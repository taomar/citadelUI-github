import test from 'node:test';
import assert from 'node:assert/strict';
import { TerraformExportSession, readTerraformSource } from '../web/js/terraform-export-session.mjs';
import { sha256 } from '../shared/source-scope.mjs';
import { GitHubRepositoryProvider } from '../web/js/github-provider.mjs';
import { exportFixture, fixtureFiles, fixtureChoices, FIXTURE_ACCESS_PATH, FIXTURE_SECOND_ACCESS_PATH, FIXTURE_POLICY_PATH } from './_terraform-export-fixture.mjs';

async function ready() {
  const fixture = exportFixture();
  const session = new TerraformExportSession({ contextProvider: () => fixture.context, registry: fixture.registry, activePath: FIXTURE_ACCESS_PATH });
  await session.initialize();
  for (const [area, choices] of Object.entries(fixtureChoices())) for (const [key, value] of Object.entries(choices)) session.setInput(area, key, value);
  assert.equal(session.view().ready, true);
  return { ...fixture, session };
}

test('source reads are confined to parameters, templates and used policy XML; no source writes or env access', async () => {
  const fixture = await ready();
  const review = await fixture.session.review();
  assert.equal(review.dependencies.length, 7);
  assert(review.dependencies.some((entry) => entry.path === FIXTURE_POLICY_PATH));
  const reads = fixture.root.owner.trace.filter((entry) => entry.operation === 'getFile');
  assert(reads.every((entry) => /\.(bicepparam|bicep|xml)$/.test(entry.path)));
  assert(!fixture.root.owner.trace.some((entry) => /write|create|remove/i.test(entry.operation)));
});

test('one Access configuration must be chosen explicitly when multiple exist; never merge or invent ZIP paths', async () => {
  const fixture = exportFixture();
  const session = new TerraformExportSession({ contextProvider: () => fixture.context, registry: fixture.registry });
  await session.initialize();
  assert.equal(session.view().areas.find((entry) => entry.id === 'access').path, null);
  await assert.rejects(session.review(), /Resolve/);
  const readyFixture = await ready();
  const s = readyFixture.session;
  await s.select('access', { path: FIXTURE_SECOND_ACCESS_PATH });
  const review = await s.review();
  const access = review.files.find((entry) => entry.path === 'citadel-access-contracts/terraform.tfvars');
  assert.match(access.text, /"business_unit" = "research"/);
  assert(!access.text.includes('"business_unit" = "finance"'));
  assert.equal(review.files.length, 3);
});

test('area inclusion is explicit and keeps independent choices/configurations, not partial settings', async () => {
  const { session } = await ready();
  const before = session.view().areas[0].choices;
  await session.select('llm', { included: false });
  await session.select('access', { included: false });
  const review = await session.review();
  assert.deepEqual(review.files.map((entry) => entry.path), ['environments/export-demo.tfvars']);
  await session.select('llm', { included: true });
  await session.select('access', { included: true });
  assert.deepEqual(session.view().areas[0].choices, before);
  assert.equal((await session.review()).files.length, 3);
  for (const area of ['deployment', 'llm', 'access']) await session.select(area, { included: false });
  await assert.rejects(session.review(), /Resolve/);
});

test('approval downloads the exact reviewed ZIP bytes and repeated clicks share one in-flight attempt', async () => {
  const { session, root } = await ready();
  const before = root.allFiles().map((entry) => [entry.path, Buffer.from(entry.bytes).toString('base64')]);
  const review = await session.review();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const download = async (file) => {
    calls++;
    assert.equal(await sha256(file.bytes), review.zipHash);
    assert.equal(file.bytes.length, review.size);
    await gate;
  };
  const first = session.approveAndExport(review.id, download);
  const repeated = session.approveAndExport(review.id, download);
  assert.equal(first, repeated);
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(session.view().review, null);
  assert.deepEqual(root.allFiles().map((entry) => [entry.path, Buffer.from(entry.bytes).toString('base64')]), before);
  await assert.rejects(session.approveAndExport(review.id, download), /fresh ZIP review/);
});

for (const path of [
  'bicep/infra/main.bicepparam', 'bicep/infra/llm-backend-onboarding/main.bicep', FIXTURE_POLICY_PATH,
]) {
  test(`freshness revokes approval after ${path} changes`, async () => {
    const { session, root } = await ready();
    const review = await session.review();
    const original = root.allFiles().find((entry) => entry.path === path).bytes;
    root.put(path, `${new TextDecoder().decode(original)}\n// changed after review\n`);
    let downloads = 0;
    await assert.rejects(session.approveAndExport(review.id, async () => { downloads++; }), /changed/);
    assert.equal(downloads, 0);
    assert.equal(session.view().review, null);
  });
}

test('choices, drafts, context changes, and download setup failures cannot reuse approval', async () => {
  const first = await ready();
  const review = await first.session.review();
  first.session.setInput('deployment', 'target:apim_publisher_name', 'Revised');
  await assert.rejects(first.session.approveAndExport(review.id, async () => assert.fail('download')), /fresh ZIP review/);
  const second = await ready();
  const draftReview = await second.session.review();
  second.registry.countDrafts = async () => 1;
  await assert.rejects(second.session.approveAndExport(draftReview.id, async () => assert.fail('download')), /drafts/);
  const third = await ready();
  const contextReview = await third.session.review();
  third.context.environment.id = 'other-environment';
  await assert.rejects(third.session.approveAndExport(contextReview.id, async () => assert.fail('download')), /workspace or branch/);
  const fourth = await ready();
  const brokenReview = await fourth.session.review();
  await assert.rejects(fourth.session.approveAndExport(brokenReview.id, async () => { throw new Error('Object URL failed'); }), /Object URL failed/);
  assert.equal(fourth.session.view().review, null);
});

test('back/revise and a source-provider handoff revoke existing approvals', async () => {
  const first = await ready();
  const review = await first.session.review();
  first.session.revise();
  await assert.rejects(first.session.approveAndExport(review.id, async () => assert.fail('download')), /fresh ZIP review/);
  const second = await ready();
  const secondReview = await second.session.review();
  second.context.provider = exportFixture().provider;
  await assert.rejects(second.session.approveAndExport(secondReview.id, async () => assert.fail('download')), /workspace or branch/);
});

test('an input change during asynchronous review construction cannot approve a different generation', async () => {
  const fixture = await ready();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fixture.registry.countDrafts = () => gate;
  const review = fixture.session.review();
  fixture.session.setInput('deployment', 'target:apim_publisher_name', 'Changed during review');
  release(0);
  await assert.rejects(review, /changed while building/);
  assert.equal(fixture.session.view().review, null);
});

test('mocked GitHub freshness refreshes an isolated provider without repinning the ordinary editor', async () => {
  const files = fixtureFiles();
  const records = await Promise.all(Object.entries(files).map(async ([alias, text]) => {
    const bytes = new TextEncoder().encode(text);
    const hash = await sha256(bytes);
    return { alias, bytes, hash, sha: hash.slice(0, 40), size: bytes.length };
  }));
  let head = 'a'.repeat(40);
  const requests = [];
  const request = async (path, options) => {
    requests.push(path);
    assert.equal(options?.method, undefined, 'The export provider has no write request');
    if (path.endsWith('/tree')) return {
      head, repositoryId: 1, fullName: 'synthetic/export-only', branch: 'example',
      files: records.map(({ alias, sha }) => ({ alias, sha, kind: alias.split('.').at(-1) })),
    };
    const url = new URL(path, 'http://synthetic.invalid');
    assert(url.pathname.endsWith('/blob'));
    const record = records.find((entry) => entry.alias === url.searchParams.get('alias'));
    assert.equal(url.searchParams.get('sha'), record.sha);
    return { size: record.size, hash: record.hash, content: Buffer.from(record.bytes).toString('base64') };
  };
  const provider = new GitHubRepositoryProvider({ request, environmentId: 'synthetic-environment' });
  const editorSnapshot = await provider.tree();
  const context = {
    projectId: 'synthetic', provider,
    environment: { id: 'synthetic-environment', source: {
      kind: 'github', repositoryId: 1, fullName: 'synthetic/export-only', sourceBranch: 'example',
    } },
  };
  const session = new TerraformExportSession({ contextProvider: () => context, registry: { countDrafts: async () => 0 }, activePath: FIXTURE_ACCESS_PATH });
  await session.initialize();
  for (const [area, choices] of Object.entries(fixtureChoices())) for (const [key, value] of Object.entries(choices)) session.setInput(area, key, value);
  const review = await session.review();
  head = 'b'.repeat(40);
  await assert.rejects(session.approveAndExport(review.id, async () => assert.fail('download')), /branch changed/);
  assert.equal(provider.snapshot, editorSnapshot);
  assert.equal(provider.snapshot.head, 'a'.repeat(40));
  assert(requests.filter((path) => path.endsWith('/tree')).length >= 4);
});

test('pending normal editor state prevents export startup and remains unchanged', async () => {
  const fixture = exportFixture();
  const session = new TerraformExportSession({ contextProvider: () => fixture.context, registry: fixture.registry, pendingEdits: () => true });
  await assert.rejects(session.initialize(), /drafts/);
  assert.equal(fixture.root.owner.trace.length, 0);
});

test('policy dependencies cannot escape the repository boundary or use env/state files', async () => {
  for (const relative of ['../../../../../../outside.xml', '.env', '../policies/secret.tfstate', 'C:\\private\\policy.xml']) {
    const files = fixtureFiles();
    files[FIXTURE_ACCESS_PATH] = files[FIXTURE_ACCESS_PATH].replace('../policies/export-fixture.xml', relative);
    const fixture = exportFixture(files);
    await assert.rejects(readTerraformSource(fixture.provider, FIXTURE_ACCESS_PATH));
    assert(!fixture.root.owner.trace.some((entry) => entry.path.endsWith('.env') || entry.path.includes('private')));
  }
});

test('default policy expressions cannot silently discard a suffix after loadTextContent', async () => {
  const files = fixtureFiles();
  files[FIXTURE_ACCESS_PATH] = files[FIXTURE_ACCESS_PATH].replace("policyXml: loadTextContent('../policies/export-fixture.xml')", "policyXml: ''");
  files['bicep/infra/citadel-access-contracts/main.bicep'] =
    files['bicep/infra/citadel-access-contracts/main.bicep'].replace(
      "var defaultProductPolicyXml = loadTextContent('./policies/default-ai-product-policy.xml')",
      "var defaultProductPolicyXml = loadTextContent('./policies/default-ai-product-policy.xml') + runtimePolicy");
  const fixture = exportFixture(files);
  await assert.rejects(readTerraformSource(fixture.provider, FIXTURE_ACCESS_PATH), /static loadTextContent/);
});
