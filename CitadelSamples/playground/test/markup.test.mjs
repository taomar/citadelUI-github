/**
 * Markup and design-system checks.
 *
 * These are static: they read `index.html` and the two stylesheets and assert
 * the structural, accessibility and world-consistency properties the brief
 * fixes. A browser smoke run is a separate, manual step; these run anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HTML = fileURLToPath(new URL('../web/index.html', import.meta.url));
const WORLD_CSS = fileURLToPath(new URL('../web/css/world.css', import.meta.url));
const WORKBENCH_CSS = fileURLToPath(new URL('../web/css/workbench.css', import.meta.url));

const html = await readFile(HTML, 'utf-8');
const world = await readFile(WORLD_CSS, 'utf-8');
const workbench = await readFile(WORKBENCH_CSS, 'utf-8');
const css = `${world}\n${workbench}`;

/* ------------------------------------------------- the direction contract */

test('the opening comment is a five-block direction contract of at most 150 words', () => {
  const match = html.match(/<!--([\s\S]*?)-->/);
  assert.ok(match, 'index.html must open with a direction contract comment');
  const contract = match[1];
  for (const block of ['THESIS:', 'OWN-WORLD:', 'STORY:', 'FIRST VIEWPORT:', 'FORM:']) {
    assert.ok(contract.includes(block), `the direction contract is missing ${block}`);
  }
  const words = contract.trim().split(/\s+/).filter(Boolean);
  assert.ok(words.length <= 150, `the direction contract is ${words.length} words; the limit is 150`);
  assert.ok(words.length >= 60, `the direction contract is only ${words.length} words`);
  const order = ['THESIS:', 'OWN-WORLD:', 'STORY:', 'FIRST VIEWPORT:', 'FORM:'].map((block) =>
    contract.indexOf(block),
  );
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the five blocks are out of order');
});

/* --------------------------------------------------------- independence */

test('nothing imports or links the existing CitadelUI application', () => {
  for (const [name, text] of [['index.html', html], ['world.css', world], ['workbench.css', workbench]]) {
    assert.ok(!/CitadelUI/i.test(text), `${name} references CitadelUI`);
    assert.ok(!/\.\.\/\.\.\/\.\.\/CitadelUI/.test(text), `${name} reaches outside CitadelSamples`);
  }
  for (const href of html.matchAll(/href="([^"]+)"/g)) {
    const value = href[1];
    if (value.startsWith('http') || value.startsWith('data:') || value.startsWith('#')) continue;
    assert.ok(value.startsWith('/web/') || value.startsWith('/'), `unexpected href ${value}`);
    assert.ok(!value.includes('..'), `href ${value} traverses upward`);
  }
});

test('the page loads exactly one module script and no inline script', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /type="module"/);
  assert.match(scripts[0], /src="\/web\/js\/main\.mjs"/);
  assert.ok(!/<script>[\s\S]*?<\/script>/.test(html), 'no inline script, so the CSP needs no unsafe-inline');
  assert.ok(!/\son(click|load|input|change)=/.test(html), 'no inline event handler attributes');
  assert.ok(!/style="/.test(html), 'no inline styles');
});

/* ------------------------------------------------------- accessibility */

test('the page declares a language, a viewport and a title', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /<title>Citadel Publish Playground<\/title>/);
});

test('landmarks are present and labelled', () => {
  assert.match(html, /<header class="masthead">/);
  assert.match(html, /<nav class="rail rail-directory" id="directory" aria-label="Recipe directory">/);
  assert.match(html, /<main class="sheet" id="workbench" tabindex="-1">/);
  assert.doesNotMatch(html, /rail-context/, 'the former context rail must not create a fourth desktop column');
});

test('a skip link targets the main region', () => {
  assert.match(html, /class="skip" href="#workbench"/);
  assert.match(css, /\.skip:focus\s*\{[^}]*top:/, 'the skip link must become visible on focus');
});

test('the tab list and its panels are wired for assistive technology', () => {
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-label="Recipe views"/);
  for (const id of ['guide', 'code', 'request', 'response']) {
    assert.match(html, new RegExp(`id="panel-${id}"[^>]*role="tabpanel"`), `panel-${id} is not a tabpanel`);
    assert.match(html, new RegExp(`id="panel-${id}"[^>]*aria-labelledby="tab-${id}"`), `panel-${id} is unlabelled`);
    assert.match(html, new RegExp(`id="panel-${id}"[^>]*tabindex="0"`), `panel-${id} is not focusable`);
  }
});

test('every visible control in the static markup has a programmatic label', () => {
  assert.match(html, /<label class="visually-hidden" for="directory-search">/);
  assert.match(html, /<label for="sample-select">Recipe<\/label>/);
  assert.match(html, /id="directory-search"/);
  assert.match(html, /id="sample-select"/);
});

test('a polite live region exists for status announcements', () => {
  assert.match(html, /id="live" role="status" aria-live="polite"/);
});

test('the visually-hidden helper hides without removing from the accessibility tree', () => {
  const rule = css.match(/\.visually-hidden\s*\{([^}]*)\}/);
  assert.ok(rule, '.visually-hidden must be defined');
  assert.match(rule[1], /clip-path: inset\(50%\)/);
  assert.ok(!/display:\s*none/.test(rule[1]), 'display:none would remove it from the accessibility tree');
});

/* ------------------------------------------------------- the own world */

test('the world tokens are defined locally, in the Citadel control-plane ramps', () => {
  for (const token of [
    '--nav: #0b3c68',
    '--sheet: #ffffff',
    '--brand: #0f6cbd',
    '--cloud: #006b8f',
    '--success: #107c10',
    '--warning: #8a3707',
    '--danger: #c50f1f',
    '--ink-1: #111827',
    '--rule: #d8e2ec',
  ]) {
    assert.ok(world.includes(token), `the world is missing ${token}`);
  }
  assert.match(world, /--sans: 'Segoe UI Variable Text'/);
  assert.match(world, /--mono: 'Cascadia Mono'/);
});

test('no decorative gradient, glass or blur is used anywhere', () => {
  for (const forbidden of [/linear-gradient/, /radial-gradient/, /backdrop-filter/, /filter:\s*blur/]) {
    assert.ok(!forbidden.test(css), `the stylesheet uses ${forbidden}`);
  }
});

test('identifiers are never uppercased by the stylesheet', () => {
  assert.ok(!/text-transform:\s*uppercase/.test(css), 'uppercasing deletes camelCase word boundaries');
});

test('elevation is restrained: exactly one lift token and no shadow stack', () => {
  const lifts = [...world.matchAll(/--lift[a-z0-9-]*:/g)];
  assert.equal(lifts.length, 1, 'exactly one elevation token');
  assert.ok(!/box-shadow:[^;]*,[^;]*,[^;]*,/.test(css), 'no stacked decorative shadows');
});

test('no same-size card grid: the layout uses rows and intrinsic tracks', () => {
  assert.ok(!/repeat\(auto-fill, *minmax\(\d+px/.test(css), 'no fixed-pixel card grid');
  assert.ok(!/grid-template-columns:\s*repeat\(\d+,\s*1fr\)/.test(css), 'no equal-column card grid');
  assert.match(workbench, /\.prow\s*\{[\s\S]*?grid-template-columns: minmax\(/, 'parameter rows use a shared track');
  assert.match(workbench, /\.facts\s*\{[\s\S]*?grid-template-columns: minmax\(/, 'fact rows use a shared track');
});

test('progressive disclosure is used rather than modals', () => {
  assert.match(workbench, /\.disc > summary/, 'detail is reached by disclosure');
  assert.ok(!/<dialog/.test(html), 'no modal dialog in the markup');
  assert.ok(!/\bshowModal\b/.test(css));
});

test('every interactive component declares its states', () => {
  const states = [
    [/\.btn:hover:not\(:disabled\)/, 'button hover'],
    [/\.btn:active:not\(:disabled\)/, 'button active'],
    [/\.btn:disabled/, 'button disabled'],
    [/\.btn\[aria-busy='true'\]/, 'button loading'],
    [/\.ctl:hover:not\(:disabled\)/, 'input hover'],
    [/\.ctl:focus-visible/, 'input focus'],
    [/\.ctl:disabled/, 'input disabled'],
    [/\.ctl\[aria-invalid='true'\]/, 'input error'],
    [/\.ctl\[data-needed='true'\]/, 'input needed'],
    [/\.ctl\[data-needed='true'\]:hover:not\(:disabled\)/, 'input needed hover'],
    [/\.tab:hover/, 'tab hover'],
    [/\.tab:active/, 'tab active'],
    [/\.tab\[aria-selected='true'\]/, 'tab selected'],
    [/\.tab:disabled/, 'tab disabled'],
    [/\.dir-item:hover/, 'directory row hover'],
    [/\.dir-item:active/, 'directory row active'],
    [/\.dir-item\[aria-current='true'\]/, 'directory row current'],
    [/a:hover/, 'link hover'],
    [/a:active/, 'link active'],
    [/:focus-visible/, 'global focus'],
  ];
  for (const [pattern, label] of states) {
    assert.match(css, pattern, `${label} state is not defined`);
  }
});

test('focus is always visible and never removed without a replacement', () => {
  assert.match(world, /:focus-visible\s*\{[\s\S]*?box-shadow: var\(--focus-ring\)/);
  const outlineNone = [...css.matchAll(/outline:\s*none/g)];
  for (const match of outlineNone) {
    const tail = css.slice(match.index, match.index + 240);
    assert.match(tail, /box-shadow/, 'outline: none must be paired with a visible focus ring');
  }
});

test('reduced motion is respected globally and for the busy indicator', () => {
  assert.match(world, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: 0\.01ms/);
  assert.match(workbench, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none/);
});

test('current interface guidelines keep zoom, paste, touch and motion safe', () => {
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
  assert.doesNotMatch(css, /transition:\s*all/);
  assert.doesNotMatch(html, /\bonpaste\s*=/i);
  assert.match(world, /touch-action: manipulation/);
  assert.match(world, /-webkit-tap-highlight-color:/);
});

test('the layout changes shape rather than shrinking on a narrow viewport', () => {
  assert.match(world, /@media \(max-width: 66rem\)[\s\S]*?grid-template-areas:\s*\n?\s*'masthead'/);
  assert.match(world, /@media \(max-width: 66rem\)[\s\S]*?\.rail\s*\{\s*display: none/);
  assert.match(world, /\.compact-only\s*\{\s*display: none/, 'the compact controls are hidden on desktop');
  assert.match(html, /class="strip-compact compact-only"/, 'a native selector replaces the rail');
  assert.match(workbench, /\.parameter-pane\s*\{[\s\S]*?position: sticky/, 'parameters stay related to source on desktop');
  assert.match(
    workbench,
    /@media \(max-width: 72rem\)[\s\S]*?\.parameter-pane\s*\{[\s\S]*?position: static/,
    'the same parameter pane enters the narrow document flow',
  );
});

test('Code owns one canonical parameter pane and there is no Configure workflow', () => {
  assert.doesNotMatch(html, /panel-configure|tab-configure/);
  assert.match(workbench, /\.code-workspace\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(workbench, /\.parameter-pane-summary/);
  assert.match(workbench, /\.parameter-pane \.prow\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
});

test('no layout track is written in fixed pixels', () => {
  const pixelTracks = [...css.matchAll(/grid-template-columns:[^;]*\b\d{2,}px/g)];
  assert.deepEqual(pixelTracks.map((match) => match[0]), [], 'layout tracks must be intrinsic');
  const pixelWidths = [...css.matchAll(/(?<!max-)(?<!min-)\bwidth:\s*\d{3,}px/g)];
  assert.deepEqual(pixelWidths.map((match) => match[0]), [], 'no fixed pixel widths');
});

test('the page cannot overflow horizontally at a narrow width', () => {
  assert.match(world, /body\s*\{[\s\S]*?overflow: hidden/);
  assert.match(workbench, /\.preview\s*\{[\s\S]*?overflow-wrap: anywhere/);
  assert.match(workbench, /\.tabs\s*\{[\s\S]*?overflow-x: auto/);
  assert.match(css, /max-width: 100%/, 'controls are capped at their container');
});

test('no fake dashboard metric or eyebrow heading is present in the markup', () => {
  assert.ok(!/class="[^"]*\b(kicker|eyebrow|overline)\b/.test(html));
  assert.ok(!/class="[^"]*\b(kpi|metric-card|stat-card|sparkline)\b/.test(html));
  assert.ok(!/\.(kpi|metric-card|stat-card|sparkline)\b/.test(css));
});

test('no card is nested inside another card', () => {
  // The three surfaces that carry a border are all terminal: none of them is
  // declared as a descendant of another.
  for (const [outer, inner] of [
    ['.result', '.result'],
    ['.ack', '.ack'],
    ['.preview', '.preview'],
    ['.result', '.ack'],
    ['.ctx-compact', '.result'],
  ]) {
    const pattern = new RegExp(`\\${outer}\\s+\\${inner}\\s*\\{`);
    assert.ok(!pattern.test(css), `${outer} ${inner} would nest a bordered surface`);
  }
});

test('the masthead states execution capability in the first viewport', () => {
  assert.match(html, /id="capability"[^>]*data-can-execute="false"/);
  assert.match(html, /id="capability-label"/);
  assert.match(world, /\.mh-capability\[data-can-execute='true'\]::before/);
});

test('the source notebook and its hash are visible in the first viewport', () => {
  assert.match(html, /id="source-file"/);
  assert.match(html, /id="source-hash"/);
  assert.match(html, /citadel-publish-contract-tests\.ipynb/);
});
