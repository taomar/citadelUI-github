/**
 * The governance log, judged on what it refuses to hold.
 *
 * The store's defence is its schema: a closed action vocabulary, a closed reason
 * vocabulary, and no free-text field anywhere. These tests push everything a
 * careless caller might realistically pass — an exception message, a path, a
 * token, a parameter value — and require it to be dropped rather than filtered.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ActivityStore, ACTIVITY_ACTIONS, ACTIVITY_REASONS } from '../server/activity.mjs';
import { createCitadelServer } from '../server/index.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MockGitHub, TEST_TOKEN } from './_github-mock.mjs';

async function store(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-activity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, activity: new ActivityStore({ dataRoot: root, ...options }) };
}

test('an unknown action, outcome, origin or reason is refused rather than stored', async (t) => {
  const { activity } = await store(t);
  assert.equal(await activity.record({ action: 'nope' }), null);
  assert.equal(await activity.record({ action: 'environment.open', outcome: 'weird' }), null);
  assert.equal(await activity.record({ action: 'environment.open', origin: 'attacker' }), null);
  assert.equal(await activity.record(null), null);
  assert.equal(await activity.record('a string'), null);

  // An unrecognised reason is dropped, and the event is still recorded: the
  // event happened, and the reason field is the only part in doubt.
  const event = await activity.record({
    action: 'validation.failure',
    outcome: 'failed',
    reason: 'ENOENT: /data/settings/registry.json contains github_pat_secret',
    target: 'QA',
  });
  assert.equal(event.reason, null);
  assert.equal(event.action, 'validation.failure');
});

test('the recorded shape is closed and carries nothing a caller smuggled in', async (t) => {
  const { root, activity } = await store(t);
  await activity.record({
    action: 'repository.attach',
    outcome: 'ok',
    reason: 'permission-denied',
    target: 'taomar/citadelQA @ main',
    account: 'octo-dev',
    // Everything below is not part of the schema and must not survive.
    token: TEST_TOKEN,
    sessionId: 'opaque-session-id',
    localPath: 'C:\\source\\citadel',
    parameterValue: 'sk-live-1234',
    message: 'ENOENT while reading .azure/.env',
  });
  const [event] = await activity.list();
  assert.deepEqual(Object.keys(event).sort(), [
    'account',
    'action',
    'at',
    'id',
    'origin',
    'outcome',
    'reason',
    'target',
  ]);
  assert.match(event.id, /^[0-9a-f-]{36}$/);
  const raw = await readFile(join(root, 'settings', 'activity.json'), 'utf8');
  for (const forbidden of [TEST_TOKEN, 'github_pat_', 'opaque-session-id', 'C:\\\\source', 'sk-live', 'ENOENT']) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
});

test('a name is stripped of control characters and bounded', async (t) => {
  const { activity } = await store(t);
  await activity.record({
    action: 'environment.open',
    target: `QA\n\u0000injected: line\r${'x'.repeat(400)}`,
    account: 'octo\u0007dev',
  });
  const [event] = await activity.list();
  assert.equal(/[\u0000-\u001f\u007f]/.test(event.target), false);
  assert.ok(event.target.length <= 160);
  assert.ok(event.target.endsWith('\u2026'));
  assert.equal(event.account, 'octo dev');
});

test('the log is bounded and newest-first', async (t) => {
  const { activity } = await store(t, { maxEvents: 5 });
  for (let index = 0; index < 12; index += 1) {
    await activity.record({ action: 'environment.open', target: `Workspace ${index}` });
  }
  const events = await activity.list(50);
  assert.equal(events.length, 5);
  assert.deepEqual(
    events.map((event) => event.target),
    ['Workspace 11', 'Workspace 10', 'Workspace 9', 'Workspace 8', 'Workspace 7']
  );
  assert.equal((await activity.list(2)).length, 2);
});

test('a failing write never propagates into the operation it describes', async (t) => {
  const { activity } = await store(t);
  // A directory where the file should be: every write fails from here on.
  await mkdir(join(activity.path), { recursive: true });
  assert.equal(await activity.record({ action: 'environment.open', target: 'QA' }), null);
});

test('the vocabularies stay in step with what the product records', () => {
  for (const action of Object.keys(ACTIVITY_ACTIONS)) {
    assert.match(action, /^[a-z]+\.[a-z-]+$/);
    assert.equal(typeof ACTIVITY_ACTIONS[action], 'string');
  }
  assert.ok(ACTIVITY_REASONS.has('account-mismatch'));
  assert.ok(ACTIVITY_REASONS.has('persistence-unavailable'));
});

// ------------------------------------------------------------------ routes --

function httpRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? Buffer.from(options.body) : null;
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: { ...options.headers, ...(body ? { 'Content-Length': String(body.length) } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            text: () => Buffer.concat(chunks).toString('utf8'),
            json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
          })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function server(t) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-activity-http-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await mkdir(join(root, 'shared'), { recursive: true });
  await writeFile(
    join(root, 'web', 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body></body></html>'
  );
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9001, fullName: 'taomar/citadelQA' });
  github.seed(repository, 'main', citadelRepositoryFiles());
  const allowedHost = '127.0.0.1:4173';
  const created = await createCitadelServer({
    webRoot: join(root, 'web'),
    sharedRoot: join(root, 'shared'),
    dataRoot: join(root, 'data'),
    allowedHost,
    allowedOrigin: `http://${allowedHost}`,
    sessionToken: 'test-session-token',
    githubOptions: { clientOptions: { fetch: github.fetch } },
  });
  await new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(0, '127.0.0.1', resolve);
  });
  // One hook, in one order: stop serving, drain the fire-and-forget activity
  // queue, then remove the directory. Reversing the last two leaves a temporary
  // behind and fails the teardown rather than the test.
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await created.activityStore.settled();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const port = created.server.address().port;
  const call = (path, init = {}) =>
    httpRequest(port, path, {
      ...init,
      headers: {
        Host: allowedHost,
        'Sec-Fetch-Site': 'same-origin',
        'X-Citadel-Session': 'test-session-token',
        ...(init.method && init.method !== 'GET'
          ? { Origin: `http://${allowedHost}`, 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers || {}),
      },
    });
  return { call, github, ...created };
}

test('connection lifecycle is recorded server-side with no credential in it', async (t) => {
  const fixture = await server(t);
  const post = (path, body) =>
    fixture.call(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

  const { profile } = (
    await post('/api/github/connections', { name: 'Work account', token: TEST_TOKEN })
  ).json();
  await post(`/api/github/connections/${profile.id}/rename`, { name: 'Home laptop' });
  await post(`/api/github/connections/${profile.id}/disconnect`);

  const response = await fixture.call('/api/activity');
  assert.equal(response.status, 200);
  const events = response.json().events;
  assert.deepEqual(
    events.map((event) => event.action),
    ['connection.disconnect', 'connection.rename', 'connection.create']
  );
  assert.deepEqual(new Set(events.map((event) => event.origin)), new Set(['server']));
  assert.equal(events.at(-1).target, 'Work account');
  assert.equal(events.at(-1).account, 'octo-dev');
  assert.equal(response.text().includes('github_pat_'), false);
});

test('the browser may only append the actions it alone observes', async (t) => {
  const fixture = await server(t);
  const post = (body) =>
    fixture.call('/api/activity', { method: 'POST', body: JSON.stringify(body) });

  const allowed = await post({ action: 'environment.open', target: 'QA' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json().recorded, true);
  assert.equal(allowed.json().event.origin, 'client');

  // A browser cannot claim a credential event happened.
  for (const action of [
    'connection.create',
    'connection.reconnect',
    'connection.restore',
    'connection.persistence-enabled',
    'connection.remove',
    'repository.attach',
  ]) {
    const refused = await post({ action, target: 'forged' });
    assert.equal(refused.status, 400, action);
    assert.equal(refused.json().error.code, 'INVALID_ACTIVITY_ACTION');
  }

  // And it cannot widen the schema.
  const extra = await post({ action: 'environment.open', target: 'QA', token: TEST_TOKEN });
  assert.equal(extra.status, 400);
  assert.equal(extra.json().error.code, 'INVALID_CONTENT');
});

test('a repository validation failure is recorded as a failure, not silently', async (t) => {
  const fixture = await server(t);
  const ordinary = fixture.github.addRepository({ id: 9002, fullName: 'taomar/not-citadel' });
  fixture.github.seed(ordinary, 'main', { 'README.md': '# ordinary\n' });
  const { session } = (
    await fixture.call('/api/github/connections', {
      method: 'POST',
      body: JSON.stringify({ name: 'Work', token: TEST_TOKEN }),
    })
  ).json();

  await fixture.call('/api/github/repos/9002/compatibility?branch=main', {
    headers: { 'X-Citadel-GitHub-Session': session.id },
  });
  const events = (await fixture.call('/api/activity')).json().events;
  const failure = events.find((event) => event.action === 'validation.failure');
  assert.ok(failure, 'a failed validation was not recorded');
  assert.equal(failure.outcome, 'failed');
  assert.equal(failure.reason, 'not-a-citadel-repository');
  assert.equal(failure.target, 'taomar/not-citadel @ main');
});
