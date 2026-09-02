/**
 * Waiting has to look like waiting.
 *
 * A slow GitHub call and a crashed tab are indistinguishable when the screen
 * stops moving, and the user's response to that ambiguity is to reload — which
 * is precisely how unsaved edits get lost. So anything that waits must animate,
 * must announce itself, and must not offer a control that hides it.
 *
 * These are source-contract assertions, in the same style as the other
 * `app.mjs` suites: the module owns browser globals and cannot be imported
 * under Node, but the guarantees below are structural and are worth pinning
 * anyway. Each one fails if the behaviour is removed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Normalised to LF: the working tree is CRLF on Windows, and a delimiter of
// '\n}\n' would otherwise never match, silently widening every slice below to
// the rest of the file and making these assertions meaningless.
const app = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('every async entry point marks the status as pending', () => {
  // `withStatus` is the single funnel the product already routes every await
  // through. Marking pending there is what makes the animation universal rather
  // than something each call site has to remember.
  const fn = app.slice(app.indexOf('async function withStatus'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /setStatus\(\s*message\s*,\s*'info'\s*,\s*true\s*,\s*true\s*\)/);
});

test('a pending status is rendered as busy, not merely as new text', () => {
  assert.match(app, /els\.status\.setAttribute\('aria-busy',\s*'true'\)/);
  // And it must be cleared again, or the region lies about being busy forever.
  assert.match(app, /els\.status\.removeAttribute\('aria-busy'\)/);
});

test('a pending status carries the pending class the animation hangs off', () => {
  assert.match(app, /status-\$\{tone\}\$\{pending \? ' status-pending' : ''\}/);
});

test('work in flight offers no dismiss control', () => {
  // Dismissing an in-flight operation would leave it running with nothing on
  // screen to say so — the exact state this feature exists to prevent.
  const render = app.slice(app.indexOf('function renderStatus'));
  const body = render.slice(0, render.indexOf('\n}\n'));
  assert.match(body, /pending\s*\n?\s*\?\s*null/);
  assert.match(body, /'aria-label':\s*'Dismiss notification'/);
});

test('a long wait escalates to an honest reassurance, not a fake percentage', () => {
  assert.match(app, /STILL_WORKING_AFTER_MS/);
  assert.match(app, /still working/);
  // Nothing here knows how long GitHub will take, so nothing may claim to.
  // Comments are stripped first: prose about percentages is not a percentage.
  const render = app.slice(app.indexOf('function renderStatus'));
  const body = render.slice(0, render.indexOf('\n}\n')).replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(body, /%/);
});

test('the escalation is time-based and cleared with the status', () => {
  assert.match(app, /pendingTicker\s*=\s*setTimeout\(renderStatus,\s*STILL_WORKING_AFTER_MS\)/);
  // A stale ticker would re-render a status that has already been replaced.
  assert.match(app, /clearTimeout\(pendingTicker\)/);
});

test('the pending marker actually animates', () => {
  assert.match(css, /\.status-pending::before\s*\{[^}]*animation:\s*status-spin/);
  assert.match(css, /@keyframes status-spin\s*\{[^}]*rotate\(360deg\)/);
});

test('reduced motion still gets a visible marker, not a frozen ring', () => {
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  const block = reduced.slice(0, reduced.indexOf('\n}\n', reduced.indexOf('.status-pending')));
  assert.match(block, /\.status-pending::before/);
  assert.match(block, /animation:\s*none/);
  // Without a solid fill this degrades to a static ring, which reads as a
  // broken control rather than as progress.
  assert.match(block, /background:\s*var\(--brand\)/);
});

test('a settled status keeps its severity dot and does not spin', () => {
  // The spinner replaces the severity dot only while pending; success and error
  // must still read as success and error.
  assert.match(css, /\.status-ok::before\s*\{[^}]*background:\s*var\(--success\)/);
  assert.match(css, /\.status-error::before\s*\{[^}]*background:\s*var\(--danger\)/);
});
