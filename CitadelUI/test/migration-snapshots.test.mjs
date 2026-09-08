import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MigrationDonor } from '../web/js/migration-donor.mjs';
import { MigrationSnapshots } from '../web/js/migration-snapshot.mjs';
import { SNAPSHOT_ENDPOINT as BASE } from '../shared/migration-snapshot.mjs';
import { serializeValue } from '../shared/bicepparam/serialize.mjs';
import { isolatedSnapshotApp } from './_migration-snapshot-fixture.mjs';
import { migrationHarness, MigrationFileHandle, TARGET, TEMPLATE, SCHEMA } from './_migration-fixture.mjs';
import { publicHarness, PUBLIC_FILE, PUBLIC_REPO, PublicGitHubMock, armParameters } from './_migration-public-fixture.mjs';
import { authenticatedHarness } from './_migration-auth-fixture.mjs';
import { cachedPublicHarness } from './_migration-public-cache.mjs';
import { readBicepParameters } from '../shared/migration-input.mjs';
import { migrationRowVisible, migrationSelectionSummary } from '../web/js/migration-value-view.mjs';

export const LLM_TARGET = 'bicep/infra/llm-backend-onboarding/main.bicepparam';
export const ACCESS_ROOT = 'bicep/infra/citadel-access-contracts';
const models = [{ backendId: 'old-models', backendType: 'ai-foundry', endpoint: 'https://old.example.invalid/',
  authType: 'managed-identity', priority: 1, weight: 100,
  supportedModels: [{ name: 'chat', modelVersion: '2026', modelFormat: 'OpenAI', capacity: 90 }] }];
const files = {
  [TARGET]: "using './main.bicep'\nparam count = 4\n",
  [TEMPLATE]: SCHEMA,
  [LLM_TARGET]: `param llmBackendConfig = ${serializeValue(models)}\n`,
  [`${ACCESS_ROOT}/finance/main.bicepparam`]: "param productName = 'finance'\nparam subscriptionRequired = true\n",
  'resolved.json': armParameters({ Count: { value: 5 } }),
  'abbreviations.json': '{"resourceGroup":"rg"}',
  'invalid.json': armParameters({ Count: { value: 1, reference: {} } }),
  'unfamiliar/explicit.bicepparam': 'param usefulOldName = 7\n',
  '.env': 'DO_NOT_CAPTURE_ENV',
  'unrelated-script.sh': 'DO_NOT_CAPTURE_SCRIPT',
  'samples/demo.bicepparam': 'param doNotCapture = true\n',
};

for (const kind of ['public', 'private-token', 'private-saved', 'folder', 'files']) {
  test(`complete ${kind} capture survives original loss and isolated app restart without source reads`, async (t) => {
    const app = await isolatedSnapshotApp(t);
    let h;
    let donor;
    if (kind === 'public') {
      h = publicHarness();
      h.github.seed('legacy-main', files);
      donor = h.donor;
    } else if (kind.startsWith('private')) {
      h = authenticatedHarness();
      h.github.seed('legacy-main', files);
      await h.connection.connect(kind.endsWith('saved') ? { profileId: 'existing-connection' } : { token: h.token });
      donor = h.selectDonor();
    } else {
      h = migrationHarness({ donorFiles: files });
      donor = kind === 'folder' ? h.donor : new MigrationDonor({ files: [
        new MigrationFileHandle('old.bicepparam', files[TARGET]),
        new MigrationFileHandle('main.bicep', SCHEMA),
        new MigrationFileHandle('resolved.json', files['resolved.json']),
      ] });
    }
    let originalAllowed = true;
    let forbiddenAttempts = 0;
    const original = new Proxy(donor, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args) => {
          if (!originalAllowed) { forbiddenAttempts += 1; throw new Error('All original donor operations are denied'); }
          return value.apply(target, args);
        };
      },
    });
    const client = new MigrationSnapshots({ request: app.request, registry: h.registry });
    const captured = await client.capture(original, {
      destination: h.context, discover: (reader, options) => h.session.inventory(reader, options),
    });
    const originalProvenance = captured.provenance();
    const entries = await captured.entries();
    assert(entries.some((file) => file.format === 'json'));
    assert(!entries.some((file) => /abbreviations|invalid|samples|\.env|script/.test(file.alias)));
    if (kind !== 'files') {
      assert(entries.some((file) => file.alias === LLM_TARGET));
      assert(entries.some((file) => file.alias.startsWith(`${ACCESS_ROOT}/finance/`)));
      assert(entries.some((file) => file.alias === 'unfamiliar/explicit.bicepparam'));
      assert(captured.acquisitionFacts().issues.some((issue) => issue.file === 'invalid.json'));
    }
    if (h.connection) {
      for (const credential of h.github.credentials.values()) credential.revoked = true;
      h.clock.now += 24 * 60 * 60 * 1000;
      await h.connection.disconnect();
    }
    if (h.github) {
      h.github.seed('legacy-main', { [PUBLIC_FILE]: 'param count = 999\n' });
      h.github.overrides.set(`/repos/${PUBLIC_REPO}`, () => { throw new Error('Original network is forbidden after completion'); });
    }
    for (const method of ['read', 'entries', 'template', 'assertFresh', 'assertDistinct', 'assertSameFile']) {
      // The completed adapter cannot retain a reference to any original method.
      assert.notEqual(captured[method], donor[method]);
    }
    const before = { github: h.github?.calls.length, auth: h.github?.authCalls?.length, local: h.donorTrace.length };
    originalAllowed = false;
    h.donorRoot.permission = 'denied';
    h.donorRoot.entries = async function* () { throw new Error('Original folder unavailable'); };
    await app.restart();
    const reopened = await client.open(captured.id, h.context);
    assert.deepEqual(reopened.provenance(), originalProvenance);
    const source = (await reopened.entries()).find((file) => file.alias === (kind === 'files' ? 'old.bicepparam' : TARGET));
    const view = await h.session.plan({ donor: reopened, sourceIds: [source.id], targetAlias: TARGET });
    const row = view.rows.find((row) => row.name === 'Count');
    h.session.decide(row.id, { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true });
    const preview = await h.session.previewSelected();
    assert.equal(preview.canApply, true);
    assert.match((await h.session.export(preview.id, 'draft')).text, /Count = 4/);
    await h.session.apply(preview.id, { reviewed: true });
    assert.match((await h.provider.read(TARGET)).text, /Count = 4/);
    assert.deepEqual({ github: h.github?.calls.length, auth: h.github?.authCalls?.length, local: h.donorTrace.length }, before);
    assert.equal(forbiddenAttempts, 0);
    assert.equal(h.api.trace.filter((step) => step === 'receipt').length, 1);
    const manifestText = await readFile(join(app.root, 'migration-sources', captured.id, 'complete.json'), 'utf8');
    for (const forbidden of [h.token, h.destinationToken, ...(h.mintedIds || []), 'DO_NOT_CAPTURE_ENV', 'DO_NOT_CAPTURE_SCRIPT'].filter(Boolean)) {
      assert(!manifestText.includes(forbidden));
    }
    assert.equal((await app.call(BASE, { headers: { 'X-Citadel-Session': 'wrong-owner-session' } })).status, 401);
    assert.equal((await app.call(BASE, { headers: { Origin: 'https://untrusted.invalid' }, method: 'POST', body: '{}' })).status, 403);
    await assert.rejects(app.request(`${BASE}/${captured.id}/files/${source.id}`, {
      method: 'PUT', body: Buffer.from('change'), headers: { 'Content-Type': 'application/octet-stream' },
    }), { code: 'snapshot-immutable' });
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(app.root, 'migration-sources', captured.id))).mode & 0o777, 0o700);
      assert.equal((await stat(join(app.root, 'migration-sources', captured.id, `${source.id}.bin`))).mode & 0o777, 0o600);
    }
    t.diagnostic(JSON.stringify({ acquisition: kind, completed: true, isolatedAppRestart: true, freshOwnerSignIn: true,
      before, after: { github: h.github?.calls.length, auth: h.github?.authCalls?.length, local: h.donorTrace.length },
      forbiddenOriginalAttempts: forbiddenAttempts, export: true, localApply: true }));
  });
}

test('incomplete/corrupt source never opens or falls back; failed refresh leaves the completed copy', async (t) => {
  const app = await isolatedSnapshotApp(t);
  const h = publicHarness();
  const client = new MigrationSnapshots({ request: app.request, registry: h.registry });
  const capture = () => client.capture(h.donor, { destination: h.context, discover: (reader, options) => h.session.inventory(reader, options) });
  const good = await capture();
  const originalCalls = h.github.calls.length;
  app.store.faultInjector = (phase) => { if (phase === 'complete') throw new Error('Synthetic publication interruption'); };
  await assert.rejects(capture(), { code: 'snapshot-unavailable' });
  assert.equal((await client.open(good.id, h.context)).id, good.id);
  const staged = (await client.list()).find((item) => item.status === 'staging');
  assert(staged);
  await assert.rejects(client.open(staged.id, h.context), { code: 'snapshot-incomplete' });
  const file = (await good.entries())[0];
  await writeFile(join(app.root, 'migration-sources', good.id, `${file.id}.bin`), 'corrupt synthetic bytes');
  const calls = h.github.calls.length;
  await assert.rejects(client.open(good.id, h.context), { code: 'snapshot-corrupt' });
  await assert.rejects(good.read(file.id), { code: 'snapshot-corrupt' });
  assert.equal(h.github.calls.length, calls);
  assert(calls >= originalCalls);
  await rm(join(app.root, 'migration-sources', good.id, `${file.id}.bin`));
  await assert.rejects(good.read(file.id), { code: 'snapshot-corrupt' });
  await client.delete(staged.id);
  await client.delete(good.id);
  assert.deepEqual(await readdir(join(app.root, 'migration-sources')), []);
});

test('local target separation is captured against a real target handle, never just a cache ID or path label', async (t) => {
  const app = await isolatedSnapshotApp(t);
  const h = migrationHarness();
  const client = new MigrationSnapshots({ request: app.request, registry: h.registry });
  const original = new MigrationDonor({ folder: h.root });
  await assert.rejects(client.capture(original, { destination: h.context, discover: (reader) => h.session.inventory(reader) }), { code: 'identity' });
  assert.deepEqual(await client.list(), []);
  const donor = await client.capture(h.donor, { destination: h.context, discover: (reader) => h.session.inventory(reader) });
  await assert.rejects(client.open(donor.id, { ...h.context, provider: { ...h.provider, root: h.donorRoot } }), { code: 'snapshot-identity' });
  await h.registry.forgetMigrationSnapshotTarget(donor.id);
  await assert.rejects(client.open(donor.id, h.context), { code: 'snapshot-identity' });
});

test('duplicate explicit basenames remain distinct; storage is bounded and deletion is explicit', async (t) => {
  const app = await isolatedSnapshotApp(t, { snapshotOptions: { limits: { snapshots: 1 } } });
  const h = migrationHarness();
  const client = new MigrationSnapshots({ request: app.request, registry: h.registry });
  const donor = new MigrationDonor({ files: [
    new MigrationFileHandle('old.bicepparam', 'param Count = 4\n'),
    new MigrationFileHandle('old.bicepparam', 'param Count = 5\n'),
  ] });
  const capture = () => client.capture(donor, { destination: h.context, discover: (reader) => h.session.inventory(reader) });
  const snapshot = await capture();
  const entries = await snapshot.entries();
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.notEqual((await snapshot.read(entries[0].id)).text, (await snapshot.read(entries[1].id)).text);
  await assert.rejects(capture(), { code: 'snapshot-limit' });
  assert.equal((await client.open(snapshot.id, h.context)).id, snapshot.id);
  await client.delete(snapshot.id);
  assert.notEqual((await capture()).id, snapshot.id);
});

test('exact cached public main/resources retain expression and ambiguity facts without runtime invention', {
  skip: !process.env.CITADEL_MIGRATION_PUBLIC_CACHE && 'Supply the approved public response cache to run this bounded replay.',
}, async (t) => {
  const cache = JSON.parse(await readFile(process.env.CITADEL_MIGRATION_PUBLIC_CACHE, 'utf8'));
  assert.equal(cache.commit.sha, '9ef37ad75a47ca89c179a0db5a4123e60c4c720e');
  assert.equal(cache.tree.tree.length, 433);
  const app = await isolatedSnapshotApp(t);
  const supplements = [];
  const h = cachedPublicHarness(cache, { targetFiles: {
    [TARGET]: await readFile(new URL('../../bicep/infra/main.bicepparam', import.meta.url), 'utf8'),
    [TEMPLATE]: await readFile(new URL('../../bicep/infra/main.bicep', import.meta.url), 'utf8'),
  } }, { resolveMissingBlob(entry) {
    assert.match(entry.sha, /^[a-f0-9]{40}$/);
    // The provided inventory cache predates template capture. Use the exact
    // already-local Git object, not current CRLF bytes or a network fallback.
    const bytes = execFileSync('git', ['cat-file', 'blob', entry.sha], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    supplements.push({ alias: entry.path, gitBlob: entry.sha });
    return bytes;
  } });
  const client = new MigrationSnapshots({ request: app.request, registry: h.registry });
  const donor = await client.capture(h.donor, { destination: h.context, discover: (reader, options) => h.session.inventory(reader, options) });
  const calls = h.github.calls.length;
  h.github.fetch = () => { throw new Error('No live or original cache reads after completion'); };
  await app.restart();
  const prepared = await client.open(donor.id, h.context);
  const entries = await prepared.entries();
  assert(!entries.some((entry) => entry.alias.endsWith('abbreviations.json')));
  const main = entries.find((entry) => entry.alias === TARGET);
  const resources = entries.find((entry) => entry.alias === 'bicep/infra/resources.bicepparam');
  for (const [entry, assignments, expressions] of [[main, 97, 93], [resources, 96, 92]]) {
    const parsed = readBicepParameters((await prepared.read(entry.id)).text);
    assert.equal(parsed.parameters.length, assignments);
    assert.equal(parsed.parameters.filter((parameter) => parameter.status === 'dynamic').length, expressions);
  }
  const view = await h.session.plan({ donor: prepared, sourceIds: [main.id], targetAlias: TARGET });
  const summary = migrationSelectionSummary(view.rows);
  assert.equal(summary.same, 4);
  assert.equal(view.rows.filter((row) => migrationRowVisible(row, { scope: 'differences' })).length, 0);
  assert(summary.unavailable >= 90);
  const preview = await h.session.previewSelected();
  assert.equal(preview.changed, false);
  assert.equal(preview.report.summary.proposedEdits, 0);
  assert.equal(preview.report.blockers.length, 0);
  assert(preview.report.unverified.length > 0);
  const combined = await h.session.plan({ donor: prepared, sourceIds: [main.id, resources.id], targetAlias: TARGET });
  assert(combined.rows.some((row) => row.candidates.length === 2 && row.categories.includes('ambiguous')));
  assert.equal(h.github.calls.length, calls);
  t.diagnostic(JSON.stringify({ exactPublicCommit: cache.commit.sha, cachedResponses: Object.keys(cache.blobs).length,
    exactLocalGitTemplateSupplements: supplements, oldRequestsAfterCapture: calls, oldRequestsAfterReview: h.github.calls.length }));
});
