import { createRequire } from 'node:module';
import { existsSync, lstatSync, realpathSync, statfsSync, statSync, chmodSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { exact, HASH, refuse, canonicalTargets, targetKeys } from './request.mjs';

const LOCAL_FILESYSTEMS = new Set([0xef53, 0x58465342, 0x9123683e]);
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 4096;
const states = new Set(['accepted', 'running', 'completed', 'blocked', 'cancelled', 'inconclusive', 'failed']);
const unavailable = () => Object.assign(new Error('Staged durable storage is unavailable. New dispatch is blocked; previous outcomes require owner recovery.'),
  { status: 503, code: 'hosted-storage-unavailable' });

export function createSqliteRunStore({ directory, now = Date.now } = {}) {
  if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24) throw unavailable();
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  let guard, db, healthy = true, closed = false;
  const timings = { transactions: 0, maxTransactionMs: 0, maxCheckpointMs: 0 };
  function checkFile(path) {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw unavailable();
  }
  let root, statePath, guardPath;
  try {
    if (!isAbsolute(directory ?? '') || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw unavailable();
    root = realpathSync(directory);
    if (lstatSync(root).mode & 0o077) throw unavailable();
    if (!LOCAL_FILESYSTEMS.has(Number(statfsSync(root).type) >>> 0)) throw unavailable();
    statePath = join(root, 'runs.sqlite');
    guardPath = join(root, 'instance.sqlite');
    for (const name of ['runs.sqlite', 'runs.sqlite-wal', 'runs.sqlite-shm', 'instance.sqlite', 'instance.sqlite-journal']) checkFile(join(root, name));
    const priorGuard = existsSync(guardPath);
    guard = new DatabaseSync(guardPath, { allowExtension: false });
    guard.enableLoadExtension(false);
    guard.exec('PRAGMA busy_timeout=50; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL;');
    guard.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS instance (id INTEGER PRIMARY KEY CHECK(id=1), initialized INTEGER NOT NULL CHECK(initialized IN (0,1))); INSERT OR IGNORE INTO instance VALUES(1,0); COMMIT;');
    if (guard.prepare('PRAGMA locking_mode').get().locking_mode !== 'exclusive') throw unavailable();
    if (priorGuard && guard.prepare('SELECT initialized FROM instance WHERE id=1').get().initialized && !existsSync(statePath)) throw unavailable();
    db = new DatabaseSync(statePath, { allowExtension: false });
    db.enableLoadExtension(false);
    db.exec('PRAGMA busy_timeout=50; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA wal_autocheckpoint=256; PRAGMA max_page_count=16384;');
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal'
      || db.prepare('PRAGMA synchronous').get().synchronous !== 2
      || db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1
      || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw unavailable();
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1) throw unavailable();
    if (version === 0) {
      if (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n) throw unavailable();
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, tenant TEXT NOT NULL, owner TEXT NOT NULL, sample TEXT NOT NULL,
          adapter TEXT NOT NULL, policy TEXT NOT NULL, identity TEXT NOT NULL, nonce TEXT UNIQUE NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('accepted','running','completed','blocked','cancelled','inconclusive','failed')),
          created INTEGER NOT NULL, updated INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
          target_json TEXT NOT NULL CHECK(length(target_json)<=16384),
          result_json TEXT CHECK(length(result_json)<=65536),
          UNIQUE(tenant,owner,nonce));
        CREATE TABLE targets (key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id));
        CREATE TABLE effects (
          run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('intended','observed','unknown')),
          request_digest TEXT NOT NULL, observation TEXT CHECK(length(observation)<=8192),
          PRIMARY KEY(run_id,id));
        CREATE INDEX runs_owner ON runs(tenant,owner);
        CREATE INDEX targets_run ON targets(run_id);
        CREATE TABLE cooldowns (key TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
    }
    db.exec("BEGIN IMMEDIATE; UPDATE effects SET state='unknown' WHERE state='intended'; UPDATE runs SET state='inconclusive', active=0 WHERE state IN ('accepted','running'); COMMIT;");
    guard.exec('BEGIN EXCLUSIVE; UPDATE instance SET initialized=1 WHERE id=1; COMMIT;');
    for (const name of ['runs.sqlite', 'runs.sqlite-wal', 'runs.sqlite-shm', 'instance.sqlite', 'instance.sqlite-journal']) {
      const path = join(root, name);
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  } catch {
    try { db?.close(); } finally { guard?.close(); }
    throw unavailable();
  }
  let sql;
  try { sql = Object.freeze({
    byId: db.prepare('SELECT * FROM runs WHERE id=?'),
    byNonce: db.prepare('SELECT * FROM runs WHERE tenant=? AND owner=? AND nonce=?'),
    count: db.prepare('SELECT count(*) AS n FROM runs'),
    active: db.prepare('SELECT count(*) AS n FROM runs WHERE active=1'),
    ownerActive: db.prepare('SELECT count(*) AS n FROM runs WHERE active=1 AND tenant=? AND owner=?'),
    target: db.prepare('SELECT run_id FROM targets WHERE key=?'),
    reservations: db.prepare('SELECT count(*) AS n FROM targets WHERE run_id=?'),
    cooldown: db.prepare('SELECT until_ms FROM cooldowns WHERE key=?'),
    insert: db.prepare('INSERT INTO runs(id,tenant,owner,sample,adapter,policy,identity,nonce,state,created,updated,active,target_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    reserve: db.prepare('INSERT INTO targets VALUES(?,?)'),
    effectCount: db.prepare('SELECT count(*) AS n FROM effects WHERE run_id=?'),
    effect: db.prepare('INSERT INTO effects VALUES(?,?,?,?,NULL)'),
    observed: db.prepare("UPDATE effects SET state='observed', observation=? WHERE run_id=? AND id=? AND state='intended'"),
    response: db.prepare("UPDATE effects SET observation=? WHERE run_id=? AND id=? AND state='intended'"),
    effects: db.prepare('SELECT id,state,request_digest,observation FROM effects WHERE run_id=? ORDER BY id LIMIT 256'),
    unresolved: db.prepare("SELECT count(*) AS n FROM effects WHERE run_id=? AND state!='observed'"),
    update: db.prepare('UPDATE runs SET state=?,updated=?,active=?,result_json=? WHERE id=?'),
    release: db.prepare('DELETE FROM targets WHERE run_id=?'),
    recoverable: db.prepare('SELECT DISTINCT r.id,r.sample,r.state FROM runs r JOIN targets t ON t.run_id=r.id WHERE r.tenant=? AND r.owner=? ORDER BY r.created LIMIT 100'),
    reconcile: db.prepare("UPDATE effects SET state='observed' WHERE run_id=?"),
    checkpoint: db.prepare('PRAGMA wal_checkpoint(PASSIVE)'),
  }); } catch {
    try { db.close(); } finally { guard.close(); }
    throw unavailable();
  }
  const stateIdentity = statSync(statePath), guardIdentity = statSync(guardPath);
  function ready() {
    if (!healthy || closed) throw unavailable();
    try {
      for (const [path, identity] of [[statePath, stateIdentity], [guardPath, guardIdentity]]) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== identity.ino || stat.dev !== identity.dev || stat.size > MAX_BYTES) throw unavailable();
      }
      checkFile(`${statePath}-wal`);
    } catch { healthy = false; throw unavailable(); }
  }
  function read(fn) {
    ready();
    try { return fn(); }
    catch { healthy = false; throw unavailable(); }
  }
  function transaction(fn) {
    ready();
    const start = performance.now();
    try {
      db.exec('BEGIN IMMEDIATE');
      const value = fn();
      if (value && typeof value.then === 'function') throw new TypeError('Async storage transaction refused.');
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { healthy = false; }
      if (Number.isInteger(error.status)) throw error;
      healthy = false;
      throw unavailable();
    } finally {
      timings.transactions++;
      timings.maxTransactionMs = Math.max(timings.maxTransactionMs, performance.now() - start);
    }
  }
  function row(record) {
    return record ? { id: record.id, tenant: record.tenant, owner: record.owner, sampleId: record.sample,
      adapterVersion: record.adapter, policyDigest: record.policy, identityDigest: record.identity, state: record.state,
      created: record.created, updated: record.updated, active: Boolean(record.active),
      targets: JSON.parse(record.target_json), result: record.result_json ? JSON.parse(record.result_json) : null } : null;
  }
  const safeJson = (value, max) => {
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text) > max) refuse('Stored metadata exceeds its bound.', 'storage-record-limit', 400);
    return text;
  };
  return Object.freeze({
    claim(record, { maxConcurrentRuns = 8, maxPerOwner = 1 } = {}) {
      exact(record, ['tenant', 'owner', 'sampleId', 'adapterVersion', 'policyDigest', 'identityDigest', 'nonceHash', 'targets']);
      if (![record.policyDigest, record.identityDigest, record.nonceHash].every((value) => HASH.test(value))
        || ![record.tenant, record.owner].every((value) => /^[a-f0-9-]{36}$/.test(value))
        || !/^[a-z0-9-]{1,80}$/.test(record.sampleId) || !/^[\w.-]{1,64}$/.test(record.adapterVersion)
        || !Array.isArray(record.targets)) {
        refuse('Invalid durable admission identity.', 'invalid-admission', 400);
      }
      const targets = canonicalTargets(record.targets, { allowEmpty: true }), keys = targetKeys(targets);
      return transaction(() => {
        const previous = sql.byNonce.get(record.tenant, record.owner, record.nonceHash);
        if (previous) {
          if (previous.identity !== record.identityDigest || previous.policy !== record.policyDigest) refuse('Idempotency identity changed.', 'idempotency-conflict');
          return { created: false, run: row(previous) };
        }
        if (sql.count.get().n >= MAX_ROWS) refuse('Run retention capacity reached. Unresolved effects are retained.', 'storage-capacity', 429);
        if (sql.active.get().n >= maxConcurrentRuns || sql.ownerActive.get(record.tenant, record.owner).n >= maxPerOwner) {
          refuse('Staged execution capacity reached.', 'runner-busy', 429);
        }
        for (const target of keys) {
          if (sql.target.get(target)) refuse('The target has an active or unresolved effect. Reconcile it first.', 'target-reserved');
          if ((sql.cooldown.get(target)?.until_ms ?? 0) > now()) refuse('Target cooldown is active.', 'target-cooldown', 429);
        }
        const id = randomUUID(), time = now();
        sql.insert.run(id, record.tenant, record.owner, record.sampleId, record.adapterVersion, record.policyDigest,
          record.identityDigest, record.nonceHash, 'accepted', time, time, 1, safeJson(targets, 16384));
        for (const target of keys) sql.reserve.run(target, id);
        return { created: true, run: row(sql.byId.get(id)) };
      });
    },
    get(id) { return read(() => row(sql.byId.get(id))); },
    hasReservation(id) { return read(() => sql.reservations.get(id).n > 0); },
    listRecoverable(tenant, owner) { return read(() => sql.recoverable.all(tenant, owner)); },
    beginEffect(runId, id, requestDigest) {
      if (!/^[a-z0-9-]{1,80}$/.test(id) || !HASH.test(requestDigest)) refuse('Invalid effect identity.', 'invalid-effect', 400);
      return transaction(() => {
        const run = sql.byId.get(runId);
        if (!run || !run.active || !['accepted', 'running'].includes(run.state)) refuse('Run is not dispatchable.', 'run-not-active');
        if (!JSON.parse(run.target_json).length) refuse('No target was reserved for this effect.', 'invalid-target');
        if (sql.effectCount.get(runId).n >= 256) refuse('Effect budget exhausted.', 'effect-limit');
        sql.effect.run(runId, id, 'intended', requestDigest);
        sql.update.run('running', now(), 1, null, runId);
      });
    },
    observeEffect(runId, id, observation) {
      exact(observation, ['status', 'outcome'], ['status', 'outcome']);
      if (!Number.isInteger(observation.status) || observation.status < 200 || observation.status > 599
        || !['confirmed', 'unknown'].includes(observation.outcome)) refuse('Invalid effect observation.', 'invalid-effect', 400);
      return transaction(() => {
        if (observation.outcome === 'confirmed') {
          if (sql.observed.run(safeJson(observation, 8192), runId, id).changes !== 1) refuse('Effect is no longer awaiting observation.', 'effect-conflict');
        } else if (sql.response.run(safeJson(observation, 8192), runId, id).changes !== 1) refuse('Effect is no longer awaiting observation.', 'effect-conflict');
      });
    },
    finish(runId, state, result = null) {
      if (!states.has(state) || ['accepted', 'running'].includes(state)) refuse('Invalid terminal state.', 'invalid-state', 400);
      return transaction(() => {
        const record = sql.byId.get(runId);
        if (!record) refuse('Run not found.', 'run-unavailable', 404);
        if (sql.unresolved.get(runId).n) state = 'inconclusive';
        sql.update.run(state, now(), 0, result ? safeJson({ ...result, state }, 65536) : null, runId);
        if (!sql.unresolved.get(runId).n) sql.release.run(runId);
        return row(sql.byId.get(runId));
      });
    },
    effects(runId) { return read(() => sql.effects.all(runId).map(({ observation, ...item }) => ({ ...item, observation: observation ? JSON.parse(observation) : null }))); },
    reconcile(runId, observations) {
      if (!Array.isArray(observations) || observations.length > 256) refuse('Invalid reconciliation.', 'invalid-reconciliation');
      return transaction(() => {
        const effects = sql.effects.all(runId);
        if (observations.length !== effects.length || effects.some((effect) => !observations.some((value) => value.id === effect.id && value.confirmed === true))) {
          refuse('The provider outcome remains unknown.', 'outcome-unknown');
        }
        for (const value of observations) exact(value, ['id', 'confirmed']);
        sql.reconcile.run(runId);
        sql.release.run(runId);
        return row(sql.byId.get(runId));
      });
    },
    checkpoint() {
      ready();
      const start = performance.now();
      try { return sql.checkpoint.get(); }
      catch { healthy = false; throw unavailable(); }
      finally { timings.maxCheckpointMs = Math.max(timings.maxCheckpointMs, performance.now() - start); }
    },
    diagnostics() { return { ...timings, schemaVersion: 1, healthy: healthy && !closed }; },
    close() { if (!closed) { closed = true; try { db.close(); } finally { guard.close(); } } },
  });
}
