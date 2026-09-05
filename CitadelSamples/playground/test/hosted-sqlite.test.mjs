import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createSqliteRunStore } from '../src/hosted/sqliteRunStore.mjs';
import { digest, targetKeys } from '../src/hosted/request.mjs';
import { storageRecord } from './helpers/stagedStoreProcess.mjs';

const diskTest = process.platform === 'linux' && process.env.CITADEL_STAGED_TEST_ROOT ? test : test.skip;
const directories = [];
after(async () => { for (const path of directories) await rm(path, { recursive: true, force: true }); });

async function directory(t) {
  const path = await mkdtemp(join(process.env.CITADEL_STAGED_TEST_ROOT ?? tmpdir(), 'citadel-staged-w1-96518acf-'));
  directories.push(path);
  return path;
}

diskTest('SQLite commits admission atomically, enforces stable target identity and retains unknown outcomes', async (t) => {
  const path = await directory(t);
  const store = createSqliteRunStore({ directory: path });
  t.after(() => store.close());
  const first = store.claim(storageRecord());
  assert.equal(first.created, true);
  assert.equal(store.claim(storageRecord()).created, false);
  assert.throws(() => store.claim({ ...storageRecord(), identityDigest: digest('changed') }), /Idempotency/);
  assert.throws(() => store.claim(storageRecord('fresh-session-key-salt')), /capacity|target/i);
  store.beginEffect(first.run.id, 'write-once', digest('effect'));
  assert.equal(store.finish(first.run.id, 'failed').state, 'inconclusive');
  assert.throws(() => store.claim(storageRecord('after-logout')), /target/i);
  assert.deepEqual(targetKeys(storageRecord().targets), targetKeys([{ ...storageRecord().targets[0],
    resourceId: `${storageRecord().targets[0].resourceId}/subscriptions/different-label` }]));
  assert.equal(store.effects(first.run.id)[0].state, 'intended');
  assert.throws(() => store.reconcile(first.run.id, []), /unknown/);
  store.reconcile(first.run.id, [{ id: 'write-once', confirmed: true }]);
  assert.equal(store.claim(storageRecord('explicit-new-review')).created, true);
});

diskTest('SQLite guard survives COMMIT, excludes a live second process, and reopens after actual crash', async (t) => {
  const path = await directory(t);
  const child = fork(fileURLToPath(new URL('./helpers/stagedStoreProcess.mjs', import.meta.url)), [path], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  let stderr = '';
  child.stderr.on('data', (value) => { stderr += value; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ready = await Promise.race([
    once(child, 'message').then(([value]) => value),
    once(child, 'exit').then(() => { throw new Error(`Storage child exited before ready: ${stderr}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Storage child readiness deadline')), 10000); timer.unref(); }),
  ]);
  const start = performance.now();
  assert.throws(() => createSqliteRunStore({ directory: path }), /storage is unavailable/);
  const contentionMs = performance.now() - start;
  assert.ok(contentionMs < 1000, `bounded guard contention: ${contentionMs}`);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const reopened = createSqliteRunStore({ directory: path });
  t.after(() => reopened.close());
  assert.equal(reopened.get(ready.runId).state, 'inconclusive');
  assert.equal(reopened.effects(ready.runId)[0].state, 'unknown');
  assert.throws(() => reopened.claim(storageRecord('new-login-new-review')), /target/i);
  assert.equal(reopened.claim(storageRecord()).run.id, ready.runId, 'same nonce/identity is stable after restart');
  reopened.reconcile(ready.runId, [{ id: 'write-once', confirmed: true }]);
  assert.equal(reopened.claim(storageRecord('review-after-readback')).created, true);
  t.diagnostic(JSON.stringify({ node: process.version, contentionMs, ...reopened.diagnostics() }));
});

diskTest('origin-only unresolved reservations survive later resource discovery and restart', async (t) => {
  const path = await directory(t);
  let store = createSqliteRunStore({ directory: path });
  t.after(() => store.close());
  const known = storageRecord('later-known-resource');
  const unknown = { ...storageRecord('unknown-resource'), targets: [{ resourceId: '', origin: known.targets[0].origin }] };
  const { run } = store.claim(unknown);
  store.beginEffect(run.id, 'unknown-paid-request', digest('fixed-paid-request'));
  store.finish(run.id, 'inconclusive');
  assert.throws(() => store.claim(known), /target/i);
  store.close();
  store = createSqliteRunStore({ directory: path });
  assert.throws(() => store.claim(known), /target/i);
  assert.ok(targetKeys(unknown.targets).every((key) => targetKeys(known.targets).includes(key)));
});

diskTest('corrupt or missing initialized SQLite state never becomes an empty replacement database', async (t) => {
  const path = await directory(t);
  const store = createSqliteRunStore({ directory: path });
  store.claim(storageRecord());
  store.close();
  const file = join(path, 'runs.sqlite'), damaged = Buffer.from('deliberately-invalid-sqlite-fixture');
  await writeFile(file, damaged);
  assert.throws(() => createSqliteRunStore({ directory: path }), /storage is unavailable/);
  assert.deepEqual(await readFile(file), damaged);
  await rm(file);
  assert.throws(() => createSqliteRunStore({ directory: path }), /storage is unavailable/);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

diskTest('storage rollback preserves the first intended effect; schema and extension operations are not caller inputs', async (t) => {
  const path = await directory(t);
  let store = createSqliteRunStore({ directory: path });
  t.after(() => store.close());
  assert.throws(() => store.claim({ ...storageRecord(), sql: 'ATTACH DATABASE' }), /shape/);
  const { run } = store.claim(storageRecord());
  store.beginEffect(run.id, 'same', digest('first'));
  assert.throws(() => store.beginEffect(run.id, 'same', digest('second')), /storage is unavailable/);
  store.close();
  store = createSqliteRunStore({ directory: path });
  assert.equal(store.effects(run.id).length, 1);
  assert.equal(store.effects(run.id)[0].request_digest, digest('first'));
  assert.throws(() => store.observeEffect(run.id, 'same', { status: 200, outcome: 'confirmed', token: 'never-stored' }), /shape/);
});

diskTest('bounded transaction and checkpoint timings leave cooperative event-loop turns responsive', async (t) => {
  const path = await directory(t);
  const store = createSqliteRunStore({ directory: path });
  t.after(() => store.close());
  let maxTurnMs = 0;
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    const { run } = store.claim(storageRecord(`latency-${index}`));
    store.beginEffect(run.id, 'effect', digest('fixed-effect'));
    store.observeEffect(run.id, 'effect', { status: 200, outcome: 'confirmed' });
    store.finish(run.id, 'completed');
    if (index % 10 === 0) store.checkpoint();
    await new Promise((resolve) => setImmediate(resolve));
    maxTurnMs = Math.max(maxTurnMs, performance.now() - start);
  }
  const metrics = store.diagnostics();
  assert.ok(metrics.maxTransactionMs < 250 && metrics.maxCheckpointMs < 250 && maxTurnMs < 500,
    `storage latency exceeded the acceptance ceiling: ${JSON.stringify({ ...metrics, maxTurnMs })}`);
  t.diagnostic(JSON.stringify({ node: process.version, ...metrics, maxTurnMs }));
});
