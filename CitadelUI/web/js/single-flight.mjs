/**
 * A mutating user action must not be re-entrant.
 *
 * ## The defect this exists to fix
 *
 * `commitSave` was bound straight to a button — `onclick: commitSave` — with
 * nothing between the click and the work. A second click while the first
 * `await` was outstanding started a second save, and both had already read the
 * same branch head and the same content hash. Two commits, identical tree,
 * identical parent, three seconds apart. The first won the ref update; the
 * second was refused and rescued onto a branch of its own.
 *
 * The user saw one action and got two branches.
 *
 * ## Why this is a module and not a flag at the call site
 *
 * The invariant was already implemented, inconsistently, in three shapes:
 * `rowOperation` disabled its row's buttons through a `setBusy` callback,
 * `environmentOperation` was built from the same factory and passed none, and
 * the three save paths had neither. Nothing owned the rule, so every trigger
 * improvised and the ones that forgot were invisible until a user double
 * clicked. Centralising it means a call site opts *out* by not using it, which
 * is reviewable, rather than opting in by remembering.
 *
 * ## Ignored, never queued
 *
 * A second click is not a second intention. Queueing it would run the same save
 * twice in sequence — with a stale reviewed hash the second time — which is the
 * very outcome this prevents. So re-entry is dropped and the caller is told
 * nothing happened.
 *
 * ## Visibly busy, not merely inert
 *
 * A control that silently ignores clicks is indistinguishable from a broken
 * one, and a user whose click does nothing clicks again. The trigger is
 * disabled and marked `aria-busy` for the duration, so the refusal is something
 * the user can see and a screen reader announces.
 */

/**
 * Returned when a call was dropped because the same key was already running.
 *
 * A distinct sentinel rather than `undefined`, because `undefined` is what the
 * product's own `withStatus` returns when an operation *failed*. Collapsing
 * "did not start" into "failed" would make a dropped double-click look like an
 * error to every caller that checks the result.
 */
export const SKIPPED = Symbol('single-flight-skipped');

/**
 * A keyed set of operations, at most one of each in flight.
 *
 * Keys are independent: saving a parameter must not block removing an unrelated
 * workspace. What must not overlap is one key with itself.
 */
export function createSingleFlight() {
  const active = new Map();

  return {
    isBusy(key) {
      return active.has(key);
    },

    /** Every key currently running, for tests and for busy-state rendering. */
    active() {
      return [...active.keys()];
    },

    /**
     * Run `fn` unless `key` is already running, in which case return `SKIPPED`.
     *
     * The promise is registered before the first `await` inside `fn` can yield,
     * so two synchronous invocations in the same tick — exactly what a double
     * click produces — cannot both pass the check.
     */
    run(key, fn) {
      if (active.has(key)) return SKIPPED;
      const promise = (async () => fn())().finally(() => {
        // Only clear our own entry. A key released by a later run would let a
        // third invocation overlap the second.
        if (active.get(key) === promise) active.delete(key);
      });
      active.set(key, promise);
      return promise;
    },
  };
}

/** The application's lock. One per document; call sites share it by key. */
export const mutations = createSingleFlight();

/**
 * Mark a control busy, and return the exact restore that undoes it.
 *
 * The prior disabled state is captured rather than assumed, so a control that
 * was already disabled for its own reasons is not silently enabled when the
 * operation finishes.
 */
export function markBusy(control) {
  if (!control) return () => {};
  const wasDisabled = Boolean(control.disabled);
  const hadBusy = control.getAttribute?.('aria-busy') ?? null;
  control.disabled = true;
  control.setAttribute?.('aria-busy', 'true');
  control.classList?.add('is-busy');
  return () => {
    control.disabled = wasDisabled;
    control.classList?.remove('is-busy');
    if (hadBusy === null) control.removeAttribute?.('aria-busy');
    else control.setAttribute?.('aria-busy', hadBusy);
  };
}

/**
 * Wrap a click handler so the action it triggers runs at most once at a time.
 *
 * The control comes from the event, so this works for a button built inline by
 * `h()` without the caller having to hold a reference to it. When there is no
 * event — a programmatic call — the lock still applies; only the visual busy
 * state is absent, because there is nothing on screen that was clicked.
 *
 * `key` defaults to the wrapper itself, which gives each binding its own lock.
 * A shared string key serialises distinct controls that drive the same
 * operation.
 */
export function guardedHandler(fn, options = {}) {
  const registry = options.registry || mutations;
  // Identity, not a name. Two bindings created from the same factory must not
  // collide, and a caller that *wants* them to share a lock says so explicitly.
  const key = options.key || Symbol('guarded-handler');
  return async function guarded(event) {
    // Checked before the control is touched, so a dropped re-entry leaves no
    // trace on a button that another invocation is already responsible for.
    if (registry.isBusy(key)) return SKIPPED;
    const control = options.control || event?.currentTarget || null;
    const restore = markBusy(control);
    try {
      const outcome = registry.run(key, () => fn.call(this, event));
      if (outcome === SKIPPED) return SKIPPED;
      return await outcome;
    } finally {
      restore();
    }
  };
}
