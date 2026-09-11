import assert from 'node:assert/strict';
import test from 'node:test';
import { TransactionStore } from '../server/transactions.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { MigrationDonor } from '../web/js/migration-donor.mjs';
import { MigrationSession } from '../web/js/migration-session.mjs';
import { ACCESS_PATHS, citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';
import { CURRENT, SCHEMA, TARGET, TEMPLATE, LEGACY, folderFromFiles } from './_migration-fixture.mjs';

const edit = (name, value) => ({ op: 'set', path: [name], value });
const encode = (text) => new TextEncoder().encode(text);

async function fixture(t, operation = 'parameter') {
  const files = operation === 'migration'
    ? { [TARGET]: CURRENT, [TEMPLATE]: SCHEMA }
    : Object.fromEntries(Object.entries(citadelRepositoryFiles()).filter(([, value]) => typeof value === 'string'));
  const f = await nativeLocalFixture({ configuration: createConfiguration('bicep'), onlyFiles: files });
  t.after(f.close);
  return f;
}

async function prepareOperation(f, operation, t) {
  if (operation === 'parameter') {
    const document = await f.service.deployment(TARGET);
    return () => f.service.save(TARGET, [edit('environmentName', 'receipt-parameter')], document.hash);
  }
  if (operation === 'policy') {
    const source = await f.provider.read(ACCESS_PATHS.policy);
    return () => f.service.savePolicy({
      path: ACCESS_PATHS.policy, expectedHash: source.hash,
      text: '<policies><inbound><!-- reviewed policy --><base /></inbound></policies>\n',
    });
  }
  if (operation === 'creation') return () => f.service.createContract({ name: 'receipt-creation' });
  if (operation === 'restore') {
    const document = await f.service.deployment(TARGET);
    const saved = await f.service.save(TARGET, [edit('environmentName', 'prior-save')], document.hash);
    return () => f.service.restoreTransaction(saved.archived);
  }
  if (operation === 'copy') {
    const target = await nativeLocalFixture({
      configuration: f.configuration, environmentId: 'receipt-copy-target',
      onlyFiles: Object.fromEntries(Object.entries(citadelRepositoryFiles()).filter(([, value]) => typeof value === 'string')),
    });
    t.after(target.close);
    f.environments.set(target.environment.id, target.environment);
    f.service.registry = { listEnvironments: async () => [target.environment], getHandle: async () => target.root };
    f.service.createProvider = async () => target.provider;
    const source = await f.provider.read(TARGET);
    (await f.provider.fileHandle(TARGET)).change(source.text.replace("environmentName = 'dev'", "environmentName = 'copy-me'"));
    const comparison = await f.service.compareEnvironment(target.environment.id, TARGET);
    return () => f.service.copyParameters(target.environment.id, TARGET, ['environmentName'],
      comparison.source.hash, comparison.destination.hash);
  }
  const session = new MigrationSession({
    contextProvider: () => f.context, registry: { getDraft: async () => null }, coordinator: f.coordinator,
  });
  const donor = new MigrationDonor({ folder: folderFromFiles('receipt-donor', { 'main.bicepparam': LEGACY }) });
  const view = await session.plan({ donor, sourceIds: ['main.bicepparam'], targetAlias: TARGET });
  const row = view.rows.find((item) => item.name === 'Count');
  session.decide(row.id, { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true });
  session.keepRemaining();
  const review = await session.preview();
  return () => session.apply(review.id, { reviewed: true });
}

for (const operation of ['parameter', 'policy', 'creation', 'copy', 'migration', 'restore']) {
  for (const interruption of ['after-commit-manifest', 'lost-response']) {
    test(`Local receipt outcome: ${operation} retains committed bytes after ${interruption}`, async (t) => {
      const f = await fixture(t, operation);
      const run = await prepareOperation(f, operation, t);
      let planned, context;
      const commit = f.coordinator.commit.bind(f.coordinator);
      f.coordinator.commit = (files, options) => {
        planned = files;
        context = options.context;
        return commit(files, options);
      };
      if (interruption === 'after-commit-manifest') {
        f.store.faultInjector = async (point) => {
          if (point === interruption) throw new Error('Synthetic fault after durable commit');
        };
      } else {
        const receipt = f.store.commitReceipt.bind(f.store);
        f.store.commitReceipt = async (...args) => {
          await receipt(...args);
          throw new Error('Synthetic lost receipt response');
        };
      }
      f.trace.length = 0;
      const result = await run();
      assert.ok(result.warnings.some((warning) => warning.includes('committed journal')));
      const id = result.transactionId || result.archived;
      const row = await f.store.getTransaction(context.environment.id, id);
      assert.equal(row.status, 'committed');
      assert.equal(row.recoveryRequired, false);
      for (const file of planned) {
        assert.deepEqual((await context.provider.read(file.alias)).bytes, new Uint8Array(file.after));
        assert.equal(row.files.find((entry) => entry.alias === file.alias).receiptVerified, true);
      }
      assert.equal(f.trace.some((entry) => ['rollback', 'fail'].includes(entry.action)), false);
      const restarted = new TransactionStore({ dataRoot: f.dataRoot, getEnvironment: async (env) => f.environments.get(env) });
      await restarted.initialize();
      const persisted = await restarted.getTransaction(context.environment.id, id);
      assert.equal(persisted.status, 'committed');
      assert.equal(persisted.auditRecorded, true);
      assert.ok((await restarted.history(context.environment.id)).some((entry) => entry.transactionId === id));
    });
  }
}

test('Local receipt outcome: an unconfirmed receipt retains bytes and records explicit recovery', async (t) => {
  const f = await fixture(t);
  const run = await prepareOperation(f, 'parameter', t);
  f.hooks.request = (path) => {
    if (path.endsWith('/receipt')) throw new Error('Synthetic unavailable receipt');
  };
  await assert.rejects(run(), { code: 'LOCAL_RECOVERY_REQUIRED', recoveryRequired: true, applied: null });
  const [row] = await f.store.history(f.environment.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.recoveryRequired, true);
  assert.match((await f.provider.read(TARGET)).text, /receipt-parameter/);
  assert.equal(f.trace.some((entry) => entry.action === 'rollback'), false);
});

for (const point of ['first-inspection', 'recovery-and-inspection']) {
  test(`Local receipt outcome: ${point} failure never falls through to source rollback`, async (t) => {
    const f = await fixture(t);
    const run = await prepareOperation(f, 'parameter', t);
    let inspections = 0;
    f.hooks.request = (path, init) => {
      if (path.endsWith('/receipt')) throw new Error('Synthetic receipt failure');
      if (path.endsWith('/fail')) throw new Error('Synthetic terminal failure');
      if (!init.method) {
        inspections += 1;
        if (point === 'first-inspection' || inspections === 2) throw new Error('Synthetic inspection failure');
      }
    };
    await assert.rejects(run(), (error) => {
      assert.equal(error.code, 'LOCAL_RECOVERY_REQUIRED');
      assert.match(error.message, /Source bytes were retained/);
      assert.match(error.message, /Synthetic inspection failure/);
      if (point === 'recovery-and-inspection') assert.match(error.message, /Synthetic terminal failure/);
      return true;
    });
    assert.match((await f.provider.read(TARGET)).text, /receipt-parameter/);
    assert.equal((await f.store.history(f.environment.id))[0].status, 'committing');
    assert.equal(f.trace.some((entry) => entry.action === 'rollback'), false);
  });
}

for (const phase of ['before-write', 'partial-write', 'foreign-write']) {
  test(`Local receipt outcome: ${phase} terminal-record failures are surfaced without unsafe rollback`, async (t) => {
    const f = await fixture(t);
    const one = await f.provider.read(TARGET), two = await f.provider.read(ACCESS_PATHS.policy);
    const next = encode(`${one.text}\n// reviewed change\n`);
    const write = f.provider.write.bind(f.provider);
    f.provider.write = async (alias, bytes, options) => {
      if (alias === two.alias) {
        if (phase === 'foreign-write') (await f.provider.fileHandle(one.alias)).change('// external bytes\n');
        throw new Error('Synthetic write failure');
      }
      return write(alias, bytes, options);
    };
    f.hooks.request = (path, init) => {
      if (phase === 'before-write' && path.includes('/backups/') && init.method === 'PUT') throw new Error('Synthetic backup failure');
      if (path.endsWith('/rollback') || path.endsWith('/fail')) throw new Error('Synthetic terminal record rejected');
    };
    await assert.rejects(f.coordinator.commit([
      { alias: one.alias, before: one.bytes, beforeHash: one.hash, after: next },
      { alias: two.alias, before: two.bytes, beforeHash: two.hash, after: encode(`${two.text}\n`) },
    ], { action: 'parameter-edit', context: f.context }), (error) => {
      assert.equal(error.code, 'LOCAL_RECOVERY_REQUIRED');
      assert.match(error.message, /Synthetic (?:backup|write) failure/);
      assert.match(error.message, /Synthetic terminal record rejected/);
      assert.match(error.message, /Inspect History/);
      return true;
    });
    assert.deepEqual((await f.provider.read(two.alias)).bytes, two.bytes);
    assert.deepEqual((await f.provider.read(one.alias)).bytes, phase === 'foreign-write' ? encode('// external bytes\n') : one.bytes);
  });
}
