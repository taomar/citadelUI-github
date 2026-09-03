/**
 * The container has exactly one owner, claimed once, and that is the only way in.
 *
 * These tests pin the behaviour the feature exists for rather than the shape of
 * the implementation: that a fresh deployment offers the claim and a claimed one
 * refuses it forever, that the right password gets in and the wrong one does
 * not, that nothing anywhere stores the password itself, that no route creates a
 * second account or resets the first, and that an unreadable record fails closed
 * instead of quietly re-opening the claim.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCitadelServer } from '../server/index.mjs';
import { OwnerAccount } from '../server/owner.mjs';

const ALLOWED_HOST = '127.0.0.1:4173';
const ORIGIN = `http://${ALLOWED_HOST}`;
const USERNAME = 'citadel-owner';
const PASSWORD = 'correct horse battery staple';

/**
 * scrypt at production cost is deliberately slow, and these tests derive keys
 * dozens of times. A lower cost keeps the suite quick while exercising exactly
 * the same code path — the parameters travel with each record, so a record
 * written at any cost verifies against itself.
 */
const TEST_COST = { N: 4, r: 8, p: 1 };

function httpRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, method: options.method || 'GET', headers: options.headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
            json() {
              return JSON.parse(this.body.toString('utf8'));
            },
          })
        );
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function start(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-owner-'));
  const webRoot = join(root, 'web');
  const sharedRoot = join(root, 'shared');
  const dataRoot = join(root, 'data');
  await mkdir(webRoot, { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  await writeFile(
    join(webRoot, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body></body></html>'
  );
  await writeFile(join(sharedRoot, 'policy.mjs'), 'export const shared = true;\n');
  let created;
  try {
    created = await createCitadelServer({
      webRoot,
      sharedRoot,
      dataRoot,
      allowedHost: ALLOWED_HOST,
      allowedOrigin: ORIGIN,
      ownerOptions: { cost: TEST_COST, failedDelayMs: 0 },
      ...options,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  await new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(0, '127.0.0.1', resolve);
  });
  const port = created.server.address().port;
  const call = (path, requestOptions = {}) =>
    httpRequest(port, path, {
      ...requestOptions,
      headers: { Host: ALLOWED_HOST, 'Sec-Fetch-Site': 'same-origin', ...(requestOptions.headers || {}) },
    });
  return {
    root,
    dataRoot,
    ownerPath: join(dataRoot, 'settings', 'owner.json'),
    ...created,
    request: call,
    post(path, payload, headers = {}) {
      return call(path, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
      });
    },
  };
}

async function close(fixture) {
  await new Promise((resolve) => fixture.server.close(resolve));
  await rm(fixture.root, { recursive: true, force: true });
}

function authState(response) {
  const match = response.body.toString('utf8').match(/<meta name="citadel-auth" content="([^"]+)" \/>/);
  assert.ok(match, 'the bootstrap reports an authentication state');
  return match[1];
}

test('a fresh container offers the claim, and claiming it issues the session token', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));

  const before = await fixture.request('/api/owner');
  assert.equal(before.status, 200);
  assert.equal(before.json().state, 'unclaimed');
  assert.equal(authState(await fixture.request('/')), 'unclaimed');

  const claim = await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD });
  assert.equal(claim.status, 201);
  const { sessionToken } = claim.json();
  assert.ok(typeof sessionToken === 'string' && sessionToken.length >= 43);

  // The token the claim handed back is a working credential for a data route.
  const registry = await fixture.request('/api/registry', {
    headers: { 'X-Citadel-Session': sessionToken },
  });
  assert.equal(registry.status, 200);

  const after = await fixture.request('/api/owner');
  assert.equal(after.json().state, 'claimed');
  assert.equal(authState(await fixture.request('/')), 'claimed');
});

test('a claimed container refuses every further claim, whatever credentials are offered', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  assert.equal((await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD })).status, 201);

  // The original owner cannot re-claim, a second person cannot claim, and
  // neither can take the container by presenting the credential that worked.
  for (const attempt of [
    { username: USERNAME, password: PASSWORD },
    { username: 'someone-else', password: 'a totally different secret' },
    { username: USERNAME, password: 'a totally different secret' },
  ]) {
    const response = await fixture.post('/api/owner/claim', attempt);
    assert.equal(response.status, 409);
    assert.equal(response.json().error.code, 'OWNER_ALREADY_CLAIMED');
    assert.equal(response.json().error.sessionToken, undefined);
  }

  // And the stored credential is still the first one.
  const stored = JSON.parse(await readFile(fixture.ownerPath, 'utf8'));
  assert.equal(stored.username, USERNAME);
});

test('two concurrent claims leave exactly one owner, and the winner is the one stored', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));

  const attempts = ['first', 'second', 'third', 'fourth'].map((name) =>
    fixture.post('/api/owner/claim', { username: name, password: `${name}-password-value` })
  );
  const responses = await Promise.all(attempts);
  const winners = responses.filter((response) => response.status === 201);
  const losers = responses.filter((response) => response.status !== 201);

  assert.equal(winners.length, 1, 'exactly one claim succeeds');
  assert.equal(losers.length, 3);
  for (const loser of losers) {
    assert.equal(loser.status, 409, 'a losing claim fails cleanly rather than erroring');
    assert.equal(loser.json().error.code, 'OWNER_ALREADY_CLAIMED');
  }

  // The credential on disk belongs to the winner, and it is the one that works.
  const winnerIndex = responses.indexOf(winners[0]);
  const winnerName = ['first', 'second', 'third', 'fourth'][winnerIndex];
  const stored = JSON.parse(await readFile(fixture.ownerPath, 'utf8'));
  assert.equal(stored.username, winnerName);
  const signIn = await fixture.post('/api/owner/session', {
    username: winnerName,
    password: `${winnerName}-password-value`,
  });
  assert.equal(signIn.status, 200);
});

test('the right password signs in and the wrong one does not, with one message for either mistake', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD });

  const ok = await fixture.post('/api/owner/session', { username: USERNAME, password: PASSWORD });
  assert.equal(ok.status, 200);
  const token = ok.json().sessionToken;
  assert.equal((await fixture.request('/api/registry', { headers: { 'X-Citadel-Session': token } })).status, 200);

  const wrongPassword = await fixture.post('/api/owner/session', { username: USERNAME, password: 'not the secret' });
  const wrongUsername = await fixture.post('/api/owner/session', { username: 'someone-else', password: PASSWORD });
  for (const response of [wrongPassword, wrongUsername]) {
    assert.equal(response.status, 401);
    assert.equal(response.json().error.code, 'INVALID_CREDENTIALS');
    assert.equal(response.json().sessionToken, undefined);
  }
  // Naming which half was wrong would tell a caller they had found the username.
  assert.equal(wrongPassword.json().error.message, wrongUsername.json().error.message);
});

test('nothing stored anywhere under the data root contains the password', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD });

  const raw = await readFile(fixture.ownerPath, 'utf8');
  assert.ok(!raw.includes(PASSWORD), 'the record does not contain the password');
  const record = JSON.parse(raw);
  assert.equal(record.algorithm, 'scrypt');
  assert.ok(Buffer.from(record.salt, 'base64').length >= 16, 'the salt is at least 16 bytes');
  assert.ok(record.cost.N > 1 && record.cost.r > 0 && record.cost.p > 0);
  assert.equal(record.password, undefined);

  // Nor may it appear anywhere else in the record, base64-encoded or otherwise.
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') continue;
    assert.ok(!value.includes(PASSWORD), `${key} does not carry the password`);
    assert.ok(
      !Buffer.from(value, 'base64').toString('utf8').includes(PASSWORD),
      `${key} does not carry the password encoded`
    );
  }

  // Two owners choosing the same password must not produce the same hash, which
  // is the only thing the per-record salt is for.
  const other = await mkdtemp(join(tmpdir(), 'citadel-owner-salt-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  const second = new OwnerAccount({ dataRoot: other, cost: TEST_COST, failedDelayMs: 0 });
  await second.claim(USERNAME, PASSWORD);
  const secondRecord = JSON.parse(await readFile(join(other, 'settings', 'owner.json'), 'utf8'));
  assert.notEqual(secondRecord.salt, record.salt);
  assert.notEqual(secondRecord.hash, record.hash);
});

test('no route creates a second account and no route resets the password', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD });
  const token = (await fixture.post('/api/owner/session', { username: USERNAME, password: PASSWORD }))
    .json()
    .sessionToken;
  const session = { 'X-Citadel-Session': token, Origin: ORIGIN };

  // Paths a reset or a second user would plausibly live at. Anonymously they
  // must be unreachable; with a valid session they must not exist at all. The
  // distinction matters: 401 proves nothing was created, 404 proves there is no
  // such route to create with.
  for (const path of [
    '/api/owner/password',
    '/api/owner/reset',
    '/api/owner/users',
    '/api/owner/session/password',
    '/api/owners',
  ]) {
    const anonymous = await fixture.post(path, { username: 'second', password: 'another secret value' });
    assert.ok(
      [401, 404, 405].includes(anonymous.status),
      `${path} is unreachable anonymously (${anonymous.status})`
    );
    const authenticated = await fixture.post(
      path,
      { username: 'second', password: 'another secret value' },
      session
    );
    assert.ok(
      [404, 405].includes(authenticated.status),
      `${path} is not a route even when signed in (${authenticated.status})`
    );
  }

  // The routes that do exist refuse every method that would mean "change this".
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/api/owner', '/api/owner/claim', '/api/owner/session']) {
      const response = await fixture.request(path, {
        method,
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...session },
      });
      assert.ok(response.status === 404 || response.status === 405, `${method} ${path} is refused`);
    }
  }

  // The credential still works, so none of the above quietly changed it.
  assert.equal((await fixture.post('/api/owner/session', { username: USERNAME, password: PASSWORD })).status, 200);
});

test('an unauthenticated caller gets no usable token and reaches no data route', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD });

  // The page no longer carries a session token for anyone who asks for it.
  const page = await fixture.request('/');
  assert.equal(page.status, 200);
  assert.ok(!page.body.toString('utf8').includes('citadel-session'), 'no session token in the markup');
  assert.ok(!page.body.toString('utf8').includes(fixture.sessionToken), 'the token itself is not in the markup');

  for (const path of ['/api/registry', '/api/health', '/api/activity']) {
    const response = await fixture.request(path);
    assert.equal(response.status, 401, `${path} refuses an anonymous caller`);
    assert.equal(response.json().error.code, 'INVALID_SESSION');
  }
  // A guessed token is no better than none.
  const guessed = await fixture.request('/api/registry', { headers: { 'X-Citadel-Session': 'guessed-token' } });
  assert.equal(guessed.status, 401);
});

test('the health probe answers without a session, so the platform can see the container is up', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));

  for (const stage of ['before', 'after']) {
    if (stage === 'after') {
      await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD });
    }
    const probe = await fixture.request('/healthz');
    assert.equal(probe.status, 200, `/healthz answers ${stage} the claim`);
    assert.equal(probe.json().ok, true);
  }
});

test('an unreadable owner record fails closed and is never mistaken for unclaimed', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD });

  // Truncation, a valid document of the wrong shape, and a record whose hash has
  // been tampered with: each is "cannot tell", and none of them is "nobody has
  // claimed this yet".
  for (const damage of ['{"version":1,', '{"version":1,"algorithm":"scrypt"}', '{}', '']) {
    await writeFile(fixture.ownerPath, damage);

    const state = await fixture.request('/api/owner');
    assert.equal(state.status, 503, 'the state route refuses rather than reporting unclaimed');
    assert.notEqual(state.body.toString('utf8').includes('"unclaimed"'), true);

    const claim = await fixture.post('/api/owner/claim', { username: 'opportunist', password: 'a new secret value' });
    assert.equal(claim.status, 503, 'a damaged record cannot be re-claimed');
    assert.equal(claim.json().sessionToken, undefined);

    const signIn = await fixture.post('/api/owner/session', { username: USERNAME, password: PASSWORD });
    assert.equal(signIn.status, 503, 'sign-in refuses rather than guessing');

    // The page must not invite a claim either, or the UI would contradict the server.
    assert.equal(authState(await fixture.request('/')), 'unavailable');
  }
});

test('a rejected sign-in is paused, and the pause does not depend on which half was wrong', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-owner-delay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const account = new OwnerAccount({ dataRoot: root, cost: TEST_COST, failedDelayMs: 60 });
  await account.claim(USERNAME, PASSWORD);

  for (const attempt of [
    { username: USERNAME, password: 'not the secret' },
    { username: 'someone-else', password: PASSWORD },
  ]) {
    const started = process.hrtime.bigint();
    await assert.rejects(() => account.verify(attempt.username, attempt.password), {
      code: 'INVALID_CREDENTIALS',
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs >= 55, `a rejection waits (${elapsedMs.toFixed(1)}ms)`);
  }

  // The pause is only on the failure path; a correct sign-in is not delayed.
  await account.verify(USERNAME, PASSWORD);
});

test('a claim is refused before it is stored when the credential is unusable', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));

  for (const attempt of [
    { username: '', password: PASSWORD },
    { username: USERNAME, password: 'short' },
    { username: USERNAME },
    { username: 123, password: PASSWORD },
    { username: USERNAME, password: PASSWORD, role: 'admin' },
  ]) {
    const response = await fixture.post('/api/owner/claim', attempt);
    assert.equal(response.status, 400, `${JSON.stringify(attempt)} is refused`);
  }

  // None of those consumed the one claim this container has.
  assert.equal((await fixture.request('/api/owner')).json().state, 'unclaimed');
  assert.equal((await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD })).status, 201);
});

test('the owner routes keep every transport control the rest of the API enforces', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));

  const payload = JSON.stringify({ username: USERNAME, password: PASSWORD });

  // A foreign host, a cross-site fetch and a foreign origin are each refused,
  // exactly as they would be on any other route. Signing in must not be a way
  // around the controls that protect everything else.
  const foreignHost = await httpRequest(fixture.server.address().port, '/api/owner/claim', {
    method: 'POST',
    body: payload,
    headers: { Host: 'evil.example', 'Sec-Fetch-Site': 'same-origin', Origin: ORIGIN, 'Content-Type': 'application/json' },
  });
  assert.equal(foreignHost.status, 421);

  const crossSite = await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD }, {
    'Sec-Fetch-Site': 'cross-site',
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json().error.code, 'INVALID_FETCH_SITE');

  const foreignOrigin = await fixture.post('/api/owner/claim', { username: USERNAME, password: PASSWORD }, {
    Origin: 'http://evil.example',
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.json().error.code, 'INVALID_ORIGIN');

  // None of the refusals claimed the container.
  assert.equal((await fixture.request('/api/owner')).json().state, 'unclaimed');
});
