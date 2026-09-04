#!/usr/bin/env node
/**
 * Browser acceptance contract for the protected-source playground.
 *
 * This runner is deliberately separate from smoke.mjs while the redesign is
 * landing. It uses only Node and Chromium, touches no Azure or live endpoint,
 * and exits non-zero when any browser, source, or execution-state contract is
 * missing.
 *
 * Usage: node scripts/browser-acceptance.mjs [--chrome <path>]
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { CATALOGUE, getSample } from '../src/catalogue/index.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';
import { createPlaygroundServer } from '../server.mjs';
import {
  expectedParameterFields,
  expectedParameterPaths,
  expectedSourceContract,
  parameterZonePaths,
  validateSourceDomSnapshot,
  validateSourcePayload,
  validateValidationPayload,
  validateWritableControls,
} from './browser-acceptance-contract.mjs';
import { createCheckReporter, launchBrowserHarness } from './browser-harness.mjs';

const NOTEBOOK_URL = new URL('../../citadel-publish-contract-tests.ipynb', import.meta.url);
const SECRET = 'FAKE-ACCEPTANCE-KEY';
const SOURCE_SELECTOR = '[data-source-cell][data-cell-index][data-protected="true"][data-editable="false"]';
const reporter = createCheckReporter({ name: 'browser acceptance' });

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function reportIssues(label, issues) {
  reporter.check(label, issues.length === 0, issues.join('; '));
}

async function browserJson(harness, path, options = {}) {
  return harness.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(path)}, ${JSON.stringify(options)});
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { parseError: text }; }
    return { status: response.status, ok: response.ok, body };
  })()`);
}

async function selectSample(harness, sampleId) {
  await harness.evaluate(`(() => {
    const target = document.querySelector('[data-sample=${JSON.stringify(sampleId)}]');
    if (!target) return false;
    target.click();
    document.getElementById('tab-guide')?.click();
    return true;
  })()`);
  await harness.waitFor(
    `document.querySelectorAll(${JSON.stringify(SOURCE_SELECTOR)}).length === ${getSample(sampleId).sourceCells.length}`,
    { label: `protected source for ${sampleId}` },
  );
}

async function sourceDomSnapshot(harness) {
  return harness.evaluate(`(() => [...document.querySelectorAll(${JSON.stringify(SOURCE_SELECTOR)})].map((cell) => {
    const source = cell.querySelector('pre[data-source-code]') ?? cell.querySelector('pre code');
    return {
      cellIndex: Number(cell.dataset.cellIndex),
      protected: cell.dataset.protected,
      editable: cell.dataset.editable,
      text: source?.textContent ?? '',
      editableDescendants: cell.querySelectorAll(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
      ).length,
    };
  }))()`);
}

async function writableSnapshot(harness) {
  return harness.evaluate(`(() => [...document.querySelectorAll(
    '#panel-configure input:not([disabled]):not([readonly]),' +
    '#panel-configure textarea:not([disabled]):not([readonly]),' +
    '#panel-configure select:not([disabled]),' +
    '#panel-configure [contenteditable="true"]'
  )].filter((control) => control.getClientRects().length > 0).map((control) => {
    const row = control.closest('[data-parameter-path]');
    return {
      path: row?.dataset.parameterPath ?? '',
      label: row?.querySelector('label')?.textContent.trim() ?? control.getAttribute('aria-label') ?? control.tagName,
      tag: control.tagName.toLowerCase(),
      type: control.type ?? '',
      secret: row?.dataset.parameterSecret === 'true' || control.type === 'password',
      inProtectedSource: Boolean(control.closest('[data-protected="true"]')),
    };
  }))()`);
}

async function checkSourceContracts(harness, notebook, notebookMeta) {
  const sourceBySample = new Map();
  for (const sample of CATALOGUE.samples) {
    const expected = expectedSourceContract({ sample, notebook, notebookMeta });
    const response = await browserJson(harness, `/api/source/${encodeURIComponent(sample.id)}`);
    reporter.equal(`${sample.id}: protected source endpoint succeeds`, response.status, 200);
    if (!response.ok) continue;

    const declaredFields = expectedParameterFields(sample);
    const declaredPaths = expectedParameterPaths(sample);
    reportIssues(
      `${sample.id}: source response is exact, protected, and declares only its writable fields`,
      validateSourcePayload(response.body, expected, declaredFields),
    );
    sourceBySample.set(sample.id, { expected, payload: response.body });

    await selectSample(harness, sample.id);
    reportIssues(
      `${sample.id}: browser exposes exact protected source with no editable code`,
      validateSourceDomSnapshot(await sourceDomSnapshot(harness), expected.cells),
    );

    await harness.evaluate(`document.getElementById('tab-configure')?.click()`);
    reportIssues(
      `${sample.id}: only declared parameter, configuration, and secret fields are writable`,
      validateWritableControls(
        await writableSnapshot(harness),
        declaredPaths,
        parameterZonePaths(response.body.parameterZones),
      ),
    );
  }
  reporter.equal('all 19 protected-source contracts were exercised', sourceBySample.size, 19);
  return sourceBySample;
}

async function checkOfflineValidation(harness, sourceBySample) {
  const sampleId = 'azure-context-check';
  const expected = sourceBySample.get(sampleId)?.expected;
  if (!expected) {
    reporter.check('offline validation has source metadata to validate', false, `${sampleId} source response was unavailable`);
    return;
  }

  const valid = await browserJson(harness, `/api/source/${sampleId}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
  });
  reporter.equal('offline source validation succeeds with the exact request body', valid.status, 200);
  if (valid.ok) {
    reportIssues(
      'offline source validation reports compile-only evidence and removes its workspace',
      validateValidationPayload(valid.body, { sampleId, expectedSource: expected }),
    );
    reporter.equal('offline source validation passes', valid.body.state, 'passed');
  }

  for (const [label, body] of [
    ['undeclared request members', { protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId }],
    ['a missing protocol version', {}],
    ['a mistyped protocol version', { protocolVersion: String(EXECUTION_PROTOCOL_VERSION) }],
    ['an unsupported protocol version', { protocolVersion: EXECUTION_PROTOCOL_VERSION + 1 }],
  ]) {
    const response = await browserJson(harness, `/api/source/${sampleId}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    reporter.check(
      `offline source validation rejects ${label}`,
      response.status >= 400 && response.status < 500,
      String(response.status),
    );
  }

  await selectSample(harness, sampleId);
  const validationUi = await harness.evaluate(`(async () => {
    const button = document.querySelector('[data-source-validate]') ??
      [...document.querySelectorAll('button')].find((candidate) =>
        /validate|review/i.test(candidate.textContent) && candidate.closest('[data-source-surface], #panel-guide')
      );
    if (!button) return { button: false, executionModes: [], validationModes: [] };
    button.click();
    const deadline = Date.now() + 10000;
    while (!document.querySelector('[data-validation-mode="python-compile-only"]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      button: true,
      executionModes: [...document.querySelectorAll('[data-execution-mode]')].map((node) => ({
        mode: node.dataset.executionMode,
        text: node.textContent.trim(),
      })),
      validationModes: [...document.querySelectorAll('[data-validation-mode]')].map((node) => node.dataset.validationMode),
      text: document.getElementById('panel-guide')?.textContent ?? '',
    };
  })()`);
  reporter.check('protected source exposes a keyboard-operable validation action', validationUi.button === true);
  reporter.check(
    'offline validation is labelled offline-local',
    validationUi.executionModes.some((entry) => entry.mode === 'offline-local' && /offline|local/i.test(entry.text)),
    JSON.stringify(validationUi.executionModes),
  );
  reporter.check(
    'offline validation is labelled python-compile-only',
    validationUi.validationModes.includes('python-compile-only'),
    validationUi.validationModes.join(', '),
  );
  reporter.check('offline validation never claims live evidence', !/\blive evidence:\s*(yes|true)\b/i.test(validationUi.text ?? ''));
}

async function installCapableExecutor(harness, expression) {
  await harness.evaluate(`(() => {
    const hooks = globalThis.__citadelTestHooks;
    if (!hooks) return false;
    hooks.installExecutor(${expression});
    return true;
  })()`);
}

async function checkApprovalGate(harness) {
  await installCapableExecutor(
    harness,
    `({
      describeCapability: () => ({ id: 'acceptance', kind: 'local', canExecute: true, supportedStepTypes: [], reason: 'test' }),
      supports: () => ({ supported: true, unsupportedStepTypes: [] }),
      cancel: async () => ({ cancelled: false }),
      execute: async (_plan, context = {}) => {
        context.onProgress?.({ type: 'run-start', runId: 'approval-0001', sampleId: 'cleanup', workspace: '.' });
        return {
          state: 'completed', sampleId: 'cleanup', summary: 'Approval-gated test completed.', detail: '',
          steps: [], assertions: [], configurationUpdates: {}, secretUpdates: {},
          meta: { executor: 'local', executionMode: 'local', runId: 'approval-0001', artifacts: [] }
        };
      }
    })`,
  );

  const gate = await harness.evaluate(`(async () => {
    document.querySelector('[data-sample="cleanup"]').click();
    const hooks = globalThis.__citadelTestHooks;
    hooks.setValue('hub.subscriptionId', '00000000-1111-2222-3333-444444444444');
    hooks.setValue('hub.resourceGroupName', 'rg-acceptance');
    hooks.setValue('hub.apimName', 'apim-acceptance');
    hooks.setValue('samples.cleanup.confirmNonProduction', true);
    document.getElementById('tab-request').click();
    const before = {
      disabled: document.getElementById('run-button')?.disabled,
      reason: document.querySelector('.runbar-reason')?.textContent ?? '',
    };
    const acknowledgement = document.getElementById('ack-check');
    acknowledgement?.click();
    const approved = {
      disabled: document.getElementById('run-button')?.disabled,
      checked: document.getElementById('ack-check')?.checked,
    };
    document.getElementById('tab-configure').click();
    hooks.setValue('hub.resourceGroupName', 'rg-acceptance-changed');
    document.getElementById('tab-request').click();
    const invalidated = {
      disabled: document.getElementById('run-button')?.disabled,
      checked: document.getElementById('ack-check')?.checked,
    };
    document.getElementById('ack-check')?.click();
    document.getElementById('run-button')?.click();
    const deadline = Date.now() + 5000;
    while (hooks.isRunning() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      before,
      approved,
      invalidated,
      afterRun: {
        disabled: document.getElementById('run-button')?.disabled,
        checked: document.getElementById('ack-check')?.checked,
      },
    };
  })()`);

  reporter.check('risky execution is blocked before approval', gate.before.disabled === true && /acknowledge/i.test(gate.before.reason));
  reporter.check('one explicit approval enables the reviewed run', gate.approved.disabled === false && gate.approved.checked === true);
  reporter.check('editing configuration invalidates approval', gate.invalidated.disabled === true && gate.invalidated.checked === false);
  reporter.check('approval is spent by one run', gate.afterRun.disabled === true && gate.afterRun.checked === false);
}

async function prepareWeatherRecipe(harness) {
  await harness.evaluate(`(() => {
    document.querySelector('[data-sample="weather-mcp-discovery"]').click();
    const hooks = globalThis.__citadelTestHooks;
    hooks.setValue('hub.gatewayUrl', 'https://gateway.invalid');
    hooks.setValue('gatewayAccess.apiKey', ${JSON.stringify(SECRET)});
    document.getElementById('tab-request').click();
  })()`);
}

async function checkStreamingAndCancellation(harness) {
  await prepareWeatherRecipe(harness);
  await installCapableExecutor(
    harness,
    `(() => {
      let finish;
      const pending = new Promise((resolve) => { finish = resolve; });
      return {
        describeCapability: () => ({ id: 'acceptance-local', kind: 'local', canExecute: true, supportedStepTypes: [], reason: 'test' }),
        supports: () => ({ supported: true, unsupportedStepTypes: [] }),
        execute: async (_plan, context = {}) => {
          context.onProgress?.({ type: 'run-start', runId: 'stream-0001', sampleId: 'weather-mcp-discovery', workspace: '.' });
          context.onProgress?.({ type: 'step-start', step: { id: 'initialize', kind: 'http', title: 'Initialize' } });
          context.onProgress?.({ type: 'step', step: {
            id: 'initialize', kind: 'http', title: 'Initialize', state: 'completed',
            durationMs: 4, detail: 'Handshake complete.', evidence: { status: 200 }
          } });
          context.onProgress?.({ type: 'step-start', step: { id: 'list-tools', kind: 'http', title: 'List tools' } });
          return pending;
        },
        cancel: async () => {
          finish({
            state: 'cancelled', sampleId: 'weather-mcp-discovery', summary: 'Cancelled after 1 of 3 steps.', detail: '',
            steps: [
              { id: 'initialize', kind: 'http', title: 'Initialize', state: 'completed', durationMs: 4, detail: 'Handshake complete.', evidence: { status: 200 } },
              { id: 'list-tools', kind: 'http', title: 'List tools', state: 'cancelled', durationMs: 2, detail: 'Cancelled.', evidence: {} }
            ],
            assertions: [], configurationUpdates: {}, secretUpdates: {},
            meta: { executor: 'local', executionMode: 'local', runId: 'stream-0001', artifacts: [] }
          });
          return { cancelled: true };
        }
      };
    })()`,
  );

  const run = await harness.evaluate(`(async () => {
    document.getElementById('run-button').click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const during = {
      busy: document.getElementById('run-button')?.getAttribute('aria-busy'),
      cancelEnabled: document.getElementById('cancel-button')?.disabled === false,
      completed: [...document.querySelectorAll('#panel-response .step[data-state="completed"] .step-title')].map((node) => node.textContent),
      running: [...document.querySelectorAll('#panel-response .step[data-state="running"] .step-title')].map((node) => node.textContent),
    };
    document.getElementById('cancel-button').click();
    const deadline = Date.now() + 5000;
    while (globalThis.__citadelTestHooks.isRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    document.getElementById('tab-response').click();
    return {
      during,
      finalState: document.querySelector('#panel-response .result')?.dataset.state,
      states: [...document.querySelectorAll('#panel-response .step')].map((node) => node.dataset.state),
      text: document.getElementById('panel-response')?.textContent ?? '',
    };
  })()`);

  reporter.check(
    'streamed output shows completed and in-flight steps before the run settles',
    run.during.busy === 'true' &&
      run.during.cancelEnabled === true &&
      run.during.completed.includes('Initialize') &&
      run.during.running.includes('List tools'),
    JSON.stringify(run.during),
  );
  reporter.check('cancellation produces a cancelled result', run.finalState === 'cancelled', String(run.finalState));
  reporter.check('cancellation preserves evidence for steps already run', run.states.includes('completed') && run.states.includes('cancelled'));
  reporter.check('streamed and cancelled output never renders a secret', !run.text.includes(SECRET));
}

async function checkTimeoutAndArtifacts(harness) {
  await installCapableExecutor(
    harness,
    `({
      describeCapability: () => ({ id: 'acceptance-local', kind: 'local', canExecute: true, supportedStepTypes: [], reason: 'test' }),
      supports: () => ({ supported: true, unsupportedStepTypes: [] }),
      cancel: async () => ({ cancelled: false }),
      execute: async () => ({
        state: 'failed', sampleId: 'weather-mcp-discovery', summary: 'The source validation timed out.', detail: 'Stopped at the configured deadline.',
        steps: [{
          id: 'compile', kind: 'artifact', title: 'Compile protected source', state: 'failed', durationMs: 25,
          detail: 'Timed out after 25 ms.', artifactPath: 'artifacts/source-validation.txt',
          evidence: { timedOut: true, timeoutMs: 25 }
        }],
        assertions: [], configurationUpdates: {},
        secretUpdates: { 'gatewayAccess.apiKey': ${JSON.stringify(SECRET)} },
        meta: {
          executor: 'local', executionMode: 'local', liveEvidence: false, runId: 'timeout-0001',
          artifacts: ['artifacts/source-validation.txt']
        }
      })
    })`,
  );

  const result = await harness.evaluate(`(async () => {
    document.getElementById('tab-request').click();
    document.getElementById('run-button').click();
    const deadline = Date.now() + 5000;
    while (globalThis.__citadelTestHooks.isRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    document.getElementById('tab-response').click();
    const panel = document.getElementById('panel-response');
    return {
      state: panel.querySelector('.result')?.dataset.state,
      text: panel.textContent,
      html: panel.innerHTML,
      executionModes: [...panel.querySelectorAll('[data-execution-mode]')].map((node) => ({
        mode: node.dataset.executionMode,
        text: node.textContent.trim(),
      })),
    };
  })()`);

  reporter.check('timeout is rendered as failure evidence, never success', result.state === 'failed' && /timed out/i.test(result.text));
  reporter.check('timeout evidence includes the applied limit', result.text.includes('timedOut') && result.text.includes('25'));
  reporter.check(
    'generated artifact evidence names both the step artifact and generated-file result',
    result.text.includes('artifacts/source-validation.txt') && /Generated files/.test(result.text),
  );
  reporter.check(
    'local execution carries an explicit local label',
    result.executionModes.some((entry) => entry.mode === 'local' && /local/i.test(entry.text)),
    JSON.stringify(result.executionModes),
  );
  reporter.check('returned secret updates are presence-only in rendered output', !result.text.includes(SECRET) && !result.html.includes(SECRET));
}

async function checkLiveLabel(harness) {
  await installCapableExecutor(
    harness,
    `({
      describeCapability: () => ({ id: 'acceptance-relay', kind: 'relay', canExecute: true, supportedStepTypes: [], reason: 'test' }),
      supports: () => ({ supported: true, unsupportedStepTypes: [] }),
      cancel: async () => ({ cancelled: false }),
      execute: async () => ({
        state: 'completed', sampleId: 'weather-mcp-discovery', summary: 'Synthetic live-labelled result completed.', detail: '',
        steps: [], assertions: [], configurationUpdates: {}, secretUpdates: {},
        meta: { executor: 'relay', executionMode: 'live', liveEvidence: true, runId: 'live-label-0001', artifacts: [] }
      })
    })`,
  );
  const modes = await harness.evaluate(`(async () => {
    document.getElementById('tab-request').click();
    document.getElementById('run-button').click();
    const deadline = Date.now() + 5000;
    while (globalThis.__citadelTestHooks.isRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    document.getElementById('tab-response').click();
    return [...document.querySelectorAll('#panel-response [data-execution-mode]')].map((node) => ({
      mode: node.dataset.executionMode,
      text: node.textContent.trim(),
    }));
  })()`);
  reporter.check(
    'live evidence carries an explicit live label',
    modes.some((entry) => entry.mode === 'live' && /live/i.test(entry.text)),
    JSON.stringify(modes),
  );
}

async function checkSecretRendering(harness) {
  const secret = await harness.evaluate(`(() => {
    const attributes = [];
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        if (attribute.value.includes(${JSON.stringify(SECRET)})) {
          attributes.push(element.tagName + '[' + attribute.name + ']');
        }
      }
    }
    const secretControl = document.querySelector('[data-parameter-path="gatewayAccess.apiKey"] input');
    return {
      inText: document.body.textContent.includes(${JSON.stringify(SECRET)}),
      inMarkup: document.body.innerHTML.includes(${JSON.stringify(SECRET)}),
      attributes,
      secretControlType: secretControl?.type ?? '',
    };
  })()`);
  reporter.check(
    'secret values are never rendered as text, markup, or attributes',
    secret.inText === false && secret.inMarkup === false && secret.attributes.length === 0,
    JSON.stringify(secret),
  );
  reporter.equal('the declared secret field stays masked', secret.secretControlType, 'password');
}

async function checkKeyboardOrder(harness) {
  await harness.page.send('Page.navigate', { url: `${harness.baseUrl}/?testExecutor` });
  await harness.waitFor('document.querySelectorAll(".dir-item").length === 19', { label: 'page reload for keyboard checks' });
  const expected = await harness.evaluate(`(() => {
    const selector = [
      'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
      'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]'
    ].join(',');
    const nodes = [...new Set(document.querySelectorAll(selector))]
      .filter((node) => {
        const closedDetails = node.closest('details:not([open])');
        const isClosedSummary = closedDetails && node === closedDetails.querySelector(':scope > summary');
        return node.tabIndex >= 0 &&
          (!closedDetails || isClosedSummary) &&
          node.getClientRects().length > 0 &&
          getComputedStyle(node).visibility !== 'hidden';
      });
    nodes.forEach((node, index) => { node.dataset.acceptanceFocus = String(index); });
    document.activeElement?.blur();
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    document.body.removeAttribute('tabindex');
    return nodes.map((node) => ({
      index: node.dataset.acceptanceFocus,
      id: node.id,
      text: node.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60),
    }));
  })()`);

  const actual = [];
  for (let index = 0; index < expected.length; index += 1) {
    await harness.pressKey('Tab');
    actual.push(await harness.evaluate(`document.activeElement?.dataset.acceptanceFocus ?? ''`));
  }
  reporter.check(
    'Tab follows visible DOM order without traps or skipped controls',
    JSON.stringify(actual) === JSON.stringify(expected.map((entry) => entry.index)),
    `expected ${expected.length} controls, observed ${actual.filter(Boolean).length}`,
  );
  const tabStops = await harness.evaluate(
    `[...document.querySelectorAll('[role="tab"]')].filter((node) => node.tabIndex === 0).length`,
  );
  reporter.equal('the tablist contributes exactly one stop to page Tab order', tabStops, 1);
}

async function checkResponsiveLayout(harness) {
  await harness.setViewport({ width: 320, height: 640, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const narrow = await harness.evaluate(`(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    sourceOverflowsViewport: [...document.querySelectorAll(${JSON.stringify(SOURCE_SELECTOR)})]
      .some((node) => node.getBoundingClientRect().right > window.innerWidth + 1),
    compactRecipeVisible: getComputedStyle(document.querySelector('.strip-compact')).display !== 'none',
  }))()`);
  reporter.check('320px layout has no page-level horizontal overflow', narrow.documentWidth <= narrow.viewport, `${narrow.documentWidth} > ${narrow.viewport}`);
  reporter.check('320px layout keeps protected source inside the viewport', narrow.sourceOverflowsViewport === false);
  reporter.check('320px layout exposes the compact recipe control', narrow.compactRecipeVisible === true);

  // A 640 CSS-pixel viewport models 200% zoom on a 1280-pixel display.
  await harness.setViewport({ width: 640, height: 480, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const zoom = await harness.evaluate(`(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    sourceOverflowsViewport: [...document.querySelectorAll(${JSON.stringify(SOURCE_SELECTOR)})]
      .some((node) => node.getBoundingClientRect().right > window.innerWidth + 1),
  }))()`);
  reporter.check('200% zoom has no page-level horizontal overflow', zoom.documentWidth <= zoom.viewport, `${zoom.documentWidth} > ${zoom.viewport}`);
  reporter.check('200% zoom keeps protected source inside the viewport', zoom.sourceOverflowsViewport === false);
}

async function main() {
  const notebookBytes = await readFile(NOTEBOOK_URL);
  const notebook = JSON.parse(notebookBytes.toString('utf8'));
  const notebookMeta = {
    fileName: CATALOGUE.sourceNotebook.fileName,
    sha256: createHash('sha256').update(notebookBytes).digest('hex'),
    bytes: notebookBytes.length,
  };

  const harness = await launchBrowserHarness({
    browserPath: argumentValue('--chrome'),
    createServer: ({ port }) => createPlaygroundServer({ port }),
  });
  try {
    await harness.waitFor('document.querySelectorAll(".dir-item").length === 19', {
      label: 'the 19-recipe directory',
    });
    await harness.waitFor('Boolean(globalThis.__citadelTestHooks)', { label: 'the loopback-only test executor seam' });

    const sourceBySample = await checkSourceContracts(harness, notebook, notebookMeta);
    await checkOfflineValidation(harness, sourceBySample);
    await checkApprovalGate(harness);
    await checkStreamingAndCancellation(harness);
    await checkTimeoutAndArtifacts(harness);
    await checkLiveLabel(harness);
    await checkSecretRendering(harness);
    await checkKeyboardOrder(harness);
    await checkResponsiveLayout(harness);

    reporter.check('no uncaught browser errors were recorded', harness.pageErrors.length === 0, harness.pageErrors.join('; '));
  } finally {
    await harness.close();
  }

  const result = reporter.finish();
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  process.stdout.write(`browser acceptance: failed to run - ${error.message}\n`);
  process.exitCode = /No Chromium browser found/.test(error.message) ? 2 : 1;
});
