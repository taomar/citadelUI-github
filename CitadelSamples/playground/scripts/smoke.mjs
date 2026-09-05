#!/usr/bin/env node
/**
 * Fast browser smoke for the per-recipe wizard.
 *
 * This runs against the loopback preview server only. It verifies secure
 * bootstrap, recipe switching, validation, secret handling, and narrow reflow.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPlaygroundServer } from '../server.mjs';
import { createCheckReporter, launchBrowserHarness } from './browser-harness.mjs';
import { navigationFocusCycle, navigationKey, navigationPointer, openNavigationPicker } from './dossier-browser-acceptance.mjs';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function settle(harness) {
  await harness.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function main() {
  const reporter = createCheckReporter({ name: 'wizard smoke' });
  const harness = await launchBrowserHarness({
    browserPath: argumentValue('--chrome'),
    createServer: ({ port, testBootstrapCapability }) =>
      createPlaygroundServer({
        port,
        mode: 'preview',
        publicOrigin: null,
        testBootstrapCapability,
      }),
    path: '/?testExecutor&recipe=publish-assets',
  });

  try {
    await harness.waitFor(
      "document.querySelector('[data-wizard-step]') && Boolean(globalThis.__citadelTestHooks)",
      { timeoutMs: 30_000, label: 'the recipe wizard' },
    );
    await settle(harness);

    const initial = await harness.evaluate(`(() => ({
      title: document.title,
      recipeCount: document.querySelectorAll('.recipe-directory-item').length,
      currentRecipe: document.querySelector('.dossier-current-id')?.textContent ?? '',
      stepTitle: document.getElementById('wizard-step-title')?.textContent ?? '',
      stepProgress: document.querySelector('.dossier-stage-progress > span')?.textContent.trim() ?? '',
      topLevelTabs: [...document.querySelectorAll('[role="tab"]')]
        .filter((tab) => !document.getElementById('dossier-output')?.contains(tab)).length,
      primaryActions: document.querySelectorAll('#wizard-action-bar .btn-primary').length,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      bootstrapInUrl: location.href.includes('bootstrap='),
    }))()`);
    reporter.equal('page title is set', initial.title, 'Citadel Publish Playground');
    reporter.equal('all recipes render in the catalogue', initial.recipeCount, 19);
    reporter.equal('the requested recipe is active', initial.currentRecipe, 'publish-assets');
    reporter.includes('the Azure recipe starts with its account and target task', initial.stepTitle, 'Azure account & target');
    reporter.check('step progress is honest', /^Step 1 of [2-5]$/.test(initial.stepProgress), initial.stepProgress);
    reporter.equal('there are no top-level workflow tabs', initial.topLevelTabs, 0);
    reporter.equal('the page exposes one primary wizard action', initial.primaryActions, 1);
    reporter.check('desktop has no page-level horizontal overflow', initial.documentWidth <= initial.viewportWidth);
    reporter.check('the bootstrap capability is removed immediately', !initial.bootstrapInUrl);

    await navigationPointer(harness, '#wizard-action-bar .btn-primary');
    reporter.check('the primary setup action is present', true);
    await settle(harness);
    const focused = await harness.evaluate(`(() => ({
      step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
      path: document.activeElement?.closest('[data-parameter-path]')?.dataset.parameterPath ?? '',
      invalid: document.activeElement?.getAttribute('aria-invalid') === 'true',
    }))()`);
    reporter.check(
      'Continue stays on the step and focuses the first invalid field',
      focused.step === 'account-target' && focused.invalid && focused.path.length > 0,
      JSON.stringify(focused),
    );

    await navigationPointer(harness, '#recipe-group-exercise');
    await navigationPointer(harness, '[data-recipe-id="weather-mcp-discovery"]');
    reporter.check('the gateway recipe can be selected', true);
    await harness.waitFor(
      "document.querySelector('.dossier-current-id')?.textContent === 'weather-mcp-discovery'",
      { label: 'Weather MCP discovery' },
    );
    await settle(harness);

    const gateway = await harness.evaluate(`(() => {
      const hooks = globalThis.__citadelTestHooks;
      hooks.setValue('hub.gatewayUrl', 'https://gateway.example.test');
      return {
        title: document.getElementById('wizard-step-title')?.textContent ?? '',
        identityKind: document.querySelector('.execution-context-bar')?.dataset.identityKind ?? '',
        accountControls: /Sign in with Microsoft|Switch Azure account|Set Active/
          .test(document.body.textContent ?? ''),
      };
    })()`);
    await settle(harness);
    await harness.evaluate(`(() => {
      const row = [...document.querySelectorAll('[data-parameter-path]')]
        .find((candidate) => candidate.dataset.parameterPath === 'gatewayAccess.apiKey');
      const control = row?.querySelector('input[type="password"]');
      if (!control) return false;
      control.value = 'SMOKE-SECRET-DO-NOT-RENDER';
      control.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const secret = await harness.evaluate(`(() => ({
      passwordValue: [...document.querySelectorAll('[data-parameter-path]')]
        .find((row) => row.dataset.parameterPath === 'gatewayAccess.apiKey')
        ?.querySelector('input[type="password"]')?.value ?? '',
      textLeak: document.body.textContent.includes('SMOKE-SECRET-DO-NOT-RENDER'),
      markupLeak: document.documentElement.outerHTML.includes('SMOKE-SECRET-DO-NOT-RENDER'),
    }))()`);
    reporter.includes('gateway recipes use the Gateway connection task', gateway.title, 'Gateway connection');
    reporter.equal('gateway identity is separate from Azure account identity', gateway.identityKind, 'gateway-key');
    reporter.check('gateway recipes expose no Azure account controls', !gateway.accountControls);
    reporter.check(
      'the gateway key remains only in its masked control',
      secret.passwordValue === 'SMOKE-SECRET-DO-NOT-RENDER' && !secret.textLeak && !secret.markupLeak,
      JSON.stringify(secret),
    );

    await harness.setViewport({ width: 320, height: 480, mobile: true });
    await settle(harness);
    const narrow = await harness.evaluate(`(() => {
      const visible = (element) => Boolean(
        element &&
        element.getClientRects().length &&
        getComputedStyle(element).visibility !== 'hidden'
      );
      const controls = [...document.querySelectorAll(
        '#dossier-shell button:not([disabled]), #dossier-shell input:not([disabled]), #dossier-shell select:not([disabled]), #dossier-shell summary'
      )].filter(visible);
      const picker = document.querySelector('.dossier-directory-toggle');
      const workspace = document.querySelector('.dossier-workspace-bar');
      const workspaceStyle = workspace ? getComputedStyle(workspace) : null;
      const stepSelector = document.querySelector('.dossier-stage-progress select');
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        recipeRailVisible: visible(document.getElementById('recipe-directory')),
        recipePickerVisible: visible(picker),
        recipePickerText: picker?.textContent.trim() ?? '',
        recipePickerWidth: picker?.getBoundingClientRect().width ?? 0,
        recipePickerBottom: picker?.getBoundingClientRect().bottom ?? 0,
        workspaceWidth: workspace?.clientWidth ?? 0,
        workspaceContentWidth: workspace
          ? workspace.clientWidth
            - Number.parseFloat(workspaceStyle.paddingLeft || '0')
            - Number.parseFloat(workspaceStyle.paddingRight || '0')
          : 0,
        stepSelectorVisible: visible(stepSelector),
        stepSelectorTop: stepSelector?.getBoundingClientRect().top ?? 0,
        actionPosition: getComputedStyle(document.getElementById('wizard-action-bar')).position,
        minimumControlHeight: Math.min(...controls.map((element) => element.getBoundingClientRect().height)),
      };
    })()`);
    reporter.check('320x480 has no page-level horizontal overflow', narrow.documentWidth <= narrow.viewportWidth);
    reporter.check(
      '320x480 makes recipe navigation a full-width row above the step selector',
      !narrow.recipeRailVisible
        && narrow.recipePickerVisible
        && narrow.recipePickerText.startsWith('Browse Recipes')
        && narrow.recipePickerWidth >= narrow.workspaceContentWidth - 2
        && narrow.stepSelectorTop >= narrow.recipePickerBottom - 1,
      JSON.stringify(narrow),
    );
    await openNavigationPicker(harness);
    const drawerKeyboard = await navigationFocusCycle(harness, [
      'close', 'recipe-directory-search', 'recipe-group-discover', 'recipe-group-prepare',
      'recipe-group-publish-grant', 'recipe-group-exercise', 'recipe-link-weather-mcp-discovery',
      'recipe-link-learn-mcp-discovery', 'recipe-link-a2a-agent-card', 'recipe-link-a2a-message-send',
      'recipe-link-agent-framework-hr-question', 'recipe-link-weather-tools-call',
      'recipe-group-observe', 'recipe-group-policy', 'recipe-group-lifecycle',
    ]);
    await navigationKey(harness, 'Escape', 27);
    Object.assign(drawerKeyboard, await harness.evaluate(`({
      closed:document.querySelector('.dossier-directory-toggle')?.getAttribute('aria-expanded') === 'false',
      focusReturned:document.activeElement === document.querySelector('.dossier-directory-toggle')
    })`));
    await openNavigationPicker(harness);
    await harness.setViewport({ width: 390, height: 700, mobile: true });
    await settle(harness);
    drawerKeyboard.sameModeResize = await harness.evaluate(`(() => ({
      open: document.querySelector('.dossier-directory-toggle')?.getAttribute('aria-expanded') === 'true',
      modal: document.getElementById('recipe-drawer')?.getAttribute('aria-modal') === 'true',
      focusInside: document.getElementById('recipe-drawer')?.contains(document.activeElement) === true,
    }))()`);
    await harness.setViewport({ width: 1300, height: 800, mobile: false });
    await settle(harness);
    drawerKeyboard.desktopTransition = await harness.evaluate(`(() => ({
      directoryVisible: document.getElementById('recipe-directory')?.getClientRects().length > 0,
      modal: document.getElementById('recipe-drawer')?.getAttribute('aria-modal') === 'true',
      dossierInert: document.getElementById('run-dossier')?.hasAttribute('inert') === true,
    }))()`);
    narrow.drawerKeyboard = drawerKeyboard;
    reporter.check(
      'the recipe picker contains focus and becomes a normal rail when the viewport widens',
      drawerKeyboard.wrapsForward
        && drawerKeyboard.wrapsBackward
        && drawerKeyboard.closed
        && drawerKeyboard.focusReturned
        && drawerKeyboard.sameModeResize.open
        && drawerKeyboard.sameModeResize.modal
        && drawerKeyboard.sameModeResize.focusInside
        && drawerKeyboard.desktopTransition.directoryVisible
        && !drawerKeyboard.desktopTransition.modal
        && !drawerKeyboard.desktopTransition.dossierInert,
      JSON.stringify(drawerKeyboard),
    );
    reporter.check('320x480 exposes the current-step selector', narrow.stepSelectorVisible);
    reporter.check(
      '320x480 pins the wizard actions',
      ['sticky', 'fixed'].includes(narrow.actionPosition),
      narrow.actionPosition,
    );
    reporter.check('320x480 controls remain at least 44px high', narrow.minimumControlHeight >= 43.5);
    reporter.check('the page reported no uncaught browser errors', harness.pageErrors.length === 0, harness.pageErrors.join('; '));
  } finally {
    await harness.close();
  }

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
