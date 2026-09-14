import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationGitHubConnection } from '../web/js/migration-github-connection.mjs';
import { createCitadelServer } from '../server/index.mjs';
import { MIGRATION_ATTEMPT_HEADER, MIGRATION_SOURCE_ENDPOINT, MIGRATION_SOURCE_HEADER } from '../shared/migration-github-auth.mjs';
import { acceptCount, deferred } from './_migration-fixture.mjs';
import { armParameters, PUBLIC_FILE, PUBLIC_REPO, PUBLIC_SCHEMA, PUBLIC_TEMPLATE, PUBLIC_TEXT } from './_migration-public-fixture.mjs';
import { AuthenticatedGitHubMock, authenticatedHarness } from './_migration-auth-fixture.mjs';

test('migration authenticated donor accepts Contents Read without push/admin and applies one local transaction', async () => {
  const h = authenticatedHarness();
  const status = await h.connection.connect({ token: h.token });
  assert.equal(status.credentialSource, 'session-pat');
  assert.equal(h.connection.connected, true);
  assert.equal((await h.connection.inspectRepository(PUBLIC_REPO)).visibility, 'private');
  const donor = h.selectDonor();
  assert.equal(donor.kind, 'authenticated-github');
  const preview = await acceptCount(h);
  assert.equal(preview.canApply, true);
  assert.equal(preview.report.donor.revision.provider, 'authenticated-github');
  assert.equal(preview.report.donor.revision.visibility, 'private');
  assert.equal(preview.report.summary.proposedEdits, 1);
  assert.equal(preview.report.summary.copied, 0);
  for (const output of [status, donor.provenance(), preview, await h.session.export(preview.id, 'report')]) {
    assert(!JSON.stringify(output).includes(h.token));
    assert(!JSON.stringify(output).includes(h.mintedIds[0]));
  }
  await h.session.apply(preview.id, { reviewed: true });
  assert.equal(h.targetTrace.filter((entry) => entry.startsWith('write:')).length, 1);
  assert.equal(h.api.trace.filter((entry) => entry === 'prepare').length, 1);
  assert(!h.donorTrace.some((entry) => /write|writable|readwrite/.test(entry)));
  assert(h.github.authCalls.every((entry) => entry.method === 'GET' && entry.authenticated));
  assert(!h.localCalls.some((entry) => entry.path.includes(h.token)));
  assert.deepEqual(h.vaultWrites, []);
  await h.connection.disconnect();
  assert.equal(h.routes.migrationSource.sessions.size, 0);
  assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
});

test('migration saved source connection is cloned without revoking or replacing destination credentials', async () => {
  const h = authenticatedHarness();
  const choices = await h.connection.listConnections();
  assert.equal(choices.profiles[0].id, 'existing-connection');
  assert(!JSON.stringify(choices).includes(h.destinationToken));
  const status = await h.connection.connect({ profileId: 'existing-connection' });
  assert.equal(status.credentialSource, 'saved-connection');
  assert.equal(status.profile.id, 'existing-connection');
  assert.notEqual(h.mintedIds[0], h.destination.id);
  const preview = await acceptCount(h);
  assert.equal(preview.canApply, true);
  await h.connection.disconnect();
  assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
  assert.deepEqual(h.vaultWrites, []);
  assert.deepEqual(h.vaultReads, []);
});

for (const mode of ['token', 'saved']) {
  test(`migration ${mode} source lists real branches and inspects JSON without changing destination credentials`, async () => {
    const h = authenticatedHarness();
    h.github.seed('release/older', { [PUBLIC_FILE]: PUBLIC_TEXT });
    h.github.seed('legacy-main', {
      [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA,
      'bicep/infra/main.json': armParameters({ Count: { value: 5 } }),
      'bicep/infra/abbreviations.json': '{"appService":"app"}',
      'package.json': '{}',
    });
    await h.connection.connect(mode === 'saved' ? { profileId: 'existing-connection' } : { token: h.token });
    const metadata = await h.connection.inspectRepository(PUBLIC_REPO);
    const result = await h.connection.listBranches(metadata);
    assert.deepEqual(result.branches.map((branch) => branch.name), ['legacy-main', 'release/older']);
    const donor = h.selectDonor();
    const inventory = await h.session.inventory(donor);
    assert.equal(inventory.items.length, 2);
    assert.equal(inventory.ignored, 2);
    assert.deepEqual(inventory.issues, []);
    assert(h.github.authCalls.every((call) => call.authenticated && call.method === 'GET'));
    assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
    assert.deepEqual(h.vaultWrites, []);
    await assert.rejects(donor.read('package.json'), { code: 'private-scope' });
    await h.connection.disconnect();
  });
}

test('migration branch lookup honors Contents Read and invalidates a revoked source instead of falling back', async () => {
  const h = authenticatedHarness();
  await h.connection.connect({ token: h.token });
  const metadata = await h.connection.inspectRepository(PUBLIC_REPO);
  h.github.credentials.get(h.token).contentsRead = false;
  await assert.rejects(h.connection.listBranches(metadata), { code: 'private-access' });
  h.github.credentials.get(h.token).revoked = true;
  await assert.rejects(h.connection.listBranches(metadata), { code: 'private-auth-invalid' });
  assert.equal(h.connection.connected, false);
  assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
  assert(h.github.authCalls.every((call) => call.authenticated));
});
test('migration saved encrypted opt-in can supply a new isolated source session but is never rewritten', async () => {
  const h = authenticatedHarness();
  h.sessions.destroy(h.destination.id);
  h.persisted.set('existing-connection', h.destinationToken);
  const status = await h.connection.connect({ profileId: 'existing-connection' });
  assert.equal(status.profile.id, 'existing-connection');
  assert.deepEqual(h.vaultReads, ['existing-connection']);
  assert.deepEqual(h.vaultWrites, []);
  assert.equal(h.sessions.size, 0, 'borrowing must not create an ordinary editable session');
  await h.connection.disconnect();
  assert.equal(h.persisted.get('existing-connection'), h.destinationToken);
});

test('migration wrong-account, missing-profile and forbidden classic source credentials are explicit failures', async () => {
  const h = authenticatedHarness();
  h.sessions.destroy(h.destination.id);
  h.persisted.set('existing-connection', h.github.credential({ id: 5002, login: 'different-reader' }));
  await assert.rejects(h.connection.connect({ profileId: 'existing-connection' }), { code: 'private-account' });
  await assert.rejects(h.connection.connect({ profileId: 'missing' }), { code: 'private-profile' });
  await assert.rejects(h.connection.connect({ token: 'ghp_SYNTHETIC_CLASSIC_CREDENTIAL' }), { code: 'private-auth-classic' });
  assert.equal(h.connection.connected, false);
  assert.equal(h.routes.migrationSource.sessions.size, 0);
  assert.deepEqual(h.vaultWrites, []);
});

test('migration missing Contents Read and token revocation never fall back to anonymous or another account', async () => {
  for (const revoked of [false, true]) {
    const h = authenticatedHarness();
    if (!revoked) h.github.credentials.get(h.token).contentsRead = false;
    await h.connection.connect({ token: h.token });
    if (revoked) h.github.credentials.get(h.token).revoked = true;
    await assert.rejects(h.plan(), (error) =>
      ['private-access', 'private-auth-invalid'].includes(error.code) &&
      !error.message.includes('SYNTHETIC_UPSTREAM_PRIVATE_DETAIL'));
    assert(h.github.authCalls.every((entry) => entry.authenticated));
    assert.equal(h.api.trace.length, 0);
    assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
  }
});

test('migration expired source sessions invalidate cached private bytes before another read', async () => {
  const h = authenticatedHarness();
  await h.connection.connect({ token: h.token });
  const donor = h.selectDonor();
  await donor.read(PUBLIC_FILE);
  h.clock.now += 31 * 60 * 1000;
  await assert.rejects(donor.read(PUBLIC_FILE), { code: 'private-auth-expired' });
  assert.equal(h.connection.connected, false);
  assert.equal(h.routes.migrationSource.readers.size, 0);
  assert.equal(h.api.trace.length, 0);
});

test('migration private ref movement and saved-profile changes consume the plan without writing', async () => {
  for (const profileChanged of [false, true]) {
    const h = authenticatedHarness();
    await h.connection.connect(profileChanged ? { profileId: 'existing-connection' } : { token: h.token });
    const preview = await acceptCount(h);
    if (profileChanged) h.profileData.get('existing-connection').updatedAt = 'synthetic-changed';
    else h.github.seed('legacy-main', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA });
    await assert.rejects(h.session.export(preview.id, 'draft'), { code: profileChanged ? 'private-profile' : 'private-stale' });
    assert.equal(h.api.trace.length, 0);
    assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
  }
});

test('migration replacing a PAT invalidates old donors even when the replacement fails', async () => {
  const h = authenticatedHarness();
  await h.connection.connect({ token: h.token });
  const donor = h.selectDonor();
  await donor.read(PUBLIC_FILE);
  await assert.rejects(h.connection.connect({ token: 'invalid' }), { code: 'private-auth-invalid' });
  await assert.rejects(donor.read(PUBLIC_FILE), { code: 'private-stale' });
  assert.equal(h.connection.connected, false);
  assert.equal(h.routes.migrationSource.sessions.size, 0);
  assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
});

test('migration disconnect during a slow source login revokes the late session and retains no credential', { timeout: 3000 }, async (t) => {
  const h = authenticatedHarness();
  const gate = deferred();
  t.after(() => gate.resolve());
  const entered = deferred();
  h.hooks.connected = async () => { entered.resolve(); await gate.promise; };
  const pending = h.connection.connect({ token: h.token });
  const rejected = assert.rejects(pending, { code: 'private-stale' });
  await entered.promise;
  const closing = h.connection.disconnect();
  gate.resolve();
  await rejected;
  assert.deepEqual(await closing, { erased: true });
  assert.equal(h.connection.connected, false);
  assert.equal(h.routes.migrationSource.sessions.size, 0);
});

test('migration connection response loss is cleaned up using an attempt capability, not an unknown session ID', async () => {
  const h = authenticatedHarness();
  h.hooks.connected = async () => { throw new Error('Synthetic response lost after session creation'); };
  await assert.rejects(h.connection.connect({ token: h.token }), { code: 'private-read' });
  assert.equal(h.mintedIds.length, 1);
  assert.equal(h.routes.migrationSource.sessions.size, 0);
  assert.equal(h.routes.migrationSource.readers.size, 0);
  assert.deepEqual(await h.connection.disconnect(), { erased: true });
});

test('migration bounded attempt eviction erases a source credential even after its response and first cleanup were lost', async () => {
  const h = authenticatedHarness();
  h.hooks.failErase = true;
  h.hooks.connected = async () => { throw new Error('Synthetic lost session response'); };
  await assert.rejects(h.connection.connect({ token: h.token }), { code: 'private-disconnect' });
  assert.equal(h.routes.migrationSource.sessions.size, 1);
  h.hooks.failErase = false;
  for (let index = 0; index < 65; index += 1) {
    await h.request(`${MIGRATION_SOURCE_ENDPOINT}/session`, {
      method: 'DELETE', headers: { [MIGRATION_ATTEMPT_HEADER]: randomUUID() },
    });
  }
  assert.equal(h.routes.migrationSource.attempts.size, 64);
  assert.equal(h.routes.migrationSource.sessions.size, 0);
  assert.equal(h.routes.migrationSource.readers.size, 0);
  assert.deepEqual(await h.connection.disconnect(), { erased: true });
  assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
});

test('migration cancellation before GitHub identity returns prevents a source session from being minted', { timeout: 3000 }, async (t) => {
  const h = authenticatedHarness();
  const gate = deferred();
  t.after(() => gate.resolve());
  const entered = deferred();
  const erased = deferred();
  h.github.beforeIdentity = async () => { entered.resolve(); await gate.promise; };
  h.hooks.erased = () => erased.resolve();
  const pending = h.connection.connect({ token: h.token });
  const rejected = assert.rejects(pending, { code: 'private-stale' });
  await entered.promise;
  const closing = h.connection.disconnect();
  await erased.promise;
  assert.equal(h.routes.migrationSource.sessions.size, 0);
  gate.resolve();
  await rejected;
  assert.deepEqual(await closing, { erased: true });
  assert.equal(h.mintedIds.length, 0);
});

test('migration superseded logins cannot revoke the newer source credential', { timeout: 3000 }, async (t) => {
  const h = authenticatedHarness();
  const gate = deferred();
  t.after(() => gate.resolve());
  const entered = deferred();
  let identities = 0;
  h.github.beforeIdentity = async () => {
    if (++identities === 1) { entered.resolve(); await gate.promise; }
  };
  const first = h.connection.connect({ token: h.token });
  const rejected = assert.rejects(first, { code: 'private-stale' });
  await entered.promise;
  const second = await h.connection.connect({ token: h.github.credential({ id: 9001, login: 'new-source-reader' }) });
  gate.resolve();
  await rejected;
  assert.equal(second.account.id, 9001);
  assert.equal(h.connection.status().account.id, 9001);
  assert.equal(h.routes.migrationSource.sessions.size, 1);
  assert.equal((await h.connection.inspectRepository(PUBLIC_REPO)).visibility, 'private');
  assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
});

test('migration failed source erasure is retryable and cannot silently replace or resume the old credential', async () => {
  const h = authenticatedHarness();
  await h.connection.connect({ token: h.token });
  const donor = h.selectDonor();
  h.hooks.failErase = true;
  await assert.rejects(h.connection.disconnect(), { code: 'private-disconnect' });
  assert.equal(h.connection.connected, false);
  await assert.rejects(h.connection.connect({ token: h.token }), { code: 'private-disconnect' });
  await assert.rejects(donor.entries(), { code: 'private-stale' });
  assert.equal(h.mintedIds.length, 1);
  h.hooks.failErase = false;
  assert.deepEqual(await h.connection.disconnect(), { erased: true });
  assert.equal(h.routes.migrationSource.sessions.size, 0);
  assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
});

test('migration source session and snapshot capabilities cannot be borrowed from the destination or another source', async () => {
  const h = authenticatedHarness();
  await assert.rejects(h.request(`${MIGRATION_SOURCE_ENDPOINT}/repository?repository=${PUBLIC_REPO}`, {
    headers: { [MIGRATION_SOURCE_HEADER]: h.destination.id },
  }), { code: 'private-auth-expired' });
  await h.connection.connect({ token: h.token });
  await h.selectDonor().entries();
  const snapshotId = [...h.routes.migrationSource.readers.values()][0].reader.snapshots.keys().next().value;
  const second = new MigrationGitHubConnection({ request: h.request });
  await second.connect({ token: h.token });
  await assert.rejects(h.request(`${MIGRATION_SOURCE_ENDPOINT}/verify?selectionId=${snapshotId}`, {
    headers: { [MIGRATION_SOURCE_HEADER]: h.mintedIds[1] },
  }), { code: 'private-expired' });
  await assert.rejects(h.request(`${MIGRATION_SOURCE_ENDPOINT}/snapshot?token=forbidden`, {
    method: 'POST', headers: { [MIGRATION_SOURCE_HEADER]: h.mintedIds[0] },
  }), { code: 'private-read-only' });
  assert.equal(h.sessions.resolve(h.destination.id).token, h.destinationToken);
});

test('migration authenticated browser adapter has no destination-session or persistence side effects', async () => {
  const text = await readFile(new URL('../web/js/migration-github-connection.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|github-session-manager|reconnectConnection|resumeConnection|setConnectionPersistence/);
  const h = authenticatedHarness();
  await assert.rejects(h.connection.connect({ token: h.token, persist: true }), { code: 'private-input' });
  assert.equal(h.mintedIds.length, 0);
});

test('migration authenticated HTTP routes preserve owner, origin and source-session boundaries without persisting a PAT', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-auth-donor-http-'));
  const webRoot = join(root, 'web');
  const sharedRoot = join(root, 'shared');
  await mkdir(webRoot);
  await mkdir(sharedRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><html><body>Synthetic test</body></html>');
  const github = new AuthenticatedGitHubMock();
  const token = github.credential();
  const host = '127.0.0.1:4196';
  const owner = 'synthetic-owner-session';
  const created = await createCitadelServer({
    webRoot, sharedRoot, dataRoot: join(root, 'data'), allowedHost: host, allowedOrigin: `http://${host}`,
    sessionToken: owner, githubOptions: { clientOptions: { fetch: github.fetch } },
    credentialVault: { initialize: async () => {}, status: () => ({ available: false }) },
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    created.server.closeAllConnections();
    await new Promise((resolve) => created.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const port = created.server.address().port;
  const call = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const text = body ? JSON.stringify(body) : '';
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        Host: host, 'Sec-Fetch-Site': 'same-origin', Origin: `http://${host}`,
        ...(text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(text);
  });
  const path = `${MIGRATION_SOURCE_ENDPOINT}/session`;
  const ownerHeaders = { 'X-Citadel-Session': owner };
  assert.equal((await call(path, { method: 'POST', body: { token } })).status, 401);
  assert.equal((await call(path, { method: 'POST', body: { token }, headers: { ...ownerHeaders, Origin: 'http://wrong.invalid' } })).status, 403);
  assert.equal(github.authCalls.length, 0);
  const connected = await call(path, {
    method: 'POST', body: { token }, headers: { ...ownerHeaders, [MIGRATION_ATTEMPT_HEADER]: randomUUID() },
  });
  assert.equal(connected.status, 200);
  assert(!JSON.stringify(connected).includes(token));
  const headers = { ...ownerHeaders, [MIGRATION_SOURCE_HEADER]: connected.body.sessionId };
  const repository = await call(`${MIGRATION_SOURCE_ENDPOINT}/repository?repository=${PUBLIC_REPO}`, { headers });
  assert.equal(repository.status, 200);
  assert.equal(repository.body.visibility, 'private');
  assert.match(repository.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal((await call(`${MIGRATION_SOURCE_ENDPOINT}/blob`, { method: 'POST', headers, body: {} })).status, 405);
  assert.equal((await call(path, { method: 'DELETE', headers })).body.erased, true);
  assert.equal((await call(`${MIGRATION_SOURCE_ENDPOINT}/repository?repository=${PUBLIC_REPO}`, { headers })).status, 401);
  assert(github.authCalls.every((entry) => entry.method === 'GET'));
});
