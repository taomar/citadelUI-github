#!/usr/bin/env node
/**
 * Browser acceptance for the per-recipe Citadel run wizard.
 *
 * The runner uses only the loopback preview server and the explicit test
 * executor seam. Every non-loopback request is blocked.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPlaygroundServer } from '../server.mjs';
import { createExecutionContextManager } from '../src/server/executionContextManager.mjs';
import { createCheckReporter, launchBrowserHarness } from './browser-harness.mjs';

const ARTIFACT_DIRECTORY = fileURLToPath(new URL('../.artifacts/dossier/', import.meta.url));
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
    width: 1440,
    height: 900,
    mobile: false,
    breakpoint: 'desktop',
  }),
  Object.freeze({
    order: 5,
    name: 'publish-assets-tablet',
    recipeId: 'publish-assets',
    width: 768,
    height: 800,
    mobile: false,
    breakpoint: 'tablet',
  }),
  Object.freeze({
    order: 6,
    name: 'publish-assets-phone',
    recipeId: 'publish-assets',
    width: 390,
    height: 844,
    mobile: true,
    breakpoint: 'phone',
  }),
  Object.freeze({
    order: 7,
    name: 'publish-assets-phone-small',
    recipeId: 'publish-assets',
    width: 320,
    height: 480,
    mobile: true,
    breakpoint: 'phone',
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
    name: 'offline-diagnostics',
    recipeId: 'azure-context-check',
    width: 820,
    height: 800,
    mobile: false,
    breakpoint: 'tablet',
    openDiagnostics: true,
  }),
  Object.freeze({
    order: 14,
    name: 'reduced-motion',
    recipeId: 'publish-assets',
    width: 820,
    height: 800,
    mobile: false,
    breakpoint: 'tablet',
    reducedMotion: true,
  }),
  Object.freeze({
    order: 15,
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
  if (!['sticky', 'fixed'].includes(snapshot.actionBarPosition)) issues.push('wizard action bar is not sticky or fixed');
  if (snapshot.primaryActionCount !== 1) issues.push(`expected one primary page action, got ${snapshot.primaryActionCount}`);

  if (scenario.breakpoint === 'desktop') {
    if (!snapshot.directoryVisible || snapshot.drawerControlVisible) {
      issues.push('desktop must expose the recipe rail without a duplicate drawer control');
    }
    if (!snapshot.stepNavVisible || snapshot.stepSelectorVisible) {
      issues.push('desktop must use the left wizard step navigation');
    }
    if (snapshot.minimumControlHeight < 39.5) {
      issues.push(`desktop controls are only ${snapshot.minimumControlHeight}px high`);
    }
  } else {
    if (snapshot.directoryVisible || !snapshot.drawerControlVisible) {
      issues.push('compact layouts must replace the recipe rail with one picker control');
    }
    if (snapshot.stepNavVisible || !snapshot.stepSelectorVisible) {
      issues.push('compact layouts must use the current-step selector');
    }
    if (snapshot.actionBarPosition !== 'fixed') issues.push('compact wizard action bar is not fixed');
    if (!snapshot.safeAreaRule) issues.push('compact action bar has no safe-area inset rule');
    if (['phone', 'zoom'].includes(scenario.breakpoint) && snapshot.minimumControlHeight < 43.5) {
      issues.push(`mobile controls are only ${snapshot.minimumControlHeight}px high`);
    }
    if (['phone', 'zoom'].includes(scenario.breakpoint) && snapshot.contextHorizontalOverflow) {
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

async function navigateToRecipe(harness, recipeId, stepId = 'account-target') {
  await harness.evaluate("globalThis.__dossierNavigationMarker = 'pending'");
  const url = new URL(harness.baseUrl);
  url.searchParams.set('testExecutor', '');
  url.searchParams.set('recipe', recipeId);
  url.hash = `step=${stepId}`;
  await harness.page.send('Page.navigate', { url: url.href });
  await harness.waitFor(
    "globalThis.__dossierNavigationMarker !== 'pending'",
    { timeoutMs: 30_000, label: `${recipeId} document navigation` },
  );
  await waitForWizard(harness, recipeId);
  await installTestExecutor(harness);
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
  const clicked = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('#wizard-action-bar button')]
      .find((candidate) => candidate.textContent.trim() === 'Continue');
    button?.click();
    return Boolean(button);
  })()`);
  if (!clicked) return false;
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
  return true;
}

async function prepareCleanupReview(harness) {
  await setValues(harness, {
    'hub.subscriptionId': '00000000-1111-2222-3333-444444444444',
    'hub.resourceGroupName': 'rg-wizard-acceptance',
    'hub.apimName': 'apim-wizard-acceptance',
    'samples.cleanup.confirmNonProduction': true,
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
      stepProgress: document.querySelector('.dossier-stage-progress > span')?.textContent.trim() ?? '',
      stepCount: document.querySelectorAll('.wizard-step-link').length,
      wizardCount: document.querySelectorAll('.recipe-wizard').length,
      currentStepCount: document.querySelectorAll('[data-wizard-step]').length,
      topLevelTabs: [...document.querySelectorAll('[role="tab"]')]
        .filter((tab) => !document.getElementById('dossier-output')?.contains(tab)).length,
      identityKind: document.querySelector('.execution-context-bar')?.dataset.identityKind ?? '',
      azureAccountControls: /Sign in with Microsoft|Switch Azure account|Account \\/ subscription|Set Active/
        .test(document.body.textContent ?? ''),
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
    const directory = document.getElementById('recipe-directory');
    const drawerControl = document.querySelector('.dossier-directory-toggle');
    const stepNav = document.querySelector('.wizard-step-nav');
    const stepSelector = document.querySelector('.dossier-stage-progress select');
    const actionBar = document.getElementById('wizard-action-bar');
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
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      shellWidth: shell?.scrollWidth ?? 0,
      mastheadScrollWidth: masthead?.scrollWidth ?? 0,
      mastheadClientWidth: masthead?.clientWidth ?? 0,
      clippedMastheadControls: clippedMastheadControlLabels.length,
      clippedMastheadControlLabels,
      contextHorizontalOverflow:
        Boolean(contextGrid) && contextGrid.scrollWidth > contextGrid.clientWidth + 1,
      nestedFormScrollers,
      visibleStepContents: [...document.querySelectorAll('.wizard-step-content')].filter(visible).length,
      directoryVisible: visible(directory),
      drawerControlVisible: visible(drawerControl),
      stepNavVisible: visible(stepNav),
      stepSelectorVisible: visible(stepSelector),
      actionBarPosition: actionBar ? getComputedStyle(actionBar).position : '',
      primaryActionCount: [...document.querySelectorAll('#wizard-action-bar .btn-primary')].filter(visible).length,
      safeAreaRule,
      minimumControlHeight: controls.length
        ? Math.min(...controls.map((element) => element.getBoundingClientRect().height))
        : 0,
    };
  })()`);
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
  await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('#wizard-action-bar button')]
      .find((candidate) => candidate.textContent.trim() === 'Continue');
    button?.click();
    return true;
  })()`);
  await settle(harness);
  return harness.evaluate(`(() => ({
    before: ${JSON.stringify(before)},
    after: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
    activePath: document.activeElement?.closest('[data-parameter-path]')?.dataset.parameterPath ?? '',
    invalid: document.activeElement?.getAttribute('aria-invalid') === 'true',
  }))()`);
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
      .find((candidate) => /^Run sample/.test(candidate.textContent.trim()));
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
        .find((candidate) => /^Run sample/.test(candidate.textContent.trim()));
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
    title: document.getElementById('wizard-step-title')?.textContent ?? '',
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
  await harness.evaluate(`(() => {
    window.confirm = () => true;
    const item = document.querySelector(
      '.recipe-directory-item[data-recipe-id="weather-mcp-discovery"]'
    );
    item?.click();
    return Boolean(item);
  })()`);
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
  const opened = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('#wizard-action-bar button')]
      .find((candidate) => /^Run sample/.test(candidate.textContent.trim()));
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
    return {
      opened: dialog?.open === true,
      focusInside: dialog?.contains(document.activeElement) === true,
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
  return harness.evaluate(`(async () => {
    const row = [...document.querySelectorAll('[data-parameter-path]')]
      .find((candidate) => candidate.dataset.parameterPath === 'hub.gatewayUrl');
    const control = row?.querySelector('input');
    if (!control) return { found: false };
    control.dataset.acceptanceIdentity = 'gateway-url-control';
    control.focus();
    control.value = 'https://gateway.example.test/very/long/operator/path';
    control.setSelectionRange(29, 29);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      found: true,
      value: control.value,
      active: document.activeElement === control,
      selectionStart: control.selectionStart,
      identityPreserved: control.dataset.acceptanceIdentity === 'gateway-url-control',
    };
  })()`);
}

async function gatewayKeyNavigationSnapshot(harness) {
  await navigateToRecipe(harness, 'weather-mcp-discovery');
  await setValues(harness, {
    'hub.gatewayUrl': 'https://gateway.example.test',
    'gatewayAccess.apiKey': SECRET,
  });
  if (!(await advanceToReview(harness))) return { reachedReview: false };
  const clicked = await harness.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim() === 'Manage gateway key');
    button?.click();
    return Boolean(button);
  })()`);
  if (!clicked) return { reachedReview: true, clicked: false };
  await harness.waitFor(
    "document.querySelector('[data-wizard-step]')?.dataset.wizardStep === 'account-target'",
    { label: 'Gateway connection after Manage gateway key' },
  );
  await settle(harness);
  return harness.evaluate(`(() => ({
    reachedReview: true,
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
      .find((candidate) => /^Run sample/.test(candidate.textContent.trim()));
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
      .find((candidate) => /^Run sample/.test(candidate.textContent.trim()));
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
  await harness.evaluate(`(() => {
    document.querySelector('.recipe-directory-item[data-recipe-id="weather-mcp-discovery"]')?.click();
    history.back();
    return true;
  })()`);
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
      .find((candidate) => candidate.textContent.trim() === 'Cancel run');
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
    reporter.check(`${scenario.name}: reached Review & approve`, await prepareCleanupReview(harness));
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

  if (!scenario.openSource && !scenario.openDiagnostics) {
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
      reporter.includes(`${scenario.name}: gateway step title is correct`, wizard.title, 'Gateway connection');
    }
    if (scenario.recipeId === 'apim-discovery') {
      reporter.includes(`${scenario.name}: Azure step title is correct`, wizard.title, 'Azure account & target');
      reporter.check(
        `${scenario.name}: unsupported browser login fails closed to terminal handoff`,
        wizard.terminalFallback && !wizard.azureAccountControls,
        JSON.stringify(wizard),
      );
    }
  }

  if (!scenario.openSource && !scenario.openDiagnostics) {
    reportIssues(
      reporter,
      `${scenario.name}: responsive wizard contract`,
      viewportContractIssues(await viewportSnapshot(harness), scenario),
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

    await harness.evaluate("document.querySelector('.dossier-identity-action-primary')?.click()");
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
    await harness.evaluate(
      "[...document.querySelectorAll('.dossier-identity-action')].find((button) => button.textContent === 'Cancel sign-in')?.click()",
    );
    await harness.waitFor(
      "document.querySelector('.dossier-identity-action-primary')?.textContent === 'Switch Azure account'",
      { label: 'cancelled login recovery' },
    );

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
      'recipe navigation is locked while the shared Azure subscription changes',
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
      'subscription activation reconciles the wizard to the verified shared CLI default',
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

async function main() {
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

    await navigateToRecipe(harness, 'publish-assets');
    const validation = await validationFocusSnapshot(harness);
    reporter.check(
      'Continue validates the current step and focuses its first invalid field',
      validation.before === validation.after && validation.invalid && validation.activePath.length > 0,
      JSON.stringify(validation),
    );

    await navigateToRecipe(harness, 'weather-mcp-discovery');
    const gatewayWizard = await wizardSnapshot(harness);
    reporter.equal('gateway recipes dynamically skip the Required inputs step', gatewayWizard.stepCount, 4);

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
        invalidValue.activePath === 'hub.subscriptionId',
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

    await navigateToRecipe(harness, 'cleanup');
    reporter.check('Cleanup can reach its risk decision step', await prepareCleanupReview(harness));
    const destructive = await destructiveDialogSnapshot(harness);
    reporter.check(
      'destructive confirmation owns focus, repeats context, closes with Escape, and returns focus',
      destructive.opened &&
        destructive.focusInside &&
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
        typing.value === 'https://gateway.example.test/very/long/operator/path',
      JSON.stringify(typing),
    );

    const gatewayKeyNavigation = await gatewayKeyNavigationSnapshot(harness);
    reporter.check(
      'Manage gateway key returns to Gateway connection and focuses the masked control',
      gatewayKeyNavigation.reachedReview &&
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
        activeRun.actionText !== 'Cancel run',
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
