import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { decodeNativeBytes } from '../shared/terraform/workspace.mjs';
import { decodeSourceBytes, encodeSourceText } from '../shared/source-text.mjs';
import { sha256 } from '../shared/source-scope.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';
import { githubWorkspaceFixture } from './_github-workspace-fixture.mjs';
import { ACCESS_PATHS, citadelRepositoryFiles } from './_citadel-fixture.mjs';

const MAIN = 'bicep/infra/main.bicepparam';
const encode = (text) => new TextEncoder().encode(text);
const comment = 'Untouched caf\u00e9 \u6f22\u5b57 \ud83d\ude80';
const main = citadelRepositoryFiles()[MAIN]
  .replace("param environmentName = 'dev'", `// ${comment}\nparam environmentName = 'dev' // keep`)
  .replace(/\n/g, '\r\n');
const policy = `<policies>\r\n  <!-- ${comment} -->\r\n  <inbound><set-variable name="jwtRequired" value="false" /></inbound>\r\n</policies>\r\n`;

async function fixture(t, transport, files, afterAttach = false) {
  if (transport === 'GitHub') return githubWorkspaceFixture({ [afterAttach ? 'filesAfterAttach' : 'files']: Object.fromEntries(
    Object.entries(files).map(([alias, content]) => [alias, typeof content === 'string' ? content : { content }])
  ) });
  const f = await nativeLocalFixture({
    configuration: createConfiguration('bicep'),
    onlyFiles: { ...Object.fromEntries(Object.entries(citadelRepositoryFiles()).filter(([, value]) => typeof value === 'string')), ...files },
  });
  t.after(f.close);
  f.raw = async (alias) => (await f.provider.fileHandle(alias)).bytes.slice();
  return f;
}

test('source codec roundtrips BOM, CRLF, Unicode and an intentional second leading marker', () => {
  for (const text of ['', main, policy, '\uFEFF', `\uFEFF${main}`, `\uFEFF\uFEFF${main}`]) {
    const bytes = encode(text), decoded = decodeSourceBytes(bytes);
    assert.deepEqual(encodeSourceText(decoded.text, decoded), bytes);
  }
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xe2, 0x82]),
    new Uint8Array([0xff, 0xfe, 0x61, 0])]) {
    assert.throws(() => decodeSourceBytes(bytes), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
  }
  assert.throws(() => encodeSourceText('\ud800'), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
  assert.throws(() => decodeNativeBytes(encode(`\uFEFF${main}`)), /BOM files are read-only/);
  assert.throws(() => decodeNativeBytes(new Uint8Array([0xff])), /valid UTF-8/);
});

for (const transport of ['Local', 'GitHub']) {
  for (const bom of [false, true]) {
    for (const kind of ['parameter', 'guided-policy', 'raw-policy']) {
      test(`source fidelity: ${transport} ${kind} preserves ${bom ? 'BOM' : 'no BOM'}, CRLF and untouched Unicode bytes`, async (t) => {
        const alias = kind === 'parameter' ? MAIN : ACCESS_PATHS.policy;
        const original = encode(`${bom ? '\uFEFF' : ''}${kind === 'parameter' ? main : policy}`);
        const f = await fixture(t, transport, { [alias]: original });
        const source = await f.provider.read(alias);
        assert.equal(source.bom, bom);
        assert.deepEqual(encodeSourceText(source.text, source), original);
        const operations = [{ op: 'set', path: ['environmentName'], value: 'reviewed' }];
        const text = kind === 'raw-policy' ? policy.replace('value="false"', 'value="true"') : null;
        const changes = { variables: { jwtRequired: true } };
        const preview = kind === 'parameter'
          ? await f.service.preview(alias, operations, source.hash)
          : await f.service.previewPolicy(alias, changes, text, source.hash);
        assert.equal(preview.bom, bom);
        const expected = encode(`${bom ? '\uFEFF' : ''}${kind === 'parameter'
          ? main.replace("'dev'", "'reviewed'") : policy.replace('value="false"', 'value="true"')}`);
        assert.deepEqual(encodeSourceText(preview.before, preview), original);
        assert.deepEqual(encodeSourceText(preview.after, preview), expected);
        const result = kind === 'parameter'
          ? await f.service.save(alias, operations, source.hash)
          : await f.service.savePolicy({ path: alias, changes, text, expectedHash: source.hash });
        assert.deepEqual(await f.raw(alias), expected);
        const historyId = (await f.service.history()).transactions[0].transactionId;
        if (transport === 'Local') {
          const transaction = await f.store.getTransaction(f.environment.id, result.archived);
          const token = await f.store.issueRestoreToken(f.environment.id, result.archived);
          const backup = await f.store.getBackupForRestore(f.environment.id, result.archived, transaction.files[0].id, token.backupReadToken);
          assert.deepEqual(new Uint8Array(backup.bytes), original);
        } else {
          const recorded = f.audit.commits.find((entry) => entry.commit === historyId);
          assert.ok(recorded.aliases.includes(alias));
          const parent = f.github.commits.get(historyId).parents[0];
          const entry = f.github.treeOf(parent).find((file) => file.path === alias);
          assert.deepEqual(new Uint8Array(Buffer.from(f.github.blobs.get(entry.sha), 'base64')), original);
        }
        await f.service.restoreTransaction(historyId);
        assert.deepEqual(await f.raw(alias), original);
      });
    }
  }

  for (const alias of [MAIN, ACCESS_PATHS.policy]) {
    test(`source fidelity: ${transport} refuses malformed UTF-8 before preview or save for ${alias}`, async (t) => {
      const invalid = new Uint8Array([...encode('// unreviewed '), 0xff, ...encode(`\n${alias === MAIN ? main : policy}`)]);
      const f = await fixture(t, transport, { [alias]: invalid }, true);
      const hash = await sha256(invalid);
      const operations = [{ op: 'set', path: ['environmentName'], value: 'refused' }];
      await assert.rejects(f.provider.read(alias), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
      await assert.rejects(alias === MAIN
        ? f.service.preview(alias, operations, hash)
        : f.service.previewPolicy(alias, {}, '<policies/>', hash), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
      await assert.rejects(alias === MAIN
        ? f.service.save(alias, operations, hash)
        : f.service.savePolicy({ path: alias, text: '<policies/>', expectedHash: hash }),
      { code: 'SOURCE_ENCODING_UNSUPPORTED' });
      assert.deepEqual(await f.raw(alias), invalid);
      if (transport === 'Local') assert.equal((await f.store.history(f.environment.id)).length, 0);
      else assert.equal(f.audit.commits.length, 0);
    });
  }

  test(`source fidelity: ${transport} template creation keeps parameter and policy BOM provenance`, async (t) => {
    const files = citadelRepositoryFiles();
    const f = await fixture(t, transport, {
      [ACCESS_PATHS.template]: `\uFEFF${files[ACCESS_PATHS.template].replace(/\n/g, '\r\n')}`,
      [ACCESS_PATHS.policy]: `\uFEFF${policy}`,
    });
    const result = await f.service.createContract({ name: 'encoding-pair' });
    const parameter = result.created.find((alias) => alias.endsWith('.bicepparam'));
    const xml = result.created.find((alias) => alias.endsWith('.xml'));
    assert.deepEqual((await f.raw(parameter)).slice(0, 3), new Uint8Array([0xef, 0xbb, 0xbf]));
    assert.deepEqual(await f.raw(xml), encode(`\uFEFF${policy}`));
    assert.match((await f.provider.read(parameter)).text, /using '\.\.\/\.\.\/main.bicep'\r\n/);
  });
}

test('source fidelity: Local overwrite backs up exact external encoding and retains its BOM', async (t) => {
  const f = await fixture(t, 'Local', { [MAIN]: main });
  const loaded = await f.service.deployment(MAIN);
  const external = encode(`\uFEFF${main.replace('// keep', '// external')}`);
  (await f.provider.fileHandle(MAIN)).change(external);
  const review = await f.service.prepareLocalOverwrite(loaded, [{ op: 'set', path: ['environmentName'], value: 'replacement' }]);
  const result = await f.service.saveLocalOverwrite(review);
  assert.equal(review.bom, true);
  assert.deepEqual(await f.raw(MAIN), encode(`\uFEFF${main.replace("'dev'", "'replacement'")}`));
  await f.service.restoreTransaction(result.archived);
  assert.deepEqual(await f.raw(MAIN), external);
});
