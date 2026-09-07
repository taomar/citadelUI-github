import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubApiClient } from '../server/github/api.mjs';
import { createCitadelServer } from '../server/index.mjs';
import { PublicGitHubMigrationDonor, inspectPublicDonorRepository } from '../web/js/migration-public-donor.mjs';
import { MigrationSession } from '../web/js/migration-session.mjs';
import { publicDonorAlias, publicDonorRef, publicRepositoryName, PUBLIC_DONOR_LIMITS } from '../shared/migration-public-github.mjs';
import { MAX_SOURCE_BYTES } from '../shared/source-scope.mjs';
import { acceptCount, CURRENT, TARGET, deferred } from './_migration-fixture.mjs';
import {
  armParameters, PUBLIC_FILE, PUBLIC_MAIN_SAMPLE, PUBLIC_REPO, PUBLIC_SCHEMA, PUBLIC_TEMPLATE, PUBLIC_TEXT, PublicGitHubMock, publicHarness,
} from './_migration-public-fixture.mjs';

test('migration public repository URLs and explicit ref kinds reject arbitrary hosts, paths and credential-shaped inputs', () => {
  assert.equal(publicRepositoryName(`https://github.com/${PUBLIC_REPO}.git`), PUBLIC_REPO);
  assert.equal(publicRepositoryName(PUBLIC_REPO), PUBLIC_REPO);
  assert.deepEqual(publicDonorRef('branch', 'release/older'), { type: 'branch', name: 'release/older' });
  assert.deepEqual(publicDonorRef('tag', 'v-old'), { type: 'tag', name: 'v-old' });
  assert.equal(publicDonorRef('commit', 'a'.repeat(40)).type, 'commit');
  for (const input of [
    'http://github.com/owner/repo', 'https://github.example/owner/repo', 'https://api.github.com/repos/owner/repo',
    'https://github.com:444/owner/repo', 'https://user:password@github.com/owner/repo',
    'https://github.com/owner/repo/tree/main', 'https://github.com/owner/repo?token=synthetic',
    'https://github.com/owner/../repo', 'https://github.com/owner/%2e%2e', '//github.com/owner/repo',
    'owner/repo/extra', 'owner/..', 'owner/repo\ninjected',
  ]) assert.throws(() => publicRepositoryName(input), { code: 'public-input' });
  for (const [type, ref] of [['branch', ''], ['branch', '../escape'], ['tag', 'a?b'], ['commit', 'abc123'], ['other', 'main']]) {
    assert.throws(() => publicDonorRef(type, ref), { code: 'public-input' });
  }
});

test('migration public donor uses only anonymous GETs, bypasses old-source compatibility, and pins complete provenance', async () => {
  const h = publicHarness();
  const metadata = await inspectPublicDonorRepository(PUBLIC_REPO, h.request);
  assert.equal(metadata.defaultBranch, 'legacy-main');
  const preview = await acceptCount(h);
  assert.equal(preview.canApply, true);
  assert.equal(preview.report.donor.kind, 'public-github');
  const revision = preview.report.donor.revision;
  assert.equal(revision.repositoryId, 8001);
  assert.equal(revision.repository, PUBLIC_REPO);
  assert.equal(revision.refType, 'branch');
  assert.equal(revision.ref, 'legacy-main');
  assert.match(revision.commit, /^[a-f0-9]{40}$/);
  assert.match(revision.treeSha, /^[a-f0-9]{40}$/);
  assert.match(preview.report.binding.sources[0].version, /^[a-f0-9]{40}$/);
  assert.equal(preview.report.binding.sources[0].hash.length, 64);
  assert(h.publicCalls.every((call) => call.method === 'GET' && !Object.keys(call.headers).length));
  assert(h.github.calls.every((call) => !/compatibility|\/user|\/branches$|\/git\/refs$/.test(call.path)));
  for (const name of ['write', 'remove', 'assertWritable', 'readSubscriptionId', 'writeSubscriptionId']) assert.equal(h.donor[name], undefined);
  assert.equal(h.api.trace.length, 0, 'no transaction is prepared by discovery/preview');
});

test('migration public supplied-main evidence is replayed at the explicit commit, never the default branch', async () => {
  const github = new PublicGitHubMock();
  github.repository.full_name = PUBLIC_MAIN_SAMPLE.repository;
  github.repository.default_branch = 'citadel-v1';
  const revision = github.seed('main', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA });
  github.commits.set(PUBLIC_MAIN_SAMPLE.commit, { sha: PUBLIC_MAIN_SAMPLE.commit, tree: { sha: revision.treeSha } });
  const h = publicHarness({
    github, repository: PUBLIC_MAIN_SAMPLE.repository, refType: 'commit', ref: PUBLIC_MAIN_SAMPLE.commit,
  });
  const preview = await acceptCount(h);
  assert.equal(preview.report.donor.revision.commit, PUBLIC_MAIN_SAMPLE.commit);
  assert.equal(preview.report.donor.revision.refType, 'commit');
  assert.equal(preview.report.pairs[0].source.label, PUBLIC_MAIN_SAMPLE.repository);
  assert(!github.calls.some((call) => call.path.includes('/git/ref/')), 'the explicit preset does not read a default branch');
});

for (const kind of ['tag', 'annotated-tag', 'commit']) {
  test(`migration public ${kind} selection resolves an explicit immutable revision`, async () => {
    const github = new PublicGitHubMock();
    const revision = github.seed('v-older', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA }, {
      tag: true, annotated: kind === 'annotated-tag',
    });
    const h = publicHarness({ github, refType: kind === 'commit' ? 'commit' : 'tag', ref: kind === 'commit' ? revision.commit : 'v-older' });
    const preview = await acceptCount(h);
    assert.equal(preview.report.donor.revision.commit, revision.commit);
    assert.equal(preview.report.donor.revision.treeSha, revision.treeSha);
    assert.equal(preview.report.donor.label, PUBLIC_REPO);
    assert.equal(preview.report.pairs[0].source.label, PUBLIC_REPO, 'a validated commit ID must not hide repository provenance');
    if (kind === 'annotated-tag') assert.notEqual(preview.report.donor.revision.refSha, revision.commit);
    const draft = await h.session.export(preview.id, 'draft');
    assert.match(draft.text, /param Count = 4/);
  });
}

test('migration public JSON shares strict ARM mapping, duplicate handling and secure/dynamic screening', async () => {
  const github = new PublicGitHubMock();
  const file = 'parameters.json';
  github.seed('legacy-main', {
    [file]: armParameters({
      count: { value: 6 },
      'Legacy.Feature.Flag': { value: true },
      secretValue: { value: 'SYNTHETIC_PRIVATE_MARKER' },
      nested: { value: { credential: 'SYNTHETIC_PRIVATE_MARKER' } },
      dynamic: { value: [{ expression: "[parameters('DO_NOT_EVALUATE')]" }] },
      reference: { reference: { keyVault: { id: 'synthetic-vault' }, secretName: 'synthetic' } },
    }).replace('"count":{"value":6}', '"count":{"value":6},"Count":{"value":7}'),
  });
  const h = publicHarness({ github });
  const view = await h.plan({ sourceIds: [file] });
  const row = view.rows.find((item) => item.name === 'Count');
  assert.equal(row.candidates.length, 2);
  assert(row.categories.includes('ambiguous'));
  assert(!JSON.stringify(view).includes('SYNTHETIC_PRIVATE_MARKER'));
  assert(!JSON.stringify(view).includes('DO_NOT_EVALUATE'));
  h.session.decide(row.id, { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true });
  h.session.keepRemaining();
  const preview = await h.session.preview();
  assert.equal(preview.report.summary.copied, 0);
  assert.equal(preview.report.summary.proposedEdits, 1);
  assert(preview.report.pairs[0].oldOnlyNames.includes('Legacy.Feature.Flag'));
  assert.match((await h.session.export(preview.id, 'draft')).text, /param Count = 6/);
  assert.doesNotMatch((await h.session.export(preview.id, 'draft')).text, /Legacy\.Feature\.Flag/);
});

test('migration public Bicep secure annotations and nested interpolation are never copied or exposed', async () => {
  const github = new PublicGitHubMock();
  github.seed('legacy-main', {
    [PUBLIC_FILE]: "using './main.bicep'\nparam count = 'SYNTHETIC_PRIVATE_MARKER'\nparam nested = [{ item: '${DO_NOT_EVALUATE}' }]\n",
    [PUBLIC_TEMPLATE]: '@secure()\nparam count string\nparam nested array\n',
  });
  const h = publicHarness({ github });
  const view = await h.plan();
  assert.equal(view.rows[0].candidates[0].category, 'sensitive');
  assert.equal(view.rows[0].candidates[0].eligible, false);
  assert(!JSON.stringify(view).includes('SYNTHETIC_PRIVATE_MARKER'));
  assert(!JSON.stringify(view).includes('DO_NOT_EVALUATE'));
});

test('migration public scope rejects hidden sources, .env, symlinks, submodules, oversized entries and arbitrary API input', async () => {
  for (const alias of ['.azure/dev/.env', '.env.json', '.git/config.json', 'CitadelUI/config.json', '../main.bicepparam', '/main.bicepparam', 'file.ps1', 'a//main.bicepparam', 'token=SYNTHETIC_PRIVATE_MARKER.bicepparam']) {
    assert.throws(() => publicDonorAlias(alias), { code: 'public-scope' });
  }
  const github = new PublicGitHubMock();
  github.seed('legacy-main', {
    [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA,
    '.azure/dev/.env': 'never read', '.env.json': 'never read', 'CitadelUI/private.bicepparam': 'never read',
    'link.bicepparam': { text: PUBLIC_TEXT, mode: '120000' },
    'module.bicepparam': { text: PUBLIC_TEXT, mode: '160000', type: 'commit' },
    'large.json': { text: '{}', size: MAX_SOURCE_BYTES + 1 },
  });
  const h = publicHarness({ github });
  const entries = await h.donor.entries();
  assert.deepEqual(entries.map((entry) => entry.alias), [PUBLIC_TEMPLATE, PUBLIC_FILE]);
  assert.equal(h.donor.exclusions().length, 3);
  const before = h.github.calls.length;
  await assert.rejects(h.donor.read('link.bicepparam'), { code: 'public-scope' });
  await assert.rejects(h.request(`/api/github/public-donor/snapshot?repository=${PUBLIC_REPO}&refType=branch&ref=legacy-main&token=forbidden`), { code: 'public-input' });
  await assert.rejects(h.request(`/api/github/public-donor/snapshot?repository=${PUBLIC_REPO}&refType=branch&ref=legacy-main`, { method: 'POST', body: '{}' }), { code: 'public-read-only' });
  assert.equal(h.github.calls.length, before);
});

test('migration credential-shaped public file aliases are refused before request URLs or report identifiers are formed', async () => {
  const h = publicHarness();
  const before = h.publicCalls.length;
  await assert.rejects(h.donor.read('token=SYNTHETIC_PRIVATE_MARKER.bicepparam'), { code: 'public-scope' });
  assert.equal(h.publicCalls.length, before);
  assert.doesNotMatch(JSON.stringify(h.publicCalls), /SYNTHETIC_PRIVATE_MARKER/);
});

test('migration public snapshots reject truncated trees and never interpret an incomplete listing as absent templates', async () => {
  const github = new PublicGitHubMock();
  for (const tree of github.trees.values()) tree.truncated = true;
  const h = publicHarness({ github });
  await assert.rejects(h.donor.entries(), { code: 'public-tree' });
  assert.equal(h.github.calls.filter((call) => call.path.includes('/git/trees/')).length, 1, 'no quota-heavy subtree fallback');
});

test('migration public missing templates are distinguished from API read errors and excluded templates', async () => {
  const github = new PublicGitHubMock();
  github.seed('legacy-main', { [PUBLIC_FILE]: PUBLIC_TEXT });
  const missing = publicHarness({ github });
  assert((await missing.plan()).rows[0].candidates[0].eligible, 'absence is known from a complete immutable tree');
  const blockedGithub = new PublicGitHubMock();
  blockedGithub.seed('legacy-main', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: { text: PUBLIC_SCHEMA, mode: '120000' } });
  const blocked = publicHarness({ github: blockedGithub });
  await assert.rejects(blocked.plan(), { code: 'public-scope' });
});

test('migration public duplicate paths and non-file template entries cannot pick a metadata winner', async () => {
  const duplicate = publicHarness();
  const tree = duplicate.github.trees.values().next().value;
  tree.tree.push({ ...tree.tree[0], mode: '120000' });
  await assert.rejects(duplicate.donor.entries(), { code: 'public-tree' });
  const directory = publicHarness();
  directory.github.trees.values().next().value.tree.find((entry) => entry.path === PUBLIC_TEMPLATE).type = 'tree';
  await assert.rejects(directory.plan(), { code: 'public-scope' });
});

for (const [status, headers, code] of [
  [429, {}, 'public-rate'],
  [403, { 'x-ratelimit-remaining': '0' }, 'public-rate'],
  [403, { 'retry-after': '10' }, 'public-rate'],
  [403, { 'x-ratelimit-remaining': '25' }, 'public-read'],
  [404, {}, 'public-not-found'],
  [500, {}, 'public-read'],
  [302, { location: 'https://arbitrary.invalid/private' }, 'public-redirect'],
]) {
  test(`migration public HTTP ${status} (${code}) is explicit and never leaks upstream messages`, async () => {
    const h = publicHarness();
    h.github.overrides.set(`/repos/${PUBLIC_REPO}`, (github) => github.json(status, { message: 'SYNTHETIC_PRIVATE_MARKER' }, headers));
    await assert.rejects(h.donor.entries(), (error) => error.code === code && !error.message.includes('SYNTHETIC_PRIVATE_MARKER'));
    assert.equal(h.github.calls.length, 1, 'no redirect or authenticated fallback');
    assert.equal(h.api.trace.length, 0);
  });
}

test('migration public rate/read failures during freshness checks invalidate decisions instead of pretending fields disappeared', async () => {
  const h = publicHarness();
  const preview = await acceptCount(h);
  h.github.overrides.set(`/repositories/8001`, (github) => github.json(403, { message: 'SYNTHETIC_PRIVATE_MARKER' }, { 'x-ratelimit-remaining': '0' }));
  await assert.rejects(h.session.export(preview.id, 'report'), { code: 'public-rate' });
  await assert.rejects(h.session.apply(preview.id, { reviewed: true }), { code: 'review' });
  assert.equal(h.api.trace.length, 0);
});

for (const kind of ['branch', 'tag']) {
  test(`migration public moved ${kind} invalidates a reviewed pinned plan`, async () => {
    const github = new PublicGitHubMock();
    if (kind === 'tag') github.seed('v-old', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA }, { tag: true, annotated: true });
    const h = publicHarness({ github, refType: kind, ref: kind === 'tag' ? 'v-old' : 'legacy-main' });
    const preview = await acceptCount(h);
    const prior = preview.report.donor.revision.commit;
    github.seed(kind === 'tag' ? 'v-old' : 'legacy-main', {
      [PUBLIC_FILE]: PUBLIC_TEXT.replace('count = 4', 'count = 7'), [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA,
    }, { tag: kind === 'tag', annotated: kind === 'tag' });
    await assert.rejects(h.session.export(preview.id, 'draft'), { code: 'public-stale' });
    assert(github.commits.has(prior), 'old immutable commit still exists; the selected moving ref is the stale input');
    assert.equal(h.api.trace.length, 0);
  });
}

test('migration public full-commit selections remain valid when an unselected branch moves', async () => {
  const github = new PublicGitHubMock();
  const commit = github.refs.get('heads/legacy-main').object.sha;
  const h = publicHarness({ github, refType: 'commit', ref: commit });
  const preview = await acceptCount(h);
  github.seed('legacy-main', { [PUBLIC_FILE]: PUBLIC_TEXT.replace('4', '7'), [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA });
  assert.match((await h.session.export(preview.id, 'draft')).text, /Count = 4/);
  assert.equal(preview.report.donor.revision.commit, commit);
});

test('migration public blob cache remains bounded across repeated file pairings', async () => {
  const github = new PublicGitHubMock();
  github.seed('legacy-main', Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`file-${index}.bicepparam`, `// synthetic ${index}\n`])));
  const h = publicHarness({ github });
  for (let index = 0; index < 65; index++) await h.donor.read(`file-${index}.bicepparam`);
  const before = github.calls.length;
  await h.donor.read('file-0.bicepparam');
  assert.equal(github.calls.length, before + 2, 'oldest blob was evicted; its public metadata and immutable blob are re-read');
});

test('migration public repository privacy/identity changes and snapshot expiration are explicit', async () => {
  for (const change of ['private', 'identity', 'expired']) {
    let now = Date.now();
    const h = publicHarness({ routes: { now: () => now } });
    const preview = await acceptCount(h);
    if (change === 'private') h.github.repository.private = true;
    if (change === 'identity') h.github.repository.full_name = 'synthetic/renamed';
    if (change === 'expired') now += PUBLIC_DONOR_LIMITS.lifetimeMs + 1;
    await assert.rejects(h.session.preview(), {
      code: change === 'private' ? 'public-not-found' : change === 'identity' ? 'public-stale' : 'public-expired',
    });
    await assert.rejects(h.session.export(preview.id, 'report'), { code: 'review' });
  }
});

test('migration public blob identity, content size and SHA-256 are checked independently of filenames', async () => {
  const h = publicHarness();
  await h.donor.entries();
  const snapshot = h.routes.publicDonor.snapshots.values().next().value;
  const entry = snapshot.files.find((file) => file.alias === PUBLIC_FILE);
  h.github.blobs.get(entry.sha).content = Buffer.from(PUBLIC_TEXT.replace('4', '5')).toString('base64');
  await assert.rejects(h.donor.read(PUBLIC_FILE), { code: 'public-read' });
  const valid = publicHarness();
  const forged = new PublicGitHubMigrationDonor({
    repository: PUBLIC_REPO, refType: 'branch', ref: 'legacy-main',
    request: async (path, options) => {
      const response = await valid.request(path, options);
      return path.includes('/blob?') ? { ...response, hash: 'f'.repeat(64) } : response;
    },
  });
  await assert.rejects(forged.read(PUBLIC_FILE), { code: 'public-read' });
});

test('migration public arbitrary JSON and Git LFS pointers cannot masquerade as parameter values', async () => {
  for (const [alias, text, code] of [
    ['arbitrary.json', '{"count":3}', 'public-format'],
    ['large.bicepparam', 'version https://git-lfs.github.com/spec/v1\noid sha256:synthetic\nsize 99\n', 'public-scope'],
  ]) {
    const github = new PublicGitHubMock();
    github.seed('legacy-main', { [alias]: text });
    const h = publicHarness({ github });
    await assert.rejects(h.plan({ sourceIds: [alias] }), { code });
  }
});

test('migration public donor applies only through local backups and rechecks the public ref during authorization', async () => {
  const h = publicHarness();
  const preview = await acceptCount(h);
  await h.session.apply(preview.id, { reviewed: true });
  assert.deepEqual(h.api.trace, ['prepare', 'backup', 'authorize', 'committing', 'receipt']);
  assert.equal((await h.provider.read(TARGET)).text, CURRENT.replace('Count = 2', 'Count = 4'));
  assert(h.github.calls.every((call) => call.method === 'GET'));
  const hooks = {};
  const stale = publicHarness({ local: { hooks } });
  const review = await acceptCount(stale);
  hooks.authorize = async () => {
    stale.github.seed('legacy-main', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA });
  };
  await assert.rejects(stale.session.apply(review.id, { reviewed: true }), { code: 'public-stale' });
  assert.equal((await stale.provider.read(TARGET)).text, CURRENT);
  assert.equal(stale.api.trace.at(-1), 'fail');
});

test('migration public donor receipt failure retains the existing rollback route and never writes GitHub', async () => {
  const h = publicHarness({ local: { hooks: { receipt: async () => { throw new Error('Synthetic receipt failure'); } } } });
  const preview = await acceptCount(h);
  await assert.rejects(h.session.apply(preview.id, { reviewed: true }), { code: 'apply-failed' });
  assert.equal((await h.provider.read(TARGET)).text, CURRENT);
  assert.equal(h.api.trace.at(-1), 'rollback');
  assert(h.github.calls.every((call) => call.method === 'GET'));
});

test('migration public slow reads cannot publish a plan after workspace or selection changes', async () => {
  const h = publicHarness();
  await h.donor.entries();
  const gate = deferred();
  const entered = deferred();
  const snapshot = h.routes.publicDonor.snapshots.values().next().value;
  const entry = snapshot.files.find((file) => file.alias === PUBLIC_FILE);
  h.github.overrides.set(`/repos/${PUBLIC_REPO}/git/blobs/${entry.sha}`, async (github) => {
    entered.resolve();
    await gate.promise;
    return github.json(200, github.blobs.get(entry.sha));
  });
  const pending = h.plan();
  await entered.promise;
  h.state.context = { ...h.context };
  gate.resolve();
  await assert.rejects(pending, { code: 'stale' });
  assert.equal(h.api.trace.length, 0);
});

test('migration public donor rejects identical remote snapshot aliases; different remote targets remain export-only', async () => {
  const h = publicHarness();
  await h.donor.entries();
  const revision = h.donor.provenance();
  let head = revision.commit;
  let writes = 0;
  const context = {
    projectId: 'remote-project',
    environment: { id: 'remote-target', label: 'Current remote', source: {
      kind: 'github', repositoryId: 8001, fullName: PUBLIC_REPO, sourceBranch: 'main', workingBranch: 'current-branch',
    } },
    provider: {
      remote: true, tree: async () => ({ head, repository: { id: 8001, fullName: PUBLIC_REPO }, branch: 'current-branch' }),
      entries: () => h.provider.entries(), read: (alias) => h.provider.read(alias),
    },
  };
  const session = new MigrationSession({
    contextProvider: () => context, registry: h.registry, coordinator: { commit: async () => { writes++; } },
  });
  await assert.rejects(session.plan({ donor: h.donor, sourceIds: [PUBLIC_FILE], targetAlias: TARGET }), { code: 'identity' });
  head = 'f'.repeat(40);
  const view = await session.plan({ donor: h.donor, sourceIds: [PUBLIC_FILE], targetAlias: TARGET });
  const row = view.rows.find((entry) => entry.name === 'Count');
  session.decide(row.id, { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true });
  session.keepRemaining();
  const preview = await session.preview();
  assert.equal(preview.canApply, false);
  assert.match((await session.export(preview.id, 'draft')).text, /Count = 4/);
  await assert.rejects(session.apply(preview.id, { reviewed: true }), { code: 'remote' });
  assert.equal(writes, 0);
});

test('migration anonymous GitHub client cannot be given a token or mutation by another caller', async () => {
  let calls = 0;
  const client = new GitHubApiClient({ fetch: async () => { calls++; throw new Error('Should not fetch'); } });
  await assert.rejects(client.request('/repos/example/repo', { anonymous: true, token: 'synthetic-not-a-credential' }));
  await assert.rejects(client.request('/repos/example/repo', { anonymous: true, method: 'POST', body: {} }));
  assert.equal(calls, 0);
});

function callHttp(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('migration public HTTP transport preserves owner/host/fetch-site/CSP guards but requires no GitHub session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-public-donor-http-'));
  const webRoot = join(root, 'web');
  const sharedRoot = join(root, 'shared');
  await mkdir(webRoot);
  await mkdir(sharedRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><html><body>Synthetic test</body></html>');
  const github = new PublicGitHubMock();
  const host = '127.0.0.1:4199';
  const sessionToken = 'synthetic-owner-session';
  const created = await createCitadelServer({
    webRoot, sharedRoot, dataRoot: join(root, 'data'), allowedHost: host, allowedOrigin: `http://${host}`,
    sessionToken, githubOptions: { clientOptions: { fetch: github.fetch } },
    credentialVault: { initialize: async () => {}, status: () => ({ available: false }) },
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const port = created.server.address().port;
  const path = `/api/github/public-donor/repository?repository=${PUBLIC_REPO}`;
  const headers = { Host: host, 'Sec-Fetch-Site': 'same-origin', 'X-Citadel-Session': sessionToken };
  assert.equal((await callHttp(port, path, { Host: host, 'Sec-Fetch-Site': 'same-origin' })).status, 401);
  assert.equal((await callHttp(port, path, { ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await callHttp(port, path, { ...headers, Host: 'arbitrary.invalid' })).status, 421);
  assert.equal(github.calls.length, 0);
  const result = await callHttp(port, path, headers);
  assert.equal(result.status, 200);
  assert.equal(result.body.visibility, 'public');
  assert.match(result.headers['content-security-policy'], /connect-src 'self'/);
  assert.doesNotMatch(result.headers['content-security-policy'], /api\.github\.com/);
  assert.equal((await callHttp(port, path, { ...headers, Origin: `http://${host}` }, 'POST')).status, 405);
  assert.equal(github.calls.length, 1, 'only the allowed anonymous metadata read reaches GitHub');
});
