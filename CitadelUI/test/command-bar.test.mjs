import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../web/css/components.css', import.meta.url), 'utf8');

test('command bar separates global identity from contextual document actions', () => {
  const header = index.slice(index.indexOf('<header class="titleblock"'), index.indexOf('<section class="commandbar"'));
  const commands = index.slice(index.indexOf('<section class="commandbar"'), index.indexOf('<nav id="sidebar"'));
  assert.match(header, /class="tb-name">Citadel</);
  assert.match(header, /id="workspace-switch"/);
  assert.match(header, /id="environment-name"/);
  assert.match(header, /class="global-actions"/);
  assert.match(header, /id="global-settings"/);
  assert.match(header, /href="\/debug\.html"/);
  assert.doesNotMatch(header, /id="tb-actions"/);
  for (const id of ['document-label', 'repo-path', 'source-kind', 'write-target', 'tb-actions']) {
    assert(commands.includes(`id="${id}"`), `${id} remains in document context.`);
  }
});

test('command bar keeps existing tools grouped and a stable primary review action', () => {
  assert.match(app, /class: 'tb-status-group'/);
  assert.match(app, /class: 'tb-command-set'/);
  assert.match(app, /id: 'review-save'/);
  assert.match(app, /'aria-describedby': 'save-state'/);
  assert.match(app, /'aria-label': 'Workspace tools'/);
  assert.match(app, /'aria-label': 'Experimental tools'/);
  assert.match(app, /blocking\.length \? ' has-errors'/);
  assert.match(app, /warnings\.length \? ' has-warnings'/);
  assert.match(styles, /\.tb-command-set #review-save\s*\{[^}]*min-width:/);
});

test('command bar uses restrained shared tokens and retains compact structural rules', () => {
  assert.match(styles, /\.tb-brand-copy\s*\{[\s\S]*?display:\s*grid/);
  assert.match(styles, /\.commandbar\s*\{[^}]*background:\s*var\(--sheet\)/);
  assert.match(styles, /\.tb-environment\s*\{[^}]*color:\s*var\(--nav-ink\)/);
  assert.doesNotMatch(styles, /\.tb-environment\s*\{[^}]*background:/);
  assert.match(styles, /\.tb-actions\s*\{[^}]*border-left:\s*0/);
  assert.match(styles, /\.tb-pending\.has-errors\s*\{[^}]*color:\s*var\(--danger\)/);
  assert.doesNotMatch(styles, /\.tb-local:hover,\s*\.environment-path:hover/);
  assert.match(styles, /@media \(max-width: 48rem\)[\s\S]*?\.tb-brand-copy\s*\{[^}]*display:\s*none/);
  assert.match(styles, /@media \(max-width: 48rem\)[\s\S]*?\.tb-command-set > \*\s*\{[^}]*flex:\s*0 1 auto/);
});
