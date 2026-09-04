/**
 * Exact request contracts for protected source and offline Python validation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CATALOGUE } from '../src/catalogue/index.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';
import { RequestRefused } from '../src/server/runRequest.mjs';
import {
  validateCodeValidationRequest,
  validateSourceSampleId,
} from '../src/server/recipeRequest.mjs';

test('a source route can select only an existing catalogue sample', () => {
  const request = validateSourceSampleId('weather-mcp-discovery', CATALOGUE);
  assert.equal(request.sample.id, 'weather-mcp-discovery');
  assert.throws(
    () => validateSourceSampleId('not-a-sample', CATALOGUE),
    (error) => error instanceof RequestRefused && error.code === 'unknown-sample' && error.status === 404,
  );
});

test('offline validation accepts exactly { protocolVersion } for the route-selected sample', () => {
  const request = validateCodeValidationRequest(
    'azure-context-check',
    { protocolVersion: EXECUTION_PROTOCOL_VERSION },
    CATALOGUE,
  );
  assert.equal(request.sample.id, 'azure-context-check');
  assert.deepEqual(Object.keys(request), ['sample']);
});

test('offline validation refuses every browser-supplied instruction, input, and secret', () => {
  const extras = [
    { inputs: {} },
    { secrets: {} },
    { code: 'print(1)' },
    { path: 'cell.py' },
    { command: 'python' },
    { url: 'https://example.test' },
    { executable: 'python' },
    { sampleId: 'cleanup' },
  ];
  for (const extra of extras) {
    assert.throws(
      () =>
        validateCodeValidationRequest(
          'azure-context-check',
          { protocolVersion: EXECUTION_PROTOCOL_VERSION, ...extra },
          CATALOGUE,
        ),
      (error) => error instanceof RequestRefused && error.code === 'forbidden-member',
      `expected ${Object.keys(extra)[0]} to be refused`,
    );
  }
});

test('offline validation refuses malformed bodies and protocol versions', () => {
  for (const payload of [null, [], 'x', 42]) {
    assert.throws(() => validateCodeValidationRequest('azure-context-check', payload, CATALOGUE), RequestRefused);
  }
  assert.throws(
    () => validateCodeValidationRequest('azure-context-check', { protocolVersion: 999 }, CATALOGUE),
    (error) => error instanceof RequestRefused && error.code === 'protocol-version',
  );
});
