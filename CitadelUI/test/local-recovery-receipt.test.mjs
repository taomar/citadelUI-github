import assert from 'node:assert/strict';
import test from 'node:test';
import { TransactionStore } from '../server/transactions.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';

const MAIN = 'bicep/infra/main.bicepparam';

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
  const writes = [];
  const write = f.provider.write.bind(f.provider), remove = f.provider.remove.bind(f.provider);
  f.provider.write = async (...args) => { writes.push('write'); return write(...args); };
  f.provider.remove = async (...args) => { writes.push('remove'); return remove(...args); };
  f.trace.length = 0;
  return { ...f, id: transaction.transactionId, before: before.bytes, final: current.bytes, writes };
}

async function assertUntouched(f) {
  assert.deepEqual((await f.provider.read(MAIN)).bytes, f.final);
  assert.deepEqual(f.writes, []);
  assert.equal(f.trace.some((entry) => entry.action === 'rollback'), false);
  assert.equal(f.trace.filter((entry) => entry.action === 'receipt').length, 1, 'no automatic receipt retry');
}

test('Local recovery receipt: an ordinary Complete returns an explicit applied receipt without rewriting source', async (t) => {
  const f = await recoverable(t);
  const request = f.coordinator.request;
  f.coordinator.request = function (...args) {
    assert.equal(this, f.coordinator, 'recovery preserves the injected request receiver');
    return request(...args);
  };
  const result = await f.service.recoverTransaction(f.id, 'complete');
  await assertUntouched(f);
  assert.equal(result.applied, true);
  assert.equal(result.outcome, 'applied');
  assert.equal(result.transactionId, f.id);
  assert.equal(result.status, 'committed');
  assert.equal((await f.store.history(f.environment.id)).length, 1);
});

for (const interruption of ['after-commit-manifest', 'lost-response']) {
  test(`Local recovery receipt: History Complete reconciles ${interruption} against its durable journal`, async (t) => {
    const f = await recoverable(t);
    if (interruption === 'after-commit-manifest') {
      f.store.faultInjector = (point) => {
        if (point === interruption) throw new Error('Synthetic recovery receipt lost after durable commit');
      };
    } else {
      const receipt = f.store.commitReceipt.bind(f.store);
      f.store.commitReceipt = async (...args) => {
        await receipt(...args);
        throw new Error('Synthetic recovery receipt response lost');
      };
    }
    let result = null, error = null;
    try { result = await f.service.recoverTransaction(f.id, 'complete'); }
    catch (failure) { error = failure; }
    await assertUntouched(f);
    const manifest = await f.store.getTransaction(f.environment.id, f.id);
    assert.equal(manifest.status, 'committed');
    assert.equal(manifest.recoveryRequired, false);
    assert.equal(manifest.auditRecorded, interruption !== 'after-commit-manifest');
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
      interruption === 'after-commit-manifest');
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
      assert.equal(error.code, 'LOCAL_RECOVERY_REQUIRED');
      assert.equal(error.transactionId, f.id);
      assert.equal(error.applied, null);
      assert.equal(error.recoveryRequired, true);
      assert.match(error.message, /Source bytes were retained/);
      assert.match(error.message, /Synthetic unavailable outcome inspection/);
      return true;
    });
    await assertUntouched(f);
    assert.equal((await f.store.getTransaction(f.environment.id, f.id)).status, landed ? 'committed' : 'failed');
    assert.equal(f.trace.some((entry) => entry.action === 'fail'), false);
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
    assert.equal(error.code, 'LOCAL_RECOVERY_REQUIRED');
    assert.equal(error.applied, null); assert.equal(error.recoveryRequired, true);
    assert.match(error.message, /receipt is not confirmed/);
    assert.doesNotMatch(error.message, /could not be recorded/);
    return true;
  });
  await assertUntouched(f);
  const pending = await f.store.getTransaction(f.environment.id, f.id);
  assert.equal(pending.status, 'failed'); assert.equal(pending.recoveryRequired, true);
  assert.equal(recordedFailure, status === 'committing', 'record only a legal new failure; existing failed recovery remains intact');
  assert.equal(f.trace.filter((entry) => entry.action === 'fail').length, status === 'committing' ? 1 : 0);
  f.hooks.request = null; f.trace.length = 0;
  const result = await f.coordinator.recover(f.id, 'complete');
  await assertUntouched(f);
  assert.equal(result.applied, true); assert.equal(result.transactionId, f.id);
  assert.equal((await f.store.history(f.environment.id)).length, 1);
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
      assert.equal(error.code, 'LOCAL_RECOVERY_REQUIRED');
      assert.equal(error.transactionId, f.id);
      assert.equal(error.applied, null); assert.equal(error.recoveryRequired, true);
      assert.match(error.message, /Source bytes were retained/);
      assert.match(error.message, /recovery could not be recorded/);
      assert.match(error.message, /Synthetic recovery record failure/);
      if (!inspectionAvailable) assert.match(error.message, /Synthetic follow-up inspection failure/);
      return true;
    });
    await assertUntouched(f);
    const transaction = await f.store.getTransaction(f.environment.id, f.id);
    assert.equal(transaction.status, 'committing');
    assert.equal(transaction.recoveryRequired, true);
    assert.equal(f.trace.filter((entry) => entry.action === 'fail').length, 1);
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
  await assertUntouched(f);
  assert.equal(result.applied, true); assert.equal(result.transactionId, f.id);
  assert(result.warnings.some((warning) => /committed journal/.test(warning)));
  assert.equal((await f.store.getTransaction(f.environment.id, f.id)).status, 'committed');
  assert.equal(f.trace.filter((entry) => entry.action === 'fail').length, 1);
});

test('Local recovery receipt: Complete still refuses source that does not match the reviewed final bytes', async (t) => {
  const f = await recoverable(t);
  (await f.provider.fileHandle(MAIN)).change(f.before);
  await assert.rejects(f.coordinator.recover(f.id, 'complete'), /Not every target matches its planned final hash/);
  assert.deepEqual((await f.provider.read(MAIN)).bytes, f.before);
  assert.deepEqual(f.writes, []);
  assert.equal(f.trace.some((entry) => ['receipt', 'rollback', 'fail'].includes(entry.action)), false);
});
