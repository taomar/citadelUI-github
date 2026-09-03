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

/**
 * The toast is not enough on its own.
 *
 * `showModal()` puts a native dialog in the browser's top layer, which is above
 * every z-index, so the fixed status toast is behind the backdrop exactly when
 * the wait is longest — a save. The clicked control stays visible, and
 * `markBusy` already marks it, so the control is the second place progress has
 * to appear.
 */
test('the busy control itself spins, because a dialog hides the toast', () => {
  // Window is generous enough to span the declarations and the comment between
  // the selector and the animation, but still scoped to the same rule block.
  assert.match(css, /\.btn\.is-busy::before[^}]*animation:\s*status-spin/);
  assert.match(css, /\.btn\[aria-busy='true'\]::before/);
});

test('a busy control is not faded into invisibility by the disabled style', () => {
  // `markBusy` disables the control, and `.btn:disabled` sets opacity 0.5.
  // Without restoring opacity the spinner would be half-transparent precisely
  // when it is the only progress on screen.
  assert.match(css, /\.btn\.is-busy,\s*\n\s*\.btn\[aria-busy='true'\]\s*\{[^}]*opacity:\s*1/);
  assert.match(css, /\.btn\.is-busy,\s*\n\s*\.btn\[aria-busy='true'\]\s*\{[^}]*cursor:\s*progress/);
});

test('the control spinner also degrades honestly under reduced motion', () => {
  // Anchored on the rule itself rather than on "the last reduced-motion block",
  // because the stylesheet ends with a global reduced-motion reset that would
  // otherwise satisfy a looser search without proving anything about buttons.
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.btn\.is-busy::before[\s\S]*?animation:\s*none/
  );
});

test('every guarded save marks a control, so the spinner has somewhere to appear', () => {
  // `guardedHandler` resolves the control from the event, so an inline button
  // built by `h()` is marked without the caller holding a reference. If this
  // stopped being true, the CSS above would style nothing.
  const sf = readFileSync(new URL('../web/js/single-flight.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(sf, /const control = options\.control \|\| event\?\.currentTarget \|\| null/);
  assert.match(sf, /control\.classList\?\.add\('is-busy'\)/);
  assert.match(sf, /control\.setAttribute\?\.\('aria-busy', 'true'\)/);
});
