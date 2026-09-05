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

async function checkValidationAbortReset(harness) {
  await selectSample(harness, 'azure-context-check');
  let heldRequestId = null;
  const removeListener = harness.page.on('Fetch.requestPaused', (event) => {
    if (event.request.url.includes('/api/source/azure-context-check/validate')) {
      heldRequestId = event.requestId;
      return;
    }
    harness.page.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
  });
  await harness.page.send('Fetch.enable', {
    patterns: [{ urlPattern: '*api/source/azure-context-check/validate*', requestStage: 'Request' }],
  });
  try {
    await harness.evaluate(`(() => {
      void globalThis.__citadelTestHooks.validateProtectedSource();
      return true;
    })()`);
    await harness.waitFor(
      `document.getElementById('validate-source-button')?.textContent.includes('Validating')`,
      { label: 'held source validation to enter its running state' },
    );
    await selectSample(harness, 'apim-discovery');
    await selectSample(harness, 'azure-context-check');
    const reset = await harness.evaluate(`(() => ({
      button: document.getElementById('validate-source-button')?.textContent ?? '',
      running: Boolean(document.querySelector('[data-validation-mode][aria-busy="true"]')),
      text: document.getElementById('panel-code')?.textContent ?? '',
    }))()`);
    reporter.check(
      'switching recipes resets an aborted source validation to not-run',
      !/Validating/.test(reset.button) && reset.running === false && !/Compiling protected Python cells/.test(reset.text),
      JSON.stringify(reset),
    );
  } finally {
    if (heldRequestId) {
      await harness.page.send('Fetch.failRequest', { requestId: heldRequestId, errorReason: 'Aborted' }).catch(() => {});
    }
    await harness.page.send('Fetch.disable').catch(() => {});
    removeListener?.();
  }
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

async function serverJson(harness, path, options = {}) {
  const response = await fetch(new URL(path, harness.baseUrl), {
    ...options,
    headers: {
      Origin: harness.baseUrl,
      'Sec-Fetch-Site': 'same-origin',
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { parseError: text };
  }
  return { status: response.status, ok: response.ok, body };
}

async function selectSample(harness, sampleId) {
  await harness.evaluate(`(() => {
    const target = document.querySelector('[data-sample=${JSON.stringify(sampleId)}]');
    if (!target) return false;
    target.click();
    document.getElementById('tab-code')?.click();
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
    '[data-parameter-path] input:not([disabled]):not([readonly]),' +
    '[data-parameter-path] textarea:not([disabled]):not([readonly]),' +
    '[data-parameter-path] select:not([disabled]),' +
    '[data-parameter-path] [contenteditable="true"]'
  )].map((control) => {
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

    await harness.evaluate(`document.getElementById('tab-code')?.click()`);
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

async function checkCodeParameterWorkspace(harness) {
  const sample = getSample('tool-rate-limit-burst');
  const expectedPaths = expectedParameterPaths(sample);
  const expectedGroups = [...new Set(sample.configurationEntries.map((entry) => entry.requirement))];
  await selectSample(harness, sample.id);
  await harness.evaluate(`document.getElementById('tab-code')?.click()`);

  const workspace = await harness.evaluate(`(() => {
    const controls = [...document.querySelectorAll('[data-parameter-path] input, [data-parameter-path] textarea, [data-parameter-path] select')];
    const pathCounts = Object.fromEntries(${JSON.stringify(expectedPaths)}.map((path) => [
      path,
      controls.filter((control) => control.closest('[data-parameter-path]')?.dataset.parameterPath === path).length,
    ]));
    const groups = [...document.querySelectorAll('[data-requirement-group]')].map((group) => group.dataset.requirementGroup);
    const rows = [...document.querySelectorAll('[data-parameter-path]')];
    const advanced = document.querySelector('.advanced-parameters');
    const firstPrimary = document.querySelector('.parameters-section > .parameter-group');
    return {
      paneCount: document.querySelectorAll('[data-parameter-pane]').length,
      pathCounts,
      groups,
      allInCode: controls.every((control) => Boolean(control.closest('#panel-code [data-parameter-pane]'))),
      labelled: controls.every((control) => {
        const label = document.querySelector('label[for="' + CSS.escape(control.id) + '"]');
        return Boolean(label?.textContent.trim() || control.getAttribute('aria-label'));
      }),
      named: controls.every((control) => control.name === control.closest('[data-parameter-path]')?.dataset.parameterPath),
      autocomplete: controls.every((control) => Boolean(control.autocomplete)),
      readinessLabel: document.querySelector('.parameters-section')?.getAttribute('aria-labelledby') ?? '',
      secretTypes: controls
        .filter((control) => control.closest('[data-parameter-secret="true"]'))
        .map((control) => control.type),
      hasConfigureTab: Boolean(document.getElementById('tab-configure') || document.getElementById('panel-configure')),
      guidedFields: rows.every((row) =>
        Boolean(
          row.querySelector('.prow-purpose')?.textContent.trim() &&
          row.querySelectorAll('.prow-badges .chip').length >= 2 &&
          row.querySelector('.prow-pattern')?.textContent.trim() &&
          /Where do I get this\\?/.test(row.querySelector('.field-source > summary')?.textContent ?? '')
        )
      ),
      advancedClosed: Boolean(advanced && !advanced.open),
      advancedGroups: [...(advanced?.querySelectorAll('[data-requirement-group]') ?? [])].map(
        (group) => group.dataset.requirementGroup
      ),
      primaryBeforeAdvanced: Boolean(
        firstPrimary && advanced && firstPrimary.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      sourceNavCount: document.querySelectorAll('.source-nav a').length,
      sourceCellCount: document.querySelectorAll('[data-source-cell]').length,
    };
  })()`);

  reporter.equal('Code renders exactly one canonical parameter pane', workspace.paneCount, 1);
  reporter.check(
    'every declared input has exactly one canonical control',
    Object.values(workspace.pathCounts).every((count) => count === 1),
    JSON.stringify(workspace.pathCounts),
  );
  reporter.check('every parameter control belongs to Code', workspace.allInCode === true);
  reporter.check(
    'all declared requirement groups are present and scannable',
    workspace.groups.length === expectedGroups.length && expectedGroups.every((group) => workspace.groups.includes(group)),
    JSON.stringify(workspace.groups),
  );
  reporter.check(
    'parameter controls have labels, names, and autocomplete metadata',
    workspace.labelled === true && workspace.named === true && workspace.autocomplete === true,
    JSON.stringify(workspace),
  );
  reporter.check('parameter readiness is programmatically labelled', workspace.readinessLabel === 'parameters-section-title');
  reporter.check(
    'every declared secret uses a masked password control',
    workspace.secretTypes.length > 0 && workspace.secretTypes.every((type) => type === 'password'),
    workspace.secretTypes.join(', '),
  );
  reporter.check('the disconnected Configure workflow is absent', workspace.hasConfigureTab === false);
  reporter.check('each field shows purpose, requirement, readiness, pattern, and acquisition help', workspace.guidedFields === true);
  reporter.check(
    'defaulted and generated fields are progressively disclosed after required inputs',
    workspace.advancedClosed === true &&
      workspace.primaryBeforeAdvanced === true &&
      JSON.stringify(workspace.advancedGroups) === JSON.stringify(['optional', 'generated']),
    JSON.stringify(workspace),
  );
  reporter.check(
    'protected source navigation names every cited cell',
    workspace.sourceNavCount === workspace.sourceCellCount && workspace.sourceCellCount > 0,
    JSON.stringify(workspace),
  );

  const wrapping = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('.source-tools button')].find((node) => /Wrap long lines/.test(node.textContent));
    button.focus();
    button.click();
    const source = document.querySelector('.source-code');
    const activeButton = [...document.querySelectorAll('.source-tools button')].find((node) => /horizontal scrolling/.test(node.textContent));
    const wrapped = {
      pressed: activeButton?.getAttribute('aria-pressed') ?? '',
      whiteSpace: getComputedStyle(source).whiteSpace,
      focused: document.activeElement?.id ?? '',
    };
    activeButton?.click();
    return wrapped;
  })()`);
  reporter.check(
    'protected source offers a keyboard button that wraps long lines',
    wrapping.pressed === 'true' && wrapping.whiteSpace === 'pre-wrap' && wrapping.focused === 'source-wrap-toggle',
    JSON.stringify(wrapping),
  );

  const advancedState = await harness.evaluate(`(async () => {
    const details = document.querySelector('.advanced-parameters');
    details.open = true;
    const path = 'samples.tool-rate-limit-burst.requestCount';
    const control = document.querySelector('[data-parameter-path="' + CSS.escape(path) + '"] input');
    control.focus();
    control.value = '41';
    control.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      open: document.querySelector('.advanced-parameters')?.open,
      focused: document.activeElement?.id ?? '',
      value: document.querySelector('[data-parameter-path="' + CSS.escape(path) + '"] input')?.value,
    };
  })()`);
  reporter.check(
    'advanced disclosure and focus survive canonical parameter edits',
    advancedState.open === true &&
      advancedState.focused === 'f-samples-tool-rate-limit-burst-requestCount' &&
      advancedState.value === '41',
    JSON.stringify(advancedState),
  );

  const directory = await harness.evaluate(`(async () => {
    const shell = document.querySelector('.shell');
    const before = document.getElementById('directory').getBoundingClientRect().width;
    document.getElementById('directory-toggle').click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const after = document.getElementById('directory').getBoundingClientRect().width;
    const collapsed = {
      state: shell.dataset.directoryCollapsed,
      track: getComputedStyle(shell).getPropertyValue('--rail-directory').trim(),
      label: document.getElementById('directory-toggle').getAttribute('aria-label'),
      hiddenGroups: getComputedStyle(document.getElementById('directory-groups')).display === 'none',
    };
    document.getElementById('directory-toggle').click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { before, after, ...collapsed };
  })()`);
  reporter.check(
    'desktop recipe navigation is narrow and explicitly collapsible',
    directory.before <= 224 &&
      directory.track === '3.25rem' &&
      directory.state === 'true' &&
      directory.label === 'Expand recipe navigator' &&
      directory.hiddenGroups === true,
    JSON.stringify(directory),
  );

  await harness.evaluate(`(() => {
    const control = document.querySelector('[data-parameter-path="gatewayAccess.apiKey"] input');
    control.focus();
  })()`);
  const typedSecret = 'ABCDE12345';
  for (const character of typedSecret) {
    await harness.page.send('Input.dispatchKeyEvent', { type: 'char', key: character, text: character });
  }
  const secretDuringTyping = await harness.evaluate(`(() => {
    const control = document.querySelector('[data-parameter-path="gatewayAccess.apiKey"] input');
    return {
      type: control?.type ?? '',
      value: control?.value ?? '',
      textLeak: document.body.textContent.includes(${JSON.stringify(typedSecret)}),
      markupLeak: document.body.innerHTML.includes(${JSON.stringify(typedSecret)}),
    };
  })()`);
  await harness.evaluate(`document.getElementById('source-wrap-toggle').focus()`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const secretAfterBlur = await harness.evaluate(`(() => {
    const row = document.querySelector('[data-parameter-path="gatewayAccess.apiKey"]');
    return {
      value: row?.querySelector('input')?.value ?? '',
      ready: [...(row?.querySelectorAll('.prow-badges .chip') ?? [])].some((chip) => chip.textContent === 'Ready'),
      textLeak: document.body.textContent.includes(${JSON.stringify(typedSecret)}),
      markupLeak: document.body.innerHTML.includes(${JSON.stringify(typedSecret)}),
    };
  })()`);
  reporter.check(
    'masked secret controls preserve sequential typing without rendering the value',
    secretDuringTyping.type === 'password' &&
      secretDuringTyping.value === typedSecret &&
      secretDuringTyping.textLeak === false &&
      secretDuringTyping.markupLeak === false &&
      secretAfterBlur.value === '' &&
      secretAfterBlur.ready === true &&
      secretAfterBlur.textLeak === false &&
      secretAfterBlur.markupLeak === false,
    JSON.stringify({ secretDuringTyping, secretAfterBlur }),
  );

  const conditional = await harness.evaluate(`(() => {
    const setValue = (path, value) => {
      const row = document.querySelector('[data-parameter-path="' + CSS.escape(path) + '"]');
      const control = row?.querySelector('input, textarea, select');
      if (!control) return false;
      control.value = value;
      control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      return true;
    };
    setValue('samples.tool-rate-limit-burst.deployedEndpoint', '');
    setValue('hub.gatewayUrl', '');
    const beforeRow = document.querySelector('[data-parameter-path="hub.gatewayUrl"]');
    const beforeControl = beforeRow?.querySelector('input');
    const before = {
      required: beforeControl?.getAttribute('aria-required'),
      text: beforeRow?.textContent ?? '',
    };
    setValue('samples.tool-rate-limit-burst.deployedEndpoint', 'https://gateway.invalid/weather');
    const afterRow = document.querySelector('[data-parameter-path="hub.gatewayUrl"]');
    const afterControl = afterRow?.querySelector('input');
    return {
      before,
      after: {
        required: afterControl?.getAttribute('aria-required'),
        text: afterRow?.textContent ?? '',
      },
    };
  })()`);
  reporter.check(
    'a conditional input is required while its declared condition holds',
    conditional.before.required === 'true' && /condition holds now/i.test(conditional.before.text),
    JSON.stringify(conditional.before),
  );
  reporter.check(
    'the same conditional control becomes non-required when its condition clears',
    conditional.after.required === null && /condition does not hold now/i.test(conditional.after.text),
    JSON.stringify(conditional.after),
  );

  const directEdit = await harness.evaluate(`(() => {
    const path = 'samples.tool-rate-limit-burst.requestCount';
    const control = document.querySelector('[data-parameter-path="' + CSS.escape(path) + '"] input');
    control.value = '37';
    control.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('tab-request').click();
    document.getElementById('tab-code').click();
    return document.querySelector('[data-parameter-path="' + CSS.escape(path) + '"] input')?.value;
  })()`);
  reporter.equal('parameters edit directly on Code and retain canonical state', directEdit, '37');

  await selectSample(harness, 'azure-context-check');
  const invalid = await harness.evaluate(`(() => {
    document.getElementById('tab-code').click();
    const control = document.getElementById('f-hub-subscriptionId');
    control.value = 'not-a-guid';
    control.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      error: document.querySelector('[data-parameter-path="hub.subscriptionId"] .field-error')?.textContent ?? '',
      status: document.querySelector('#parameter-pane-summary .chip')?.textContent ?? '',
      reviewDisabled: document.getElementById('parameter-review-button')?.disabled,
    };
  })()`);
  reporter.check(
    'invalid parameter values never produce a ready pane or enabled review',
    /guid/i.test(invalid.error) && invalid.status !== 'Ready' && invalid.reviewDisabled === true,
    JSON.stringify(invalid),
  );
}

async function checkExecutionIdentity(harness) {
  await selectSample(harness, 'azure-context-check');
  const signedOut = await harness.evaluate(`(() => {
    const hooks = globalThis.__citadelTestHooks;
    const context = {
      kind: 'azure-cli-management',
      label: 'Azure CLI user',
      summary: 'Sign in before this local operator sample can run.',
      state: 'signed-out',
      code: 'azure-cli-signed-out',
      canExecute: false,
      authority: null,
      subscription: { activeId: null, activeName: null, configuredId: null, matches: null },
      gateway: null,
      hostedRelay: null,
      guarantees: { tokensExposed: false, credentialsPersisted: false },
      futureHostedProcess: null,
    };
    globalThis.__acceptanceSignedOutContext = context;
    hooks.setExecutionContext(context);
    const identity = document.querySelector('[data-execution-identity]');
    const parameters = document.querySelector('.parameters-section');
    return {
      journey: [...document.querySelectorAll('.run-path li')].map((item) => ({
        step: item.querySelector('span')?.textContent ?? '',
        label: [...item.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim(),
      })),
      identityBeforeParameters: Boolean(
        identity.compareDocumentPosition(parameters) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      heading: identity.querySelector('.task-section-title')?.textContent ?? '',
      text: identity.textContent,
      signInLabel: document.getElementById('start-azure-login')?.textContent ?? '',
      badge: identity.querySelector('.chip')?.textContent ?? '',
    };
  })()`);
  reporter.check(
    'the 5-step run path is visible in task order',
    JSON.stringify(signedOut.journey) ===
      JSON.stringify([
        { step: '1', label: 'Execution identity' },
        { step: '2', label: 'Parameters' },
        { step: '3', label: 'Protected code' },
        { step: '4', label: 'Approve & Run' },
        { step: '5', label: 'Output' },
      ]),
    JSON.stringify(signedOut.journey),
  );
  reporter.check(
    'Execution identity is the first task in the right pane',
    signedOut.identityBeforeParameters === true && /^1\. Execution identity/.test(signedOut.heading),
    signedOut.heading,
  );
  reporter.check(
    'signed-out Azure context names the specific sign-in action without claiming readiness',
    signedOut.signInLabel === 'Sign In to Azure' && signedOut.badge !== 'Ready' && /Runs as/.test(signedOut.text),
    JSON.stringify(signedOut),
  );

  const pending = await harness.evaluate(`(() => {
    globalThis.__citadelTestHooks.setAzureLogin({
      loginId: 'login-acceptance',
      state: 'waiting-for-user',
      verificationUrl: 'https://microsoft.com/devicelogin',
      userCode: 'ABCD-EFGH',
      message: 'Open Microsoft sign-in and enter the short code.',
      timestamps: {},
    });
    return {
      link: document.querySelector('.device-login a')?.getAttribute('href') ?? '',
      code: document.getElementById('azure-device-code')?.textContent ?? '',
      cancel: document.getElementById('cancel-azure-login')?.textContent ?? '',
      signInPresent: Boolean(document.getElementById('start-azure-login')),
    };
  })()`);
  reporter.check(
    'device-code pending state exposes its URL, short code, and cancellation',
    pending.link === 'https://microsoft.com/devicelogin' &&
      pending.code === 'ABCD-EFGH' &&
      pending.cancel === 'Cancel Azure sign-in' &&
      pending.signInPresent === false,
    JSON.stringify(pending),
  );

  const loginDuringRefresh = await harness.evaluate(`(() => {
    const hooks = globalThis.__citadelTestHooks;
    hooks.setAdvertisedExecutionContext(globalThis.__acceptanceSignedOutContext);
    hooks.setValue('hub.subscriptionId', 'subscription-changed-during-login');
    const snapshot = {
      state: document.querySelector('[data-execution-identity]')?.dataset.executionIdentity ?? '',
      code: document.getElementById('azure-device-code')?.textContent ?? '',
      cancel: document.getElementById('cancel-azure-login')?.textContent ?? '',
    };
    hooks.setExecutionContext(globalThis.__acceptanceSignedOutContext);
    hooks.setAzureLogin({
      loginId: 'login-acceptance',
      state: 'waiting-for-user',
      verificationUrl: 'https://microsoft.com/devicelogin',
      userCode: 'ABCD-EFGH',
      message: 'Open Microsoft sign-in and enter the short code.',
      timestamps: {},
    });
    return snapshot;
  })()`);
  reporter.check(
    'active device login remains visible and cancellable while context refreshes',
    loginDuringRefresh.state === 'unavailable' &&
      loginDuringRefresh.code === 'ABCD-EFGH' &&
      loginDuringRefresh.cancel === 'Cancel Azure sign-in',
    JSON.stringify(loginDuringRefresh),
  );

  const failedLogin = await harness.evaluate(`(() => {
    globalThis.__citadelTestHooks.setExecutionContext(globalThis.__acceptanceSignedOutContext);
    globalThis.__citadelTestHooks.setAzureLogin({
      loginId: 'login-acceptance',
      state: 'failed',
      verificationUrl: '',
      userCode: '',
      message: 'Status could not be refreshed.',
      timestamps: {},
    });
    return {
      signIn: Boolean(document.getElementById('start-azure-login')),
      cancel: document.getElementById('cancel-azure-login')?.textContent ?? '',
      message: document.querySelector('.device-login-message')?.textContent ?? '',
    };
  })()`);
  reporter.check(
    'failed in-flight login keeps its cancellation and suppresses unsafe retry',
    failedLogin.signIn === false &&
      failedLogin.cancel === 'Cancel Azure sign-in' &&
      /could not be refreshed/.test(failedLogin.message),
    JSON.stringify(failedLogin),
  );

  const ready = await harness.evaluate(`(() => {
    globalThis.__citadelTestHooks.setAzureLogin({
      loginId: 'login-acceptance',
      state: 'succeeded',
      verificationUrl: '',
      userCode: '',
      message: 'Signed in.',
      timestamps: {},
    });
    const context = {
      kind: 'azure-cli-management',
      label: 'Azure CLI user',
      summary: 'Signed in for this local operator sample.',
      state: 'ready',
      code: 'azure-cli-ready',
      canExecute: true,
      authority: {
        type: 'azure-cli-user',
        principalName: 'Acceptance User',
        principalType: 'user',
        tenantId: 'tenant-acceptance'
      },
      subscription: {
        activeId: 'sub-acceptance',
        activeName: 'Acceptance Sandbox',
        configuredId: 'sub-acceptance',
        matches: true
      },
      gateway: null,
      hostedRelay: null,
      guarantees: { tokensExposed: false, credentialsPersisted: false },
      futureHostedProcess: null,
    };
    globalThis.__acceptanceExecutionContext = context;
    globalThis.__citadelTestHooks.setExecutionContext(context);
    const identity = document.querySelector('[data-execution-identity]');
    return { badge: identity.querySelector('.chip')?.textContent ?? '', text: identity.textContent };
  })()`);
  reporter.check(
    'signed-in context states principal, tenant, subscription, and match',
    ready.badge === 'Ready' &&
      /Acceptance User/.test(ready.text) &&
      /tenant-acceptance/.test(ready.text) &&
      /Acceptance Sandbox/.test(ready.text) &&
      /matches/.test(ready.text),
    JSON.stringify(ready),
  );

  const stale = await harness.evaluate(`(() => {
    const hooks = globalThis.__citadelTestHooks;
    hooks.setAdvertisedExecutionContext(globalThis.__acceptanceExecutionContext);
    hooks.setValue('hub.subscriptionId', 'sub-changed-after-context');
    const snapshot = {
      state: document.querySelector('[data-execution-identity]')?.dataset.executionIdentity ?? '',
      text: document.querySelector('[data-execution-identity]')?.textContent ?? '',
    };
    hooks.setExecutionContext(globalThis.__acceptanceExecutionContext);
    return snapshot;
  })()`);
  reporter.check(
    'changing identity-bound inputs invalidates execution context immediately',
    stale.state === 'unavailable' && /being rechecked/.test(stale.text),
    JSON.stringify(stale),
  );
}

async function checkAzureLoginRestartRecovery(harness) {
  await selectSample(harness, 'azure-context-check');
  const priorPageErrorCount = harness.pageErrors.length;
  let attempt = 0;
  let heldRestartRequestId = null;
  let cancelledLoginId = null;
  const descriptor = {
    state: 'blocked',
    summary: 'An Azure CLI device-code login is already in progress.',
    code: 'login-in-progress',
    login: {
      id: 'azure-login-0042',
      state: 'waiting-for-user',
      verificationUrl: 'https://microsoft.com/devicelogin',
      userCode: 'RETRY-1234',
      message: 'Continue the current sign-in.',
    },
    context: null,
  };
  const removeListener = harness.page.on('Fetch.requestPaused', (event) => {
    if (event.request.url.includes('/api/azure-login/cancel')) {
      cancelledLoginId = JSON.parse(event.request.postData).loginId;
      harness.page
        .send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
          body: Buffer.from(
            JSON.stringify({
              login: {
                ...descriptor.login,
                state: 'cancelled',
                message: 'Azure CLI device-code sign-in was cancelled.',
              },
              context: null,
            }),
          ).toString('base64'),
        })
        .catch(() => {});
      return;
    }
    if (!event.request.url.includes('/api/azure-login/start')) {
      harness.page.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
      return;
    }
    attempt += 1;
    if (attempt === 1) {
      harness.page.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }).catch(() => {});
      return;
    }
    if (attempt > 2) {
      heldRestartRequestId = event.requestId;
      return;
    }
    harness.page
      .send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 409,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: Buffer.from(JSON.stringify(descriptor)).toString('base64'),
      })
      .catch(() => {});
  });
  await harness.page.send('Fetch.enable', {
    patterns: [{ urlPattern: '*api/azure-login/*', requestStage: 'Request' }],
  });
  try {
    const ambiguous = await harness.evaluate(`(async () => {
      const hooks = globalThis.__citadelTestHooks;
      hooks.setExecutionContext(globalThis.__acceptanceSignedOutContext);
      hooks.setAzureLogin({
        loginId: 'obsolete-terminal-login',
        state: 'failed',
        verificationUrl: '',
        userCode: '',
        message: 'The prior sign-in failed.',
      });
      await hooks.startAzureLogin();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return {
        message: document.querySelector('.device-login-message')?.textContent ?? '',
        cancel: Boolean(document.getElementById('cancel-azure-login')),
        retry: Boolean(document.getElementById('start-azure-login')),
        refresh: Boolean(document.getElementById('refresh-execution-context')),
        focused: document.activeElement?.id ?? '',
      };
    })()`);
    reporter.check(
      'an ambiguous sign-in restart never resurrects a terminal login id and remains recoverable',
      ambiguous.cancel === false &&
        ambiguous.retry === true &&
        ambiguous.refresh === true &&
        ambiguous.focused === 'start-azure-login' &&
        /could not be confirmed/i.test(ambiguous.message),
      JSON.stringify(ambiguous),
    );

    const reconciled = await harness.evaluate(`(async () => {
      await globalThis.__citadelTestHooks.startAzureLogin();
      return {
        state: document.querySelector('.device-login')?.dataset.loginState ?? '',
        code: document.getElementById('azure-device-code')?.textContent ?? '',
        cancel: document.getElementById('cancel-azure-login')?.textContent ?? '',
        retry: Boolean(document.getElementById('start-azure-login')),
      };
    })()`);
    reporter.check(
      'a login-in-progress descriptor reconciles the UI to the current cancellable login',
      reconciled.state === 'waiting-for-user' &&
        reconciled.code === 'RETRY-1234' &&
        reconciled.cancel === 'Cancel Azure sign-in' &&
        reconciled.retry === false,
      JSON.stringify(reconciled),
    );

    await harness.evaluate(`(() => {
      const hooks = globalThis.__citadelTestHooks;
      hooks.setExecutionContext(globalThis.__acceptanceSignedOutContext);
      hooks.setAzureLogin({
        loginId: 'another-terminal-login',
        state: 'failed',
        verificationUrl: '',
        userCode: '',
        message: 'The prior sign-in failed.',
      });
      globalThis.__acceptancePendingLoginStart = hooks.startAzureLogin();
      return true;
    })()`);
    const heldDeadline = Date.now() + 2_000;
    while (!heldRestartRequestId && Date.now() < heldDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!heldRestartRequestId) throw new Error('The held Azure login restart request was not observed.');
    await harness.evaluate(`globalThis.__citadelTestHooks.cancelAzureLogin()`);
    await harness.page.send('Fetch.fulfillRequest', {
      requestId: heldRestartRequestId,
      responseCode: 409,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
      body: Buffer.from(JSON.stringify(descriptor)).toString('base64'),
    });
    const cancelled = await harness.evaluate(`(async () => {
      await globalThis.__acceptancePendingLoginStart;
      delete globalThis.__acceptancePendingLoginStart;
      return {
        state: document.querySelector('.device-login')?.dataset.loginState ?? '',
        cancel: Boolean(document.getElementById('cancel-azure-login')),
      };
    })()`);
    reporter.check(
      'cancellation requested before reconciliation cancels the returned current login id',
      heldRestartRequestId !== null &&
        cancelledLoginId === descriptor.login.id &&
        cancelled.state === 'cancelled' &&
        cancelled.cancel === false,
      JSON.stringify({ heldRestartRequestId, cancelledLoginId, ...cancelled }),
    );
  } finally {
    await harness.page.send('Fetch.disable').catch(() => {});
    removeListener?.();
    for (let index = harness.pageErrors.length - 1; index >= priorPageErrorCount; index -= 1) {
      if (/Failed to load resource: the server responded with a status of 409/.test(harness.pageErrors[index])) {
        harness.pageErrors.splice(index, 1);
      }
    }
  }
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
    const response = await serverJson(harness, `/api/source/${sampleId}/validate`, {
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
    document.getElementById('tab-code')?.click();
    const button = document.getElementById('validate-source-button');
    if (!button) return { button: false, executionModes: [], validationModes: [] };
    button.click();
    const deadline = Date.now() + 10000;
    while (!document.querySelector('[data-validation-artifact-download]') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      button: true,
      executionModes: [...document.querySelectorAll('[data-execution-mode]')].map((node) => ({
        mode: node.dataset.executionMode,
        text: node.textContent.trim(),
      })),
      validationModes: [...document.querySelectorAll('[data-validation-mode]')].map((node) => node.dataset.validationMode),
      artifactDownload: document.querySelector('[data-validation-artifact-download]')?.textContent.trim() ?? '',
      text: document.getElementById('panel-code')?.textContent ?? '',
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
  reporter.check(
    'offline validation exposes its inline report as a download',
    /^Download .+/.test(validationUi.artifactDownload),
    validationUi.artifactDownload,
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
    hooks.setValue('samples.cleanup.confirmNonProduction', false);
    document.getElementById('tab-code').click();
    const guardRow = () => document.querySelector('[data-parameter-path="samples.cleanup.confirmNonProduction"]');
    const unconfirmed = {
      ready: [...guardRow().querySelectorAll('.prow-badges .chip')].some((chip) => chip.textContent === 'Ready'),
      required: guardRow().querySelector('input')?.getAttribute('aria-required'),
      error: guardRow().querySelector('.field-error')?.textContent ?? '',
    };
    hooks.setValue('samples.cleanup.confirmNonProduction', true);
    const confirmed = {
      ready: [...guardRow().querySelectorAll('.prow-badges .chip')].some((chip) => chip.textContent === 'Ready'),
      error: guardRow().querySelector('.field-error')?.textContent ?? '',
    };
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
    document.getElementById('tab-code').click();
    const input = document.getElementById('f-hub-resourceGroupName');
    input.value = 'rg-acceptance-changed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
      unconfirmed,
      confirmed,
      approved,
      invalidated,
      afterRun: {
        disabled: document.getElementById('run-button')?.disabled,
        checked: document.getElementById('ack-check')?.checked,
      },
    };
  })()`);

  reporter.check('risky execution is blocked before approval', gate.before.disabled === true && /acknowledge/i.test(gate.before.reason));
  reporter.check(
    'mustEqual guard readiness stays blocked until the required value is true',
    gate.unconfirmed.ready === false &&
      gate.unconfirmed.required === 'true' &&
      gate.unconfirmed.error.length > 0 &&
      gate.confirmed.ready === true &&
      gate.confirmed.error === '',
    JSON.stringify({ unconfirmed: gate.unconfirmed, confirmed: gate.confirmed }),
  );
  reporter.check('one explicit approval enables the reviewed run', gate.approved.disabled === false && gate.approved.checked === true);
  reporter.check('editing a parameter directly on Code invalidates approval', gate.invalidated.disabled === true && gate.invalidated.checked === false);
  reporter.check('approval is spent by one run', gate.afterRun.disabled === true && gate.afterRun.checked === false);
}

async function checkRunIdIsolation(harness) {
  await selectSample(harness, 'azure-context-check');
  const output = await harness.evaluate(`(() => {
    document.getElementById('tab-response')?.click();
    const panel = document.getElementById('panel-response');
    return {
      state: panel?.querySelector('.result')?.dataset.state ?? '',
      text: panel?.textContent ?? '',
    };
  })()`);
  reporter.check(
    'an unexecuted sample never displays another sample run id',
    output.state === 'not-run' && !output.text.includes('approval-0001'),
    JSON.stringify(output),
  );
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
    result.executionModes.some((entry) => entry.mode === 'local-machine' && /local/i.test(entry.text)),
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
    modes.some((entry) => entry.mode === 'hosted-relay' && /live/i.test(entry.text)),
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
  await harness.evaluate(`document.getElementById('tab-code')?.click()`);
  await harness.waitFor('Boolean(document.querySelector("[data-parameter-pane] input"))', { label: 'Code parameter controls' });
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
    actual.push(
      await harness.evaluate(`(() => {
        const active = document.activeElement;
        if (!active) return '';
        return active.id ? 'id:' + active.id : 'index:' + (active.dataset.acceptanceFocus ?? '');
      })()`),
    );
  }
  reporter.check(
    'Tab follows visible DOM order without traps or skipped controls',
    JSON.stringify(actual) ===
      JSON.stringify(expected.map((entry) => (entry.id ? `id:${entry.id}` : `index:${entry.index}`))),
    JSON.stringify({
      expected: expected.map((entry) => `${entry.index}:${entry.id || entry.text}`),
      actual,
    }),
  );
  const tabStops = await harness.evaluate(
    `[...document.querySelectorAll('[role="tab"]')].filter((node) => node.tabIndex === 0).length`,
  );
  reporter.equal('the tablist contributes exactly one stop to page Tab order', tabStops, 1);

  const focus = await harness.evaluate(`(() => {
    const input = document.querySelector('[data-parameter-pane] input:not([type="checkbox"])');
    input?.focus();
    const style = input ? getComputedStyle(input) : null;
    const strip = document.querySelector('.sheet-sticky')?.getBoundingClientRect();
    const rect = input?.getBoundingClientRect();
    return {
      visible: Boolean(style && style.boxShadow !== 'none'),
      belowStickyHeader: Boolean(rect && strip && rect.top >= strip.bottom - 1),
      inViewport: Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight),
    };
  })()`);
  reporter.check('keyboard focus is visibly styled on parameter controls', focus.visible === true, JSON.stringify(focus));
  reporter.check(
    'the sticky Code regions do not cover a focused parameter',
    focus.belowStickyHeader === true && focus.inViewport === true,
    JSON.stringify(focus),
  );

  const reverse = await harness.evaluate(`(async () => {
    const input = document.getElementById('f-hub-subscriptionId');
    input.focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return input.id;
  })()`);
  await harness.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', modifiers: 8 });
  await harness.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', modifiers: 8 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const reverseTarget = await harness.evaluate(`document.activeElement?.id ?? ''`);
  reporter.check(
    'Shift+Tab keeps focus on the preceding Code-pane control after validation renders',
    reverse === 'f-hub-subscriptionId' && reverseTarget === 'refresh-execution-context',
    reverseTarget,
  );
}

async function checkResponsiveLayout(harness) {
  await selectSample(harness, 'tool-rate-limit-burst');
  await harness.evaluate(`document.getElementById('tab-code')?.click()`);

  await harness.setViewport({ width: 1440, height: 900, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const desktop = await harness.evaluate(`(() => {
    const sheet = document.querySelector('.sheet');
    const workspace = document.querySelector('.code-workspace');
    const source = document.querySelector('.code-source');
    const pane = document.querySelector('[data-parameter-pane]');
    sheet.scrollTop = 420;
    const strip = document.querySelector('.sheet-sticky').getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    pane.scrollTop = pane.scrollHeight;
    const reviewRect = document.getElementById('parameter-review-button').getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      columns: getComputedStyle(workspace).gridTemplateColumns.split(' ').length,
      position: getComputedStyle(pane).position,
      sourceBeforePane: sourceRect.left < paneRect.left,
      paneContained: paneRect.right <= workspaceRect.right + 1,
      stickyBelowHeader: paneRect.top >= strip.bottom - 1,
      finalActionVisible: reviewRect.top >= paneRect.top && reviewRect.bottom <= Math.min(paneRect.bottom, window.innerHeight) + 1,
    };
  })()`);
  reporter.check(
    'desktop keeps protected source and Parameters in 2 related columns',
    desktop.columns === 2 && desktop.sourceBeforePane === true && desktop.paneContained === true,
    JSON.stringify(desktop),
  );
  reporter.check(
    'desktop Parameters stays sticky below the recipe header',
    desktop.position === 'sticky' && desktop.stickyBelowHeader === true && desktop.finalActionVisible === true,
    JSON.stringify(desktop),
  );
  reporter.check('desktop has no page-level horizontal overflow', desktop.documentWidth <= desktop.viewport);

  await harness.setViewport({ width: 820, height: 800, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const tablet = await harness.evaluate(`(() => {
    const source = document.querySelector('.code-source').getBoundingClientRect();
    const pane = document.querySelector('[data-parameter-pane]');
    const paneRect = pane.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      position: getComputedStyle(pane).position,
      paneAfterSource: paneRect.top >= source.top,
      paneWidth: paneRect.width,
    };
  })()`);
  reporter.check(
    'tablet stacks the canonical Parameters pane coherently',
    tablet.position === 'static' && tablet.paneAfterSource === true && tablet.paneWidth <= tablet.viewport,
    JSON.stringify(tablet),
  );
  reporter.check('tablet has no page-level horizontal overflow', tablet.documentWidth <= tablet.viewport);

  await selectSample(harness, 'azure-context-check');
  const tabletCellJump = await harness.evaluate(`(async () => {
    document.getElementById('tab-code').click();
    document.querySelector('.source-nav a[href="#source-cell-4"]').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sheet = document.querySelector('.sheet').getBoundingClientRect();
    const sticky = document.querySelector('.sheet-sticky');
    const heading = document.querySelector('#source-cell-4 > summary').getBoundingClientRect();
    return {
      stickyPosition: getComputedStyle(sticky).position,
      headingTop: heading.top,
      headingBottom: heading.bottom,
      sheetTop: sheet.top,
      viewportBottom: window.innerHeight,
    };
  })()`);
  reporter.check(
    'tablet source cell navigation leaves the target heading fully visible',
    tabletCellJump.stickyPosition === 'static' &&
      tabletCellJump.headingTop >= tabletCellJump.sheetTop - 1 &&
      tabletCellJump.headingBottom <= tabletCellJump.viewportBottom + 1,
    JSON.stringify(tabletCellJump),
  );

  await harness.setViewport({ width: 375, height: 667, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await selectSample(harness, 'azure-context-check');
  const phoneCellJump = await harness.evaluate(`(async () => {
    document.querySelector('.source-nav a[href="#source-cell-4"]').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sheet = document.querySelector('.sheet').getBoundingClientRect();
    const heading = document.querySelector('#source-cell-4 > summary').getBoundingClientRect();
    return {
      focused: document.activeElement === document.querySelector('#source-cell-4 > summary'),
      headingTop: heading.top,
      headingBottom: heading.bottom,
      sheetTop: sheet.top,
      viewportBottom: window.innerHeight,
    };
  })()`);
  reporter.check(
    '375px source jump focuses a fully visible target heading',
    phoneCellJump.focused === true &&
      phoneCellJump.headingTop >= phoneCellJump.sheetTop - 1 &&
      phoneCellJump.headingBottom <= phoneCellJump.viewportBottom + 1,
    JSON.stringify(phoneCellJump),
  );

  await harness.setViewport({ width: 320, height: 640, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const narrow = await harness.evaluate(`(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    sourceOverflowsViewport: [...document.querySelectorAll(${JSON.stringify(SOURCE_SELECTOR)})]
      .some((node) => node.getBoundingClientRect().right > window.innerWidth + 1),
    compactRecipeVisible: getComputedStyle(document.querySelector('.strip-compact')).display !== 'none',
    parameterDisclosure: document.querySelector('[data-parameter-pane]')?.tagName === 'DETAILS',
    parameterPosition: getComputedStyle(document.querySelector('[data-parameter-pane]')).position,
    sourceFirst: document.querySelector('.code-source').compareDocumentPosition(document.querySelector('[data-parameter-pane]')) & Node.DOCUMENT_POSITION_FOLLOWING,
    jumpTarget: document.querySelector('.parameter-jump')?.getAttribute('href') ?? '',
  }))()`);
  reporter.check('320px layout has no page-level horizontal overflow', narrow.documentWidth <= narrow.viewport, `${narrow.documentWidth} > ${narrow.viewport}`);
  reporter.check('320px layout keeps protected source inside the viewport', narrow.sourceOverflowsViewport === false);
  reporter.check('320px layout exposes the compact recipe control', narrow.compactRecipeVisible === true);
  reporter.check(
    '320px keeps source first and Parameters immediately reachable as a disclosure',
    Boolean(narrow.sourceFirst) &&
      narrow.parameterDisclosure === true &&
      narrow.parameterPosition === 'static' &&
      narrow.jumpTarget === '#code-parameters',
    JSON.stringify(narrow),
  );

  for (const viewport of [
    { width: 375, height: 667 },
    { width: 320, height: 480 },
  ]) {
    await harness.setViewport({ ...viewport, mobile: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await selectSample(harness, 'azure-context-check');
    const jump = await harness.evaluate(`(async () => {
      document.getElementById('tab-code').click();
      document.querySelector('.source-nav a[href="#source-cell-4"]').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.querySelector('.parameter-jump').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const sheet = document.querySelector('.sheet').getBoundingClientRect();
      const sticky = document.querySelector('.sheet-sticky');
      const stickyRect = sticky.getBoundingClientRect();
      const summary = document.getElementById('parameter-pane-summary').getBoundingClientRect();
      const stickyCoversTop =
        getComputedStyle(sticky).position === 'sticky' &&
        stickyRect.bottom > sheet.top &&
        stickyRect.top <= sheet.top + 1;
      const visibleTop = stickyCoversTop ? Math.min(stickyRect.bottom, sheet.bottom) : sheet.top;
      const visibleBottom = Math.min(sheet.bottom, window.innerHeight);
      return {
        focused: document.activeElement?.id ?? '',
        summaryTop: summary.top,
        summaryBottom: summary.bottom,
        visibleTop,
        visibleBottom,
      };
    })()`);
    reporter.check(
      `${viewport.width}x${viewport.height} source then parameter jump keeps the actual target in the visible sheet viewport`,
      jump.focused === 'parameter-pane-summary' &&
        jump.summaryTop >= jump.visibleTop - 1 &&
        jump.summaryBottom <= jump.visibleBottom + 1,
      JSON.stringify(jump),
    );
  }

  await harness.setViewport({ width: 320, height: 480, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const compactSelfTest = await harness.evaluate(`(async () => {
    const details = document.getElementById('self-test');
    details.open = true;
    document.getElementById('self-test-run').click();
    const deadline = Date.now() + 5000;
    while (['Not run', 'Running…'].includes(document.getElementById('self-test-status').textContent)) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const body = details.querySelector('.mh-selftest-body');
    body.scrollTop = body.scrollHeight;
    const last = body.querySelector('.mh-selftest-check:last-child')?.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const workbench = document.getElementById('workbench').getBoundingClientRect();
    const selector = document.getElementById('sample-select');
    selector.focus();
    selector.scrollIntoView({ block: 'nearest' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const focused = selector.getBoundingClientRect();
    return {
      status: document.getElementById('self-test-status').textContent,
      bodyScrollable: body.scrollHeight > body.clientHeight && body.scrollTop > 0,
      finalContentVisible: Boolean(last && last.bottom <= bodyRect.bottom + 1),
      workbenchHeight: workbench.height,
      focusedControlVisible:
        document.activeElement === selector &&
        focused.top >= workbench.top - 1 &&
        focused.bottom <= Math.min(workbench.bottom, window.innerHeight) + 1,
    };
  })()`);
  reporter.check(
    '320x480 self-test scrolls independently without removing the workbench',
    /Passed/.test(compactSelfTest.status) &&
      compactSelfTest.bodyScrollable === true &&
      compactSelfTest.finalContentVisible === true &&
      compactSelfTest.workbenchHeight > 0 &&
      compactSelfTest.focusedControlVisible === true,
    JSON.stringify(compactSelfTest),
  );

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
    createServer: ({ port, testBootstrapCapability }) =>
      createPlaygroundServer({ port, mode: 'execute', testBootstrapCapability }),
  });
  try {
    await harness.waitFor('document.querySelectorAll(".dir-item").length === 19', {
      label: 'the 19-recipe directory',
    });
    await harness.waitFor('Boolean(globalThis.__citadelTestHooks)', { label: 'the loopback-only test executor seam' });
    const sessionCapability = await browserJson(harness, '/api/capabilities');
    reporter.equal('the browser claims the per-launch local session', sessionCapability.body?.sessionAuth?.state, 'claimed');
    reporter.equal('the bootstrap fragment is removed immediately after boot', await harness.evaluate('location.hash'), '');
    const browserCookies = await harness.page.send('Network.getCookies', { urls: [harness.baseUrl] });
    const localSessionCookie = browserCookies.cookies.find((cookie) => cookie.name === 'citadel_playground_session');
    reporter.check('the local session cookie is present and HttpOnly', localSessionCookie?.httpOnly === true);

    const sourceBySample = await checkSourceContracts(harness, notebook, notebookMeta);
    await checkCodeParameterWorkspace(harness);
    await checkExecutionIdentity(harness);
    await checkAzureLoginRestartRecovery(harness);
    await checkOfflineValidation(harness, sourceBySample);
    await checkValidationAbortReset(harness);
    await checkApprovalGate(harness);
    await checkRunIdIsolation(harness);
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
