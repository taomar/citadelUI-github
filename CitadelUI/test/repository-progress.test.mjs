import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, readText } from './_dom-stub.mjs';

installDom();
const { createRepositoryProgress, STATUS_DELAY_MS, ACTIVITY_DELAY_MS } = await import('../web/js/repository-progress.mjs');
const nodes = (root) => [root, ...root.children.flatMap(nodes)];
const find = (root, name) => nodes(root).find((node) => node.className.split(' ').includes(name));
const timestamp = Date.parse('2026-09-08T01:00:00Z');
const copying = (overrides = {}) => ({
  id: 'import-one', state: 'copying', stageId: 'objects', stage: 'Copying the complete source snapshot.',
  startedAt: new Date(timestamp - 120_000).toISOString(), updatedAt: new Date(timestamp).toISOString(),
  progress: { phase: 'copy', completed: 279, total: 363, unit: 'files', currentPath: 'assets/large-example.png' },
  ...overrides,
});

test('repository progress: idle is hidden and an unmeasured request never invents a percentage', () => {
  const view = createRepositoryProgress({ now: () => timestamp });
  view.update({});
  assert.equal(view.root.hidden, true);
  view.update({ busy: true });
  assert.equal(view.root.hidden, false);
  assert.equal(find(view.root, 'repository-progress-meter').hidden, true);
  assert.match(readText(view.root), /Contacting GitHub/);
  assert.doesNotMatch(readText(view.root), /\d+%/);
});

test('repository progress: confirmed copy counts, current item and elapsed time are visible', () => {
  const view = createRepositoryProgress({ now: () => timestamp });
  view.update({ operation: copying(), lastStatusAt: timestamp });
  assert.match(readText(view.root), /279 of 363 files copied \(76% of file copy\)/);
  assert.match(readText(view.root), /Current item: assets\/large-example\.png/);
  assert.match(readText(view.root), /Elapsed 2m 0s/);
  const meter = find(view.root, 'repository-progress-meter');
  assert.equal(meter.getAttribute('max'), '363');
  assert.equal(meter.getAttribute('value'), '279');
  assert.equal(meter.getAttribute('aria-label'), 'File copy');
  assert.match(meter.getAttribute('aria-valuetext'), /279 of 363/);
  assert.equal(find(view.root, 'repository-progress-count').getAttribute('aria-live'), 'polite');
  assert.equal(find(view.root, 'repository-progress-timing').getAttribute('aria-live'), 'off');
});

test('repository progress: verification uses its own counter, not the completed copy counter', () => {
  const view = createRepositoryProgress({ now: () => timestamp });
  const verifying = copying({ state: 'verifying', stageId: 'verify-snapshot' });
  view.update({ operation: verifying, lastStatusAt: timestamp });
  assert.equal(find(view.root, 'repository-progress-meter').hidden, true, 'copy counts cannot stand in for verification');
  view.update({ operation: { ...verifying, progress: { phase: 'verify', completed: 3, total: 363, unit: 'files' } }, lastStatusAt: timestamp });
  assert.match(readText(view.root), /3 of 363 files verified/);
  assert.match(readText(view.root), /snapshot is on GitHub/);
  assert.equal(find(view.root, 'repository-progress-meter').getAttribute('aria-label'), 'File verification');
  view.update({ operation: { ...verifying, stageId: 'verify-settings', progress: { phase: 'verify', completed: 363, total: 363, unit: 'files' } }, lastStatusAt: timestamp });
  assert.equal(find(view.root, 'repository-progress-meter').hidden, true);
  assert.match(readText(view.root), /All files have been verified. Confirming private visibility/);
  assert.doesNotMatch(readText(find(view.root, 'repository-progress-heading')), /Repository ready/);
});

test('repository progress: publication is separate from copying and has no invented overall percentage', () => {
  const view = createRepositoryProgress({ now: () => timestamp });
  view.update({ operation: copying({ stageId: 'publishing-main' }), lastStatusAt: timestamp });
  assert.match(readText(view.root), /Publishing the snapshot on main/);
  assert.equal(find(view.root, 'repository-progress-meter').hidden, true);
});

test('repository progress: unchanged file counts expose a long wait even when status polling succeeds', () => {
  let clock = timestamp;
  const view = createRepositoryProgress({ now: () => clock });
  view.update({ operation: copying(), lastStatusAt: clock });
  clock += ACTIVITY_DELAY_MS + 1000;
  view.update({ operation: copying(), lastStatusAt: clock });
  assert.match(readText(view.root), /Waiting for the next confirmed activity/);
  assert.match(readText(view.root), /Elapsed 2m 16s/);
  assert.equal(find(view.root, 'repository-progress-meter').getAttribute('value'), '279');
  assert.ok(find(view.root, 'repository-progress-heading').classList.contains('stage-active'));
});

test('repository progress: delayed and failed status responses stop implying a live connection', () => {
  let clock = timestamp;
  const view = createRepositoryProgress({ now: () => clock });
  view.update({ operation: copying(), lastStatusAt: clock });
  clock += STATUS_DELAY_MS;
  view.tick();
  assert.match(readText(view.root), /A status response is taking longer than expected/);
  assert.equal(find(view.root, 'repository-progress-heading').classList.contains('stage-active'), false);
  view.update({ operation: copying(), lastStatusAt: timestamp, statusFailed: true });
  assert.match(readText(view.root), /Live updates were interrupted. Retrying automatically/);
  assert.match(readText(view.root), /Do not create another repository/);
  assert.equal(find(view.root, 'repository-progress-meter').getAttribute('value'), '279');
});

test('repository progress: cooldown and ambiguous-write recovery remain explicit', () => {
  const view = createRepositoryProgress({ now: () => timestamp });
  view.update({ operation: copying({ state: 'paused', retryAt: timestamp + 65_000 }), lastStatusAt: timestamp });
  assert.match(readText(view.root), /Waiting to resume/);
  assert.match(readText(view.root), /Retry in 1m 5s/);
  assert.match(readText(view.root), /private repository is retained/);
  view.update({ operation: copying(), uncertain: true, lastStatusAt: timestamp });
  assert.match(readText(view.root), /Confirming the last request/);
  assert.equal(find(view.root, 'repository-progress-meter').hidden, true);
});

test('repository progress: completion is persistent, stops motion and freezes elapsed time', () => {
  let clock = timestamp;
  const view = createRepositoryProgress({ now: () => clock });
  view.update({ operation: copying({ state: 'complete', stageId: 'complete' }), lastStatusAt: clock });
  const before = readText(find(view.root, 'repository-progress-timing'));
  clock += 60_000;
  view.tick();
  assert.equal(readText(find(view.root, 'repository-progress-timing')), before);
  assert.match(readText(view.root), /Continue to repository to choose a branch/);
  assert.ok(find(view.root, 'repository-progress-heading').classList.contains('stage-done'));
  assert.equal(find(view.root, 'repository-progress-meter').hidden, true);
});

test('repository progress: old status payloads and untrusted file names cannot invent progress or markup', () => {
  const view = createRepositoryProgress({ now: () => timestamp });
  view.update({ operation: copying({ state: 'verifying', progress: { completed: 363, total: 363, unit: 'files' } }), lastStatusAt: timestamp });
  assert.equal(find(view.root, 'repository-progress-meter').hidden, true);
  view.update({ operation: copying({
    progress: { phase: 'copy', completed: 1, total: 363, currentPath: '<img src=x onerror=alert(1)>' },
  }), lastStatusAt: timestamp });
  assert.equal(nodes(view.root).some((node) => node.tagName === 'IMG'), false);
  assert.match(readText(view.root), /<img src=x onerror=alert\(1\)>/);
});
