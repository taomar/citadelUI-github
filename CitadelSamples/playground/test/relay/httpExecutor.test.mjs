/**
 * The relay's http+assertion execution core (`createRelayHttpExecutor`).
 *
 * These tests exercise the module directly against injected fakes only — no
 * real network call is made. They cover the properties that make this core
 * safe to run unattended against a real gateway: it never follows a redirect,
 * it enforces response-size and time budgets, it blocks a run outright rather
 * than attempt an unsupported step type, it never leaks a missing-secret
 * detail as a raw throw, and it reports updates/limits shapes the caller can
 * rely on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSamplePlan, CATALOGUE, getSample, requirementsFor } from '../../src/catalogue/index.mjs';
import { createExecutionPlan, step } from '../../src/core/plan.mjs';
import { secretRef } from '../../src/core/secrets.mjs';
import { createOriginAllowlist } from '../../src/relay/originAllowlist.mjs';
import { createRelayHttpExecutor, DEFAULT_RELAY_LIMITS } from '../../src/relay/httpExecutor.mjs';
import { createSampleRequestPolicy } from '../../src/relay/requestPolicy.mjs';
import { rebuildRelayPlan } from '../../src/relay/requestSchema.mjs';
import { FAKE_API_KEY, FIXTURE_SECRETS, makeFixtureReader } from '../helpers/fixtures.mjs';
import { fakeFetch, sseFrame } from '../helpers/transports.mjs';
import { allowAllRequestPolicy } from '../helpers/relayFakes.mjs';

const GATEWAY_ORIGIN = 'https://apim-citadel-test.azure-api.net';

function fixtureInputsFor(sample) {
  const read = makeFixtureReader();
  const inputs = {};
  for (const entry of sample.configurationEntries) {
    if (entry.secret) continue;
    inputs[entry.path] = read(entry.path);
  }
  return inputs;
}

function allowlist(origins = [GATEWAY_ORIGIN]) {
  return createOriginAllowlist(origins);
}

function minimalPlan(overrides = {}) {
  return createExecutionPlan({
    sampleId: 'unit-test-plan',
    title: 'Unit test plan',
    summary: 'A hand-built plan for httpExecutor unit tests.',
    risk: { level: 'read-only', effect: 'none', blastRadius: 'none', reversibility: 'n/a' },
    sourceCells: [],
    steps: [],
    ...overrides,
  });
}

/* --------------------------------------------------------------- happy path */

test('a real allow-listed sample runs end to end against a mocked gateway', async () => {
  const sample = getSample('weather-mcp-discovery');
  const inputs = fixtureInputsFor(sample);
  const { plan } = rebuildRelayPlan({ sample, inputs }, CATALOGUE, { buildSamplePlan, requirementsFor });

  const fetch = fakeFetch([
    {
      match: (_url, init) => JSON.parse(init.body).method === 'initialize',
      response: {
        status: 200,
        headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'session-abc' },
        text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }),
      },
    },
    {
      match: (_url, init) => JSON.parse(init.body).method === 'tools/list',
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        text: sseFrame({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get-weather' }] } }),
      },
    },
  ]);

  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: FIXTURE_SECRETS });

  assert.equal(result.state, 'completed');
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[1].headers['Mcp-Session-Id'], 'session-abc');
  const tools = result.assertions.find((assertion) => assertion.id === 'assert-tools');
  assert.equal(tools.status, 'passed');
});

/* ------------------------------------------------------- public-evidence leak */

test('a policy-approved endpoint cannot exfiltrate a secret by reflecting a transform of it inside assertion evidence', async () => {
  // The endpoint is legitimate by every earlier gate: it is the exact
  // allow-listed/policy-approved origin, using the exact policy-approved
  // header. It is malicious only in what it chooses to answer with — it
  // never sees the live secret value (the relay only ever sends it, never
  // logs/reflects it itself), but it can still try to smuggle it back if
  // the CALLER ever gave it a live secret value to observe. Model the worst
  // case directly: assume the endpoint somehow learned the secret (e.g. a
  // prior request leaked it, or it is simply guessing well-known strings)
  // and echoes a transform of it — here, base64 — inside fields an
  // evaluator turns into "helpful" evidence: a tool name, and, separately,
  // other unrelated response fields no evaluator even reads. Exact-value
  // redaction only ever catches the literal secret, never this transform.
  const encodedSecret = Buffer.from(FAKE_API_KEY, 'utf-8').toString('base64');
  const seededMarker = 'seeded-canary-should-never-appear-in-result';

  const sample = getSample('weather-mcp-discovery');
  const inputs = fixtureInputsFor(sample);
  const { plan } = rebuildRelayPlan({ sample, inputs }, CATALOGUE, { buildSamplePlan, requirementsFor });

  const fetch = fakeFetch([
    {
      match: (_url, init) => JSON.parse(init.body).method === 'initialize',
      response: {
        status: 200,
        headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'session-abc' },
        text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: seededMarker } } }),
      },
    },
    {
      match: (_url, init) => JSON.parse(init.body).method === 'tools/list',
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        text: sseFrame({
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [{ name: encodedSecret, description: seededMarker }],
            // Fields no evaluator reads at all — proves the sanitizer does
            // not depend on this evaluator's specific field list, only on
            // never letting upstream content of any shape onto the wire.
            unexpectedExtra: { nested: [encodedSecret, seededMarker] },
          },
        }),
      },
    },
  ]);

  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: FIXTURE_SECRETS });

  // The assertion still reaches its correct, real verdict: exactly one
  // (malicious) tool name came back, so `mcp-tools` still passes — the
  // sanitizer must not change what the relay actually decided, only what it
  // is allowed to say about how it decided it.
  assert.equal(result.state, 'completed');
  const tools = result.assertions.find((assertion) => assertion.id === 'assert-tools');
  assert.equal(tools.status, 'passed');

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(FAKE_API_KEY), 'the raw secret must never reach the result');
  assert.ok(!serialized.includes(encodedSecret), 'a transform (base64) of the secret must never reach the result either');
  assert.ok(!serialized.includes(seededMarker), 'no other upstream-supplied string may reach the result');

  // Not just the evidence field: the assertion's own `detail`, the step's
  // `detail`, and the run-level `summary` must all be free of upstream
  // content too — a fixed, non-parameterised message, not a template filled
  // in with anything observed.
  assert.equal(tools.detail, 'The assertion passed.');
  assert.equal(result.steps.find((s) => s.id === 'assert-tools').detail, 'The assertion passed.');
  assert.ok(!result.summary.includes(encodedSecret) && !result.summary.includes(seededMarker));

  // The evidence itself must have been reduced to nothing — not merely to
  // structural facts (a session-captured boolean, a tool count): even those
  // are the backend's own choice and a channel a compromised endpoint could
  // use, so public assertion evidence carries no evaluator-derived field at
  // all, regardless of type.
  assert.deepEqual(tools.evidence, {});
});

test('a JSON-RPC error member (with attacker-chosen code/message/data) never reaches the public result, even as the correct FAILED verdict', async () => {
  // `assertions.mjs`'s `jsonrpc` evaluator, unlike `mcp-tools` above, hands
  // its evidence the RAW upstream `error` object verbatim on failure
  // (`{ status, error: verdict.error }`, see src/server/assertions.mjs), and
  // `interpretJsonRpc` (src/core/parsing.mjs) builds its own `reason` string
  // by interpolating `error.message` directly. Both of those are exactly
  // the kind of upstream-controlled content `publicResult.mjs` exists to
  // strip — this is a real catalogue sample (`a2a-message-send`) and a real
  // assertion kind (`jsonrpc`), not a synthetic fixture, so this proves the
  // module's fixed-schema (never-derived-from-upstream) design does its job
  // here too, without needing to know anything about this evaluator's
  // specific `error` shape — including its own numeric `status` field,
  // which the module now drops unconditionally along with everything else.
  const encodedSecret = Buffer.from(FAKE_API_KEY, 'utf-8').toString('base64');
  const seededMessage = 'seeded-jsonrpc-message-should-never-appear-in-result';
  const seededData = 'seeded-jsonrpc-data-should-never-appear-in-result';

  const sample = getSample('a2a-message-send');
  const inputs = fixtureInputsFor(sample);
  const { plan } = rebuildRelayPlan({ sample, inputs }, CATALOGUE, { buildSamplePlan, requirementsFor });

  const fetch = fakeFetch([
    {
      match: (_url, init) => JSON.parse(init.body).method === 'message/send',
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32603, message: `${seededMessage} ${encodedSecret}`, data: { detail: seededData, secretEcho: encodedSecret } },
        }),
      },
    },
  ]);

  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: FIXTURE_SECRETS });

  // The correct verdict still comes through: an HTTP 2xx carrying a
  // JSON-RPC `error` member is a failure for this sample, by design (see
  // exercise.mjs's own deviation note) — the public projection must not
  // change WHAT was decided, only what it is allowed to say about it.
  assert.equal(result.state, 'failed');
  const jsonRpcAssertion = result.assertions.find((assertion) => assertion.id === 'assert-jsonrpc');
  assert.equal(jsonRpcAssertion.status, 'failed');

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(FAKE_API_KEY), 'the raw secret must never reach the result');
  assert.ok(!serialized.includes(encodedSecret), 'a transform (base64) of the secret must never reach the result either');
  assert.ok(!serialized.includes(seededMessage), 'the JSON-RPC error.message must never reach the result');
  assert.ok(!serialized.includes(seededData), 'the JSON-RPC error.data must never reach the result');
  assert.ok(!serialized.includes(-32603) && !/-32603/.test(serialized), 'the JSON-RPC error.code must never reach the result either');

  // Fixed, non-parameterised text only — never `interpretJsonRpc`'s own
  // `reason`, which interpolates `error.message`.
  assert.equal(jsonRpcAssertion.detail, 'The assertion failed.');
  assert.equal(result.steps.find((s) => s.id === 'assert-jsonrpc').detail, 'The assertion failed.');
  // Evidence is empty, full stop — not even the assertion's own (otherwise
  // "harmless-looking") numeric `status` field survives, since a bounded
  // number is exactly as usable a side channel as a string here.
  assert.deepEqual(jsonRpcAssertion.evidence, {});

  // The HTTP step that actually received the response is equally clean: its
  // evidence is a fixed projection of trusted REQUEST metadata only (here,
  // just the plan-declared method) — never the response status, format, or
  // a session-header-derived boolean — and the raw `jsonRpcBody` internal
  // field `runHttp` attaches for the assertion step to consume is dropped
  // by `publicStep`'s field allowlist before the step ever reaches `steps`.
  const httpStep = result.steps.find((s) => s.id === 'message-send');
  assert.deepEqual(httpStep.evidence, { method: 'POST' });
  assert.ok(!('jsonRpcBody' in httpStep), 'the raw JSON-RPC body must never be a public step field');
});

/* ---------------------------------------------------------------- redirects */

test('every outbound request is made with redirect: "error", never followed', async () => {
  const fetch = fakeFetch([
    { match: () => true, response: { status: 200, headers: {}, text: '{}' } },
  ]);
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'ping',
        title: 'Ping',
        detail: 'Single GET.',
        request: { method: 'GET', url: `${GATEWAY_ORIGIN}/health` },
        produces: [],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  await executor.execute(plan, { secrets: {} });
  assert.equal(fetch.calls[0].redirect, 'error');
});

test('a destination outside the allowlist is refused before any request is sent', async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return { status: 200, headers: {}, text: async () => '{}' };
  };
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'ping',
        title: 'Ping',
        detail: 'Single GET to a non-allowlisted host.',
        request: { method: 'GET', url: 'https://evil.example.net/steal' },
        produces: [],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.state, 'failed');
  // A FIXED, non-parameterised refusal — never `originAllowlist.mjs`'s own
  // thrown message, which would otherwise embed the raw/parsed URL text.
  // That text is safe to name for a genuinely STATIC, caller-supplied plan
  // like this one (and `server.mjs`'s own pre-execution destination check
  // does exactly that, elsewhere) — but this executor-level re-check runs
  // for every step, including ones whose URL is only resolved at runtime
  // from an earlier step's own (potentially attacker-controlled) response,
  // so it must never reflect that text back, and there is no way to tell
  // the two cases apart here — see `assertUrlAllowed` in httpExecutor.mjs.
  assert.equal(
    result.steps[0].detail,
    'Refused: step "ping"\'s request URL is malformed or is not one of the configured allowed destinations.',
  );
  assert.ok(!result.steps[0].detail.includes('evil.example.net'), 'the disallowed origin must not be echoed back either');
  assert.equal(called, false, 'the disallowed origin must never be contacted');
});

/* ------------------------------------------------------------------ limits */

test('a response over the configured byte limit is refused, not truncated silently', async () => {
  const hugeBody = 'x'.repeat(1024);
  const fetch = fakeFetch([{ match: () => true, response: { status: 200, headers: {}, text: hugeBody } }]);
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'ping',
        title: 'Ping',
        detail: 'Single GET.',
        request: { method: 'GET', url: `${GATEWAY_ORIGIN}/health` },
        produces: [],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({
    fetchImpl: fetch,
    allowlist: allowlist(),
    requestPolicy: allowAllRequestPolicy(),
    limits: { maxResponseBytes: 100 },
  });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.state, 'failed');
  assert.match(result.steps[0].detail, /exceeded the 100-byte limit/);
});

test('a step that never resolves is aborted at its configured timeout', async () => {
  const fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'hangs',
        title: 'Hangs forever',
        detail: 'The mocked transport never settles.',
        request: { method: 'GET', url: `${GATEWAY_ORIGIN}/health`, timeoutSeconds: 30 },
        produces: [],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({
    fetchImpl: fetch,
    allowlist: allowlist(),
    requestPolicy: allowAllRequestPolicy(),
    limits: { stepTimeoutMs: 25 },
  });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.state, 'failed');
  assert.match(result.steps[0].detail, /Timed out/);
});

test('the default limits export sane, non-zero bounds for every dimension', () => {
  for (const key of ['stepTimeoutMs', 'runTimeoutMs', 'maxOutputBytes', 'maxResponseBytes', 'maxBurstRequests', 'maxConcurrency']) {
    assert.ok(Number.isFinite(DEFAULT_RELAY_LIMITS[key]) && DEFAULT_RELAY_LIMITS[key] > 0, `${key} must be a positive finite bound`);
  }
});

/* ------------------------------------------------------- unsupported steps */

test('a plan requiring a step type the relay does not run is blocked before any fetch', async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return { status: 200, headers: {}, text: async () => '{}' };
  };
  const plan = { ...minimalPlan(), requiredStepTypes: ['http', 'azure-cli'], steps: [] };
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.state, 'blocked');
  assert.deepEqual(result.meta.unsupportedStepTypes, ['azure-cli']);
  assert.equal(called, false);
});

/* --------------------------------------------------------------- secrets */

test('a missing secret value fails the step cleanly, without throwing or leaking anything', async () => {
  const fetch = fakeFetch([{ match: () => true, response: { status: 200, headers: {}, text: '{}' } }]);
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'authed',
        title: 'Authenticated call',
        detail: 'Requires a secret the caller did not supply.',
        request: {
          method: 'GET',
          url: `${GATEWAY_ORIGIN}/secure`,
          headers: { 'api-key': secretRef('gatewayAccess.apiKey') },
        },
        produces: [],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.state, 'failed');
  assert.match(result.steps[0].detail, /Missing secret value for gatewayAccess\.apiKey/);
  assert.equal(fetch.calls.length, 0, 'the request must never be sent without its secret');
});

test('a resolved secret value is redacted out of the recorded evidence', async () => {
  const fetch = fakeFetch([{ match: () => true, response: { status: 200, headers: {}, text: '{"ok":true}' } }]);
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'authed',
        title: 'Authenticated call',
        detail: 'Carries a secret header.',
        request: {
          method: 'GET',
          url: `${GATEWAY_ORIGIN}/secure`,
          headers: { 'api-key': secretRef('gatewayAccess.apiKey') },
        },
        produces: [],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: { 'gatewayAccess.apiKey': FAKE_API_KEY } });
  assert.equal(result.state, 'completed');
  assert.ok(!JSON.stringify(result).includes(FAKE_API_KEY), 'the live secret value must never reach the result');
});

/* -------------------------------------------------------------------- burst */

test('a repeat/burst request respects the configured concurrency and count caps', async () => {
  let peakConcurrent = 0;
  let inFlight = 0;
  let totalCalls = 0;
  const fetch = async () => {
    totalCalls += 1;
    inFlight += 1;
    peakConcurrent = Math.max(peakConcurrent, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { status: 429, headers: {}, text: async () => '' };
  };
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'burst',
        title: 'Burst',
        detail: 'Repeat request.',
        request: {
          method: 'POST',
          url: `${GATEWAY_ORIGIN}/mcp`,
          repeat: { count: 6, concurrency: 2, timeoutSeconds: 5 },
        },
        produces: ['statusCodes', 'errors'],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.state, 'completed');
  assert.ok(peakConcurrent <= 2, `concurrency cap must hold, observed ${peakConcurrent}`);
  assert.equal(totalCalls, 6, 'every configured repetition actually fired a request');
  // `requested`/`concurrency` are the caller's OWN already-validated repeat
  // configuration (clamped to this executor's bounds), so they are safe,
  // trusted evidence; the per-request status HISTOGRAM this evidence used
  // to carry is not — it is built entirely from response status codes the
  // backend chooses, so it no longer appears here at all (see
  // publicHttpEvidence in httpExecutor.mjs / publicResult.mjs).
  assert.deepEqual(result.steps[0].evidence, { method: 'POST', requested: 6, concurrency: 2 });
});

test('a burst request count is capped at the configured maximum, even if the plan asks for more', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return { status: 200, headers: {}, text: async () => '' };
  };
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'burst',
        title: 'Burst',
        detail: 'Repeat request exceeding the configured cap.',
        request: { method: 'POST', url: `${GATEWAY_ORIGIN}/mcp`, repeat: { count: 1000, concurrency: 4, timeoutSeconds: 5 } },
        produces: ['statusCodes', 'errors'],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({
    fetchImpl: fetch,
    allowlist: allowlist(),
    requestPolicy: allowAllRequestPolicy(),
    limits: { maxBurstRequests: 10, maxConcurrency: 2 },
  });
  await executor.execute(plan, { secrets: {} });
  assert.equal(calls, 10);
});

/* --------------------------------------------------------------- reporting */

test('a completed run with no updates reports empty configurationUpdates/secretUpdates, never undefined', async () => {
  const fetch = fakeFetch([{ match: () => true, response: { status: 200, headers: {}, text: '{}' } }]);
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'ping',
        title: 'Ping',
        detail: 'Single GET.',
        request: { method: 'GET', url: `${GATEWAY_ORIGIN}/health` },
        produces: [],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: {} });
  assert.deepEqual(result.configurationUpdates, {});
  assert.deepEqual(result.secretUpdates, {});
});

test('cancellation via an already-aborted signal stops the run before any step completes', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const fetch = async () => {
    called = true;
    return { status: 200, headers: {}, text: async () => '{}' };
  };
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'ping',
        title: 'Ping',
        detail: 'Single GET.',
        request: { method: 'GET', url: `${GATEWAY_ORIGIN}/health` },
        produces: [],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: {}, signal: controller.signal });
  assert.equal(result.state, 'cancelled');
  assert.equal(called, false);
});

test('createRelayHttpExecutor requires an allowlist and a fetch implementation', () => {
  assert.throws(
    () => createRelayHttpExecutor({ fetchImpl: async () => {}, requestPolicy: allowAllRequestPolicy() }),
    TypeError,
  );
});

test('createRelayHttpExecutor requires a requestPolicy — it can no longer silently no-op when one is omitted', () => {
  // This is the structural half of the requestPolicy/httpExecutor drift fix:
  // omitting requestPolicy used to leave the runtime re-check for a
  // discovered/secondary URL running against nothing at all. It must now be
  // a construction-time error, exactly like a missing allowlist or fetch.
  assert.throws(
    () => createRelayHttpExecutor({ fetchImpl: async () => {}, allowlist: allowlist() }),
    TypeError,
  );
});

/* --------------------------------------------------------- request policy */

test('a resolved secret value is never carried into evidence as a raw body preview', async () => {
  const fetch = fakeFetch([{ match: () => true, response: { status: 200, headers: {}, text: '{"tool":"get-weather"}' } }]);
  const plan = minimalPlan({
    steps: [
      step.http({
        id: 'ping',
        title: 'Ping',
        detail: 'Single GET.',
        request: { method: 'GET', url: `${GATEWAY_ORIGIN}/health` },
        produces: [],
      }),
    ],
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy: allowAllRequestPolicy() });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.state, 'completed');
  assert.ok(!('bodyPreview' in result.steps[0].evidence), 'a per-step evidence object must never carry a raw upstream body preview');
  assert.ok(!JSON.stringify(result).includes('get-weather'), 'no arbitrary upstream response content may reach the public result at all');
});

test('a request policy refuses a URL outside its per-sample/per-step allow-list before any fetch is sent', async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return { status: 200, headers: {}, text: async () => '{}' };
  };
  const plan = { ...minimalPlan({
    steps: [
      step.http({
        id: 'ping',
        title: 'Ping',
        detail: 'Single GET to an attacker-controlled path on an allow-listed origin.',
        request: { method: 'GET', url: `${GATEWAY_ORIGIN}/attacker-path` },
        produces: [],
      }),
    ],
  }), sampleId: 'policy-test-sample' };
  const requestPolicy = createSampleRequestPolicy({
    'policy-test-sample': { ping: { urls: [`${GATEWAY_ORIGIN}/health`] } },
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.state, 'failed');
  assert.match(result.steps[0].detail, /request policy/);
  assert.equal(called, false, 'a policy-disallowed URL must never be contacted');
});

test('a request policy refuses a secret-bearing header name outside its allow-list before any fetch is sent', async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return { status: 200, headers: {}, text: async () => '{}' };
  };
  const plan = { ...minimalPlan({
    steps: [
      step.http({
        id: 'authed',
        title: 'Authenticated call',
        detail: 'Carries the secret in a header the tenant policy never approved.',
        request: {
          method: 'GET',
          url: `${GATEWAY_ORIGIN}/secure`,
          headers: { 'x-reflect': secretRef('gatewayAccess.apiKey') },
        },
        produces: [],
      }),
    ],
  }), sampleId: 'policy-test-sample' };
  const requestPolicy = createSampleRequestPolicy({
    'policy-test-sample': { authed: { urls: [`${GATEWAY_ORIGIN}/secure`], headerNames: ['api-key'] } },
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy });
  const result = await executor.execute(plan, { secrets: { 'gatewayAccess.apiKey': FAKE_API_KEY } });
  assert.equal(result.state, 'failed');
  assert.match(result.steps[0].detail, /x-reflect/);
  assert.equal(called, false, 'the secret must never be sent in a header the policy does not allow');
});

test('a request policy is re-checked against a runtime-discovered ("secondary") URL bound from an earlier step, before it is ever fetched', async () => {
  let secondCallMade = false;
  const fetch = async (url) => {
    if (String(url).includes('attacker-secondary')) secondCallMade = true;
    if (String(url).endsWith('/discover')) {
      return { status: 200, headers: {}, text: async () => JSON.stringify(`${GATEWAY_ORIGIN}/attacker-secondary`) };
    }
    return { status: 200, headers: {}, text: async () => '{}' };
  };
  const plan = { ...minimalPlan({
    steps: [
      step.http({
        id: 'discover',
        title: 'Discover',
        detail: 'Returns a follow-up URL in its own response.',
        request: { method: 'GET', url: `${GATEWAY_ORIGIN}/discover`, capture: { next: 'response.json' } },
        produces: ['next'],
      }),
      step.http({
        id: 'follow',
        title: 'Follow the discovered URL',
        detail: 'Not yet a literal URL at plan-rebuild time.',
        request: { method: 'GET', url: '{{steps.discover.next}}' },
        produces: [],
      }),
    ],
  }), sampleId: 'policy-test-sample' };
  const requestPolicy = createSampleRequestPolicy({
    'policy-test-sample': {
      discover: { urls: [`${GATEWAY_ORIGIN}/discover`] },
      follow: { urls: [`${GATEWAY_ORIGIN}/expected-follow-up`] },
    },
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.steps[0].state, 'completed', 'the discover step itself is policy-approved and runs');
  assert.equal(result.steps[1].state, 'failed');
  assert.match(result.steps[1].detail, /request policy/);
  assert.equal(secondCallMade, false, 'the runtime-bound, policy-disallowed secondary URL must never actually be fetched');
});

test('a MALFORMED runtime-bound ("secondary") URL is refused with a fixed message, never echoing the raw captured text', async () => {
  const seededMarker = 'seeded-malformed-marker-should-never-appear-in-result-\u0007-\\evil';
  let secondCallMade = false;
  const fetch = async (url) => {
    if (String(url).includes('seeded-malformed-marker')) secondCallMade = true;
    if (String(url).endsWith('/discover')) {
      // The captured "URL" is not a URL at all — a control character and a
      // backslash, exactly the raw-hazard shape `originAllowlist.mjs`
      // refuses outright — and it is entirely upstream-controlled (this
      // step's own response), the same class of content a compromised
      // backend fully owns.
      return { status: 200, headers: {}, text: async () => JSON.stringify(seededMarker) };
    }
    return { status: 200, headers: {}, text: async () => '{}' };
  };
  const plan = { ...minimalPlan({
    steps: [
      step.http({
        id: 'discover',
        title: 'Discover',
        detail: 'Returns a malformed follow-up URL in its own response.',
        request: { method: 'GET', url: `${GATEWAY_ORIGIN}/discover`, capture: { next: 'response.json' } },
        produces: ['next'],
      }),
      step.http({
        id: 'follow',
        title: 'Follow the discovered URL',
        detail: 'Not yet a literal URL at plan-rebuild time.',
        request: { method: 'GET', url: '{{steps.discover.next}}' },
        produces: [],
      }),
    ],
  }), sampleId: 'policy-test-sample' };
  const requestPolicy = createSampleRequestPolicy({
    'policy-test-sample': {
      discover: { urls: [`${GATEWAY_ORIGIN}/discover`] },
      follow: { urls: [`${GATEWAY_ORIGIN}/expected-follow-up`] },
    },
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.steps[1].state, 'failed');
  assert.equal(
    result.steps[1].detail,
    'Refused: step "follow"\'s request URL is malformed or is not one of the configured allowed destinations.',
  );
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(seededMarker), 'the raw captured, malformed text must never reach the result');
  assert.equal(secondCallMade, false, 'a malformed captured URL must never actually be fetched');
});

test('a DISALLOWED-ORIGIN runtime-bound ("secondary") URL is refused with a fixed message, never echoing the captured origin', async () => {
  let secondCallMade = false;
  const fetch = async (url) => {
    if (String(url).includes('attacker.example.net')) secondCallMade = true;
    if (String(url).endsWith('/discover')) {
      return { status: 200, headers: {}, text: async () => JSON.stringify('https://attacker.example.net/steal') };
    }
    return { status: 200, headers: {}, text: async () => '{}' };
  };
  const plan = { ...minimalPlan({
    steps: [
      step.http({
        id: 'discover',
        title: 'Discover',
        detail: 'Returns a follow-up URL on a disallowed origin.',
        request: { method: 'GET', url: `${GATEWAY_ORIGIN}/discover`, capture: { next: 'response.json' } },
        produces: ['next'],
      }),
      step.http({
        id: 'follow',
        title: 'Follow the discovered URL',
        detail: 'Not yet a literal URL at plan-rebuild time.',
        request: { method: 'GET', url: '{{steps.discover.next}}' },
        produces: [],
      }),
    ],
  }), sampleId: 'policy-test-sample' };
  const requestPolicy = createSampleRequestPolicy({
    'policy-test-sample': {
      discover: { urls: [`${GATEWAY_ORIGIN}/discover`] },
      follow: { urls: [`${GATEWAY_ORIGIN}/expected-follow-up`] },
    },
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(result.steps[1].state, 'failed');
  // This is refused by `originAllowlist.mjs` (the destination is outside
  // this tenant's allowlist entirely), one layer before the request-policy
  // re-check exercised by the test above it — both must produce the same
  // fixed, non-parameterised message for a runtime-bound URL.
  assert.equal(
    result.steps[1].detail,
    'Refused: step "follow"\'s request URL is malformed or is not one of the configured allowed destinations.',
  );
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('attacker.example.net'), 'the captured, disallowed origin must never reach the result');
  assert.equal(secondCallMade, false, 'a disallowed-origin captured URL must never actually be fetched');
});

test('a request policy refusal for a burst step blocks every iteration, before even the first fetch is sent', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return { status: 200, headers: {}, text: async () => '' };
  };
  const plan = { ...minimalPlan({
    steps: [
      step.http({
        id: 'burst',
        title: 'Burst',
        detail: 'Repeat request to a policy-disallowed URL.',
        request: { method: 'POST', url: `${GATEWAY_ORIGIN}/attacker-path`, repeat: { count: 5, concurrency: 2, timeoutSeconds: 5 } },
        produces: ['statusCodes', 'errors'],
      }),
    ],
  }), sampleId: 'policy-test-sample' };
  const requestPolicy = createSampleRequestPolicy({
    'policy-test-sample': { burst: { urls: [`${GATEWAY_ORIGIN}/health`] } },
  });
  const executor = createRelayHttpExecutor({ fetchImpl: fetch, allowlist: allowlist(), requestPolicy });
  const result = await executor.execute(plan, { secrets: {} });
  assert.equal(calls, 0, 'not one burst iteration may reach the network when the URL is policy-disallowed');
  assert.equal(result.steps[0].state, 'failed');
  assert.match(result.steps[0].detail, /request policy/);
});

test('createRelayHttpExecutor rejects a requestPolicy missing the required authorize functions', () => {
  assert.throws(
    () => createRelayHttpExecutor({ fetchImpl: async () => {}, allowlist: allowlist(), requestPolicy: {} }),
    TypeError,
  );
});
