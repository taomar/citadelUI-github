/**
 * Exact-schema request handling for the relay wire protocol.
 *
 * The relay speaks a strict SUBSET of `/api/run`'s contract, reusing
 * `validateRunRequest`/`rebuildPlan` verbatim, plus its own allow-list and
 * nonce-carrying acknowledgement. These tests prove: the allow-list is
 * computed from the catalogue's own risk/step-type shape (never
 * hand-maintained and never widened by a structural-eligibility quirk); the
 * exact-member schema rejects anything not in the fixed shape; secrets are
 * never accepted from the caller; and a rebuilt plan is refused if it would
 * require a step type the relay does not run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSamplePlan, CATALOGUE, getSample, requirementsFor } from '../../src/catalogue/index.mjs';
import { RequestRefused } from '../../src/server/runRequest.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../../src/core/types.mjs';
import {
  computeRelayAllowedSampleIds,
  RELAY_SUPPORTED_STEP_TYPES,
  rebuildRelayPlan,
  validateExecuteRequest,
} from '../../src/relay/requestSchema.mjs';
import { makeFixtureReader } from '../helpers/fixtures.mjs';

const DEFAULT_ALLOWED = computeRelayAllowedSampleIds(CATALOGUE, { buildSamplePlan, requirementsFor });

function fixtureInputsFor(sample) {
  const read = makeFixtureReader();
  const inputs = {};
  for (const entry of sample.configurationEntries) {
    if (entry.secret) continue;
    inputs[entry.path] = read(entry.path);
  }
  return inputs;
}

/* -------------------------------------------------- computeRelayAllowedSampleIds */

test('the default relay allow-list is exactly the catalogue read-only, http/assertion-only samples', () => {
  assert.deepEqual(
    [...DEFAULT_ALLOWED].sort(),
    ['a2a-agent-card', 'a2a-message-send', 'learn-mcp-discovery', 'weather-mcp-discovery', 'weather-tools-call'].sort(),
  );
});

test('every allow-listed sample is genuinely risk.level "read-only"', () => {
  for (const id of DEFAULT_ALLOWED) {
    assert.equal(getSample(id).risk.level, 'read-only', `${id} must be read-only to be relay-eligible`);
  }
});

test('a load-generating sample is excluded even when every one of its steps is http/assertion', () => {
  const burst = getSample('tool-rate-limit-burst');
  assert.notEqual(burst.risk.level, 'read-only');
  const { plan } = buildSamplePlan(burst, makeFixtureReader());
  const requiredTypes = plan.requiredStepTypes.filter((type) => !RELAY_SUPPORTED_STEP_TYPES.includes(type));
  assert.deepEqual(requiredTypes, [], 'the sample really is structurally http/assertion-only');
  assert.ok(!DEFAULT_ALLOWED.includes('tool-rate-limit-burst'), 'risk gates it out regardless of its step shape');
});

test('a sample requiring artifact/azure-cli/library steps is excluded', () => {
  assert.ok(!DEFAULT_ALLOWED.includes('publish-assets'));
  assert.ok(!DEFAULT_ALLOWED.includes('weather-api-ensure'));
});

test('computeRelayAllowedSampleIds never throws for a structurally-incomplete sample; it is excluded instead', () => {
  // hub.gatewayUrl has no catalogue-wide default. If the eligibility scan did
  // not synthesise a placeholder for it, every gateway-dependent sample would
  // either throw or be wrongly excluded. Proven here by the presence of
  // gateway-dependent samples in the computed list.
  assert.ok(DEFAULT_ALLOWED.length > 0);
  assert.doesNotThrow(() => computeRelayAllowedSampleIds(CATALOGUE, { buildSamplePlan, requirementsFor }));
});

/* -------------------------------------------------------- validateExecuteRequest */

function validRequest(sampleId, overrides = {}) {
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sampleId,
    inputs: fixtureInputsFor(getSample(sampleId)),
    ...overrides,
  };
}

test('a well-formed request for an allow-listed sample validates and returns the canonical shape', () => {
  const result = validateExecuteRequest(validRequest('weather-mcp-discovery'), CATALOGUE, {
    relayAllowedSampleIds: DEFAULT_ALLOWED,
  });
  assert.equal(result.sample.id, 'weather-mcp-discovery');
  assert.deepEqual(result.secretRefs, ['gatewayAccess.apiKey']);
  assert.equal(result.acknowledgement, null);
});

test('a member outside the fixed schema is rejected by name, even a plausible-looking one', () => {
  for (const extra of ['secrets', 'plan', 'url', 'headers', 'command', 'path']) {
    assert.throws(
      () =>
        validateExecuteRequest({ ...validRequest('weather-mcp-discovery'), [extra]: {} }, CATALOGUE, {
          relayAllowedSampleIds: DEFAULT_ALLOWED,
        }),
      (error) => error instanceof RequestRefused && error.status === (extra === 'secrets' ? 400 : 400),
      `"${extra}" must be refused`,
    );
  }
});

test('`secrets` is refused with its own explicit code, distinct from a generic forbidden member', () => {
  try {
    validateExecuteRequest({ ...validRequest('weather-mcp-discovery'), secrets: { x: 'y' } }, CATALOGUE, {
      relayAllowedSampleIds: DEFAULT_ALLOWED,
    });
    assert.fail('expected a RequestRefused');
  } catch (error) {
    assert.ok(error instanceof RequestRefused);
    assert.equal(error.code, 'secrets-not-accepted');
  }
});

test('an unrecognised top-level member reports code forbidden-member', () => {
  try {
    validateExecuteRequest({ ...validRequest('weather-mcp-discovery'), unexpected: 1 }, CATALOGUE, {
      relayAllowedSampleIds: DEFAULT_ALLOWED,
    });
    assert.fail('expected a RequestRefused');
  } catch (error) {
    assert.equal(error.code, 'forbidden-member');
  }
});

test('a sample outside the relay allow-list is refused with a 403 and an explicit code', () => {
  try {
    // Read-only (no acknowledgement gate), but structurally azure-cli, so it
    // is never relay-eligible regardless of any allow-list contents supplied
    // here — this isolates the allow-list rejection from the risk gate.
    validateExecuteRequest(validRequest('azure-context-check'), CATALOGUE, {
      relayAllowedSampleIds: DEFAULT_ALLOWED,
    });
    assert.fail('expected a RequestRefused');
  } catch (error) {
    assert.ok(error instanceof RequestRefused);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'relay-sample-not-allowed');
  }
});

test('an empty allow-list refuses every sample, including one that would otherwise be structurally eligible', () => {
  assert.throws(
    () => validateExecuteRequest(validRequest('weather-mcp-discovery'), CATALOGUE, { relayAllowedSampleIds: [] }),
    (error) => error instanceof RequestRefused && error.code === 'relay-sample-not-allowed',
  );
});

test('secretRefs is always recomputed from the sample; the caller cannot widen or invent one', () => {
  const withoutClaim = validateExecuteRequest(validRequest('weather-mcp-discovery'), CATALOGUE, {
    relayAllowedSampleIds: DEFAULT_ALLOWED,
  });
  assert.deepEqual(withoutClaim.secretRefs, ['gatewayAccess.apiKey']);

  // A caller-supplied secretRefs is checked against the canonical set, but the
  // returned value is still the canonical set — never simply echoed back.
  const withNarrowerClaim = validateExecuteRequest(
    validRequest('weather-mcp-discovery', { secretRefs: ['gatewayAccess.apiKey'] }),
    CATALOGUE,
    { relayAllowedSampleIds: DEFAULT_ALLOWED },
  );
  assert.deepEqual(withNarrowerClaim.secretRefs, ['gatewayAccess.apiKey']);
});

test('a secretRefs entry the sample does not declare is refused', () => {
  assert.throws(
    () =>
      validateExecuteRequest(validRequest('weather-mcp-discovery', { secretRefs: ['not.a.real.ref'] }), CATALOGUE, {
        relayAllowedSampleIds: DEFAULT_ALLOWED,
      }),
    (error) => error instanceof RequestRefused && error.code === 'unknown-secret-ref',
  );
});

test('a non-array secretRefs is refused', () => {
  assert.throws(
    () =>
      validateExecuteRequest(validRequest('weather-mcp-discovery', { secretRefs: 'gatewayAccess.apiKey' }), CATALOGUE, {
        relayAllowedSampleIds: DEFAULT_ALLOWED,
      }),
    (error) => error instanceof RequestRefused && error.code === 'invalid-secret-refs',
  );
});

test('an unsupported protocol version is refused (reused verbatim from validateRunRequest)', () => {
  assert.throws(
    () =>
      validateExecuteRequest(validRequest('weather-mcp-discovery', { protocolVersion: 1 }), CATALOGUE, {
        relayAllowedSampleIds: DEFAULT_ALLOWED,
      }),
    (error) => error instanceof RequestRefused && error.code === 'protocol-version',
  );
});

test('an unknown sample id is refused before the allow-list is even consulted', () => {
  assert.throws(
    () =>
      validateExecuteRequest(
        { protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'not-a-real-sample', inputs: {} },
        CATALOGUE,
        { relayAllowedSampleIds: DEFAULT_ALLOWED },
      ),
    (error) => error instanceof RequestRefused && error.code === 'unknown-sample',
  );
});

test('a non-object payload is refused', () => {
  for (const bad of [null, 'string', 42, [], undefined]) {
    assert.throws(() => validateExecuteRequest(bad, CATALOGUE, { relayAllowedSampleIds: DEFAULT_ALLOWED }), RequestRefused);
  }
});

/* -------------------------------------------------------------- rebuildRelayPlan */

test('rebuildRelayPlan builds a plan for an allow-listed sample without ever receiving a real secret value', () => {
  const sample = getSample('weather-mcp-discovery');
  const inputs = fixtureInputsFor(sample);
  const { plan } = rebuildRelayPlan({ sample, inputs }, CATALOGUE, { buildSamplePlan, requirementsFor });
  assert.ok(plan);
  assert.equal(plan.sampleId, 'weather-mcp-discovery');
  assert.ok(plan.requiredStepTypes.every((type) => RELAY_SUPPORTED_STEP_TYPES.includes(type)));
  assert.ok(
    !JSON.stringify(plan).includes('relay-secret-provider-placeholder'),
    'the secret placeholder must never reach the built plan',
  );
});

test('rebuildRelayPlan refuses a sample whose plan requires a step type the relay does not run', () => {
  const sample = getSample('publish-assets');
  const inputs = fixtureInputsFor(sample);
  assert.throws(
    () => rebuildRelayPlan({ sample, inputs }, CATALOGUE, { buildSamplePlan, requirementsFor }),
    (error) => error instanceof RequestRefused && error.code === 'unsupported-step-type',
  );
});

test('rebuildRelayPlan works for every sample in the default allow-list', () => {
  for (const id of DEFAULT_ALLOWED) {
    const sample = getSample(id);
    const inputs = fixtureInputsFor(sample);
    const { plan, resolvedInputs } = rebuildRelayPlan({ sample, inputs }, CATALOGUE, { buildSamplePlan, requirementsFor });
    assert.ok(plan, `${id} should build a plan`);
    assert.ok(resolvedInputs, `${id} should resolve its inputs`);
  }
});
