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

    const validation = await harness.evaluate(`(() => {
      const button = [...document.querySelectorAll('#wizard-action-bar button')]
        .find((candidate) => candidate.textContent.trim() === 'Continue');
      button?.click();
      return true;
    })()`);
    reporter.check('the Continue action is present', validation);
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

    const selected = await harness.evaluate(`(async () => {
      const item = document.querySelector('.recipe-directory-item[data-recipe-id="weather-mcp-discovery"]');
      item?.click();
      return Boolean(item);
    })()`);
    reporter.check('the gateway recipe can be selected', selected);
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
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        recipeRailVisible: visible(document.getElementById('recipe-directory')),
        recipePickerVisible: visible(document.querySelector('.dossier-directory-toggle')),
        stepSelectorVisible: visible(document.querySelector('.dossier-stage-progress select')),
        actionPosition: getComputedStyle(document.getElementById('wizard-action-bar')).position,
        minimumControlHeight: Math.min(...controls.map((element) => element.getBoundingClientRect().height)),
      };
    })()`);
    reporter.check('320x480 has no page-level horizontal overflow', narrow.documentWidth <= narrow.viewportWidth);
    reporter.check('320x480 uses one recipe picker instead of the rail', !narrow.recipeRailVisible && narrow.recipePickerVisible);
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
