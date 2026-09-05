#!/usr/bin/env node
/**
 * Browser acceptance for the Signed Run Dossier integration.
 *
 * The runner starts the preview-only loopback server, enables the explicit
 * testExecutor seam, blocks every non-loopback request, and uses CDP directly.
 * It is expected to pass after the dossier renderers and stylesheet link are
 * integrated with the shared contract.
 *
 * Usage: node scripts/dossier-browser-acceptance.mjs [--chrome <path>]
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CATALOGUE } from '../src/catalogue/index.mjs';
import { createPlaygroundServer } from '../server.mjs';
import {
  DOSSIER_IDS,
  DOSSIER_OUTPUT_VIEWS,
  DOSSIER_STAGES,
  DOSSIER_URL,
} from '../web/js/render/dossier-contract.mjs';
import { createCheckReporter, launchBrowserHarness } from './browser-harness.mjs';

const ARTIFACT_DIRECTORY = fileURLToPath(new URL('../.artifacts/dossier/', import.meta.url));
const SECRET = 'DOSSIER-ACCEPTANCE-SECRET';
const SOURCE_CELL_SELECTOR =
  '[data-source-cell][data-cell-index][data-protected="true"][data-editable="false"]';
const BASE_DOSSIER_IDS = Object.freeze(
  Object.values(DOSSIER_IDS).filter((id) => id !== DOSSIER_IDS.destructiveDialog),
);

export const DOSSIER_ACCEPTANCE_SCENARIOS = Object.freeze([
  Object.freeze({ order: 1, name: 'desktop', width: 1440, height: 900, mobile: false, breakpoint: 'desktop' }),
  Object.freeze({ order: 2, name: 'tablet', width: 820, height: 800, mobile: false, breakpoint: 'tablet' }),
  Object.freeze({ order: 3, name: 'phone', width: 390, height: 844, mobile: true, breakpoint: 'phone' }),
  Object.freeze({ order: 4, name: 'phone-small', width: 320, height: 480, mobile: true, breakpoint: 'phone' }),
  Object.freeze({ order: 5, name: 'zoom-200-percent', width: 1280, height: 900, mobile: false, breakpoint: 'zoom' }),
  Object.freeze({ order: 6, name: 'reduced-motion', width: 820, height: 800, mobile: false, breakpoint: 'tablet' }),
  Object.freeze({ order: 7, name: 'forced-colors', width: 820, height: 800, mobile: false, breakpoint: 'tablet' }),
]);

export function dossierScreenshotName(scenario) {
  if (!scenario || !Number.isInteger(scenario.order) || !scenario.name) {
    throw new TypeError('A numbered dossier acceptance scenario is required.');
  }
  const prefix = String(scenario.order).padStart(2, '0');
  const size = scenario.name.includes('zoom') || scenario.name.includes('motion') || scenario.name.includes('colors')
    ? ''
    : `-${scenario.width}x${scenario.height}`;
  return `${prefix}-${scenario.name}${size}.png`;
}

export function dossierBreakpoint(width) {
  if (!Number.isFinite(width) || width <= 0) throw new TypeError('A positive viewport width is required.');
  if (width >= 1200) return 'desktop';
  if (width >= 768) return 'tablet';
  return 'phone';
}

export function semanticOrderIssues(actualIds) {
  const expected = [
    DOSSIER_IDS.context,
    DOSSIER_IDS.inputs,
    DOSSIER_IDS.review,
    DOSSIER_IDS.output,
  ];
  if (!Array.isArray(actualIds)) return ['semantic order must be an array'];
  return JSON.stringify(actualIds) === JSON.stringify(expected)
    ? []
    : [`primary dossier order must be ${expected.join(' -> ')}, got ${actualIds.join(' -> ')}`];
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
  const issues = [];
  if (!snapshot || typeof snapshot !== 'object') return ['viewport snapshot is required'];
  if (snapshot.documentWidth > snapshot.viewportWidth + 1) {
    issues.push(`document width ${snapshot.documentWidth} exceeds viewport ${snapshot.viewportWidth}`);
  }
  if (snapshot.shellWidth > snapshot.viewportWidth + 1) {
    issues.push(`dossier shell width ${snapshot.shellWidth} exceeds viewport ${snapshot.viewportWidth}`);
  }
  if (snapshot.nestedFormScrollers > 0) issues.push('the form contains a nested vertical scroller');
  if (snapshot.navigatorCount !== 1) issues.push(`expected one recipe navigator, got ${snapshot.navigatorCount}`);

  if (scenario.breakpoint === 'desktop') {
    if (!snapshot.directoryVisible || snapshot.drawerControlVisible) {
      issues.push('desktop must expose the rail and hide the drawer control');
    }
    if (snapshot.ledgerPosition !== 'sticky') issues.push('desktop ledger is not sticky');
    if (snapshot.ledgerWidth < 299 || snapshot.ledgerWidth > 321) {
      issues.push(`desktop ledger width ${snapshot.ledgerWidth} is outside 300-320px`);
    }
    if (snapshot.visiblePrimaryStages !== DOSSIER_STAGES.length) {
      issues.push('desktop does not expose the continuous four-stage dossier');
    }
  }

  if (scenario.breakpoint === 'tablet') {
    if (snapshot.directoryVisible || !snapshot.drawerControlVisible) {
      issues.push('tablet must replace the rail with the recipe drawer');
    }
    if (!snapshot.singleColumn) issues.push('tablet dossier is not a single column');
    if (!['sticky', 'fixed'].includes(snapshot.actionBarPosition)) {
      issues.push('tablet action bar is not sticky');
    }
  }

  if (scenario.breakpoint === 'phone') {
    if (snapshot.directoryVisible || !snapshot.drawerControlVisible) {
      issues.push('phone must replace the rail with the recipe picker');
    }
    if (!snapshot.stageProgressVisible || !/([1-4]\s*\/\s*4|stage\s+[1-4]\s+of\s+4)/i.test(snapshot.stageProgressText)) {
      issues.push('phone does not expose the stage n/4 affordance');
    }
    if (snapshot.visiblePrimaryStages !== 1) issues.push('phone must expose one primary stage at a time');
    if (!['sticky', 'fixed'].includes(snapshot.actionBarPosition)) {
      issues.push('phone bottom dock is not fixed or sticky');
    }
    if (snapshot.actionBarHeight < 55) issues.push(`phone bottom dock is only ${snapshot.actionBarHeight}px high`);
    if (!snapshot.safeAreaRule) issues.push('phone bottom dock has no safe-area inset rule');
    if (!snapshot.compactInspectorsClosed) issues.push('compact inspectors are not closed by default');
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

function currentScenario(name) {
  const scenario = DOSSIER_ACCEPTANCE_SCENARIOS.find((entry) => entry.name === name);
  if (!scenario) throw new Error(`Unknown dossier acceptance scenario ${name}.`);
  return scenario;
}

async function settle(harness) {
  await harness.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}

async function navigateToRecipe(harness, recipeId, stage = DOSSIER_STAGES[0]) {
  const url = new URL(harness.baseUrl);
  url.searchParams.set('testExecutor', '');
  url.searchParams.set(DOSSIER_URL.recipeParam, recipeId);
  url.hash = `${DOSSIER_URL.stageHashPrefix}${stage}`;
  await harness.page.send('Page.navigate', { url: url.href });
  await waitForDossier(harness);
  await harness.waitFor('Boolean(globalThis.__citadelTestHooks)', {
    label: 'the loopback-only dossier test executor seam',
  });
  await installTestExecutor(harness);
  await settle(harness);
}

async function waitForDossier(harness) {
  const ids = JSON.stringify(BASE_DOSSIER_IDS);
  await harness.waitFor(`(${ids}).every((id) => Boolean(document.getElementById(id)))`, {
    timeoutMs: 30_000,
    label: `the Signed Run Dossier IDs (${BASE_DOSSIER_IDS.join(', ')})`,
  });
}

async function installTestExecutor(harness) {
  await harness.evaluate(`(() => {
    const hooks = globalThis.__citadelTestHooks;
    if (!hooks) return false;
    hooks.installExecutor({
      describeCapability: () => ({
        id: 'dossier-acceptance',
        kind: 'local',
        canExecute: true,
        supportedStepTypes: [],
        reason: 'loopback-only acceptance executor'
      }),
      supports: () => ({ supported: true, unsupportedStepTypes: [] }),
      cancel: async () => ({ cancelled: false }),
      execute: async (_plan, context = {}) => {
        context.onProgress?.({
          type: 'run-start',
          runId: 'dossier-acceptance-0001',
          sampleId: 'cleanup',
          workspace: '.'
        });
        context.onProgress?.({
          type: 'step-progress',
          runId: 'dossier-acceptance-0001',
          step: { id: 'acceptance', state: 'completed', summary: 'Local test step completed.' }
        });
        return {
          state: 'completed',
          sampleId: 'cleanup',
          summary: 'Loopback dossier acceptance completed.',
          detail: '',
          steps: [],
          assertions: [],
          configurationUpdates: {},
          secretUpdates: {},
          meta: {
            executor: 'local',
            executionMode: 'local',
            runId: 'dossier-acceptance-0001',
            artifacts: [],
            azureContacted: false,
            liveEvidence: false
          }
        };
      }
    });
    return true;
  })()`);
}

async function installLoopbackRequestGuard(harness) {
  const requests = [];
  const blocked = [];
  const errors = [];
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
    if (!allowed) blocked.push(request.url);
    const method = allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest';
    const params = allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' };
    harness.page.send(method, params).catch((error) => errors.push(error.message));
  });
  try {
    await harness.page.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
  } catch (error) {
    removeListener?.();
    throw error;
  }
  return {
    requests,
    blocked,
    errors,
    async close() {
      removeListener?.();
      await harness.page.send('Fetch.disable').catch(() => {});
    },
  };
}

async function prepareArtifactDirectory() {
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

async function staticContractSnapshot(harness) {
  return harness.evaluate(`(() => {
    const ids = ${JSON.stringify([
      DOSSIER_IDS.context,
      DOSSIER_IDS.inputs,
      DOSSIER_IDS.review,
      DOSSIER_IDS.output,
    ])};
    const dossier = document.getElementById(${JSON.stringify(DOSSIER_IDS.dossier)});
    const output = document.getElementById(${JSON.stringify(DOSSIER_IDS.output)});
    const inspector = document.getElementById(${JSON.stringify(DOSSIER_IDS.sourceInspector)});
    const fields = [...document.querySelectorAll(
      '#${DOSSIER_IDS.inputs} input, #${DOSSIER_IDS.inputs} select, #${DOSSIER_IDS.inputs} textarea'
    )].filter((field) => field.type !== 'hidden').map((field) => {
      const escapedId = field.id && globalThis.CSS?.escape ? CSS.escape(field.id) : field.id;
      const explicitLabel = escapedId ? document.querySelector('label[for="' + escapedId + '"]') : null;
      return {
        id: field.id,
        name: field.getAttribute('name') ?? '',
        tag: field.tagName.toLowerCase(),
        autocomplete: field.getAttribute('autocomplete') ?? '',
        labelled: Boolean(
          explicitLabel ||
          field.closest('label') ||
          field.getAttribute('aria-label') ||
          field.getAttribute('aria-labelledby')
        ),
      };
    });
    const allTabs = [...document.querySelectorAll('[role="tab"]')];
    const tablists = [...document.querySelectorAll('[role="tablist"]')];
    const outputTabNames = allTabs.map((tab) =>
      tab.dataset.outputView || tab.getAttribute('aria-controls')?.replace(/^.*?(transcript|evidence|artifacts).*$/i, '$1') ||
      tab.textContent.trim().toLowerCase()
    );
    return {
      order: ids
        .map((id) => document.getElementById(id))
        .filter((node) => node && dossier?.contains(node))
        .sort((left, right) =>
          left === right ? 0 : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
        )
        .map((node) => node.id),
      topLevelTabs: allTabs.filter((tab) => !output?.contains(tab)).length,
      outputOnlyTabs:
        allTabs.every((tab) => output?.contains(tab)) &&
        tablists.every((tablist) => output?.contains(tablist)),
      outputTabNames,
      sourceInspectorSecondary:
        Boolean(inspector && dossier) &&
        !ids.some((id) => inspector.contains(document.getElementById(id))) &&
        Boolean(document.getElementById(${JSON.stringify(DOSSIER_IDS.output)})
          ?.compareDocumentPosition(inspector) & Node.DOCUMENT_POSITION_FOLLOWING),
      fields,
      roleLogCount: output?.querySelectorAll('[role="log"]').length ?? 0,
      deviceCodeContent:
        /device\\s*code|microsoft\\.com\\/devicelogin/i.test(document.body.textContent ?? '') ||
        Boolean(document.querySelector('[data-device-code], .device-code, #start-azure-login')),
    };
  })()`);
}

async function sourceImmutabilitySnapshot(harness, sampleId) {
  return harness.evaluate(`(async () => {
    const inspector = document.getElementById(${JSON.stringify(DOSSIER_IDS.sourceInspector)});
    let openedByAcceptance = false;
    let opener = null;
    if (inspector && inspector.getClientRects().length === 0) {
      opener = document.querySelector(
        '[aria-controls="${DOSSIER_IDS.sourceInspector}"],' +
        '[popovertarget="${DOSSIER_IDS.sourceInspector}"],' +
        '[commandfor="${DOSSIER_IDS.sourceInspector}"],' +
        '[data-open-inspector="source"]'
      );
      opener?.click();
      openedByAcceptance = Boolean(opener);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    const response = await fetch('/api/source/${encodeURIComponent(sampleId)}');
    const payload = await response.json();
    const expectedCells = payload.cells.map((cell) => ({
      index: String(cell.cellIndex),
      text: cell.text,
    }));
    const expected = new Map(expectedCells.map((cell) => [cell.index, cell.text]));
    const cells = [...document.querySelectorAll(${JSON.stringify(SOURCE_CELL_SELECTOR)})].map((cell) => {
      const text = cell.querySelector('pre[data-source-code], pre code, [data-source-code]')?.textContent ?? '';
      return {
        index: cell.dataset.cellIndex,
        text,
        expected: expected.get(cell.dataset.cellIndex),
        protected: cell.dataset.protected,
        editable: cell.dataset.editable,
        editableDescendants: cell.querySelectorAll(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
        ).length,
      };
    });
    const result = {
      status: response.status,
      expectedCount: expected.size,
      expectedCells,
      cells,
    };
    if (openedByAcceptance) {
      if (typeof inspector.close === 'function') inspector.close();
      else if (inspector.hasAttribute('popover') && typeof inspector.hidePopover === 'function') inspector.hidePopover();
      else if (opener) opener.click();
      else inspector.removeAttribute('open');
    }
    return result;
  })()`);
}

async function firstBlockerSnapshot(harness, sample) {
  const blockingPaths = sample.configurationEntries
    .filter((entry) => entry.blockingWhenBlank)
    .map((entry) => entry.path);
  return harness.evaluate(`(async () => {
    const paths = ${JSON.stringify(blockingPaths)};
    const controls = paths.map((path) => {
      const row = [...document.querySelectorAll('[data-parameter-path]')]
        .find((candidate) => candidate.dataset.parameterPath === path);
      return row?.querySelector('input:not([type="hidden"]), select, textarea') ?? null;
    }).filter(Boolean);
    for (const control of controls) {
      if (control.type === 'checkbox' || control.type === 'radio') control.checked = false;
      else control.value = '';
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const review = [
      ...document.querySelectorAll(
        '[data-dossier-action="review"], [data-review-action], #review-sample-button, #parameter-review-button, button'
      )
    ].find((button) =>
      button.matches('[data-dossier-action="review"], [data-review-action], #review-sample-button, #parameter-review-button') ||
      /^review sample$/i.test(button.textContent.trim())
    );
    review?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const active = document.activeElement;
    const activeRow = active?.closest?.('[data-parameter-path]');
    const firstInvalid = [...document.querySelectorAll(
      '#${DOSSIER_IDS.inputs} [aria-invalid="true"], #${DOSSIER_IDS.inputs} :invalid'
    )].find((control) => control.getClientRects().length > 0);
    return {
      blockerCount: controls.length,
      reviewFound: Boolean(review),
      activePath: activeRow?.dataset.parameterPath ?? '',
      firstInvalidPath: firstInvalid?.closest('[data-parameter-path]')?.dataset.parameterPath ?? '',
    };
  })()`);
}

async function dialogFocusSnapshot(harness) {
  await harness.evaluate(`(() => {
    const hooks = globalThis.__citadelTestHooks;
    hooks?.setValue('hub.subscriptionId', '00000000-1111-2222-3333-444444444444');
    hooks?.setValue('hub.resourceGroupName', 'rg-dossier-acceptance');
    hooks?.setValue('hub.apimName', 'apim-dossier-acceptance');
    hooks?.setValue('samples.cleanup.confirmNonProduction', true);
    hooks?.setValue('samples.cleanup.deleteResourceGroup', true);
    return true;
  })()`);
  await settle(harness);
  await harness.evaluate(`(() => {
    const review = [
      ...document.querySelectorAll(
        '[data-dossier-action="review"], [data-review-action], #review-sample-button, #parameter-review-button, button'
      )
    ].find((button) =>
      button.matches('[data-dossier-action="review"], [data-review-action], #review-sample-button, #parameter-review-button') ||
      /^review sample$/i.test(button.textContent.trim())
    );
    review?.click();
    return Boolean(review);
  })()`);
  await settle(harness);
  const opened = await harness.evaluate(`(() => {
    const acknowledgement = document.querySelector(
      '#${DOSSIER_IDS.review} input[type="checkbox"][data-acknowledgement], #${DOSSIER_IDS.review} #ack-check'
    );
    if (acknowledgement && !acknowledgement.checked) acknowledgement.click();
    const run = [
      ...document.querySelectorAll(
        '[data-dossier-action="run"], [data-run-action], #run-sample-button, #run-button, button'
      )
    ].find((button) =>
      button.matches('[data-dossier-action="run"], [data-run-action], #run-sample-button, #run-button') ||
      /^run sample$/i.test(button.textContent.trim())
    );
    if (!run) return { openerFound: false, openerId: '' };
    run.dataset.acceptanceDialogOpener = 'true';
    run.focus();
    run.click();
    return { openerFound: true, openerId: run.id };
  })()`);
  await harness.waitFor(
    `(() => {
      const dialog = document.getElementById(${JSON.stringify(DOSSIER_IDS.destructiveDialog)});
      let popoverOpen = false;
      try { popoverOpen = dialog?.matches(':popover-open') ?? false; } catch {}
      return Boolean(dialog && (dialog.open || popoverOpen || dialog.getAttribute('aria-hidden') === 'false'));
    })()`,
    { label: DOSSIER_IDS.destructiveDialog },
  );
  const activeInside = await harness.evaluate(`(() => {
    const dialog = document.getElementById(${JSON.stringify(DOSSIER_IDS.destructiveDialog)});
    return Boolean(dialog?.contains(document.activeElement));
  })()`);
  await harness.pressKey('Escape');
  await harness.waitFor(
    `(() => {
      const dialog = document.getElementById(${JSON.stringify(DOSSIER_IDS.destructiveDialog)});
      let popoverOpen = false;
      try { popoverOpen = dialog?.matches(':popover-open') ?? false; } catch {}
      return Boolean(dialog && !dialog.open && !popoverOpen && dialog.getAttribute('aria-hidden') !== 'false');
    })()`,
    { label: 'the destructive dialog to close with Escape' },
  );
  const returned = await harness.evaluate(
    `document.activeElement?.dataset.acceptanceDialogOpener === 'true'`,
  );
  return { ...opened, activeInside, returned };
}

async function visibleFocusIssues(harness) {
  return harness.evaluate(`(async () => {
    const selector = [
      'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
      'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const primary = document.getElementById(${JSON.stringify(DOSSIER_IDS.dossier)});
    const nodes = [...new Set(primary?.querySelectorAll(selector) ?? [])].filter((node) =>
      node.tabIndex >= 0 &&
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== 'hidden'
    );
    const failures = [];
    for (const node of nodes) {
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = node.getBoundingClientRect();
      const visual = globalThis.visualViewport;
      const left = visual?.offsetLeft ?? 0;
      const top = visual?.offsetTop ?? 0;
      const right = left + (visual?.width ?? innerWidth);
      const bottom = top + (visual?.height ?? innerHeight);
      const x = Math.min(Math.max(rect.left + rect.width / 2, left + 1), right - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, top + 1), bottom - 1);
      const hit = document.elementFromPoint(x - left, y - top);
      const visible =
        rect.left >= left - 1 &&
        rect.right <= right + 1 &&
        rect.top >= top - 1 &&
        rect.bottom <= bottom + 1 &&
        Boolean(hit && (hit === node || node.contains(hit) || hit.contains(node)));
      if (!visible) failures.push(node.id || node.getAttribute('name') || node.textContent.trim().slice(0, 40));
    }
    return failures;
  })()`);
}

async function viewportSnapshot(harness, scenario) {
  return harness.evaluate(`(() => {
    const visible = (node) => Boolean(
      node &&
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== 'hidden'
    );
    const directory = document.getElementById(${JSON.stringify(DOSSIER_IDS.recipeDirectory)});
    const drawer = document.getElementById(${JSON.stringify(DOSSIER_IDS.recipeDrawer)});
    const drawerControl = document.querySelector(
      '[aria-controls="${DOSSIER_IDS.recipeDrawer}"],' +
      '[popovertarget="${DOSSIER_IDS.recipeDrawer}"],' +
      '[commandfor="${DOSSIER_IDS.recipeDrawer}"]'
    );
    const ledger = document.getElementById(${JSON.stringify(DOSSIER_IDS.ledger)});
    const actionBar = document.querySelector(
      '[data-dossier-bottom-dock], .dossier-bottom-dock, [data-dossier-action-bar], .dossier-action-bar'
    );
    const progress = document.querySelector('[data-dossier-stage-progress], .dossier-stage-progress');
    const primaryStages = [...document.querySelectorAll('[data-dossier-stage]')];
    const primaryRects = ${JSON.stringify([
      DOSSIER_IDS.context,
      DOSSIER_IDS.inputs,
      DOSSIER_IDS.review,
      DOSSIER_IDS.output,
    ])}.map((id) => document.getElementById(id)?.getBoundingClientRect()).filter(Boolean);
    const compactInspectors = ${JSON.stringify([
      DOSSIER_IDS.sourceInspector,
      DOSSIER_IDS.provenanceDrawer,
      DOSSIER_IDS.diagnosticsDrawer,
    ])}.map((id) => document.getElementById(id)).filter(Boolean);
    const popoverOpen = (node) => {
      try { return node.matches(':popover-open'); } catch { return false; }
    };
    const nestedFormScrollers = [...document.querySelectorAll(
      '#${DOSSIER_IDS.inputs} form, #${DOSSIER_IDS.inputs} fieldset, #${DOSSIER_IDS.inputs} [data-parameter-group]'
    )].filter((node) => {
      const style = getComputedStyle(node);
      return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
    }).length;
    const safeAreaRule = [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((rule) =>
          /safe-area-inset-bottom/.test(rule.cssText) &&
          /(dossier-bottom-dock|dossier-action-bar)/.test(rule.cssText)
        );
      } catch {
        return false;
      }
    });
    const shell = document.getElementById(${JSON.stringify(DOSSIER_IDS.shell)});
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
      shell?.scrollWidth ?? 0
    );
    const activeNavigators = [
      visible(directory),
      visible(drawer) || visible(drawerControl),
    ].filter(Boolean).length;
    return {
      scenario: ${JSON.stringify(scenario.name)},
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      documentWidth,
      shellWidth: shell?.scrollWidth ?? 0,
      nestedFormScrollers,
      navigatorCount: activeNavigators,
      directoryVisible: visible(directory),
      drawerControlVisible: visible(drawer) || visible(drawerControl),
      ledgerPosition: ledger ? getComputedStyle(ledger).position : '',
      ledgerWidth: ledger?.getBoundingClientRect().width ?? 0,
      actionBarPosition: actionBar ? getComputedStyle(actionBar).position : '',
      actionBarHeight: actionBar?.getBoundingClientRect().height ?? 0,
      safeAreaRule,
      stageProgressVisible: visible(progress),
      stageProgressText: progress?.textContent.trim() ?? '',
      visiblePrimaryStages: primaryStages.length
        ? primaryStages.filter(visible).length
        : primaryRects.filter((rect) => rect.width > 0 && rect.height > 0).length,
      singleColumn:
        primaryRects.length === 4 &&
        primaryRects.every((rect) => Math.abs(rect.left - primaryRects[0].left) <= 1),
      compactInspectorsClosed: compactInspectors.every((node) =>
        !node.open &&
        !popoverOpen(node) &&
        node.getAttribute('aria-hidden') !== 'false' &&
        !visible(node)
      ),
    };
  })()`);
}

async function openPhoneRecipePickerSnapshot(harness) {
  return harness.evaluate(`(async () => {
    const drawer = document.getElementById(${JSON.stringify(DOSSIER_IDS.recipeDrawer)});
    const trigger = document.querySelector(
      '[aria-controls="${DOSSIER_IDS.recipeDrawer}"],' +
      '[popovertarget="${DOSSIER_IDS.recipeDrawer}"],' +
      '[commandfor="${DOSSIER_IDS.recipeDrawer}"]'
    );
    if (!drawer || !trigger) return { found: false };
    trigger.focus();
    trigger.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = drawer.getBoundingClientRect();
    const viewport = globalThis.visualViewport;
    let popoverOpen = false;
    try { popoverOpen = drawer.matches(':popover-open'); } catch {}
    const open = drawer.open || popoverOpen || drawer.getAttribute('aria-hidden') === 'false';
    const result = {
      found: true,
      open,
      fullWidth: Math.abs(rect.width - (viewport?.width ?? innerWidth)) <= 1,
      fullHeight: Math.abs(rect.height - (viewport?.height ?? innerHeight)) <= 1,
      focusInside: drawer.contains(document.activeElement),
    };
    return result;
  })()`);
}

async function compactInspectorSnapshot(harness) {
  return harness.evaluate(`(async () => {
    const inspector = document.getElementById(${JSON.stringify(DOSSIER_IDS.sourceInspector)});
    const trigger = document.querySelector(
      '[aria-controls="${DOSSIER_IDS.sourceInspector}"],' +
      '[popovertarget="${DOSSIER_IDS.sourceInspector}"],' +
      '[commandfor="${DOSSIER_IDS.sourceInspector}"],' +
      '[data-open-inspector="source"]'
    );
    const compactSurfaces = ${JSON.stringify([
      DOSSIER_IDS.sourceInspector,
      DOSSIER_IDS.provenanceDrawer,
      DOSSIER_IDS.diagnosticsDrawer,
    ])}.map((id) => document.getElementById(id)).filter(Boolean);
    if (!inspector || !trigger) return { found: false };
    trigger.focus();
    trigger.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    let modal = false;
    let popoverOpen = false;
    try { modal = inspector.matches(':modal'); } catch {}
    try { popoverOpen = inspector.matches(':popover-open'); } catch {}
    const rect = inspector.getBoundingClientRect();
    const visual = globalThis.visualViewport;
    return {
      found: true,
      open: inspector.open || popoverOpen || inspector.getAttribute('aria-hidden') === 'false',
      topLayer: modal || popoverOpen,
      fullWidth: Math.abs(rect.width - (visual?.width ?? innerWidth)) <= 1,
      focusInside: inspector.contains(document.activeElement),
      allCompactSurfacesUseTopLayerSemantics: compactSurfaces.every((surface) =>
        surface.tagName === 'DIALOG' || surface.hasAttribute('popover')
      ),
    };
  })()`);
}

async function runResponsiveScenarios(harness, reporter) {
  for (const scenario of DOSSIER_ACCEPTANCE_SCENARIOS.slice(0, 4)) {
    await harness.page.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await harness.page.send('Emulation.setEmulatedMedia', { media: '', features: [] });
    await harness.setViewport(scenario);
    await settle(harness);
    const snapshot = await viewportSnapshot(harness, scenario);
    reportIssues(
      reporter,
      `${scenario.name}: responsive contract`,
      viewportContractIssues(snapshot, scenario),
    );
    if (scenario.name === 'phone') {
      const picker = await openPhoneRecipePickerSnapshot(harness);
      reporter.check(
        'phone recipe picker opens full-height with focus inside',
        picker.found && picker.open && picker.fullWidth && picker.fullHeight && picker.focusInside,
        JSON.stringify(picker),
      );
      await harness.pressKey('Escape');
      await settle(harness);
      const inspector = await compactInspectorSnapshot(harness);
      reporter.check(
        'compact inspectors use top-layer semantics and protected source opens full-width',
        inspector.found &&
          inspector.open &&
          inspector.topLayer &&
          inspector.fullWidth &&
          inspector.focusInside &&
          inspector.allCompactSurfacesUseTopLayerSemantics,
        JSON.stringify(inspector),
      );
      await harness.pressKey('Escape');
      await settle(harness);
    }
    if (scenario.name === 'phone-small') {
      const focusIssues = await visibleFocusIssues(harness);
      reporter.check(
        '320x480 keeps every primary focus target visible and uncovered',
        focusIssues.length === 0,
        focusIssues.join(', '),
      );
    }
    await captureScreenshot(harness, scenario);
  }
}

async function runZoomScenario(harness, reporter) {
  const scenario = currentScenario('zoom-200-percent');
  await harness.setViewport(scenario);
  let supported = true;
  try {
    await harness.page.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  } catch {
    supported = false;
  }
  await settle(harness);
  const zoom = await harness.evaluate(`(() => ({
    scale: globalThis.visualViewport?.scale ?? 1,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    shellWidth: document.getElementById(${JSON.stringify(DOSSIER_IDS.shell)})?.scrollWidth ?? 0,
  }))()`);
  reporter.check(
    'Chromium applies a true 200% page scale',
    supported && zoom.scale >= 1.9,
    JSON.stringify(zoom),
  );
  reporter.check(
    '200% zoom has no layout-level horizontal clipping',
    zoom.documentWidth <= zoom.viewportWidth + 1 && zoom.shellWidth <= zoom.viewportWidth + 1,
    JSON.stringify(zoom),
  );
  const focusIssues = await visibleFocusIssues(harness);
  reporter.check(
    '200% zoom keeps every primary focus target visible and uncovered',
    focusIssues.length === 0,
    focusIssues.join(', '),
  );
  await captureScreenshot(harness, scenario);
  await harness.page.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await harness.setViewport({ width: 640, height: 450, mobile: false });
  await settle(harness);
  const reflow = await harness.evaluate(`(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    shellWidth: document.getElementById(${JSON.stringify(DOSSIER_IDS.shell)})?.scrollWidth ?? 0,
    compactStageProgress: Boolean(
      document.querySelector('[data-dossier-stage-progress], .dossier-stage-progress')?.getClientRects().length
    ),
  }))()`);
  reporter.check(
    'the 200%-equivalent layout viewport reflows without horizontal clipping',
    reflow.documentWidth <= reflow.viewportWidth + 1 &&
      reflow.shellWidth <= reflow.viewportWidth + 1 &&
      reflow.compactStageProgress,
    JSON.stringify(reflow),
  );
}

async function runReducedMotionScenario(harness, reporter) {
  const scenario = currentScenario('reduced-motion');
  await harness.setViewport(scenario);
  await harness.page.send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await settle(harness);
  const motion = await harness.evaluate(`(() => {
    const seconds = (value) => value.split(',').map((entry) => {
      const trimmed = entry.trim();
      return trimmed.endsWith('ms') ? Number.parseFloat(trimmed) / 1000 : Number.parseFloat(trimmed) || 0;
    });
    const offenders = [];
    for (const node of document.querySelectorAll('#${DOSSIER_IDS.shell} *')) {
      const style = getComputedStyle(node);
      const maximum = Math.max(...seconds(style.animationDuration), ...seconds(style.transitionDuration));
      if (maximum > 0.011) offenders.push(node.id || node.className || node.tagName);
    }
    return { matches: matchMedia('(prefers-reduced-motion: reduce)').matches, offenders };
  })()`);
  reporter.check(
    'reduced motion removes material dossier animation',
    motion.matches && motion.offenders.length === 0,
    JSON.stringify(motion.offenders),
  );
  await captureScreenshot(harness, scenario);
  await harness.page.send('Emulation.setEmulatedMedia', { media: '', features: [] });
}

async function runForcedColorsScenario(harness, reporter) {
  const scenario = currentScenario('forced-colors');
  await harness.setViewport(scenario);
  try {
    await harness.page.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'forced-colors', value: 'active' }],
    });
  } catch {
    process.stdout.write('  skip forced-colors: Chromium does not expose forced-colors emulation\n');
    return;
  }
  await settle(harness);
  const contrast = await harness.evaluate(`(() => {
    if (!matchMedia('(forced-colors: active)').matches) return { supported: false };
    const target = document.querySelector('#${DOSSIER_IDS.dossier} button, #${DOSSIER_IDS.dossier} input');
    target?.focus();
    const style = target ? getComputedStyle(target) : null;
    const shellStyle = getComputedStyle(document.getElementById(${JSON.stringify(DOSSIER_IDS.shell)}));
    return {
      supported: true,
      focusVisible: Boolean(style && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2),
      canvasBackground: shellStyle.backgroundColor,
      targetFound: Boolean(target),
    };
  })()`);
  if (!contrast.supported) {
    process.stdout.write('  skip forced-colors: this Chromium build did not activate the media feature\n');
  } else {
    reporter.check(
      'forced colors retains a visible focus boundary',
      contrast.targetFound && contrast.focusVisible,
      JSON.stringify(contrast),
    );
    await captureScreenshot(harness, scenario);
  }
  await harness.page.send('Emulation.setEmulatedMedia', { media: '', features: [] });
}

async function secretAbsenceSnapshot(harness, secretPath) {
  return harness.evaluate(`(() => {
    const secret = ${JSON.stringify(SECRET)};
    const secretPath = ${JSON.stringify(secretPath)};
    const attributes = [];
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        if (attribute.value.includes(secret)) attributes.push(element.tagName + '[' + attribute.name + ']');
      }
    }
    const secretRow = [...document.querySelectorAll('[data-parameter-path]')]
      .find((row) => row.dataset.parameterPath === secretPath);
    const secretControl = secretRow?.querySelector('input, textarea');
    return {
      controlCarriesSecret: secretControl?.value === secret,
      controlType: secretControl?.type ?? '',
      text: document.body.textContent.includes(secret),
      markup: document.documentElement.outerHTML.includes(secret),
      attributes,
      localStorage: Object.values(localStorage).some((value) => value.includes(secret)),
      sessionStorage: Object.values(sessionStorage).some((value) => value.includes(secret)),
    };
  })()`);
}

async function main() {
  const reporter = createCheckReporter({ name: 'dossier browser acceptance' });
  const defaultSample =
    CATALOGUE.samples.find((sample) => sample.configurationEntries.some((entry) => entry.blockingWhenBlank)) ??
    CATALOGUE.samples[0];
  const destructiveSample = CATALOGUE.samples.find((sample) => sample.risk.level === 'destructive');
  const secretSample = CATALOGUE.samples.find((sample) =>
    sample.configurationEntries.some((entry) => entry.secret === true || entry.requirement === 'secret'),
  );
  if (!defaultSample || !destructiveSample || !secretSample) {
    throw new Error('The dossier acceptance recipes are unavailable.');
  }

  await prepareArtifactDirectory();
  const harness = await launchBrowserHarness({
    browserPath: argumentValue('--chrome'),
    createServer: ({ port }) =>
      createPlaygroundServer({ port, mode: 'preview', publicOrigin: null }),
    path: 'about:blank',
  });
  let guard = null;
  try {
    guard = await installLoopbackRequestGuard(harness);
    await navigateToRecipe(harness, defaultSample.id);
    reporter.check(
      'the acceptance page is loopback-only with the explicit testExecutor flag',
      await harness.evaluate(
        `location.hostname === '127.0.0.1' && new URLSearchParams(location.search).has('testExecutor')`,
      ),
    );

    const staticSnapshot = await staticContractSnapshot(harness);
    reportIssues(reporter, 'primary semantic order is context -> inputs -> review -> output', semanticOrderIssues(staticSnapshot.order));
    reporter.equal('there are no top-level workflow tabs', staticSnapshot.topLevelTabs, 0);
    reporter.check('tabs are confined to output views', staticSnapshot.outputOnlyTabs, JSON.stringify(staticSnapshot.outputTabNames));
    reporter.check(
      'output tabs use only transcript, evidence, and artifacts',
      JSON.stringify(
        staticSnapshot.outputTabNames
          .map((name) => DOSSIER_OUTPUT_VIEWS.find((view) => String(name).toLowerCase().includes(view)))
          .sort(),
      ) === JSON.stringify([...DOSSIER_OUTPUT_VIEWS].sort()),
      JSON.stringify(staticSnapshot.outputTabNames),
    );
    reporter.check('the source inspector follows the primary document as a secondary surface', staticSnapshot.sourceInspectorSecondary);
    reportIssues(reporter, 'input fields have labels, names, and autocomplete policies', fieldContractIssues(staticSnapshot.fields));
    reporter.check('output exposes an assistive-technology log', staticSnapshot.roleLogCount >= 1);
    reporter.check('the dossier exposes no device-code sign-in content', staticSnapshot.deviceCodeContent === false);

    const source = await sourceImmutabilitySnapshot(harness, defaultSample.id);
    reporter.equal('protected source endpoint remains local and available', source.status, 200);
    reporter.check(
      'protected source is exact and immutable in the inspector',
      JSON.stringify(source.cells.map((cell) => ({ index: cell.index, text: cell.text }))) ===
        JSON.stringify(source.expectedCells) &&
        source.cells.every((cell) =>
          cell.text === cell.expected &&
          cell.protected === 'true' &&
          cell.editable === 'false' &&
          cell.editableDescendants === 0
        ),
      JSON.stringify(source.cells),
    );

    const blocker = await firstBlockerSnapshot(harness, defaultSample);
    reporter.check(
      'Review sample focuses the first blocking field',
      blocker.blockerCount > 0 &&
        blocker.reviewFound &&
        blocker.activePath === blocker.firstInvalidPath &&
        blocker.activePath.length > 0,
      JSON.stringify(blocker),
    );

    await navigateToRecipe(harness, destructiveSample.id);
    const dialog = await dialogFocusSnapshot(harness);
    reporter.check(
      'the destructive dialog owns focus, closes with Escape, and returns focus',
      dialog.openerFound && dialog.activeInside && dialog.returned,
      JSON.stringify(dialog),
    );

    await navigateToRecipe(harness, secretSample.id);
    const secretPath = secretSample.configurationEntries.find(
      (entry) => entry.secret === true || entry.requirement === 'secret',
    ).path;
    await harness.evaluate(`(() => {
      const row = [...document.querySelectorAll('[data-parameter-path]')]
        .find((candidate) => candidate.dataset.parameterPath === ${JSON.stringify(secretPath)});
      const control = row?.querySelector('input[type="password"], textarea');
      if (!control) return false;
      control.focus();
      control.value = ${JSON.stringify(SECRET)};
      control.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await settle(harness);
    const secret = await secretAbsenceSnapshot(harness, secretPath);
    reporter.check(
      'secret values are absent from text, markup, attributes, and browser storage',
      secret.controlCarriesSecret &&
        secret.controlType === 'password' &&
        !secret.text &&
        !secret.markup &&
        secret.attributes.length === 0 &&
        !secret.localStorage &&
        !secret.sessionStorage,
      JSON.stringify(secret),
    );

    await navigateToRecipe(harness, defaultSample.id);
    await runResponsiveScenarios(harness, reporter);
    await runZoomScenario(harness, reporter);
    await runReducedMotionScenario(harness, reporter);
    await runForcedColorsScenario(harness, reporter);

    await settle(harness);
    reportIssues(
      reporter,
      'the browser attempted no Azure or live request',
      [
        ...nonLoopbackRequestIssues(guard.requests, harness.baseUrl),
        ...guard.blocked.map((url) => `blocked external request: ${url}`),
        ...guard.errors.map((error) => `request guard error: ${error}`),
      ],
    );
    reporter.check('no uncaught browser errors were recorded', harness.pageErrors.length === 0, harness.pageErrors.join('; '));
  } finally {
    await guard?.close();
    await harness.close();
  }

  const result = reporter.finish();
  process.exitCode = result.ok ? 0 : 1;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stdout.write(`dossier browser acceptance: failed to run - ${error.message}\n`);
    process.exitCode = /No Chromium browser found/.test(error.message) ? 2 : 1;
  });
}
