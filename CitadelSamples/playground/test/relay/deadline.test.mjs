/**
 * The shared "race a promise against a deadline" primitive used by
 * `server.mjs`, `managedIdentity.mjs`, and `secretProvider.mjs` to bound an
 * external boundary call even when the dependency itself ignores its
 * `signal` argument and never settles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEADLINE_EXCEEDED, abortError, raceAbortSignal, raceDeadline } from '../../src/relay/deadline.mjs';

test('abortError produces an Error whose name is AbortError', () => {
  const error = abortError('custom message');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message, 'custom message');
});

test('raceAbortSignal with no signal at all just follows the promise', async () => {
  assert.equal(await raceAbortSignal(Promise.resolve('value'), undefined), 'value');
  await assert.rejects(() => raceAbortSignal(Promise.reject(new Error('boom')), undefined), /boom/);
});

test('raceAbortSignal follows the promise when it settles before the signal fires', async () => {
  const controller = new AbortController();
  assert.equal(await raceAbortSignal(Promise.resolve('value'), controller.signal), 'value');
});

test('raceAbortSignal rejects with a fresh AbortError when the signal fires before the promise settles, even though the promise never settles at all', async () => {
  const controller = new AbortController();
  const never = new Promise(() => {});
  const pending = raceAbortSignal(never, controller.signal, 'custom timeout message');
  controller.abort();
  await assert.rejects(() => pending, { name: 'AbortError', message: 'custom timeout message' });
});

test('raceAbortSignal rejects immediately when the signal is already aborted, without waiting on the promise at all', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => raceAbortSignal(new Promise(() => {}), controller.signal), { name: 'AbortError' });
});

test("raceAbortSignal never surfaces the raced-away promise's own later rejection as an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const controller = new AbortController();
    const lateRejecting = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('settled long after the race was already lost')), 30);
    });
    const pending = raceAbortSignal(lateRejecting, controller.signal);
    controller.abort();
    await assert.rejects(() => pending, { name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('raceDeadline with no signal just follows the promise', async () => {
  assert.equal(await raceDeadline(Promise.resolve('value'), undefined), 'value');
});

test('raceDeadline resolves to the DEADLINE_EXCEEDED sentinel when the signal fires before the promise settles, even though the promise never settles at all', async () => {
  const controller = new AbortController();
  const pending = raceDeadline(new Promise(() => {}), controller.signal);
  controller.abort();
  assert.equal(await pending, DEADLINE_EXCEEDED);
});

test('raceDeadline resolves to DEADLINE_EXCEEDED immediately for an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await raceDeadline(new Promise(() => {}), controller.signal), DEADLINE_EXCEEDED);
});

test('raceDeadline still propagates a genuine rejection that arrives before the signal fires', async () => {
  const controller = new AbortController();
  await assert.rejects(() => raceDeadline(Promise.reject(new Error('genuine failure')), controller.signal), /genuine failure/);
});

test("raceDeadline never surfaces the raced-away promise's own later rejection as an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const controller = new AbortController();
    const lateRejecting = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('settled long after the deadline already won')), 30);
    });
    const pending = raceDeadline(lateRejecting, controller.signal);
    controller.abort();
    assert.equal(await pending, DEADLINE_EXCEEDED);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});
