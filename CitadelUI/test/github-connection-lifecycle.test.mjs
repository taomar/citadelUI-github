import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConnectionProfileStore } from '../server/connections.mjs';
import { CredentialVault } from '../server/credentials.mjs';
import { GitHubApiClient } from '../server/github/api.mjs';
import { connectionStatus } from '../server/github/connection-lifecycle.mjs';
import { GitHubRoutes, connectionStatus as facadeStatus } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { MockGitHub, TEST_TOKEN } from './_github-mock.mjs';

const REPLACEMENT_TOKEN = `${TEST_TOKEN}_replacement`;

function observe(target, owner, methods, events) {
  for (const name of methods) {
    const original = target[name];
    target[name] = function (...args) {
      events.push(`${owner}.${name}`);
      return original.apply(this, args);
    };
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-a5-connections-'));
  let profiles, vault, sessions;
  t.after(async () => {
    await Promise.all([profiles?.queue, vault?.queue]);
    sessions?.clear();
    vault?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  profiles = await new ConnectionProfileStore({ dataRoot: root }).initialize();
  vault = await new CredentialVault({
    dataRoot: root,
    keySource: {
      read: async () => ({ bytes: Buffer.alloc(32, 0x5a), reason: 'synthetic-key' }),
      invalidReason: 'invalid-synthetic-key',
    },
  }).initialize();
  sessions = new GitHubSessionStore();
  const events = [], transport = [], notes = [];
  const github = new MockGitHub();
  const client = new GitHubApiClient({
    fetch: (href, init) => {
      const url = new URL(href);
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(init.headers.Authorization, `Bearer ${github.token}`);
      transport.push({
        method: init.method, path: url.pathname + url.search,
        body: init.body ?? null, redirect: init.redirect, cache: init.cache,
      });
      events.push(`${init.method} ${url.pathname}`);
      return github.fetch(href, init);
    },
  });
  const routes = new GitHubRoutes({
    profiles, vault, sessions, client,
    activity: { record(event) { notes.push(event); events.push(`note:${event.action}:${event.outcome}`); } },
  });
  observe(profiles, 'profiles', ['list', 'get', 'findByAccount', 'create', 'update', 'remove'], events);
  observe(vault, 'vault', ['has', 'load', 'store', 'remove'], events);
  observe(sessions, 'sessions', ['assertLoginAllowed', 'create', 'destroyProfile', 'findByProfile', 'hasProfile'], events);
  observe(routes, 'routes', ['forgetCaches'], events);
  const lifecycle = routes.connectionLifecycle;
  const reset = () => { events.length = 0; transport.length = 0; notes.length = 0; };
  const create = (persist = false) => routes.createConnection({ name: 'Work account', token: TEST_TOKEN, persist });
  return { root, profiles, vault, sessions, github, client, routes, lifecycle, events, transport, notes, reset, create };
}

function assertIdentityRead(f) {
  assert.deepEqual(f.transport, [{
    method: 'GET', path: '/user', body: null, redirect: 'manual', cache: 'no-store',
  }]);
}

test('A5 Git connections: status projection is the same facade function for every state', () => {
  assert.equal(facadeStatus, connectionStatus);
  for (const connected of [false, true]) {
    for (const persisted of [false, true]) {
      for (const vaultAvailable of [false, true]) {
        const expected = connected ? (persisted ? 'persistent' : 'session')
          : persisted ? (vaultAvailable ? 'persistent-idle' : 'unavailable') : 'reconnect';
        assert.equal(connectionStatus({ connected, persisted, vaultAvailable }), expected);
      }
    }
  }
});

test('A5 Git connections: the seam borrows the live owners and keeps facade signatures', async (t) => {
  const f = await fixture(t);
  assert.equal(f.lifecycle.sessions, f.sessions);
  assert.equal(f.lifecycle.profiles, f.profiles);
  assert.equal(f.lifecycle.vault, f.vault);
  assert.equal(f.lifecycle.client, f.client);
  assert.equal('treeCache' in f.lifecycle, false);
  assert.equal('blobCache' in f.lifecycle, false);
  const signatures = {
    requireProfiles: 0, profileIdOf: 1, connect: 1, identify: 1, connections: 0,
    persist: 2, connectionResult: 3, createConnection: 1, reconnectConnection: 2,
    resumeConnection: 1, renameConnection: 2, setConnectionPersistence: 2,
    disconnectConnection: 1, removeConnection: 1,
  };
  for (const [name, arity] of Object.entries(signatures)) {
    assert.equal(f.routes[name].length, arity, name);
    assert.equal(f.lifecycle[name].length, arity, name);
  }
  const replacement = { request: f.client.request.bind(f.client) };
  f.routes.client = replacement;
  assert.equal(f.lifecycle.client, replacement);
  assert.deepEqual(await f.routes.identify(TEST_TOKEN), f.github.user);
  assertIdentityRead(f);
});

test('A5 Git connections: unsupported fields and names fail before credential admission or requests', async (t) => {
  const f = await fixture(t);
  for (const [body, code] of [
    [{ name: 'Work', token: TEST_TOKEN, repositoryId: 9001 }, 'INVALID_CONTENT'],
    [{ name: ' ', token: 'short' }, 'INVALID_CONNECTION_NAME'],
  ]) {
    await assert.rejects(f.routes.createConnection(body), { status: 400, code });
    assert.deepEqual(f.events, []);
  }
  await assert.rejects(f.lifecycle.createConnection({ name: 'Work', token: 'short' }), {
    status: 400, code: 'GITHUB_TOKEN_INVALID',
  });
  assert.deepEqual(f.events, ['sessions.assertLoginAllowed']);
  assert.deepEqual(f.transport, []);
  assert.deepEqual(await f.profiles.list(), []);
  assert.equal(f.sessions.size, 0);
  assert.throws(() => f.routes.profileIdOf('../wrong'), { status: 400, code: 'INVALID_CONNECTION' });
});

test('A5 Git connections: create persists through the existing vault and never returns credential bytes', async (t) => {
  const f = await fixture(t);
  const result = await f.create(true);
  assert.deepEqual(f.events, [
    'sessions.assertLoginAllowed', 'GET /user', 'profiles.findByAccount', 'profiles.create',
    'vault.store', 'sessions.create', 'note:connection.create:ok', 'note:connection.persistence-enabled:ok',
  ]);
  assertIdentityRead(f);
  assert.equal(result.profile.status, 'persistent');
  assert.equal(result.profile.credentialMode, 'persistent');
  assert.equal(result.persisted, true);
  assert.equal(result.persistenceReason, null);
  assert.equal(f.sessions.resolve(result.session.id).token, TEST_TOKEN);
  assert.equal(await f.vault.load(result.profile.id, result.profile.accountId), TEST_TOKEN);
  for (const text of [
    JSON.stringify(result), JSON.stringify(f.notes),
    await readFile(f.profiles.path, 'utf8'),
    await readFile(f.vault.path(result.profile.id), 'utf8'),
  ]) assert.equal(text.includes(TEST_TOKEN), false);

  f.reset();
  await assert.rejects(f.routes.createConnection({ name: 'Duplicate', token: TEST_TOKEN }), {
    status: 409, code: 'CONNECTION_ACCOUNT_TAKEN', profileId: result.profile.id,
  });
  assert.deepEqual(f.events, [
    'sessions.assertLoginAllowed', 'GET /user', 'profiles.findByAccount', 'note:connection.create:refused',
  ]);
  assert.equal(f.sessions.size, 1);
});

test('managed GitHub accounts retain encrypted credentials and numeric identity on restore', async (t) => {
  const f = await fixture(t);
  f.github.user.login = 'octo-dev_acme';
  const created = await f.create(true);
  assert.equal(created.persisted, true);
  assert.equal(created.profile.accountLogin, 'octo-dev_acme');
  await f.routes.disconnectConnection(created.profile.id);
  const restored = await f.routes.resumeConnection(created.profile.id);
  assert.equal(restored.profile.accountId, created.profile.accountId);
  assert.equal(restored.profile.accountLogin, 'octo-dev_acme');
  assert.equal(restored.persisted, true);
  assert.equal(JSON.stringify(restored).includes(TEST_TOKEN), false);
  assert.equal((await readFile(f.vault.path(created.profile.id), 'utf8')).includes(TEST_TOKEN), false);
});

for (const failure of ['throw', 'false', 'unavailable']) {
  test(`A5 Git connections: reconnect erases the old envelope before ${failure} persistence`, async (t) => {
    const f = await fixture(t);
    const before = await f.create(true);
    const oldSession = f.sessions.resolve(before.session.id);
    f.github.token = REPLACEMENT_TOKEN;
    f.vault.store = async () => {
      f.events.push('vault.store');
      assert.equal(await f.vault.has(before.profile.id), false);
      if (failure === 'throw') throw new Error('Synthetic encryption failure');
      return false;
    };
    if (failure === 'unavailable') f.vault.close();
    f.reset();
    const after = await f.routes.reconnectConnection(before.profile.id, { token: REPLACEMENT_TOKEN });
    assert.deepEqual(f.events, [
      'profiles.get', 'sessions.assertLoginAllowed', 'GET /user', 'sessions.destroyProfile',
      'vault.remove', ...(failure === 'unavailable' ? [] : ['vault.store', 'vault.has']),
      'profiles.update', 'sessions.create', 'note:connection.reconnect:ok',
    ]);
    assertIdentityRead(f);
    assert.equal(oldSession.token, null);
    assert.equal(f.sessions.status(before.session.id).connected, false);
    assert.equal(f.sessions.resolve(after.session.id).token, REPLACEMENT_TOKEN);
    assert.equal(await f.vault.has(before.profile.id), false);
    assert.equal((await f.profiles.get(before.profile.id)).credentialMode, 'session');
    assert.equal(after.persisted, false);
    assert.equal(after.persistenceReason, 'persistence-unavailable');
    assert.equal(after.profile.status, 'session');
    assert.equal(JSON.stringify(after).includes(REPLACEMENT_TOKEN), false);
  });
}

test('A5 Git connections: reconnect refuses another account before destroying or sealing anything', async (t) => {
  const f = await fixture(t);
  const before = await f.create(true);
  f.github.user = { login: 'another-account', id: 8181, type: 'User' };
  f.reset();
  await assert.rejects(f.lifecycle.reconnectConnection(before.profile.id, { token: TEST_TOKEN }), {
    status: 409, code: 'CONNECTION_ACCOUNT_MISMATCH',
    expectedLogin: 'octo-dev', actualLogin: 'another-account',
  });
  assert.deepEqual(f.events, [
    'profiles.get', 'sessions.assertLoginAllowed', 'GET /user', 'note:connection.reconnect:refused',
  ]);
  assertIdentityRead(f);
  assert.equal(f.sessions.resolve(before.session.id).token, TEST_TOKEN);
  assert.equal(await f.vault.load(before.profile.id, 4242), TEST_TOKEN);
  assert.equal((await f.profiles.get(before.profile.id)).credentialMode, 'persistent');
});

test('A5 Git connections: an erasure exception stops reconnect instead of minting a replacement', async (t) => {
  const f = await fixture(t);
  const before = await f.create(true);
  const oldSession = f.sessions.resolve(before.session.id);
  const error = new Error('Synthetic erase-port failure');
  f.vault.remove = async () => { f.events.push('vault.remove'); throw error; };
  f.reset();
  await assert.rejects(f.lifecycle.reconnectConnection(before.profile.id, { token: TEST_TOKEN }), (thrown) => thrown === error);
  assert.deepEqual(f.events, [
    'profiles.get', 'sessions.assertLoginAllowed', 'GET /user', 'sessions.destroyProfile', 'vault.remove',
  ]);
  assert.equal(oldSession.token, null);
  assert.equal(f.sessions.size, 0);
  assert.equal(await f.vault.has(before.profile.id), true);
});

test('A5 Git connections: disconnect, list and resume share sessions without resealing credentials', async (t) => {
  const f = await fixture(t);
  const before = await f.create(true);
  const oldSession = f.sessions.resolve(before.session.id);
  f.routes.treeCache.set('tree', {});
  f.routes.blobCache.set('blob', {});
  f.reset();
  const disconnected = await f.routes.disconnectConnection(before.profile.id);
  assert.deepEqual(f.events, [
    'profiles.get', 'sessions.destroyProfile', 'routes.forgetCaches', 'vault.has', 'note:connection.disconnect:ok',
  ]);
  assert.equal(disconnected.disconnected, true);
  assert.equal(disconnected.profile.status, 'persistent-idle');
  assert.equal(oldSession.token, null);
  assert.equal(f.routes.treeCache.size, 0);
  assert.equal(f.routes.blobCache.size, 0);
  assert.deepEqual(f.transport, []);
  const listed = await f.routes.connections();
  assert.equal(listed.profiles[0].status, 'persistent-idle');
  assert.equal(JSON.stringify(listed).includes(before.session.id), false);
  f.reset();
  const resumed = await f.lifecycle.resumeConnection(before.profile.id);
  assert.deepEqual(f.events, [
    'profiles.get', 'vault.load', 'GET /user', 'sessions.destroyProfile', 'sessions.create',
    'profiles.update', 'note:connection.restore:ok',
  ]);
  assertIdentityRead(f);
  assert.notEqual(resumed.session.id, before.session.id);
  assert.equal(resumed.profile.status, 'persistent');
  assert.equal(f.sessions.resolve(resumed.session.id).token, TEST_TOKEN);
  assert.equal(f.sessions.size, 1);
});

test('A5 Git connections: resume removes a wrong-account envelope before refusing it', async (t) => {
  const f = await fixture(t);
  const before = await f.create(true);
  await f.routes.disconnectConnection(before.profile.id);
  f.github.user = { login: 'another-account', id: 8181, type: 'User' };
  f.reset();
  await assert.rejects(f.routes.resumeConnection(before.profile.id), {
    status: 409, code: 'CONNECTION_ACCOUNT_MISMATCH',
  });
  assert.deepEqual(f.events, [
    'profiles.get', 'vault.load', 'GET /user', 'vault.remove', 'note:connection.restore:refused',
  ]);
  assert.equal(f.sessions.size, 0);
  assert.equal(await f.vault.has(before.profile.id), false);
});

test('A5 Git connections: missing profiles and unavailable envelopes never become a connected result', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.routes.resumeConnection('missing-profile'), { status: 404, code: 'UNKNOWN_CONNECTION' });
  assert.deepEqual(f.events, ['profiles.get']);
  const before = await f.create();
  f.reset();
  await assert.rejects(f.routes.resumeConnection(before.profile.id), { status: 409, code: 'CREDENTIAL_UNAVAILABLE' });
  assert.deepEqual(f.events, ['profiles.get', 'vault.load', 'note:connection.restore:failed']);
  f.vault.close();
  f.reset();
  await assert.rejects(f.routes.resumeConnection(before.profile.id), { status: 409, code: 'CREDENTIAL_UNAVAILABLE' });
  assert.deepEqual(f.events, ['profiles.get']);
  assert.deepEqual(f.transport, []);
});

test('A5 Git connections: persistence toggles and renaming never create another session or credential owner', async (t) => {
  const f = await fixture(t);
  const before = await f.create();
  f.reset();
  const enabled = await f.lifecycle.setConnectionPersistence(before.profile.id, { persist: true });
  assert.deepEqual(f.events, [
    'profiles.get', 'sessions.findByProfile', 'vault.store', 'profiles.update', 'note:connection.persistence-enabled:ok',
  ]);
  assert.equal(enabled.profile.status, 'persistent');
  f.reset();
  const disabled = await f.routes.setConnectionPersistence(before.profile.id, { persist: false });
  assert.deepEqual(f.events, [
    'profiles.get', 'vault.remove', 'profiles.update', 'note:connection.persistence-disabled:ok', 'sessions.hasProfile',
  ]);
  assert.equal(disabled.profile.status, 'session');
  assert.equal(await f.vault.has(before.profile.id), false);
  const renamed = await f.routes.renameConnection(before.profile.id, { name: 'Renamed account' });
  assert.equal(renamed.profile.name, 'Renamed account');
  assert.equal(renamed.profile.id, before.profile.id);
  assert.equal(renamed.profile.accountId, before.profile.accountId);
  assert.equal(f.sessions.size, 1);
  assert.deepEqual(f.transport, []);

  await f.routes.disconnectConnection(before.profile.id);
  f.reset();
  await assert.rejects(f.routes.setConnectionPersistence(before.profile.id, { persist: true }), {
    status: 409, code: 'CONNECTION_NOT_LIVE',
  });
  assert.deepEqual(f.events, ['profiles.get', 'sessions.findByProfile']);
});

test('A5 Git connections: removal uses existing metadata, session, cache and vault ports in order', async (t) => {
  const f = await fixture(t);
  const before = await f.create(true);
  const oldSession = f.sessions.resolve(before.session.id);
  f.routes.treeCache.set('tree', {});
  f.routes.blobCache.set('blob', {});
  f.reset();
  assert.deepEqual(await f.lifecycle.removeConnection(before.profile.id), { removed: true, profileId: before.profile.id });
  assert.deepEqual(f.events, [
    'profiles.remove', 'sessions.destroyProfile', 'routes.forgetCaches', 'vault.remove', 'note:connection.remove:ok',
  ]);
  assert.equal(oldSession.token, null);
  assert.equal(await f.profiles.get(before.profile.id), null);
  assert.equal(await f.vault.has(before.profile.id), false);
  assert.equal(f.routes.treeCache.size, 0);
  assert.equal(f.routes.blobCache.size, 0);
  assert.deepEqual(f.transport, []);
});

test('A5 Git connections: legacy session creation and deletion retain their original erasure envelope', async (t) => {
  const f = await fixture(t);
  const connected = await f.routes.connect({ token: TEST_TOKEN });
  assert.deepEqual(f.events, ['sessions.assertLoginAllowed', 'GET /user', 'sessions.create']);
  assertIdentityRead(f);
  const session = f.sessions.resolve(connected.id);
  const response = await f.routes.handle({
    req: { method: 'DELETE' }, parts: ['api', 'github', 'sessions', connected.id],
  });
  assert.deepEqual(response, { disconnected: true, erased: true });
  assert.equal(session.token, null);
  assert.equal(f.sessions.size, 0);
  assert.deepEqual(await f.profiles.list(), []);
});
