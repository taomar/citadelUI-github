/**
 * The relay's public-evidence projection (`src/relay/publicResult.mjs`).
 *
 * An earlier version of this module was a RECURSIVE, type-based sanitizer:
 * it kept any boolean, bounded number, or array/object built entirely of
 * those, on the theory that only STRINGS (and containers holding one) could
 * carry upstream-derived content. That theory is wrong. A compromised
 * backend chooses every one of those shapes too — which of several
 * plausible status codes to answer with, whether to set a header the relay
 * turns into a boolean, how many entries an array has, which key names an
 * object uses — and can use that choice itself as a side channel,
 * independent of ever placing a raw or transformed secret STRING anywhere.
 * `httpExecutor.test.mjs`'s "a JSON-RPC error member..." and "a policy-
 * approved endpoint cannot exfiltrate..." tests cover this end to end
 * through real catalogue samples; these tests instead exercise the module
 * directly, including the specific exploit shapes the old type-based design
 * used to accept: a secret encoded as an object KEY name, as a boolean, as
 * a plain (in-range) number, and as an array's LENGTH or ORDER rather than
 * its contents.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  publicAssertionDetail,
  publicizeStepRecord,
  publicRunSummary,
  sanitizeAssertionEvidence,
} from '../../src/relay/publicResult.mjs';

/* --------------------------------------------------- always-empty evidence */

test('sanitizeAssertionEvidence returns {} for a missing/non-object evidence value', () => {
  assert.deepEqual(sanitizeAssertionEvidence(undefined), {});
  assert.deepEqual(sanitizeAssertionEvidence(null), {});
  assert.deepEqual(sanitizeAssertionEvidence({}), {});
});

test('sanitizeAssertionEvidence returns {} even for an evidence object made entirely of booleans and in-range numbers', () => {
  // The exact shape the old recursive sanitizer used to keep in full.
  const evidence = sanitizeAssertionEvidence({ ok: true, count: 3, status: 200, ratio: 0.5, empty: null });
  assert.deepEqual(evidence, {});
});

test('sanitizeAssertionEvidence returns {} regardless of assertion evaluator shape (mcp-tools pass branch)', () => {
  const evidence = sanitizeAssertionEvidence({ tools: ['get-weather'], sessionCaptured: true });
  assert.deepEqual(evidence, {});
});

test('sanitizeAssertionEvidence returns {} regardless of assertion evaluator shape (equals fail branch)', () => {
  const evidence = sanitizeAssertionEvidence({ actual: 'attacker-controlled-value', expected: 'expected-value' });
  assert.deepEqual(evidence, {});
});

test('sanitizeAssertionEvidence returns {} for a raw JSON-RPC error object, even alongside a bare status code', () => {
  const evidence = sanitizeAssertionEvidence({ status: 200, error: { code: -32000, message: 'attacker text' } });
  assert.deepEqual(evidence, {});
});

test('sanitizeAssertionEvidence returns {} for a nested object/array regardless of whether every leaf "type-checks" as safe', () => {
  const evidence = sanitizeAssertionEvidence({ card: { name: 'attacker-value', urls: ['https://evil.example'] } });
  const evidenceAllScalar = sanitizeAssertionEvidence({ shape: { userAssignedCount: 2, hasSystemAssigned: false } });
  assert.deepEqual(evidence, {});
  assert.deepEqual(evidenceAllScalar, {});
});

/* ------------------------------------------- exploit: secret as object key */

test('exploit: a secret encoded as an OBJECT KEY name never survives — the old recursive sanitizer kept it, since only VALUES were type-checked', () => {
  const secretDerivedKey = 'leaked-secret-as-a-key-4f2c9a';
  const evidence = sanitizeAssertionEvidence({ [secretDerivedKey]: true });
  assert.deepEqual(evidence, {});
  assert.ok(!JSON.stringify(evidence).includes(secretDerivedKey));
});

/* ---------------------------------------- exploit: secret as numeric value */

test('exploit: a secret-derived number in plain range never survives — a compromised backend can pick from hundreds of "plausible" bounded values', () => {
  // A backend that wants to leak, say, the low byte of a secret can simply
  // choose a bounded, entirely "safe by type" number (e.g. an HTTP-status-
  // shaped value 200-599, or any other bounded count) that encodes it.
  const evidence = sanitizeAssertionEvidence({ secretByte: 214, secretStatusLike: 487 });
  assert.deepEqual(evidence, {});
});

/* ---------------------------------------- exploit: secret as a boolean */

test('exploit: a secret bit encoded as a boolean never survives', () => {
  const evidence = sanitizeAssertionEvidence({ secretBit0: true, secretBit1: false, secretBit2: true });
  assert.deepEqual(evidence, {});
});

/* -------------------------------------- exploit: secret as array length/order */

test('exploit: a secret encoded purely as an array LENGTH (contents otherwise "safe") never survives', () => {
  // Under the old recursive design this would have been dropped only if it
  // exceeded the hard-coded array-length cap; a backend need only stay
  // under that cap (e.g. pick a length 0-50) to encode a value via length
  // alone, with every element itself an unremarkable, "safe-by-type" value.
  const secretDerivedLength = 7;
  const evidence = sanitizeAssertionEvidence({ items: new Array(secretDerivedLength).fill(true) });
  assert.deepEqual(evidence, {});
});

test('exploit: a secret encoded purely as array ORDER of otherwise-identical-looking safe values never survives', () => {
  const evidenceAscending = sanitizeAssertionEvidence({ sequence: [1, 2, 3] });
  const evidenceDescending = sanitizeAssertionEvidence({ sequence: [3, 2, 1] });
  assert.deepEqual(evidenceAscending, {});
  assert.deepEqual(evidenceDescending, {});
});

/* --------------------------------------------------------------- detail text */

test('publicAssertionDetail is a fixed sentence chosen only by status, for every known status', () => {
  assert.equal(publicAssertionDetail('passed'), 'The assertion passed.');
  assert.equal(publicAssertionDetail('failed'), 'The assertion failed.');
  assert.equal(publicAssertionDetail('inconclusive'), 'The assertion result was inconclusive.');
});

test('publicAssertionDetail defaults to the inconclusive sentence for an unrecognised status, never echoing it', () => {
  assert.equal(publicAssertionDetail('something-unexpected'), 'The assertion result was inconclusive.');
});


/* ----------------------------------------------------------------- summary */

test('publicRunSummary never embeds a failedTitles/blockedDetail value it was not given as trusted input', () => {
  assert.equal(
    publicRunSummary({ state: 'failed', ran: 2, expected: 2, failedTitles: ['Call the tool'], inconclusiveCount: 0 }),
    '1 step(s) failed: Call the tool.',
  );
  assert.equal(
    publicRunSummary({ state: 'cancelled', ran: 1, expected: 3, failedTitles: [], inconclusiveCount: 0 }),
    'Cancelled after 1 of 3 step(s).',
  );
  assert.equal(
    publicRunSummary({ state: 'blocked', ran: 0, expected: 1, failedTitles: [], blockedDetail: 'Unsupported step types: azure-cli.', inconclusiveCount: 0 }),
    'Unsupported step types: azure-cli.',
  );
  assert.equal(
    publicRunSummary({ state: 'completed', ran: 4, expected: 4, failedTitles: [], inconclusiveCount: 0 }),
    'All 4 step(s) ran and every assertion passed.',
  );
});

test('publicRunSummary reports only a bounded count for an inconclusive run, never per-assertion detail text', () => {
  assert.equal(
    publicRunSummary({ state: 'inconclusive', ran: 3, expected: 3, failedTitles: [], inconclusiveCount: 2 }),
    '2 assertion(s) could not be decided.',
  );
});

test('publicRunSummary reports a step-count shortfall distinctly from an inconclusive-assertion count', () => {
  assert.equal(
    publicRunSummary({ state: 'inconclusive', ran: 1, expected: 3, failedTitles: [], inconclusiveCount: 0 }),
    'Only 1 of 3 step(s) ran.',
  );
});

/* ------------------------------------------------------------- step records */

test('publicizeStepRecord passes an http step record through unchanged (its evidence is already built from trusted request metadata only)', () => {
  const record = { id: 'call', kind: 'http', title: 'Call', state: 'completed', detail: 'The request completed.', evidence: { method: 'GET' } };
  assert.deepEqual(publicizeStepRecord(record), record);
});

test('publicizeStepRecord rebuilds an assertion step record fully from its status, dropping any pre-existing unsafe evidence/detail', () => {
  const record = {
    id: 'assert-tools',
    kind: 'assertion',
    title: 'Tools listed',
    state: 'completed',
    detail: 'attacker-supplied detail text',
    evidence: { tools: ['attacker-tool-name'], sessionCaptured: true, secretByte: 214 },
    assertion: {
      id: 'assert-tools',
      status: 'passed',
      detail: 'attacker-supplied detail text',
      evidence: { tools: ['attacker-tool-name'], sessionCaptured: true, secretByte: 214 },
    },
  };
  const publicized = publicizeStepRecord(record);
  assert.equal(publicized.detail, 'The assertion passed.');
  assert.deepEqual(publicized.evidence, {});
  assert.equal(publicized.assertion.detail, 'The assertion passed.');
  assert.deepEqual(publicized.assertion.evidence, {});
});
