import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  claimBrowserSession,
  consumeBootstrapCapability,
  normalizeSessionAuthDescriptor,
} from '../web/js/sessionAuth.mjs';

const CAPABILITY = 'A'.repeat(43);

test('the launch capability is removed from the URL before it can be reused', () => {
  const calls = [];
  const capability = consumeBootstrapCapability({
    locationRef: {
      hash: `#bootstrap=${CAPABILITY}`,
      pathname: '/',
      search: '?recipe=cleanup',
    },
    historyRef: {
      replaceState(...args) {
        calls.push(args);
      },
    },
  });

  assert.equal(capability, CAPABILITY);
  assert.deepEqual(calls, [[null, '', '/?recipe=cleanup']]);
});

test('invalid or unrelated fragments are not consumed', () => {
  let replaced = false;
  const capability = consumeBootstrapCapability({
    locationRef: { hash: '#stage=review', pathname: '/', search: '' },
    historyRef: { replaceState: () => { replaced = true; } },
  });

  assert.equal(capability, null);
  assert.equal(replaced, false);
});

test('the session descriptor accepts only the fixed same-origin claim endpoint', () => {
  assert.deepEqual(
    normalizeSessionAuthDescriptor({
      required: true,
      state: 'unclaimed',
      claimEndpoint: 'https://example.test/claim',
      message: 'Open the secure launch URL.',
    }),
    {
      required: true,
      state: 'unclaimed',
      claimEndpoint: null,
      message: 'Open the secure launch URL.',
    },
  );
});

test('claim sends the one-use capability only in the fixed header', async () => {
  const calls = [];
  const result = await claimBrowserSession({
    descriptor: {
      required: true,
      state: 'unclaimed',
      claimEndpoint: '/api/session/claim',
    },
    capability: CAPABILITY,
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return { status: 204 };
    },
  });

  assert.deepEqual(result, { claimed: true, skipped: false, reason: '' });
  assert.equal(calls[0].path, '/api/session/claim');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers['X-Citadel-Bootstrap-Capability'], CAPABILITY);
  assert.deepEqual(JSON.parse(calls[0].options.body), { protocolVersion: 1 });
  assert.doesNotMatch(calls[0].options.body, new RegExp(CAPABILITY));
});

test('claim fails closed without the advertised endpoint and valid capability', async () => {
  const result = await claimBrowserSession({
    descriptor: { required: true, state: 'unclaimed', claimEndpoint: null },
    capability: 'short',
    fetchImpl: async () => {
      throw new Error('must not call');
    },
  });
  assert.deepEqual(result, {
    claimed: false,
    skipped: false,
    reason: 'missing-capability',
  });
});
