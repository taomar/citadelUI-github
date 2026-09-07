import assert from 'node:assert/strict';
import test from 'node:test';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { repositoryHttpFixture } from './_repository-http-fixture.mjs';
import { TEST_TOKEN } from './_github-mock.mjs';

test('repository creation integration: real service and protected HTTP populate exact bytes and rejoin normal attachment', async (t) => {
  const fixture = await repositoryHttpFixture({
    files: citadelRepositoryFiles({
      LICENSE: 'MIT fixture license; preserve exact bytes.\r\n',
      'assets/binary.pbix': Buffer.alloc(2_022_353, 0xfe),
      'assets/bom.txt': '\ufeff"quoted"\r\nsecond line\r\n',
      '.github/ISSUE_TEMPLATE.md': 'Keep this checked-in dotfile.\n',
    }),
  });
  t.after(() => fixture.close());
  const connection = await fixture.call('/api/github/connections', {
    method: 'POST', body: { name: 'Private creation fixture', token: TEST_TOKEN, persist: false },
  });
  assert.equal(connection.status, 200, JSON.stringify(connection.body));
  const githubSession = connection.body.session.id;
  const request = (path, init = {}) => fixture.call(path, { ...init, githubSession });
  const base = '/api/github/repository-creations';
  assert.equal((await fixture.call(base)).status, 401);
  const prepared = await request(base, {
    method: 'POST',
    body: { name: 'http-private-copy', sourceUrl: 'https://github.com/fixture-upstream/source/tree/citadel-v1', operationKey: 'http-integration-operation' },
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const id = prepared.body.id;
  await fixture.creations.settled();
  const ready = await request(`${base}/${id}`);
  assert.equal(ready.body.state, 'ready', JSON.stringify({ operation: ready.body, unexpected: fixture.unexpected }));
  assert.equal(ready.body.source.commit, fixture.github.sourceHead);
  assert.equal(ready.body.source.tree, fixture.github.source.commits.get(fixture.github.sourceHead).tree.sha);
  assert.equal(fixture.github.calls.some((call) => call.method !== 'GET'), false);
  const start = await request(`${base}/${id}/start`, { method: 'POST', body: {} });
  assert.equal(start.status, 200);
  await fixture.creations.settled();
  const result = await request(`${base}/${id}`);
  assert.equal(result.body.state, 'complete', JSON.stringify({ operation: result.body, unexpected: fixture.unexpected }));
  assert.equal(result.body.destination.private, true);
  assert.equal(result.body.destination.branch, 'main');
  const destination = fixture.github.repos.get('fixture-owner/http-private-copy');
  assert.equal(destination.private, true);
  assert.equal(destination.default_branch, 'main');
  assert.deepEqual(fixture.github.snapshot(destination), fixture.github.snapshot(fixture.github.source, 'citadel-v1'));
  assert.equal(JSON.stringify(result.body).includes(TEST_TOKEN), false);
  assert.deepEqual(fixture.unexpected, []);
  const listed = await request('/api/github/repos');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.repositories.some((repo) => repo.id === destination.id));
  const canonical = await request(`/api/github/repos/${destination.id}`);
  assert.equal(canonical.body.canPush, true);
  const branches = await request(`/api/github/repos/${destination.id}/branches`);
  assert.equal(branches.status, 200);
  assert.deepEqual(branches.body.branches.map((branch) => branch.name), ['main']);
  const compatibility = await request(`/api/github/repos/${destination.id}/compatibility?branch=main`);
  assert.equal(compatibility.status, 200);
  assert.equal(compatibility.body.supported, true);
  const attached = await request('/api/github/attachments', {
    method: 'POST',
    body: {
      repositoryId: destination.id, sourceBranch: 'main', environmentId: 'http-created-environment',
      writeMode: 'direct', expectedHead: compatibility.body.head, operationKey: 'http-created-attachment',
    },
  });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  assert.equal(attached.body.source.connectionProfileId, connection.body.profile.id);
  assert.equal(attached.body.source.kind, 'github');
  assert.equal(attached.body.source.sourceBranch, 'main');
  assert.equal(attached.body.source.workingBranch, 'main');
  assert.equal(fixture.github.calls.filter((call) => call.method === 'POST' && call.path === '/user/repos').length, 1);
});
