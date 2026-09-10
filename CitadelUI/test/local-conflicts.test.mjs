import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { nativeLocalFixture, nativeConfiguration } from './_native-fixture.mjs';

async function fixture(format, t) {
  const f = await nativeLocalFixture(format === 'bicep'
    ? { configuration: createConfiguration('bicep'), files: citadelRepositoryFiles() }
    : { configuration: nativeConfiguration(['deployment']) });
  t.after(f.close);
  f.alias = format === 'bicep' ? 'bicep/infra/main.bicepparam' : 'environments/development.tfvars';
  f.name = format === 'bicep' ? 'resourceGroupName' : 'environment_name';
  f.document = await f.service.deployment(f.alias);
  f.operations = [{ op: 'set', path: [f.name], value: 'reviewed-replacement' }];
  f.replacement = (await f.service.preview(f.alias, f.operations, f.document.hash, f.document.nativeIdentity)).after;
  f.external = `${f.document.text}\n${format === 'bicep' ? '//' : '#'} EXTERNAL saved edit: must be in the backup\n`;
  f.file = await f.provider.fileHandle(f.alias);
  f.file.change(f.external);
  return f;
}

for (const format of ['bicep', 'terraform']) {
  test(`${format} Local conflict: Cancel preserves draft/source; confirmed overwrite backs up the external version`, async (t) => {
    const f = await fixture(format, t), originalDraft = structuredClone(f.operations);
    await assert.rejects(f.service.save(f.alias, f.operations, f.document.hash, f.document.nativeIdentity), /changed/i);
    const cancelled = await f.service.prepareLocalOverwrite(f.document, f.operations);
    assert.equal(cancelled.before, f.external);
    assert.equal(cancelled.after, f.replacement);
    assert.equal((await f.provider.read(f.alias)).text, f.external);
    assert.deepEqual(f.operations, originalDraft);
    assert.equal((await f.coordinator.history()).transactions.length, 0);
    const confirmed = await f.service.prepareLocalOverwrite(f.document, f.operations);
    const saved = await f.service.saveLocalOverwrite(confirmed);
    assert.equal((await f.provider.read(f.alias)).text, f.replacement);
    const transaction = await f.store.getTransaction(f.environment.id, saved.archived);
    const backup = await readFile(join(f.dataRoot, 'environments', f.environment.id, 'transactions',
      saved.archived, 'files', `${transaction.files[0].id}.backup`), 'utf8');
    assert.equal(backup, f.external);
    await f.coordinator.revert(saved.archived);
    assert.equal((await f.provider.read(f.alias)).text, f.external);
    await assert.rejects(f.service.saveLocalOverwrite(confirmed), /already attempted/);
  });

  test(`${format} Local overwrite stops when backup fails or the file changes again after confirmation`, async (t) => {
    const f = await fixture(format, t);
    const first = await f.service.prepareLocalOverwrite(f.document, f.operations);
    f.file.change(f.external + '\n');
    await assert.rejects(f.service.saveLocalOverwrite(first), /changed/i);
    assert.equal((await f.coordinator.history()).transactions.length, 0);
    const second = await f.service.prepareLocalOverwrite(f.document, f.operations);
    f.hooks.request = (path, request) => {
      if (path.includes('/backups/') && request.method === 'PUT') throw new Error('Synthetic failed backup');
    };
    await assert.rejects(f.service.saveLocalOverwrite(second), /Synthetic failed backup/);
    assert.equal((await f.provider.read(f.alias)).text, f.external + '\n');
    assert.equal(f.root.owner.trace.some((entry) => entry.operation === 'write'), false);
  });
}

test('native Local overwrite preserves schema/secret/creation gates and never changes the newly active context', async (t) => {
  const f = await fixture('terraform', t);
  const other = await nativeLocalFixture({ environmentId: 'other-local', configuration: nativeConfiguration(['deployment']) });
  t.after(other.close);
  const otherBefore = (await other.provider.read(f.alias)).text;
  const review = await f.service.prepareLocalOverwrite(f.document, f.operations);
  f.service.contextProvider = () => other.context;
  await f.service.saveLocalOverwrite(review);
  assert.equal((await f.provider.read(f.alias)).text, f.replacement);
  assert.equal((await other.provider.read(f.alias)).text, otherBefore);

  f.service.contextProvider = () => f.context;
  f.file.change(f.external);
  const schema = await f.provider.fileHandle('variables.tf'), originalSchema = (await f.provider.read('variables.tf')).text;
  schema.change(originalSchema + '\n');
  await assert.rejects(f.service.prepareLocalOverwrite(f.document, f.operations), { code: 'NATIVE_REVIEW_STALE' });
  schema.change(originalSchema);
  f.file.change(f.external + '\npassword = "synthetic-sensitive"\n');
  await assert.rejects(f.service.prepareLocalOverwrite(f.document, f.operations), { code: 'NATIVE_SENSITIVE_FILE' });
  await assert.rejects(f.service.prepareLocalOverwrite({ ...f.document, hash: null, absent: true }, f.operations), /already-open existing/);
  await assert.rejects(f.service.prepareLocalOverwrite(f.document, f.operations,
    { ...f.context, environment: { ...f.environment, source: { kind: 'github' } } }), /Local file/);
});

test('Local policy overwrite backs up external XML, not the stale policy originally opened', async (t) => {
  const f = await fixture('bicep', t);
  const alias = 'bicep/modules/citadel-access-contracts/contracts/test/ai-product-policy.xml';
  f.root.put(alias, '<policies><inbound /></policies>\n');
  const source = await f.provider.read(alias), loaded = { path: alias, ...source };
  const external = '<policies><inbound><!-- external edit --></inbound></policies>\n';
  (await f.provider.fileHandle(alias)).change(external);
  const replacement = '<policies><inbound><base /></inbound></policies>\n';
  const review = await f.service.prepareLocalPolicyOverwrite(loaded, null, replacement);
  const saved = await f.service.saveLocalOverwrite(review);
  assert.equal((await f.provider.read(alias)).text, replacement);
  const transaction = await f.store.getTransaction(f.environment.id, saved.archived);
  assert.equal(await readFile(join(f.dataRoot, 'environments', f.environment.id, 'transactions',
    saved.archived, 'files', `${transaction.files[0].id}.backup`), 'utf8'), external);
  await f.coordinator.revert(saved.archived);
  assert.equal((await f.provider.read(alias)).text, external);
});
