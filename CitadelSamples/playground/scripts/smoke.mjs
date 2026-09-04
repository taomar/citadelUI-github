#!/usr/bin/env node
/**
 * Browser smoke check.
 *
 * Drives a headless Chromium over the DevTools Protocol using Node's built-in
 * WebSocket — no Playwright, no Puppeteer, no dependency of any kind. It
 * starts the playground server on an ephemeral port, loads the page, and
 * asserts the interactions that only exist once the DOM is real: selecting a
 * recipe, switching tabs, typing into a field, searching the directory,
 * acknowledging a risky recipe, and rendering at 320px.
 *
 * Usage:  node scripts/smoke.mjs [--chrome <path>] [--keep-open]
 * Exit code 0 on success, 1 on any failed assertion.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { createPlaygroundServer } from '../server.mjs';

const CHROME_CANDIDATES = [
  process.env.CITADEL_SMOKE_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const results = [];
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail && !condition ? ` — ${detail}` : ''}\n`);
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Minimal CDP client over the built-in WebSocket. */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timeout for ${method}`));
          }
        }, 30000);
      });
    },
    close: () => socket.close(),
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
  }
  return result.result.value;
}

/**
 * Poll until an expression is truthy. A fixed sleep is flaky here: the app
 * fetches forty ES modules over HTTP before it renders anything.
 */
async function waitFor(client, expression, { timeoutMs = 20000, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await evaluate(client, expression)) return true;
    } catch {
      /* the document may not be ready yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function reserveLoopbackPort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  await once(server, 'close');
  if (!port) throw new Error('could not reserve a DevTools port');
  return port;
}

async function waitForDevTools(port, browser, output) {
  const deadline = Date.now() + 30000;
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  while (Date.now() < deadline) {
    if (browser.exitCode !== null) {
      throw new Error(`browser exited before DevTools was ready${output() ? `: ${output()}` : ''}`);
    }
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const payload = await response.json();
        if (typeof payload.webSocketDebuggerUrl === 'string' && payload.webSocketDebuggerUrl) {
          return payload.webSocketDebuggerUrl;
        }
      }
    } catch {
      /* Chromium has not opened the loopback endpoint yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`browser did not open its DevTools endpoint${output() ? `: ${output()}` : ''}`);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    process.stdout.write('smoke: no Chromium found. Set CITADEL_SMOKE_CHROME to a browser path.\n');
    process.exit(2);
  }

  const port = await reserveLoopbackPort();
  const server = createPlaygroundServer({ port });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${port}`;

  const profile = await mkdtemp(join(tmpdir(), 'citadel-smoke-'));
  const devtoolsPort = await reserveLoopbackPort();
  const browser = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${devtoolsPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let browserWs = '';
  let browserOutput = '';
  const recordOutput = (chunk) => {
    browserOutput = `${browserOutput}${String(chunk)}`.slice(-4096);
  };
  browser.stderr.on('data', recordOutput);
  browser.stdout.on('data', recordOutput);

  try {
    browserWs = await waitForDevTools(devtoolsPort, browser, () => browserOutput.trim());
    const browserClient = await connect(browserWs);
    const { targetId } = await browserClient.send('Target.createTarget', { url: 'about:blank' });
    const targets = await browserClient.send('Target.getTargets');
    const target = targets.targetInfos.find((info) => info.targetId === targetId);
    const pageWs = browserWs.replace(/\/devtools\/browser\/.*/, `/devtools/page/${target.targetId}`);
    const page = await connect(pageWs);

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');

    const consoleErrors = [];
    await page.send('Runtime.addBinding', { name: '__smoke' }).catch(() => {});

    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send('Page.navigate', { url: `${base}/?testExecutor` });
    await waitFor(page, 'document.querySelectorAll(".dir-item").length === 19', {
      label: 'the recipe directory to render',
    });
    // The capability probe is a second round trip; wait for it to settle so the
    // masthead is not read mid-flight.
    await waitFor(page, '!/Checking/.test(document.getElementById("capability-label").textContent)', {
      label: 'the capability probe to settle',
    });

    /* ---------------------------------------------------------- first view */
    const first = await evaluate(
      page,
      `(() => ({
        title: document.title,
        heading: document.getElementById('sample-title').textContent,
        directoryButtons: document.querySelectorAll('.dir-item').length,
        groups: document.querySelectorAll('.dir-group').length,
        tabs: [...document.querySelectorAll('[role="tab"]')].map(t => t.textContent.trim().split('\\n')[0]),
        selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.id,
        visiblePanels: [...document.querySelectorAll('.panel')].filter(p => !p.hidden).length,
        capability: document.getElementById('capability-label').textContent,
        hash: document.getElementById('source-hash').textContent,
        options: document.querySelectorAll('#sample-select option').length,
        docWidth: document.documentElement.scrollWidth,
        winWidth: window.innerWidth,
      }))()`,
    );

    check('page title is set', first.title === 'Citadel Publish Playground', first.title);
    check('all 19 recipes render in the directory', first.directoryButtons === 19, String(first.directoryButtons));
    check('all 7 groups render', first.groups === 7, String(first.groups));
    check('four tabs are present', first.tabs.length === 4, first.tabs.join(','));
    check('the Guide tab is selected first', first.selectedTab === 'tab-guide', first.selectedTab);
    check('exactly one panel is visible', first.visiblePanels === 1, String(first.visiblePanels));
    check('capability reports preview only', /preview only/i.test(first.capability), first.capability);
    check('the notebook hash is shown', /^sha256 ee706b4d/.test(first.hash), first.hash);
    check('the compact selector mirrors the directory', first.options === 19, String(first.options));
    check('no horizontal overflow at 1440px', first.docWidth <= first.winWidth, `${first.docWidth} > ${first.winWidth}`);

    /* ------------------------------------------------------------ selection */
    const selection = await evaluate(
      page,
      `(() => {
        document.querySelector('[data-sample="cleanup"]').click();
        return {
          heading: document.getElementById('sample-title').textContent,
          current: document.querySelectorAll('.dir-item[aria-current="true"]').length,
          currentId: document.querySelector('.dir-item[aria-current="true"]')?.dataset.sample,
          selectValue: document.getElementById('sample-select').value,
          risk: [...document.querySelectorAll('#sample-meta .chip')].map(c => c.textContent),
          live: document.getElementById('live').textContent,
          tab: document.querySelector('[role="tab"][aria-selected="true"]').id,
        };
      })()`,
    );
    check('selecting a recipe renders it', selection.heading === 'Cleanup', selection.heading);
    check('exactly one directory row is current', selection.current === 1, String(selection.current));
    check('the current row is the selected one', selection.currentId === 'cleanup', selection.currentId);
    check('the compact selector follows', selection.selectValue === 'cleanup', selection.selectValue);
    check('the risk chip reads Destructive', selection.risk.includes('Destructive'), selection.risk.join(','));
    check('selection is announced politely', /Cleanup selected/.test(selection.live), selection.live);
    check('selection resets to the Guide tab', selection.tab === 'tab-guide', selection.tab);

    /* ----------------------------------------------------------------- tabs */
    const tabs = await evaluate(
      page,
      `(() => {
        document.getElementById('tab-request').click();
        const before = document.querySelector('[role="tab"][aria-selected="true"]').id;
        const requestVisible = !document.getElementById('panel-request').hidden;
        const active = document.querySelector('[role="tab"][aria-selected="true"]');
        active.focus();
        active.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const after = document.querySelector('[role="tab"][aria-selected="true"]').id;
        const focused = document.activeElement?.id;
        const home = (() => {
          const current = document.querySelector('[role="tab"][aria-selected="true"]');
          current.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
          return document.querySelector('[role="tab"][aria-selected="true"]').id;
        })();
        const roving = [...document.querySelectorAll('[role="tab"]')]
          .filter(t => t.getAttribute('tabindex') === '0').length;
        const visible = [...document.querySelectorAll('.panel')].filter(p => !p.hidden).map(p => p.id);
        return { before, requestVisible, after, focused, home, roving, visible };
      })()`,
    );
    check('clicking a tab switches the panel', tabs.before === 'tab-request' && tabs.requestVisible, tabs.before);
    check('ArrowRight moves to the next tab', tabs.after === 'tab-response', tabs.after);
    check('focus follows the newly selected tab', tabs.focused === 'tab-response', tabs.focused);
    check('Home returns to the first tab', tabs.home === 'tab-guide', tabs.home);
    check('exactly one tab is in the tab order', tabs.roving === 1, String(tabs.roving));
    check('still exactly one panel visible after keyboard nav', tabs.visible.length === 1, tabs.visible.join(','));

    /* ------------------------------------------------------ risk gate + form */
    const filled = await evaluate(
      page,
      `(() => {
        // A shared helper: find a control by its visible label and set it.
        window.__set = (label, value) => {
          const field = [...document.querySelectorAll('#panel-configure .prow')]
            .find(row => row.querySelector('.prow-label')?.textContent.trim() === label);
          if (!field) return 'no field: ' + label;
          const control = field.querySelector('input, select, textarea');
          if (!control) return 'no control: ' + label;
          if (control.type === 'checkbox') {
            control.checked = Boolean(value);
            control.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            control.value = String(value);
            control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
          }
          return 'ok';
        };
        window.__groupTitles = () =>
          [...document.querySelectorAll('#panel-configure .sec-title')].map(t => t.textContent.trim());
        document.querySelector('[data-sample="cleanup"]').click();
        document.getElementById('tab-configure').click();
        const outcomes = [
          window.__set('Subscription ID', '00000000-1111-2222-3333-444444444444'),
          window.__set('Governance hub resource group', 'rg-smoke'),
          window.__set('API Management service name', 'apim-smoke'),
          window.__set('This gateway is not production', true),
        ];
        return {
          outcomes,
          errors: document.querySelectorAll('#panel-configure .field-error').length,
          groups: window.__groupTitles(),
          rowCount: document.querySelectorAll('#panel-configure .prow').length,
          // A field cleanup never reads must not be on the form at all.
          hasGatewayUrl: window.__set('Gateway URL', 'x') === 'ok',
          hasKeyVaultName: window.__set('Key Vault name', 'x') === 'ok',
        };
      })()`,
    );
    check('every configure field could be set by its label', filled.outcomes.every((o) => o === 'ok'), filled.outcomes.join(','));
    check('a complete configuration clears every inline error', filled.errors === 0, String(filled.errors));
    check(
      'the configure view leads with the configuration contract',
      filled.groups[0] === 'Configuration contract',
      filled.groups.join(' | '),
    );
    check('mandatory and optional groups are visible and named', filled.groups.includes('Mandatory') && filled.groups.includes('Optional (defaults)'), filled.groups.join(' | '));
    check('a field the recipe never reads is not rendered', filled.hasGatewayUrl === false && filled.hasKeyVaultName === false);

    /* ------------------------------------------------------------- exports */
    const exports = await evaluate(
      page,
      `(() => {
        const buttons = ['copy-config', 'download-config', 'copy-env', 'download-env']
          .map(id => document.getElementById(id));
        // Capture what the copy action would place on the clipboard without
        // reaching the real clipboard, which headless Chrome does not grant.
        window.__copied = [];
        navigator.clipboard.writeText = async (text) => { window.__copied.push(text); };
        buttons[0].click();
        buttons[2].click();
        return {
          present: buttons.every(Boolean),
          labels: buttons.map(b => b && b.textContent.trim()),
          contract: document.querySelector('#panel-configure .prose')?.textContent ?? '',
        };
      })()`,
    );
    check('all four export actions are present', exports.present === true, exports.labels.join(' | '));
    check(
      'the download actions name a deterministic file',
      exports.labels[1] === 'Download citadel-cleanup.config.json' && exports.labels[3] === 'Download citadel-cleanup.env.example',
      exports.labels.join(' | '),
    );
    check('the contract line summarises what the sample needs', /mandatory/i.test(exports.contract), exports.contract);

    const copied = await evaluate(page, 'window.__copied ?? []');
    check('copying produces a JSON document and an env example', (copied ?? []).length === 2, String((copied ?? []).length));
    const copiedJson = (copied ?? [])[0] ?? '';
    check('the copied configuration parses as JSON', (() => { try { JSON.parse(copiedJson); return true; } catch { return false; } })());
    check('the copied configuration names the sample and its cells', /"id": "cleanup"/.test(copiedJson) && /"cells"/.test(copiedJson));
    check('the copied configuration lists what is still missing', /"missing"/.test(copiedJson));

    const gate = await evaluate(
      page,
      `(() => {
        document.getElementById('tab-request').click();
        const ack = document.getElementById('ack-check');
        const run = document.getElementById('run-button');
        const before = { hasAck: Boolean(ack), runDisabled: run?.disabled, steps: document.querySelectorAll('#panel-request .step').length };
        ack.checked = true;
        ack.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          before,
          after: {
            ackStillChecked: document.getElementById('ack-check').checked,
            reason: document.querySelector('.runbar-reason')?.textContent ?? '',
            runDisabled: document.getElementById('run-button').disabled,
            riskTone: document.querySelector('.ack')?.dataset.risk,
          },
        };
      })()`,
    );
    check('a complete configuration generates a plan with steps', gate.before.steps >= 3, String(gate.before.steps));
    check('a destructive recipe shows an acknowledgement', gate.before.hasAck === true);
    check('run is disabled before acknowledgement', gate.before.runDisabled === true);
    check('the acknowledgement carries the destructive tone', gate.after.riskTone === 'destructive', gate.after.riskTone);
    check('the acknowledgement records the choice', gate.after.ackStillChecked === true);
    check('run stays disabled while the server is preview-only', gate.after.runDisabled === true);
    check('the missing runtime is explained', /preview mode|runtime|not attached/i.test(gate.after.reason), gate.after.reason);

    const invalidated = await evaluate(
      page,
      `(() => {
        document.getElementById('tab-configure').click();
        window.__set('Governance hub resource group', 'rg-smoke-2');
        document.getElementById('tab-request').click();
        return { ackChecked: document.getElementById('ack-check')?.checked };
      })()`,
    );
    check('changing an input clears the acknowledgement', invalidated.ackChecked === false, String(invalidated.ackChecked));

    /* ------------------------------------------------------ validation + secret */
    const validation = await evaluate(
      page,
      `(() => {
        document.querySelector('[data-sample="weather-mcp-discovery"]').click();
        document.getElementById('tab-configure').click();
        // Deliberately clear a value the sample genuinely needs. The gateway URL
        // is conditional here: it is required only while no deployed endpoint
        // has been recorded, which is the state this page is in.
        window.__set('Gateway URL', '');
        const errors = [...document.querySelectorAll('.field-error')].map(e => e.textContent);
        const invalid = document.querySelectorAll('#panel-configure [aria-invalid="true"]').length;
        const described = document.querySelector('#panel-configure [aria-describedby]') !== null;
        document.getElementById('tab-request').click();
        const blockedText = document.getElementById('panel-request').textContent;
        // Restore it and add the secret, then read the preview.
        document.getElementById('tab-configure').click();
        window.__set('Gateway URL', 'https://apim-smoke.azure-api.net');
        window.__set('Access-contract api-key', 'FAKE-SMOKE-KEY-0000');
        const cleared = document.querySelectorAll('#panel-configure .field-error').length;
        const configText = document.getElementById('panel-configure').textContent;
        document.getElementById('tab-request').click();
        const preview = document.querySelector('#panel-request .preview')?.textContent ?? '';
        return {
          errorCount: errors.length,
          invalid,
          described,
          blockedText,
          cleared,
          preview,
          configText,
          firstError: errors[0] ?? '',
        };
      })()`,
    );
    check('a missing required input is reported inline', validation.errorCount > 0, String(validation.errorCount));
    check('the message names the field', /Gateway URL is required/.test(validation.firstError), validation.firstError);
    check('invalid controls are marked aria-invalid', validation.invalid > 0, String(validation.invalid));
    check('controls are described by their help and errors', validation.described === true);
    check(
      'an invalid configuration explains why no plan exists',
      /Complete the required inputs/.test(validation.blockedText),
      validation.blockedText.slice(0, 80),
    );
    check('fixing the input clears the inline error', validation.cleared === 0, String(validation.cleared));
    check('the configure view never renders the typed secret', !validation.configText.includes('FAKE-SMOKE-KEY-0000'));
    check('the preview never contains the typed secret', !validation.preview.includes('FAKE-SMOKE-KEY-0000'));
    check(
      'the preview uses an environment placeholder',
      validation.preview.includes('${CITADEL_GATEWAY_ACCESS_API_KEY}'),
      validation.preview.slice(0, 80),
    );

    /* ------------------------------------------------- run, evidence, cancel */
    const run = await evaluate(
      page,
      `(async () => {
        const hooks = globalThis.__citadelTestHooks;
        if (!hooks) return { installed: false };
        // A test-only executor. It reaches nothing: no Azure, no gateway, no
        // process. The seam exists only because the page carries ?testExecutor
        // on loopback, so a normal session cannot reach it.
        let resolveRun;
        const pending = new Promise((resolve) => { resolveRun = resolve; });
        let cancelled = false;
        hooks.installExecutor({
          describeCapability: () => ({ id: 'test', kind: 'local', canExecute: true, supportedStepTypes: [], reason: 'test' }),
          supports: () => ({ supported: true, unsupportedStepTypes: [] }),
          cancel: async () => { cancelled = true; resolveRun({
            state: 'cancelled', sampleId: 'weather-mcp-discovery', summary: 'Cancelled after 1 of 3 step(s).',
            steps: [{ id: 'mcp-initialize', kind: 'http', title: 'MCP initialize', state: 'cancelled', durationMs: 12, detail: 'Cancelled.', evidence: {} }],
            assertions: [], meta: { executor: 'local', runId: 'smoke-0001' }, configurationUpdates: {}, secretUpdates: {},
          }); return { cancelled: true }; },
          execute: async (_plan, context = {}) => {
            context.onProgress?.({ type: 'run-start', runId: 'smoke-0001', sampleId: 'weather-mcp-discovery', workspace: '.' });
            context.onProgress?.({
              type: 'step-start',
              step: { id: 'mcp-initialize', kind: 'http', title: 'MCP initialize' },
            });
            return pending;
          },
        });
        document.getElementById('tab-request').click();
        const runButton = document.getElementById('run-button');
        const cancelButton = document.getElementById('cancel-button');
        const before = { runDisabled: runButton.disabled, cancelDisabled: cancelButton.disabled };
        runButton.click();
        await new Promise((r) => setTimeout(r, 60));
        const during = {
          running: hooks.isRunning(),
          runDisabled: document.getElementById('run-button').disabled,
          cancelDisabled: document.getElementById('cancel-button').disabled,
          busy: document.getElementById('run-button').getAttribute('aria-busy'),
          streamingStep: document.querySelector('#panel-response .step[data-state="running"]')?.textContent ?? '',
        };
        document.getElementById('cancel-button').click();
        await new Promise((r) => setTimeout(r, 120));
        document.getElementById('tab-response').click();
        const responseText = document.getElementById('panel-response').textContent;
        return {
          installed: true,
          before,
          during,
          cancelled,
          responseText,
          state: document.querySelector('#panel-response .result')?.dataset.state,
          stepStates: [...document.querySelectorAll('#panel-response .step')].map(s => s.dataset.state),
        };
      })()`,
    );
    check('the test executor seam is available on loopback with the flag', run.installed === true);
    check('run becomes enabled once a runtime is attached', run.before.runDisabled === false, JSON.stringify(run.before));
    check('cancel is disabled until a run is in flight', run.before.cancelDisabled === true);
    check('the run reports itself as busy while it is in flight', run.during.busy === 'true' && run.during.runDisabled === true);
    check('cancel becomes available during a run', run.during.cancelDisabled === false);
    check('the output view streams the active step before completion', /MCP initialize/.test(run.during.streamingStep), run.during.streamingStep);
    check('cancelling reaches the executor', run.cancelled === true);
    check('a cancelled run is reported as cancelled, never completed', run.state === 'cancelled', String(run.state));
    check('per-step state is shown for the steps that ran', run.stepStates.includes('cancelled'), run.stepStates.join(','));
    check('the response never renders the typed secret', !run.responseText.includes('FAKE-SMOKE-KEY-0000'));

    const evidence = await evaluate(
      page,
      `(async () => {
        const hooks = globalThis.__citadelTestHooks;
        hooks.installExecutor({
          describeCapability: () => ({ id: 'test', kind: 'local', canExecute: true, supportedStepTypes: [], reason: 'test' }),
          supports: () => ({ supported: true, unsupportedStepTypes: [] }),
          execute: async () => ({
            state: 'completed',
            sampleId: 'weather-mcp-discovery',
            summary: 'All 3 step(s) ran and every assertion passed.',
            detail: '',
            steps: [
              { id: 'mcp-initialize', kind: 'http', title: 'MCP initialize', state: 'completed', durationMs: 41,
                detail: 'HTTP 200 · json', evidence: { status: 200, sessionCaptured: true, url: 'https://apim-smoke.azure-api.net/mcp/weather-tool-mcp/mcp' } },
              { id: 'tools-list', kind: 'http', title: 'MCP tools/list', state: 'completed', durationMs: 33,
                detail: 'HTTP 200 · sse', evidence: { status: 200, format: 'sse' } },
              { id: 'assert-tools', kind: 'assertion', title: 'Confirm the handshake', state: 'completed', durationMs: 1,
                detail: '1 tool(s) returned.', evidence: { tools: ['get-weather'] },
                assertion: { id: 'assert-tools', status: 'passed', detail: '1 tool(s) returned.' } },
            ],
            assertions: [{ id: 'initialize-ok', status: 'passed', detail: 'Handshake succeeded.' }],
            meta: { executor: 'local', runId: 'smoke-0002', artifacts: [] },
            configurationUpdates: { 'hub.apimName': 'apim-discovered' },
            secretUpdates: {},
          }),
        });
        document.getElementById('tab-request').click();
        document.getElementById('run-button').click();
        await new Promise((r) => setTimeout(r, 150));
        document.getElementById('tab-response').click();
        const panel = document.getElementById('panel-response');
        return {
          state: panel.querySelector('.result')?.dataset.state,
          stepCount: panel.querySelectorAll('.step').length,
          hasEvidence: panel.textContent.includes('sessionCaptured'),
          hasDuration: /\\d+ ms/.test(panel.textContent),
          hasUpdates: panel.textContent.includes('apim-discovered'),
          passMarks: [...panel.querySelectorAll('.expect-mark')].map(m => m.textContent),
          live: document.getElementById('live').textContent,
        };
      })()`,
    );
    check('a completed run is reported as completed', evidence.state === 'completed', String(evidence.state));
    check('every step is reported with its own row', evidence.stepCount === 3, String(evidence.stepCount));
    check('step evidence is rendered', evidence.hasEvidence === true);
    check('step duration is rendered', evidence.hasDuration === true);
    check('discovered public values are shown', evidence.hasUpdates === true);
    check('a passing assertion marks the expected result', evidence.passMarks.includes('pass'), evidence.passMarks.join(','));
    check('the result is announced politely', /All 3 step/.test(evidence.live), evidence.live);

    /* --------------------------------------------------------------- search */
    const search = await evaluate(
      page,
      `(() => {
        const box = document.getElementById('directory-search');
        box.value = 'burst';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const filtered = document.querySelectorAll('.dir-item').length;
        box.value = 'zzzz-nothing';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const emptyText = document.querySelector('#directory-groups .empty')?.textContent ?? '';
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const restored = document.querySelectorAll('.dir-item').length;
        return { filtered, emptyText, restored, count: document.getElementById('directory-count').textContent };
      })()`,
    );
    check('search filters the directory', search.filtered === 2, String(search.filtered));
    check('an empty search result explains itself', /No recipe matches/.test(search.emptyText), search.emptyText);
    check('clearing the search restores all 19', search.restored === 19, String(search.restored));

    /* ----------------------------------------------- narrow viewport + zoom */
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 640,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const narrow = await evaluate(
      page,
      `(() => {
        const rail = document.getElementById('directory');
        const context = document.getElementById('context');
        const compactSelect = document.querySelector('.strip-compact');
        const compactContext = document.getElementById('context-compact');
        return {
          docWidth: document.documentElement.scrollWidth,
          winWidth: window.innerWidth,
          railHidden: getComputedStyle(rail).display === 'none',
          contextHidden: getComputedStyle(context).display === 'none',
          selectVisible: getComputedStyle(compactSelect).display !== 'none',
          contextDisclosure: getComputedStyle(compactContext).display !== 'none',
          tabsVisible: document.querySelectorAll('[role="tab"]').length,
        };
      })()`,
    );
    check('no horizontal overflow at 320px', narrow.docWidth <= narrow.winWidth, `${narrow.docWidth} > ${narrow.winWidth}`);
    check('the directory rail is replaced at 320px', narrow.railHidden === true);
    check('the context rail is replaced at 320px', narrow.contextHidden === true);
    check('a native recipe selector appears', narrow.selectVisible === true);
    check('a context disclosure appears', narrow.contextDisclosure === true);
    check('tabs remain horizontal and present', narrow.tabsVisible === 4, String(narrow.tabsVisible));

    /* ------------------------------------------------ offline self-test (320px) */
    // The disclosure's body used to be positioned absolutely off the toggle,
    // which overflowed the viewport once the masthead wrapped to a narrow
    // layout and hid the run button behind the compact recipe strip. Drive a
    // real click through the real server here, at the width that broke it.
    const selfTestNarrow = await evaluate(
      page,
      `(async () => {
        document.querySelector('#self-test summary').click();
        document.getElementById('self-test-run').click();
        const pending = () => ['Not run', 'Running…'].includes(document.getElementById('self-test-status').textContent);
        const deadline = Date.now() + 5000;
        while (pending()) {
          if (Date.now() > deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return {
          status: document.getElementById('self-test-status').textContent,
          docWidth: document.documentElement.scrollWidth,
          winWidth: window.innerWidth,
        };
      })()`,
    );
    check(
      'the offline self-test runs to completion at 320px',
      /Passed — offline only/.test(selfTestNarrow.status),
      selfTestNarrow.status,
    );
    check(
      'no horizontal overflow after running the self-test at 320px',
      selfTestNarrow.docWidth <= selfTestNarrow.winWidth,
      `${selfTestNarrow.docWidth} > ${selfTestNarrow.winWidth}`,
    );

    // 200% zoom is equivalent to halving the CSS viewport at the same pixels.
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 640,
      height: 480,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const zoomed = await evaluate(
      page,
      `({ docWidth: document.documentElement.scrollWidth, winWidth: window.innerWidth })`,
    );
    check(
      'no horizontal overflow at 200% zoom (640px CSS)',
      zoomed.docWidth <= zoomed.winWidth,
      `${zoomed.docWidth} > ${zoomed.winWidth}`,
    );

    /* ---------------------------------------------------------- every recipe */
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const sweep = await evaluate(
      page,
      `(() => {
        const ids = [...document.querySelectorAll('.dir-item')].map(b => b.dataset.sample);
        const problems = [];
        for (const id of ids) {
          document.querySelector('[data-sample="' + id + '"]').click();
          for (const tab of ['guide','configure','request','response']) {
            document.getElementById('tab-' + tab).click();
            const panel = document.getElementById('panel-' + tab);
            if (panel.hidden) problems.push(id + '/' + tab + ': hidden');
            if (panel.textContent.trim().length < 40) problems.push(id + '/' + tab + ': empty');
          }
        }
        return { count: ids.length, problems };
      })()`,
    );
    check('every recipe renders all four tabs with content', sweep.problems.length === 0, sweep.problems.join('; '));
    check('the sweep visited all 19 recipes', sweep.count === 19, String(sweep.count));

    /* ------------------------------------------------- offline self-test */
    // This is the same card already exercised at 320px above, but here it is
    // run once more at a normal viewport through the real /api/self-test
    // route (no fake executor) to assert the full evidence shape a user sees:
    // exactly five checks, all passed, and the fixed offline claims.
    const selfTest = await evaluate(
      page,
      `(async () => {
        const details = document.getElementById('self-test');
        if (!details.open) details.querySelector('summary').click();
        document.getElementById('self-test-run').click();
        const pending = () => ['Not run', 'Running…'].includes(document.getElementById('self-test-status').textContent);
        const deadline = Date.now() + 5000;
        while (pending()) {
          if (Date.now() > deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const checks = [...document.querySelectorAll('.mh-selftest-check')];
        return {
          status: document.getElementById('self-test-status').textContent,
          summary: document.getElementById('self-test-summary').textContent,
          checkCount: checks.length,
          allPassed: checks.every((row) => /Pass/.test(row.querySelector('.chip')?.textContent ?? '')),
          live: document.getElementById('live').textContent,
        };
      })()`,
    );
    check('the offline self-test reports Passed', /Passed — offline only/.test(selfTest.status), selfTest.status);
    check(
      'the summary states no Azure contact and no live evidence',
      /contacted no Azure service/.test(selfTest.summary) && /no live evidence/.test(selfTest.summary),
      selfTest.summary,
    );
    check('exactly five checks are rendered', selfTest.checkCount === 5, String(selfTest.checkCount));
    check('every rendered check passed', selfTest.allPassed === true);
    check('the live region announces the self-test result', /offline self-test/i.test(selfTest.live), selfTest.live);

    const consoleCheck = await evaluate(page, 'window.__smokeErrors ?? []');
    check('no uncaught page errors were recorded', (consoleCheck ?? []).length === 0, JSON.stringify(consoleCheck));

    page.close();
    browserClient.close();
  } finally {
    if (browser.exitCode === null && browser.signalCode === null) {
      browser.kill('SIGKILL');
      await Promise.race([
        once(browser, 'exit').catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    server.close();
    await once(server, 'close').catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\nsmoke: ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(`smoke: failed to run — ${error.message}\n`);
  process.exit(1);
});
