import assert from 'node:assert/strict';
import test from 'node:test';
import { githubError } from '../server/github/api.mjs';
import { repositoryHttpFixture } from './_repository-http-fixture.mjs';

test('owner HTTP: a read-only organization token discovers repository owners even when memberships are empty', async (t) => {
  const fixture = await repositoryHttpFixture();
  t.after(() => fixture.close());
  const organization = fixture.github.organization('readonly-organization');
  fixture.github.memberships.clear();
  fixture.github.repository('readonly-organization/visible', {
    owner: { id: organization.id, type: organization.type, login: organization.login },
    permissions: { pull: true, push: false, admin: false },
  });
  fixture.github.before = (call) => {
    if (call.method !== 'GET') throw githubError(403, 'GITHUB_REQUEST_FAILED', 'Read-only fixture');
  };
  const token = `github_pat_${'r'.repeat(82)}`;
  const connected = await fixture.call('/api/github/connections', {
    method: 'POST', body: { name: 'Read-only organization connection', token },
  });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  const githubSession = connected.body.session.id;
  const visible = await fixture.call('/api/github/repository-owners', { githubSession });
  assert.equal(visible.status, 200, JSON.stringify(visible.body));
  assert.deepEqual(visible.body.defaultOwner, { id: organization.id, type: organization.type, login: organization.login });
  assert.equal(visible.body.owners[0].access, 'not-verified');
  assert.equal(visible.body.owners[0].membership, undefined);
  assert.equal(JSON.stringify(visible.body).includes(token), false);
  const checked = await fixture.call('/api/github/repository-owners', {
    method: 'POST', githubSession, body: { owner: visible.body.defaultOwner },
  });
  assert.equal(checked.status, 404, 'discovery must not invent active membership');
  const explicit = await fixture.call('/api/github/repository-owners', {
    method: 'POST', githubSession, body: { organization: organization.login },
  });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.body.id, organization.id);
  assert.equal(explicit.body.access, 'not-verified');
  assert.ok(fixture.github.calls.every((call) => call.method === 'GET'));
  assert.deepEqual(fixture.unexpected, []);
});
