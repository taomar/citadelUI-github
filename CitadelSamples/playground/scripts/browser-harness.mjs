import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BROWSER_CANDIDATES = Object.freeze([
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]);
export const TEST_BOOTSTRAP_CAPABILITY = 'A'.repeat(43);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function browserCandidates({ explicitPath, env = process.env } = {}) {
  return [
    explicitPath,
    env.CITADEL_ACCEPTANCE_CHROME,
    env.CITADEL_SMOKE_CHROME,
    `${env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
    ...DEFAULT_BROWSER_CANDIDATES,
  ].filter(Boolean);
}

export function findBrowserPath(options = {}) {
  return browserCandidates(options).find((candidate) => existsSync(candidate)) ?? null;
}

export function createCheckReporter({ name = 'acceptance', write = (line) => process.stdout.write(line) } = {}) {
  const results = [];

  function check(label, condition, detail = '') {
    const result = { label, ok: Boolean(condition), detail: String(detail ?? '') };
    results.push(result);
    write(`${result.ok ? '  ok  ' : ' FAIL '} ${label}${result.detail && !result.ok ? ` - ${result.detail}` : ''}\n`);
    return result.ok;
  }

  function finish() {
    const failures = results.filter((result) => !result.ok);
    write(`\n${name}: ${results.length - failures.length}/${results.length} checks passed\n`);
    return { results: [...results], failures, ok: failures.length === 0 };
  }

  return Object.freeze({
    check,
    equal(label, actual, expected) {
      return check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    includes(label, actual, expected) {
      return check(label, String(actual).includes(String(expected)), `${JSON.stringify(actual)} does not include ${JSON.stringify(expected)}`);
    },
    finish,
    get results() {
      return [...results];
    },
  });
}

export function connectCdpPipe(writeStream, readStream, { timeoutMs = 30_000 } = {}) {
  if (!writeStream?.write || !readStream?.on) throw new TypeError('CDP pipe streams are required.');
  let nextId = 0;
  let buffered = Buffer.alloc(0);
  const pending = new Map();
  const listeners = new Map();

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function listenerKey(sessionId, method) {
    return `${sessionId ?? ''}\0${method}`;
  }

  function receive(message) {
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    if (!message.method) return;
    for (const listener of listeners.get(listenerKey(message.sessionId, message.method)) ?? []) {
      listener(message.params ?? {});
    }
  }

  readStream.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const delimiter = buffered.indexOf(0);
      if (delimiter < 0) return;
      const frame = buffered.subarray(0, delimiter);
      buffered = buffered.subarray(delimiter + 1);
      if (frame.length === 0) continue;
      try {
        receive(JSON.parse(frame.toString('utf8')));
      } catch (error) {
        rejectPending(new Error(`Invalid CDP response: ${error.message}`));
      }
    }
  });
  readStream.on('error', (error) => rejectPending(new Error(`The browser DevTools pipe failed: ${error.message}`)));
  readStream.on('close', () => rejectPending(new Error('The browser DevTools pipe closed.')));

  function send(method, params = {}, sessionId) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      writeStream.write(`${JSON.stringify(message)}\0`, (error) => {
        if (!error || !pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function on(method, listener, sessionId) {
    const key = listenerKey(sessionId, method);
    const current = listeners.get(key) ?? [];
    current.push(listener);
    listeners.set(key, current);
    return () => listeners.set(key, current.filter((candidate) => candidate !== listener));
  }

  function session(sessionId) {
    if (!sessionId) throw new TypeError('A CDP session id is required.');
    return Object.freeze({
      send: (method, params = {}) => send(method, params, sessionId),
      on: (method, listener) => on(method, listener, sessionId),
      close() {},
    });
  }

  return Object.freeze({
    send,
    on,
    session,
    close() {
      rejectPending(new Error('The browser DevTools pipe closed.'));
      writeStream.destroy();
      readStream.destroy();
    },
  });
}

export async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Browser evaluation failed.');
  }
  return result.result.value;
}

export async function waitFor(client, expression, { timeoutMs = 20_000, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await evaluate(client, expression)) return;
    } catch {
      // Navigation and module loading can briefly make the execution context unavailable.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await wait(100);
  }
}

export async function reserveLoopbackPort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  await once(server, 'close');
  if (!port) throw new Error('Could not reserve a loopback port.');
  return port;
}

export async function launchBrowserHarness({
  browserPath,
  createServer,
  path = '/?testExecutor',
  bootstrapCapability = TEST_BOOTSTRAP_CAPABILITY,
  originForPort = (port) => `https://127.0.0.1:${port}`,
  browserArguments = [],
  viewport = { width: 1440, height: 900, mobile: false },
} = {}) {
  if (typeof createServer !== 'function') throw new TypeError('launchBrowserHarness requires createServer.');
  const executable = findBrowserPath({ explicitPath: browserPath });
  if (!executable) {
    throw new Error('No Chromium browser found. Set CITADEL_ACCEPTANCE_CHROME to a browser path.');
  }

  const serverPort = await reserveLoopbackPort();
  const server = createServer({ port: serverPort, testBootstrapCapability: bootstrapCapability });
  if (!(server instanceof HttpsServer)) throw new Error('Browser acceptance requires an HTTPS server and isolated browser trust before listening.');
  server.listen(serverPort, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = originForPort(serverPort);
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('Browser acceptance requires verified HTTPS.');
  const profile = await mkdtemp(join(tmpdir(), 'citadel-browser-acceptance-'));
  const browser = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-pipe',
      ...browserArguments,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] },
  );

  let browserOutput = '';
  const recordOutput = (chunk) => {
    browserOutput = `${browserOutput}${String(chunk)}`.slice(-4096);
  };
  browser.stderr.on('data', recordOutput);
  browser.stdout.on('data', recordOutput);

  let browserClient;
  let page;
  const pageErrors = [];
  const runtimeErrors = [];

  async function setViewport({ width, height, mobile = false, deviceScaleFactor = 1 }) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
  }

  async function pressKey(key) {
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  }

  async function close() {
    page?.close();
    browserClient?.close();
    if (browser.exitCode === null && browser.signalCode === null) {
      browser.kill('SIGKILL');
      await Promise.race([once(browser, 'exit').catch(() => {}), wait(2_000)]);
    }
    server.close();
    await once(server, 'close').catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }

  try {
    browserClient = connectCdpPipe(browser.stdio[3], browser.stdio[4]);
    await browserClient.send('Browser.getVersion');
    const { targetId } = await browserClient.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browserClient.send('Target.attachToTarget', { targetId, flatten: true });
    page = browserClient.session(sessionId);
    page.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const message = exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? 'Uncaught page error';
      pageErrors.push(message);
      runtimeErrors.push(message);
    });
    page.on('Log.entryAdded', ({ entry }) => {
      if (entry?.level === 'error') pageErrors.push(entry.text ?? 'Browser log error');
    });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await setViewport(viewport);
    const launchUrl = new URL(path, baseUrl);
    if (bootstrapCapability) launchUrl.hash = `bootstrap=${encodeURIComponent(bootstrapCapability)}`;
    await page.send('Page.navigate', { url: launchUrl.href });
  } catch (error) {
    const output = browserOutput.trim();
    await close();
    throw new Error(`${error.message}${output ? ` Browser output: ${output}` : ''}`, { cause: error });
  }

  return Object.freeze({
    baseUrl,
    page,
    pageErrors,
    runtimeErrors,
    evaluate: (expression) => evaluate(page, expression),
    waitFor: (expression, options) => waitFor(page, expression, options),
    setViewport,
    pressKey,
    async openTestPage(url, { freshContext = false } = {}) {
      if (new URL(url).protocol !== 'https:') throw new Error('Browser test pages require HTTPS.');
      const context = freshContext ? await browserClient.send('Target.createBrowserContext') : {};
      const { targetId } = await browserClient.send('Target.createTarget', { url: 'about:blank', ...context });
      const { sessionId } = await browserClient.send('Target.attachToTarget', { targetId, flatten: true });
      const client = browserClient.session(sessionId);
      await client.send('Page.enable');
      await client.send('Runtime.enable');
      await client.send('Page.navigate', { url });
      return {
        evaluate: (expression) => evaluate(client, expression),
        waitFor: (expression) => waitFor(client, expression),
        close: () => context.browserContextId
          ? browserClient.send('Target.disposeBrowserContext', context)
          : browserClient.send('Target.closeTarget', { targetId }),
      };
    },
    close,
  });
}
