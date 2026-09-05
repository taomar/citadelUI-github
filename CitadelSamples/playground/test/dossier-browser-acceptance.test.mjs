import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  DOSSIER_ACCEPTANCE_SCENARIOS,
  dossierBreakpoint,
  dossierScreenshotName,
  fieldContractIssues,
  nonLoopbackRequestIssues,
  semanticOrderIssues,
  viewportContractIssues,
} from '../scripts/dossier-browser-acceptance.mjs';
import { DOSSIER_IDS } from '../web/js/render/dossier-contract.mjs';

const RESPONSIVE_CSS = new URL('../web/css/responsive.css', import.meta.url);
const css = await readFile(RESPONSIVE_CSS, 'utf8');

test('dossier acceptance scenarios and screenshot names are deterministic', () => {
  assert.deepEqual(
    DOSSIER_ACCEPTANCE_SCENARIOS.map((scenario) => dossierScreenshotName(scenario)),
    [
      '01-desktop-1440x900.png',
      '02-tablet-820x800.png',
      '03-phone-390x844.png',
      '04-phone-small-320x480.png',
      '05-zoom-200-percent.png',
      '06-reduced-motion.png',
      '07-forced-colors.png',
    ],
  );
  assert.equal(dossierBreakpoint(1200), 'desktop');
  assert.equal(dossierBreakpoint(1199), 'tablet');
  assert.equal(dossierBreakpoint(768), 'tablet');
  assert.equal(dossierBreakpoint(767), 'phone');
});

test('semantic and field helpers report integration contract violations', () => {
  const correctOrder = [
    DOSSIER_IDS.context,
    DOSSIER_IDS.inputs,
    DOSSIER_IDS.review,
    DOSSIER_IDS.output,
  ];
  assert.deepEqual(semanticOrderIssues(correctOrder), []);
  assert.equal(semanticOrderIssues([...correctOrder].reverse()).length, 1);

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
        shellWidth: 1440,
        nestedFormScrollers: 0,
        navigatorCount: 1,
        directoryVisible: true,
        drawerControlVisible: false,
        ledgerPosition: 'sticky',
        ledgerWidth: 310,
        visiblePrimaryStages: 4,
      },
      desktop,
    ),
    [],
  );

  const phone = DOSSIER_ACCEPTANCE_SCENARIOS[3];
  const issues = viewportContractIssues(
    {
      documentWidth: 340,
      viewportWidth: 320,
      shellWidth: 340,
      nestedFormScrollers: 1,
      navigatorCount: 2,
      directoryVisible: true,
      drawerControlVisible: false,
      stageProgressVisible: false,
      stageProgressText: '',
      visiblePrimaryStages: 4,
      actionBarPosition: 'static',
      actionBarHeight: 40,
      safeAreaRule: false,
      compactInspectorsClosed: false,
    },
    phone,
  );
  assert.ok(issues.length >= 10);
});

test('responsive CSS encodes the desktop, tablet, phone, zoom, and high-contrast contract', () => {
  assert.match(css, /@media \(min-width: 75rem\)/);
  assert.match(css, /@media \(min-width: 48rem\) and \(max-width: 74\.9375rem\)/);
  assert.match(css, /@media \(max-width: 47\.9375rem\)/);
  assert.match(css, /grid-template-columns: minmax\(12rem, 15rem\) minmax\(0, 1fr\) clamp\(18\.75rem, 22vw, 20rem\)/);
  assert.match(css, /--dossier-dock-size: 3\.5rem/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?--dossier-control-size: 2\.75rem/);
  assert.match(css, /@media \(pointer: fine\)[\s\S]*?--dossier-control-size: 2\.25rem/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /#source-inspector[\s\S]*?position: fixed/);
  assert.match(css, /\[popovertarget='recipe-drawer'\]/);
  assert.match(css, /overscroll-behavior: contain/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient|backdrop-filter|filter:\s*blur/i);
});
