import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { exactNumber, parseNativeValues } from '../shared/terraform/parser.mjs';
import { nativeTransactionProof } from '../shared/terraform/review.mjs';
import { TransactionStore } from '../server/transactions.mjs';
import { BrowserDirectoryProvider } from '../web/js/directory-provider.mjs';
import { nativeLocalFixture, nativeConfiguration, NATIVE_FILES } from './_native-fixture.mjs';

const edit = (path, value) => ({ op: 'set', path, value });
async function saved(fixture, alias, operations) {
  const document = await fixture.service.deployment(alias);
  const preview = await fixture.service.preview(alias, operations, document.hash, document.nativeIdentity);
  const result = await fixture.service.save(alias, operations, document.hash, document.nativeIdentity);
  assert.equal((await fixture.provider.read(alias)).text, preview.after);
  return { document, preview, result };
}

for (const area of ['llm', 'access']) test(`Local ${area} unit works alone without a Bicep workspace or Deployment root`, async (t) => {
  const configuration = nativeConfiguration([area]), unit = configuration.units[0];
  const f = await nativeLocalFixture({ configuration,
    onlyFiles: Object.fromEntries(Object.entries(NATIVE_FILES).filter(([alias]) => alias.startsWith(`${unit.rootAlias}/`))) });
  t.after(f.close);
  assert.equal((await f.service.focus()).areas.length, 1);
  const path = area === 'llm' ? ['llm_backend_config', 0, 'backend_id'] : ['services', 0, 'code'];
  await saved(f, unit.valueAlias, [edit(path, 'standalone-native')]);
  await assert.rejects(f.provider.read('variables.tf'), { code: 'NATIVE_SOURCE_SCOPE' });
  await assert.rejects(f.provider.readSubscriptionId('development'), /not available for native Terraform/);
  await assert.rejects(f.provider.writeSubscriptionId('development', '11111111-2222-4333-8444-555555555555', null), /not available for native Terraform/);
  assert.equal(f.root.owner.trace.some((entry) => entry.path.startsWith('.azure')), false);
});

test('native Local inventory is metadata, not a capability to read an unselected values file', async (t) => {
  const f = await nativeLocalFixture();
  t.after(f.close);
  const inventory = new BrowserDirectoryProvider(f.root, { nativeInventory: true });
  assert.ok((await inventory.entries()).some((entry) => entry.alias === 'environments/development.tfvars'));
  await assert.rejects(inventory.read('environments/development.tfvars'), /Select a nonsecret operator file/);
  await assert.rejects(inventory.write('variables.tf', new Uint8Array()), /only reads known schema dependencies/);
  assert.equal((await inventory.read('variables.tf')).text, NATIVE_FILES['variables.tf']);
});

test('native Local loads first, uses own schemas and journals source-preserving saves in all areas', async (t) => {
  const f = await nativeLocalFixture();
  t.after(f.close);
  assert.equal((await f.service.focus()).areas.length, 3);
  const deployment = await saved(f, 'environments/development.tfvars', [edit(['environment_name'], 'changed'), edit(['enabled'], false), edit(['ratio'], exactNumber('0.9007199254740993123456789'))]);
  assert.match(deployment.preview.after, /# keep this comment/);
  assert.doesNotMatch(deployment.preview.after, /^optional_note\s*=/m);
  await saved(f, 'llm-backend-onboarding/operator.tfvars', [edit(['llm_backend_config', 0, 'supported_models', 0, 'capacity'], exactNumber('12.5'))]);
  const xml = '<policies><inbound><set-variable name="example" value="${literal}" /></inbound></policies>';
  await saved(f, 'citadel-access-contracts/operator.tfvars', [edit(['services', 0, 'code'], 'chat-two'), edit(['services', 0, 'policy_xml'], xml)]);
  assert.equal(parseNativeValues((await f.provider.read('citadel-access-contracts/operator.tfvars')).text).value.services[0].policy_xml, xml);
  for (const [alias, original] of Object.entries(NATIVE_FILES)) {
    if (!alias.endsWith('.tfvars')) assert.equal((await f.provider.read(alias)).text, original);
  }
  const history = await f.coordinator.history();
  assert.equal(history.transactions.length, 3);
  assert.ok(history.transactions.every((entry) => entry.status === 'committed' && entry.nativeProof && entry.files.every((file) => file.backupVerified)));
  await f.coordinator.revert(deployment.result.archived);
  assert.equal((await f.provider.read('environments/development.tfvars')).text, NATIVE_FILES['environments/development.tfvars']);
});

for (const syntax of ['hcl-tfvars', 'json-tfvars']) test(`native absent ${syntax} needs explicit creation and supports scoped creation undo`, async (t) => {
  const valueAlias = `environments/new.tfvars${syntax === 'json-tfvars' ? '.json' : ''}`;
  const f = await nativeLocalFixture({ configuration: nativeConfiguration([{ area: 'deployment', valueAlias, syntax, allowCreate: true }]) });
  t.after(f.close);
  const { document, result } = await saved(f, valueAlias, [edit(['environment_name'], 'created')]);
  assert.equal(document.hash, null);
  assert.equal(document.absent, true);
  assert.equal((await f.store.getTransaction(f.environment.id, result.archived)).files[0].existed, false);
  await f.coordinator.revert(result.archived);
  await assert.rejects(f.provider.read(valueAlias), { name: 'NotFoundError' });
});

test('native approval rejects changed values, schema, policy and new files without source writes', async (t) => {
  const f = await nativeLocalFixture();
  t.after(f.close);
  const alias = 'citadel-access-contracts/operator.tfvars';
  for (const changedAlias of [alias, 'citadel-access-contracts/variables.tf', 'citadel-access-contracts/policies/default-ai-product-policy.xml']) {
    const document = await f.service.deployment(alias);
    const file = await f.provider.fileHandle(changedAlias);
    const original = (await f.provider.read(changedAlias)).text;
    file.change(original + '\n');
    await assert.rejects(f.service.save(alias, [edit(['product_terms'], 'new')], document.hash, document.nativeIdentity), { code: 'NATIVE_REVIEW_STALE' });
    file.change(original);
  }
  assert.equal((await f.store.history(f.environment.id)).length, 0);
  assert.equal(f.root.owner.trace.filter((entry) => entry.operation === 'write').length, 0);
});

test('native receipt interruption retains source bytes for scoped recovery without bypassing backups', async (t) => {
  const f = await nativeLocalFixture();
  t.after(f.close);
  const alias = 'environments/development.tfvars', document = await f.service.deployment(alias);
  f.hooks.request = (path) => { if (path.endsWith('/receipt')) throw new Error('Synthetic receipt interruption'); };
  await assert.rejects(f.service.save(alias, [edit(['environment_name'], 'pending-receipt')], document.hash, document.nativeIdentity), /receipt.*not confirmed/i);
  const transaction = (await f.store.history(f.environment.id))[0];
  assert.equal(transaction.status, 'failed');
  assert.notEqual((await f.provider.read(alias)).text, document.text);
  f.hooks.request = null;
  await f.coordinator.recover(transaction.transactionId, 'rollback');
  assert.equal((await f.provider.read(alias)).text, document.text);
  assert.equal((await f.store.history(f.environment.id))[0].status, 'rolled_back');
  assert.ok(f.trace.findIndex((entry) => entry.action === 'backups') < f.trace.findIndex((entry) => entry.action === 'committing'));
});

test('native staged create failure removes only its unchanged unpublished empty file', async (t) => {
  const alias = 'environments/new.tfvars.json';
  const f = await nativeLocalFixture({ configuration: nativeConfiguration([{ area: 'deployment', valueAlias: alias, syntax: 'json-tfvars', allowCreate: true }]) });
  t.after(f.close);
  const document = await f.service.deployment(alias);
  let failed = false;
  f.root.owner.before = ({ operation }) => { if (!failed && operation === 'write') { failed = true; throw new Error('Synthetic staged failure'); } };
  await assert.rejects(f.service.save(alias, [edit(['environment_name'], 'not-published')], document.hash, document.nativeIdentity), /Synthetic staged failure/);
  await assert.rejects(f.provider.read(alias), { name: 'NotFoundError' });
  assert.equal((await f.store.history(f.environment.id))[0].status, 'rolled_back');
});

test('detected native creation collision is never adopted or undone, even with identical proposed bytes', async (t) => {
  const alias = 'environments/new.tfvars';
  const f = await nativeLocalFixture({ configuration: nativeConfiguration([{ area: 'deployment', valueAlias: alias, allowCreate: true }]) });
  t.after(f.close);
  const document = await f.service.deployment(alias), operations = [edit(['environment_name'], 'same-proposed-value')];
  const proposed = (await f.service.preview(alias, operations, null, document.nativeIdentity)).after;
  f.root.owner.before = ({ operation, path }) => {
    if (operation === 'createFile' && path === alias) {
      f.root.owner.before = null;
      f.root.put(alias, proposed);
    }
  };
  await assert.rejects(f.service.save(alias, operations, null, document.nativeIdentity), /Recovery still requires/);
  assert.equal((await f.provider.read(alias)).text, proposed);
  assert.equal(f.root.owner.trace.some((entry) => entry.operation === 'write' || entry.operation === 'removeEntry'), false);
  const transaction = (await f.coordinator.history()).transactions[0];
  assert.equal((await f.coordinator.inspect(transaction.transactionId)).canComplete, false);
  await assert.rejects(f.coordinator.recover(transaction.transactionId, 'complete'), /unconfirmed/);
  await assert.rejects(f.coordinator.recover(transaction.transactionId, 'rollback'), /will not remove/);
  const tokens = await f.store.recover(f.environment.id, transaction.transactionId);
  await assert.rejects(f.store.commitReceipt(f.environment.id, transaction.transactionId, tokens.authorizationToken, {
    receipts: [{ alias, hash: transaction.files[0].finalHash, size: transaction.files[0].finalSize }],
  }), { code: 'NATIVE_CREATION_UNCONFIRMED' });
  const directory = await f.root.getDirectoryHandle('environments');
  const foreign = directory.children.get('new.tfvars');
  directory.children.set('foreign-kept.tfvars', foreign);
  directory.children.delete('new.tfvars');
  await f.coordinator.recover(transaction.transactionId, 'rollback');
  assert.equal(new TextDecoder().decode(foreign.bytes), proposed);
  await saved(f, alias, operations);
  assert.equal((await f.provider.read(alias)).text, proposed);
});

test('post-close native failure keeps a real recovery record; foreign bytes are never restored over', async (t) => {
  for (const foreign of [false, true]) {
    const f = await nativeLocalFixture({ configuration: nativeConfiguration(['deployment']) });
    t.after(f.close);
    const alias = 'environments/development.tfvars', document = await f.service.deployment(alias);
    const operations = [edit(['environment_name'], 'published-before-failure')];
    const proposed = (await f.service.preview(alias, operations, document.hash, document.nativeIdentity)).after;
    const external = 'environment_name = "external-after-close"\n';
    f.root.owner.afterClose = (handle) => {
      f.root.owner.afterClose = null;
      if (foreign) handle.change(external);
      else throw new Error('Synthetic post-close interruption');
    };
    await assert.rejects(f.service.save(alias, operations, document.hash, document.nativeIdentity), /Recovery still requires/);
    const transaction = (await f.coordinator.history()).transactions[0];
    assert.equal(transaction.recoveryRequired, true);
    if (foreign) {
      await assert.rejects(f.coordinator.recover(transaction.transactionId, 'rollback'), /foreign/);
      assert.equal((await f.provider.read(alias)).text, external);
    } else {
      await f.coordinator.recover(transaction.transactionId, 'complete');
      assert.equal((await f.store.getTransaction(f.environment.id, transaction.transactionId)).status, 'committed');
      assert.equal((await f.provider.read(alias)).text, proposed);
    }
  }
});

test('native recovery remains read-only while reviewed schema or policy dependencies have changed', async (t) => {
  const f = await nativeLocalFixture({ configuration: nativeConfiguration(['deployment']) });
  t.after(f.close);
  const alias = 'environments/development.tfvars', document = await f.service.deployment(alias);
  const schema = await f.provider.fileHandle('variables.tf'), original = (await f.provider.read('variables.tf')).text;
  f.root.owner.afterClose = () => { f.root.owner.afterClose = null; schema.change(original + '\n'); };
  f.hooks.request = (path) => { if (path.endsWith('/receipt')) throw new Error('Synthetic lost receipt'); };
  await assert.rejects(f.service.save(alias, [edit(['environment_name'], 'retained')], document.hash, document.nativeIdentity), /receipt.*not confirmed/i);
  f.hooks.request = null;
  const transaction = (await f.coordinator.history()).transactions[0], current = (await f.provider.read(alias)).text;
  await assert.rejects(f.coordinator.recover(transaction.transactionId, 'rollback'), { code: 'NATIVE_HISTORY_STALE' });
  assert.equal((await f.provider.read(alias)).text, current);
  schema.change(original);
  await f.coordinator.recover(transaction.transactionId, 'rollback');
  assert.equal((await f.provider.read(alias)).text, document.text);
});

test('lost native receipt response reconciles a persisted commit instead of undoing it; restart preserves scope', async (t) => {
  const f = await nativeLocalFixture({ configuration: nativeConfiguration(['deployment']) });
  t.after(f.close);
  const alias = 'environments/development.tfvars', document = await f.service.deployment(alias);
  f.store.faultInjector = async (phase) => {
    if (phase === 'after-commit-manifest') throw new Error('Synthetic response lost after commit');
  };
  const result = await f.service.save(alias, [edit(['environment_name'], 'committed-once')], document.hash, document.nativeIdentity);
  assert.ok(result.warnings.some((warning) => warning.includes('committed journal')));
  assert.equal((await f.coordinator.history()).transactions.length, 1);
  const restarted = new TransactionStore({ dataRoot: f.dataRoot, getEnvironment: async (id) => f.environments.get(id) });
  await restarted.initialize();
  assert.equal((await restarted.getTransaction(f.environment.id, result.archived)).status, 'committed');
  assert.match((await f.provider.read(alias)).text, /committed-once/);
  await assert.rejects(restarted.getTransaction('another-workspace', result.archived), /not found/i);
});

test('known-sensitive whole files cannot be read, changed, backed up or exposed through native history', async (t) => {
  const f = await nativeLocalFixture();
  t.after(f.close);
  const alias = 'llm-backend-onboarding/operator.tfvars';
  const document = await f.service.deployment(alias);
  const secret = document.text.replace('secret_value = null', 'secret_value = "synthetic-sensitive-marker"');
  (await f.provider.fileHandle(alias)).change(secret);
  await assert.rejects(f.provider.read(alias), { code: 'NATIVE_SENSITIVE_FILE' });
  await assert.rejects(f.service.save(alias, [edit(['apim_name'], 'unrelated')], document.hash, document.nativeIdentity), { code: 'NATIVE_SENSITIVE_FILE' });
  const bytes = Buffer.from(secret);
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const prepared = await f.store.prepare({ environmentId: f.environment.id, targetId: f.context.projectId, targetLabel: 'parameter-edit',
    nativeProof: nativeTransactionProof(f.configuration, document), changedAliases: [alias],
    files: [{ alias, existed: true, hash, size: bytes.length }] });
  await assert.rejects(f.store.uploadBackup(f.environment.id, prepared.transaction.transactionId, prepared.transaction.files[0].id,
    prepared.transactionToken, hash, bytes), { code: 'NATIVE_SENSITIVE_FILE' });
  for (const candidate of ['terraform.tfstate.tfvars', 'environments/plan.tfvars', '.terraform/terraform.tfvars', 'environments/other.tfvars', 'main.tf']) {
    await assert.rejects(f.provider.write(candidate, new TextEncoder().encode('name = "blocked"')), /scope|Only|State|excluded|unsafe/i);
  }
  const journal = JSON.stringify(await f.store.getTransaction(f.environment.id, prepared.transaction.transactionId));
  assert.ok(!journal.includes('synthetic-sensitive-marker'));
  await assert.rejects(readdir(join(f.dataRoot, 'environments', f.environment.id, 'transactions', prepared.transaction.transactionId, 'files')), { code: 'ENOENT' });
});

test('native history refuses retargeted identities, changed dependencies and foreign current bytes', async (t) => {
  const f = await nativeLocalFixture();
  t.after(f.close);
  const alias = 'environments/development.tfvars';
  const { result } = await saved(f, alias, [edit(['environment_name'], 'saved')]);
  const schema = await f.provider.fileHandle('variables.tf');
  schema.change(NATIVE_FILES['variables.tf'] + '\n');
  await assert.rejects(f.coordinator.revert(result.archived), { code: 'NATIVE_HISTORY_STALE' });
  schema.change(NATIVE_FILES['variables.tf']);
  (await f.provider.fileHandle(alias)).change('environment_name = "foreign"\n');
  await assert.rejects(f.coordinator.revert(result.archived), /no longer matches/);
  const different = nativeConfiguration(['deployment']);
  f.environments.set(f.environment.id, { ...f.environment, configuration: different });
  await assert.rejects(f.store.getTransaction(f.environment.id, result.archived), { code: 'CONFIGURATION_RETARGET' });
  const bytes = await readFile(f.store.manifestPath(f.environment.id, result.archived), 'utf8');
  assert.ok(bytes.includes(f.configuration.profileId));
});
