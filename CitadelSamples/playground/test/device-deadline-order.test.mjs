import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAuth } from '../src/hosted/deviceAuth.mjs';
import { createSessions } from '../src/hosted/sessions.mjs';
import { hostedConfig, deviceClientId, operatorClaims } from './helpers/hostedFixtures.mjs';

function setup(t, { expiresIn = 300, pending = false, config: overrides = {}, claimsExpire = false } = {}) {
  const origin = 1750000000000;
  let clock = origin, release, request, verifications = 0;
  const result = new Promise((resolve) => { release = resolve; });
  const config = hostedConfig({ maxTransactions: 1, deviceClientId, ...overrides });
  const sessions = createSessions(config, { now: () => clock });
  const auth = {
    client: () => ({ acquireTokenByDeviceCode(value) {
      request = value;
      value.deviceCodeCallback({ userCode: 'SYNTHETIC', deviceCode: 'synthetic-private-device-grant',
        verificationUri: 'https://microsoft.com/devicelogin', expiresIn, interval: 1 });
      return result;
    } }),
    verifyDevice() { verifications++; assert.fail('Expired/cancelled result reached identity verification.'); },
  };
  const device = createDeviceAuth(config, sessions, auth);
  const owner = pending ? null : sessions.create();
  if (claimsExpire) owner.claims = { ...operatorClaims(), exp: origin / 1000 + 1 };
  const flow = device.begin(owner, 'signin', 'deadline-fixture');
  device.start(flow.session, flow.flowId);
  const initial = device.status(flow.session, flow.flowId);
  assert.equal(initial.state, 'pending');
  assert.equal(typeof initial.userCode === 'string', true);
  assert.equal(initial.deviceCode, undefined);
  t.after(async () => { release({}); await device.close(); sessions.close(); });
  return {
    device, sessions, flow, origin, initial,
    advance(time) { assert.ok(time >= clock, 'Each fixture clock must move forward.'); clock = time; },
    status: () => device.status(flow.session, flow.flowId),
    assertFenced(expected) {
      const value = device.status(flow.session, flow.flowId);
      assert.equal(value.state, expected);
      assert.equal(value.code, expected === 'expired' ? 'device-expired' : 'device-cancelled');
      assert.equal(value.settled, false);
      assert.equal(value.userCode, undefined);
      assert.equal(value.deviceCode, undefined);
      assert.equal(request.cancel, true);
      assert.throws(() => device.complete(flow.session, flow.flowId), { status: 409 });
      assert.throws(() => sessions.begin(null, 'signin', null, 'capacity-probe'), { status: 429 });
    },
    async settle() {
      release({ idToken: 'synthetic-late-result-must-not-be-adopted' });
      await result;
      assert.equal(verifications, 0);
      assert.deepEqual(flow.session.credentials, {});
      const next = sessions.begin(null, 'signin', null, 'capacity-probe');
      assert.equal(next.state !== flow.flowId, true);
      sessions.endAuth(sessions.get(next.sessionId), next);
    },
  };
}

for (const order of ['session-first', 'device-first']) {
  for (const expiresIn of [300, 2]) {
    test(`${order}: ${expiresIn === 2 ? 'short provider' : 'application'} deadline is expired and holds capacity until settlement`, async (t) => {
      const app = setup(t, { expiresIn });
      assert.equal(app.initial.expiresAt, app.origin + expiresIn * 1000);
      assert.equal(app.initial.deadlineAt, app.origin + 300000);
      app.advance(app.initial.expiresAt);
      if (order === 'session-first') app.sessions.sweep();
      else app.status();
      app.assertFenced('expired');
      await app.settle();
      if (expiresIn === 2) {
        assert.equal(app.status().state, 'expired');
        assert.equal(app.status().settled, true);
      } else assert.equal(app.device.pending(app.flow.session), null);
    });
  }
}

test('explicit Cancel remains cancelled while unsettled polling crosses provider expiry', async (t) => {
  const app = setup(t, { expiresIn: 2 });
  app.advance(app.origin + 1000);
  app.device.cancel(app.flow.session, app.flow.flowId);
  app.advance(app.initial.expiresAt);
  app.sessions.sweep();
  app.assertFenced('cancelling');
  await app.settle();
  assert.equal(app.status().state, 'cancelled');
  assert.equal(app.status().code, 'device-cancelled');
  assert.equal(app.status().settled, true);
});

for (const expiry of ['pending', 'idle', 'absolute', 'claims']) {
  test(`${expiry} session lifetime propagates expiry without releasing an unsettled device grant`, async (t) => {
    const app = setup(t, { pending: expiry === 'pending', claimsExpire: expiry === 'claims',
      config: expiry === 'idle' ? { idleMs: 1000 } : expiry === 'absolute' ? { absoluteMs: 1000 } : {} });
    app.advance(expiry === 'pending' ? app.initial.deadlineAt : app.origin + 1000);
    assert.equal(app.sessions.get(app.flow.session.id, { touch: false }), null);
    app.assertFenced('expired');
    await app.settle();
  });
}
