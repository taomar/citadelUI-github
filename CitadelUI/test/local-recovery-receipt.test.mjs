import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TransactionStore } from '../server/transactions.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { mutationOutcome } from '../shared/mutation-outcome.mjs';
import { LocalTransactionCoordinator } from '../web/js/mutation-coordinator.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';

const MAIN = 'bicep/infra/main.bicepparam';
const CONFIRMED_WARNING = 'The receipt response failed, but the committed journal confirms this save.';
const AUDIT_WARNING = 'The terminal audit is still pending. Inspect History before another change.';

async function recoverable(t, status = 'failed') {
  const f = await nativeLocalFixture({
    configuration: createConfiguration('bicep'),
    onlyFiles: Object.fromEntries(Object.entries(citadelRepositoryFiles()).filter(([, value]) => typeof value === 'string')),
  });
  t.after(f.close);
  const before = await f.provider.read(MAIN);
  f.hooks.request = (path) => {
    if (path.endsWith('/receipt')) throw new Error('Synthetic interrupted initial receipt');
    if (status === 'committing' && path.endsWith('/fail')) throw new Error('Synthetic interrupted failure record');
  };
  await assert.rejects(f.service.save(MAIN,
    [{ op: 'set', path: ['environmentName'], value: 'recover-final' }], before.hash),
  { code: 'LOCAL_RECOVERY_REQUIRED', recoveryRequired: true });
  f.hooks.request = null;
  if (status === 'committing') await f.store.initialize();
  const [transaction] = await f.store.history(f.environment.id);
  const current = await f.provider.read(MAIN);
  assert.equal(transaction.status, status);
  assert.equal(transaction.recoveryRequired, true);
  assert.match(current.text, /environmentName = 'recover-final'/);
  assert.notDeepEqual(current.bytes, before.bytes);
  assert.deepEqual(current.bytes, new TextEncoder().encode(before.text.replace("environmentName = 'dev'", "environmentName = 'recover-final'")));
  assert.deepEqual(f.root.owner.trace.filter((entry) => ['write', 'close', 'removeEntry'].includes(entry.operation)),
    [{ operation: 'write', path: MAIN }, { operation: 'close', path: MAIN }], 'the initial mutation published once');
  const handle = await f.provider.fileHandle(MAIN);
  const revision = handle.modified;
  const requests = [], events = [];
  const request = f.coordinator.request;
  f.coordinator.request = async function (path, init = {}) {
    const action = !init.method ? 'inspect' : path.split('/').at(-1);
    requests.push({ action, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    events.push(action);
    return request(path, init);
  };
  f.root.owner.before = ({ operation, path }) => {
    if (['write', 'close', 'removeEntry'].includes(operation)) events.push(`${operation}:${path}`);
  };
  const writes = [];
  const write = f.provider.write.bind(f.provider), remove = f.provider.remove.bind(f.provider);
  f.provider.write = async (...args) => { writes.push('write'); return write(...args); };
  f.provider.remove = async (...args) => { writes.push('remove'); return remove(...args); };
  f.trace.length = 0;
  return { ...f, id: transaction.transactionId, before: before.bytes, final: current.bytes, writes,
    requests, events, handle, revision, initial: transaction };
}

async function assertUntouched(f, tail) {
  assert.deepEqual((await f.provider.read(MAIN)).bytes, f.final);
  assert.deepEqual(f.writes, []);
  assert.equal(f.handle.modified, f.revision, 'Complete neither rewrites identical bytes nor publishes a second mutation');
  assert.equal(f.trace.some((entry) => entry.action === 'rollback'), false);
  assert.equal(f.trace.filter((entry) => entry.action === 'receipt').length, 1, 'no automatic receipt retry');
  if (tail) assert.deepEqual(f.events, ['inspect', 'recover', 'receipt', ...tail]);
  assert.deepEqual(f.requests.find((entry) => entry.action === 'recover').body, {});
  assert.deepEqual(f.requests.find((entry) => entry.action === 'receipt').body, {
    receipts: [{ alias: MAIN, hash: f.initial.files[0].finalHash, size: f.final.length }],
  });
  for (const request of f.requests.filter((entry) => entry.action === 'fail')) {
    assert.deepEqual(request.body, { changedAliases: [MAIN] });
  }
}

async function assertJournal(f, { status, auditRecorded, recoveryRequired,
  failedEvents = f.initial.status === 'failed' || status === 'failed' ? 1 : 0 }) {
  const transaction = await f.store.getTransaction(f.environment.id, f.id);
  assert.equal(transaction.status, status);
  assert.equal(transaction.auditRecorded, auditRecorded);
  assert.equal(transaction.recoveryRequired, recoveryRequired);
  assert.deepEqual(transaction.changedAliases, [MAIN]);
  assert.deepEqual(transaction.changedNames, { [MAIN]: ['environmentName'] });
  assert.equal(transaction.targetLabel, 'parameter-edit');
  assert.equal(transaction.targetId, f.context.projectId);
  assert.deepEqual(transaction.files, f.initial.files.map((file) => ({
    ...file, receiptVerified: status === 'committed',
  })));
  assert.deepEqual(new Uint8Array(await readFile(join(f.store.transactionRoot(f.environment.id, f.id),
    'files', `${transaction.files[0].id}.backup`))), f.before);
  const restarted = new TransactionStore({ dataRoot: f.dataRoot, getEnvironment: async (id) => f.environments.get(id) });
  await restarted.initialize();
  const persisted = await restarted.getTransaction(f.environment.id, f.id);
  assert.equal(persisted.status, status);
  assert.equal(persisted.recoveryRequired, status !== 'committed');
  assert.equal(persisted.auditRecorded, status === 'committed' || auditRecorded);
  assert.deepEqual(persisted.files, transaction.files);
  const coordinator = new LocalTransactionCoordinator({
    contextProvider: () => f.context,
    request: async (path) => {
      assert.equal(path, `/api/transactions/${f.id}?environmentId=${encodeURIComponent(f.environment.id)}`);
      return { transaction: await restarted.getTransaction(f.environment.id, f.id) };
    },
  });
  const inspection = await coordinator.inspect(f.id);
  assert.equal(inspection.canComplete, true);
  assert.deepEqual(inspection.files, persisted.files.map((file) => ({
    ...file, currentHash: file.finalHash, currentSize: file.finalSize, state: 'final',
  })));
  assert.deepEqual((await restarted.history(f.environment.id)).map((row) => row.transactionId), [f.id]);
  const audit = (await readFile(restarted.auditPath(f.environment.id), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.filter((row) => row.event === 'committed').length, status === 'committed' ? 1 : 0);
  assert.equal(audit.filter((row) => row.event === 'failed').length, failedEvents,
    'never repeat the already-failed terminal transition');
  assert.deepEqual((await f.provider.read(MAIN)).bytes, f.final);
  assert.equal(f.handle.modified, f.revision);
  return transaction;
}

function assertRecoveryError(error, id) {
  assert.deepEqual({ ...error }, { code: 'LOCAL_RECOVERY_REQUIRED', transactionId: id,
    applied: null, recoveryRequired: true });
  assert.equal(mutationOutcome(error), 'recovery-required');
  assert.equal(error.outcome, undefined, 'the Local failure is an error, not a fabricated success envelope');
  assert.equal(error.files, undefined);
  assert.equal(error.changed, undefined);
  assert.equal(error.warnings, undefined);
}

test('Local recovery receipt: an ordinary Complete returns an explicit applied receipt without rewriting source', async (t) => {
  const f = await recoverable(t);
  const request = f.coordinator.request;
  f.coordinator.request = function (...args) {
    assert.equal(this, f.coordinator, 'recovery preserves the injected request receiver');
    return request(...args);
  };
  const result = await f.service.recoverTransaction(f.id, 'complete');
  await assertUntouched(f, []);
  assert.equal(result.applied, true);
  assert.equal(result.outcome, 'applied');
  assert.equal(result.transactionId, f.id);
  assert.equal(result.status, 'committed');
  assert.equal((await f.store.history(f.environment.id)).length, 1);
  const row = await assertJournal(f, { status: 'committed', auditRecorded: true, recoveryRequired: false });
  assert.deepEqual(result, { transactionId: f.id, status: 'committed', committedAt: row.committedAt,
    applied: true, outcome: 'applied' });
});

for (const interruption of ['after-commit-manifest', 'terminal-audit-error', 'after-terminal-audit', 'lost-response']) {
  test(`Local recovery receipt: History Complete reconciles ${interruption} against its durable journal`, async (t) => {
    const f = await recoverable(t);
    if (interruption === 'after-commit-manifest') {
      f.store.faultInjector = (point) => {
        if (point === interruption) throw new Error('Synthetic recovery receipt lost after durable commit');
      };
    } else if (interruption === 'lost-response') {
      const receipt = f.store.commitReceipt.bind(f.store);
      f.store.commitReceipt = async (...args) => {
        await receipt(...args);
        throw new Error('Synthetic recovery receipt response lost');
      };
    } else {
      const audit = f.store.ensureTerminalAudit.bind(f.store);
      f.store.ensureTerminalAudit = async (...args) => {
        if (args[2] !== 'committed') return audit(...args);
        if (interruption === 'after-terminal-audit') await audit(...args);
        throw new Error('Synthetic interrupted terminal audit');
      };
    }
    let result = null, error = null;
    try { result = await f.service.recoverTransaction(f.id, 'complete'); }
    catch (failure) { error = failure; }
    await assertUntouched(f, ['inspect']);
    const manifest = await f.store.getTransaction(f.environment.id, f.id);
    assert.equal(manifest.status, 'committed');
    assert.equal(manifest.recoveryRequired, false);
    const auditPending = ['after-commit-manifest', 'terminal-audit-error'].includes(interruption);
    assert.equal(manifest.auditRecorded, !auditPending);
    await assertJournal(f, { status: 'committed', auditRecorded: !auditPending, recoveryRequired: false });
    const restarted = new TransactionStore({ dataRoot: f.dataRoot, getEnvironment: async (id) => f.environments.get(id) });
    await restarted.initialize();
    assert.equal((await restarted.getTransaction(f.environment.id, f.id)).auditRecorded, true);
    assert.equal((await restarted.history(f.environment.id))[0].transactionId, f.id);
    t.diagnostic(JSON.stringify({ interruption, status: manifest.status, auditRecorded: manifest.auditRecorded,
      sourceRetained: true, error: error && { message: error.message, code: error.code || null },
      applied: result?.applied ?? null, warnings: result?.warnings || [] }));
    assert.equal(error, null);
    assert.equal(result.transactionId, f.id);
    assert.equal(result.applied, true);
    assert.equal(result.outcome, 'applied');
    assert.equal(result.status, 'committed');
    assert.equal(result.committedAt, manifest.committedAt);
    assert(result.warnings.some((warning) => /committed journal/.test(warning)));
    assert.equal(result.warnings.some((warning) => /terminal audit.*pending/i.test(warning)),
      auditPending);
    assert.deepEqual(result, { transactionId: f.id, status: 'committed', committedAt: manifest.committedAt,
      applied: true, outcome: 'applied', warnings: [CONFIRMED_WARNING, ...(auditPending ? [AUDIT_WARNING] : [])] });
    assert.equal(f.trace.some((entry) => entry.action === 'fail'), false);
  });
}

for (const landed of [false, true]) {
  test(`Local recovery receipt: unknown inspection keeps ${landed ? 'committed' : 'unconfirmed'} bytes and an explicit recovery outcome`, async (t) => {
    const f = await recoverable(t);
    let attempted = false;
    if (landed) {
      const receipt = f.store.commitReceipt.bind(f.store);
      f.store.commitReceipt = async (...args) => {
        attempted = true;
        await receipt(...args);
        throw new Error('Synthetic unanswered recovery receipt');
      };
    }
    f.hooks.request = (path, init) => {
      if (!landed && path.endsWith('/receipt')) {
        attempted = true;
        throw new Error('Synthetic unanswered recovery receipt');
      }
      if (attempted && !init.method) throw new Error('Synthetic unavailable outcome inspection');
    };
    await assert.rejects(f.coordinator.recover(f.id, 'complete'), (error) => {
      assertRecoveryError(error, f.id);
      assert.equal(error.code, 'LOCAL_RECOVERY_REQUIRED');
      assert.equal(error.transactionId, f.id);
      assert.equal(error.applied, null);
      assert.equal(error.recoveryRequired, true);
      assert.match(error.message, /Source bytes were retained/);
      assert.match(error.message, /Synthetic unavailable outcome inspection/);
      return true;
    });
    await assertUntouched(f, ['inspect']);
    assert.equal((await f.store.getTransaction(f.environment.id, f.id)).status, landed ? 'committed' : 'failed');
    assert.equal(f.trace.some((entry) => entry.action === 'fail'), false);
    await assertJournal(f, { status: landed ? 'committed' : 'failed', auditRecorded: true, recoveryRequired: !landed });
  });
}

for (const status of ['failed', 'committing']) test(`Local recovery receipt: unconfirmed Complete from ${status} retains valid recovery and permits only a later explicit retry`, async (t) => {
  const f = await recoverable(t, status);
  let recordedFailure = false;
  const fail = f.store.fail.bind(f.store);
  f.store.fail = async (...args) => { const result = await fail(...args); recordedFailure = true; return result; };
  f.hooks.request = (path) => {
    if (path.endsWith('/receipt')) throw new Error('Synthetic unanswered recovery receipt');
  };
  await assert.rejects(f.coordinator.recover(f.id, 'complete'), (error) => {
    assertRecoveryError(error, f.id);
    assert.equal(error.code, 'LOCAL_RECOVERY_REQUIRED');
    assert.equal(error.applied, null); assert.equal(error.recoveryRequired, true);
    assert.match(error.message, /receipt is not confirmed/);
    assert.doesNotMatch(error.message, /could not be recorded/);
    return true;
  });
  await assertUntouched(f, ['inspect', ...(status === 'committing' ? ['fail'] : [])]);
  const pending = await f.store.getTransaction(f.environment.id, f.id);
  assert.equal(pending.status, 'failed'); assert.equal(pending.recoveryRequired, true);
  assert.equal(recordedFailure, status === 'committing', 'record only a legal new failure; existing failed recovery remains intact');
  assert.equal(f.trace.filter((entry) => entry.action === 'fail').length, status === 'committing' ? 1 : 0);
  await assertJournal(f, { status: 'failed', auditRecorded: true, recoveryRequired: true });
  f.hooks.request = null; f.trace.length = 0; f.events.length = 0; f.requests.length = 0;
  const result = await f.coordinator.recover(f.id, 'complete');
  await assertUntouched(f, []);
  assert.equal(result.applied, true); assert.equal(result.transactionId, f.id);
  assert.equal((await f.store.history(f.environment.id)).length, 1);
  const row = await assertJournal(f, { status: 'committed', auditRecorded: true, recoveryRequired: false, failedEvents: 1 });
  assert.deepEqual(result, { transactionId: f.id, status: 'committed', committedAt: row.committedAt,
    applied: true, outcome: 'applied' });
});

for (const inspectionAvailable of [true, false]) {
  test(`Local recovery receipt: a failed recovery record stays explicit with ${inspectionAvailable ? 'available' : 'unavailable'} follow-up inspection`, async (t) => {
    const f = await recoverable(t, 'committing');
    let failureAttempted = false;
    f.hooks.request = (path, init) => {
      if (path.endsWith('/receipt')) throw new Error('Synthetic unanswered recovery receipt');
      if (path.endsWith('/fail')) {
        failureAttempted = true;
        throw new Error('Synthetic recovery record failure');
      }
      if (failureAttempted && !inspectionAvailable && !init.method) {
        throw new Error('Synthetic follow-up inspection failure');
      }
    };
    await assert.rejects(f.coordinator.recover(f.id, 'complete'), (error) => {
      assertRecoveryError(error, f.id);
      assert.equal(error.code, 'LOCAL_RECOVERY_REQUIRED');
      assert.equal(error.transactionId, f.id);
      assert.equal(error.applied, null); assert.equal(error.recoveryRequired, true);
      assert.match(error.message, /Source bytes were retained/);
      assert.match(error.message, /recovery could not be recorded/);
      assert.match(error.message, /Synthetic recovery record failure/);
      if (!inspectionAvailable) assert.match(error.message, /Synthetic follow-up inspection failure/);
      return true;
    });
    await assertUntouched(f, ['inspect', 'fail', 'inspect']);
    const transaction = await f.store.getTransaction(f.environment.id, f.id);
    assert.equal(transaction.status, 'committing');
    assert.equal(transaction.recoveryRequired, true);
    assert.equal(f.trace.filter((entry) => entry.action === 'fail').length, 1);
    await assertJournal(f, { status: 'committing', auditRecorded: false, recoveryRequired: true });
  });
}

test('Local recovery receipt: a late committed receipt wins over a rejected recovery record', async (t) => {
  const f = await recoverable(t, 'committing');
  let savedReceipt;
  f.hooks.request = async (path, init) => {
    if (path.endsWith('/receipt')) {
      savedReceipt = { authorization: init.headers['X-Citadel-Authorization'], body: JSON.parse(init.body) };
      throw new Error('Synthetic unanswered recovery receipt');
    }
    if (path.endsWith('/fail')) {
      await f.store.commitReceipt(f.environment.id, f.id, savedReceipt.authorization, savedReceipt.body);
      throw new Error('Synthetic rejected failure record after late commit');
    }
  };
  const result = await f.coordinator.recover(f.id, 'complete');
  await assertUntouched(f, ['inspect', 'fail', 'inspect']);
  assert.equal(result.applied, true); assert.equal(result.transactionId, f.id);
  assert(result.warnings.some((warning) => /committed journal/.test(warning)));
  assert.equal((await f.store.getTransaction(f.environment.id, f.id)).status, 'committed');
  assert.equal(f.trace.filter((entry) => entry.action === 'fail').length, 1);
  const row = await assertJournal(f, { status: 'committed', auditRecorded: true, recoveryRequired: false });
  assert.deepEqual(result, { transactionId: f.id, status: 'committed', committedAt: row.committedAt,
    applied: true, outcome: 'applied', warnings: [CONFIRMED_WARNING] });
});

test('Local recovery receipt: Complete still refuses source that does not match the reviewed final bytes', async (t) => {
  const f = await recoverable(t);
  (await f.provider.fileHandle(MAIN)).change(f.before);
  await assert.rejects(f.coordinator.recover(f.id, 'complete'), /Not every target matches its planned final hash/);
  assert.deepEqual((await f.provider.read(MAIN)).bytes, f.before);
  assert.deepEqual(f.writes, []);
  assert.equal(f.trace.some((entry) => ['receipt', 'rollback', 'fail'].includes(entry.action)), false);
  assert.deepEqual(f.events, ['inspect', 'recover']);
  const restarted = new TransactionStore({ dataRoot: f.dataRoot, getEnvironment: async (id) => f.environments.get(id) });
  await restarted.initialize();
  assert.deepEqual((await restarted.getTransaction(f.environment.id, f.id)).files, f.initial.files);
  assert.deepEqual((await f.provider.read(MAIN)).bytes, f.before);
});

test('C1 Local normal commits and History Complete retain the same production receipt implementation', async () => {
  const [client, coordinator] = await Promise.all([
    readFile(new URL('../web/js/transaction-client.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../web/js/mutation-coordinator.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(client, /import \{ commitLocalReceipt, localRecoveryFailure \} from '\.\/mutation-coordinator\.mjs'/);
  assert.match(client, /receiptAttempted = true;\s+const receipt = await commitLocalReceipt\(request,/);
  assert.match(client, /if \(receiptAttempted\) throw error;/);
  assert.match(coordinator, /export async function commitLocalReceipt\(/);
  assert.match(coordinator, /return commitLocalReceipt\(this\.request\.bind\(this\),/);
});
