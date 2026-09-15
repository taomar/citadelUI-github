import assert from 'node:assert/strict';
import test from 'node:test';
import { isGitHubLogin } from '../shared/github-login.mjs';
import { parseRepositorySource } from '../shared/repository-source.mjs';
import { publicRepositoryName } from '../shared/migration-public-github.mjs';
import { repositoryHttpFixture } from './_repository-http-fixture.mjs';
import { TEST_TOKEN } from './_github-mock.mjs';

test('GitHub login grammar accepts ordinary and managed accounts within the same bounds', () => {
  for (const login of ['octo-dev', 'mona-cat_acme', 'acme_admin', `${'a'.repeat(30)}_abcdefgh`]) {
    assert.equal(isGitHubLogin(login), true, login);
    assert.equal(parseRepositorySource(`https://github.com/${login}/config/tree/main`).fullName, `${login}/config`);
    assert.equal(publicRepositoryName(`${login}/config`), `${login}/config`);
  }
  for (const login of ['', null, 7, '-start', '_acme', 'name_', 'two__suffix', 'name@acme',
    '../name', 'name/acme', 'name\\acme', 'name.acme', 'name\nacme', `${'a'.repeat(31)}_abcdefgh`]) {
    assert.equal(isGitHubLogin(login), false, String(login));
  }
});

for (const persist of [false, true]) {
  test(`managed GitHub login survives real connection HTTP and reconnect, persist=${persist}`, async (t) => {
    const f = await repositoryHttpFixture();
    t.after(() => f.close());
    f.github.identity.login = 'mona-cat_acme';
    const result = await f.call('/api/github/connections', {
      method: 'POST', body: { name: 'Managed work account', token: TEST_TOKEN, persist },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.profile.accountLogin, 'mona-cat_acme');
    assert.equal(result.body.profile.accountId, f.github.identity.id);
    assert.equal(JSON.stringify(result.body).includes(TEST_TOKEN), false);

    const profileId = result.body.profile.id;
    const metadata = (await f.call('/api/registry')).body;
    const registered = await f.call('/api/registry', {
      method: 'PUT', body: {
        expectedEpoch: metadata.epoch, expectedRevision: metadata.revision,
        projects: [{ id: 'managed-project', label: 'Managed project' }],
        environments: [{
          id: 'managed-workspace', projectId: 'managed-project', label: 'Main',
          compatibility: 'unscanned',
          source: {
            kind: 'github', connectionProfileId: profileId, repositoryId: 9001,
            fullName: 'mona-cat_acme/config', sourceBranch: 'main', workingBranch: 'main', writeMode: 'direct',
          },
        }],
      },
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    assert.equal(registered.body.environments[0].source.fullName, 'mona-cat_acme/config');

    await f.call(`/api/github/connections/${profileId}/disconnect`, { method: 'POST' });
    const reconnected = await f.call(`/api/github/connections/${profileId}/reconnect`, {
      method: 'POST', body: { token: TEST_TOKEN },
    });
    assert.equal(reconnected.status, 200, JSON.stringify(reconnected.body));
    assert.equal(reconnected.body.profile.accountLogin, 'mona-cat_acme');

    f.github.identity.id += 1;
    const wrong = await f.call(`/api/github/connections/${profileId}/reconnect`, {
      method: 'POST', body: { token: TEST_TOKEN },
    });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error.code, 'CONNECTION_ACCOUNT_MISMATCH');
    assert.deepEqual(f.unexpected, []);
  });
}

test('organization destination discovery and access checks use protected real HTTP routes', async (t) => {
  const f = await repositoryHttpFixture();
  t.after(() => f.close());
  const organization = f.github.organization('client-org');
  const connected = await f.call('/api/github/connections', {
    method: 'POST', body: { name: 'Organization admin', token: TEST_TOKEN },
  });
  assert.equal(connected.status, 200);
  const githubSession = connected.body.session.id;
  assert.equal((await f.call('/api/github/repository-owners')).status, 401);
  const discovered = await f.call('/api/github/repository-owners', { githubSession });
  assert.equal(discovered.status, 200, JSON.stringify(discovered.body));
  assert.deepEqual(discovered.body.defaultOwner, { id: organization.id, login: organization.login, type: 'Organization' });
  const access = await f.call('/api/github/repository-owners', {
    method: 'POST', githubSession, body: { owner: discovered.body.defaultOwner },
  });
  assert.equal(access.status, 200, JSON.stringify(access.body));
  assert.equal(access.body.access, 'not-verified', 'A metadata read is not proof that repository creation will be permitted.');
  const request = await f.call('/api/github/repository-creations', {
    method: 'POST', githubSession,
    body: { name: 'org-copy', sourceUrl: 'https://github.com/fixture-upstream/source/tree/citadel-v1',
      owner: discovered.body.defaultOwner, operationKey: 'org-http-creation-once' },
  });
  assert.equal(request.status, 200, JSON.stringify(request.body));
  await f.creations.settled();
  const ready = await f.call(`/api/github/repository-creations/${request.body.id}`, { githubSession });
  assert.equal(ready.body.state, 'ready', JSON.stringify(ready.body.error));
  assert.equal(ready.body.destination.fullName, 'client-org/org-copy');
  assert.equal(f.github.calls.some((call) => call.method === 'POST'), false);
  assert.deepEqual(f.unexpected, []);
});
