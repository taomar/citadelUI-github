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
 * `consume` accepts an optional validated expiry (the caller's own
 * `acknowledgement.expiresAt`, once `verifyAcknowledgement` has already
 * accepted it) and retains the nonce until at least that time, not merely
 * this store's fixed default TTL: a bounded caller-supplied clock-skew
 * tolerance can make an accepted acknowledgement's real validity window
 * longer than this store's own default (see `ACKNOWLEDGEMENT_TTL_MS` and
 * `ACKNOWLEDGEMENT_CLOCK_SKEW_MS`, imported below) — a fixed, shorter
 * retention here would let this store forget a nonce while the
 * acknowledgement it protects would still verify as valid, reopening a
 * replay window the acknowledgement layer itself had already closed.
 * Retention is bounded by `maxRetentionMs` against a malformed or abusive
 * far-future value; omitted, non-finite, or already-past values fall back
 * to the fixed default `ttlMs`, preserving prior behavior for callers that
 * do not supply one. A too-small `ttlMs` never undermines a supplied,
 * validated expiry: the caller-supplied-expiry branch below is bounded by
 * `maxRetentionMs`, never by `ttlMs`.
 *
 * `maxRetentionMs` itself is bounded from below at construction time — see
 * `MIN_MAX_RETENTION_MS` — so a misconfigured caller can never silently
 * reintroduce the exact replay window this mechanism exists to close.
 *
 * The in-memory implementation is correct for a single relay instance. A
 * multi-instance deployment needs a shared store (e.g. Redis) behind the
 * same `{ consume(nonce, nonceExpiresAt?) -> boolean }` interface; nothing
 * else here changes.
 */

import { ACKNOWLEDGEMENT_TTL_MS, ACKNOWLEDGEMENT_CLOCK_SKEW_MS } from './acknowledgement.mjs';

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TRACKED = 10_000;
// The floor below which `maxRetentionMs` must never fall: the worst-case
// lifetime `verifyAcknowledgement` will ever accept for an acknowledgement
// (its claimed TTL, plus the bounded future-issuance clock-skew tolerance —
// see acknowledgement.mjs). A `maxRetentionMs` smaller than this could cap a
// caller-supplied, already-validated `nonceExpiresAt` down to something
// shorter than the acknowledgement's own real expiry, reopening the exact
// replay window `consume`'s second parameter exists to close. This is a
// hard floor, enforced below, not merely a documented convention.
export const MIN_MAX_RETENTION_MS = ACKNOWLEDGEMENT_TTL_MS + ACKNOWLEDGEMENT_CLOCK_SKEW_MS;
// An absolute ceiling on how long a single-use nonce is retained beyond this
// store's own fixed default TTL, when a caller supplies its own validated
// expiry (see `consume`'s second parameter above). Comfortably larger than
// `MIN_MAX_RETENTION_MS` today — generous enough to cover any acknowledgement
// `verifyAcknowledgement` will ever accept, while still bounding memory
// against a malformed or abusive far-future value that somehow reached this
// store without first passing that validation.
const MAX_RETENTION_MS = 30 * 60_000;

export function createNonceStore({ ttlMs = DEFAULT_TTL_MS, maxRetentionMs = MAX_RETENTION_MS, now = () => Date.now() } = {}) {
  if (!Number.isFinite(maxRetentionMs) || maxRetentionMs <= 0) {
    throw new TypeError(`createNonceStore requires a finite, positive maxRetentionMs (received ${maxRetentionMs}).`);
  }
  if (maxRetentionMs < MIN_MAX_RETENTION_MS) {
    throw new RangeError(
      `createNonceStore requires maxRetentionMs >= ${MIN_MAX_RETENTION_MS}ms (ACKNOWLEDGEMENT_TTL_MS + ` +
        `ACKNOWLEDGEMENT_CLOCK_SKEW_MS), received ${maxRetentionMs}ms — a smaller ceiling could truncate a ` +
        'validated acknowledgement expiry below its own real expiry, reopening a nonce-replay window.',
    );
  }
  const seen = new Map(); // nonce -> expiresAtMs

  function sweep() {
    const cutoff = now();
    for (const [nonce, expiresAtMs] of seen) {
      if (expiresAtMs <= cutoff) seen.delete(nonce);
    }
  }

  return Object.freeze({
    /**
     * @param {string} nonce
     * @param {number} [nonceExpiresAt]   the caller's own validated expiry
     *   for whatever this nonce is bound to — see the module docstring
     * @returns {boolean} true if this nonce was fresh (and is now consumed)
     */
    consume(nonce, nonceExpiresAt) {
      if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 200) return false;
      sweep();
      if (seen.has(nonce)) return false;
      if (seen.size >= MAX_TRACKED) {
        // Fail closed rather than let the store grow without bound.
        return false;
      }
      const cutoff = now();
      // Bounded by `maxRetentionMs`, NEVER by `ttlMs`: a caller-supplied,
      // already-validated expiry must never be undermined by however small
      // `ttlMs` happens to be configured — only the validated-at-construction
      // `maxRetentionMs` ceiling may shorten it.
      const retainUntil =
        typeof nonceExpiresAt === 'number' && Number.isFinite(nonceExpiresAt) && nonceExpiresAt > cutoff
          ? Math.min(nonceExpiresAt, cutoff + maxRetentionMs)
          : cutoff + ttlMs;
      seen.set(nonce, retainUntil);
      return true;
    },
    get size() {
      return seen.size;
    },
  });
}
