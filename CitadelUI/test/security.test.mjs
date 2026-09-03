import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCitadelServer } from '../server/index.mjs';

async function start(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-security-'));
  const webRoot = join(root, 'web');
  const sharedRoot = join(root, 'shared');
  const dataRoot = join(root, 'data');
  await mkdir(webRoot, { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  await writeFile(
    join(webRoot, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body><script type="module" src="/app.mjs"></script></body></html>'
  );
  await writeFile(join(webRoot, 'app.mjs'), 'export const ready = true;\n');
  await writeFile(join(sharedRoot, 'policy.mjs'), 'export const shared = true;\n');
  await writeFile(join(sharedRoot, 'citadel-core.mjs'), 'export const core = true;\n');
  const allowedHost = '127.0.0.1:4173';
  let created;
  try {
    created = await createCitadelServer({
      webRoot,
      sharedRoot,
      dataRoot,
      allowedHost,
      allowedOrigin: `http://${allowedHost}`,
      ownerOptions: { cost: { N: 4, r: 8, p: 1 }, failedDelayMs: 0 },
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
      host: allowedHost,
      ...requestOptions,
      headers: { Host: allowedHost, ...(requestOptions.headers || {}) },
    });
  return {
    root,
    ...created,
    request: call,
    /**
     * Become the owner and return the session token.
     *
     * The bootstrap no longer carries a token, so a test that needs one has to
     * claim the container the way a browser does. This is the only way to obtain
     * a working credential, which is the property the owner feature adds.
     *
     * The credentials are short on purpose: one fixture here runs with a 64-byte
     * JSON body limit to prove that limit is enforced, and a longer name would
     * make the fixture trip the very control it is meant to be testing.
     */
    async signIn(username = 'owner', password = 'owner-password') {
      const claim = await call('/api/owner/claim', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
          Origin: `http://${allowedHost}`,
        },
      });
      assert.equal(claim.status, 201, 'the fixture claims the container');
      return claim.json().sessionToken;
    },
  };
}

function httpRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: options.headers,
      },
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

async function close(fixture) {
  await new Promise((resolve) => fixture.server.close(resolve));
  await rm(fixture.root, { recursive: true, force: true });
}

/**
 * CHANGED CONTRACT.
 *
 * This helper used to read a working session token out of the bootstrap markup,
 * because every `GET /` was handed one. That is exactly the property the owner
 * credential removes, so the token is no longer in the page and what remains to
 * read is the authentication state.
 */
function authStateFrom(response) {
  const match = response.body
    .toString('utf8')
    .match(/<meta name="citadel-auth" content="([^"]+)" \/>/);
  assert.ok(match, 'bootstrap reports the authentication state');
  return match[1];
}

function apiHeaders(token, extra = {}) {
  return {
    'Sec-Fetch-Site': 'same-origin',
    'X-Citadel-Session': token,
    ...extra,
  };
}

/**
 * CHANGED TEST — the assertion about the token was inverted deliberately.
 *
 *   Old contract: any `GET /` is handed a working session token in the markup.
 *   New contract: `GET /` carries no token at all; it reports only whether this
 *   container has an owner, and a token is issued solely by a successful claim
 *   or sign-in.
 *
 * Everything else this test covers — the response headers, the registry
 * namespace, the absence of CORS, no-store on static assets — is unchanged.
 */
test('bootstrap withholds the session token and every response receives restrictive headers', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const response = await fixture.request('/');
  assert.equal(response.status, 200);
  assert.equal(authStateFrom(response), 'unclaimed');
  const markup = response.body.toString('utf8');
  assert.equal(markup.includes('citadel-session'), false, 'no session token in the markup');
  assert.equal(markup.includes(fixture.sessionToken), false, 'not the token under another name');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(
    response.body.toString('utf8'),
    /meta name="citadel-registry-namespace" content="citadel-ui"/
  );
  assert.ok(response.headers['x-correlation-id']);
  assert.equal(response.headers['access-control-allow-origin'], undefined);

  // A token still exists and is still 32 random bytes; it is now issued by the
  // claim rather than published to anyone who loads the page.
  const token = await fixture.signIn();
  assert.ok(token.length >= 43);
  assert.equal(authStateFrom(await fixture.request('/')), 'claimed');

  const staticAsset = await fixture.request('/app.mjs');
  assert.equal(staticAsset.status, 200);
  assert.equal(staticAsset.headers['cache-control'], 'no-store');
});

test('QA server mode rejects the production origin and registry namespace', async () => {
  await assert.rejects(
    start({ testRuntime: true }),
    /QA requires an isolated origin and registry namespace/
  );
});

test('Node tests cannot fall back to the production data root', async () => {
  await assert.rejects(
    createCitadelServer(),
    /Tests must provide an isolated dataRoot/
  );
  await assert.rejects(
    createCitadelServer({
      dataRoot: fileURLToPath(new URL('../.data', import.meta.url)),
      allowedHost: '127.0.0.1:45173',
      allowedOrigin: 'http://127.0.0.1:45173',
      registryNamespace: 'citadel-ui-qa-data-root',
      testRuntime: true,
    }),
    /must not use a production Citadel data root/
  );
});

test('shared modules are served from a traversal-protected static mount and copied by Docker', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));

  const module = await fixture.request('/shared/policy.mjs');
  assert.equal(module.status, 200);
  assert.equal(module.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(module.body.toString('utf8'), 'export const shared = true;\n');
  const core = await fixture.request('/shared/citadel-core.mjs');
  assert.equal(core.status, 200);
  assert.equal(core.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(core.body.toString('utf8'), 'export const core = true;\n');

  assert.equal((await fixture.request('/shared')).status, 404);
  assert.equal((await fixture.request('/shared/')).status, 404);
  const traversal = await fixture.request('/shared/%2e%2e%2fweb/index.html');
  assert.equal(traversal.status, 403);
  assert.equal(traversal.body.toString('utf8').includes('<title>Test</title>'), false);

  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY --chown=10001:10001 shared \.\/shared/);
});

test('host, fetch-site, session, origin, JSON, method, and body limits are enforced', async (t) => {
  const fixture = await start({ jsonBodyLimit: 64 });
  t.after(() => close(fixture));
  const bootstrap = await fixture.request('/');
  assert.equal(authStateFrom(bootstrap), 'unclaimed');
  const token = await fixture.signIn();

  const wrongHost = await fixture.request('/healthz', { headers: { Host: 'localhost:4173' } });
  assert.equal(wrongHost.status, 421);

  const noSession = await fixture.request('/api/health', {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(noSession.status, 401);
  const crossSite = await fixture.request('/api/health', {
    headers: apiHeaders(token, { 'Sec-Fetch-Site': 'cross-site' }),
  });
  assert.equal(crossSite.status, 403);
  const validHealth = await fixture.request('/api/health', { headers: apiHeaders(token) });
  assert.deepEqual(validHealth.json(), { ok: true, service: 'citadel-ui' });

  const noOrigin = await fixture.request('/api/content/bicepparam/parse', {
    method: 'POST',
    headers: apiHeaders(token, { 'Content-Type': 'application/json' }),
    body: '{}',
  });
  assert.equal(noOrigin.status, 403);
  const wrongType = await fixture.request('/api/content/bicepparam/parse', {
    method: 'POST',
    headers: apiHeaders(token, {
      Origin: 'http://127.0.0.1:4173',
      'Content-Type': 'text/plain',
    }),
    body: '{}',
  });
  assert.equal(wrongType.status, 415);
  const tooLarge = await fixture.request('/api/content/bicepparam/parse', {
    method: 'POST',
    headers: apiHeaders(token, {
      Origin: 'http://127.0.0.1:4173',
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ text: 'x'.repeat(100) }),
  });
  assert.equal(tooLarge.status, 413);
  const rejectedMethod = await fixture.request('/api/health', {
    method: 'DELETE',
    headers: apiHeaders(token, { Origin: 'http://127.0.0.1:4173' }),
  });
  assert.equal(rejectedMethod.status, 405);
  assert.equal(rejectedMethod.headers.allow, 'GET, POST, PUT');

  const unauthorizedRecovery = await fixture.request('/api/transactions/missing/recover', {
    method: 'POST',
    headers: {
      'Sec-Fetch-Site': 'same-origin',
      Origin: 'http://127.0.0.1:4173',
      'Content-Type': 'application/json',
      'X-Citadel-Environment': 'env-one',
    },
    body: '{}',
  });
  assert.equal(unauthorizedRecovery.status, 401);
  assert.equal(unauthorizedRecovery.json().error.code, 'INVALID_SESSION');

  const unauthorizedRestore = await fixture.request('/api/transactions/missing/restore-token', {
    method: 'POST',
    headers: {
      'Sec-Fetch-Site': 'same-origin',
      Origin: 'http://127.0.0.1:4173',
      'Content-Type': 'application/json',
      'X-Citadel-Environment': 'env-one',
    },
    body: '{}',
  });
  assert.equal(unauthorizedRestore.status, 401);
  assert.equal(unauthorizedRestore.json().error.code, 'INVALID_SESSION');
});

test('health responses expose no host path and legacy host-filesystem routes are absent', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const healthz = await fixture.request('/healthz');
  assert.deepEqual(healthz.json(), { ok: true });
  assert.equal(healthz.body.toString().includes(fixture.root), false);
  const token = await fixture.signIn();
  for (const path of [
    '/api/deployments',
    '/api/deployment?path=C:%2Fhost%2Fsecret',
    '/api/save',
    '/api/environments',
    '/api/environment',
    '/api/access-contract-targets',
  ]) {
    const response = await fixture.request(path, { headers: apiHeaders(token) });
    assert.equal(response.status, 404, path);
    assert.equal(response.body.toString().includes(fixture.root), false);
    assert.equal(response.body.toString().includes('C:/host/secret'), false);
  }

  const indexSource = await readFile(
    new URL('../server/index.mjs', import.meta.url),
    'utf8'
  );
  for (const forbiddenImport of [
    './discovery.mjs',
    './save.mjs',
    './envlayer.mjs',
    './access-targets.mjs',
    './contracts.mjs',
    './bicep.mjs',
  ]) {
    assert.equal(indexSource.includes(forbiddenImport), false, forbiddenImport);
  }
});

test('content endpoints transform supplied text without accepting a source path', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const token = await fixture.signIn();
  const headers = apiHeaders(token, {
    Origin: 'http://127.0.0.1:4173',
    'Content-Type': 'application/json',
  });

  const source = "using './main.bicep'\nparam enabled = false\n";
  const parsed = await fixture.request('/api/content/bicepparam/parse', {
    method: 'POST',
    headers,
    body: JSON.stringify({ alias: 'bicep/main.bicepparam', text: source }),
  });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.json().params[0].value, false);

  const preview = await fixture.request('/api/content/bicepparam/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      alias: 'bicep/main.bicepparam',
      text: source,
      operations: [{ op: 'set', path: ['enabled'], value: true }],
      path: 'C:/must/not/be/opened',
    }),
  });
  assert.equal(preview.status, 200);
  assert.match(preview.json().text, /enabled = true/);

  const policy =
    '<policies><inbound><set-variable name="jwtRequired" value="false" /></inbound>' +
    '<backend /><outbound /><on-error /></policies>';
  const policySpecs = await fixture.request('/api/core/policy/specs', {
    headers: apiHeaders(token),
  });
  assert.equal(policySpecs.status, 200);
  assert.deepEqual(Object.keys(policySpecs.json()).sort(), [
    'contentSafety',
    'semanticCache',
    'throttles',
    'variables',
  ]);

  const policyParse = await fixture.request('/api/core/policy/read', {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: policy }),
  });
  assert.equal(policyParse.status, 200);
  assert.equal(policyParse.json().controls.variables.jwtRequired.value, 'false');
  assert.deepEqual(Object.keys(policyParse.json()), ['controls']);

  const policyPreview = await fixture.request('/api/core/policy/apply', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text: policy,
      changes: { variables: { jwtRequired: true } },
    }),
  });
  assert.equal(policyPreview.status, 200);
  assert.equal(policyPreview.json().controls.variables.jwtRequired.value, 'true');
  assert.match(policyPreview.json().text, /name="jwtRequired" value="true"/);
  assert.deepEqual(Object.keys(policyPreview.json()).sort(), ['controls', 'text']);

  const pathRejected = await fixture.request('/api/core/policy/read', {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: policy, path: 'C:/must/not/be/opened' }),
  });
  assert.equal(pathRejected.status, 400);
  assert.equal(pathRejected.json().error.code, 'INVALID_CONTENT');
});

test('registry metadata endpoints are authenticated and persist only non-sensitive fields', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const token = await fixture.signIn();
  const headers = apiHeaders(token, {
    Origin: 'http://127.0.0.1:4173',
    'Content-Type': 'application/json',
  });
  const denied = await fixture.request('/api/registry');
  assert.equal(denied.status, 403);
  const initial = await fixture.request('/api/registry', { headers: apiHeaders(token) });
  assert.equal(initial.status, 200);
  const authority = initial.json();
  const timestamp = '2026-08-31T10:00:00.000Z';
  const body = {
    expectedEpoch: authority.epoch,
    expectedRevision: authority.revision,
    projects: [
      {
        id: 'project-one',
        label: 'Citadel rollout',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    environments: [
      {
        id: 'environment-one',
        projectId: 'project-one',
        label: 'Development',
        folderName: 'citadel-dev',
        localPath: 'C:\\source\\citadel-dev',
        fingerprint: 'a'.repeat(64),
        toolVersion: '1.0.0-local',
        settingsVersion: 2,
        fingerprintVersion: 1,
        compatibility: 'supported',
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
        lastScannedAt: timestamp,
      },
    ],
    removedProjectIds: [],
    removedEnvironmentIds: [],
  };
  const saved = await fixture.request('/api/registry', {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(saved.status, 200);
  const read = await fixture.request('/api/registry', { headers: apiHeaders(token) });
  assert.equal(read.status, 200);
  assert.equal(read.json().environments[0].source.folderName, 'citadel-dev');
  assert.equal(read.json().environments[0].source.localPath, 'C:\\source\\citadel-dev');
  assert.equal(read.json().environments[0].folderName, undefined);
  const raw = await readFile(join(fixture.root, 'data', 'settings', 'registry.json'), 'utf8');
  for (const forbidden of ['handle', '.azure', '.env']) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
});

test('concurrency limit returns a bounded busy response', async (t) => {
  const fixture = await start({ maxConcurrency: 0 });
  t.after(() => close(fixture));
  const response = await fixture.request('/healthz');
  assert.equal(response.status, 503);
  assert.equal(response.json().error.code, 'SERVER_BUSY');
  assert.equal(response.headers['retry-after'], '1');
});
