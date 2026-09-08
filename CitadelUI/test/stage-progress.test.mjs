import assert from 'node:assert/strict';
import test from 'node:test';

import { ATTACH_STAGES, CONNECT_STAGES, LOCAL_ATTACH_STAGES, StageTracker, SLOW_STAGE_MS } from '../web/js/stage-progress.mjs';
import { installDom } from './_dom-stub.mjs';

/**
 * Progress the product can actually justify.
 *
 * The rule these tests hold the tracker to is that it never claims more than has
 * happened: a stage becomes active when its await starts, done when that await
 * returns, and a failure stops exactly where it stopped rather than resetting.
 */
test('a stage is only complete once a later stage has actually begun', () => {
  const tracker = new StageTracker(CONNECT_STAGES);
  assert.deepEqual(
    tracker.list().map((stage) => stage.state),
    ['pending', 'pending', 'pending', 'pending']
  );

  tracker.begin('token');
  assert.equal(tracker.list()[0].state, 'active');
  assert.equal(tracker.running, true);

  tracker.begin('auth');
  // The previously active stage must settle, or it keeps spinning behind a step
  // that has already moved on.
  assert.equal(tracker.list()[0].state, 'done');
  assert.equal(tracker.list()[1].state, 'active');
});

test('a failure keeps completed stages and names the exact stage that failed', () => {
  const tracker = new StageTracker(CONNECT_STAGES);
  tracker.begin('token');
  tracker.begin('auth');
  tracker.fail('Connection failed: bad credentials');

  const states = Object.fromEntries(tracker.list().map((stage) => [stage.id, stage.state]));
  assert.equal(states.token, 'done', 'work that succeeded is still shown as done');
  assert.equal(states.auth, 'failed');
  assert.equal(states.repos, 'pending', 'later stages never ran');
  assert.equal(tracker.failedStage, 'auth');
  assert.equal(tracker.running, false);
  assert.match(tracker.error, /Connection failed/);
});

test('success marks every stage done and stops running', () => {
  const tracker = new StageTracker(CONNECT_STAGES);
  tracker.begin('token');
  tracker.begin('auth');
  tracker.begin('repos');
  tracker.succeed('Connected as octocat');

  assert.deepEqual(
    tracker.list().map((stage) => stage.state),
    ['done', 'done', 'done', 'done']
  );
  assert.equal(tracker.list().at(-1).label, 'Connected as octocat');
  assert.equal(tracker.running, false);
  assert.equal(tracker.error, null);
});

/**
 * The "still waiting" line is time-based, so the clock is injected rather than
 * slept through.
 */
test('a slow stage is only called slow once it really is', () => {
  let now = 1000;
  const tracker = new StageTracker(CONNECT_STAGES, { now: () => now });
  tracker.begin('auth');
  assert.equal(tracker.isSlow(), false);
  now += SLOW_STAGE_MS - 1;
  assert.equal(tracker.isSlow(), false);
  now += 1;
  assert.equal(tracker.isSlow(), true);
  tracker.succeed();
  assert.equal(tracker.isSlow(), false, 'a finished attempt is not waiting for anything');
});

test('constructing a tracker does not notify, so a renderer can close over it', () => {
  // The panel declares its region and its tracker in one scope; a constructor
  // that notified would run the renderer while the region was still in its
  // temporal dead zone.
  let notified = 0;
  const tracker = new StageTracker(CONNECT_STAGES, { onChange: () => (notified += 1) });
  assert.equal(notified, 0);
  tracker.reset();
  assert.equal(notified, 1, 'an explicit reset still notifies');
});

test('the rendered region announces progress politely and failure as an alert', async () => {
  installDom();
  const { createStageRegion } = await import(`../web/js/stage-progress.mjs?dom=${Math.random()}`);
  const region = createStageRegion({ label: 'GitHub connection progress' });
  const tracker = new StageTracker(CONNECT_STAGES, { onChange: (t) => region.update(t) });

  assert.equal(region.list.getAttribute('role'), 'status');
  assert.equal(region.list.getAttribute('aria-live'), 'polite');
  assert.equal(region.failure.getAttribute('role'), 'alert');
  assert.equal(region.list.getAttribute('aria-label'), 'GitHub connection progress');

  region.update(tracker);
  assert.equal(region.root.hidden, true, 'nothing to say before an attempt starts');

  tracker.begin('token');
  assert.equal(region.root.hidden, false);
  assert.equal(region.failure.hidden, true);

  tracker.begin('auth');
  tracker.fail('Connection failed: the token was rejected.');
  assert.equal(region.failure.hidden, false);
  assert.match(region.failure.textContent, /Connection failed/);

  const items = region.list.children;
  assert.equal(items.length, CONNECT_STAGES.length);
  // State reaches assistive technology as words, not only as a glyph.
  assert.match(items[0].getAttribute('aria-label'), /complete$/);
  assert.match(items[1].getAttribute('aria-label'), /failed$/);
  assert.match(items[2].getAttribute('aria-label'), /not started$/);
});

test('a slow local attachment never claims GitHub or branch work while remote wording is preserved', async () => {
  installDom();
  const { createStageRegion } = await import('../web/js/stage-progress.mjs');
  let now = 1000;
  const region = createStageRegion({ waitingMessage: 'Still working with the local folder.' });
  const tracker = new StageTracker(LOCAL_ATTACH_STAGES, { now: () => now });
  tracker.begin('read');
  now += SLOW_STAGE_MS;
  region.update(tracker);
  const waiting = region.root.children.find((node) => node.className === 'stage-waiting');
  assert.equal(waiting.hidden, false);
  assert.equal(waiting.textContent, 'Still working with the local folder.');
  assert.equal(tracker.list()[0].state, 'done');
  assert.equal(tracker.list()[1].state, 'active');
  assert(ATTACH_STAGES.some((stage) => stage.label === 'Revalidating Citadel branch'));
  assert(ATTACH_STAGES.some((stage) => stage.label === 'Creating or recovering working branch'));
});
