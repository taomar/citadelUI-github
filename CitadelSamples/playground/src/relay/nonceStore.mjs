/**
 * Single-use nonce tracking for the local-proxy -> relay hop.
 *
 * Every forwarded `/execute` request carries a fresh nonce the local proxy
 * mints (never the browser — the browser's acknowledgement and this nonce
 * answer different questions: "did the user consent" vs "is this exact
 * forwarded execution request fresh, not a replay"). The relay consumes the
 * nonce exactly once; a second delivery of the same nonce — a retried
 * request, a captured-and-replayed one — is refused rather than executed
 * twice.
 *
 * The in-memory implementation is correct for a single relay instance. A
 * multi-instance deployment needs a shared store (e.g. Redis) behind the same
 * `{ consume(nonce) -> boolean }` interface; nothing else here changes.
 */

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TRACKED = 10_000;

export function createNonceStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const seen = new Map(); // nonce -> expiresAtMs

  function sweep() {
    const cutoff = now();
    for (const [nonce, expiresAtMs] of seen) {
      if (expiresAtMs <= cutoff) seen.delete(nonce);
    }
  }

  return Object.freeze({
    /** @returns {boolean} true if this nonce was fresh (and is now consumed) */
    consume(nonce) {
      if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 200) return false;
      sweep();
      if (seen.has(nonce)) return false;
      if (seen.size >= MAX_TRACKED) {
        // Fail closed rather than let the store grow without bound.
        return false;
      }
      seen.set(nonce, now() + ttlMs);
      return true;
    },
    get size() {
      return seen.size;
    },
  });
}
