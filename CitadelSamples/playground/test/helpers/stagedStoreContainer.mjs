import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createSqliteRunStore } from '../../src/hosted/sqliteRunStore.mjs';
import { digest } from '../../src/hosted/request.mjs';
import { storageRecord } from './stagedStoreProcess.mjs';

const phase = process.argv[2];
if (['write', 'read'].includes(phase)) {
  const directory = '/state/container-replacement';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const store = createSqliteRunStore({ directory });
  if (phase === 'write') {
    const { run } = store.claim(storageRecord('container-replacement'));
    store.beginEffect(run.id, 'unknown-effect', digest('owned-container-effect'));
    console.log(JSON.stringify({ phase, node: process.version, runId: run.id, state: 'intended', directory }));
    setInterval(() => {}, 60000);
  } else {
    const same = store.claim(storageRecord('container-replacement'));
    assert.equal(same.created, false);
    assert.equal(same.run.state, 'inconclusive');
    assert.equal(store.effects(same.run.id)[0].state, 'unknown');
    assert.throws(() => store.claim(storageRecord('fresh-session-after-container-replacement')), /target/i);
    console.log(JSON.stringify({ phase, node: process.version, runId: same.run.id,
      state: same.run.state, reservationSurvived: true, automaticDispatch: false, directory }));
    store.close();
  }
}
