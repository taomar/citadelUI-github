import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { decodeNativeBytes } from '../shared/terraform/workspace.mjs';
import { decodeSourceBytes, encodeSourceText } from '../shared/source-text.mjs';
import { sha256 } from '../shared/source-scope.mjs';
import { nativeLocalFixture, nativeConfiguration, NATIVE_FILES } from './_native-fixture.mjs';
import { githubWorkspaceFixture } from './_github-workspace-fixture.mjs';
import { ACCESS_PATHS, citadelRepositoryFiles } from './_citadel-fixture.mjs';

const MAIN = 'bicep/infra/main.bicepparam';
const encode = (text) => new TextEncoder().encode(text);
const comment = 'Untouched caf\u00e9 \u6f22\u5b57 \ud83d\ude80';
const main = citadelRepositoryFiles()[MAIN]
  .replace("param environmentName = 'dev'", `// ${comment}\nparam environmentName = 'dev' // keep`)
  .replace(/\n/g, '\r\n');
const policy = `<policies>\r\n  <!-- ${comment} -->\r\n  <inbound><set-variable name="jwtRequired" value="false" /></inbound>\r\n</policies>\r\n`;

const mutationRequests = (f, transport) => transport === 'Local'
  ? f.root.owner.trace.filter((entry) => ['createWritable', 'write', 'close', 'createFile', 'createDirectory', 'removeEntry'].includes(entry.operation))
  : f.github.calls.filter((entry) => entry.method !== 'GET');
const sourceSnapshot = (f, transport) => Object.fromEntries(transport === 'Local'
  ? f.root.allFiles().map(({ path, bytes }) => [path, bytes.slice()])
  : f.github.treeOf(f.repository.refs.get(f.environment.source.workingBranch)).map(({ path }) => [path, f.raw(path)]));

async function localBackup(f, transactionId) {
  const transaction = await f.store.getTransaction(f.environment.id, transactionId);
  const token = await f.store.issueRestoreToken(f.environment.id, transactionId);
  const backup = await f.store.getBackupForRestore(f.environment.id, transactionId, transaction.files[0].id, token.backupReadToken);
  return new Uint8Array(backup.bytes);
}

async function fixture(t, transport, files, afterAttach = false, environmentId) {
  if (transport === 'GitHub') return githubWorkspaceFixture({ environmentId, [afterAttach ? 'filesAfterAttach' : 'files']: Object.fromEntries(
    Object.entries(files).map(([alias, content]) => [alias, typeof content === 'string' ? content : { content }])
  ) });
  const f = await nativeLocalFixture({
    environmentId,
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
    assert.deepEqual(decoded, { text: text.startsWith('\uFEFF') ? text.slice(1) : text, bom: text.startsWith('\uFEFF') });
    assert.deepEqual(encodeSourceText(decoded.text, decoded), bytes);
  }
  assert.deepEqual(encodeSourceText(main, { bytes: encode(`\uFEFF${main}`) }), encode(`\uFEFF${main}`));
  assert.deepEqual(encodeSourceText(main, { bom: false, bytes: encode(`\uFEFF${main}`) }), encode(main), 'Explicit BOM provenance overrides byte inference.');
  assert.deepEqual(encodeSourceText(`\uFEFF${main}`, { bom: true }), encode(`\uFEFF\uFEFF${main}`));
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
        const originals = sourceSnapshot(f, transport), mutations = mutationRequests(f, transport);
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
        assert.deepEqual(mutationRequests(f, transport), mutations, 'Preview cannot write source or Git objects.');
        const result = kind === 'parameter'
          ? await f.service.save(alias, operations, source.hash)
          : await f.service.savePolicy({ path: alias, changes, text, expectedHash: source.hash });
        assert.deepEqual(await f.raw(alias), expected);
        assert.deepEqual(sourceSnapshot(f, transport), { ...originals, [alias]: expected }, 'All unrelated source bytes remain untouched.');
        const historyId = (await f.service.history()).transactions[0].transactionId;
        if (transport === 'Local') {
          assert.deepEqual(await localBackup(f, result.archived), original);
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
      const mutations = mutationRequests(f, transport), originals = sourceSnapshot(f, transport);
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
      assert.deepEqual(sourceSnapshot(f, transport), originals);
      assert.deepEqual(mutationRequests(f, transport), mutations);
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

  test(`source fidelity: ${transport} parameter copy preserves destination BOM, CRLF, comments and exact prior bytes`, async (t) => {
    const sourceBytes = encode(main.replace("'dev'", "'source-copy'"));
    const targetText = main.replace("'dev'", "'target'").replace('// keep', '// target-owned');
    const targetBytes = encode(`\uFEFF${targetText}`);
    const source = await fixture(t, transport, { [MAIN]: sourceBytes }, false, 'encoding-copy-source');
    const target = await fixture(t, transport, { [MAIN]: targetBytes }, false, 'encoding-copy-target');
    source.service.registry = { listEnvironments: async () => [source.environment, target.environment], getHandle: async () => null };
    source.service.createProvider = async (environment) => environment.id === target.environment.id ? target.provider : source.provider;
    source.service.coordinator = target.coordinator;
    const file = await source.provider.read(MAIN);
    const preview = await source.service.previewCopy(target.environment.id, MAIN, ['environmentName'], file.hash);
    assert.equal(preview.bom, true);
    const expected = encode(`\uFEFF${targetText.replace("'target'", "'source-copy'")}`);
    assert.deepEqual(encodeSourceText(preview.after, preview), expected);
    const result = await source.service.copyParameters(target.environment.id, MAIN, ['environmentName'], preview.sourceHash, preview.targetHash);
    assert.equal(result.applied, true);
    assert.deepEqual(await target.raw(MAIN), expected); assert.deepEqual(await source.raw(MAIN), sourceBytes);
    await target.service.restoreTransaction(result.commit || result.transactionId);
    assert.deepEqual(await target.raw(MAIN), targetBytes);
  });

  test(`source fidelity: ${transport} no-op previews and saves leave original bytes and History unchanged`, async (t) => {
    const originals = { [MAIN]: encode(`\uFEFF${main}`), [ACCESS_PATHS.policy]: encode(`\uFEFF${policy}`) };
    const f = await fixture(t, transport, originals);
    const mutations = mutationRequests(f, transport);
    const parameter = await f.provider.read(MAIN), xml = await f.provider.read(ACCESS_PATHS.policy);
    assert.equal((await f.service.preview(MAIN, [], parameter.hash)).changed, false);
    assert.equal((await f.service.save(MAIN, [], parameter.hash)).outcome, 'unchanged');
    assert.equal((await f.service.previewPolicy(ACCESS_PATHS.policy, {}, null, xml.hash)).changed, false);
    assert.equal((await f.service.savePolicy({ path: ACCESS_PATHS.policy, changes: {}, expectedHash: xml.hash })).outcome, 'unchanged');
    for (const [alias, bytes] of Object.entries(originals)) assert.deepEqual(await f.raw(alias), bytes);
    assert.equal((await f.service.history()).transactions.length, 0);
    await assert.rejects(f.service.previewPolicy(ACCESS_PATHS.policy, {}, policy.replace(comment, '\ud800'), xml.hash),
      { code: 'SOURCE_ENCODING_UNSUPPORTED' });
    assert.deepEqual(await f.raw(ACCESS_PATHS.policy), originals[ACCESS_PATHS.policy]);
    assert.deepEqual(mutationRequests(f, transport), mutations);
  });

  test(`C1 Git source fidelity: ${transport} raw policy preserves an intentional second leading marker through preview, save and Undo`, async (t) => {
    const alias = ACCESS_PATHS.policy, original = encode(`\uFEFF\uFEFF${policy}`);
    const f = await fixture(t, transport, { [alias]: original });
    const source = await f.provider.read(alias), mutations = mutationRequests(f, transport);
    assert.equal(source.bom, true); assert.equal(source.text, `\uFEFF${policy}`);
    const text = source.text.replace('value="false"', 'value="true"'), expected = encode(`\uFEFF${text}`);
    const preview = await f.service.previewPolicy(alias, {}, text, source.hash);
    assert.deepEqual({ before: preview.before, after: preview.after, bom: preview.bom },
      { before: `\uFEFF${policy}`, after: text, bom: true });
    assert.deepEqual(encodeSourceText(preview.after, preview), expected);
    assert.deepEqual(mutationRequests(f, transport), mutations);
    const result = await f.service.savePolicy({ path: alias, text, expectedHash: source.hash });
    assert.equal(result.outcome, 'applied'); assert.deepEqual(await f.raw(alias), expected);
    if (transport === 'Local') assert.deepEqual(await localBackup(f, result.archived), original);
    else {
      const parent = f.github.commits.get(result.commit).parents[0];
      const entry = f.github.treeOf(parent).find((file) => file.path === alias);
      assert.deepEqual(Buffer.from(f.github.blobs.get(entry.sha), 'base64'), Buffer.from(original));
    }
    await f.service.restoreTransaction(result.commit || result.transactionId);
    assert.deepEqual(await f.raw(alias), original);
  });

  test(`C1 Git source fidelity: ${transport} unencodable parameter and policy edits fail before writes or backups`, async (t) => {
    const f = await fixture(t, transport, { [MAIN]: `\uFEFF${main}`, [ACCESS_PATHS.policy]: policy });
    const originals = sourceSnapshot(f, transport), mutations = mutationRequests(f, transport);
    const parameter = await f.provider.read(MAIN), xml = await f.provider.read(ACCESS_PATHS.policy);
    const operations = [{ op: 'set', path: ['environmentName'], value: '\ud800' }];
    const text = policy.replace(comment, '\udfff');
    await assert.rejects(f.service.preview(MAIN, operations, parameter.hash), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
    await assert.rejects(f.service.save(MAIN, operations, parameter.hash), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
    await assert.rejects(f.service.previewPolicy(ACCESS_PATHS.policy, {}, text, xml.hash), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
    await assert.rejects(f.service.savePolicy({ path: ACCESS_PATHS.policy, text, expectedHash: xml.hash }), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
    assert.deepEqual(operations, [{ op: 'set', path: ['environmentName'], value: '\ud800' }]);
    assert.deepEqual(sourceSnapshot(f, transport), originals);
    assert.deepEqual(mutationRequests(f, transport), mutations);
    assert.deepEqual((await f.service.history()).transactions, []);
    if (transport === 'Local') assert.deepEqual(f.trace.filter((entry) => entry.method !== 'GET'), []);
  });
}

for (const sourceTransport of ['Local', 'GitHub']) for (const targetTransport of ['Local', 'GitHub']) {
  for (const targetBom of [false, true]) {
    test(`L2 parameter copy: ${sourceTransport} to ${targetTransport} retains ${targetBom ? 'BOM' : 'no BOM'}, ordered names, bytes and request accounting`, async (t) => {
      const sourceText = main.replace("'dev'", "'source-copy'").replace("'westeurope'", "'eastus'");
      const sourceBytes = encode(`${targetBom ? '' : '\uFEFF'}${sourceText}`);
      const targetText = main.replace("'dev'", "'target'").replace('// keep', '// target-owned');
      const targetBytes = encode(`${targetBom ? '\uFEFF' : ''}${targetText}`);
      const expectedText = targetText.replace("'target'", "'source-copy'").replace("'westeurope'", "'eastus'");
      const expectedBytes = encode(`${targetBom ? '\uFEFF' : ''}${expectedText}`);
      const source = await fixture(t, sourceTransport, { [MAIN]: sourceBytes }, false, 'l2-copy-source');
      const target = await fixture(t, targetTransport, { [MAIN]: targetBytes }, false, 'l2-copy-target');
      source.service.registry = { listEnvironments: async () => [source.environment, target.environment], getHandle: async () => null };
      source.service.createProvider = async (environment) => environment.id === target.environment.id ? target.provider : source.provider;
      source.service.coordinator = target.coordinator;
      const originals = sourceSnapshot(source, sourceTransport), destinations = sourceSnapshot(target, targetTransport);
      const sourceMutations = mutationRequests(source, sourceTransport), targetMutations = mutationRequests(target, targetTransport);
      const validate = t.mock.method(target.coordinator, 'validateRequest');
      const commit = t.mock.method(target.coordinator, 'commit');
      const loaded = await source.provider.read(MAIN);
      const selection = ['location', 'apimSku', 'environmentName', 'location'];
      const preview = await source.service.previewCopy(target.environment.id, MAIN, selection, loaded.hash);
      assert.deepEqual(preview, {
        before: targetText, after: expectedText, changed: true, selected: ['environmentName', 'location'],
        sourceHash: loaded.hash, targetHash: await sha256(targetBytes),
        targetLabel: target.environment.label, targetAlias: MAIN, bom: targetBom,
      });
      assert.deepEqual(sourceSnapshot(source, sourceTransport), originals);
      assert.deepEqual(sourceSnapshot(target, targetTransport), destinations);
      assert.deepEqual(mutationRequests(source, sourceTransport), sourceMutations);
      assert.deepEqual(mutationRequests(target, targetTransport), targetMutations);
      assert.equal(commit.mock.callCount(), 0);
      assert.equal(validate.mock.callCount(), 1);
      const [previewFiles, previewOptions] = validate.mock.calls[0].arguments;
      assert.deepEqual(previewFiles, [{ alias: MAIN, beforeHash: preview.targetHash, after: expectedBytes }]);
      assert.equal(previewOptions.context.provider, target.provider);
      assert.equal(previewOptions.context.environment, target.environment);
      assert.equal(previewOptions.action, 'environment-copy');

      const result = await source.service.copyParameters(target.environment.id, MAIN, selection, preview.sourceHash, preview.targetHash);
      assert.equal(result.outcome, 'applied');
      assert.equal(commit.mock.callCount(), 1);
      const [commitFiles, commitOptions] = commit.mock.calls[0].arguments;
      assert.deepEqual(commitFiles, [{
        alias: MAIN, before: targetBytes, beforeHash: preview.targetHash, after: expectedBytes,
        changed: ['environmentName', 'location'],
      }]);
      assert.equal(commitOptions.context.provider, target.provider);
      assert.equal(commitOptions.context.environment, target.environment);
      assert.equal(commitOptions.action, 'environment-copy');
      assert.deepEqual(await target.raw(MAIN), expectedBytes);
      assert.deepEqual(sourceSnapshot(target, targetTransport), { ...destinations, [MAIN]: expectedBytes });
      assert.deepEqual(sourceSnapshot(source, sourceTransport), originals);
      assert.deepEqual(mutationRequests(source, sourceTransport), sourceMutations);
      if (targetTransport === 'Local') {
        assert.deepEqual(await localBackup(target, result.transactionId), targetBytes);
        assert.equal(target.trace.filter((entry) => entry.action === 'prepare').length, 1);
      } else {
        const submissions = target.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/commits'));
        assert.equal(submissions.length, 1);
        const budget = await validate.mock.calls[0].result;
        assert.equal(budget.limit, 12582912);
        assert.equal(Buffer.byteLength(submissions[0].body), budget.encodedBytes);
        const body = JSON.parse(submissions[0].body);
        assert.equal(body.action, 'environment-copy');
        assert.equal(body.files.length, 1);
        assert.equal(body.files[0].beforeHash, preview.targetHash);
        assert.deepEqual(Buffer.from(body.files[0].after, 'base64'), Buffer.from(expectedBytes));
        const parent = target.github.commits.get(result.commit).parents[0];
        const entry = target.github.treeOf(parent).find((file) => file.path === MAIN);
        assert.deepEqual(Buffer.from(target.github.blobs.get(entry.sha), 'base64'), Buffer.from(targetBytes));
      }
      await target.service.restoreTransaction(result.commit || result.transactionId);
      assert.deepEqual(sourceSnapshot(target, targetTransport), destinations);
      assert.deepEqual(sourceSnapshot(source, sourceTransport), originals);
    });
  }
}

test('source fidelity: Local overwrite backs up exact external encoding and retains its BOM', async (t) => {
  const f = await fixture(t, 'Local', { [MAIN]: main });
  const loaded = await f.service.deployment(MAIN);
  const external = encode(`\uFEFF${main.replace('// keep', '// external')}`);
  (await f.provider.fileHandle(MAIN)).change(external);
  const review = await f.service.prepareLocalOverwrite(loaded, [{ op: 'set', path: ['environmentName'], value: 'replacement' }]);
  const result = await f.service.saveLocalOverwrite(review);
  assert.equal(review.bom, true);
  assert.deepEqual(encodeSourceText(review.before, review), external);
  assert.deepEqual(await localBackup(f, result.archived), external);
  assert.deepEqual(await f.raw(MAIN), encode(`\uFEFF${main.replace("'dev'", "'replacement'")}`));
  await f.service.restoreTransaction(result.archived);
  assert.deepEqual(await f.raw(MAIN), external);
});

test('source fidelity: Local policy overwrite previews preserve current external BOM and restore exact external bytes', async (t) => {
  const f = await fixture(t, 'Local', { [ACCESS_PATHS.policy]: policy });
  const loaded = { path: ACCESS_PATHS.policy, ...await f.provider.read(ACCESS_PATHS.policy) };
  const external = encode(`\uFEFF${policy.replace(comment, 'External untouched bytes')}`);
  (await f.provider.fileHandle(ACCESS_PATHS.policy)).change(external);
  const review = await f.service.prepareLocalPolicyOverwrite(loaded, { variables: { jwtRequired: true } }, null);
  assert.equal(review.bom, true);
  assert.deepEqual(encodeSourceText(review.before, review), external);
  const result = await f.service.saveLocalOverwrite(review);
  assert.deepEqual(await localBackup(f, result.archived), external);
  assert.deepEqual(await f.raw(ACCESS_PATHS.policy), encode(`\uFEFF${policy.replace('value="false"', 'value="true"')}`));
  await f.service.restoreTransaction(result.archived);
  assert.deepEqual(await f.raw(ACCESS_PATHS.policy), external);
  const invalid = new Uint8Array([...external, 0xff]);
  (await f.provider.fileHandle(ACCESS_PATHS.policy)).change(invalid);
  const mutations = mutationRequests(f, 'Local'), history = await f.store.history(f.environment.id);
  await assert.rejects(f.service.prepareLocalPolicyOverwrite(loaded, {}, null), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
  assert.deepEqual(await f.raw(ACCESS_PATHS.policy), invalid);
  assert.deepEqual(mutationRequests(f, 'Local'), mutations);
  assert.deepEqual(await f.store.history(f.environment.id), history);
});

test('C1 Git source fidelity: Local native admission still refuses BOM, whole-file sensitivity and parser size before unrelated edits', async (t) => {
  const configuration = nativeConfiguration(['llm']), alias = configuration.units[0].valueAlias;
  const f = await nativeLocalFixture({ configuration });
  t.after(f.close);
  const loaded = await f.service.deployment(alias), handle = await f.provider.fileHandle(alias);
  const rejectedSources = [
    { bytes: encode(`\uFEFF${NATIVE_FILES[alias]}`), code: 'NATIVE_SYNTAX', message: /BOM files are read-only/ },
    { bytes: encode(NATIVE_FILES[alias].replace('secret_value = null', 'secret_value = "synthetic-sensitive-marker"')),
      code: 'NATIVE_SENSITIVE_FILE', message: /sensitive/i },
    { bytes: encode(`#${' '.repeat(512 * 1024)}\n${NATIVE_FILES[alias]}`), code: 'NATIVE_LIMIT', message: /512 KiB/ },
  ];
  for (const { bytes, code, message } of rejectedSources) {
    assert.doesNotThrow(() => decodeSourceBytes(bytes), 'Reversible UTF-8 is not native whole-file admission.');
    handle.change(bytes);
    const mutations = mutationRequests(f, 'Local'), originals = sourceSnapshot(f, 'Local');
    const refuses = (error) => error.code === code && message.test(error.message);
    await assert.rejects(f.provider.read(alias), refuses);
    await assert.rejects(f.service.preview(alias, [{ op: 'set', path: ['apim_name'], value: 'unrelated' }], loaded.hash, loaded.nativeIdentity), refuses);
    await assert.rejects(f.service.save(alias, [{ op: 'set', path: ['apim_name'], value: 'unrelated' }], loaded.hash, loaded.nativeIdentity), refuses);
    assert.deepEqual(sourceSnapshot(f, 'Local'), originals);
    assert.deepEqual(mutationRequests(f, 'Local'), mutations);
  }
  assert.deepEqual(await f.store.history(f.environment.id), []);
  assert.deepEqual(f.trace.filter((entry) => entry.method !== 'GET'), []);
});
