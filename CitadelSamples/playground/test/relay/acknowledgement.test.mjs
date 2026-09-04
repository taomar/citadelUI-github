/**
 * Direct unit coverage of `src/relay/acknowledgement.mjs`: the pure
 * mint/verify/digest/target-derivation functions that back gate 3 (a
 * short-lived, one-use acknowledgement bound to caller, tenant, target,
 * sample, canonical input digest, and risk text). `test/relay/server.test.mjs`
 * exercises these through `handleExecuteRequest`; this file exercises the
 * module directly, including branches (caller/tenant binding, key-order
 * independence, constructor guards) that are easiest to prove in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACKNOWLEDGEMENT_TTL_MS,
  ACKNOWLEDGEMENT_CLOCK_SKEW_MS,
  canonicalInputDigest,
  mintAcknowledgement,
  planDestinationOrigins,
  verifyAcknowledgement,
} from '../../src/relay/acknowledgement.mjs';

const BASE = {
  sampleId: 'weather-mcp-discovery',
  inputs: { 'weatherTool.city': 'Seattle', 'hub.gatewayUrl': 'https://apim-citadel-test.azure-api.net' },
  secretRefs: ['gatewayAccess.apiKey'],
  target: 'https://apim-citadel-test.azure-api.net',
  riskText: 'Opens an MCP session against a remote server through the gateway. Nothing is created or changed.',
};

function mint(overrides = {}) {
  return mintAcknowledgement({ ...BASE, ...overrides });
}

function expectedFor(overrides = {}) {
  return { sampleId: BASE.sampleId, inputs: BASE.inputs, secretRefs: BASE.secretRefs, target: BASE.target, riskText: BASE.riskText, ...overrides };
}

/* ------------------------------------------------------- canonicalInputDigest */

test('canonicalInputDigest is a 64-character lowercase hex sha-256', () => {
  const digest = canonicalInputDigest({ sampleId: BASE.sampleId, inputs: BASE.inputs, secretRefs: BASE.secretRefs });
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('canonicalInputDigest is independent of key order in inputs and secretRefs', () => {
  const a = canonicalInputDigest({ sampleId: 's', inputs: { a: 1, b: 2 }, secretRefs: ['x', 'y'] });
  const b = canonicalInputDigest({ sampleId: 's', inputs: { b: 2, a: 1 }, secretRefs: ['y', 'x'] });
  assert.equal(a, b);
});

test('canonicalInputDigest changes when any bound value changes', () => {
  const base = canonicalInputDigest({ sampleId: 's', inputs: { a: 1 }, secretRefs: [] });
  assert.notEqual(base, canonicalInputDigest({ sampleId: 'different', inputs: { a: 1 }, secretRefs: [] }));
  assert.notEqual(base, canonicalInputDigest({ sampleId: 's', inputs: { a: 2 }, secretRefs: [] }));
  assert.notEqual(base, canonicalInputDigest({ sampleId: 's', inputs: { a: 1 }, secretRefs: ['ref'] }));
});

test('canonicalInputDigest defaults secretRefs to empty and inputs to an empty object', () => {
  assert.doesNotThrow(() => canonicalInputDigest({ sampleId: 's' }));
});

/* ------------------------------------------------------- mintAcknowledgement */

test('mintAcknowledgement produces a self-consistent, freshly-expiring envelope', () => {
  const ack = mint();
  assert.equal(ack.accepted, true);
  assert.equal(ack.sampleId, BASE.sampleId);
  assert.equal(ack.target, BASE.target);
  assert.equal(ack.riskText, BASE.riskText);
  assert.equal(ack.caller, null);
  assert.equal(ack.tenant, null);
  assert.equal(typeof ack.nonce, 'string');
  assert.ok(ack.nonce.length > 0);
  assert.equal(ack.inputDigest, canonicalInputDigest({ sampleId: BASE.sampleId, inputs: BASE.inputs, secretRefs: BASE.secretRefs }));
  assert.equal(ack.expiresAt - ack.issuedAt, ACKNOWLEDGEMENT_TTL_MS);
});

test('mintAcknowledgement accepts an explicit caller, tenant, ttlMs, now and nonce', () => {
  const ack = mint({ caller: 'user-123', tenant: 'tenant-abc', ttlMs: 1000, now: () => 5000, nonce: 'fixed-nonce' });
  assert.equal(ack.caller, 'user-123');
  assert.equal(ack.tenant, 'tenant-abc');
  assert.equal(ack.issuedAt, 5000);
  assert.equal(ack.expiresAt, 6000);
  assert.equal(ack.nonce, 'fixed-nonce');
});

test('mintAcknowledgement is frozen: a caller cannot mutate a minted envelope', () => {
  const ack = mint();
  assert.throws(() => {
    ack.sampleId = 'tampered';
  }, TypeError);
});

test('mintAcknowledgement requires sampleId, target and riskText', () => {
  assert.throws(() => mintAcknowledgement({ ...BASE, sampleId: undefined }), TypeError);
  assert.throws(() => mintAcknowledgement({ ...BASE, sampleId: '' }), TypeError);
  assert.throws(() => mintAcknowledgement({ ...BASE, target: undefined }), TypeError);
  assert.throws(() => mintAcknowledgement({ ...BASE, target: '' }), TypeError);
  assert.throws(() => mintAcknowledgement({ ...BASE, riskText: undefined }), TypeError);
  assert.throws(() => mintAcknowledgement({ ...BASE, riskText: '' }), TypeError);
});

test('mintAcknowledgement rejects an empty iterable target (e.g. planDestinationOrigins found nothing to bind to)', () => {
  assert.throws(() => mintAcknowledgement({ ...BASE, target: [] }), TypeError);
  assert.throws(() => mintAcknowledgement({ ...BASE, target: new Set() }), TypeError);
});

test('mintAcknowledgement stores a single-element iterable target as a plain string, same as a bare string', () => {
  const fromArray = mint({ target: ['https://only-origin.example.net'] });
  const fromSet = mint({ target: new Set(['https://only-origin.example.net']) });
  assert.equal(fromArray.target, 'https://only-origin.example.net');
  assert.equal(fromSet.target, 'https://only-origin.example.net');
});

test('mintAcknowledgement stores a genuinely multi-origin target as a frozen, sorted, deduped array, regardless of input order or duplicates', () => {
  const ack = mint({
    target: ['https://second.example.net', 'https://first.example.net', 'https://second.example.net'],
  });
  assert.deepEqual(ack.target, ['https://first.example.net', 'https://second.example.net']);
  assert.throws(() => ack.target.push('https://tampered.example.net'), TypeError);
});

test('mintAcknowledgement accepts a Set as a multi-origin target, sorted the same way as an array would be', () => {
  const fromSet = mint({ target: new Set(['https://b.example.net', 'https://a.example.net']) });
  const fromArray = mint({ target: ['https://a.example.net', 'https://b.example.net'] });
  assert.deepEqual(fromSet.target, fromArray.target);
});

test('two mints of the same request produce two different nonces by default', () => {
  const first = mint();
  const second = mint();
  assert.notEqual(first.nonce, second.nonce);
});


/* ----------------------------------------------------- verifyAcknowledgement */

test('verifyAcknowledgement accepts a correctly bound, unexpired acknowledgement', () => {
  const result = verifyAcknowledgement(mint(), expectedFor());
  assert.equal(result.ok, true);
});

test('verifyAcknowledgement REJECTS a scalar acknowledgement target when the expected set names several origins, even though it is a genuine member of that set', () => {
  // This is the fix for the HIGH-severity gap: a plan whose rebuilt view
  // requires two or more destination origins (`planDestinationOrigins(plan)`
  // returning 2+ entries) must never be satisfiable by a scalar
  // acknowledgement that merely names ONE of them. Accepting mere membership
  // here would let a single-origin consent silently authorise contacting
  // every OTHER origin in the expected set too, none of which the caller
  // ever saw named at acknowledgement time. A scalar target is only ever
  // valid against an expected set that is ITSELF exactly one origin — see
  // the "single allowed origin" test below for that still-supported shape.
  const ack = mint({ target: 'https://second-origin.example.net' });
  const result = verifyAcknowledgement(ack, expectedFor({ target: new Set(['https://first.example.net', 'https://second-origin.example.net']) }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'acknowledgement-target-mismatch');
});

test('verifyAcknowledgement accepts a scalar acknowledgement target when the expected set normalises to that exact single origin', () => {
  const ack = mint({ target: 'https://only-origin.example.net' });
  // `expected.target` may itself be handed as a single-element iterable
  // (e.g. a rebuilt plan that happens to contact only one origin) — it must
  // normalise down to the same single-origin exact-match check as a bare
  // string would.
  const result = verifyAcknowledgement(ack, expectedFor({ target: new Set(['https://only-origin.example.net']) }));
  assert.equal(result.ok, true);
});

test('verifyAcknowledgement accepts a genuinely multi-origin acknowledgement when it matches the expected set EXACTLY, regardless of order', () => {
  const ack = mint({ target: ['https://second.example.net', 'https://first.example.net'] });
  const result = verifyAcknowledgement(ack, expectedFor({ target: ['https://first.example.net', 'https://second.example.net'] }));
  assert.equal(result.ok, true);
});

test('verifyAcknowledgement rejects a multi-origin acknowledgement that is only a SUBSET of the plan\'s actual destinations', () => {
  // A multi-origin plan's consent must cover its FULL destination set —
  // partial coverage (the caller only consented to one of two origins the
  // rebuilt plan will actually contact) is not membership, it is a
  // mismatch. `mintAcknowledgement` always collapses a single-element
  // target back to a plain string (see the mint tests above), so a
  // partially-covered multi-origin acknowledgement is constructed directly
  // here rather than through `mint`, to exercise `verifyAcknowledgement`'s
  // array branch against a shape it would never itself produce but a
  // malicious or buggy caller could still submit.
  const multiOriginAck = mint({ target: ['https://first.example.net', 'https://second.example.net'] });
  const partiallyCoveredAck = { ...multiOriginAck, target: ['https://first.example.net'] };
  const result = verifyAcknowledgement(
    partiallyCoveredAck,
    expectedFor({ target: ['https://first.example.net', 'https://second.example.net'] }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'acknowledgement-target-mismatch');
});

test('verifyAcknowledgement rejects a multi-origin acknowledgement that names an origin OUTSIDE the plan\'s actual destinations, even if it also names every real one', () => {
  const ack = mint({ target: ['https://first.example.net', 'https://second.example.net', 'https://not-a-real-destination.example.net'] });
  const result = verifyAcknowledgement(ack, expectedFor({ target: ['https://first.example.net', 'https://second.example.net'] }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'acknowledgement-target-mismatch');
});

for (const bad of [undefined, null, 'a string', 42, ['array']]) {
  test(`verifyAcknowledgement rejects a non-object acknowledgement (${JSON.stringify(bad)}) with acknowledgement-required`, () => {
    const result = verifyAcknowledgement(bad, expectedFor());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'acknowledgement-required');
  });
}

test('verifyAcknowledgement rejects accepted !== true with acknowledgement-required', () => {
  const result = verifyAcknowledgement({ ...mint(), accepted: false }, expectedFor());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'acknowledgement-required');
});

test('verifyAcknowledgement rejects a missing or empty nonce with nonce-required', () => {
  const { nonce, ...withoutNonce } = mint();
  void nonce;
  assert.equal(verifyAcknowledgement(withoutNonce, expectedFor()).code, 'nonce-required');
  assert.equal(verifyAcknowledgement({ ...mint(), nonce: '' }, expectedFor()).code, 'nonce-required');
});

test('verifyAcknowledgement rejects a non-numeric or missing expiresAt with acknowledgement-malformed', () => {
  const { expiresAt, ...withoutExpiry } = mint();
  void expiresAt;
  assert.equal(verifyAcknowledgement(withoutExpiry, expectedFor()).code, 'acknowledgement-malformed');
  assert.equal(verifyAcknowledgement({ ...mint(), expiresAt: 'not-a-number' }, expectedFor()).code, 'acknowledgement-malformed');
});

test('verifyAcknowledgement rejects a missing or non-numeric issuedAt with acknowledgement-malformed', () => {
  const { issuedAt, ...withoutIssuedAt } = mint();
  void issuedAt;
  assert.equal(verifyAcknowledgement(withoutIssuedAt, expectedFor()).code, 'acknowledgement-malformed');
  assert.equal(verifyAcknowledgement({ ...mint(), issuedAt: 'not-a-number' }, expectedFor()).code, 'acknowledgement-malformed');
});

test('verifyAcknowledgement rejects a claimed lifetime (expiresAt - issuedAt) beyond ACKNOWLEDGEMENT_TTL_MS with acknowledgement-malformed, even when the acknowledgement is not itself expired yet', () => {
  // A forged, or otherwise abusive, far-future expiresAt paired with its own
  // issuedAt must be rejected on its claimed LIFETIME alone: without this
  // check it would still pass every other structural and freshness check
  // here, and a caller keying a replay-prevention window off this exact
  // field (the managed-run store's nonce retention — see managedRun.mjs)
  // would then retain that window for an unbounded length of time.
  const ack = { ...mint({ now: () => 1_000 }), issuedAt: 1_000, expiresAt: 1_000 + ACKNOWLEDGEMENT_TTL_MS + 1 };
  const result = verifyAcknowledgement(ack, expectedFor(), { now: () => 2_000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'acknowledgement-malformed');
});

test('verifyAcknowledgement accepts a claimed lifetime exactly at ACKNOWLEDGEMENT_TTL_MS', () => {
  const ack = { ...mint({ now: () => 1_000 }), issuedAt: 1_000, expiresAt: 1_000 + ACKNOWLEDGEMENT_TTL_MS };
  const result = verifyAcknowledgement(ack, expectedFor(), { now: () => 2_000 });
  assert.equal(result.ok, true);
});

test('verifyAcknowledgement accepts an issuedAt that is technically ahead of the verifier\'s own clock, as long as it is within the bounded clock-skew tolerance', () => {
  // Genuine wall-clock disagreement between the process that minted the
  // acknowledgement and the process now verifying it — a few tens of
  // seconds, well inside ACKNOWLEDGEMENT_CLOCK_SKEW_MS — must not be
  // refused outright.
  const ack = mint({ now: () => 1_000 + ACKNOWLEDGEMENT_CLOCK_SKEW_MS / 2 });
  const result = verifyAcknowledgement(ack, expectedFor(), { now: () => 1_000 });
  assert.equal(result.ok, true);
});

test('verifyAcknowledgement rejects an issuedAt beyond the bounded clock-skew tolerance with acknowledgement-not-yet-valid', () => {
  const ack = mint({ now: () => 1_000 + ACKNOWLEDGEMENT_CLOCK_SKEW_MS + 1 });
  const result = verifyAcknowledgement(ack, expectedFor(), { now: () => 1_000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'acknowledgement-not-yet-valid');
});

test('verifyAcknowledgement rejects the reviewer-reported reproduction: an issuedAt far enough in the future that its otherwise-ordinary, TTL-bounded expiresAt would still outlive the managed-run store\'s fixed nonce-retention cap, even though every OTHER check here would have accepted it', () => {
  // Before ACKNOWLEDGEMENT_CLOCK_SKEW_MS existed, this exact acknowledgement
  // passed every check in this function: its claimed lifetime
  // (expiresAt - issuedAt) is EXACTLY ACKNOWLEDGEMENT_TTL_MS, so the
  // claimed-lifetime bound above is satisfied; and its expiresAt, roughly 30
  // minutes ahead of real verification time, is comfortably still in the
  // future, so the plain expiry check is satisfied too. Its ABSOLUTE
  // expiresAt, however, lands past the durable managed-run store's fixed
  // MAX_NONCE_RETENTION_MS cap (30 minutes from admission — see
  // managedRun.mjs), which is exactly capped, not extended, for a
  // nonceExpiresAt that large. That combination used to open a real replay
  // window: once the store's capped retention lapsed, this acknowledgement
  // would still verify as "not yet expired", so a different Idempotency-Key
  // replaying the same nonce past that point would wrongly be treated as
  // fresh and admitted as a new run.
  const nowAtVerification = 1_000;
  const abusiveIssuedAt = nowAtVerification + 26 * 60_000; // ~26 minutes ahead: (issuedAt + TTL) lands past the 30-minute cap
  const ack = mint({ now: () => abusiveIssuedAt });
  assert.equal(ack.expiresAt - nowAtVerification > 30 * 60_000, true, 'test setup must actually exceed the store\'s 30-minute retention cap');
  const result = verifyAcknowledgement(ack, expectedFor(), { now: () => nowAtVerification });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'acknowledgement-not-yet-valid');
});

test('the explicit backstop check binding expiresAt to now + ACKNOWLEDGEMENT_TTL_MS + the clock-skew tolerance accepts exactly at that boundary, documenting -- independently of the issuedAt and claimed-lifetime checks above -- the exact property the managed-run store\'s nonce retention depends on', () => {
  // Given the checks above (issuedAt bounded to now + skew, and claimed
  // lifetime bounded to ACKNOWLEDGEMENT_TTL_MS), this bound is implied for
  // every input and therefore cannot independently reject anything those
  // two checks did not already reject — but it is kept explicit so the
  // property the managed-run store's nonce retention depends on (see the
  // reproduction test above) is asserted directly here, not merely as an
  // emergent consequence of two checks that were designed for different
  // reasons and could, in isolation, later be loosened without anyone
  // noticing this consequence.
  const nowMs = 1_000;
  const atBound = {
    ...mint({ now: () => nowMs }),
    issuedAt: nowMs + ACKNOWLEDGEMENT_CLOCK_SKEW_MS,
    expiresAt: nowMs + ACKNOWLEDGEMENT_TTL_MS + ACKNOWLEDGEMENT_CLOCK_SKEW_MS,
  };
  assert.equal(verifyAcknowledgement(atBound, expectedFor(), { now: () => nowMs }).ok, true, 'exactly at the bound must still be accepted');
});

test('verifyAcknowledgement rejects an expired acknowledgement with acknowledgement-expired', () => {
  const ack = mint({ now: () => 1000, ttlMs: 500 });
  const result = verifyAcknowledgement(ack, expectedFor(), { now: () => 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'acknowledgement-expired');
});

test('verifyAcknowledgement rejects a sample mismatch with acknowledgement-sample-mismatch', () => {
  const result = verifyAcknowledgement(mint(), expectedFor({ sampleId: 'a-different-sample' }));
  assert.equal(result.code, 'acknowledgement-sample-mismatch');
});

test('verifyAcknowledgement rejects a target not in the expected set with acknowledgement-target-mismatch', () => {
  const result = verifyAcknowledgement(mint(), expectedFor({ target: 'https://not-the-configured-gateway.example.net' }));
  assert.equal(result.code, 'acknowledgement-target-mismatch');
});

test('verifyAcknowledgement rejects an empty expected target set with acknowledgement-target-mismatch', () => {
  const result = verifyAcknowledgement(mint(), expectedFor({ target: [] }));
  assert.equal(result.code, 'acknowledgement-target-mismatch');
});

test('verifyAcknowledgement rejects an input digest mismatch with acknowledgement-input-mismatch', () => {
  const result = verifyAcknowledgement(mint(), expectedFor({ inputs: { ...BASE.inputs, 'weatherTool.city': 'Portland' } }));
  assert.equal(result.code, 'acknowledgement-input-mismatch');
});

test('verifyAcknowledgement rejects a secretRefs mismatch with acknowledgement-input-mismatch', () => {
  const result = verifyAcknowledgement(mint(), expectedFor({ secretRefs: ['a-different-secret'] }));
  assert.equal(result.code, 'acknowledgement-input-mismatch');
});

test('verifyAcknowledgement rejects a risk-text mismatch with acknowledgement-risk-mismatch, when riskText is expected', () => {
  const result = verifyAcknowledgement(mint(), expectedFor({ riskText: 'a stale risk description' }));
  assert.equal(result.code, 'acknowledgement-risk-mismatch');
});

test('verifyAcknowledgement skips the risk-text check when expected.riskText is omitted', () => {
  const expected = expectedFor();
  delete expected.riskText;
  const result = verifyAcknowledgement(mint(), expected);
  assert.equal(result.ok, true);
});

test('verifyAcknowledgement enforces caller binding only when expected.caller is provided', () => {
  const ack = mint({ caller: 'user-123' });
  assert.equal(verifyAcknowledgement(ack, expectedFor()).ok, true, 'caller not checked when omitted from expected');
  assert.equal(
    verifyAcknowledgement(ack, expectedFor({ caller: 'a-different-caller' })).code,
    'acknowledgement-caller-mismatch',
  );
  assert.equal(verifyAcknowledgement(ack, expectedFor({ caller: 'user-123' })).ok, true);
});

test('verifyAcknowledgement enforces tenant binding only when expected.tenant is provided', () => {
  const ack = mint({ tenant: 'tenant-abc' });
  assert.equal(verifyAcknowledgement(ack, expectedFor()).ok, true, 'tenant not checked when omitted from expected');
  assert.equal(
    verifyAcknowledgement(ack, expectedFor({ tenant: 'a-different-tenant' })).code,
    'acknowledgement-tenant-mismatch',
  );
  assert.equal(verifyAcknowledgement(ack, expectedFor({ tenant: 'tenant-abc' })).ok, true);
});

test('verifyAcknowledgement never throws, even given a wildly malformed acknowledgement', () => {
  assert.doesNotThrow(() => verifyAcknowledgement({ garbage: true }, expectedFor()));
  assert.doesNotThrow(() => verifyAcknowledgement('not-an-object', expectedFor()));
});

/* --------------------------------------------------- planDestinationOrigins */

test('planDestinationOrigins collects the distinct origins of every literal http step URL', () => {
  const plan = {
    steps: [
      { type: 'http', request: { url: 'https://gateway.example.net/mcp' } },
      { type: 'http', request: { url: 'https://gateway.example.net/other-path' } },
      { type: 'assertion', check: 'status-equals' },
    ],
  };
  const origins = planDestinationOrigins(plan);
  assert.deepEqual([...origins], ['https://gateway.example.net']);
});

test('planDestinationOrigins skips steps whose url is not a literal absolute URL, without throwing', () => {
  const plan = {
    steps: [
      { type: 'http', request: { url: '{{steps.first.headers.location}}' } },
      { type: 'http', request: {} },
      { type: 'http' },
    ],
  };
  assert.doesNotThrow(() => planDestinationOrigins(plan));
  assert.equal(planDestinationOrigins(plan).size, 0);
});

test('planDestinationOrigins tolerates a plan with no steps, or no plan at all', () => {
  assert.equal(planDestinationOrigins({ steps: [] }).size, 0);
  assert.equal(planDestinationOrigins({}).size, 0);
  assert.equal(planDestinationOrigins(undefined).size, 0);
});
