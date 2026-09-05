#!/usr/bin/env node
/**
 * Browser acceptance for the per-recipe Citadel run wizard.
 *
 * The runner uses loopback servers, including one configured with the real
 * relay capability path. Every browser-originated non-loopback request is blocked.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPlaygroundServer } from '../server.mjs';
import { createExecutionContextManager } from '../src/server/executionContextManager.mjs';
import { createCheckReporter, launchBrowserHarness } from './browser-harness.mjs';

const ARTIFACT_DIRECTORY = resolve(argumentValue('--artifacts') ?? fileURLToPath(new URL('../.artifacts/dossier/', import.meta.url)));
const PLAYGROUND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'DOSSIER-ACCEPTANCE-SECRET';
const ACTIVE_SUBSCRIPTION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ALTERNATE_SUBSCRIPTION_ID = '00000000-1111-2222-3333-444444444444';

export const DOSSIER_ACCEPTANCE_SCENARIOS = Object.freeze([
  Object.freeze({
    order: 1,
    name: 'azure-account-desktop',
    recipeId: 'apim-discovery',
    width: 1440,
    height: 900,
    mobile: false,
    breakpoint: 'desktop',
  }),
  Object.freeze({
    order: 2,
    name: 'gateway-connection-desktop',
    recipeId: 'weather-mcp-discovery',
    width: 1440,
    height: 900,
    mobile: false,
    breakpoint: 'desktop',
    openHelpPath: 'hub.gatewayUrl',
  }),
  Object.freeze({
    order: 3,
    name: 'gateway-help-mobile',
    recipeId: 'weather-mcp-discovery',
    width: 390,
    height: 844,
    mobile: true,
    breakpoint: 'phone',
    openHelpPath: 'hub.gatewayUrl',
  }),
  Object.freeze({
    order: 4,
    name: 'publish-assets-desktop',
    recipeId: 'publish-assets',
    width: 1252,
    height: 876,
    mobile: false,
    breakpoint: 'desktop',
    requiresWorkspaceScroll: true,
    reachabilityPath: 'hub.location',
    keyboardScroll: true,
  }),
  Object.freeze({
    order: 5,
    name: 'publish-assets-tablet',
    recipeId: 'publish-assets',
    width: 768,
    height: 800,
    mobile: false,
    breakpoint: 'tablet',
    requiresWorkspaceScroll: true,
    reachabilityPath: 'hub.location',
    keyboardScroll: true,
  }),
  Object.freeze({
    order: 6,
    name: 'publish-assets-phone',
    recipeId: 'publish-assets',
    width: 390,
    height: 844,
    mobile: true,
    breakpoint: 'phone',
    requiresWorkspaceScroll: true,
    reachabilityPath: 'hub.location',
    keyboardScroll: true,
  }),
  Object.freeze({
    order: 7,
    name: 'publish-assets-phone-small',
    recipeId: 'publish-assets',
    width: 320,
    height: 480,
    mobile: true,
    breakpoint: 'phone',
    requiresWorkspaceScroll: true,
    reachabilityPath: 'hub.location',
    keyboardScroll: true,
  }),
  Object.freeze({
    order: 8,
    name: 'publish-assets-zoom-200-percent',
    recipeId: 'publish-assets',
    width: 640,
    height: 450,
    screenshotWidth: 1280,
    screenshotHeight: 900,
    mobile: false,
    breakpoint: 'zoom',
    deviceScaleFactor: 2,
    requiresWorkspaceScroll: true,
    reachabilityPath: 'hub.location',
    keyboardScroll: true,
  }),
  Object.freeze({
    order: 9,
    name: 'publish-assets-source-desktop',
    recipeId: 'publish-assets',
    width: 1440,
    height: 900,
    mobile: false,
    breakpoint: 'desktop',
    openSource: true,
  }),
  Object.freeze({
    order: 10,
    name: 'publish-assets-source-mobile',
    recipeId: 'publish-assets',
    width: 390,
    height: 844,
    mobile: true,
    breakpoint: 'phone',
    openSource: true,
  }),
  Object.freeze({
    order: 11,
    name: 'cleanup-review-desktop',
    recipeId: 'cleanup',
    width: 1440,
    height: 900,
    mobile: false,
    breakpoint: 'desktop',
    review: true,
  }),
  Object.freeze({
    order: 12,
    name: 'cleanup-review-mobile',
    recipeId: 'cleanup',
    width: 390,
    height: 844,
    mobile: true,
    breakpoint: 'phone',
    review: true,
  }),
  Object.freeze({
    order: 13,
    name: 'cleanup-confirmation-desktop',
    recipeId: 'cleanup',
    width: 1440,
    height: 900,
    mobile: false,
    breakpoint: 'desktop',
    review: true,
    openDestructiveConfirmation: true,
    visualOnly: true,
  }),
  Object.freeze({
    order: 14,
    name: 'cleanup-confirmation-mobile',
    recipeId: 'cleanup',
    width: 390,
    height: 844,
    mobile: true,
    breakpoint: 'phone',
    review: true,
    openDestructiveConfirmation: true,
    visualOnly: true,
  }),
  Object.freeze({
    order: 15,
    name: 'recipe-picker-mobile',
    recipeId: 'publish-assets',
    width: 390,
    height: 844,
    mobile: true,
    breakpoint: 'phone',
    openDirectory: true,
    visualOnly: true,
  }),
  Object.freeze({
    order: 16,
    name: 'offline-diagnostics',
    recipeId: 'azure-context-check',
    width: 820,
    height: 800,
    mobile: false,
    breakpoint: 'tablet',
    openDiagnostics: true,
  }),
  Object.freeze({
    order: 17,
    name: 'reduced-motion',
    recipeId: 'publish-assets',
    width: 820,
    height: 800,
    mobile: false,
    breakpoint: 'tablet',
    reducedMotion: true,
  }),
  Object.freeze({
    order: 18,
    name: 'forced-colors',
    recipeId: 'publish-assets',
    width: 820,
    height: 800,
    mobile: false,
    breakpoint: 'tablet',
    forcedColors: true,
  }),
]);

export function dossierScreenshotName(scenario) {
  if (!scenario || !Number.isInteger(scenario.order) || !scenario.name) {
    throw new TypeError('A numbered dossier acceptance scenario is required.');
  }
  const prefix = String(scenario.order).padStart(2, '0');
  return `${prefix}-${scenario.name}-${scenario.screenshotWidth ?? scenario.width}x${scenario.screenshotHeight ?? scenario.height}.png`;
}

export function dossierBreakpoint(width) {
  if (!Number.isFinite(width) || width <= 0) throw new TypeError('A positive viewport width is required.');
  if (width >= 1200) return 'desktop';
  if (width >= 768) return 'tablet';
  return 'phone';
}

export function wizardStepIssues(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return ['wizard snapshot is required'];
  const issues = [];
  if (snapshot.wizardCount !== 1) issues.push(`expected one recipe wizard, got ${snapshot.wizardCount}`);
  if (snapshot.currentStepCount !== 1) issues.push(`expected one current wizard step, got ${snapshot.currentStepCount}`);
  if (snapshot.stepCount < 2 || snapshot.stepCount > 5) {
    issues.push(`expected 2-5 dynamically derived steps, got ${snapshot.stepCount}`);
  }
  if (!/^Step \d+ of \d+$/.test(snapshot.stepProgress)) {
    issues.push(`invalid step progress text: ${snapshot.stepProgress}`);
  }
  if (snapshot.topLevelTabs !== 0) issues.push('top-level workflow tabs are present');
  return issues;
}

export function fieldContractIssues(fields) {
  if (!Array.isArray(fields)) return ['field snapshot must be an array'];
  const issues = [];
  for (const field of fields) {
    const label = field.id || field.name || field.tag || 'field';
    if (!field.labelled) issues.push(`${label} has no programmatic label`);
    if (!field.name) issues.push(`${label} has no name`);
    if (!field.autocomplete) issues.push(`${label} has no autocomplete policy`);
  }
  return issues;
}

export function nonLoopbackRequestIssues(urls, baseUrl) {
  const allowedOrigin = new URL(baseUrl).origin;
  return (urls ?? []).flatMap((value) => {
    try {
      const url = new URL(value);
      if (['data:', 'blob:', 'about:'].includes(url.protocol)) return [];
      return url.origin === allowedOrigin ? [] : [`external request attempted: ${url.href}`];
    } catch {
      return [`invalid request URL observed: ${String(value)}`];
    }
  });
}

export function viewportContractIssues(snapshot, scenario) {
  if (!snapshot || typeof snapshot !== 'object') return ['viewport snapshot is required'];
  const issues = [];
  if (snapshot.documentWidth > snapshot.viewportWidth + 1) {
    issues.push(`document width ${snapshot.documentWidth} exceeds viewport ${snapshot.viewportWidth}`);
  }
  if (snapshot.shellWidth > snapshot.viewportWidth + 1) {
    issues.push(`wizard shell width ${snapshot.shellWidth} exceeds viewport ${snapshot.viewportWidth}`);
  }
  if (snapshot.mastheadScrollWidth > snapshot.mastheadClientWidth + 1) {
    issues.push('masthead commands overflow their visible row');
  }
  if (snapshot.clippedMastheadControls > 0) {
    issues.push(
      `${snapshot.clippedMastheadControls} masthead controls are clipped: ${snapshot.clippedMastheadControlLabels.join(', ')}`,
    );
  }
  if (snapshot.nestedFormScrollers > 0) issues.push('the form contains a nested vertical scroller');
  if (snapshot.visibleStepContents !== 1) issues.push(`expected one visible step surface, got ${snapshot.visibleStepContents}`);
  if (snapshot.actionBarPosition !== 'static' || !snapshot.actionInWorkspace) {
    issues.push('the task action must remain in the workspace reading flow');
  }
  if (!snapshot.stepNavVisible || snapshot.stepSelectorVisible) issues.push('use one inline step navigation at every width');
  if (snapshot.contextDisclosureOpen || !snapshot.contextSummaryVisible) {
    issues.push('execution details must remain available through a collapsed disclosure');
  }
  if (snapshot.primaryActionCount !== 1) issues.push(`expected one primary page action, got ${snapshot.primaryActionCount}`);
  if (!/(auto|scroll)/.test(snapshot.mainOverflowY)) {
    issues.push(`wizard workspace overflow-y is ${snapshot.mainOverflowY || 'unset'}, not auto`);
  }
  if (snapshot.bodyOverflowY !== 'hidden') {
    issues.push(`body overflow-y is ${snapshot.bodyOverflowY || 'unset'}, not hidden`);
  }
  if (snapshot.documentScrollHeight > snapshot.documentClientHeight + 1) {
    issues.push('the document scrolls in addition to the wizard workspace');
  }
  if (snapshot.mainHorizontalOverflow) issues.push('wizard workspace has horizontal overflow');
  if (
    scenario.requiresWorkspaceScroll
    && snapshot.mainScrollHeight <= snapshot.mainClientHeight + 1
  ) {
    issues.push('the long recipe does not expose a real workspace scroll range');
  }

  if (scenario.breakpoint === 'desktop') {
    if (!snapshot.directoryVisible || snapshot.drawerControlVisible) {
      issues.push('desktop must expose the recipe rail without a duplicate drawer control');
    }
    if (!/(auto|scroll)/.test(snapshot.directoryOverflowY)) {
      issues.push('desktop recipe navigation is not independently scrollable');
    }
    if (snapshot.minimumControlHeight < 39.5) {
      issues.push(`desktop controls are only ${snapshot.minimumControlHeight}px high`);
    }
  } else {
    if (snapshot.directoryVisible || !snapshot.drawerControlVisible) {
      issues.push('compact layouts must replace the recipe rail with one picker control');
    }
    if (!snapshot.drawerControlText.startsWith('Browse Recipes')) {
      issues.push('compact recipe navigation does not clearly say Browse Recipes');
    }
    if (['phone', 'zoom'].includes(scenario.breakpoint) && snapshot.viewportHeight >= 480) {
      if (snapshot.drawerControlWidth < snapshot.workspaceContentWidth - 2) {
        issues.push('narrow recipe navigation does not own the full workspace row');
      }
    }
    if (!snapshot.safeAreaRule) issues.push('compact action bar has no safe-area inset rule');
    if (['phone', 'zoom'].includes(scenario.breakpoint) && snapshot.minimumControlHeight < 43.5) {
      issues.push(`mobile controls are only ${snapshot.minimumControlHeight}px high`);
    }
    if (snapshot.contextHorizontalOverflow) {
      issues.push('compact execution context requires horizontal scrolling');
    }
  }
  return issues;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function reportIssues(reporter, label, issues) {
  reporter.check(label, issues.length === 0, issues.join('; '));
}

async function settle(harness) {
  await harness.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function prepareArtifacts() {
  await rm(ARTIFACT_DIRECTORY, { recursive: true, force: true });
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
}

async function captureScreenshot(harness, scenario) {
  const { data } = await harness.page.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(
    resolve(ARTIFACT_DIRECTORY, dossierScreenshotName(scenario)),
    Buffer.from(data, 'base64'),
  );
}

async function installRequestGuard(harness) {
  const requests = [];
  const blocked = [];
  const allowedOrigin = new URL(harness.baseUrl).origin;
  const removeListener = harness.page.on('Fetch.requestPaused', ({ requestId, request }) => {
    requests.push(request.url);
    let allowed = false;
    try {
      const url = new URL(request.url);
      allowed = ['data:', 'blob:', 'about:'].includes(url.protocol) || url.origin === allowedOrigin;
    } catch {
      allowed = false;
    }
    if (allowed) void harness.page.send('Fetch.continueRequest', { requestId });
    else {
      blocked.push(request.url);
      void harness.page.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  });
  await harness.page.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  });
  return {
    requests,
    blocked,
    async close() {
      removeListener?.();
      await harness.page.send('Fetch.disable').catch(() => {});
    },
  };
}

async function waitForWizard(harness, recipeId) {
  await harness.waitFor(
    `document.querySelector('[data-wizard-step]') && document.querySelector('.dossier-current-id')?.textContent === ${JSON.stringify(recipeId)}`,
    { timeoutMs: 30_000, label: `${recipeId} wizard` },
  );
  await harness.waitFor('Boolean(globalThis.__citadelTestHooks)', {
    label: 'the loopback-only wizard test seam',
  });
}

async function installTestExecutor(harness) {
  await harness.evaluate(`(() => {
    globalThis.__citadelTestHooks.installExecutor({
      describeCapability: () => ({
        id: 'wizard-acceptance',
        kind: 'local',
        canExecute: true,
        supportedStepTypes: [],
        reason: 'loopback-only browser acceptance'
      }),
      supports: () => ({ supported: true, unsupportedStepTypes: [] }),
      cancel: async () => ({ cancelled: true }),
      execute: async (_plan, context = {}) => {
        const snapshot = globalThis.__citadelTestHooks.snapshot();
        const runId = 'wizard-acceptance-0001';
        context.onProgress?.({
          type: 'run-start',
          runId,
          sampleId: snapshot?.sample?.id,
          workspace: '.'
        });
        return {
          state: 'completed',
          sampleId: snapshot?.sample?.id,
          summary: 'Loopback wizard acceptance completed.',
          detail: '',
          steps: [],
          assertions: [],
          configurationUpdates: {},
          secretUpdates: {},
          meta: {
            executor: 'local',
            executionMode: 'local',
            runId,
            artifacts: [],
            azureContacted: false,
            liveEvidence: false
          }
        };
      }
    });
    return true;
  })()`);
  await settle(harness);
}

async function navigateToRecipe(harness, recipeId, stepId = 'account-target', { previewOnly = false } = {}) {
  await harness.evaluate("globalThis.__dossierNavigationMarker = 'pending'");
  const url = new URL(harness.baseUrl);
  url.searchParams.set('testExecutor', '');
  url.searchParams.set('recipe', recipeId);
  url.hash = `step=${stepId}`;
  const removeDialog = harness.page.on('Page.javascriptDialogOpening', ({ type }) => {
    if (type === 'beforeunload') void harness.page.send('Page.handleJavaScriptDialog', { accept: true });
  });
  try {
    await harness.page.send('Page.navigate', { url: url.href });
  } finally {
    removeDialog();
  }
  await harness.waitFor(
    "globalThis.__dossierNavigationMarker !== 'pending'",
    { timeoutMs: 30_000, label: `${recipeId} document navigation` },
  );
  await waitForWizard(harness, recipeId);
  if (!previewOnly) await installTestExecutor(harness);
}

async function malformedWizardUrlSnapshot(harness) {
  await harness.evaluate("globalThis.__dossierNavigationMarker = 'pending'");
  const url = new URL(harness.baseUrl);
  url.searchParams.set('testExecutor', '');
  url.searchParams.set('recipe', 'publish-assets');
  await harness.page.send('Page.navigate', { url: `${url.href}#step=%` });
  await harness.waitFor(
    "globalThis.__dossierNavigationMarker !== 'pending'",
    { timeoutMs: 30_000, label: 'malformed wizard URL navigation' },
  );
  await waitForWizard(harness, 'publish-assets');
  return harness.evaluate(`(() => ({
    step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep ?? '',
    hash: location.hash,
  }))()`);
}

async function setValues(harness, values) {
  await harness.evaluate(`(() => {
    const values = ${JSON.stringify(values)};
    for (const [path, value] of Object.entries(values)) {
      globalThis.__citadelTestHooks.setValue(path, value);
    }
    return true;
  })()`);
  await settle(harness);
}

async function clickContinue(harness) {
  const before = await harness.evaluate("document.querySelector('[data-wizard-step]')?.dataset.wizardStep");
  await workspacePointer(harness, '#wizard-action-bar .btn-primary');
  await harness.waitFor(
    `document.querySelector('[data-wizard-step]')?.dataset.wizardStep !== ${JSON.stringify(before)}`,
    { label: `wizard to advance from ${before}` },
  );
  await settle(harness);
  return true;
}

async function advanceToReview(harness) {
  for (let index = 0; index < 5; index += 1) {
    const step = await harness.evaluate("document.querySelector('[data-wizard-step]')?.dataset.wizardStep");
    if (step === 'review-approve') return true;
    if (!(await clickContinue(harness))) return false;
  }
  return false;
}

async function advanceToReadOnlyRun(harness) {
  for (let index = 0; index < 5; index += 1) {
    const action = await harness.evaluate(`(() => {
      const button = document.querySelector('#wizard-action-bar .btn-primary');
      return {
        label: button?.textContent.trim() ?? '',
        enabled: Boolean(button && !button.disabled),
      };
    })()`);
    if (action.label === 'Run Check') return action.enabled;
    if (!(await clickContinue(harness))) return false;
  }
  return false;
}

async function openFieldHelp(harness, path) {
  return harness.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-parameter-path]')]
      .find((candidate) => candidate.dataset.parameterPath === ${JSON.stringify(path)});
    const help = row?.querySelector('.configure-field-help');
    if (!help) return false;
    help.open = true;
    help.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  })()`);
}

async function openSource(harness) {
  const guideOpened = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim() === 'Guide');
    button?.click();
    return Boolean(button);
  })()`);
  if (!guideOpened) return false;
  await harness.waitFor("document.getElementById('provenance-drawer')?.open === true", {
    label: 'guide drawer',
  });
  const sourceOpened = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('#provenance-drawer button')]
      .find((candidate) => candidate.textContent.trim() === 'Inspect cited source');
    button?.click();
    return Boolean(button);
  })()`);
  if (!sourceOpened) return false;
  await harness.waitFor("document.getElementById('source-inspector')?.open === true", {
    label: 'protected source inspector',
  });
  await settle(harness);
  return true;
}

async function openDiagnostics(harness) {
  const opened = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim() === 'Checks');
    button?.click();
    return Boolean(button);
  })()`);
  if (!opened) return false;
  await harness.waitFor("document.getElementById('diagnostics-drawer')?.open === true", {
    label: 'diagnostics drawer',
  });
  await settle(harness);
  return harness.evaluate(`(() => {
    const text = document.getElementById('diagnostics-drawer')?.textContent ?? '';
    return !/Fail\\s*[—-]\\s*undefined/i.test(text);
  })()`);
}

async function prepareCleanupReview(harness) {
  await setValues(harness, {
    'hub.subscriptionId': '00000000-1111-2222-3333-444444444444',
    'hub.resourceGroupName': 'rg-wizard-acceptance',
    'hub.apimName': 'apim-wizard-acceptance',
    'samples.cleanup.confirmNonProduction': true,
    'samples.cleanup.deleteWeatherSourceApi': true,
  });
  return advanceToReview(harness);
}

async function preparePublishReview(harness) {
  await setValues(harness, {
    'hub.subscriptionId': '00000000-1111-2222-3333-444444444444',
    'hub.resourceGroupName': 'rg-wizard-acceptance',
    'hub.apimName': 'apim-wizard-acceptance',
    'hub.location': 'westeurope',
    'foundry.accountName': 'foundry-wizard-acceptance',
    'foundry.projectName': 'project-wizard-acceptance',
    'foundry.agentName': 'agent-wizard-acceptance',
  });
  return advanceToReview(harness);
}

async function wizardSnapshot(harness) {
  return harness.evaluate(`(() => {
    const visible = (element) => Boolean(
      element &&
      !(element.tagName !== 'SUMMARY' && element.closest('details:not([open])')) &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden'
    );
    const fields = [...document.querySelectorAll(
      '.wizard-step-content input:not([type="hidden"]), .wizard-step-content select, .wizard-step-content textarea'
    )].map((field) => {
      const escapedId = field.id && globalThis.CSS?.escape ? CSS.escape(field.id) : field.id;
      return {
        id: field.id,
        name: field.getAttribute('name') ?? '',
        tag: field.tagName.toLowerCase(),
        autocomplete: field.getAttribute('autocomplete') ?? '',
        labelled: Boolean(
          (escapedId && document.querySelector('label[for="' + escapedId + '"]')) ||
          field.closest('label') ||
          field.getAttribute('aria-label') ||
          field.getAttribute('aria-labelledby')
        ),
      };
    });
    return {
      recipeId: document.querySelector('.dossier-current-id')?.textContent ?? '',
      title: document.getElementById('wizard-step-title')?.textContent ?? '',
      stepTitle: document.querySelector('.wizard-step-link[aria-current="step"]')?.getAttribute('aria-label') ?? '',
      stepProgress: document.querySelector('.dossier-stage-progress > span')?.textContent.trim() ?? '',
      stepCount: document.querySelectorAll('.wizard-step-link').length,
      hasReviewStep: [...document.querySelectorAll('.wizard-step-link')]
        .some((button) => /Confirm & run/i.test(button.textContent ?? '')),
      wizardCount: document.querySelectorAll('.recipe-wizard').length,
      currentStepCount: document.querySelectorAll('[data-wizard-step]').length,
      topLevelTabs: [...document.querySelectorAll('[role="tab"]')]
        .filter((tab) => !document.getElementById('dossier-output')?.contains(tab)).length,
      identityKind: document.querySelector('.execution-context-bar')?.dataset.identityKind ?? '',
      azureAccountControls: /Sign in with Microsoft|Switch Azure account|Account \\/ subscription|Set Active/
        .test(document.body.textContent ?? ''),
      signInEnabled: document.querySelector('.dossier-identity-action-primary')?.disabled === false,
      terminalFallback: /Refresh Azure CLI Status/.test(document.body.textContent ?? ''),
      deviceFlowContent: /device\\s*code|microsoft\\.com\\/devicelogin/i.test(document.body.textContent ?? ''),
      futureStepDisabled: [...document.querySelectorAll('.wizard-step-link')]
        .filter((button) => button.getAttribute('aria-current') !== 'step')
        .some((button) => button.disabled),
      fields,
      actionVisible: visible(document.getElementById('wizard-action-bar')),
    };
  })()`);
}

async function viewportSnapshot(harness) {
  return harness.evaluate(`(() => {
    const visible = (element) => Boolean(
      element &&
      !(element.tagName !== 'SUMMARY' && element.closest('details:not([open])')) &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden'
    );
    const shell = document.getElementById('dossier-shell');
    const masthead = document.getElementById('masthead');
    const contextGrid = document.querySelector('.execution-context-grid');
    const contextDisclosure = document.querySelector('.execution-context-disclosure');
    const contextSummary = document.querySelector('.execution-context-summary');
    const directory = document.getElementById('recipe-directory');
    const drawerControl = document.querySelector('.dossier-directory-toggle');
    const workspaceBar = document.querySelector('.dossier-workspace-bar');
    const workspaceStyle = workspaceBar ? getComputedStyle(workspaceBar) : null;
    const stepNav = document.querySelector('.wizard-step-nav');
    const stepSelector = document.querySelector('.dossier-stage-progress select');
    const actionBar = document.getElementById('wizard-action-bar');
    const main = document.getElementById('run-dossier');
    const mainStyle = main ? getComputedStyle(main) : null;
    const bodyStyle = getComputedStyle(document.body);
    const directoryList = directory?.querySelector('.recipe-directory-groups');
    const directoryStyle = directoryList ? getComputedStyle(directoryList) : null;
    const controls = [...document.querySelectorAll(
      '#dossier-shell button:not([disabled]), #dossier-shell input:not([disabled]), #dossier-shell select:not([disabled]), #dossier-shell textarea:not([disabled]), #dossier-shell summary'
    )].filter(visible);
    const nestedFormScrollers = [...document.querySelectorAll(
      '.wizard-step-content form, .wizard-step-content fieldset, .wizard-step-content [data-parameter-group]'
    )].filter((element) => {
      const style = getComputedStyle(element);
      return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    }).length;
    const safeAreaRule = [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((rule) =>
          /safe-area-inset-bottom/.test(rule.cssText) && /wizard-action-bar/.test(rule.cssText)
        );
      } catch {
        return false;
      }
    });
    const clippedMastheadControlLabels = [...masthead?.querySelectorAll('button, summary') ?? []]
      .filter(visible)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -0.5 || rect.right > innerWidth + 0.5;
      })
      .map((element) => element.getAttribute('aria-label') || element.textContent.trim());
    return {
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      documentClientHeight: document.documentElement.clientHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      shellWidth: shell?.scrollWidth ?? 0,
      mastheadScrollWidth: masthead?.scrollWidth ?? 0,
      mastheadClientWidth: masthead?.clientWidth ?? 0,
      clippedMastheadControls: clippedMastheadControlLabels.length,
      clippedMastheadControlLabels,
      contextHorizontalOverflow:
        Boolean(contextGrid) && contextGrid.scrollWidth > contextGrid.clientWidth + 1,
      contextDisclosureOpen: contextDisclosure?.open === true,
      contextSummaryVisible: visible(contextSummary),
      contextSummaryTargetVisible: (() => {
        const target = document.querySelector('.execution-context-summary-target');
        return Boolean(
          target
          && target.getClientRects().length > 0
          && getComputedStyle(target).display !== 'none'
          && getComputedStyle(target).visibility !== 'hidden'
        );
      })(),
      mainOverflowY: mainStyle?.overflowY ?? '',
      mainClientHeight: main?.clientHeight ?? 0,
      mainScrollHeight: main?.scrollHeight ?? 0,
      mainHorizontalOverflow: Boolean(main) && main.scrollWidth > main.clientWidth + 1,
      bodyOverflowY: bodyStyle.overflowY,
      directoryOverflowY: directoryStyle?.overflowY ?? '',
      directoryClientHeight: directoryList?.clientHeight ?? 0,
      directoryScrollHeight: directoryList?.scrollHeight ?? 0,
      nestedFormScrollers,
      visibleStepContents: [...document.querySelectorAll('.wizard-step-content')].filter(visible).length,
      directoryVisible: visible(directory),
      drawerControlVisible: visible(drawerControl),
      drawerControlText: drawerControl?.textContent.trim() ?? '',
      drawerControlWidth: drawerControl?.getBoundingClientRect().width ?? 0,
      drawerControlBottom: drawerControl?.getBoundingClientRect().bottom ?? 0,
      workspaceBarWidth: workspaceBar?.clientWidth ?? 0,
      workspaceContentWidth: workspaceBar
        ? workspaceBar.clientWidth
          - Number.parseFloat(workspaceStyle.paddingLeft || '0')
          - Number.parseFloat(workspaceStyle.paddingRight || '0')
        : 0,
      stepNavVisible: visible(stepNav),
      stepSelectorVisible: visible(stepSelector),
      stepSelectorTop: stepSelector?.getBoundingClientRect().top ?? 0,
      actionBarPosition: actionBar ? getComputedStyle(actionBar).position : '',
      actionInWorkspace: main?.contains(actionBar) === true,
      primaryActionCount: [...document.querySelectorAll('#wizard-action-bar .btn-primary')].filter(visible).length,
      safeAreaRule,
      minimumControlHeight: controls.length
        ? Math.min(...controls.map((element) => element.getBoundingClientRect().height))
        : 0,
    };
  })()`);
}

async function scrollReachabilitySnapshot(harness, path) {
  return harness.evaluate(`(async () => {
    const visible = (element) => Boolean(
      element &&
      !(element.tagName !== 'SUMMARY' && element.closest('details:not([open])')) &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden'
    );
    const main = document.getElementById('run-dossier');
    const action = document.getElementById('wizard-action-bar');
    const targetRow = [...document.querySelectorAll('[data-parameter-path]')]
      .find((candidate) => candidate.dataset.parameterPath === ${JSON.stringify(path)});
    const target = targetRow?.querySelector('input, select, textarea');
    const fields = [...document.querySelectorAll(
      '.wizard-step-content input:not([type="hidden"]), .wizard-step-content select, .wizard-step-content textarea'
    )].filter(visible);
    const last = fields.at(-1);
    const withinWorkspace = (element) => {
      if (!main || !element) return false;
      const mainRect = main.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const top = Math.max(mainRect.top, 0);
      const bottom = Math.min(mainRect.bottom, innerHeight);
      return rect.top >= top - 1 && rect.bottom <= bottom + 1;
    };
    const withinViewport = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.top >= -1 && rect.bottom <= innerHeight + 1 &&
        rect.left >= -1 && rect.right <= innerWidth + 1;
    };
    if (!main || !target || !last) return { found: false };
    main.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const initialTargetVisible = withinWorkspace(target);
    const actionVisibleBefore = visible(action) && withinViewport(action);
    main.scrollTop = main.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const targetVisible = withinWorkspace(target);
    last.focus({ preventScroll: true });
    last.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const lastVisible = withinWorkspace(last);
    const activeIsLast = document.activeElement === last;
    action.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      found: true,
      initialTargetVisible,
      actionVisibleBefore,
      targetVisible,
      lastVisible,
      actionVisibleAfter: visible(action) && withinViewport(action),
      activeIsLast,
      targetPath: target.closest('[data-parameter-path]')?.dataset.parameterPath ?? '',
      lastPath: last.closest('[data-parameter-path]')?.dataset.parameterPath ?? '',
      scrollTop: main.scrollTop,
      maxScrollTop: main.scrollHeight - main.clientHeight,
      scrollHeight: main.scrollHeight,
      clientHeight: main.clientHeight,
      overflowY: getComputedStyle(main).overflowY,
      horizontalOverflow: main.scrollWidth > main.clientWidth + 1,
    };
  })()`);
}

async function dispatchScrollKey(harness, key, code, windowsVirtualKeyCode) {
  const event = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
  await harness.page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
  await harness.page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  await settle(harness);
}

async function keyboardScrollSnapshot(harness) {
  const ready = await harness.evaluate(`(() => {
    const main = document.getElementById('run-dossier');
    if (!main || main.scrollHeight <= main.clientHeight + 1) return false;
    main.scrollTop = 0;
    main.focus({ preventScroll: true });
    return document.activeElement === main;
  })()`);
  if (!ready) return { ready: false };
  await dispatchScrollKey(harness, 'PageDown', 'PageDown', 34);
  const pageDown = await harness.evaluate("document.getElementById('run-dossier')?.scrollTop ?? 0");
  await harness.evaluate("document.getElementById('run-dossier').scrollTop = 0");
  await dispatchScrollKey(harness, ' ', 'Space', 32);
  const space = await harness.evaluate("document.getElementById('run-dossier')?.scrollTop ?? 0");
  await harness.evaluate("document.getElementById('run-dossier').scrollTop = 0");
  await dispatchScrollKey(harness, 'End', 'End', 35);
  const end = await harness.evaluate("document.getElementById('run-dossier')?.scrollTop ?? 0");
  const max = await harness.evaluate(`(() => {
    const main = document.getElementById('run-dossier');
    return main ? main.scrollHeight - main.clientHeight : 0;
  })()`);
  await dispatchScrollKey(harness, 'Home', 'Home', 36);
  const home = await harness.evaluate("document.getElementById('run-dossier')?.scrollTop ?? 0");
  return {
    ready: true,
    pageDown,
    space,
    end,
    max,
    home,
    activeWorkspace: await harness.evaluate("document.activeElement?.id === 'run-dossier'"),
  };
}

async function helpSnapshot(harness, path) {
  return harness.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-parameter-path]')]
      .find((candidate) => candidate.dataset.parameterPath === ${JSON.stringify(path)});
    const help = row?.querySelector('.configure-field-help');
    const body = help?.querySelector('.configure-field-help-body');
    const style = body ? getComputedStyle(body) : null;
    const text = body?.innerText.replace(/\\s+/g, ' ').trim() ?? '';
    return {
      found: Boolean(row && help && body),
      open: help?.open === true,
      text,
      hasRecovery: /Run APIM discovery/.test(text),
      hasManual: /Enter manually/.test(text),
      hasCliDisclosure: /Show CLI command/.test(text),
      exposesInternalPath: /samples\\.weather|hub\\.gatewayUrl|profile ownership|notebook cell/i.test(text),
      nestedScroller: Boolean(
        body &&
        style &&
        /(auto|scroll)/.test(style.overflowY) &&
        body.scrollHeight > body.clientHeight + 1
      ),
      lineEstimate: body ? Math.ceil(body.getBoundingClientRect().height / parseFloat(style.lineHeight || '20')) : 0,
    };
  })()`);
}

async function sourceSnapshot(harness) {
  return harness.evaluate(`(() => {
    const dialog = document.getElementById('source-inspector');
    const frame = dialog?.querySelector('.source-inspector-frame');
    const cell = dialog?.querySelector('[data-source-cell]');
    const code = frame?.querySelector('pre');
    const frameStyle = frame ? getComputedStyle(frame) : null;
    return {
      open: dialog?.open === true,
      visibleCells: [...dialog?.querySelectorAll('[data-source-cell]') ?? []]
        .filter((element) => element.getClientRects().length > 0).length,
      protected: cell?.dataset.protected,
      editable: cell?.dataset.editable,
      editableDescendants: cell?.querySelectorAll('input, textarea, select, [contenteditable="true"]').length ?? 0,
      dialogWithinViewport:
        Boolean(dialog) &&
        dialog.getBoundingClientRect().width <= innerWidth + 1 &&
        dialog.getBoundingClientRect().height <= innerHeight + 1,
      localScroll:
        Boolean(frameStyle) &&
        /(auto|scroll)/.test(frameStyle.overflowX) &&
        /(auto|scroll)/.test(frameStyle.overflowY),
      wrapControl: Boolean(dialog?.querySelector('button[aria-pressed]')),
      codeWhiteSpace: code ? getComputedStyle(code).whiteSpace : '',
    };
  })()`);
}

async function validationFocusSnapshot(harness) {
  const before = await harness.evaluate("document.querySelector('[data-wizard-step]')?.dataset.wizardStep");
  await workspacePointer(harness, '#wizard-action-bar .btn-primary');
  await settle(harness);
  return harness.evaluate(`(() => {
    const main = document.getElementById('run-dossier');
    const action = document.getElementById('wizard-action-bar');
    const active = document.activeElement;
    const mainRect = main?.getBoundingClientRect();
    const actionRect = action?.getBoundingClientRect();
    const activeRect = active?.getBoundingClientRect();
    const visibleBottom = Math.min(mainRect?.bottom ?? innerHeight, innerHeight);
    return {
      before: ${JSON.stringify(before)},
      after: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
      activePath: active?.closest('[data-parameter-path]')?.dataset.parameterPath ?? '',
      invalid: active?.getAttribute('aria-invalid') === 'true',
      activeVisible: Boolean(
        activeRect &&
        mainRect &&
        activeRect.top >= mainRect.top - 1 &&
        activeRect.bottom <= visibleBottom + 1
      ),
      workspaceScrollTop: main?.scrollTop ?? 0,
    };
  })()`);
}

async function lowerFieldValidationFocusSnapshot(harness) {
  await navigateToRecipe(harness, 'publish-assets');
  await setValues(harness, {
    'hub.subscriptionId': '00000000-1111-2222-3333-444444444444',
    'hub.resourceGroupName': 'rg-wizard-acceptance',
    'hub.apimName': 'apim-wizard-acceptance',
    'hub.location': '',
  });
  await harness.evaluate(`(() => {
    const main = document.getElementById('run-dossier');
    if (main) main.scrollTop = 0;
    return true;
  })()`);
  return validationFocusSnapshot(harness);
}

async function stepNavigationSnapshot(harness) {
  await navigateToRecipe(harness, 'publish-assets');
  await setValues(harness, {
    'hub.subscriptionId': '00000000-1111-2222-3333-444444444444',
    'hub.resourceGroupName': 'rg-wizard-acceptance',
    'hub.apimName': 'apim-wizard-acceptance',
    'hub.location': 'westeurope',
  });
  await harness.evaluate(`(() => {
    const main = document.getElementById('run-dossier');
    if (main) main.scrollTop = main.scrollHeight;
    return true;
  })()`);
  const advanced = await clickContinue(harness);
  return harness.evaluate(`(() => {
    const main = document.getElementById('run-dossier');
    const heading = document.getElementById('wizard-step-title');
    const mainRect = main?.getBoundingClientRect();
    const headingRect = heading?.getBoundingClientRect();
    return {
      advanced: ${JSON.stringify(advanced)},
      step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep ?? '',
      activeId: document.activeElement?.id ?? '',
      headingVisible: Boolean(
        mainRect &&
        headingRect &&
        headingRect.top >= mainRect.top - 1 &&
        headingRect.bottom <= mainRect.bottom + 1
      ),
      workspaceScrollTop: main?.scrollTop ?? 0,
    };
  })()`);
}

async function simpleRecipeScrollSnapshot(harness) {
  await harness.setViewport({ width: 1252, height: 876, mobile: false });
  await navigateToRecipe(harness, 'azure-context-check');
  return harness.evaluate(`(() => {
    const main = document.getElementById('run-dossier');
    return {
      scrollHeight: main?.scrollHeight ?? 0,
      clientHeight: main?.clientHeight ?? 0,
      overflowY: main ? getComputedStyle(main).overflowY : '',
    };
  })()`);
}

async function longActionLabelSnapshot(harness) {
  await harness.setViewport({ width: 320, height: 480, mobile: true });
  await navigateToRecipe(harness, 'cleanup');
  const targetName = 'a'.repeat(50);
  await setValues(harness, {
    'hub.subscriptionId': '00000000-1111-2222-3333-444444444444',
    'hub.resourceGroupName': 'rg-wizard-acceptance',
    'hub.apimName': targetName,
    'samples.cleanup.confirmNonProduction': true,
    'samples.cleanup.deleteWeatherSourceApi': true,
  });
  const reachedReview = await advanceToReview(harness);
  await harness.evaluate("document.querySelector('#wizard-action-bar .wizard-primary').scrollIntoView({block:'center'})");
  await settle(harness);
  const snapshot = await harness.evaluate(`(() => {
    const shell = document.getElementById('dossier-shell');
    const action = document.getElementById('wizard-action-bar');
    const button = [...action?.querySelectorAll('button') ?? []]
      .find((candidate) => /^Run Sample/.test(candidate.textContent.trim()));
    const actionRect = action?.getBoundingClientRect();
    const buttonRect = button?.getBoundingClientRect();
    return {
      reachedReview: ${JSON.stringify(reachedReview)},
      targetPresent: button?.textContent.includes(${JSON.stringify(targetName)}) === true,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      shellScrollWidth: shell?.scrollWidth ?? 0,
      shellClientWidth: shell?.clientWidth ?? 0,
      actionScrollWidth: action?.scrollWidth ?? 0,
      actionClientWidth: action?.clientWidth ?? 0,
      buttonScrollWidth: button?.scrollWidth ?? 0,
      buttonClientWidth: button?.clientWidth ?? 0,
      actionVisible: Boolean(
        actionRect &&
        actionRect.left >= -1 &&
        actionRect.right <= innerWidth + 1 &&
        actionRect.top >= -1 &&
        actionRect.bottom <= innerHeight + 1
      ),
      buttonVisible: Boolean(
        buttonRect &&
        buttonRect.left >= -1 &&
        buttonRect.right <= innerWidth + 1 &&
        buttonRect.top >= -1 &&
        buttonRect.bottom <= innerHeight + 1
      ),
      buttonWhiteSpace: button ? getComputedStyle(button).whiteSpace : '',
    };
  })()`);
  await harness.setViewport({ width: 1440, height: 900, mobile: false });
  await settle(harness);
  return snapshot;
}

async function compactLandscapeSnapshot(harness) {
  await harness.setViewport({ width: 568, height: 320, mobile: true });
  await navigateToRecipe(harness, 'publish-assets');
  const viewport = await viewportSnapshot(harness);
  const reachability = await scrollReachabilitySnapshot(harness, 'hub.location');
  await harness.setViewport({ width: 1440, height: 900, mobile: false });
  await settle(harness);
  return { viewport, reachability };
}

async function compactPhoneLandscapeSnapshot(harness) {
  await harness.setViewport({ width: 390, height: 320, mobile: true });
  await navigateToRecipe(harness, 'publish-assets');
  const viewport = await viewportSnapshot(harness);
  const reachability = await scrollReachabilitySnapshot(harness, 'hub.location');
  await harness.setViewport({ width: 1440, height: 900, mobile: false });
  await settle(harness);
  return { viewport, reachability };
}

async function blurRerenderSnapshot(harness) {
  await harness.setViewport({ width: 390, height: 844, mobile: true });
  await navigateToRecipe(harness, 'publish-assets');
  const before = await harness.evaluate(`(async () => {
    const main = document.getElementById('run-dossier');
    const control = document.getElementById('f-hub-resourceGroupName');
    if (!main || !control) return { ready: false };
    main.scrollTop = main.scrollHeight;
    control.focus({ preventScroll: true });
    control.scrollIntoView({ block: 'center', inline: 'nearest' });
    control.value = 'rg-blur-rerender-acceptance';
    control.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      ready: true,
      scrollTop: main.scrollTop,
      activeId: document.activeElement?.id ?? '',
    };
  })()`);
  await dispatchScrollKey(harness, 'Tab', 'Tab', 9);
  await harness.evaluate('new Promise((resolve) => setTimeout(resolve, 400))');
  const after = await harness.evaluate(`(() => {
    const main = document.getElementById('run-dossier');
    const active = document.activeElement;
    const mainRect = main?.getBoundingClientRect();
    const activeRect = active?.getBoundingClientRect();
    return {
      before: ${JSON.stringify(before)},
      scrollTop: main?.scrollTop ?? 0,
      activeId: active?.id ?? '',
      activeTag: active?.tagName ?? '',
      activeInsideWorkspace: main?.contains(active) === true,
      activeVisible: Boolean(
        mainRect &&
        activeRect &&
        activeRect.top >= mainRect.top - 1 &&
        activeRect.bottom <= mainRect.bottom + 1
      ),
    };
  })()`);
  await harness.setViewport({ width: 1440, height: 900, mobile: false });
  await settle(harness);
  return after;
}

async function approvalInvalidationSnapshot(harness) {
  const acknowledgement = await harness.evaluate(`(() => {
    const input = document.querySelector('#dossier-review input[type="checkbox"]');
    if (!input) return false;
    input.click();
    return input.checked;
  })()`);
  await setValues(harness, { 'hub.resourceGroupName': 'rg-wizard-acceptance-updated' });
  return harness.evaluate(`(() => ({
    acknowledgementInitiallySet: ${JSON.stringify(acknowledgement)},
    acknowledgementNowSet: document.querySelector('#dossier-review input[type="checkbox"]')?.checked ?? false,
    step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
  }))()`);
}

async function acknowledgementGateSnapshot(harness) {
  await navigateToRecipe(harness, 'publish-assets');
  if (!(await preparePublishReview(harness))) return { reachedReview: false };
  const before = await harness.evaluate(`(() => {
    const run = [...document.querySelectorAll('#wizard-action-bar button')]
      .find((candidate) => /^Run Sample/.test(candidate.textContent.trim()));
    const acknowledgement = document.querySelector('#dossier-review input[type="checkbox"]');
    return {
      runDisabled: run?.disabled === true,
      acknowledgementPresent: Boolean(acknowledgement),
    };
  })()`);
  await harness.evaluate(`(() => {
    const acknowledgement = document.querySelector('#dossier-review input[type="checkbox"]');
    if (acknowledgement && !acknowledgement.checked) acknowledgement.click();
    return true;
  })()`);
  await settle(harness);
  return {
    reachedReview: true,
    ...before,
    runEnabledAfterAcknowledgement: await harness.evaluate(`(() => {
      const run = [...document.querySelectorAll('#wizard-action-bar button')]
        .find((candidate) => /^Run Sample/.test(candidate.textContent.trim()));
      return run?.disabled === false;
    })()`),
  };
}

async function contextLossInvalidationSnapshot(harness) {
  await navigateToRecipe(harness, 'publish-assets');
  if (!(await preparePublishReview(harness))) return { reachedReview: false };
  const acknowledgementInitiallySet = await harness.evaluate(`(() => {
    const acknowledgement = document.querySelector('#dossier-review input[type="checkbox"]');
    if (acknowledgement && !acknowledgement.checked) acknowledgement.click();
    return acknowledgement?.checked === true;
  })()`);
  await harness.evaluate(`(() => {
    globalThis.__citadelTestHooks.installContext(null, 'unavailable');
    return true;
  })()`);
  await settle(harness);
  return harness.evaluate(`(() => ({
    reachedReview: true,
    acknowledgementInitiallySet: ${JSON.stringify(acknowledgementInitiallySet)},
    acknowledgementNowSet: document.querySelector('#dossier-review input[type="checkbox"]')?.checked ?? false,
    step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
  }))()`);
}

async function invalidValueFocusSnapshot(harness) {
  await navigateToRecipe(harness, 'apim-discovery');
  await setValues(harness, {
    'hub.subscriptionId': 'bad',
    'hub.resourceGroupName': 'rg-wizard-acceptance',
  });
  return validationFocusSnapshot(harness);
}

async function hostedGatewaySnapshot(harness) {
  await navigateToRecipe(harness, 'weather-mcp-discovery');
  await harness.evaluate(`(() => {
    globalThis.__citadelTestHooks.installContext({
      kind: 'hosted-relay',
      label: 'Hosted relay',
      state: 'ready',
      canExecute: true,
      summary: 'The hosted relay owns its target policy and gateway credential.',
      authority: {
        principalName: 'requester@example.test',
        principalType: 'user',
        tenantId: 'acceptance-tenant'
      },
      subscription: null,
      gateway: null,
      hostedRelay: {
        relayIdentity: 'mi-citadel-relay',
        keySource: 'Key Vault mapping',
        targetPolicy: 'weather gateway policy'
      },
      guarantees: {}
    });
    return true;
  })()`);
  await settle(harness);
  return harness.evaluate(`(() => ({
    title: document.querySelector('.wizard-step-link[aria-current="step"]')?.getAttribute('aria-label') ?? '',
    identityKind: document.querySelector('.execution-context-bar')?.dataset.identityKind ?? '',
    hostedPath: Boolean(document.querySelector('.hosted-identity-path')),
    gatewayKeyField: Boolean(
      document.querySelector('[data-parameter-path="gatewayAccess.apiKey"]')
    ),
    azureAccountControls: /Sign in with Microsoft|Switch Azure account|Set Active/
      .test(document.body.textContent ?? ''),
  }))()`);
}

async function crossRecipeHistorySnapshot(harness) {
  await navigateToRecipe(harness, 'publish-assets');
  await preparePublishReview(harness);
  const reviewHref = await harness.evaluate('location.href');
  await harness.evaluate('window.confirm = () => true');
  await navigationGroup(harness, 'exercise');
  await navigationPointer(harness, '[data-recipe-id="weather-mcp-discovery"]', { scroll: true });
  await harness.waitFor(
    "document.querySelector('.dossier-current-id')?.textContent === 'weather-mcp-discovery' && new URL(location.href).searchParams.get('recipe') === 'weather-mcp-discovery'",
    { label: 'gateway recipe before history restoration' },
  );
  await harness.evaluate('history.back()');
  await harness.waitFor(
    "document.querySelector('.dossier-current-id')?.textContent === 'publish-assets'",
    { label: 'Publish Assets history restoration' },
  );
  await settle(harness);
  return harness.evaluate(`(() => ({
    expectedHref: ${JSON.stringify(reviewHref)},
    href: location.href,
    step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
  }))()`);
}

async function destructiveDialogSnapshot(harness) {
  await harness.setViewport({ width: 390, height: 844, mobile: true });
  await settle(harness);
  const opened = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('#wizard-action-bar button')]
      .find((candidate) => /^Run Sample/.test(candidate.textContent.trim()));
    button?.focus();
    button?.click();
    return Boolean(button && !button.disabled);
  })()`);
  if (!opened) return { opened: false };
  await harness.waitFor("document.getElementById('destructive-run-dialog')?.open === true", {
    label: 'destructive confirmation dialog',
  });
  const snapshot = await harness.evaluate(`(() => {
    const dialog = document.getElementById('destructive-run-dialog');
    const footer = dialog?.querySelector('.destructive-confirmation-actions');
    const dialogRect = dialog?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    return {
      opened: dialog?.open === true,
      focusInside: dialog?.contains(document.activeElement) === true,
      footerVisible: Boolean(
        dialogRect
        && footerRect
        && footerRect.top >= dialogRect.top - 1
        && footerRect.bottom <= dialogRect.bottom + 1
        && footerRect.bottom <= innerHeight + 1
      ),
      text: dialog?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      requiredText: dialog?.querySelector('input')?.getAttribute('data-required-text') ??
        dialog?.querySelector('input')?.getAttribute('placeholder') ?? '',
    };
  })()`);
  await harness.page.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await harness.page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await harness.waitFor("document.getElementById('destructive-run-dialog')?.open !== true", {
    label: 'destructive confirmation dialog to close',
  });
  return {
    ...snapshot,
    focusReturned: await harness.evaluate(
      "document.activeElement?.closest('#wizard-action-bar') != null",
    ),
  };
}

async function openDestructiveConfirmationForScreenshot(harness) {
  const opened = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('#wizard-action-bar button')]
      .find((candidate) => /^Run Sample/.test(candidate.textContent.trim()));
    button?.click();
    return Boolean(button && !button.disabled);
  })()`);
  if (!opened) return { opened: false };
  await harness.waitFor("document.getElementById('destructive-run-dialog')?.open === true", {
    label: 'destructive confirmation screenshot',
  });
  await settle(harness);
  return harness.evaluate(`(() => {
    const dialog = document.getElementById('destructive-run-dialog');
    const footer = dialog?.querySelector('.destructive-confirmation-actions');
    const dialogRect = dialog?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    return {
      opened: dialog?.open === true,
      focusInside: dialog?.contains(document.activeElement) === true,
      footerVisible: Boolean(
        dialogRect
        && footerRect
        && footerRect.top >= dialogRect.top - 1
        && footerRect.bottom <= dialogRect.bottom + 1
        && footerRect.bottom <= innerHeight + 1
      ),
    };
  })()`);
}

async function openDirectoryForScreenshot(harness) {
  const clicked = await harness.evaluate(`(() => {
    const button = document.querySelector('.dossier-directory-toggle');
    button?.click();
    return Boolean(button);
  })()`);
  if (!clicked) return { opened: false };
  await harness.waitFor(
    "document.getElementById('recipe-drawer')?.dataset.open === 'true'",
    { label: 'recipe picker screenshot' },
  );
  await settle(harness);
  return harness.evaluate(`(() => {
    const drawer = document.getElementById('recipe-drawer');
    return {
      opened: drawer?.dataset.open === 'true',
      modal: drawer?.getAttribute('aria-modal') === 'true',
      focusInside: drawer?.contains(document.activeElement) === true,
      dossierInert: document.getElementById('run-dossier')?.hasAttribute('inert') === true,
    };
  })()`);
}

async function cleanupNoDeleteRunSnapshot(harness) {
  await navigateToRecipe(harness, 'cleanup');
  await setValues(harness, {
    'hub.resourceGroupName': 'rg-wizard-acceptance',
    'hub.apimName': 'apim-wizard-acceptance',
  });
  const ready = await advanceToReadOnlyRun(harness);
  const before = await harness.evaluate(`(() => {
    const action = document.querySelector('#wizard-action-bar .btn-primary');
    return {
      step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep ?? '',
      hasReviewStep: [...document.querySelectorAll('.dossier-stage-progress option')]
        .some((option) => option.value === 'review-approve'),
      operationPreview: [...document.querySelectorAll('.review-operation-details > summary')]
        .some((summary) => summary.textContent.trim() === 'Preview Exact Operation'),
      action: action?.textContent.trim() ?? '',
      enabled: Boolean(action && !action.disabled),
    };
  })()`);
  if (!ready || !before.enabled) return { ready, before };
  await harness.evaluate("document.querySelector('#wizard-action-bar .btn-primary')?.click()");
  await harness.waitFor(
    "document.querySelector('[data-wizard-step]')?.dataset.wizardStep === 'run-result' && document.body.textContent.includes('Loopback wizard acceptance completed.')",
    { label: 'cleanup no-delete result' },
  );
  const result = await harness.evaluate(`(() => ({
    step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep ?? '',
    output: document.getElementById('dossier-output')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
  }))()`);
  await harness.evaluate(`(() => {
    const back = [...document.querySelectorAll('#wizard-action-bar button')]
      .find((button) => button.textContent.trim() === 'Back');
    back?.click();
    return Boolean(back);
  })()`);
  await harness.waitFor(
    "document.querySelector('[data-wizard-step]')?.dataset.wizardStep !== 'run-result'",
    { label: 'cleanup no-delete Back action' },
  );
  return {
    ready,
    before,
    result,
    backStep: await harness.evaluate(
      "document.querySelector('[data-wizard-step]')?.dataset.wizardStep ?? ''",
    ),
  };
}

async function secretSnapshot(harness) {
  await navigateToRecipe(harness, 'weather-mcp-discovery');
  await setValues(harness, { 'hub.gatewayUrl': 'https://gateway.example.test' });
  await harness.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-parameter-path]')]
      .find((candidate) => candidate.dataset.parameterPath === 'gatewayAccess.apiKey');
    const control = row?.querySelector('input[type="password"]');
    if (!control) return false;
    control.focus();
    control.value = ${JSON.stringify(SECRET)};
    control.dataset.acceptanceIdentity = 'secret-control';
    control.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await harness.evaluate('new Promise((resolve) => setTimeout(resolve, 400))');
  return harness.evaluate(`(() => {
    const secret = ${JSON.stringify(SECRET)};
    const row = [...document.querySelectorAll('[data-parameter-path]')]
      .find((candidate) => candidate.dataset.parameterPath === 'gatewayAccess.apiKey');
    const control = row?.querySelector('input');
    const attributeLeak = [...document.querySelectorAll('*')].some((element) =>
      [...element.attributes].some((attribute) => attribute.value.includes(secret))
    );
    return {
      controlType: control?.type ?? '',
      controlHasValue: control?.value === secret,
      controlIdentityPreserved: control?.dataset.acceptanceIdentity === 'secret-control',
      textLeak: document.body.textContent.includes(secret),
      markupLeak: document.documentElement.outerHTML.includes(secret),
      attributeLeak,
      browserPersistentLeak: Object.values(globalThis['local' + 'Storage']).some((value) => value.includes(secret)),
      browserSessionLeak: Object.values(globalThis['session' + 'Storage']).some((value) => value.includes(secret)),
    };
  })()`);
}

async function typingContinuitySnapshot(harness) {
  await navigateToRecipe(harness, 'weather-mcp-discovery');
  await workspacePointer(harness, '.configure-advanced > summary');
  return harness.evaluate(`(async () => {
    const row = [...document.querySelectorAll('[data-parameter-path]')]
      .find((candidate) => candidate.dataset.parameterPath === 'gatewayAccess.subscriptionKeyHeader');
    const control = row?.querySelector('input');
    if (!control) return { found: false };
    control.dataset.acceptanceIdentity = 'gateway-header-control';
    control.focus();
    control.value = 'x-gateway-operator-acceptance-header';
    control.setSelectionRange(29, 29);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      found: true,
      value: control.value,
      active: document.activeElement === control,
      selectionStart: control.selectionStart,
      identityPreserved: control.dataset.acceptanceIdentity === 'gateway-header-control',
    };
  })()`);
}

async function gatewayKeyNavigationSnapshot(harness) {
  await navigateToRecipe(harness, 'weather-mcp-discovery');
  await setValues(harness, {
    'hub.gatewayUrl': 'https://gateway.example.test',
    'gatewayAccess.apiKey': SECRET,
  });
  await clickContinue(harness);
  await workspacePointer(harness, '.task-context-edit');
  await harness.waitFor(
    "document.querySelector('[data-wizard-step]')?.dataset.wizardStep === 'account-target'",
    { label: 'Gateway connection after Edit connection' },
  );
  await settle(harness);
  return harness.evaluate(`(() => ({
    readyToRun: true,
    clicked: true,
    step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
    activePath: document.activeElement?.closest('[data-parameter-path]')?.dataset.parameterPath ?? '',
    activeType: document.activeElement?.getAttribute('type') ?? '',
  }))()`);
}

async function destructiveInvalidationSnapshot(harness) {
  await navigateToRecipe(harness, 'cleanup');
  if (!(await prepareCleanupReview(harness))) return { reachedReview: false };
  const opened = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('#wizard-action-bar button')]
      .find((candidate) => /^Run Sample/.test(candidate.textContent.trim()));
    button?.click();
    return document.getElementById('destructive-run-dialog')?.open === true;
  })()`);
  if (!opened) return { reachedReview: true, opened: false };
  await harness.evaluate(`(() => {
    globalThis.__citadelTestHooks.setValue(
      'hub.resourceGroupName',
      'rg-wizard-acceptance-changed-after-dialog'
    );
    return true;
  })()`);
  await settle(harness);
  return harness.evaluate(`(() => ({
    reachedReview: true,
    opened: true,
    dialogStillPresent: Boolean(document.getElementById('destructive-run-dialog')),
    step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
    acknowledgement: document.querySelector('#dossier-review input[type="checkbox"]')?.checked ?? false,
  }))()`);
}

async function activeRunIsolationSnapshot(harness) {
  await navigateToRecipe(harness, 'publish-assets');
  await preparePublishReview(harness);
  await harness.evaluate(`(() => {
    const acknowledgement = document.querySelector('#dossier-review input[type="checkbox"]');
    if (acknowledgement && !acknowledgement.checked) acknowledgement.click();
    return true;
  })()`);
  await harness.evaluate(`(() => {
    let finish;
    let cancelled = 0;
    globalThis.__citadelAcceptanceRun = {
      finish(result) {
        finish?.(result);
      },
      cancelled: () => cancelled,
    };
    globalThis.__citadelTestHooks.installExecutor({
      describeCapability: () => ({
        id: 'active-run-isolation',
        kind: 'local',
        canExecute: true,
        supportedStepTypes: [],
        reason: 'loopback-only active run isolation'
      }),
      supports: () => ({ supported: true, unsupportedStepTypes: [] }),
      cancel: async () => {
        cancelled += 1;
        finish?.({
          state: 'cancelled',
          sampleId: 'publish-assets',
          summary: 'Loopback run cancelled.',
          detail: '',
          steps: [],
          assertions: [],
          configurationUpdates: {},
          secretUpdates: {},
          meta: {
            executor: 'local',
            executionMode: 'local',
            runId: 'active-run-0001',
            artifacts: [],
            azureContacted: false,
            liveEvidence: false
          }
        });
        return { cancelled: true };
      },
      execute: async (_plan, context = {}) => {
        context.onProgress?.({
          type: 'run-start',
          runId: 'active-run-0001',
          sampleId: 'publish-assets',
          workspace: '.'
        });
        context.onProgress?.({
          type: 'step',
          sampleId: 'weather-mcp-discovery',
          runId: 'different-run',
          step: { id: 'foreign-step', state: 'completed', summary: 'Must not render' }
        });
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
    });
    const button = [...document.querySelectorAll('#wizard-action-bar button')]
      .find((candidate) => /^Run Sample/.test(candidate.textContent.trim()));
    button?.click();
    return Boolean(button && !button.disabled);
  })()`);
  await harness.waitFor(
    "document.querySelector('[data-wizard-step]')?.dataset.wizardStep === 'run-result'",
    { label: 'active Run & result step' },
  );
  await settle(harness);
  const beforeHistory = await harness.evaluate(`(() => ({
    href: location.href,
    length: history.length,
    step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
    actionText: document.getElementById('wizard-action-bar')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
  }))()`);
  await navigationGroup(harness, 'exercise');
  await navigationPointer(harness, '[data-recipe-id="weather-mcp-discovery"]', { scroll: true });
  if (await harness.evaluate("document.querySelector('#recipe-drawer').getAttribute('aria-modal') === 'true'")) {
    await navigationPointer(harness, '.recipe-directory-close');
  }
  await harness.evaluate('history.back()');
  await harness.evaluate('new Promise((resolve) => setTimeout(resolve, 150))');
  const during = await harness.evaluate(`(() => ({
    recipeId: document.querySelector('.dossier-current-id')?.textContent ?? '',
    step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
    recipeDisabled: document.querySelector(
      '.recipe-directory-item[data-recipe-id="weather-mcp-discovery"]'
    )?.disabled === true,
    foreignProgressVisible: document.body.textContent.includes('Must not render'),
  }))()`);
  const cancelClicked = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('#wizard-action-bar button')]
      .find((candidate) => candidate.textContent.trim() === 'Cancel Run');
    button?.click();
    return Boolean(button);
  })()`);
  await harness.evaluate('new Promise((resolve) => setTimeout(resolve, 500))');
  return {
    beforeHistory,
    ...during,
    cancelClicked,
    cancelCalls: await harness.evaluate('globalThis.__citadelAcceptanceRun.cancelled()'),
    actionText: await harness.evaluate(
      "document.getElementById('wizard-action-bar')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''",
    ),
  };
}

async function runScenario(harness, reporter, scenario) {
  await harness.page.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
  await harness.page.send('Emulation.setEmulatedMedia', { media: '', features: [] });
  await harness.setViewport(scenario);
  await navigateToRecipe(harness, scenario.recipeId);

  if (scenario.review) {
    reporter.check(`${scenario.name}: reached Confirm & run`, await prepareCleanupReview(harness));
  }
  if (scenario.openHelpPath) {
    reporter.check(`${scenario.name}: opened concise field help`, await openFieldHelp(harness, scenario.openHelpPath));
  }
  if (scenario.openSource) {
    reporter.check(`${scenario.name}: opened protected source`, await openSource(harness));
  }
  if (scenario.openDiagnostics) {
    reporter.check(`${scenario.name}: opened offline diagnostics`, await openDiagnostics(harness));
  }
  if (scenario.reducedMotion) {
    await harness.page.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }
  if (scenario.forcedColors) {
    await harness.page.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'forced-colors', value: 'active' }],
    }).catch(() => {});
  }
  await settle(harness);

  if (!scenario.visualOnly && !scenario.openSource && !scenario.openDiagnostics) {
    const wizard = await wizardSnapshot(harness);
    reportIssues(reporter, `${scenario.name}: dynamic wizard contract`, wizardStepIssues(wizard));
    reportIssues(
      reporter,
      `${scenario.name}: fields expose label, name, and autocomplete`,
      fieldContractIssues(wizard.fields),
    );
    reporter.check(`${scenario.name}: future steps are launch-gated`, wizard.futureStepDisabled);
    reporter.check(`${scenario.name}: one wizard action surface is visible`, wizard.actionVisible);
    reporter.check(`${scenario.name}: no device-flow content is rendered`, !wizard.deviceFlowContent);
    if (scenario.recipeId === 'weather-mcp-discovery') {
      reporter.equal(`${scenario.name}: gateway identity is explicit`, wizard.identityKind, 'gateway-key');
      reporter.check(`${scenario.name}: gateway recipe has no Azure account controls`, !wizard.azureAccountControls);
      reporter.check(
        `${scenario.name}: gateway task is direct and skips low-risk review`,
        wizard.stepTitle.includes('Gateway connection') && wizard.hasReviewStep === false,
        JSON.stringify(wizard),
      );
    }
    if (scenario.recipeId === 'apim-discovery') {
      reporter.includes(`${scenario.name}: Azure step title is correct`, wizard.stepTitle, 'Azure account & target');
      reporter.check(
        `${scenario.name}: unavailable system login fails closed without exposing the private CLI path`,
        wizard.terminalFallback && !wizard.signInEnabled,
        JSON.stringify(wizard),
      );
    }
  }

  if (!scenario.visualOnly && !scenario.openSource && !scenario.openDiagnostics) {
    reportIssues(
      reporter,
      `${scenario.name}: responsive wizard contract`,
      viewportContractIssues(await viewportSnapshot(harness), scenario),
    );
  }

  if (scenario.keyboardScroll) {
    const keyboard = await keyboardScrollSnapshot(harness);
    reporter.check(
      `${scenario.name}: workspace supports PageDown, Space, End, and Home`,
      keyboard.ready &&
        keyboard.activeWorkspace &&
        keyboard.pageDown > 0 &&
      keyboard.space > 0 &&
        keyboard.end >= keyboard.max - 1 &&
        keyboard.home <= 1,
      JSON.stringify(keyboard),
    );
  }

  if (scenario.requiresWorkspaceScroll) {
    const reachability = await scrollReachabilitySnapshot(harness, scenario.reachabilityPath);
    reporter.check(
      `${scenario.name}: lower fields and the following action share one reachable scroll flow`,
      reachability.found &&
        !reachability.initialTargetVisible &&
        reachability.targetVisible &&
        reachability.lastVisible &&
        reachability.actionVisibleAfter &&
        reachability.activeIsLast &&
        reachability.scrollTop > 0 &&
        reachability.maxScrollTop > 0 &&
        /(auto|scroll)/.test(reachability.overflowY) &&
        !reachability.horizontalOverflow,
      JSON.stringify(reachability),
    );
  }

  if (scenario.openHelpPath) {
    const help = await helpSnapshot(harness, scenario.openHelpPath);
    reporter.check(
      `${scenario.name}: recovery help stays concise and operator-facing`,
      help.found &&
        help.open &&
        help.hasRecovery &&
        help.hasManual &&
        !help.exposesInternalPath &&
        !help.nestedScroller &&
        help.lineEstimate <= 8,
      JSON.stringify(help),
    );
  }

  if (scenario.openSource) {
    const source = await sourceSnapshot(harness);
    reporter.check(
      `${scenario.name}: source is one immutable bounded cell with local scrolling`,
      source.open &&
        source.visibleCells === 1 &&
        source.protected === 'true' &&
        source.editable === 'false' &&
        source.editableDescendants === 0 &&
        source.dialogWithinViewport &&
        source.localScroll,
      JSON.stringify(source),
    );
  }

  if (scenario.deviceScaleFactor) {
    const zoom = await harness.evaluate(`(() => ({
      devicePixelRatio,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }))()`);
    reporter.check(
      `${scenario.name}: 200% effective reflow uses a halved CSS viewport without clipping`,
      zoom.devicePixelRatio >= 1.9 &&
        zoom.viewportWidth <= 640 &&
        zoom.documentWidth <= zoom.viewportWidth + 1,
      JSON.stringify(zoom),
    );
  }

  if (scenario.reducedMotion) {
    const motion = await harness.evaluate(`(() => {
      const offenders = [];
      for (const element of document.querySelectorAll('#dossier-shell *')) {
        const style = getComputedStyle(element);
        const values = [style.animationDuration, style.transitionDuration]
          .flatMap((value) => value.split(','))
          .map((value) => value.trim().endsWith('ms')
            ? Number.parseFloat(value) / 1000
            : Number.parseFloat(value) || 0);
        if (Math.max(...values) > 0.011) offenders.push(element.id || element.className || element.tagName);
      }
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        offenders,
      };
    })()`);
    reporter.check(
      `${scenario.name}: reduced motion removes material animation`,
      motion.matches && motion.offenders.length === 0,
      motion.offenders.join(', '),
    );
  }

  if (scenario.forcedColors) {
    const contrast = await harness.evaluate(`(() => {
      if (!matchMedia('(forced-colors: active)').matches) return { supported: false };
      const target = document.querySelector('#dossier-shell button:not([disabled])');
      target?.focus();
      const style = target ? getComputedStyle(target) : null;
      return {
        supported: true,
        focusVisible: Boolean(style && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2),
      };
    })()`);
    if (contrast.supported) {
      reporter.check(`${scenario.name}: focus remains visible`, contrast.focusVisible);
    }
  }

  if (scenario.openDestructiveConfirmation) {
    const confirmation = await openDestructiveConfirmationForScreenshot(harness);
    reporter.check(
      `${scenario.name}: destructive confirmation is fully visible`,
      confirmation.opened && confirmation.focusInside && confirmation.footerVisible,
      JSON.stringify(confirmation),
    );
  }

  if (scenario.openDirectory) {
    const directory = await openDirectoryForScreenshot(harness);
    reporter.check(
      `${scenario.name}: constrained recipe picker is modal and contains focus`,
      directory.opened && directory.modal && directory.focusInside && directory.dossierInert,
      JSON.stringify(directory),
    );
  }

  await captureScreenshot(harness, scenario);
}

function fakeAzureIdentityManager() {
  let activeSubscriptionId = ACTIVE_SUBSCRIPTION_ID;
  const account = () =>
    JSON.stringify({
      id: activeSubscriptionId,
      name:
        activeSubscriptionId === ACTIVE_SUBSCRIPTION_ID
          ? 'Acceptance subscription'
          : 'Alternate subscription',
      tenantId: 'tenant-acceptance',
      user: { name: 'operator@example.test', type: 'user' },
      isDefault: true,
      state: 'Enabled',
    });
  const subscriptions = () =>
    JSON.stringify(
      [
        [ACTIVE_SUBSCRIPTION_ID, 'Acceptance subscription'],
        [ALTERNATE_SUBSCRIPTION_ID, 'Alternate subscription'],
      ].map(([id, name]) => ({
        id,
        name,
        tenantId: 'tenant-acceptance',
        user: { name: 'operator@example.test', type: 'user' },
        isDefault: id === activeSubscriptionId,
        state: 'Enabled',
      })),
    );
  const spawn = async (options) => {
    if (options.args[0] === 'login') {
      return new Promise((resolvePromise) => {
        options.signal.addEventListener(
          'abort',
          () => resolvePromise({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true }),
          { once: true },
        );
      });
    }
    if (options.args[0] === 'account' && options.args[1] === 'show') {
      return { code: 0, stdout: account(), stderr: '', timedOut: false, aborted: false };
    }
    if (options.args[0] === 'account' && options.args[1] === 'list') {
      return { code: 0, stdout: subscriptions(), stderr: '', timedOut: false, aborted: false };
    }
    if (options.args[0] === 'account' && options.args[1] === 'set') {
      await new Promise((done) => setTimeout(done, 75));
      activeSubscriptionId = options.args[3];
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    throw new Error(`Unexpected fake Azure CLI command: ${options.args.join(' ')}`);
  };
  return createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
}

async function checkSystemAzureIdentityControls(reporter) {
  const harness = await launchBrowserHarness({
    browserPath: argumentValue('--chrome'),
    createServer: ({ port, testBootstrapCapability }) =>
      createPlaygroundServer({
        port,
        mode: 'execute',
        publicOrigin: null,
        allowSystemAzureLogin: true,
        executionContextManager: fakeAzureIdentityManager(),
        testBootstrapCapability,
      }),
    path: '/',
  });
  try {
    await harness.waitFor(
      "document.querySelector('[data-wizard-step]') && document.querySelector('.dossier-current-id')?.textContent === 'azure-context-check'",
      { timeoutMs: 30_000, label: 'Azure identity wizard' },
    );
    await harness.waitFor(
      "document.querySelectorAll('#dossier-account-subscription option').length === 2",
      { label: 'server-enumerated Azure subscriptions' },
    );
    const initial = await harness.evaluate(`(() => ({
      signIn: document.querySelector('.dossier-identity-action-primary')?.textContent ?? '',
      options: [...document.querySelectorAll('#dossier-account-subscription option')].map((option) => option.value),
      selected: document.getElementById('dossier-account-subscription')?.value ?? '',
      configurationExports: Boolean(document.querySelector('.configure-exports')),
      deviceMaterial: /device\\s*code|verificationUrl|userCode|devicelogin/i.test(document.documentElement.outerHTML),
    }))()`);
    reporter.check(
      'the wizard consumes the advertised system login and subscription capabilities',
      initial.signIn === 'Switch Azure account' &&
        initial.options.length === 2 &&
        initial.selected === ACTIVE_SUBSCRIPTION_ID &&
        initial.configurationExports &&
        !initial.deviceMaterial,
      JSON.stringify(initial),
    );

    await workspacePointer(harness, '.dossier-identity-action-primary');
    await harness.waitFor(
      "[...document.querySelectorAll('.dossier-identity-action')].some((button) => button.textContent === 'Cancel sign-in')",
      { label: 'cancellable system Azure login' },
    );
    const pending = await harness.evaluate(`(() => ({
      cancel: [...document.querySelectorAll('.dossier-identity-action')].some((button) => button.textContent === 'Cancel sign-in'),
      deviceMaterial: /device\\s*code|verificationUrl|userCode|devicelogin/i.test(document.documentElement.outerHTML),
    }))()`);
    reporter.check(
      'system Azure login is cancellable without exposing device-flow material',
      pending.cancel && !pending.deviceMaterial,
      JSON.stringify(pending),
    );
    await workspacePointer(harness, '.task-identity > .dossier-identity-action');
    await harness.waitFor(
      "document.querySelector('.dossier-identity-action-primary')?.textContent === 'Switch Azure account'",
      { label: 'cancelled login recovery' },
    );
    await harness.waitFor(
      "document.querySelectorAll('#dossier-account-subscription option').length === 2 && " +
        "document.getElementById('dossier-account-subscription')?.disabled === false",
      { label: 'refreshed Azure subscription inventory' },
    );

    await workspacePointer(harness, '.task-account-controls > summary');
    await navigationGroup(harness, 'exercise');
    await harness.evaluate(`(() => {
      const select = document.getElementById('dossier-account-subscription');
      select.value = ${JSON.stringify(ALTERNATE_SUBSCRIPTION_ID)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await harness.waitFor(
      "[...document.querySelectorAll('.dossier-identity-action')].some((button) => button.textContent === 'Set Active' && !button.disabled)",
      { label: 'enabled Azure subscription activation' },
    );
    const recipeDuringActivation = await harness.evaluate(`(async () => {
      [...document.querySelectorAll('.dossier-identity-action')]
        .find((button) => button.textContent === 'Set Active' && !button.disabled)?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      document.querySelector('[data-recipe-id="weather-mcp-discovery"]')?.click();
      return document.querySelector('.dossier-current-id')?.textContent ?? '';
    })()`);
    reporter.equal(
      'recipe navigation is locked while the launch-private Azure subscription changes',
      recipeDuringActivation,
      'azure-context-check',
    );
    await harness.waitFor(
      `document.getElementById('dossier-account-subscription')?.value === ${JSON.stringify(ALTERNATE_SUBSCRIPTION_ID)} &&
       [...document.querySelectorAll('.dossier-identity-action')]
         .find((button) => button.textContent === 'Set Active')?.disabled === true`,
      { label: 'verified Azure subscription activation' },
    );
    reporter.check(
      'subscription activation reconciles the wizard to the verified launch-private CLI subscription',
      await harness.evaluate(
        `document.getElementById('dossier-account-subscription')?.value === ${JSON.stringify(ALTERNATE_SUBSCRIPTION_ID)}`,
      ),
    );
    reporter.check(
      'the system Azure capability flow reported no uncaught browser errors',
      harness.pageErrors.length === 0,
      harness.pageErrors.join('; '),
    );
  } finally {
    await harness.close();
  }
}

function browserAcceptanceRelay() {
  return {
    enabled: true,
    hosted: false,
    url: 'https://relay.example.test/execute',
    allowedSampleIds: ['weather-mcp-discovery'],
    callerPrincipal: 'browser-acceptance-proxy',
    tenant: 'browser-acceptance-tenant',
    credentialProvider: {
      getAuthorizationHeader: async () => 'Bearer browser-acceptance',
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          state: 'completed',
          summary: 'Hosted weather discovery completed.',
          detail: '',
          steps: [],
          assertions: [],
          configurationUpdates: {},
          secretUpdates: {},
          meta: {
            executor: 'hosted-relay',
            azureContacted: true,
            liveEvidence: true,
          },
        }),
    }),
  };
}

async function checkHostedRelayReadiness(reporter) {
  const harness = await launchBrowserHarness({
    browserPath: argumentValue('--chrome'),
    createServer: ({ port, testBootstrapCapability }) =>
      createPlaygroundServer({
        port,
        mode: 'preview',
        publicOrigin: null,
        relay: browserAcceptanceRelay(),
        testBootstrapCapability,
      }),
    path: '/?recipe=weather-mcp-discovery',
  });
  try {
    await harness.waitFor(
      "document.querySelector('.dossier-current-id')?.textContent === 'weather-mcp-discovery'",
      { timeoutMs: 30_000, label: 'hosted weather wizard' },
    );
    await harness.waitFor(
      "document.querySelector('.execution-context-bar')?.dataset.identityKind === 'hosted-relay'",
      { label: 'hosted relay execution context' },
    );
    await clickContinue(harness);
    await harness.evaluate(`(() => {
      const row = [...document.querySelectorAll('[data-parameter-path]')]
        .find((candidate) => candidate.dataset.parameterPath === 'hub.gatewayUrl');
      const input = row?.querySelector('input');
      if (!input) return false;
      input.focus();
      input.value = 'https://gateway.example.test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
      return true;
    })()`);
    await harness.waitFor(
      "document.querySelector('#wizard-action-bar .btn-primary')?.disabled === false",
      { label: 'hosted weather setup action' },
    );
    await settle(harness);
    const directRunReady = await advanceToReadOnlyRun(harness);
    const beforeRun = await harness.evaluate(`(() => {
      const run = [...document.querySelectorAll('#wizard-action-bar button')]
        .find((candidate) => candidate.textContent.trim() === 'Run Check');
      return {
        runner: document.querySelector('.dossier-masthead-status')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        identityKind: document.querySelector('.execution-context-bar')?.dataset.identityKind ?? '',
        context: document.querySelector('.execution-context-bar')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        chain: [...document.querySelectorAll('.hosted-identity-path li')].map((item) =>
          item.textContent.replace(/\\s+/g, ' ').trim()
        ),
        gatewayKeyField: Boolean(document.querySelector('[data-parameter-path="gatewayAccess.apiKey"]')),
        operationPreview: [...document.querySelectorAll('.review-operation-details > summary')]
          .some((summary) => summary.textContent.trim() === 'Preview Exact Operation'),
        runPresent: Boolean(run),
        runEnabled: Boolean(run && !run.disabled),
      };
    })()`);
    reporter.check(
      'the real preview capability enables the allowlisted hosted weather run',
      directRunReady &&
        beforeRun.runner.includes('Hosted relay') &&
        !beforeRun.runner.includes('Preview only') &&
        beforeRun.identityKind === 'hosted-relay' &&
        beforeRun.context.includes('Not applicable') &&
        beforeRun.context.includes('Hosted relay gateway runs do not use this browser session') &&
        beforeRun.chain.length === 5 &&
        !beforeRun.gatewayKeyField &&
        beforeRun.operationPreview &&
        beforeRun.runPresent &&
        beforeRun.runEnabled,
      JSON.stringify(beforeRun),
    );

    await harness.evaluate(`(() => {
      const run = [...document.querySelectorAll('#wizard-action-bar button')]
        .find((candidate) => candidate.textContent.trim() === 'Run Check');
      run?.click();
      return Boolean(run && !run.disabled);
    })()`);
    await harness.waitFor(
      "document.querySelector('[data-wizard-step]')?.dataset.wizardStep === 'run-result' && document.body.textContent.includes('Hosted weather discovery completed.')",
      { label: 'hosted relay result' },
    );
    const result = await harness.evaluate(`(() => ({
      runner: document.querySelector('.dossier-masthead-status')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      output: document.getElementById('dossier-output')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    }))()`);
    await harness.evaluate('history.back()');
    await harness.waitFor(
      "document.querySelector('[data-wizard-step]')?.dataset.wizardStep !== 'run-result'",
      { label: 'validated read-only setup step after browser Back' },
    );
    result.backStep = await harness.evaluate(
      "document.querySelector('[data-wizard-step]')?.dataset.wizardStep ?? ''",
    );
    reporter.check(
      'hosted relay progress and results remain live-capable rather than preview evidence',
      result.runner.includes('Hosted relay') &&
        !result.runner.includes('Preview only') &&
        result.output.includes('Hosted relay') &&
        result.output.includes('Live target evidence') &&
        !result.output.includes('Preview only') &&
        ['account-target', 'required-inputs', 'credentials-options'].includes(result.backStep),
      JSON.stringify(result),
    );
    reporter.check(
      'the hosted relay browser flow reports no uncaught errors',
      harness.pageErrors.length === 0,
      harness.pageErrors.join('; '),
    );
  } finally {
    await harness.close();
  }
}

export function navigationContractIssues(snapshot, { desktop = false } = {}) {
  const issues = [];
  if (snapshot.overflow) issues.push('the page overflows horizontally');
  if (!snapshot.searchVisible || !snapshot.headerVisible) issues.push('navigation chrome is not reachable');
  if (!desktop && !snapshot.closeVisible) issues.push('picker close is not reachable');
  if (snapshot.scrollOwners !== 1) issues.push('navigation must have one scroll owner');
  if (desktop && snapshot.visibleGroups !== 7) issues.push('not all seven group headings are visible');
  if (snapshot.minimumTarget < (desktop ? 40 : 44) - 0.5) issues.push('navigation targets are too short');
  if (snapshot.minimumFont < 14) issues.push('recipe names were shrunk');
  if (snapshot.metadataRows !== 0) issues.push('report metadata remains in the navigator');
  return issues;
}

export async function navigationKey(harness, key, windowsVirtualKeyCode, modifiers = 0) {
  const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
  for (const type of ['keyDown', 'keyUp']) {
    await harness.page.send('Input.dispatchKeyEvent', {
      type, key, windowsVirtualKeyCode, modifiers,
      ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}),
    });
  }
  await settle(harness);
}

export async function navigationPointer(harness, selector, { scroll = false } = {}) {
  for (let attempt = 0; attempt < (scroll ? 12 : 1); attempt += 1) {
    const point = await harness.evaluate(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)});
      if (!n || n.closest('details:not([open])') && n.tagName !== 'SUMMARY') return null;
      const r = n.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      const list = n.closest('.recipe-directory-groups')?.getBoundingClientRect();
      return {
        x, y, visible: r.width > 0 && r.height > 0 && r.top >= (list?.top ?? 0) &&
          r.bottom <= (list?.bottom ?? innerHeight) && n.contains(document.elementFromPoint(x, y)),
        wheelY: list ? (list.top + list.bottom) / 2 : innerHeight / 2,
        delta: r.top < (list?.top ?? 0) ? -160 : 160
      };
    })()`);
    if (!point) throw new Error(`Navigation target is absent or collapsed: ${selector}`);
    if (point.visible) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await harness.page.send('Input.dispatchMouseEvent', {
          type, x: point.x, y: point.y, button: 'left', clickCount: 1,
        });
      }
      await settle(harness);
      return;
    }
    if (!scroll) break;
    await harness.page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: point.x, y: point.wheelY, deltaX: 0, deltaY: point.delta,
    });
    await harness.evaluate('new Promise(resolve => setTimeout(resolve, 80))');
  }
  const obstruction = await harness.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const rect = node?.getBoundingClientRect();
    const covering = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
    return { step: document.querySelector('.wizard-step[aria-current="step"]')?.dataset.wizardStep,
      rect: rect?.toJSON(), active: document.activeElement?.id,
      covering: covering?.outerHTML.slice(0, 240), dialog: !!document.querySelector('dialog[open]') };
  })()`);
  throw new Error(`Navigation target is not visibly clickable: ${selector} ${JSON.stringify(obstruction)}`);
}

async function workspacePointer(harness, selector) {
  await settle(harness);
  await harness.evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!control || control.closest('[inert]') || control.matches(':disabled')) {
      throw new Error('The requested workspace control is unavailable.');
    }
    control.scrollIntoView({ block: 'center', inline: 'nearest' });
  })()`);
  await settle(harness);
  await navigationPointer(harness, selector);
}

async function runWorkspaceComposition(harness, reporter) {
  const riskOnly = process.argv.includes('--workspace-risk-only');
  const measurements = [];
  const capture = async (name, fieldId) => {
    await harness.evaluate("document.getElementById('run-dossier').scrollTop = 0");
    await settle(harness);
    const measurement = await harness.evaluate(`(() => {
      const action = document.querySelector('#wizard-action-bar .wizard-primary');
      const field = document.getElementById(${JSON.stringify(fieldId ?? '')});
      const form = field?.closest('form');
      const advanced = document.querySelector('.configure-advanced');
      const box = n => { const r = n?.getBoundingClientRect(); return r ? {top:r.top,bottom:r.bottom,width:r.width,height:r.height} : null; };
      const main = document.getElementById('run-dossier');
      return {
        viewport: {width:innerWidth,height:innerHeight},
        heading: document.querySelector('#wizard-step-title')?.textContent,
        headingCount: main.querySelectorAll('h1').length,
        column: box(document.querySelector('.recipe-wizard')),
        field: box(field), action: box(action),
        actionInForm: !!form && form.contains(action),
        actionPosition: getComputedStyle(document.getElementById('wizard-action-bar')).position,
        advancedAfterAction: !!advanced && !!(action.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING),
        advancedOpen: advanced?.open === true,
        target: document.querySelector('.task-target-exact')?.textContent ?? '',
        context: document.querySelector('.task-target')?.textContent ?? '',
        initialErrors: main.querySelectorAll('.configure-field-error,.configure-field-needed').length,
        overflow: main.scrollWidth > main.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth,
        fields: [...main.querySelectorAll('[data-parameter-path]')].map(n=>({path:n.dataset.parameterPath,type:n.querySelector('input,select,textarea')?.type})),
      };
    })()`);
    measurements.push({ name, ...measurement });
    const { data } = await harness.page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(resolve(ARTIFACT_DIRECTORY, `${name}.png`), Buffer.from(data, 'base64'));
    reporter.check(`${name}: one bounded task heading without horizontal overflow`,
      measurement.headingCount === 1 && measurement.column.width <= 737 && !measurement.overflow, JSON.stringify(measurement));
    return measurement;
  };
  try {
    for (const viewport of riskOnly ? [] : [{width:1440,height:900},{width:660,height:800},{width:390,height:844}]) {
      await harness.setViewport({ ...viewport, mobile: viewport.width === 390 });
      await navigateToRecipe(harness, 'azure-context-check', 'account-target', { previewOnly: true });
      const azure = await capture(`workspace-azure-${viewport.width}`, 'f-hub-subscriptionId');
      reporter.check(`${viewport.width}: Azure field and action share one form, without untouched errors`,
        azure.actionInForm && azure.actionPosition === 'static' && azure.initialErrors === 0 &&
        azure.field.width <= 449 && azure.action.top - azure.field.bottom < 160, JSON.stringify(azure));
      await navigateToRecipe(harness, 'weather-tools-call');
      await setValues(harness, { 'hub.gatewayUrl':'https://gateway.example.test', 'gatewayAccess.apiKey':SECRET });
      await capture(`workspace-weather-connection-${viewport.width}`, 'f-gatewayAccess-apiKey');
      await clickContinue(harness);
      const weather = await capture(`workspace-weather-call-${viewport.width}`, 'f-samples-weather-tools-call-city');
      reporter.check(`${viewport.width}: default City is immediate and Advanced follows the real action`,
        weather.actionInForm && weather.advancedAfterAction && !weather.advancedOpen &&
        weather.action.top - weather.field.bottom < 130 &&
        weather.target === 'https://gateway.example.test/mcp/weather-tool-mcp/mcp' &&
        /Key present in memory/.test(weather.context) && /authorization is unverified/.test(weather.context), JSON.stringify(weather));
      await workspacePointer(harness, '.configure-advanced > summary');
      await workspacePointer(harness, '#f-samples-weather-tools-call-toolName');
      await navigationKey(harness, 'Tab', 9);
      reporter.check(`${viewport.width}: optional field keyboard navigation stays inside the open form`,
        await harness.evaluate("document.querySelector('.configure-advanced').open && document.querySelector('#dossier-inputs').contains(document.activeElement)"));
    }
    if (!riskOnly) {
      await harness.setViewport({width:1440,height:900,mobile:false});
      await navigateToRecipe(harness, 'publish-assets');
      await capture('workspace-publish-1440', 'f-hub-location');
      await harness.setViewport({width:390,height:844,mobile:true});
      await capture('workspace-publish-390', 'f-hub-location');
    }
    await harness.setViewport({width:390,height:844,mobile:true});
    await navigateToRecipe(harness, 'cleanup');
    await prepareCleanupReview(harness);
    await workspacePointer(harness, '#wizard-action-bar .wizard-primary');
    await settle(harness);
    const destructive = await harness.evaluate(`(() => {
      const dialog=document.getElementById('destructive-run-dialog');
      const scroll=dialog.querySelector('.destructive-confirmation-scroll');
      scroll.scrollTop=0;
      return {open:dialog.open,text:scroll.innerText,focusInside:dialog.contains(document.activeElement)};
    })()`);
    const { data } = await harness.page.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    await writeFile(resolve(ARTIFACT_DIRECTORY,'workspace-cleanup-dialog-390.png'),Buffer.from(data,'base64'));
    reporter.check('Cleanup native dialog initially exposes target and identity before acknowledgement',
      destructive.open && destructive.focusInside && /apim-wizard-acceptance/.test(destructive.text) &&
      /acceptance@example.test/.test(destructive.text), JSON.stringify(destructive));
    await navigationKey(harness,'Escape',27);
    await harness.setViewport({width:1440,height:900,mobile:false});
    await hostedGatewaySnapshot(harness);
    await capture('workspace-hosted-1440');
    await workspacePointer(harness,'.execution-context-disclosure > summary');
    const hosted = await harness.evaluate("document.querySelector('.execution-context-body').innerText");
    reporter.check('Hosted details retain each distinct authority hop', /Entra caller/.test(hosted) && /Playground identity/.test(hosted) &&
      /Relay identity/.test(hosted) && /Key Vault \/ key/.test(hosted));
    const hostedImage=await harness.page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(resolve(ARTIFACT_DIRECTORY,'workspace-hosted-details-1440.png'),Buffer.from(hostedImage.data,'base64'));
  } finally {
    await writeFile(resolve(ARTIFACT_DIRECTORY, 'workspace-measurements.json'), JSON.stringify({measurements,checks:reporter.results},null,2));
  }
}

async function navigationTabTo(harness, selector) {
  for (let index = 0; index < 60; index += 1) {
    if (await harness.evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`)) return;
    await navigationKey(harness, 'Tab', 9);
  }
  throw new Error(`Keyboard did not reach ${selector}`);
}

async function navigationGroup(harness, group) {
  await openNavigationPicker(harness);
  const compact = await harness.evaluate('innerWidth < 1200');
  if (!await harness.evaluate(`document.querySelector('#recipe-group-${group}').parentElement.open`)) {
    await navigationPointer(harness, `#recipe-group-${group}`, { scroll: compact });
  }
}

async function navigationPickerState(harness) {
  return harness.evaluate(`(() => {
    const drawer = document.querySelector('#recipe-drawer');
    const hit = selector => {
      const n = document.querySelector(selector), r = n?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight &&
        n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    };
    return {
      width:innerWidth, height:innerHeight, open:drawer?.dataset.open === 'true',
      modal:drawer?.getAttribute('aria-modal') === 'true',
      expanded:document.querySelector('.dossier-directory-toggle')?.getAttribute('aria-expanded') === 'true',
      search:hit('#recipe-directory-search'), close:hit('.recipe-directory-close'),
      focusInside:drawer?.contains(document.activeElement) === true
    };
  })()`);
}

export async function openNavigationPicker(harness) {
  await settle(harness);
  const before = await navigationPickerState(harness);
  if (before.width >= 1200) return { before, after: before, clicked: false };
  if (!before.open) await navigationPointer(harness, '.dossier-directory-toggle');
  try {
    await harness.waitFor(`(() => {
      const drawer = document.querySelector('#recipe-drawer');
      if (drawer?.dataset.open !== 'true' || drawer.getAttribute('aria-modal') !== 'true' ||
          document.querySelector('.dossier-directory-toggle')?.getAttribute('aria-expanded') !== 'true') return false;
      return ['#recipe-directory-search', '.recipe-directory-close'].every(selector => {
        const n = document.querySelector(selector), r = n?.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight &&
          n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      });
    })()`, { timeoutMs: 5000, label: 'the actually open, visible and unoccluded recipe picker' });
  } catch (error) {
    throw new Error(`${error.message} Picker before/after: ${JSON.stringify({ before, after: await navigationPickerState(harness) })}`, { cause: error });
  }
  return { before, after: await navigationPickerState(harness), clicked: !before.open };
}

export async function navigationFocusCycle(harness, expected) {
  const capture = () => harness.evaluate(`(() => {
    const n = document.activeElement, r = n.getBoundingClientRect();
    const list = n.closest('.recipe-directory-groups')?.getBoundingClientRect();
    return {
      id:n.matches('.recipe-directory-close') ? 'close' : n.id,
      tag:n.tagName, inside:document.querySelector('#recipe-drawer').contains(n),
      visible:r.width > 0 && r.height > 0 && r.top >= (list?.top ?? 0) - 0.5 &&
        r.bottom <= (list?.bottom ?? innerHeight) + 0.5 &&
        n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
    };
  })()`);
  const traces = {};
  for (const [direction, modifiers] of [['forward', 0], ['backward', 8]]) {
    await navigationPointer(harness, '#recipe-directory-search');
    await navigationKey(harness, 'Tab', 9, 8);
    const trace = [await capture()];
    for (let index = 1; index <= expected.length; index += 1) {
      await navigationKey(harness, 'Tab', 9, modifiers);
      trace.push(await capture());
      if (!trace.at(-1).inside) break;
    }
    traces[direction] = trace;
  }
  const matches = (trace, reverse) => trace.length === expected.length + 1 && trace.every((entry, index) =>
    entry.inside && entry.visible &&
    entry.id === expected[(reverse ? expected.length - index : index) % expected.length]);
  return {
    expected, ...traces,
    wrapsForward:matches(traces.forward, false),
    wrapsBackward:matches(traces.backward, true),
  };
}

async function navigationSnapshot(harness) {
  await settle(harness);
  return harness.evaluate(`(() => {
    const nav = document.querySelector('#recipe-directory');
    const list = nav.querySelector('.recipe-directory-groups');
    const rect = n => { const r = n.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, height:r.height, width:r.width }; };
    const visible = n => {
      if (!n || n.closest('details:not([open])') && n.tagName !== 'SUMMARY') return false;
      const r = n.getBoundingClientRect(), insideList = list.contains(n), b = (insideList ? list : nav).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= Math.max(0,b.top)-0.5 &&
        r.bottom <= Math.min(innerHeight,b.bottom)+0.5 &&
        n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));
    };
    const groups = [...nav.querySelectorAll('.recipe-directory-group-heading')].map(n => ({
      title:n.querySelector('h3').textContent, ...rect(n), visible:visible(n), open:n.parentElement.open
    }));
    const rows = [...nav.querySelectorAll('.recipe-directory-item')].map(n => ({
      id:n.dataset.recipeId, title:n.textContent, ...rect(n), visible:visible(n),
      expanded:!n.closest('details:not([open])'), font:parseFloat(getComputedStyle(n).fontSize)
    }));
    const targets = [...nav.querySelectorAll('summary,button,input')].filter(visible);
    return {
      viewport:[innerWidth,innerHeight], directory:rect(nav),
      pickerOpen:document.querySelector('#recipe-drawer').dataset.open === 'true',
      pickerModal:document.querySelector('#recipe-drawer').getAttribute('aria-modal') === 'true',
      list:{...rect(list),scrollTop:list.scrollTop,clientHeight:list.clientHeight,scrollHeight:list.scrollHeight},
      groups,rows,visibleGroups:groups.filter(n=>n.visible).length,visibleRecipes:rows.filter(n=>n.visible).length,
      minimumTarget:Math.min(...targets.map(n=>n.getBoundingClientRect().height)),
      minimumFont:Math.min(...rows.map(n=>n.font)),
      scrollOwners:[nav,...nav.querySelectorAll('*')].filter(n=>/auto|scroll/.test(getComputedStyle(n).overflowY)).length,
      searchVisible:visible(nav.querySelector('input')),headerVisible:visible(nav.querySelector('.recipe-directory-header')),
      closeVisible:visible(nav.querySelector('.recipe-directory-close')),
      selectedVisible:visible(nav.querySelector('[aria-current="page"]')),
      metadataRows:nav.querySelectorAll('.recipe-directory-states,.recipe-directory-meta,.recipe-directory-group-summary').length,
      overflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)>innerWidth,
      focus:document.activeElement?.id,openGroups:[...nav.querySelectorAll('details[open]')].map(n=>n.dataset.groupId)
    };
  })()`);
}

async function runNavigationAcceptance() {
  const reporter = createCheckReporter({ name: 'recipe navigation acceptance' });
  const output = resolve(argumentValue('--artifacts') ?? resolve(ARTIFACT_DIRECTORY, 'navigation'));
  await mkdir(output, { recursive: true });
  const harness = await launchBrowserHarness({
    browserPath: argumentValue('--chrome'),
    createServer: (options) => createPlaygroundServer({
      ...options, host: '127.0.0.1', mode: 'preview', publicOrigin: null, relay: { enabled: false },
    }),
  });
  const snapshots = [];
  const pickerOpenings = [];
  const focusCycles = [];
  let guard;
  const record = async (label) => {
    const snapshot = await navigationSnapshot(harness);
    snapshots.push({ label, ...snapshot });
    const { data } = await harness.page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(resolve(output, `after-${label}.png`), Buffer.from(data, 'base64'));
    return snapshot;
  };
  const openPicker = async () => {
    pickerOpenings.push(await openNavigationPicker(harness));
  };
  const choose = async (group, recipe, scroll = false) => {
    await openPicker();
    if (!await harness.evaluate(`document.querySelector('#recipe-group-${group}').parentElement.open`)) {
      await navigationPointer(harness, `#recipe-group-${group}`, { scroll });
    }
    await navigationPointer(harness, `[data-recipe-id="${recipe}"]`, { scroll });
    await harness.waitFor(`new URL(location.href).searchParams.get('recipe') === '${recipe}'`);
    await settle(harness);
  };
  try {
    await waitForWizard(harness, 'azure-context-check');
    guard = await installRequestGuard(harness);
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 660, height: 800 },
      { width: 390, height: 844, mobile: true },
      { width: 320, height: 480, mobile: true },
    ]) {
      await harness.setViewport(viewport);
      await navigateToRecipe(harness, 'azure-context-check', 'account-target', { previewOnly: true });
      await openPicker();
      const desktop = viewport.width === 1440;
      const label = `${viewport.width}x${viewport.height}`;
      reportIssues(reporter, `${label}: compact initial navigation`, navigationContractIssues(await record(label), { desktop }));
      for (const [group, recipe] of [['exercise', 'weather-tools-call'], ['publish-grant', 'publish-assets'], ['lifecycle', 'cleanup']]) {
        await choose(group, recipe, !desktop);
        await openPicker();
        const selected = await navigationSnapshot(harness);
        reporter.check(`${label}: ${recipe} visibly selected`, selected.selectedVisible, JSON.stringify(selected));
        reportIssues(reporter, `${label}: ${recipe} navigation geometry`, navigationContractIssues(selected, { desktop }));
        if (recipe === 'weather-tools-call' || desktop) await record(`${label}-${recipe}`);
      }
      if (!desktop) {
        await navigationKey(harness, 'Escape', 27);
        reporter.check(`${label}: Escape returns focus to browse`, await harness.evaluate("document.activeElement?.classList.contains('dossier-directory-toggle')"));
        await openPicker();
        for (let index = 0; index < 20; index += 1) {
          await navigationKey(harness, 'Tab', 9);
          reporter.check(`${label}: Tab stays in picker ${index + 1}`, await harness.evaluate("document.querySelector('#recipe-drawer').contains(document.activeElement)"));
        }
        await navigationTabTo(harness, '.recipe-directory-close');
        await navigationKey(harness, 'Tab', 9, 8);
        reporter.check(`${label}: Shift+Tab wraps inside picker`, await harness.evaluate("document.querySelector('#recipe-drawer').contains(document.activeElement) && !document.activeElement.matches('.recipe-directory-close')"));
        await navigationPointer(harness, '.recipe-directory-close');
        reporter.check(`${label}: close returns focus to browse`, await harness.evaluate("document.activeElement?.classList.contains('dossier-directory-toggle')"));
      }
    }
    const groupOrder = ['discover', 'prepare', 'publish-grant', 'exercise', 'observe', 'policy', 'lifecycle'];
    const rowsByGroup = {
      discover: ['azure-context-check', 'apim-discovery'],
      prepare: ['foundry-enable-a2a', 'apim-foundry-grant', 'weather-api-ensure'],
      exercise: ['weather-mcp-discovery', 'learn-mcp-discovery', 'a2a-agent-card', 'a2a-message-send', 'agent-framework-hr-question', 'weather-tools-call'],
      lifecycle: ['cleanup'],
    };
    for (const viewport of [
      { width: 660, height: 800 },
      { width: 390, height: 844, mobile: true },
      { width: 320, height: 480, mobile: true },
    ]) {
      await harness.setViewport(viewport);
      for (const mode of ['discover', 'exercise', 'lifecycle', 'lifecycle-closed', 'all-collapsed', 'search', 'eligibility']) {
        await navigateToRecipe(harness, mode.startsWith('lifecycle') ? 'cleanup' : 'azure-context-check', 'account-target', { previewOnly: true });
        await openPicker();
        let openGroup = mode === 'eligibility' ? 'exercise' : mode === 'lifecycle-closed' ? 'prepare' : mode;
        if (rowsByGroup[openGroup]) await navigationGroup(harness, openGroup);
        if (mode === 'all-collapsed') await navigationPointer(harness, '#recipe-group-discover');
        if (mode === 'search') {
          await navigationPointer(harness, '#recipe-directory-search');
          await harness.page.send('Input.insertText', { text: 'weather' });
          await settle(harness);
        }
        if (mode === 'eligibility') {
          await harness.evaluate(`(() => {
            document.getElementById('recipe-link-weather-mcp-discovery').hidden = true;
            document.getElementById('recipe-link-learn-mcp-discovery').setAttribute('inert', '');
            document.getElementById('recipe-link-a2a-agent-card').disabled = true;
            document.getElementById('recipe-link-a2a-message-send').style.visibility = 'hidden';
            const nested = document.createElement('details');
            const summary = document.createElement('summary');
            summary.id = 'hidden-nested-summary';
            summary.tabIndex = 0;
            summary.textContent = 'Not a visible group heading';
            nested.append(summary);
            document.querySelector('[data-group-id="lifecycle"] ul').append(nested);
          })()`);
        }
        const groups = mode === 'search' ? ['prepare', 'exercise'] : groupOrder;
        const expected = ['close', 'recipe-directory-search'];
        for (const group of groups) {
          expected.push(`recipe-group-${group}`);
          const rows = mode === 'search'
            ? (group === 'prepare' ? ['weather-api-ensure'] : ['weather-mcp-discovery', 'weather-tools-call'])
            : group === openGroup ? rowsByGroup[group] : [];
          for (const id of rows ?? []) {
            if (mode === 'eligibility' && rowsByGroup.exercise.slice(0, 4).includes(id)) continue;
            expected.push(`recipe-link-${id}`);
          }
        }
        const label = `${viewport.width}x${viewport.height}-${mode}-focus`;
        const cycle = await navigationFocusCycle(harness, expected);
        focusCycles.push({ label, ...cycle });
        reporter.check(`${label}: exact visible forward Tab cycle`, cycle.wrapsForward, JSON.stringify(cycle.forward));
        reporter.check(`${label}: exact visible reverse Tab cycle`, cycle.wrapsBackward, JSON.stringify(cycle.backward));
        if (viewport.width === 320) await record(label);
        await navigationKey(harness, 'Escape', 27);
        reporter.check(`${label}: Escape closes and returns focus`, await harness.evaluate("document.querySelector('#recipe-drawer').dataset.open === 'false' && document.activeElement.matches('.dossier-directory-toggle')"));
        await openPicker();
        await navigationPointer(harness, '.recipe-directory-close');
        reporter.check(`${label}: Close returns focus`, await harness.evaluate("document.querySelector('#recipe-drawer').dataset.open === 'false' && document.activeElement.matches('.dossier-directory-toggle')"));
      }
    }
    await harness.setViewport({ width: 1440, height: 900 });
    await navigateToRecipe(harness, 'cleanup', 'account-target', { previewOnly: true });
    await navigationPointer(harness, '#recipe-group-prepare');
    reporter.check('collapsed current group still identifies Cleanup', await harness.evaluate(`(() => {
      const group = document.querySelector('[data-current-group="true"]');
      return group?.dataset.groupId === 'lifecycle' && !group.open &&
        group.querySelector('summary').getAttribute('aria-describedby') &&
        group.querySelector('.visually-hidden').textContent.includes('Cleanup');
    })()`));
    await navigationPointer(harness, '#recipe-directory-search');
    await harness.page.send('Input.insertText', { text: 'weat' });
    await settle(harness);
    await harness.page.send('Input.insertText', { text: 'her' });
    await settle(harness);
    reporter.check('continued search typing keeps focus and caret', await harness.evaluate(`(() => {
      const n=document.activeElement;return n?.id==='recipe-directory-search' && n.value==='weather' && n.selectionStart===7;
    })()`));
    reporter.check('search opens matching recipes across collapsed groups', await harness.evaluate(`(() => {
      const n=document.querySelector('[data-recipe-id="weather-tools-call"]');
      return n && !n.closest('details:not([open])') && document.querySelectorAll('.recipe-directory-group[open]').length > 1;
    })()`));
    await navigationKey(harness, 'ArrowLeft', 37);
    await navigationKey(harness, 'ArrowLeft', 37);
    await harness.page.send('Input.insertText', { text: 'x' });
    await settle(harness);
    reporter.check('mid-string search editing retains caret and offers recovery', await harness.evaluate(`(() => {
      const n=document.activeElement;return n?.value==='weathxer' && n.selectionStart===6 &&
        document.querySelector('.recipe-directory-empty button')?.textContent==='Clear search';
    })()`));
    await navigationPointer(harness, '.recipe-directory-empty button');
    reporter.check('clear restores browse group without stealing search focus', await harness.evaluate(`(() => {
      const n=document.activeElement;return n?.id==='recipe-directory-search' && n.value==='' && n.selectionStart===0 &&
        document.querySelector('.recipe-directory-group[open]')?.dataset.groupId==='prepare';
    })()`));
    for (const [group, recipe] of [['exercise', 'weather-tools-call'], ['publish-grant', 'publish-assets'], ['lifecycle', 'cleanup']]) {
      await navigationTabTo(harness, `#recipe-group-${group}`);
      await navigationKey(harness, 'Enter', 13);
      await navigationTabTo(harness, `[data-recipe-id="${recipe}"]`);
      await navigationKey(harness, 'Enter', 13);
      await harness.waitFor(`new URL(location.href).searchParams.get('recipe') === '${recipe}'`);
      reporter.check(`keyboard selects ${recipe}`, (await navigationSnapshot(harness)).selectedVisible);
    }
    await navigationPointer(harness, '#recipe-group-lifecycle');
    reporter.equal('all groups can be collapsed', (await navigationSnapshot(harness)).openGroups.length, 0);
    await harness.evaluate("globalThis.__citadelTestHooks.installContext(null, 'unavailable')");
    await settle(harness);
    reporter.check('a background render retains focus on a collapsed group heading', await harness.evaluate("document.activeElement?.id === 'recipe-group-lifecycle' && !document.activeElement.parentElement.open"));
    await navigationKey(harness, ' ', 32);
    reporter.equal('Space reopens a native group', (await navigationSnapshot(harness)).openGroups[0], 'lifecycle');
    for (const [query, recipe] of [['weather tools/call', 'weather-tools-call'], ['publish assets', 'publish-assets'], ['cleanup', 'cleanup']]) {
      await navigationPointer(harness, '#recipe-directory-search');
      await harness.page.send('Input.insertText', { text: query });
      await settle(harness);
      await navigationPointer(harness, `[data-recipe-id="${recipe}"]`);
      await harness.waitFor(`new URL(location.href).searchParams.get('recipe') === '${recipe}'`);
      reporter.check(`search selects ${recipe} and clears query`, await harness.evaluate("document.querySelector('#recipe-directory-search').value === ''"));
    }
    await harness.setViewport({ width: 660, height: 800 });
    await settle(harness);
    await openPicker();
    await navigationPointer(harness, '#recipe-group-exercise');
    await harness.setViewport({ width: 700, height: 800 });
    await settle(harness);
    reporter.check('same-breakpoint resize preserves open picker and browse group', await harness.evaluate("document.querySelector('#recipe-drawer').dataset.open === 'true' && document.querySelector('[data-group-id=\"exercise\"]').open"));
    await harness.setViewport({ width: 1440, height: 900 });
    await settle(harness);
    reporter.check('modal becomes a usable rail without inert workspace or lost browse group', await harness.evaluate("!document.querySelector('#recipe-drawer').hasAttribute('aria-modal') && !document.querySelector('#run-dossier').hasAttribute('inert') && document.querySelector('[data-group-id=\"exercise\"]').open"));

    await navigateToRecipe(harness, 'azure-context-check', 'account-target', { previewOnly: true });
    await navigationPointer(harness, '#f-hub-subscriptionId');
    await harness.page.send('Input.insertText', { text: 'draft-subscription' });
    await navigationKey(harness, 'Tab', 9);
    let dialogCount = 0;
    const removeDialog = harness.page.on('Page.javascriptDialogOpening', () => {
      dialogCount += 1;
      void harness.page.send('Page.handleJavaScriptDialog', { accept: false });
    });
    await navigationPointer(harness, '#recipe-group-publish-grant');
    await navigationPointer(harness, '[data-recipe-id="publish-assets"]');
    reporter.check('dirty-input cancellation preserves recipe, URL and draft', dialogCount === 1 && await harness.evaluate("new URL(location.href).searchParams.get('recipe') === 'azure-context-check' && document.querySelector('#f-hub-subscriptionId').value === 'draft-subscription'"));
    removeDialog();
    await harness.evaluate("window.confirm = () => true");
    await choose('publish-grant', 'publish-assets');
    reporter.check('accepted dirty navigation selects the new recipe', (await navigationSnapshot(harness)).selectedVisible);
    const history = await crossRecipeHistorySnapshot(harness);
    reporter.check('history restores recipe, wizard position and expanded group', history.href === history.expectedHref && await harness.evaluate("document.querySelector('[data-group-id=\"publish-grant\"]').open"));
    await harness.setViewport({ width: 390, height: 844, mobile: true });
    await settle(harness);
    const activeRun = await activeRunIsolationSnapshot(harness);
    reporter.check('active run blocks pointer and history navigation and cancels once', activeRun.recipeId === 'publish-assets' && activeRun.step === 'run-result' && activeRun.recipeDisabled && activeRun.cancelCalls === 1 && !activeRun.foreignProgressVisible, JSON.stringify(activeRun));
    reportIssues(reporter, 'navigation attempted no live request', nonLoopbackRequestIssues(guard.requests, harness.baseUrl));
    reporter.check('navigation has no browser errors', harness.pageErrors.length === 0, harness.pageErrors.join('; '));
  } finally {
    await writeFile(resolve(output, 'navigation-after.json'), JSON.stringify({ snapshots, pickerOpenings, focusCycles, checks: reporter.results }, null, 2));
    await guard?.close();
    await harness.close();
  }
  if (!reporter.finish().ok) process.exitCode = 1;
}

async function main() {
  if (process.argv.includes('--navigation-only')) return runNavigationAcceptance();
  const reporter = createCheckReporter({ name: 'wizard browser acceptance' });
  await prepareArtifacts();
  const harness = await launchBrowserHarness({
    browserPath: argumentValue('--chrome'),
    createServer: ({ port, testBootstrapCapability }) =>
      createPlaygroundServer({
        port,
        mode: 'preview',
        publicOrigin: null,
        testBootstrapCapability,
      }),
    path: '/?testExecutor',
  });
  let guard;
  try {
    await waitForWizard(harness, 'azure-context-check');
    guard = await installRequestGuard(harness);

    await runWorkspaceComposition(harness, reporter);
    if (process.argv.includes('--workspace-only')) {
      reportIssues(reporter, 'workspace attempted no live request', nonLoopbackRequestIssues(guard.requests, harness.baseUrl));
      reporter.check('workspace has no browser errors', harness.pageErrors.length === 0, harness.pageErrors.join('; '));
      if (!reporter.finish().ok) process.exitCode = 1;
      return;
    }
    await navigateToRecipe(harness, 'publish-assets');
    const validation = await validationFocusSnapshot(harness);
    reporter.check(
      'Continue validates the current step and focuses its first invalid field',
      validation.before === validation.after &&
        validation.invalid &&
        validation.activePath.length > 0 &&
        validation.activeVisible,
      JSON.stringify(validation),
    );

    const lowerValidation = await lowerFieldValidationFocusSnapshot(harness);
    reporter.check(
      'Continue scrolls a lower invalid Publish Assets field above the action dock',
      lowerValidation.before === lowerValidation.after &&
        lowerValidation.invalid &&
        lowerValidation.activePath === 'hub.location' &&
        lowerValidation.activeVisible &&
        lowerValidation.workspaceScrollTop > 0,
      JSON.stringify(lowerValidation),
    );

    const stepNavigation = await stepNavigationSnapshot(harness);
    reporter.check(
      'input-step navigation focuses a visible heading in the workspace viewport',
      stepNavigation.advanced &&
        stepNavigation.step === 'required-inputs' &&
        stepNavigation.activeId === 'wizard-step-title' &&
        stepNavigation.headingVisible,
      JSON.stringify(stepNavigation),
    );

    const simpleRecipe = await simpleRecipeScrollSnapshot(harness);
    reporter.check(
      'a simple desktop recipe retains one scroll workspace for its secondary details',
      /(auto|scroll)/.test(simpleRecipe.overflowY) && simpleRecipe.clientHeight > 600,
      JSON.stringify(simpleRecipe),
    );

    const longAction = await longActionLabelSnapshot(harness);
    reporter.check(
      'a long valid target name wraps inside the 320px action dock without overflow',
      longAction.reachedReview &&
        longAction.targetPresent &&
        longAction.documentWidth <= longAction.viewportWidth + 1 &&
        longAction.shellScrollWidth <= longAction.shellClientWidth + 1 &&
        longAction.actionScrollWidth <= longAction.actionClientWidth + 1 &&
        longAction.buttonScrollWidth <= longAction.buttonClientWidth + 1 &&
        longAction.actionVisible &&
        longAction.buttonVisible &&
        longAction.buttonWhiteSpace === 'normal',
      JSON.stringify(longAction),
    );

    const compactLandscape = await compactLandscapeSnapshot(harness);
    reporter.check(
      'compact landscape preserves a usable scroll workspace above the action dock',
      compactLandscape.viewport.documentWidth <= compactLandscape.viewport.viewportWidth + 1 &&
        compactLandscape.viewport.documentScrollHeight <= compactLandscape.viewport.documentClientHeight + 1 &&
        compactLandscape.viewport.mainClientHeight >= 64 &&
        compactLandscape.viewport.mainScrollHeight > compactLandscape.viewport.mainClientHeight + 1 &&
        compactLandscape.reachability.found &&
        compactLandscape.reachability.targetVisible &&
        compactLandscape.reachability.lastVisible &&
        compactLandscape.reachability.actionVisibleAfter,
      JSON.stringify(compactLandscape),
    );

    const compactPhoneLandscape = await compactPhoneLandscapeSnapshot(harness);
    reporter.check(
      'narrow compact landscape preserves a usable scroll workspace above the action dock',
      compactPhoneLandscape.viewport.documentWidth <= compactPhoneLandscape.viewport.viewportWidth + 1 &&
        compactPhoneLandscape.viewport.documentScrollHeight <= compactPhoneLandscape.viewport.documentClientHeight + 1 &&
        compactPhoneLandscape.viewport.mainClientHeight >= 64 &&
        compactPhoneLandscape.viewport.mainScrollHeight > compactPhoneLandscape.viewport.mainClientHeight + 1 &&
        compactPhoneLandscape.reachability.found &&
        compactPhoneLandscape.reachability.targetVisible &&
        compactPhoneLandscape.reachability.lastVisible &&
        compactPhoneLandscape.reachability.actionVisibleAfter,
      JSON.stringify(compactPhoneLandscape),
    );

    await navigateToRecipe(harness, 'weather-mcp-discovery');
    const gatewayWizard = await wizardSnapshot(harness);
    reporter.equal('gateway recipes skip unused input and low-risk review steps', gatewayWizard.stepCount, 3);

    await navigateToRecipe(harness, 'publish-assets');
    reporter.check('Publish Assets can reach its approval step', await preparePublishReview(harness));
    const invalidation = await approvalInvalidationSnapshot(harness);
    reporter.check(
      'input changes invalidate approval while preserving the review decision surface',
      invalidation.acknowledgementInitiallySet &&
        !invalidation.acknowledgementNowSet &&
        invalidation.step === 'review-approve',
      JSON.stringify(invalidation),
    );

    const acknowledgementGate = await acknowledgementGateSnapshot(harness);
    reporter.check(
      'state-changing Run remains disabled until its one-run acknowledgement is set',
      acknowledgementGate.reachedReview &&
        acknowledgementGate.acknowledgementPresent &&
        acknowledgementGate.runDisabled &&
        acknowledgementGate.runEnabledAfterAcknowledgement,
      JSON.stringify(acknowledgementGate),
    );

    const contextLoss = await contextLossInvalidationSnapshot(harness);
    reporter.check(
      'loss of the verified execution context invalidates approval',
      contextLoss.reachedReview &&
        contextLoss.acknowledgementInitiallySet &&
        !contextLoss.acknowledgementNowSet &&
        contextLoss.step === 'review-approve',
      JSON.stringify(contextLoss),
    );

    const invalidValue = await invalidValueFocusSnapshot(harness);
    reporter.check(
      'Continue blocks populated but malformed values and focuses the invalid field',
      invalidValue.before === invalidValue.after &&
        invalidValue.invalid &&
        invalidValue.activePath === 'hub.subscriptionId' &&
        invalidValue.activeVisible,
      JSON.stringify(invalidValue),
    );

    const hostedGateway = await hostedGatewaySnapshot(harness);
    reporter.check(
      'hosted gateway recipes use the relay identity chain and no browser gateway key',
      hostedGateway.title.includes('Hosted execution context') &&
        hostedGateway.identityKind === 'hosted-relay' &&
        hostedGateway.hostedPath &&
        !hostedGateway.gatewayKeyField &&
        !hostedGateway.azureAccountControls,
      JSON.stringify(hostedGateway),
    );

    const history = await crossRecipeHistorySnapshot(harness);
    reporter.check(
      'browser history restores the completed step for a previously visited recipe',
      history.step === 'review-approve' && history.href === history.expectedHref,
      JSON.stringify(history),
    );

    const cleanupNoDelete = await cleanupNoDeleteRunSnapshot(harness);
    reporter.check(
      'cleanup with every deletion switch off skips review, runs, and returns Back to setup',
      cleanupNoDelete.ready &&
        cleanupNoDelete.before?.hasReviewStep === false &&
        cleanupNoDelete.before?.operationPreview === true &&
        cleanupNoDelete.before?.action === 'Run Check' &&
        cleanupNoDelete.result?.step === 'run-result' &&
        cleanupNoDelete.result?.output.includes('Loopback wizard acceptance completed.') &&
        ['account-target', 'required-inputs', 'credentials-options'].includes(cleanupNoDelete.backStep),
      JSON.stringify(cleanupNoDelete),
    );

    await navigateToRecipe(harness, 'cleanup');
    reporter.check('Cleanup can reach its risk decision step', await prepareCleanupReview(harness));
    const destructive = await destructiveDialogSnapshot(harness);
    reporter.check(
      'destructive confirmation owns focus, repeats context, closes with Escape, and returns focus',
      destructive.opened &&
        destructive.focusInside &&
        destructive.footerVisible &&
        /apim-wizard-acceptance|DELETE/i.test(destructive.text) &&
        destructive.focusReturned,
      JSON.stringify(destructive),
    );

    const secret = await secretSnapshot(harness);
    reporter.check(
      'memory-only credentials never appear in text, markup, attributes, or browser storage',
      secret.controlType === 'password' &&
        secret.controlHasValue &&
        secret.controlIdentityPreserved &&
        !secret.textLeak &&
        !secret.markupLeak &&
        !secret.attributeLeak &&
        !secret.browserPersistentLeak &&
        !secret.browserSessionLeak,
      JSON.stringify(secret),
    );

    const typing = await typingContinuitySnapshot(harness);
    reporter.check(
      'typing preserves the active control, caret, and value without whole-page re-render',
      typing.found &&
        typing.active &&
        typing.identityPreserved &&
        typing.selectionStart === 29 &&
        typing.value === 'x-gateway-operator-acceptance-header',
      JSON.stringify(typing),
    );

    const gatewayKeyNavigation = await gatewayKeyNavigationSnapshot(harness);
    reporter.check(
      'Edit connection returns to Gateway connection and focuses the masked control',
      gatewayKeyNavigation.readyToRun &&
        gatewayKeyNavigation.clicked &&
        gatewayKeyNavigation.step === 'account-target' &&
        gatewayKeyNavigation.activePath === 'gatewayAccess.apiKey' &&
        gatewayKeyNavigation.activeType === 'password',
      JSON.stringify(gatewayKeyNavigation),
    );

    await navigateToRecipe(harness, 'publish-assets', 'review-approve');
    reporter.equal(
      'a valid wizard step is restored from the URL',
      await harness.evaluate("document.querySelector('[data-wizard-step]')?.dataset.wizardStep"),
      'review-approve',
    );

    const destructiveInvalidation = await destructiveInvalidationSnapshot(harness);
    reporter.check(
      'approval-affecting changes close and discard an open destructive confirmation',
      destructiveInvalidation.reachedReview &&
        destructiveInvalidation.opened &&
        !destructiveInvalidation.dialogStillPresent &&
        destructiveInvalidation.step === 'review-approve' &&
        !destructiveInvalidation.acknowledgement,
      JSON.stringify(destructiveInvalidation),
    );

    const activeRun = await activeRunIsolationSnapshot(harness);
    reporter.check(
      'an active run locks recipe/history navigation, ignores foreign progress, and cancels once',
      activeRun.recipeId === 'publish-assets' &&
        activeRun.step === 'run-result' &&
        activeRun.recipeDisabled &&
        !activeRun.foreignProgressVisible &&
        activeRun.cancelClicked &&
        activeRun.cancelCalls === 1 &&
        activeRun.actionText !== 'Cancel Run',
      JSON.stringify(activeRun),
    );

    if (!process.argv.includes('--regressions-only')) {
      const requestedScenario = argumentValue('--scenario');
      const scenarios = requestedScenario
        ? DOSSIER_ACCEPTANCE_SCENARIOS.filter((scenario) => scenario.name === requestedScenario)
        : DOSSIER_ACCEPTANCE_SCENARIOS;
      for (const scenario of scenarios) {
        await runScenario(harness, reporter, scenario);
      }
    }

    const malformedUrl = await malformedWizardUrlSnapshot(harness);
    reporter.check(
      'a malformed wizard step fails closed without breaking startup',
      malformedUrl.step === 'account-target' && malformedUrl.hash === '#step=account-target',
      JSON.stringify(malformedUrl),
    );

    const blurRerender = await blurRerenderSnapshot(harness);
    reporter.check(
      'tabbing after a field edit preserves workspace scroll and visible keyboard focus',
      blurRerender.before.ready &&
        blurRerender.before.scrollTop > 0 &&
        blurRerender.scrollTop > 0 &&
        blurRerender.activeTag !== 'BODY' &&
        blurRerender.activeId === 'f-hub-resourceGroupName-help-toggle' &&
        blurRerender.activeInsideWorkspace &&
        blurRerender.activeVisible,
      JSON.stringify(blurRerender),
    );

    reportIssues(
      reporter,
      'the browser attempted no Azure or live request',
      [
        ...nonLoopbackRequestIssues(guard.requests, harness.baseUrl),
        ...guard.blocked.map((url) => `blocked external request: ${url}`),
      ],
    );
    const unexpectedPageErrors = harness.pageErrors.filter(
      (error) => !String(error).startsWith("Blocked attempt to show a 'beforeunload' confirmation panel"),
    );
    reporter.check(
      'the page reported no uncaught browser errors',
      unexpectedPageErrors.length === 0,
      unexpectedPageErrors.join('; '),
    );
  } finally {
    await guard?.close();
    await harness.close();
  }

  await checkSystemAzureIdentityControls(reporter);
  await checkHostedRelayReadiness(reporter);
  const outcome = reporter.finish();
  if (!outcome.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
