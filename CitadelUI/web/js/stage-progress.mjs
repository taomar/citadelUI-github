/**
 * Honest progress for multi-step remote work.
 *
 * Connecting to GitHub and reopening a saved environment are both several
 * distinct round trips, and a single spinner cannot say which one is slow or
 * which one failed. This models the real stages instead: each one is entered
 * when its await begins and completed when that await returns, so the display
 * can never claim progress the product has not actually made.
 *
 * There are deliberately no percentages. A percentage would have to be invented
 * -- nothing here knows how long GitHub will take -- and an invented number is a
 * worse answer than naming the step that is running.
 */

/** How long a stage may run before the wait itself is worth mentioning. */
export const SLOW_STAGE_MS = 4000;

export class StageTracker {
  /**
   * @param {Array<{id: string, label: string}>} stages ordered, and fixed for
   *   the lifetime of one attempt.
   */
  constructor(stages, options = {}) {
    this.definition = stages.map((stage) => ({ ...stage }));
    this.onChange = options.onChange || (() => {});
    this.now = options.now || (() => Date.now());
    // Initialised without notifying: a renderer that closes over this instance
    // is still in its own temporal dead zone while this constructor runs.
    this.initialize();
  }

  initialize() {
    this.states = new Map(this.definition.map((stage) => [stage.id, 'pending']));
    this.labels = new Map(this.definition.map((stage) => [stage.id, stage.label]));
    this.active = null;
    this.activeSince = null;
    this.error = null;
    this.failedStage = null;
    this.running = false;
  }

  reset() {
    this.initialize();
    this.onChange(this);
  }

  /** Replace one stage's wording once the specific subject is known. */
  relabel(id, label) {
    if (!this.labels.has(id)) return;
    this.labels.set(id, label);
    this.onChange(this);
  }

  begin(id, label) {
    if (!this.states.has(id)) return;
    if (label) this.labels.set(id, label);
    // Entering a stage means everything before it finished — including the stage
    // that was active, which would otherwise keep spinning behind a later step.
    for (const stage of this.definition) {
      if (stage.id === id) break;
      const state = this.states.get(stage.id);
      if (state === 'pending' || state === 'active') this.states.set(stage.id, 'done');
    }
    this.states.set(id, 'active');
    this.active = id;
    this.activeSince = this.now();
    this.running = true;
    this.error = null;
    this.failedStage = null;
    this.onChange(this);
  }

  complete(id, label) {
    if (!this.states.has(id)) return;
    if (label) this.labels.set(id, label);
    this.states.set(id, 'done');
    if (this.active === id) {
      this.active = null;
      this.activeSince = null;
    }
    this.onChange(this);
  }

  /** Finish successfully, marking every remaining stage done. */
  succeed(label) {
    const last = this.definition.at(-1);
    if (last && label) this.labels.set(last.id, label);
    for (const stage of this.definition) this.states.set(stage.id, 'done');
    this.active = null;
    this.activeSince = null;
    this.running = false;
    this.error = null;
    this.failedStage = null;
    this.onChange(this);
  }

  /**
   * Stop at the stage that failed.
   *
   * Completed stages keep their state: the user needs to see how far the attempt
   * got, not just that it ended.
   */
  fail(message, id = null) {
    const target = id || this.active || this.definition.find((stage) => this.states.get(stage.id) !== 'done')?.id;
    if (target) this.states.set(target, 'failed');
    this.failedStage = target || null;
    this.error = message || 'The operation failed.';
    this.active = null;
    this.activeSince = null;
    this.running = false;
    this.onChange(this);
  }

  /** True once the active stage has been running long enough to say so. */
  isSlow() {
    return Boolean(this.activeSince) && this.now() - this.activeSince >= SLOW_STAGE_MS;
  }

  activeLabel() {
    return this.active ? this.labels.get(this.active) : null;
  }

  list() {
    return this.definition.map((stage) => ({
      id: stage.id,
      label: this.labels.get(stage.id),
      state: this.states.get(stage.id),
    }));
  }
}

/** The four real round trips of a GitHub connect, in order. */
export const CONNECT_STAGES = Object.freeze([
  { id: 'token', label: 'Validating token format' },
  { id: 'auth', label: 'Authenticating with GitHub' },
  { id: 'repos', label: 'Loading authorized repositories' },
  { id: 'ready', label: 'Connected' },
]);

/** Reopening a saved environment, from stored metadata to a usable workspace. */
export const RECONNECT_STAGES = Object.freeze([
  { id: 'saved', label: 'Checking saved environment' },
  { id: 'session', label: 'Restoring GitHub connection' },
  { id: 'access', label: 'Verifying repository access' },
  { id: 'compatible', label: 'Checking the repository is a compatible Citadel repository' },
  { id: 'workspace', label: 'Loading Citadel workspace' },
  { id: 'ready', label: 'Environment ready' },
]);

/**
 * Attaching a repository, from the last check to an open workspace.
 *
 * The first three happen inside one request, and they are still listed
 * separately because they are the three things that can be *left behind* if the
 * answer is lost — and because "Creating or recovering working branch" is the
 * only honest thing to display while an ambiguous result is being reconciled.
 * A single spinner there would say "failed" for an operation the server
 * completed.
 *
 * `metadata` is separate from `branch` for the same reason: a metadata failure
 * after a branch succeeded must resume at metadata, and the display has to be
 * able to say which of the two is being retried.
 */
export const ATTACH_STAGES = Object.freeze([
  { id: 'revalidate', label: 'Revalidating Citadel branch' },
  { id: 'reserve', label: 'Reserving attachment' },
  { id: 'branch', label: 'Creating or recovering working branch' },
  { id: 'metadata', label: 'Saving workspace metadata' },
  { id: 'open', label: 'Opening workspace' },
  { id: 'ready', label: 'Ready' },
]);

/**
 * Render a tracker into a compact inline region.
 *
 * Two live regions, not one: progress is polite so it does not interrupt, and a
 * failure is an alert because it ends the attempt and needs an answer. Building
 * with `document` directly keeps this usable from both the settings screens and
 * the setup panel, which construct DOM in different styles.
 */
export function createStageRegion(options = {}) {
  const root = document.createElement('div');
  root.className = 'stage-region';
  root.hidden = true;

  const list = document.createElement('ol');
  list.className = 'stage-list';
  list.setAttribute('role', 'status');
  list.setAttribute('aria-live', 'polite');
  if (options.label) list.setAttribute('aria-label', options.label);

  const waiting = document.createElement('p');
  waiting.className = 'stage-waiting';
  waiting.setAttribute('role', 'status');
  waiting.setAttribute('aria-live', 'polite');
  waiting.hidden = true;

  const failure = document.createElement('p');
  failure.className = 'field-error stage-error';
  failure.setAttribute('role', 'alert');
  failure.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'stage-actions';
  actions.hidden = true;

  root.append(list, waiting, failure, actions);

  function update(tracker) {
    const stages = tracker.list();
    // Once an attempt has ended cleanly there is nothing to narrate.
    const finished = !tracker.running && !tracker.error;
    const idle = stages.every((stage) => stage.state === 'pending');
    root.hidden = idle || (finished && !options.keepOnSuccess);
    list.replaceChildren(
      ...stages.map((stage) => {
        const item = document.createElement('li');
        item.className = `stage stage-${stage.state}`;
        // The state is carried in the accessible name rather than a
        // visually-hidden span, so no new global utility class is needed and the
        // glyph stays purely decorative.
        item.setAttribute(
          'aria-label',
          stage.state === 'done'
            ? `${stage.label}: complete`
            : stage.state === 'failed'
              ? `${stage.label}: failed`
              : stage.state === 'active'
                ? `${stage.label}: in progress`
                : `${stage.label}: not started`
        );
        const mark = document.createElement('span');
        mark.className = 'stage-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = stage.state === 'done' ? '\u2713' : stage.state === 'failed' ? '\u2717' : '';
        const text = document.createElement('span');
        text.className = 'stage-label';
        text.textContent = stage.label;
        item.append(mark, text);
        return item;
      })
    );

    const slow = tracker.running && tracker.isSlow();
    waiting.hidden = !slow;
    waiting.textContent = slow
      ? 'Still waiting for GitHub\u2026 large accounts and organisation approval can take a moment.'
      : '';

    failure.hidden = !tracker.error;
    failure.textContent = tracker.error || '';
    actions.hidden = !tracker.error || !actions.children.length;
  }

  return { root, list, failure, actions, update };
}
