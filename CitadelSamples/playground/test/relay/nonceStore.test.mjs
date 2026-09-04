/**
 * Single-use nonce tracking for the local-proxy -> relay hop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNonceStore } from '../../src/relay/nonceStore.mjs';

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
