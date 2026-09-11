import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TransactionStore } from '../server/transactions.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { mutationOutcome } from '../shared/mutation-outcome.mjs';
import { sha256 } from '../web/js/directory-provider.mjs';
import { LocalTransactionCoordinator } from '../web/js/mutation-coordinator.mjs';
import { MigrationDonor } from '../web/js/migration-donor.mjs';
import { MigrationSession } from '../web/js/migration-session.mjs';
import { ACCESS_PATHS, citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';
import { CURRENT, SCHEMA, TARGET, TEMPLATE, LEGACY, folderFromFiles } from './_migration-fixture.mjs';

const edit = (name, value) => ({ op: 'set', path: [name], value });
const encode = (text) => new TextEncoder().encode(text);
const CONFIRMED_WARNING = 'The receipt response failed, but the committed journal confirms this save.';
const AUDIT_WARNING = 'The terminal audit is still pending. Inspect History before another change.';
const CREATION_DIR = `${ACCESS_PATHS.root}/contracts/receipt-creation`;
const receiptCases = [
  { name: 'clean', committed: true, tail: [] },
  { name: 'after-commit-manifest', committed: true, auditPending: true, tail: ['inspect'] },
  { name: 'terminal-audit-error', committed: true, auditPending: true, tail: ['inspect'] },
  { name: 'after-terminal-audit', committed: true, tail: ['inspect'] },
  { name: 'lost-response', committed: true, tail: ['inspect'] },
  { name: 'unconfirmed', tail: ['inspect', 'fail'], failed: true },
  { name: 'receipt-inspection-error', tail: ['inspect'] },
  { name: 'committed-inspection-error', committed: true, unknown: true, tail: ['inspect'] },
  { name: 'terminal-record-error', tail: ['inspect', 'fail', 'inspect'] },
  { name: 'terminal-record-inspection-error', tail: ['inspect', 'fail', 'inspect'] },
  { name: 'late-commit', committed: true, tail: ['inspect', 'fail', 'inspect'] },
];

function plannedFile(alias, before, after, changed, create = false) {
  return { alias, before: before === null ? null : encode(before), after: encode(after), changed, create };
}

function plannedRun(run, files, action, context, extra = {}) {
  return Object.assign(run, { files, action, context, ...extra });
}

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
    const source = await f.provider.read(TARGET);
    return plannedRun(() => f.service.save(TARGET, [edit('environmentName', 'receipt-parameter')], document.hash),
      [plannedFile(TARGET, source.text, source.text.replace("environmentName = 'dev'", "environmentName = 'receipt-parameter'"),
        ['environmentName'])], 'parameter-edit', f.context);
  }
  if (operation === 'policy') {
    const source = await f.provider.read(ACCESS_PATHS.policy);
    const text = '<policies><inbound><!-- reviewed policy --><base /></inbound></policies>\n';
    return plannedRun(() => f.service.savePolicy({
      path: ACCESS_PATHS.policy, expectedHash: source.hash,
      text,
    }), [plannedFile(source.alias, source.text, text, ['raw'])], 'policy-edit', f.context);
  }
  if (operation === 'creation') {
    const param = await f.provider.read(ACCESS_PATHS.template), policy = await f.provider.read(ACCESS_PATHS.policy);
    return plannedRun(() => f.service.createContract({ name: 'receipt-creation' }), [
      plannedFile(`${CREATION_DIR}/main.bicepparam`, null,
        param.text.replace("using 'main.bicep'", "using '../../main.bicep'"), ['using', 'policyXml'], true),
      plannedFile(`${CREATION_DIR}/ai-product-policy.xml`, null, policy.text, ['policyXml'], true),
    ], 'contract-create', f.context);
  }
  if (operation === 'restore') {
    const document = await f.service.deployment(TARGET);
    const original = await f.provider.read(TARGET);
    const saved = await f.service.save(TARGET, [edit('environmentName', 'prior-save')], document.hash);
    const current = await f.provider.read(TARGET);
    return plannedRun(() => f.service.restoreTransaction(saved.archived),
      [plannedFile(TARGET, current.text, original.text, ['restore'])], 'history-restore', f.context,
      { priorTransactionId: saved.archived });
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
    return plannedRun(() => f.service.copyParameters(target.environment.id, TARGET, ['environmentName'],
      comparison.source.hash, comparison.destination.hash),
      [plannedFile(TARGET, comparison.destination.text,
        comparison.destination.text.replace("environmentName = 'dev'", "environmentName = 'copy-me'"), ['environmentName'])],
      'environment-copy', comparison.target);
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
  assert.equal(review.report.summary.proposedEdits, 1);
  assert.equal(review.report.summary.copied, 0, 'a reviewed plan is not an applied migration');
  return plannedRun(() => session.apply(review.id, { reviewed: true }),
    [plannedFile(TARGET, CURRENT, CURRENT.replace('Count = 2', 'Count = 4'), ['Count'])],
    'parameter-migration', f.context, { destination: session.destination });
}

function sourceSnapshot(root) {
  return Object.fromEntries(root.allFiles().map(({ path, bytes }) => [path, bytes.slice()]));
}

async function observeOperation(f, run, scenario) {
  const observed = { commits: 0, events: [], requests: [], source: sourceSnapshot(f.root),
    destination: sourceSnapshot(run.context.provider.root) };
  const expected = await Promise.all(run.files.map(async (file) => ({
    ...file, beforeHash: file.before === null ? null : await sha256(file.before),
    finalHash: await sha256(file.after),
  })));
  const event = (name) => observed.events.push(name);
  const commit = f.coordinator.commit.bind(f.coordinator);
  f.coordinator.commit = async (files, options) => {
    observed.commits++;
    observed.planned = files;
    observed.context = options.context;
    assert.equal(options.action, run.action);
    assert.equal(options.context.provider, run.context.provider);
    assert.equal(options.context.environment.id, run.context.environment.id);
    assert.deepEqual(files.map((file) => ({
      alias: file.alias, before: file.before === null ? null : new Uint8Array(file.before), beforeHash: file.beforeHash,
      after: new Uint8Array(file.after), changed: file.changed, create: Boolean(file.create),
    })), expected.map(({ finalHash, ...file }) => file));
    try { return observed.result = await commit(files, options); }
    catch (error) { observed.error = error; throw error; }
  };
  const owner = run.context.provider.root.owner;
  owner.trace.length = 0;
  owner.before = ({ operation, path, handle }) => {
    if (operation === 'getFile') event(`read:${path}`);
    if (!['createWritable', 'write', 'close', 'removeEntry'].includes(operation)) return;
    event(`${operation}:${path}`);
    if (operation === 'write' || operation === 'close') {
      const file = expected.find((entry) => entry.alias === path);
      assert.ok(file, 'only planned files may be written');
      assert.deepEqual(handle.bytes, file.before ?? new Uint8Array(), 'staged writes are invisible until close');
    }
  };
  owner.afterClose = (handle) => {
    event(`published:${handle.path}`);
    assert.deepEqual(handle.bytes, expected.find((file) => file.alias === handle.path).after);
  };
  const write = run.context.provider.write.bind(run.context.provider);
  run.context.provider.write = async (alias, bytes, options) => {
    const file = expected.find((entry) => entry.alias === alias);
    event(`write-call:${alias}`);
    assert.deepEqual(new Uint8Array(bytes), file.after);
    assert.equal(options.create, file.create);
    assert.equal(options.expectedHash, file.beforeHash);
    assert.equal(options.finalHash, file.finalHash);
    const result = await write(alias, bytes, options);
    event(`verified:${alias}`);
    assert.equal(result.hash, file.finalHash);
    return result;
  };
  const receipt = f.store.commitReceipt.bind(f.store);
  if (['lost-response', 'committed-inspection-error'].includes(scenario.name)) {
    f.store.commitReceipt = async (...args) => {
      await receipt(...args);
      throw new Error('Synthetic receipt response lost');
    };
  }
  f.store.faultInjector = (point) => {
    event(`store:${point}`);
    if (scenario.name === point) throw new Error('Synthetic fault after durable commit');
  };
  const terminalAudit = f.store.ensureTerminalAudit.bind(f.store);
  f.store.ensureTerminalAudit = async (...args) => {
    event(`audit:${args[2]}:start`);
    if (scenario.name === 'terminal-audit-error' && args[2] === 'committed') {
      throw new Error('Synthetic terminal audit unavailable');
    }
    await terminalAudit(...args);
    event(`audit:${args[2]}:done`);
    if (scenario.name === 'after-terminal-audit' && args[2] === 'committed') {
      throw new Error('Synthetic response lost after terminal audit');
    }
  };
  for (const method of ['releaseLeaseInternal', 'applyRetentionInternal']) {
    const original = f.store[method].bind(f.store);
    f.store[method] = async (...args) => {
      event(method);
      return original(...args);
    };
  }
  let receiptRequest, inspections = 0;
  f.hooks.request = async (path, init) => {
    const action = path.includes('/backups/') ? `backups:${init.method || 'GET'}`
      : !init.method ? 'inspect' : path.split('/').at(-1);
    observed.requests.push({ action, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    event(`api:${action}`);
    if (action === 'receipt') {
      receiptRequest = init;
      assert.deepEqual(JSON.parse(init.body), {
        receipts: expected.map((file) => ({ alias: file.alias, hash: file.finalHash, size: file.after.length })),
      });
      if (!scenario.committed || scenario.name === 'late-commit') throw new Error('Synthetic unanswered receipt');
    }
    if (receiptRequest && action === 'inspect') {
      inspections++;
      if (['receipt-inspection-error', 'committed-inspection-error'].includes(scenario.name) ||
          scenario.name === 'terminal-record-inspection-error' && inspections === 2) {
        throw new Error('Synthetic receipt inspection unavailable');
      }
    }
    if (action === 'fail') {
      if (scenario.name === 'late-commit') {
        await receipt(run.context.environment.id, path.split('/')[3],
          receiptRequest.headers['X-Citadel-Authorization'], JSON.parse(receiptRequest.body));
        throw new Error('Synthetic failure record rejected after late commit');
      }
      if (scenario.name.startsWith('terminal-record')) throw new Error('Synthetic terminal record unavailable');
    }
  };
  return { expected, events: observed.events, requests: observed.requests, source: observed.source,
    destination: observed.destination, observation: observed };
}

async function assertDurableOperation(f, run, scenario, capture, id) {
  const { expected, events, requests, observation } = capture;
  assert.equal(observation.commits, 1, 'one operation, not a compensating or repeated mutation');
  const start = events.indexOf('api:prepare');
  const protocol = events.slice(start).filter((entry) => entry.startsWith('api:') ||
    /^(write-call|createWritable|write|close|published|verified|removeEntry):/.test(entry));
  assert.deepEqual(protocol, [
    'api:prepare', ...expected.filter((file) => !file.create).map(() => 'api:backups:PUT'),
    'api:authorize', 'api:committing',
    ...expected.flatMap((file) => ['write-call', 'createWritable', 'write', 'close', 'published', 'verified']
      .map((phase) => `${phase}:${file.alias}`)),
    'api:receipt', ...scenario.tail.map((action) => `api:${action}`),
  ]);
  const authorize = events.indexOf('api:authorize'), committing = events.indexOf('api:committing');
  for (const file of expected.filter((entry) => !entry.create)) {
    assert(events.slice(authorize + 1, committing).includes(`read:${file.alias}`), 'recheck after authorization');
  }
  assert.equal(f.trace.filter((entry) => entry.action === 'receipt').length, 1, 'no automatic receipt retry');
  assert.equal(f.trace.some((entry) => entry.action === 'rollback'), false);
  const row = await f.store.getTransaction(run.context.environment.id, id);
  assert.equal(row.status, scenario.committed ? 'committed' : scenario.failed ? 'failed' : 'committing');
  assert.equal(row.recoveryRequired, Boolean(scenario.failed));
  assert.equal(row.auditRecorded, Boolean((scenario.committed && !scenario.auditPending) || scenario.failed));
  assert.equal(row.targetLabel, run.action);
  assert.equal(row.targetId, run.context.projectId);
  assert.equal(row.environmentId, run.context.environment.id);
  assert.deepEqual(row.changedAliases, expected.map((file) => file.alias).sort());
  assert.deepEqual(row.changedNames, Object.fromEntries(expected.map((file) => [file.alias, [...file.changed].sort()])));
  assert.deepEqual(row.createdDirectories, expected[0].create ? [`${ACCESS_PATHS.root}/contracts`, CREATION_DIR] : []);
  assert.deepEqual(row.ownedCleanupDirectories, row.createdDirectories);
  assert.deepEqual(row.failedChangedAliases, scenario.failed ? row.changedAliases : undefined);
  assert.deepEqual(requests.find((entry) => entry.action === 'prepare').body, {
    environmentId: run.context.environment.id, environmentLabel: run.context.environment.label,
    targetId: run.context.projectId, targetLabel: run.action,
    changedAliases: expected.map((file) => file.alias),
    changedNames: Object.fromEntries(expected.map((file) => [file.alias, file.changed])),
    createdDirectories: row.createdDirectories,
    files: expected.map((file) => ({ alias: file.alias, existed: !file.create, hash: file.beforeHash,
      size: file.before?.length ?? 0 })),
  });
  assert.deepEqual(requests.find((entry) => entry.action === 'committing').body, {
    manifestHash: row.authorizedManifestHash,
    files: expected.map((file) => ({ alias: file.alias, originalHash: file.beforeHash,
      finalHash: file.finalHash, finalSize: file.after.length })),
  });
  for (const request of requests.filter((entry) => entry.action === 'fail')) {
    assert.deepEqual(request.body, { changedAliases: expected.map((file) => file.alias) },
      'failed receipt attribution is the exact attempted file set, not an empty rollback claim');
  }
  for (const file of expected) {
    const recorded = row.files.find((entry) => entry.alias === file.alias);
    assert.equal(recorded.existed, !file.create);
    assert.equal(recorded.originalHash, file.beforeHash);
    assert.equal(recorded.originalSize, file.before?.length ?? 0);
    assert.equal(recorded.finalHash, file.finalHash);
    assert.equal(recorded.finalSize, file.after.length);
    assert.equal(recorded.backupVerified, !file.create);
    assert.equal(recorded.receiptVerified, Boolean(scenario.committed));
    if (!file.create) {
      assert.deepEqual(new Uint8Array(await readFile(join(f.store.transactionRoot(row.environmentId, id),
        'files', `${recorded.id}.backup`))), file.before, 'durable backup is the exact original bytes');
    }
    assert.deepEqual((await run.context.provider.read(file.alias)).bytes, file.after);
  }
  const finalSnapshot = { ...capture.destination, ...Object.fromEntries(expected.map((file) => [file.alias, file.after])) };
  assert.deepEqual(sourceSnapshot(run.context.provider.root), finalSnapshot, 'unplanned source bytes are untouched');
  if (run.context.provider !== f.provider) assert.deepEqual(sourceSnapshot(f.root), capture.source, 'copy donor is read-only');
  const audit = (await readFile(f.store.auditPath(row.environmentId), 'utf8')).trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.transactionId === id);
  assert.deepEqual(audit.map((entry) => entry.event), [
    'prepared', 'authorized', 'committing', ...(row.auditRecorded ? [row.status] : []),
  ]);
  if (scenario.committed && !scenario.auditPending) {
    assert(events.indexOf('store:after-commit-manifest') < events.indexOf('audit:committed:done'));
    if (scenario.name !== 'after-terminal-audit') {
      assert(events.indexOf('audit:committed:done') < events.indexOf('releaseLeaseInternal'));
      assert(events.indexOf('releaseLeaseInternal') < events.indexOf('applyRetentionInternal'));
    }
  }
  const restarted = new TransactionStore({ dataRoot: f.dataRoot, getEnvironment: async (env) => f.environments.get(env) });
  await restarted.initialize();
  const persisted = await restarted.getTransaction(row.environmentId, id);
  assert.equal(persisted.status, row.status);
  assert.equal(persisted.recoveryRequired, !scenario.committed);
  assert.equal(persisted.auditRecorded, Boolean(scenario.committed || scenario.failed));
  assert.deepEqual(persisted.files, row.files);
  assert.deepEqual(persisted.changedNames, row.changedNames);
  const history = await restarted.history(row.environmentId);
  assert.deepEqual(history.map((entry) => entry.transactionId).sort(),
    [id, ...(run.priorTransactionId ? [run.priorTransactionId] : [])].sort());
  const coordinator = new LocalTransactionCoordinator({
    contextProvider: () => run.context,
    request: async (path) => {
      assert.equal(path, `/api/transactions/${id}?environmentId=${encodeURIComponent(row.environmentId)}`);
      return { transaction: await restarted.getTransaction(row.environmentId, id) };
    },
  });
  const inspection = await coordinator.inspect(id);
  assert.equal(inspection.canComplete, true);
  assert.equal(inspection.unconfirmedCreation, false);
  assert.deepEqual(inspection.files, persisted.files.map((file) => ({
    ...file, currentHash: file.finalHash, currentSize: file.finalSize, state: 'final',
  })));
  assert.deepEqual(sourceSnapshot(run.context.provider.root), finalSnapshot, 'restart inspection cannot rewrite source');
  const terminalEvents = (await readFile(restarted.auditPath(row.environmentId), 'utf8')).trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.transactionId === id && entry.event === 'committed');
  assert.equal(terminalEvents.length, scenario.committed ? 1 : 0, 'restart repairs, never duplicates, terminal audit');
  if (scenario.committed) await assert.rejects(readFile(restarted.leasePath(row.environmentId)), { code: 'ENOENT' });
  else assert.equal(JSON.parse(await readFile(restarted.leasePath(row.environmentId), 'utf8')).transactionId, id);
  return row;
}

for (const operation of ['parameter', 'policy', 'creation', 'copy', 'migration', 'restore']) {
  for (const scenario of receiptCases) {
    const interruption = scenario.name;
    const name = ['after-commit-manifest', 'lost-response'].includes(interruption)
      ? `Local receipt outcome: ${operation} retains committed bytes after ${interruption}`
      : `C1 Local ${operation}: ${interruption} preserves exact receipt, metadata and source bytes`;
    test(name, async (t) => {
      const f = await fixture(t, operation);
      const run = await prepareOperation(f, operation, t);
      const capture = await observeOperation(f, run, scenario);
      f.trace.length = 0;
      let result, failure;
      try { result = await run(); }
      catch (error) { failure = error; }
      const { planned, context } = capture.observation;
      const confirmed = scenario.committed && !scenario.unknown;
      const id = result?.transactionId || failure?.transactionId;
      assert.ok(id, failure?.stack || 'the caller retains the actual transaction identity even when delivery is unknown');
      const row = await assertDurableOperation(f, run, scenario, capture, id);
      if (!confirmed) {
        assert.equal(result, undefined);
        assert.deepEqual({ ...capture.observation.error }, {
          code: 'LOCAL_RECOVERY_REQUIRED', transactionId: id, applied: null, recoveryRequired: true,
        });
        assert.equal(mutationOutcome(failure), 'recovery-required');
        assert.equal(failure.applied, null);
        assert.equal(failure.recoveryRequired, true);
        assert.equal(failure.transactionId, id);
        assert.equal(failure.changed, undefined);
        assert.equal(failure.files, undefined);
        assert.equal(failure.created, undefined);
        assert.equal(failure.archived, undefined);
        assert.equal(failure.intended, undefined);
        assert.equal(failure.planned, undefined);
        const detail = capture.observation.error;
        assert.match(detail.message, /Source bytes were retained/);
        assert.match(detail.message, /[Ii]nspect History/);
        if (interruption.includes('inspection-error')) assert.match(detail.message, /Synthetic receipt inspection unavailable/);
        if (interruption.startsWith('terminal-record')) assert.match(detail.message, /Synthetic terminal record unavailable/);
        if (operation !== 'migration') assert.equal(failure, detail);
        else {
          assert.deepEqual({ ...failure }, { name: 'MigrationError', code: 'apply-recovery',
            transactionId: id, applied: null, recoveryRequired: true });
          assert.equal(failure.message, 'The local transaction outcome could not be confirmed. Source bytes were retained where ownership allowed; do not retry blindly. Open Settings > History to reconcile the receipt or recovery.');
        }
        return;
      }
      assert.equal(failure, undefined);
      const warnings = interruption === 'clean' ? [] : [CONFIRMED_WARNING, ...(scenario.auditPending ? [AUDIT_WARNING] : [])];
      const committed = {
        applied: true, transactionId: id,
        files: capture.expected.map((file) => ({ alias: file.alias, hash: file.finalHash })),
        ...(warnings.length ? { warnings } : {}),
      };
      assert.deepEqual(capture.observation.result, committed);
      const normalized = { ...committed, outcome: 'applied', changed: true };
      if (operation === 'migration') {
        assert.deepEqual(result, { transactionId: id, warnings, destination: run.destination, target: TARGET, copied: 1, changes: 1 });
      } else if (operation === 'creation') {
        assert.deepEqual(result, { ...normalized, id: 'contracts/receipt-creation', dir: CREATION_DIR,
          using: '../../main.bicep', created: capture.expected.map((file) => file.alias) });
      } else if (['parameter', 'policy'].includes(operation)) {
        assert.deepEqual(result, { ...normalized, path: capture.expected[0].alias, archived: id, hash: capture.expected[0].finalHash });
      } else assert.deepEqual(result, normalized);
      if (interruption !== 'clean') assert.ok(result.warnings.some((warning) => warning.includes('committed journal')));
      assert.equal(row.status, 'committed');
      assert.equal(row.recoveryRequired, false);
      for (const file of planned) {
        assert.deepEqual((await context.provider.read(file.alias)).bytes, new Uint8Array(file.after));
        assert.equal(row.files.find((entry) => entry.alias === file.alias).receiptVerified, true);
      }
      assert.equal(f.trace.some((entry) => ['rollback', 'fail'].includes(entry.action)), interruption === 'late-commit');
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
    const policyAfter = encode(`${two.text}\n`);
    const snapshot = sourceSnapshot(f.root), calls = [], order = [];
    const fileOne = await f.provider.fileHandle(one.alias);
    const revision = fileOne.modified;
    f.root.owner.trace.length = 0;
    f.root.owner.before = ({ operation, path }) => {
      if (['write', 'close', 'removeEntry'].includes(operation)) order.push(`${operation}:${path}`);
    };
    const write = f.provider.write.bind(f.provider);
    f.provider.write = async (alias, bytes, options) => {
      calls.push({ alias, bytes: new Uint8Array(bytes), expectedHash: options.expectedHash, finalHash: options.finalHash });
      if (alias === two.alias) {
        order.push('rejected-second-write');
        if (phase === 'foreign-write') {
          (await f.provider.fileHandle(one.alias)).change('// external bytes\n');
          order.push('external-change');
        }
        throw new Error('Synthetic write failure');
      }
      return write(alias, bytes, options);
    };
    f.hooks.request = (path, init) => {
      order.push(path.includes('/backups/') ? `backup:${init.method || 'GET'}` : path.split('/').at(-1));
      if (phase === 'before-write' && path.includes('/backups/') && init.method === 'PUT') throw new Error('Synthetic backup failure');
      if (path.endsWith('/rollback') || path.endsWith('/fail')) throw new Error('Synthetic terminal record rejected');
    };
    let transactionId;
    await assert.rejects(f.coordinator.commit([
      { alias: one.alias, before: one.bytes, beforeHash: one.hash, after: next },
      { alias: two.alias, before: two.bytes, beforeHash: two.hash, after: policyAfter },
    ], { action: 'parameter-edit', context: f.context }), (error) => {
      transactionId = error.transactionId;
      assert.deepEqual({ ...error }, { code: 'LOCAL_RECOVERY_REQUIRED', transactionId,
        applied: null, recoveryRequired: true });
      assert.equal(error.code, 'LOCAL_RECOVERY_REQUIRED');
      assert.match(error.message, /Synthetic (?:backup|write) failure/);
      assert.match(error.message, /Synthetic terminal record rejected/);
      assert.match(error.message, /Inspect History/);
      return true;
    });
    assert.deepEqual((await f.provider.read(two.alias)).bytes, two.bytes);
    assert.deepEqual((await f.provider.read(one.alias)).bytes, phase === 'foreign-write' ? encode('// external bytes\n') : one.bytes);
    const nextHash = await sha256(next);
    assert.deepEqual(calls, phase === 'before-write' ? [] : [
      { alias: one.alias, bytes: next, expectedHash: one.hash, finalHash: nextHash },
      { alias: two.alias, bytes: policyAfter, expectedHash: two.hash, finalHash: await sha256(policyAfter) },
      ...(phase === 'partial-write'
        ? [{ alias: one.alias, bytes: one.bytes, expectedHash: nextHash, finalHash: one.hash }] : []),
    ]);
    assert.deepEqual(order, phase === 'before-write' ? ['prepare', 'backup:PUT', 'fail'] : [
      'prepare', 'backup:PUT', 'backup:PUT', 'authorize', 'committing',
      `write:${one.alias}`, `close:${one.alias}`, 'rejected-second-write',
      ...(phase === 'foreign-write' ? ['external-change', 'fail']
        : ['backup:GET', `write:${one.alias}`, `close:${one.alias}`, 'rollback']),
    ]);
    assert.equal(f.trace.some((entry) => entry.action === 'receipt'), false, 'this is exclusively the pre-receipt rollback path');
    assert.equal(fileOne.modified, revision + (phase === 'before-write' ? 0 : 2));
    const final = { ...snapshot, [one.alias]: phase === 'foreign-write' ? encode('// external bytes\n') : one.bytes };
    assert.deepEqual(sourceSnapshot(f.root), final);
    const row = await f.store.getTransaction(f.environment.id, transactionId);
    assert.equal(row.status, phase === 'before-write' ? 'preparing' : 'committing');
    assert.equal(row.recoveryRequired, false, 'the rejected terminal record has not changed the durable journal yet');
    assert.deepEqual(row.changedAliases, [two.alias, one.alias].sort());
    assert(row.files.every((file) => file.receiptVerified === false));
    assert(row.files.every((file) => file.backupVerified === (phase !== 'before-write')));
    for (const file of row.files) {
      const original = file.alias === one.alias ? one : two;
      assert.equal(file.originalHash, original.hash);
      assert.equal(file.originalSize, original.bytes.length);
      if (phase !== 'before-write') {
        assert.deepEqual(new Uint8Array(await readFile(join(f.store.transactionRoot(f.environment.id, transactionId),
          'files', `${file.id}.backup`))), original.bytes);
      }
    }
    const restarted = new TransactionStore({ dataRoot: f.dataRoot, getEnvironment: async (id) => f.environments.get(id) });
    await restarted.initialize();
    const persisted = await restarted.getTransaction(f.environment.id, transactionId);
    assert.equal(persisted.status, phase === 'before-write' ? 'abandoned' : 'committing');
    assert.equal(persisted.recoveryRequired, phase !== 'before-write');
    assert.deepEqual(persisted.files, row.files);
    assert.deepEqual(sourceSnapshot(f.root), final, 'restart never restores over foreign bytes');
  });
}

for (const operation of ['parameter', 'policy']) {
  test(`C1 Local ${operation}: an unchanged edit has no planned mutation or receipt`, async (t) => {
    const f = await fixture(t);
    const alias = operation === 'parameter' ? TARGET : ACCESS_PATHS.policy;
    const source = await f.provider.read(alias), before = sourceSnapshot(f.root);
    const result = operation === 'parameter'
      ? await f.service.save(alias, [edit('environmentName', 'dev')], source.hash)
      : await f.service.savePolicy({ path: alias, text: source.text, expectedHash: source.hash });
    assert.deepEqual(result, { path: alias, applied: false, outcome: 'unchanged', changed: false, archived: null });
    assert.equal(mutationOutcome(result), 'unchanged');
    assert.deepEqual(f.trace, []);
    assert.deepEqual(await f.store.history(f.environment.id), []);
    assert.deepEqual(sourceSnapshot(f.root), before);
    assert.equal(f.root.owner.trace.some((entry) => ['write', 'close', 'removeEntry'].includes(entry.operation)), false);
  });
}
