import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../web/css/components.css', import.meta.url), 'utf8');

assert.match(index, /class="tb-brand-copy"/);
assert.match(index, /class="tb-name">Citadel</);
assert.match(index, /class="tb-mode">Control Panel</);
assert.match(index, /class="tb-crumb tb-environment"/);
assert.match(index, /class="tb-local-label"[^>]*>Repository</);
assert.match(index, /class="tb-copy-mark"[^>]*>Copy</);

assert.match(app, /class: 'tb-status-group'/);
assert.match(app, /class: 'tb-command-set'/);
assert.match(app, /blocking\.length \? ' has-errors'/);
assert.match(app, /warnings\.length \? ' has-warnings'/);

assert.match(styles, /\.tb-brand-copy\s*\{[\s\S]*?display:\s*grid/);
// The active environment is the primary selection on the blue frame, so it
// takes the frame's raised surface rather than the paper brand wash.
assert.match(styles, /\.tb-environment\s*\{[\s\S]*?background:\s*var\(--nav-active\)/);
assert.match(styles, /\.tb-actions\s*\{[\s\S]*?border-left:\s*1px solid var\(--nav-rule\)/);
assert.match(styles, /\.tb-pending\.has-errors\s*\{[\s\S]*?var\(--header-danger-wash\)/);
assert.doesNotMatch(styles, /\.tb-local:hover,\s*\.environment-path:hover/);
assert.match(styles, /@media \(max-width: 48rem\)[\s\S]*?\.tb-brand-copy\s*\{[\s\S]*?display:\s*none/);
assert.match(
  styles,
  /@media \(max-width: 48rem\)[\s\S]*?\.tb-command-set > \*\s*\{[\s\S]*?flex:\s*0 1 auto/
);

console.log('Command bar hierarchy and responsive structure checks passed.');
