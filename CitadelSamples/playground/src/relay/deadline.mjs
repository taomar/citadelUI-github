/**
 * Shared "race a promise against a deadline" primitive.
 *
 * Every external boundary the relay crosses (a tenant-policy directory
 * lookup, a managed-identity token fetch, a Key Vault fetch, the http
 * executor, and the body-parsing step of the first two) is bounded the
 * same way: a `signal` that fires no later than the run's own deadline.
 * Passing `signal` down to a dependency is not enough by itself — a
 * dependency (in production, or a test double) that simply IGNORES its
 * `signal` argument would otherwise hang the caller forever even though
 * the signal fired right on schedule. Every one of those call sites must
 * therefore also RACE its own promise against the same signal here, not
 * merely hand the signal down and hope.
 *
 * Neither helper below ever cancels or otherwise touches `promise` itself
 * — there is no way to force an arbitrary injected dependency to actually
 * stop working, and this module does not pretend to. It only bounds how
 * long the CALLER waits on it. Because of that, `promise` may still settle
 * (successfully or not) long after the race here has already gone the
 * other way; that eventual settlement is always observed (a no-op handler
 * is unconditionally attached) so an abandoned dependency can never surface
 * as an unhandled promise rejection later.
 */

/** @param {string} message */
export function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Attach a no-op rejection handler so an eventually-abandoned promise can never become an unhandled rejection. */
function observeEventualSettlement(promise) {
  Promise.resolve(promise).catch(() => {});
}

/**
 * Race `promise` against `signal` firing. If `signal` fires first, this
 * REJECTS with a fresh `AbortError` (`name === 'AbortError'`) — never
 * `promise`'s own eventual settlement. If `promise` settles first, this
 * settles the exact same way. Used where the caller wants a single
 * try/catch to treat "the dependency itself failed" and "the dependency
 * ran past its own budget" identically (both surface as a rejection here).
 *
 * @param {Promise} promise
 * @param {AbortSignal} [signal]
 * @param {string} [message]
 */
export function raceAbortSignal(promise, signal, message = 'Aborted.') {
  observeEventualSettlement(promise);
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(message));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(message));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Sentinel returned by `raceDeadline` when `signal` fires before `promise` settles. */
export const DEADLINE_EXCEEDED = Symbol('relay-deadline-exceeded');

/**
 * Race `promise` against `signal` firing, like `raceAbortSignal`, but
 * RESOLVES to the fixed sentinel `DEADLINE_EXCEEDED` instead of rejecting
 * when `signal` wins — for a caller (namely `server.mjs`) that wants to
 * turn "timed out waiting on this dependency" into its own controlled
 * response, without needing to distinguish that from an ordinary
 * `Promise` rejection via a thrown error's shape.
 *
 * @param {Promise} promise
 * @param {AbortSignal} [signal]
 */
export function raceDeadline(promise, signal) {
  observeEventualSettlement(promise);
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(DEADLINE_EXCEEDED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(DEADLINE_EXCEEDED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
