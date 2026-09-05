import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const [
  html,
  world,
  workbench,
  shellCss,
  configureCss,
  responsiveCss,
  main,
  shell,
  configure,
  review,
  output,
] = await Promise.all([
  read('../web/index.html'),
  read('../web/css/world.css'),
  read('../web/css/workbench.css'),
  read('../web/css/shell.css'),
  read('../web/css/configure.css'),
  read('../web/css/responsive.css'),
  read('../web/js/main.mjs'),
  read('../web/js/render/shell.mjs'),
  read('../web/js/render/configure.mjs'),
  read('../web/js/render/review.mjs'),
  read('../web/js/render/output.mjs'),
]);

const css = [world, workbench, shellCss, configureCss, responsiveCss].join('\n');
const activeUi = [html, main, shell, configure, review, output, shellCss, configureCss, responsiveCss].join('\n');

test('the page declares language, scalable viewport, theme color, title, and a local favicon', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
  assert.match(html, /<meta name="theme-color" content="#071b2d">/);
  assert.match(html, /<title>Citadel Publish Playground<\/title>/);
  assert.match(html, /<link rel="icon" href="data:,">/);
});

test('the static document is a minimal mount with one module and no inline behavior', () => {
  assert.match(html, /<div id="app"><\/div>/);
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.deepEqual(scripts, ['<script type="module" src="/web/js/main.mjs">']);
  assert.doesNotMatch(html, /\son(click|load|input|change)=/);
  assert.doesNotMatch(html, /style="/);
});

test('nothing imports or links the existing Control Plane application', () => {
  for (const [name, text] of [['index.html', html], ['world.css', world], ['main.mjs', main]]) {
    assert.doesNotMatch(text, /CitadelUI/i, `${name} references CitadelUI`);
    assert.doesNotMatch(text, /\.\.\/\.\.\/\.\.\/CitadelUI/, `${name} reaches outside CitadelSamples`);
  }
  for (const href of html.matchAll(/href="([^"]+)"/g)) {
    const value = href[1];
    if (value.startsWith('data:') || value.startsWith('#')) continue;
    assert.ok(value.startsWith('/web/'), `unexpected href ${value}`);
    assert.doesNotMatch(value, /\.\./);
  }
});

test('the skip link targets the dynamically rendered wizard heading', () => {
  assert.match(html, /class="skip-link" href="#wizard-step-title"/);
  assert.match(responsiveCss, /\.skip-link:focus\s*\{[\s\S]*?translate: 0/);
  assert.match(main, /id: 'wizard-step-title'/);
});

test('the shell renderer owns labelled masthead, navigation, main, context, and live-region landmarks', () => {
  assert.match(shell, /class: 'dossier-masthead'/);
  assert.match(shell, /'aria-label': 'Recipe directory'/);
  assert.match(shell, /id: DOSSIER_IDS\.dossier[\s\S]*?class: 'dossier-content'/);
  assert.match(shell, /'aria-label': 'Execution context'/);
  assert.match(shell, /role: 'status'[\s\S]*?'aria-live': 'polite'/);
});

test('the wizard replaces top-level workflow tabs and derives honest step progress', () => {
  assert.doesNotMatch(html, /role="tablist"|role="tabpanel"|tab-(guide|code|request|response)/);
  assert.match(shell, /`Step \$\{currentIndex \+ 1\} of \$\{Math\.max\(steps\.length, 1\)\}`/);
  assert.match(main, /WIZARD_STEP_DEFINITIONS/);
  assert.match(main, /filter\(\(step\) => step\.id !== 'account-target' \|\| identityKind\)/);
  assert.match(main, /filter\(\(step\) => step\.id !== 'required-inputs' \|\| required\.groups\.length > 0\)/);
  assert.match(main, /filter\(\(step\) => step\.id !== 'credentials-options' \|\| options\.groups\.length > 0\)/);
  assert.match(output, /Transcript/);
  assert.match(output, /Evidence/);
  assert.match(output, /Artifacts/);
});

test('future wizard steps are disabled and one footer owns the page primary action', () => {
  assert.match(main, /disabled: step\.enabled === false/);
  assert.match(main, /id: 'wizard-action-bar'/);
  assert.match(main, /class: 'btn btn-primary wizard-primary'/);
  assert.doesNotMatch(configure, /configure-missing-action[\s\S]*?btn-primary/);
});

test('gateway, Azure, hosted, and offline identity directions remain distinct', () => {
  assert.match(main, /gateway: 'Gateway connection'/);
  assert.match(main, /azure: 'Azure account & target'/);
  assert.match(main, /hosted: 'Hosted execution context'/);
  assert.match(main, /if \(liveKind === 'offline-python'\) return null/);
  assert.match(shell, /kind === 'gateway-key'/);
  assert.match(shell, /Sign in with Microsoft/);
  assert.match(shell, /Switch Azure account/);
  assert.match(shell, /Set Active changes only this Citadel playground launch/);
  assert.match(shell, /Signed in/);
  assert.match(shell, /Authorized to operate/);
  assert.match(shell, /Not authorized to operate/);
  assert.match(main, /operatorAuthorization: models\.capabilities\?\.operatorAuthorization/);
});

test('system-browser account controls are capability-gated without exposing a terminal fallback', () => {
  assert.match(shell, /identity\.systemBrowser\?\.available === true/);
  assert.match(shell, /identity\.launchCapability === 'system-browser'/);
  assert.match(shell, /identity\.launchCapability === 'wam'/);
  assert.match(shell, /Refresh Azure CLI Status/);
  assert.match(main, /accountControl\.launchMode !== 'system-browser'/);
  assert.match(main, /private Azure CLI session is not exposed to terminals/);
});

test('field help is concise by default and technical data stays behind disclosure', () => {
  assert.match(configure, /text: `Needed because /);
  assert.match(configure, /text: 'Enter manually'/);
  assert.match(configure, /text: 'Show CLI command'/);
  assert.match(configure, /text: 'Technical details'/);
  assert.match(configure, /Run APIM discovery/);
  assert.match(configureCss, /\.configure-field-help-body\s*\{[\s\S]*?display: flex[\s\S]*?flex-wrap: wrap/);
  assert.match(configureCss, /\.configure-field-help-body > details\[open\][\s\S]*?flex-basis: 100%/);
});

test('protected source is secondary, immutable, bounded, and shows one cell at a time', () => {
  assert.match(html, /<dialog id="source-inspector"/);
  assert.match(configure, /Inspect one cited repository-owned cell at a time/);
  assert.match(configure, /const cell = contract\.cells\[0\]/);
  assert.match(configure, /'data-protected': 'true'/);
  assert.match(configure, /'data-editable': 'false'/);
  assert.match(configure, /cell\.cellType === 'markdown' \|\| wrapSource/);
  assert.match(main, /sourceValidationRequest/);
  assert.match(main, /state\.sample\.id !== sampleId/);
  assert.match(configureCss, /\.source-inspector-frame\s*\{[\s\S]*?max-block-size: min\(60dvh, 40rem\)[\s\S]*?overflow: auto/);
  assert.match(configureCss, /\.source-inspector-code\s*\{[\s\S]*?white-space: pre/);
  assert.match(configureCss, /\.source-inspector-frame\[data-wrap='true'\][\s\S]*?white-space: pre-wrap/);
});

test('native top-layer dialogs own source, diagnostics, provenance, and destructive confirmation', () => {
  for (const id of ['source-inspector', 'provenance-drawer', 'diagnostics-drawer']) {
    assert.match(html, new RegExp(`<dialog id="${id}"`));
  }
  assert.match(main, /dialog\.showModal\(\)/);
  assert.match(review, /\.showModal\(\)/);
  assert.match(responsiveCss, /dialog:not\(\[open\]\)\s*\{[\s\S]*?display: none/);
});

test('the responsive contract uses a rail, centered task surface, compact selector, and safe-area footer', () => {
  assert.match(responsiveCss, /grid-template-columns: 15rem minmax\(0, 1fr\)/);
  assert.match(responsiveCss, /\.recipe-wizard\s*\{[\s\S]*?grid-template-columns: 12rem minmax\(0, 1fr\)/);
  assert.match(responsiveCss, /\.wizard-step-nav ol\s*\{[\s\S]*?position: sticky/);
  assert.match(responsiveCss, /@media \(max-width: 62rem\)[\s\S]*?\.wizard-step-nav\s*\{[\s\S]*?display: none/);
  assert.match(responsiveCss, /@media \(max-width: 62rem\)[\s\S]*?\.dossier-stage-progress select\s*\{[\s\S]*?display: block/);
  assert.match(responsiveCss, /\.wizard-action-bar\s*\{[\s\S]*?position: sticky/);
  assert.match(shellCss, /\.dossier-action-host\s*\{[^}]*grid-area: actions/);
  assert.match(shell, /class: 'dossier-action-host'/);
  assert.match(responsiveCss, /'content'\s*'actions'/);
  assert.match(responsiveCss, /env\(safe-area-inset-bottom\)/);
});

test('desktop and mobile control floors are 40px and 44px', () => {
  assert.match(responsiveCss, /--dossier-control-size: 2\.5rem/);
  assert.match(responsiveCss, /@media \(pointer: fine\)[\s\S]*?--dossier-control-size: 2\.5rem/);
  assert.match(responsiveCss, /@media \(pointer: coarse\)[\s\S]*?--dossier-control-size: 2\.75rem/);
  assert.match(responsiveCss, /@media \(max-width: 47\.999rem\)[\s\S]*?--dossier-control-size: 2\.75rem/);
});

test('focus, zoom, touch, reduced motion, and forced colors remain explicit', () => {
  assert.match(responsiveCss, /:focus-visible[\s\S]*?outline: 0\.1875rem solid var\(--brand\)/);
  assert.doesNotMatch(css, /transition:\s*all/);
  assert.match(world, /touch-action: manipulation/);
  assert.match(responsiveCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(responsiveCss, /@media \(prefers-contrast: more\)/);
  assert.match(responsiveCss, /@media \(forced-colors: active\)/);
});

test('the visual language stays restrained and locally defined', () => {
  for (const token of [
    '--nav: #0b3c68',
    '--sheet: #ffffff',
    '--brand: #0f6cbd',
    '--success: #107c10',
    '--warning: #8a3707',
    '--danger: #c50f1f',
    '--ink-1: #111827',
    '--rule: #d8e2ec',
  ]) {
    assert.ok(world.includes(token), `missing ${token}`);
  }
  assert.match(world, /--sans: 'Segoe UI Variable Text'/);
  assert.match(world, /--mono: 'Cascadia Mono'/);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient|backdrop-filter|filter:\s*blur/i);
  assert.doesNotMatch(css, /text-transform:\s*uppercase/);
});

test('layout tracks avoid fixed pixel widths and cap horizontal content', () => {
  assert.deepEqual([...css.matchAll(/grid-template-columns:[^;]*\b\d{2,}px/g)].map((match) => match[0]), []);
  assert.deepEqual([...css.matchAll(/(?<!max-)(?<!min-)\bwidth:\s*\d{3,}px/g)].map((match) => match[0]), []);
  assert.match(responsiveCss, /html,\s*body,\s*#app\s*\{[\s\S]*?overflow-x: clip/);
  assert.match(responsiveCss, /overflow-wrap: anywhere/);
});

test('the active wizard UI contains no interactive sign-in code surface', () => {
  assert.doesNotMatch(activeUi, /microsoft\.com\/devicelogin|azure-device-code|copy device code/i);
});
