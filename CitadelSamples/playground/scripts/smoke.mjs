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

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    process.stdout.write('smoke: no Chromium found. Set CITADEL_SMOKE_CHROME to a browser path.\n');
    process.exit(2);
  }

  const server = createPlaygroundServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const profile = await mkdtemp(join(tmpdir(), 'citadel-smoke-'));
  const browser = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let browserWs = '';
  const readEndpoint = new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/ws:\/\/[^\s]+/);
      if (match) resolve(match[0]);
    };
    browser.stderr.on('data', onData);
    browser.stdout.on('data', onData);
    setTimeout(() => reject(new Error('browser did not report a DevTools endpoint')), 30000);
  });

  try {
    browserWs = await readEndpoint;
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
    await page.send('Page.navigate', { url: base });
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
    check('capability reports no runtime', /not configured/i.test(first.capability), first.capability);
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
        document.querySelector('[data-sample="cleanup"]').click();
        document.getElementById('tab-configure').click();
        const outcomes = [
          window.__set('Subscription ID', '00000000-1111-2222-3333-444444444444'),
          window.__set('Governance hub resource group', 'rg-smoke'),
          window.__set('Location', 'swedencentral'),
          window.__set('API Management service name', 'apim-smoke'),
          window.__set('Gateway URL', 'https://apim-smoke.azure-api.net'),
          window.__set('Foundry account name', 'aif-smoke'),
          window.__set('Foundry project name', 'proj-smoke'),
          window.__set('Foundry agent name', 'HR-ChatAgent'),
          window.__set('Key Vault name', 'kv-smoke'),
          window.__set('This gateway is not production', true),
        ];
        return { outcomes, errors: document.querySelectorAll('#panel-configure .field-error').length };
      })()`,
    );
    check('every configure field could be set by its label', filled.outcomes.every((o) => o === 'ok'), filled.outcomes.join(','));
    check('a complete configuration clears every inline error', filled.errors === 0, String(filled.errors));

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
    check('run stays disabled with no runtime attached', gate.after.runDisabled === true);
    check('the missing runtime is explained', /runtime|not attached/i.test(gate.after.reason), gate.after.reason);

    const invalidated = await evaluate(
      page,
      `(() => {
        document.getElementById('tab-configure').click();
        window.__set('Location', 'westeurope');
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
        // Deliberately clear a required value to prove the inline error path.
        // Subscription ID is classified 'required'; Gateway URL is 'derived',
        // which warns rather than blocking, so it would not do here.
        window.__set('Subscription ID', '');
        const errors = [...document.querySelectorAll('.field-error')].map(e => e.textContent);
        const invalid = document.querySelectorAll('#panel-configure [aria-invalid="true"]').length;
        const described = document.querySelector('#panel-configure [aria-describedby]') !== null;
        document.getElementById('tab-request').click();
        const blockedText = document.getElementById('panel-request').textContent;
        // Restore it and add the secret, then read the preview.
        document.getElementById('tab-configure').click();
        window.__set('Subscription ID', '00000000-1111-2222-3333-444444444444');
        window.__set('Access-contract api-key', 'FAKE-SMOKE-KEY-0000');
        const cleared = document.querySelectorAll('#panel-configure .field-error').length;
        document.getElementById('tab-request').click();
        const preview = document.querySelector('#panel-request .preview')?.textContent ?? '';
        return {
          errorCount: errors.length,
          invalid,
          described,
          blockedText,
          cleared,
          preview,
          firstError: errors[0] ?? '',
        };
      })()`,
    );
    check('a missing required input is reported inline', validation.errorCount > 0, String(validation.errorCount));
    check('the message names the field', /Subscription ID is required/.test(validation.firstError), validation.firstError);
    check('invalid controls are marked aria-invalid', validation.invalid > 0, String(validation.invalid));
    check('controls are described by their help and errors', validation.described === true);
    check(
      'an invalid configuration explains why no plan exists',
      /Complete the required inputs/.test(validation.blockedText),
      validation.blockedText.slice(0, 80),
    );
    check('fixing the input clears the inline error', validation.cleared === 0, String(validation.cleared));
    check('the preview never contains the typed secret', !validation.preview.includes('FAKE-SMOKE-KEY-0000'));
    check(
      'the preview uses an environment placeholder',
      validation.preview.includes('${CITADEL_GATEWAY_ACCESS_API_KEY}'),
      validation.preview.slice(0, 80),
    );

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

    const consoleCheck = await evaluate(page, 'window.__smokeErrors ?? []');
    check('no uncaught page errors were recorded', (consoleCheck ?? []).length === 0, JSON.stringify(consoleCheck));

    page.close();
    browserClient.close();
  } finally {
    browser.kill();
    server.close();
    await once(server, 'close').catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\nsmoke: ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(`smoke: failed to run — ${error.message}\n`);
  process.exit(1);
});
