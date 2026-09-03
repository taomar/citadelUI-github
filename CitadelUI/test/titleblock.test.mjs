/**
 * The frame across the top says where you are and where a write will land.
 *
 * It used to say it twice. On the catalogue the path line and the source line
 * both fall back to the same sentence, so the frame spent one of its two rows
 * repeating the other — under a hardcoded "Repository" label that, on that
 * screen, was not describing a repository. That is what made it feel oversized:
 * the height was real, the second row's content was not.
 *
 * Source-contract assertions, in the same style as the other `app.mjs` suites:
 * the module owns browser globals and cannot be imported under Node.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lf = (s) => s.replace(/\r\n/g, '\n');
const app = lf(readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8'));
const html = lf(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'));
const components = lf(readFileSync(new URL('../web/css/components.css', import.meta.url), 'utf8'));

test('the source line is suppressed when it only repeats the path above it', () => {
  const fn = app.slice(app.indexOf('function setSourceLine'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /value === els\.repoPath\.textContent/);
  assert.match(body, /els\.localPathCopy\.hidden = redundant/);
  // And it must return before writing, or it would fill a hidden row anyway.
  assert.match(body, /if \(redundant\) return;/);
});

test('hiding the row actually collapses it', () => {
  // `.tb-local` sets its own display, which outranks the `hidden` attribute.
  // Without this rule the row stays visible while reporting itself hidden.
  assert.match(components, /\.tb-local\[hidden\]\s*\{[^}]*display:\s*none/);
});

test('the source label describes what it is showing', () => {
  // The label was hardcoded in markup, so a GitHub connection sentence appeared
  // beneath the word "Repository" on a screen with no repository selected.
  assert.match(html, /id="local-path-label"/);
  assert.match(app, /label:\s*sourceKind === 'github' \? 'Repository' : 'Folder'/);
  assert.match(app, /label:\s*isGitHub \? 'Repository' : 'Folder'/);
});

test('an empty actions column does not paint a divider to nothing', () => {
  assert.match(components, /\.tb-actions:empty\s*\{[\s\S]*?display:\s*none/);
  assert.match(components, /\.tb-actions:empty\s*\{[\s\S]*?border-left:\s*0/);
});

test('the frame is sized for the row it actually has', () => {
  // 3.5rem was the floor when the frame carried two lines. Left in place it is
  // dead space above a single 22px row.
  assert.match(components, /\.titleblock\s*\{[^}]*min-height:\s*3rem/);
  assert.doesNotMatch(components, /\.titleblock\s*\{[^}]*min-height:\s*3\.5rem/);
});

test('the brand divider is drawn from the frame ramp, not the sheet ramp', () => {
  // `--rule` is a paper tint. On the navy frame it read as a bright bar, which
  // is what made the brand look bolted on rather than part of the frame.
  const brand = components.slice(components.indexOf('.tb-brand {'));
  const block = brand.slice(0, brand.indexOf('\n}\n'));
  assert.match(block, /border-right:\s*1px solid var\(--nav-rule\)/);
  assert.doesNotMatch(block, /border-right:\s*1px solid var\(--rule\)/);
});

test('startup does not announce a wait while the catalogue is being read', () => {
  // `ensureWorkspace` resolves only once a workspace is chosen, so announcing
  // before it left a pending toast escalating to "still working" for as long as
  // the user browsed — a false alarm produced by the progress feature itself.
  const init = app.slice(app.indexOf("els.shell.dataset.workspace = 'setup'"));
  const upToEnsure = init.slice(0, init.indexOf('await ensureWorkspace()'));
  assert.doesNotMatch(upToEnsure, /setStatus\(/);
  // It is announced immediately after, where the work really is.
  const afterEnsure = init.slice(init.indexOf('await ensureWorkspace()'));
  assert.match(afterEnsure.slice(0, 400), /setStatus\('Opening workspace/);
});
