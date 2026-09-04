#!/usr/bin/env node
/**
 * The playground server.
 *
 * Two modes, and the difference is deliberate and visible:
 *
 *   npm start              preview only. Serves the application, answers the
 *                          capability probe, and executes nothing. `/api/run`
 *                          returns 501.
 *   npm run start:execute  attaches the local executor. Samples can really run.
 *
 * Security posture:
 *   * binds loopback; local execution is REFUSED on any other host
 *   * serves only `web/` and `src/`, with paths resolved and re-checked
 *   * sends a restrictive CSP with no inline script and no remote origins
 *   * state-changing endpoints require same-origin, a JSON content type and a
 *     bounded body
 *   * the browser never sends a plan, a command, a URL or a path — the server
 *     rebuilds all of them from its own catalogue
 *   * the relay URL and token are never disclosed to browser code
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGUE } from './src/catalogue/index.mjs';
import { summariseCapability } from './src/core/capability.mjs';
import { EXECUTION_PROTOCOL_VERSION } from './src/core/types.mjs';
import { createRunManager } from './src/server/runManager.mjs';
import { RequestRefused } from './src/server/runRequest.mjs';
import { spawnProcess } from './src/server/transports.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SERVED_ROOTS = ['web', 'src'].map((dir) => resolve(ROOT, dir));

const PORT = Number(process.env.CITADEL_PLAYGROUND_PORT ?? 4173);
const HOST = process.env.CITADEL_PLAYGROUND_HOST ?? '127.0.0.1';
const PYTHON = process.env.CITADEL_PLAYGROUND_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

/** Only these hosts may attach the local executor. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).replace(/^\[|\]$/g, ''));
}

/**
 * Relay configuration. The URL and the token are read here and never sent to
 * the browser: the browser only ever posts to the same-origin `/api/execute`.
 */
const RELAY_URL = process.env.CITADEL_PLAYGROUND_RELAY_URL ?? '';
const RELAY_TOKEN = process.env.CITADEL_PLAYGROUND_RELAY_TOKEN ?? '';
const RELAY_ENABLED = RELAY_URL !== '';

const MIME = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
  }),
);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cache-Control': 'no-store',
  };
}

/**
 * Resolve a request path to a file inside an allowed root, or null.
 * Exported so a test can assert traversal attempts are refused.
 */
export function resolveServedPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const requested = decoded === '/' ? '/web/index.html' : decoded;
  if (requested.includes('\0')) return null;
  const candidate = resolve(ROOT, `.${normalize(requested)}`);
  const allowed = SERVED_ROOTS.some((root) => candidate === root || candidate.startsWith(root + sep));
  return allowed ? candidate : null;
}

/* ----------------------------------------------------- runtime capability */

/**
 * Probe the runtimes the samples declare, once at startup.
 *
 * Nothing here contacts Azure or the user's gateway: `az version` and a Python
 * import check are local. Reachability of a customer endpoint is deliberately
 * NOT probed, because making that call is not something the playground has
 * consent to do before the user presses Run.
 */
export async function probeRuntimes({ mode, python = PYTHON, spawn = spawnProcess, root = ROOT } = {}) {
  if (mode !== 'execute') return { mode };
  const modules = [...new Set(CATALOGUE.samples.flatMap((sample) => sample.runtime?.python?.modules ?? []))];

  const [azureCli, py, accelerator] = await Promise.all([
    spawn({ executable: 'az', args: ['version', '-o', 'json'], timeoutMs: 30_000 })
      .then((result) =>
        result.code === 0
          ? { available: true, version: cliVersion(result.stdout) }
          : { available: false, reason: cliReason(result) },
      )
      .catch((error) => ({ available: false, reason: String(error?.message ?? error) })),
    probePython(python, modules, spawn),
    countAccelerator(root),
  ]);

  return { mode, azureCli, python: py, accelerator };
}

async function probePython(python, modules, spawn) {
  const probeSource = [
    'import json,sys,importlib.util',
    `mods=${JSON.stringify(modules)}`,
    'def present(name):',
    '    try:',
    '        return importlib.util.find_spec(name) is not None',
    '    except (ImportError, ModuleNotFoundError):',
    '        return False',
    'print(json.dumps({"version":sys.version.split()[0],"modules":{m:present(m) for m in mods}}))',
  ].join('\n');
  try {
    const result = await spawn({ executable: python, args: ['-c', probeSource], timeoutMs: 30_000 });
    if (result.code !== 0) {
      return {
        available: false,
        reason: `No usable Python interpreter at \`${python}\`. Install Python 3.10 or newer; nothing is installed for you.`,
      };
    }
    const payload = JSON.parse(result.stdout.trim().split('\n').pop());
    return { available: true, version: payload.version, modules: payload.modules };
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) };
  }
}

async function countAccelerator(root) {
  try {
    const base = resolve(root, 'runtime', 'accelerator');
    let files = 0;
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(resolve(dir, entry.name));
        else files += 1;
      }
    };
    await walk(base);
    return files > 0 ? { available: true, files } : { available: false, reason: 'The vendored bundle is empty.' };
  } catch {
    return { available: false, reason: 'The vendored bundle under `runtime/accelerator` is missing.' };
  }
}

function cliVersion(text) {
  try {
    return JSON.parse(text)['azure-cli'] ?? 'available';
  } catch {
    return String(text ?? '').split('\n')[0].trim() || 'available';
  }
}

function cliReason(result) {
  return result.spawnFailed
    ? 'The Azure CLI was not found on PATH. Install it and run `az login`, then restart the playground.'
    : `\`az version\` exited ${result.code}. Sign in with \`az login\` and try again.`;
}

/** What the browser is told about execution capability. No secrets, ever. */
export function capabilitiesPayload({ mode = 'preview', probe = {} } = {}) {
  const capability = summariseCapability(CATALOGUE.samples, { ...probe, mode });
  return {
    status: 'ok',
    application: 'citadel-publish-playground',
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    mode,
    capability,
    executor: RELAY_ENABLED
      ? {
          kind: 'relay',
          canExecute: true,
          endpoint: '/api/execute',
          supportedStepTypes: ['http', 'assertion'],
          reason: 'An approved relay is configured on the local server. It executes a fixed set of catalogue samples.',
        }
      : mode === 'execute'
        ? {
            kind: 'local',
            canExecute: true,
            endpoint: '/api/run',
            supportedStepTypes: ['artifact', 'azure-cli', 'http', 'library', 'assertion'],
            reason: capability.detail,
          }
        : {
            kind: 'unavailable',
            canExecute: false,
            endpoint: null,
            supportedStepTypes: [],
            reason:
              'No execution runtime is attached. Plans are generated and previewed only; nothing is sent anywhere. Start with `npm run start:execute` to attach the local executor.',
          },
    // Presence only. The URL and the token are never disclosed.
    relayConfigured: RELAY_ENABLED,
  };
}

function send(response, status, headers, body) {
  response.writeHead(status, headers);
  response.end(body);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  send(response, status, securityHeaders('application/json; charset=utf-8'), body);
}

async function readBody(request, limitBytes = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new RequestRefused('The request body is larger than the 256 KB limit.', { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Same-origin guard for every state-changing call.
 *
 * `Sec-Fetch-Site` is the primary check where the browser sends it; `Origin` is
 * the fallback. A cross-site page therefore cannot drive this API even though
 * it is bound to loopback, and requiring a JSON content type keeps it out of
 * reach of a simple form post.
 */
export function checkStateChangingRequest(request, { port = PORT, host = HOST } = {}) {
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, message: `Refused a ${site} request. This API is same-origin only.` };
  }
  const origin = request.headers.origin;
  if (origin) {
    const expected = new Set([`http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`]);
    if (!expected.has(origin)) {
      return { ok: false, status: 403, message: `Refused a request from origin ${origin}.` };
    }
  }
  const contentType = String(request.headers['content-type'] ?? '');
  if (!contentType.startsWith('application/json')) {
    return { ok: false, status: 415, message: 'This endpoint accepts application/json only.' };
  }
  return { ok: true };
}

async function handleExecute(request, response, { port, host }) {
  const guard = checkStateChangingRequest(request, { port, host });
  if (!guard.ok) {
    sendJson(response, guard.status, { state: 'blocked', summary: guard.message });
    return;
  }
  if (!RELAY_ENABLED) {
    sendJson(response, 501, {
      state: 'blocked',
      summary: 'Not run — no relay is configured on this server.',
      detail:
        'Set CITADEL_PLAYGROUND_RELAY_URL (and a token if the relay needs one) to attach an approved execution relay, or start the server with `npm run start:execute` to use the local executor instead.',
    });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    sendJson(response, 400, { state: 'failed', summary: 'Malformed request body.' });
    return;
  }
  if (typeof payload?.sampleId !== 'string' || payload.sampleId === '') {
    sendJson(response, 400, { state: 'failed', summary: 'A sampleId is required.' });
    return;
  }
  // Only the declared members are forwarded. A caller cannot smuggle a URL, a
  // header set, or a raw request through this endpoint.
  const forwarded = {
    protocolVersion: payload.protocolVersion ?? 1,
    sampleId: payload.sampleId,
    inputs: payload.inputs ?? {},
    secretRefs: Array.isArray(payload.secretRefs) ? payload.secretRefs : [],
  };
  try {
    const upstream = await fetch(RELAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(RELAY_TOKEN ? { Authorization: `Bearer ${RELAY_TOKEN}` } : {}),
      },
      body: JSON.stringify(forwarded),
    });
    const text = await upstream.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      sendJson(response, 502, {
        state: 'inconclusive',
        summary: 'The relay answered with something that is not JSON.',
        detail: 'Treating an unrecognised relay response as inconclusive rather than as a pass.',
      });
      return;
    }
    sendJson(response, upstream.ok ? 200 : 502, parsed);
  } catch (error) {
    sendJson(response, 502, {
      state: 'failed',
      summary: 'The relay could not be reached.',
      detail: String(error?.message ?? error),
    });
  }
}

async function handleStatic(request, response) {
  const filePath = resolveServedPath(request.url ?? '/');
  if (!filePath) {
    send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
      return;
    }
    const body = await readFile(filePath);
    const contentType = MIME.get(extname(filePath)) ?? 'application/octet-stream';
    send(response, 200, securityHeaders(contentType), body);
  } catch {
    send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
  }
}

async function handleRun(request, response, { mode, manager, port, host }) {
  if (mode !== 'execute' || !manager) {
    sendJson(response, 501, {
      state: 'blocked',
      summary: 'Not run — this server was started in preview mode.',
      detail:
        'Restart with `npm run start:execute` (or `node server.mjs --execute`) to attach the local executor. Preview mode generates and inspects plans and executes nothing.',
    });
    return;
  }
  const guard = checkStateChangingRequest(request, { port, host });
  if (!guard.ok) {
    sendJson(response, guard.status, { state: 'blocked', summary: guard.message });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch (error) {
    const status = error instanceof RequestRefused ? error.status : 400;
    sendJson(response, status, { state: 'failed', summary: error?.message ?? 'Malformed request body.' });
    return;
  }
  try {
    let started = false;
    const result = await manager.start(payload, {
      onStart: ({ runId }) => {
        response.writeHead(200, {
          ...securityHeaders('application/json; charset=utf-8'),
          'X-Citadel-Run-Id': runId,
        });
        response.flushHeaders();
        started = true;
      },
    });
    if (started) response.end(JSON.stringify(result));
    else sendJson(response, 200, result);
  } catch (error) {
    if (response.headersSent) {
      response.end(
        JSON.stringify({
          state: 'failed',
          summary: 'The run stopped after it started but before it could report a result.',
        }),
      );
      return;
    }
    if (error instanceof RequestRefused) {
      sendJson(response, error.status, { state: 'blocked', summary: error.message, code: error.code });
      return;
    }
    // Deliberately terse: a stack trace could carry a path or a value.
    sendJson(response, 500, { state: 'failed', summary: 'The run could not be started.' });
  }
}

async function handleCancel(request, response, { manager, port, host }) {
  if (!manager) {
    sendJson(response, 501, { cancelled: false, reason: 'Nothing can be running in preview mode.' });
    return;
  }
  const guard = checkStateChangingRequest(request, { port, host });
  if (!guard.ok) {
    sendJson(response, guard.status, { cancelled: false, reason: guard.message });
    return;
  }
  let payload = {};
  try {
    payload = JSON.parse(await readBody(request, 4096));
  } catch {
    sendJson(response, 400, { cancelled: false, reason: 'Malformed request body.' });
    return;
  }
  if (typeof payload.runId !== 'string' || !/^[a-z0-9-]{1,72}$/.test(payload.runId)) {
    sendJson(response, 400, { cancelled: false, reason: 'A runId is required.' });
    return;
  }
  sendJson(response, 200, manager.cancel(payload.runId));
}

/**
 * @param {object} options
 * @param {'preview'|'execute'} [options.mode]
 * @param {object} [options.runManager]   injected for tests
 * @param {object} [options.probe]        injected for tests
 */
export function createPlaygroundServer({ mode = 'preview', runManager = null, probe = {}, port = PORT, host = HOST } = {}) {
  const manager =
    mode === 'execute' ? (runManager ?? createRunManager({ playgroundRoot: ROOT, pythonExecutable: PYTHON })) : runManager;
  let runtimeProbe = probe;

  const server = createServer(async (request, response) => {
    const path = (request.url ?? '/').split('?')[0];

    if (path === '/api/health' || path === '/api/capabilities') {
      if (request.method !== 'GET') {
        sendJson(response, 405, { status: 'error', detail: 'Use GET.' });
        return;
      }
      sendJson(response, 200, capabilitiesPayload({ mode, probe: runtimeProbe }));
      return;
    }

    if (path === '/api/run') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { state: 'failed', summary: 'Use POST.' });
        return;
      }
      await handleRun(request, response, { mode, manager, port, host });
      return;
    }

    if (path === '/api/run/cancel') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { cancelled: false, reason: 'Use POST.' });
        return;
      }
      await handleCancel(request, response, { manager, port, host });
      return;
    }

    if (path === '/api/execute') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { state: 'failed', summary: 'Use POST.' });
        return;
      }
      await handleExecute(request, response, { port, host });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, securityHeaders('text/plain; charset=utf-8'), 'Method not allowed');
      return;
    }
    await handleStatic(request, response);
  });

  server.setProbe = (next) => {
    runtimeProbe = next;
  };
  server.runManager = manager;
  return server;
}

/* ------------------------------------------------------------------- boot */

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const wantsExecution = process.argv.includes('--execute');
  if (wantsExecution && !isLoopbackHost(HOST)) {
    process.stderr.write(
      `Refusing to attach the local executor on ${HOST}. Local execution spawns processes and writes files, so it is allowed only when the server is bound to loopback.\n` +
        'Unset CITADEL_PLAYGROUND_HOST, or use the external relay seam for a remote deployment.\n',
    );
    process.exit(1);
  }
  const mode = wantsExecution ? 'execute' : 'preview';
  const server = createPlaygroundServer({ mode });
  server.listen(PORT, HOST, async () => {
    process.stdout.write(`Citadel Publish Playground: http://${HOST}:${PORT}/\n`);
    process.stdout.write(`Mode: ${mode}\n`);
    if (mode === 'execute') {
      process.stdout.write('Probing local runtimes…\n');
      const probe = await probeRuntimes({ mode, python: PYTHON });
      server.setProbe(probe);
      const { capability } = capabilitiesPayload({ mode, probe });
      process.stdout.write(`Local execution: ${capability.label} (${capability.ready}/${capability.total} samples ready)\n`);
      process.stdout.write('Risk gates still apply. Nothing runs without a fresh acknowledgement.\n');
    } else {
      process.stdout.write('Preview only — plans are generated and inspected, and nothing is executed.\n');
      process.stdout.write('Run `npm run start:execute` to attach the local executor.\n');
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.runManager?.cancelAll();
      server.close(() => process.exit(0));
    });
  }
}

export { PORT, HOST, RELAY_ENABLED };
