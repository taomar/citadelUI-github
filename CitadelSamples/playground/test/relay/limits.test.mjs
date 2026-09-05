import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHostedRelay } from '../../relay-server.mjs';
import {
  HOSTED_RELAY_LIMIT_SCHEMA,
  readHostedRelayLimits,
  relayExecutorLimitsFromHosted,
  relayServerLimitsFromHosted,
  validateHostedRelayLimits,
  validateRelayExecutorLimits,
} from '../../src/relay/limits.mjs';

test('the hosted relay limit schema is exact, bounded, and translated to server and executor names', () => {
  assert.deepEqual(Object.keys(HOSTED_RELAY_LIMIT_SCHEMA), [
    'bodyLimitBytes',
    'runTimeoutMs',
    'requestTimeoutMs',
    'maxRequestsPerRun',
    'maxConcurrentRequests',
  ]);
  const hosted = validateHostedRelayLimits({
    bodyLimitBytes: 4096,
    runTimeoutMs: 20_000,
    requestTimeoutMs: 5000,
    maxRequestsPerRun: 7,
    maxConcurrentRequests: 3,
  });
  assert.deepEqual(relayServerLimitsFromHosted(hosted), {
    bodyLimitBytes: 4096,
    runTimeoutMs: 20_000,
    maxConcurrentRequests: 3,
  });
  assert.deepEqual(relayExecutorLimitsFromHosted(hosted), {
    stepTimeoutMs: 5000,
    runTimeoutMs: 20_000,
    maxOutputBytes: 256 * 1024,
    maxResponseBytes: 512 * 1024,
    maxBurstRequests: 7,
    maxRequestsPerRun: 7,
    maxConcurrency: 3,
  });
});

test('hosted relay limits reject unknown, malformed, out-of-range, and internally inconsistent values', () => {
  assert.throws(() => validateHostedRelayLimits({ maxConcurrency: 2 }), /Unknown hosted relay limit key/);
  assert.throws(() => validateHostedRelayLimits({ maxConcurrentRequests: 0 }), /between 1 and 32/);
  assert.throws(
    () => validateHostedRelayLimits({ runTimeoutMs: 1000, requestTimeoutMs: 1001 }),
    /must not exceed "runTimeoutMs"/,
  );
  assert.throws(
    () => readHostedRelayLimits({ CITADEL_RELAY_MAX_REQUESTS_PER_RUN: '1e3' }),
    /unsigned base-10 integer/,
  );
  assert.throws(() => validateRelayExecutorLimits({ maxConcurrentRequests: 2 }), /Unknown relay executor limit key/);
  assert.throws(
    () => validateRelayExecutorLimits({ runTimeoutMs: 10, stepTimeoutMs: 11 }),
    /must not exceed "runTimeoutMs"/,
  );
});

test('the hosted entrypoint wires every static environment limit to the enforcing layer', async () => {
  const server = buildHostedRelay({
    CITADEL_RELAY_ENTRA_AUTHENTICATED: 'true',
    CITADEL_RELAY_TOKEN_VERSION: '2',
    CITADEL_RELAY_TOKEN_ISSUER: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0',
    CITADEL_RELAY_TOKEN_RESOURCE: 'api://22222222-2222-4222-8222-222222222222',
    CITADEL_RELAY_TOKEN_AUDIENCE: '22222222-2222-4222-8222-222222222222',
    CITADEL_RELAY_ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    CITADEL_RELAY_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    CITADEL_RELAY_ALLOWED_PRINCIPAL_ID: '33333333-3333-3333-3333-333333333333',
    CITADEL_RELAY_ALLOWED_SAMPLE_IDS: '[]',
    CITADEL_RELAY_ALLOWED_ORIGINS: '["https://gateway.example.test"]',
    CITADEL_RELAY_REQUEST_POLICY: '{}',
    CITADEL_RELAY_SECRET_MAPPINGS: '{}',
    CITADEL_RELAY_KEY_VAULT_URI: 'https://vault.example.test',
    CITADEL_RELAY_MANAGED_IDENTITY_CLIENT_ID: 'relay-client',
    CITADEL_RELAY_BODY_LIMIT_BYTES: '8192',
    CITADEL_RELAY_RUN_TIMEOUT_MS: '25000',
    CITADEL_RELAY_HTTP_TIMEOUT_MS: '4000',
    CITADEL_RELAY_MAX_REQUESTS_PER_RUN: '6',
    CITADEL_RELAY_MAX_CONCURRENT_REQUESTS: '2',
  });

  assert.deepEqual(server.limits, {
    bodyLimitBytes: 8192,
    runTimeoutMs: 25_000,
    maxConcurrentRequests: 2,
  });
  const bundle = await server.tenantPolicy.resolve({
    tenant: '11111111-1111-4111-8111-111111111111',
    principal: '33333333-3333-3333-3333-333333333333',
    roles: [],
  });
  assert.equal(bundle.httpExecutor.limits.stepTimeoutMs, 4000);
  assert.equal(bundle.httpExecutor.limits.runTimeoutMs, 25_000);
  assert.equal(bundle.httpExecutor.limits.maxBurstRequests, 6);
  assert.equal(bundle.httpExecutor.limits.maxRequestsPerRun, 6);
  assert.equal(bundle.httpExecutor.limits.maxConcurrency, 2);
});
