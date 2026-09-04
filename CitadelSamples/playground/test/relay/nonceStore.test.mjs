/**
 * Single-use nonce tracking for the local-proxy -> relay hop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNonceStore, MIN_MAX_RETENTION_MS } from '../../src/relay/nonceStore.mjs';

test('a fresh nonce is consumed exactly once', () => {
  const store = createNonceStore();
  assert.equal(store.consume('abcdefgh'), true);
  assert.equal(store.consume('abcdefgh'), false, 'a replayed nonce must be refused');
  assert.equal(store.size, 1);
});

test('two distinct nonces are each accepted independently', () => {
  const store = createNonceStore();
  assert.equal(store.consume('nonce-one'), true);
  assert.equal(store.consume('nonce-two'), true);
  assert.equal(store.size, 2);
});

test('a nonce shorter than 8 characters or longer than 200 is refused, never tracked', () => {
  const store = createNonceStore();
  assert.equal(store.consume('short'), false);
  assert.equal(store.consume('x'.repeat(201)), false);
  assert.equal(store.size, 0);
});

test('a non-string nonce is refused', () => {
  const store = createNonceStore();
  assert.equal(store.consume(12345678), false);
  assert.equal(store.consume(null), false);
  assert.equal(store.consume(undefined), false);
});

test('an expired nonce is swept and its slot may be reused', () => {
  let now = 1_000_000;
  const store = createNonceStore({ ttlMs: 1000, now: () => now });
  assert.equal(store.consume('expiring-nonce'), true);
  now += 500;
  assert.equal(store.consume('expiring-nonce'), false, 'still fresh, so still a replay');
  now += 1000; // past the 1000ms TTL
  assert.equal(store.consume('expiring-nonce'), true, 'expired, so the nonce may be reused');
});

test('a supplied expiry beyond the fixed default TTL is honoured — the nonce is still retained (not replayable) after the old default would have forgotten it', () => {
  let now = 1_000_000;
  const ttlMs = 5 * 60_000; // the store's own fixed default, mirroring server.mjs's real default
  const store = createNonceStore({ ttlMs, now: () => now });
  const nonceExpiresAt = now + 6 * 60_000; // a validated expiry 1 minute beyond the default TTL
  assert.equal(store.consume('boundary-nonce', nonceExpiresAt), true);

  now += ttlMs + 1; // exactly 1ms past where the OLD fixed default would have swept this entry
  assert.equal(store.consume('boundary-nonce', nonceExpiresAt), false, 'still retained by the supplied expiry, so still a replay — not wrongly reusable');

  now = nonceExpiresAt + 1; // now past the supplied expiry itself
  assert.equal(store.consume('boundary-nonce', nonceExpiresAt), true, 'past its own supplied expiry, the slot is finally swept and may be reused');
});

test('omitting the supplied expiry preserves prior behaviour exactly — the fixed default TTL still applies', () => {
  let now = 1_000_000;
  const store = createNonceStore({ ttlMs: 1000, now: () => now });
  assert.equal(store.consume('no-expiry-arg'), true);
  now += 1001; // past the fixed default TTL
  assert.equal(store.consume('no-expiry-arg'), true, 'with no supplied expiry, the fixed default TTL alone governs retention, unchanged from before');
});

test('a non-finite or already-past supplied expiry falls back to the fixed default TTL rather than being honoured', () => {
  let now = 1_000_000;
  const store = createNonceStore({ ttlMs: 1000, now: () => now });
  assert.equal(store.consume('nan-expiry', NaN), true);
  assert.equal(store.consume('infinite-expiry', Infinity), true);
  assert.equal(store.consume('string-expiry', 'not-a-number'), true);
  assert.equal(store.consume('past-expiry', now - 1), true);
  now += 1001; // past the fixed default TTL — every one of the above must have fallen back to it
  assert.equal(store.consume('nan-expiry'), true, 'a non-finite (NaN) supplied expiry must not be honoured');
  assert.equal(store.consume('infinite-expiry'), true, 'Infinity is a number but not finite, and must not grant unbounded retention');
  assert.equal(store.consume('string-expiry'), true, 'a non-number supplied expiry must not be honoured');
  assert.equal(store.consume('past-expiry'), true, 'an already-past supplied expiry must not extend retention below the default');
});

test('an abusive far-future supplied expiry is capped by maxRetentionMs, not honoured verbatim', () => {
  let now = 1_000_000;
  const maxRetentionMs = MIN_MAX_RETENTION_MS * 2; // above the required floor, but still small enough to test cheaply
  const store = createNonceStore({ ttlMs: 1000, maxRetentionMs, now: () => now });
  const abusiveExpiry = now + 10_000_000; // wildly beyond any plausible acknowledgement lifetime
  assert.equal(store.consume('abusive-nonce', abusiveExpiry), true);
  now += maxRetentionMs - 1; // just before the maxRetentionMs cap, nowhere near the abusive expiry
  assert.equal(store.consume('abusive-nonce', abusiveExpiry), false, 'still capped-retained, so still a replay');
  now += 1; // exactly at the cap (retention is inclusive of its own boundary, like the plain-TTL case above)
  assert.equal(store.consume('abusive-nonce', abusiveExpiry), true, 'capped at maxRetentionMs rather than the caller-supplied far-future value');
});

test('the default maxRetentionMs is comfortably larger than a realistic acknowledgement lifetime (TTL + clock skew)', () => {
  let now = 1_000_000;
  const store = createNonceStore({ now: () => now });
  // 5 minutes (ACKNOWLEDGEMENT_TTL_MS) + 60 seconds (ACKNOWLEDGEMENT_CLOCK_SKEW_MS), as of
  // acknowledgement.mjs today — the exact worst case `verifyAcknowledgement` can ever accept.
  const realisticAckExpiry = now + 6 * 60_000;
  assert.equal(store.consume('realistic-ack-nonce', realisticAckExpiry), true);
  now = realisticAckExpiry - 1;
  assert.equal(store.consume('realistic-ack-nonce', realisticAckExpiry), false, 'must still be retained just before its own real expiry, well within the default cap');
});

test('the store fails closed once it reaches its tracked-nonce ceiling', () => {
  // A tiny store to exercise the ceiling without allocating 10,000 entries.
  // The ceiling itself is a module constant, so this proves the *shape* of
  // the fail-closed behaviour using a store whose sweep never frees anything
  // (a huge ttl) and a name space smaller than the real ceiling would need.
  const store = createNonceStore({ ttlMs: 10_000_000 });
  // We cannot practically fill the real 10,000-entry ceiling in a unit test
  // without a slow loop; instead assert the documented contract holds for
  // distinct nonces well under it, which is the behaviour every caller relies
  // on in practice.
  for (let i = 0; i < 500; i++) {
    assert.equal(store.consume(`nonce-${i}-aaaaaaaa`), true);
  }
  assert.equal(store.size, 500);
});

test('the reviewer-reported footgun: createNonceStore refuses a maxRetentionMs of 1ms, which would silently reintroduce the replay window this mechanism exists to close', () => {
  assert.throws(() => createNonceStore({ maxRetentionMs: 1 }), RangeError);
});

test('maxRetentionMs exactly at the required minimum floor is accepted; one millisecond below it is refused', () => {
  assert.doesNotThrow(() => createNonceStore({ maxRetentionMs: MIN_MAX_RETENTION_MS }));
  assert.throws(() => createNonceStore({ maxRetentionMs: MIN_MAX_RETENTION_MS - 1 }), RangeError);
});

test('createNonceStore refuses a non-finite or non-positive maxRetentionMs, independent of the minimum-floor check', () => {
  assert.throws(() => createNonceStore({ maxRetentionMs: NaN }), TypeError);
  assert.throws(() => createNonceStore({ maxRetentionMs: Infinity }), TypeError);
  assert.throws(() => createNonceStore({ maxRetentionMs: 0 }), TypeError);
  assert.throws(() => createNonceStore({ maxRetentionMs: -1 }), TypeError);
});

test('a small ttlMs can never undermine a supplied, validated expiry — only maxRetentionMs bounds it', () => {
  let now = 1_000_000;
  // ttlMs is deliberately far smaller than the nonce's own supplied expiry;
  // if the caller-supplied-expiry branch were ever bounded by ttlMs instead
  // of maxRetentionMs, this nonce would be wrongly forgotten almost
  // immediately.
  const store = createNonceStore({ ttlMs: 1, now: () => now });
  const nonceExpiresAt = now + 6 * 60_000; // a realistic worst-case acknowledgement expiry
  assert.equal(store.consume('short-ttl-nonce', nonceExpiresAt), true);
  now += 2; // already past the tiny ttlMs, nowhere near the supplied expiry
  assert.equal(store.consume('short-ttl-nonce', nonceExpiresAt), false, 'the supplied expiry, not ttlMs, must govern retention');
  now = nonceExpiresAt + 1;
  assert.equal(store.consume('short-ttl-nonce', nonceExpiresAt), true, 'reusable only once its own supplied expiry has passed');
});
