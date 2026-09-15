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
