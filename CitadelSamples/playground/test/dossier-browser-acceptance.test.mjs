import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  DOSSIER_ACCEPTANCE_SCENARIOS,
  dossierBreakpoint,
  dossierScreenshotName,
  fieldContractIssues,
  nonLoopbackRequestIssues,
  viewportContractIssues,
  wizardStepIssues,
} from '../scripts/dossier-browser-acceptance.mjs';

const RESPONSIVE_CSS = new URL('../web/css/responsive.css', import.meta.url);
const css = await readFile(RESPONSIVE_CSS, 'utf8');

test('dossier acceptance scenarios and screenshot names are deterministic', () => {
  assert.deepEqual(
    DOSSIER_ACCEPTANCE_SCENARIOS.map((scenario) => dossierScreenshotName(scenario)),
    [
      '01-azure-account-desktop-1440x900.png',
      '02-gateway-connection-desktop-1440x900.png',
      '03-gateway-help-mobile-390x844.png',
      '04-publish-assets-desktop-1252x876.png',
      '05-publish-assets-tablet-768x800.png',
      '06-publish-assets-phone-390x844.png',
      '07-publish-assets-phone-small-320x480.png',
      '08-publish-assets-zoom-200-percent-1280x900.png',
      '09-publish-assets-source-desktop-1440x900.png',
      '10-publish-assets-source-mobile-390x844.png',
      '11-cleanup-review-desktop-1440x900.png',
      '12-cleanup-review-mobile-390x844.png',
      '13-offline-diagnostics-820x800.png',
      '14-reduced-motion-820x800.png',
      '15-forced-colors-820x800.png',
    ],
  );
  assert.equal(dossierBreakpoint(1200), 'desktop');
  assert.equal(dossierBreakpoint(1199), 'tablet');
  assert.equal(dossierBreakpoint(768), 'tablet');
  assert.equal(dossierBreakpoint(767), 'phone');
  assert.equal(DOSSIER_ACCEPTANCE_SCENARIOS[7].width, 640);
  assert.equal(DOSSIER_ACCEPTANCE_SCENARIOS[7].deviceScaleFactor, 2);
  assert.equal(DOSSIER_ACCEPTANCE_SCENARIOS[7].screenshotWidth, 1280);
});

test('wizard and field helpers report integration contract violations', () => {
  assert.deepEqual(
    wizardStepIssues({
      wizardCount: 1,
      currentStepCount: 1,
      stepCount: 4,
      stepProgress: 'Step 1 of 4',
      topLevelTabs: 0,
    }),
    [],
  );
  assert.equal(wizardStepIssues({
    wizardCount: 2,
    currentStepCount: 0,
    stepCount: 7,
    stepProgress: '1/7',
    topLevelTabs: 4,
  }).length, 5);

  assert.deepEqual(
    fieldContractIssues([
      { id: 'resource-name', name: 'resourceName', autocomplete: 'off', labelled: true },
    ]),
    [],
  );
  assert.deepEqual(
    fieldContractIssues([{ id: 'broken', name: '', autocomplete: '', labelled: false }]),
    [
      'broken has no programmatic label',
      'broken has no name',
      'broken has no autocomplete policy',
    ],
  );
});

test('the request guard accepts loopback assets and rejects live origins', () => {
  assert.deepEqual(
    nonLoopbackRequestIssues(
      [
        'http://127.0.0.1:4312/',
        'http://127.0.0.1:4312/web/js/main.mjs',
        'data:,',
        'about:blank',
      ],
      'http://127.0.0.1:4312',
    ),
    [],
  );
  assert.deepEqual(
    nonLoopbackRequestIssues(['https://management.azure.com/subscriptions'], 'http://127.0.0.1:4312'),
    ['external request attempted: https://management.azure.com/subscriptions'],
  );
});

test('viewport helper enforces the breakpoint-specific dossier shape', () => {
  const desktop = DOSSIER_ACCEPTANCE_SCENARIOS[0];
  assert.deepEqual(
    viewportContractIssues(
      {
        documentWidth: 1440,
        viewportWidth: 1440,
        viewportHeight: 900,
        shellWidth: 1440,
        documentClientHeight: 900,
        documentScrollHeight: 900,
        mainOverflowY: 'auto',
        mainClientHeight: 700,
        mainScrollHeight: 1100,
        mainHorizontalOverflow: false,
        bodyOverflowY: 'hidden',
        contextDisclosureOpen: true,
        contextSummaryVisible: false,
        contextSummaryTargetVisible: true,
        directoryOverflowY: 'auto',
        directoryClientHeight: 700,
        directoryScrollHeight: 1200,
        nestedFormScrollers: 0,
        visibleStepContents: 1,
        directoryVisible: true,
        drawerControlVisible: false,
        drawerControlText: '',
        drawerControlWidth: 0,
        drawerControlBottom: 0,
        workspaceBarWidth: 1440,
        workspaceContentWidth: 1392,
        stepNavVisible: true,
        stepSelectorVisible: false,
        stepSelectorTop: 0,
        actionBarPosition: 'sticky',
        primaryActionCount: 1,
        minimumControlHeight: 40,
      },
      desktop,
    ),
    [],
  );

  const phone = DOSSIER_ACCEPTANCE_SCENARIOS[6];
  const issues = viewportContractIssues(
    {
      documentWidth: 340,
      viewportWidth: 320,
      viewportHeight: 480,
      shellWidth: 340,
      documentClientHeight: 480,
      documentScrollHeight: 480,
      mainOverflowY: 'auto',
      mainClientHeight: 240,
      mainScrollHeight: 900,
      mainHorizontalOverflow: false,
      bodyOverflowY: 'hidden',
      directoryOverflowY: 'auto',
      directoryClientHeight: 480,
      directoryScrollHeight: 1000,
      nestedFormScrollers: 1,
      visibleStepContents: 2,
      directoryVisible: true,
      drawerControlVisible: false,
      drawerControlText: 'Recipes',
      drawerControlWidth: 100,
      drawerControlBottom: 100,
      workspaceBarWidth: 320,
      workspaceContentWidth: 296,
      stepNavVisible: true,
      stepSelectorVisible: false,
      stepSelectorTop: 50,
      actionBarPosition: 'static',
      primaryActionCount: 2,
      safeAreaRule: false,
      minimumControlHeight: 36,
    },
    phone,
  );
  assert.ok(issues.length >= 10);
});

test('responsive CSS encodes the desktop, tablet, phone, zoom, and high-contrast contract', () => {
  assert.match(css, /grid-template-columns: 15rem minmax\(0, 1fr\)/);
  assert.match(css, /\.recipe-wizard[\s\S]*?grid-template-columns: 12rem minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 74\.999rem\)/);
  assert.match(css, /@media \(max-width: 62rem\)/);
  assert.match(css, /@media \(max-width: 47\.999rem\)/);
  assert.match(css, /\.wizard-step-nav[\s\S]*?position: sticky/);
  assert.match(css, /#dossier-shell[\s\S]*?block-size: 100dvh/);
  assert.match(css, /#run-dossier[\s\S]*?overflow: hidden auto/);
  assert.match(css, /\.dossier-stage-progress select[\s\S]*?display: block/);
  assert.match(css, /--dossier-dock-size: 3\.5rem/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?--dossier-control-size: 2\.75rem/);
  assert.match(css, /@media \(pointer: fine\)[\s\S]*?--dossier-control-size: 2\.5rem/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /#source-inspector[\s\S]*?position: fixed/);
  assert.match(css, /overscroll-behavior-inline: contain/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient|backdrop-filter|filter:\s*blur/i);
});
