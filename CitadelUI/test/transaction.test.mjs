import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { atomicWrite, normalizeSourceAlias, TransactionStore } from '../server/transactions.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-transactions-'));
  const store = new TransactionStore({ dataRoot: root, ...options });
  await store.initialize();
  return { root, store };
}

function proposal(bytes, overrides = {}) {
  return {
    environmentId: 'env-one',
    environmentLabel: 'Development',
    targetId: 'gateway',
    targetLabel: 'Gateway',
    changedAliases: ['bicep/main.bicepparam'],
    files: [
      {
        alias: 'bicep/main.bicepparam',
        existed: true,
        size: bytes.length,
        hash: hash(bytes),
      },
    ],
    ...overrides,
  };
}

async function prepareBackedUp(store, bytes) {
  const prepared = await store.prepare(proposal(bytes));
  const file = prepared.transaction.files[0];
  await store.uploadBackup(
    'env-one',
    prepared.transaction.transactionId,
    file.id,
    prepared.transactionToken,
    file.originalHash,
    bytes
  );
  return prepared;
}

test('atomic writes remove temp files and preserve destinations on pre-rename failures', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'atomic.json');
  const original = Buffer.from('original');
  await atomicWrite(destination, original);
  const preparing = await store.prepare(proposal(Buffer.from('param count = 1\n')));

  for (const stage of ['write', 'sync', 'rename']) {
    await assert.rejects(
      atomicWrite(destination, Buffer.from(`replacement-${stage}`), {
        faultInjector(current) {
          if (current === stage) {
            throw Object.assign(new Error(`injected ENOSPC at ${stage}`), { code: 'ENOSPC' });
          }
        },
      }),
      (error) => error.code === 'ENOSPC'
    );
    assert.equal((await readFile(destination, 'utf8')), 'original');
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith('.') && name.endsWith('.tmp')),
      false,
      `${stage} left an atomic-write temp file`
    );
  }

  const restarted = new TransactionStore({ dataRoot: root });
  await restarted.initialize();
  assert.equal(
    (await restarted.getTransaction('env-one', preparing.transaction.transactionId)).status,
    'abandoned'
  );
});

test('strict source aliases reject host paths, traversal, .azure, and environment files', () => {
  assert.equal(normalizeSourceAlias('bicep/main.bicepparam'), 'bicep/main.bicepparam');
  for (const alias of [
    '/host/main.bicepparam',
    'C:/host/main.bicepparam',
    '../main.bicepparam',
    'bicep/.azure/main.bicepparam',
    '.env',
    'folder/.env.local',
    'bicep/readme.md',
    'bicep\\main.bicepparam',
  ]) {
    assert.throws(() => normalizeSourceAlias(alias));
  }
});

test('created-directory metadata accepts only relative ancestors of new sources', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias =
    'bicep/infra/citadel-access-contracts/contracts/qa-alpha/main.bicepparam';
  const base = {
    environmentId: 'env-one',
    targetId: 'gateway',
    targetLabel: 'contract-create',
    changedAliases: [alias],
    files: [{ alias, existed: false, size: 0, hash: null }],
  };
  for (const createdDirectories of [
    ['C:/host/contracts'],
    ['/host/contracts'],
    ['../contracts'],
    ['bicep/infra/unrelated'],
    ['bicep/.azure/contracts'],
  ]) {
    await assert.rejects(
      store.prepare({ ...base, createdDirectories }),
      (error) =>
        error.code === 'INVALID_DIRECTORY_ALIAS' ||
        error.code === 'INVALID_CREATED_DIRECTORY' ||
        error.code === 'EXCLUDED_ALIAS'
    );
  }

  const prepared = await store.prepare({
    ...base,
    createdDirectories: [
      'bicep/infra/citadel-access-contracts/contracts',
      'bicep/infra/citadel-access-contracts/contracts/qa-alpha',
    ],
  });
  assert.deepEqual(prepared.transaction.createdDirectories, [
    'bicep/infra/citadel-access-contracts/contracts',
    'bicep/infra/citadel-access-contracts/contracts/qa-alpha',
  ]);
  await store.abandon('env-one', prepared.transaction.transactionId, prepared.transactionToken);
});

test('authorization requires a durably verified original backup and rejects stale hashes and tokens', async (t) => {
  const original = Buffer.from("param apiKey = 'TOP-SECRET-VALUE'\n");
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const prepared = await store.prepare(
    proposal(original, {
      changedNames: {
        'bicep/main.bicepparam': ['jwtRequired', 'apiKey', 'apiKey'],
      },
    })
  );
  const { transactionId } = prepared.transaction;
  const file = prepared.transaction.files[0];

  await assert.rejects(
    store.authorize('env-one', transactionId, prepared.transactionToken),
    (error) => error.code === 'BACKUPS_INCOMPLETE'
  );
  await assert.rejects(
    store.uploadBackup(
      'env-one',
      transactionId,
      file.id,
      'stale-token',
      file.originalHash,
      original
    ),
    (error) => error.code === 'INVALID_TRANSACTION_TOKEN'
  );
  await assert.rejects(
    store.uploadBackup(
      'env-one',
      transactionId,
      file.id,
      prepared.transactionToken,
      '0'.repeat(64),
      original
    ),
    (error) => error.code === 'STALE_ORIGINAL_HASH'
  );

  await store.uploadBackup(
    'env-one',
    transactionId,
    file.id,
    prepared.transactionToken,
    file.originalHash,
    original
  );
  const authorization = await store.authorize(
    'env-one',
    transactionId,
    prepared.transactionToken
  );
  assert.equal(authorization.status, 'authorized');
  assert.equal(authorization.manifestHash.length, 64);
  assert.ok(authorization.authorizationToken.length >= 43);

  const backup = await store.getBackup(
    'env-one',
    transactionId,
    file.id,
    prepared.transactionToken
  );
  assert.deepEqual(backup.bytes, original);

  const journalRoot = join(root, 'environments', 'env-one');
  const manifestText = await readFile(join(journalRoot, 'transactions', transactionId, 'manifest.json'), 'utf8');
  const auditText = await readFile(join(journalRoot, 'audit.jsonl'), 'utf8');
  const secretText = await readFile(join(journalRoot, 'transactions', transactionId, 'secret.json'), 'utf8');
  for (const metadata of [manifestText, auditText, secretText]) {
    assert.equal(metadata.includes('TOP-SECRET-VALUE'), false);
    assert.equal(metadata.includes(original.toString('base64')), false);
    assert.equal(metadata.includes(root), false);
    assert.equal(metadata.includes(prepared.transactionToken), false);
    assert.equal(metadata.includes(authorization.authorizationToken), false);
  }
  assert.deepEqual(JSON.parse(manifestText).changedNames, {
    'bicep/main.bicepparam': ['apiKey', 'jwtRequired'],
  });
  assert.deepEqual(JSON.parse(auditText.trim().split('\n')[0]).changedNames, {
    'bicep/main.bicepparam': ['apiKey', 'jwtRequired'],
  });
  assert.deepEqual(
    await readFile(join(journalRoot, 'transactions', transactionId, 'files', `${file.id}.backup`)),
    original
  );
});

test('changed names accept flat or per-alias metadata and reject unsafe value-like strings', async (t) => {
  const original = Buffer.from('param enabled = false\n');
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const flat = await store.prepare(
    proposal(original, { changedNames: ['enabled', 'contentSafety.Hate', 'enabled'] })
  );
  assert.deepEqual(flat.transaction.changedNames, ['contentSafety.Hate', 'enabled']);
  await store.abandon('env-one', flat.transaction.transactionId, flat.transactionToken);

  for (const changedNames of [
    ['enabled=TOP-SECRET'],
    ['contains spaces'],
    ['x'.repeat(129)],
    { 'other/file.bicepparam': ['enabled'] },
    { 'bicep/main.bicepparam': Array.from({ length: 101 }, (_, index) => `name${index}`) },
  ]) {
    await assert.rejects(
      store.prepare(proposal(original, { changedNames })),
      (error) =>
        error.code === 'INVALID_CHANGED_NAME' ||
        error.code === 'INVALID_CHANGED_NAMES' ||
        error.code === 'UNKNOWN_CHANGED_NAME_ALIAS'
    );
  }
});

test('commit protocol rejects stale plans and receipts, then records a hash-chained audit', async (t) => {
  const original = Buffer.from("param enabled = false\n");
  const final = Buffer.from("param enabled = true\n");
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const prepared = await prepareBackedUp(store, original);
  const { transactionId } = prepared.transaction;
  const authorization = await store.authorize(
    'env-one',
    transactionId,
    prepared.transactionToken
  );
  const commitFiles = [
    {
      alias: 'bicep/main.bicepparam',
      originalHash: hash(original),
      finalHash: hash(final),
      finalSize: final.length,
    },
  ];

  await assert.rejects(
    store.beginCommit('env-one', transactionId, authorization.authorizationToken, {
      manifestHash: '0'.repeat(64),
      files: commitFiles,
    }),
    (error) => error.code === 'STALE_MANIFEST_HASH'
  );
  await assert.rejects(
    store.beginCommit('env-one', transactionId, 'stale-authorization', {
      manifestHash: authorization.manifestHash,
      files: commitFiles,
    }),
    (error) => error.code === 'INVALID_AUTHORIZATION_TOKEN'
  );
  await store.beginCommit('env-one', transactionId, authorization.authorizationToken, {
    manifestHash: authorization.manifestHash,
    files: commitFiles,
  });

  await assert.rejects(
    store.commitReceipt('env-one', transactionId, authorization.authorizationToken, {
      receipts: [
        {
          alias: 'bicep/main.bicepparam',
          hash: hash(original),
          size: original.length,
        },
      ],
    }),
    (error) => error.code === 'FINAL_RECEIPT_FAILED'
  );
  const committed = await store.commitReceipt(
    'env-one',
    transactionId,
    authorization.authorizationToken,
    {
      receipts: [
        {
          alias: 'bicep/main.bicepparam',
          hash: hash(final),
          size: final.length,
        },
      ],
    }
  );
  assert.equal(committed.status, 'committed');

  const lines = (await readFile(join(root, 'environments', 'env-one', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(lines.map((entry) => entry.event), [
    'prepared',
    'authorized',
    'committing',
    'committed',
  ]);
  for (let index = 0; index < lines.length; index += 1) {
    const { hash: entryHash, ...entry } = lines[index];
    assert.equal(hash(JSON.stringify(entry)), entryHash);
    assert.equal(entry.previousHash, index ? lines[index - 1].hash : '0'.repeat(64));
  }
});

test('a stale preparing lease is abandoned, while a committing lease blocks new work', async (t) => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const original = Buffer.from('param count = 1\n');
  const { root, store } = await fixture({ now: () => now, leaseTtlMs: 1000 });
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await store.prepare(proposal(original));
  await assert.rejects(store.prepare(proposal(original)), (error) => error.code === 'ENVIRONMENT_LEASED');
  now += 1001;
  const second = await store.prepare(proposal(original));
  assert.equal((await store.getTransaction('env-one', first.transaction.transactionId)).status, 'abandoned');
  await store.abandon('env-one', second.transaction.transactionId, second.transactionToken);

  const committing = await prepareBackedUp(store, original);
  const authorization = await store.authorize(
    'env-one',
    committing.transaction.transactionId,
    committing.transactionToken
  );
  const final = Buffer.from('param count = 2\n');
  await store.beginCommit(
    'env-one',
    committing.transaction.transactionId,
    authorization.authorizationToken,
    {
      manifestHash: authorization.manifestHash,
      files: [
        {
          alias: 'bicep/main.bicepparam',
          originalHash: hash(original),
          finalHash: hash(final),
          finalSize: final.length,
        },
      ],
    }
  );
  now += 1001;
  await assert.rejects(
    store.prepare(proposal(original)),
    (error) => error.code === 'ENVIRONMENT_RECOVERY_REQUIRED'
  );
});

test('startup recovery abandons preparing work and preserves committing work for recovery', async (t) => {
  const original = Buffer.from('param count = 1\n');
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const preparing = await store.prepare(proposal(original));
  const restarted = new TransactionStore({ dataRoot: root });
  await restarted.initialize();
  assert.equal(
    (await restarted.getTransaction('env-one', preparing.transaction.transactionId)).status,
    'abandoned'
  );

  const committing = await prepareBackedUp(restarted, original);
  const authorization = await restarted.authorize(
    'env-one',
    committing.transaction.transactionId,
    committing.transactionToken
  );
  const final = Buffer.from('param count = 2\n');
  await restarted.beginCommit(
    'env-one',
    committing.transaction.transactionId,
    authorization.authorizationToken,
    {
      manifestHash: authorization.manifestHash,
      files: [
        {
          alias: 'bicep/main.bicepparam',
          originalHash: hash(original),
          finalHash: hash(final),
          finalSize: final.length,
        },
      ],
    }
  );

  const recovered = new TransactionStore({ dataRoot: root });
  await recovered.initialize();
  const detail = await recovered.getTransaction('env-one', committing.transaction.transactionId);
  assert.equal(detail.status, 'committing');
  assert.equal(detail.recoveryRequired, true);
  const backup = await recovered.getBackup(
    'env-one',
    committing.transaction.transactionId,
    detail.files[0].id,
    committing.transactionToken
  );
  assert.deepEqual(backup.bytes, original);
});

test('recovery rotates short-lived credentials only for recovery-required transactions', async (t) => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const original = Buffer.from('param count = 1\n');
  const final = Buffer.from('param count = 2\n');
  const { root, store } = await fixture({
    now: () => now,
    recoveryTokenTtlMs: 1000,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const preparing = await store.prepare(proposal(original));
  await assert.rejects(
    store.recover('env-one', preparing.transaction.transactionId),
    (error) => error.code === 'RECOVERY_NOT_REQUIRED'
  );
  await store.abandon(
    'env-one',
    preparing.transaction.transactionId,
    preparing.transactionToken
  );

  const committing = await prepareBackedUp(store, original);
  const initialAuthorization = await store.authorize(
    'env-one',
    committing.transaction.transactionId,
    committing.transactionToken
  );
  await store.beginCommit(
    'env-one',
    committing.transaction.transactionId,
    initialAuthorization.authorizationToken,
    {
      manifestHash: initialAuthorization.manifestHash,
      files: [
        {
          alias: 'bicep/main.bicepparam',
          originalHash: hash(original),
          finalHash: hash(final),
          finalSize: final.length,
        },
      ],
    }
  );
  await assert.rejects(
    store.recover('env-one', committing.transaction.transactionId),
    (error) => error.code === 'RECOVERY_NOT_REQUIRED'
  );

  const restarted = new TransactionStore({
    dataRoot: root,
    now: () => now,
    recoveryTokenTtlMs: 1000,
  });
  await restarted.initialize();
  const recovery = await restarted.recover(
    'env-one',
    committing.transaction.transactionId
  );
  assert.equal(recovery.status, 'committing');
  assert.equal(recovery.recoveryRequired, true);
  assert.equal(recovery.expiresAt, new Date(now + 1000).toISOString());
  const recoveryAudit = await readFile(
    join(root, 'environments', 'env-one', 'audit.jsonl'),
    'utf8'
  );
  assert.equal(recoveryAudit.includes(recovery.transactionToken), false);
  assert.equal(recoveryAudit.includes(recovery.authorizationToken), false);

  await assert.rejects(
    restarted.getBackup(
      'env-one',
      committing.transaction.transactionId,
      committing.transaction.files[0].id,
      committing.transactionToken
    ),
    (error) => error.code === 'INVALID_TRANSACTION_TOKEN'
  );
  await assert.rejects(
    restarted.commitReceipt(
      'env-one',
      committing.transaction.transactionId,
      initialAuthorization.authorizationToken,
      {
        receipts: [
          { alias: 'bicep/main.bicepparam', hash: hash(final), size: final.length },
        ],
      }
    ),
    (error) => error.code === 'INVALID_AUTHORIZATION_TOKEN'
  );
  const backup = await restarted.getBackup(
    'env-one',
    committing.transaction.transactionId,
    committing.transaction.files[0].id,
    recovery.transactionToken
  );
  assert.deepEqual(backup.bytes, original);

  now += 1001;
  await assert.rejects(
    restarted.commitReceipt(
      'env-one',
      committing.transaction.transactionId,
      recovery.authorizationToken,
      {
        receipts: [
          { alias: 'bicep/main.bicepparam', hash: hash(final), size: final.length },
        ],
      }
    ),
    (error) => error.code === 'EXPIRED_AUTHORIZATION_TOKEN'
  );

  const refreshed = await restarted.recover(
    'env-one',
    committing.transaction.transactionId
  );
  const committed = await restarted.commitReceipt(
    'env-one',
    committing.transaction.transactionId,
    refreshed.authorizationToken,
    {
      receipts: [
        { alias: 'bicep/main.bicepparam', hash: hash(final), size: final.length },
      ],
    }
  );
  assert.equal(committed.status, 'committed');
  await assert.rejects(
    restarted.recover('env-one', committing.transaction.transactionId),
    (error) => error.code === 'RECOVERY_NOT_REQUIRED'
  );

  const failed = await prepareBackedUp(restarted, original);
  const failedAuthorization = await restarted.authorize(
    'env-one',
    failed.transaction.transactionId,
    failed.transactionToken
  );
  await restarted.beginCommit(
    'env-one',
    failed.transaction.transactionId,
    failedAuthorization.authorizationToken,
    {
      manifestHash: failedAuthorization.manifestHash,
      files: [
        {
          alias: 'bicep/main.bicepparam',
          originalHash: hash(original),
          finalHash: hash(final),
          finalSize: final.length,
        },
      ],
    }
  );
  await restarted.fail('env-one', failed.transaction.transactionId, failed.transactionToken, {
    changedAliases: ['bicep/main.bicepparam'],
  });
  const failedRecovery = await restarted.recover(
    'env-one',
    failed.transaction.transactionId
  );
  assert.equal(failedRecovery.status, 'failed');
  const rolledBack = await restarted.rollback(
    'env-one',
    failed.transaction.transactionId,
    failedRecovery.transactionToken,
    {
      receipts: [
        { alias: 'bicep/main.bicepparam', hash: hash(original), size: original.length },
      ],
    }
  );
  assert.equal(rolledBack.status, 'rolled_back');
});

test('history restore tokens provide short-lived read-only access without changing status or lease', async (t) => {
  let now = Date.parse('2026-02-01T00:00:00.000Z');
  const original = Buffer.from('param count = 1\n');
  const final = Buffer.from('param count = 2\n');
  const { root, store } = await fixture({
    now: () => now,
    backupReadTokenTtlMs: 1000,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const prepared = await prepareBackedUp(store, original);
  await assert.rejects(
    store.issueRestoreToken('env-one', prepared.transaction.transactionId),
    (error) => error.code === 'RESTORE_TOKEN_NOT_ALLOWED'
  );
  const authorization = await store.authorize(
    'env-one',
    prepared.transaction.transactionId,
    prepared.transactionToken
  );
  await store.beginCommit(
    'env-one',
    prepared.transaction.transactionId,
    authorization.authorizationToken,
    {
      manifestHash: authorization.manifestHash,
      files: [
        {
          alias: 'bicep/main.bicepparam',
          originalHash: hash(original),
          finalHash: hash(final),
          finalSize: final.length,
        },
      ],
    }
  );
  await store.commitReceipt(
    'env-one',
    prepared.transaction.transactionId,
    authorization.authorizationToken,
    {
      receipts: [
        { alias: 'bicep/main.bicepparam', hash: hash(final), size: final.length },
      ],
    }
  );

  const first = await store.issueRestoreToken('env-one', prepared.transaction.transactionId);
  assert.equal(first.status, 'committed');
  assert.equal(first.expiresAt, new Date(now + 1000).toISOString());
  const restored = await store.getBackupForRestore(
    'env-one',
    prepared.transaction.transactionId,
    prepared.transaction.files[0].id,
    first.backupReadToken
  );
  assert.deepEqual(restored.bytes, original);

  const second = await store.issueRestoreToken('env-one', prepared.transaction.transactionId);
  await assert.rejects(
    store.getBackupForRestore(
      'env-one',
      prepared.transaction.transactionId,
      prepared.transaction.files[0].id,
      first.backupReadToken
    ),
    (error) => error.code === 'INVALID_BACKUP_READ_TOKEN'
  );
  now += 1001;
  await assert.rejects(
    store.getBackupForRestore(
      'env-one',
      prepared.transaction.transactionId,
      prepared.transaction.files[0].id,
      second.backupReadToken
    ),
    (error) => error.code === 'EXPIRED_BACKUP_READ_TOKEN'
  );

  const detail = await store.getTransaction('env-one', prepared.transaction.transactionId);
  assert.equal(detail.status, 'committed');
  assert.equal(detail.recoveryRequired, false);
  await assert.rejects(
    stat(join(root, 'environments', 'env-one', 'lease.json')),
    (error) => error.code === 'ENOENT'
  );
  const audit = await readFile(join(root, 'environments', 'env-one', 'audit.jsonl'), 'utf8');
  assert.equal(audit.includes(first.backupReadToken), false);
  assert.equal(audit.includes(second.backupReadToken), false);
});

test('rollback receipts restore original hashes and account for newly created files', async (t) => {
  const original = Buffer.from('param count = 1\n');
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const changedAliases = ['bicep/main.bicepparam', 'policies/new.xml'];
  const prepared = await store.prepare(
    proposal(original, {
      changedAliases,
      files: [
        {
          alias: 'bicep/main.bicepparam',
          existed: true,
          size: original.length,
          hash: hash(original),
        },
        { alias: 'policies/new.xml', existed: false, size: 0, hash: null },
      ],
    })
  );
  await store.uploadBackup(
    'env-one',
    prepared.transaction.transactionId,
    prepared.transaction.files[0].id,
    prepared.transactionToken,
    hash(original),
    original
  );
  const authorization = await store.authorize(
    'env-one',
    prepared.transaction.transactionId,
    prepared.transactionToken
  );
  const final = Buffer.from('param count = 2\n');
  const xml = Buffer.from('<policies />');
  await store.beginCommit(
    'env-one',
    prepared.transaction.transactionId,
    authorization.authorizationToken,
    {
      manifestHash: authorization.manifestHash,
      files: [
        {
          alias: 'bicep/main.bicepparam',
          originalHash: hash(original),
          finalHash: hash(final),
          finalSize: final.length,
        },
        {
          alias: 'policies/new.xml',
          originalHash: null,
          finalHash: hash(xml),
          finalSize: xml.length,
        },
      ],
    }
  );
  const rolledBack = await store.rollback(
    'env-one',
    prepared.transaction.transactionId,
    prepared.transactionToken,
    {
      receipts: [
        { alias: 'bicep/main.bicepparam', hash: hash(original), size: original.length },
        { alias: 'policies/new.xml', removed: true },
      ],
    }
  );
  assert.equal(rolledBack.status, 'rolled_back');
  const restoreAccess = await store.issueRestoreToken(
    'env-one',
    prepared.transaction.transactionId
  );
  const historicalBackup = await store.getBackupForRestore(
    'env-one',
    prepared.transaction.transactionId,
    prepared.transaction.files[0].id,
    restoreAccess.backupReadToken
  );
  assert.deepEqual(historicalBackup.bytes, original);
});

test('committed contract creation enters a recoverable revert and records removal', async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const parameter = Buffer.from("using '../../main.bicep'\n");
  const policy = Buffer.from('<policies />\n');
  const aliases = [
    'bicep/infra/citadel-access-contracts/contracts/qa-alpha/main.bicepparam',
    'bicep/infra/citadel-access-contracts/contracts/qa-alpha/ai-product-policy.xml',
  ];
  const prepared = await store.prepare({
    environmentId: 'env-one',
    environmentLabel: 'Production copy',
    targetId: 'gateway',
    targetLabel: 'contract-create',
    changedAliases: aliases,
    changedNames: Object.fromEntries(aliases.map((alias) => [alias, ['policyXml']])),
    files: aliases.map((alias) => ({ alias, existed: false, size: 0, hash: null })),
  });
  const authorization = await store.authorize(
    'env-one',
    prepared.transaction.transactionId,
    prepared.transactionToken
  );
  await store.beginCommit(
    'env-one',
    prepared.transaction.transactionId,
    authorization.authorizationToken,
    {
      manifestHash: authorization.manifestHash,
      files: [
        {
          alias: aliases[0],
          originalHash: null,
          finalHash: hash(parameter),
          finalSize: parameter.length,
        },
        {
          alias: aliases[1],
          originalHash: null,
          finalHash: hash(policy),
          finalSize: policy.length,
        },
      ],
    }
  );
  await store.commitReceipt(
    'env-one',
    prepared.transaction.transactionId,
    authorization.authorizationToken,
    {
      receipts: [
        { alias: aliases[0], hash: hash(parameter), size: parameter.length },
        { alias: aliases[1], hash: hash(policy), size: policy.length },
      ],
    }
  );

  const revert = await store.beginRevert(
    'env-one',
    prepared.transaction.transactionId
  );
  assert.equal(revert.status, 'reverting');
  assert.equal(revert.recoveryRequired, true);
  assert.deepEqual(revert.files.map((file) => file.finalHash), [hash(parameter), hash(policy)]);
  await assert.rejects(
    () => store.beginRevert('env-one', prepared.transaction.transactionId),
    (error) => error.code === 'CREATION_REVERT_NOT_ALLOWED'
  );

  const recovered = await store.recover('env-one', prepared.transaction.transactionId);
  const removed = await store.rollback(
    'env-one',
    prepared.transaction.transactionId,
    recovered.transactionToken,
    {
      receipts: aliases.map((alias) => ({ alias, removed: true })),
    }
  );
  assert.equal(removed.status, 'rolled_back');
  const detail = await store.getTransaction('env-one', prepared.transaction.transactionId);
  assert.equal(detail.status, 'rolled_back');
  assert.equal(detail.recoveryRequired, false);
  const audit = (await readFile(join(root, 'environments', 'env-one', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.ok(audit.some((entry) => entry.event === 'reverting'));
  assert.ok(audit.some((entry) => entry.event === 'recovery_tokens_rotated'));
  assert.ok(audit.some((entry) => entry.event === 'rolled_back'));
  assert.equal(audit.some((entry) => JSON.stringify(entry).includes(revert.transactionToken)), false);

  const unrelatedAlias = 'bicep/unrelated.xml';
  const unrelated = await store.prepare({
    environmentId: 'env-one',
    targetId: 'gateway',
    targetLabel: 'contract-create',
    changedAliases: [unrelatedAlias],
    files: [{ alias: unrelatedAlias, existed: false, size: 0, hash: null }],
  });
  const unrelatedAuthorization = await store.authorize(
    'env-one',
    unrelated.transaction.transactionId,
    unrelated.transactionToken
  );
  await store.beginCommit(
    'env-one',
    unrelated.transaction.transactionId,
    unrelatedAuthorization.authorizationToken,
    {
      manifestHash: unrelatedAuthorization.manifestHash,
      files: [{
        alias: unrelatedAlias,
        originalHash: null,
        finalHash: hash(policy),
        finalSize: policy.length,
      }],
    }
  );
  await store.commitReceipt(
    'env-one',
    unrelated.transaction.transactionId,
    unrelatedAuthorization.authorizationToken,
    { receipts: [{ alias: unrelatedAlias, hash: hash(policy), size: policy.length }] }
  );
  await assert.rejects(
    () => store.beginRevert('env-one', unrelated.transaction.transactionId),
    (error) => error.code === 'CREATION_REVERT_NOT_ALLOWED'
  );
});

test('startup marks interrupted contract removal recoverable', async (t) => {
  let failRevert = true;
  const { root, store } = await fixture({
    faultInjector(stage) {
      if (stage === 'after-revert-manifest' && failRevert) {
        failRevert = false;
        throw new Error('injected interrupted removal');
      }
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const final = Buffer.from('<policies />');
  const alias =
    'bicep/infra/citadel-access-contracts/contracts/qa-alpha/ai-product-policy.xml';
  const prepared = await store.prepare({
    environmentId: 'env-one',
    environmentLabel: 'Production copy',
    targetId: 'gateway',
    targetLabel: 'contract-create',
    changedAliases: [alias],
    files: [{ alias, existed: false, size: 0, hash: null }],
  });
  const authorization = await store.authorize(
    'env-one',
    prepared.transaction.transactionId,
    prepared.transactionToken
  );
  await store.beginCommit(
    'env-one',
    prepared.transaction.transactionId,
    authorization.authorizationToken,
    {
      manifestHash: authorization.manifestHash,
      files: [{ alias, originalHash: null, finalHash: hash(final), finalSize: final.length }],
    }
  );
  await store.commitReceipt(
    'env-one',
    prepared.transaction.transactionId,
    authorization.authorizationToken,
    { receipts: [{ alias, hash: hash(final), size: final.length }] }
  );
  await assert.rejects(
    () => store.beginRevert('env-one', prepared.transaction.transactionId),
    /injected interrupted removal/
  );

  const restarted = new TransactionStore({ dataRoot: root });
  await restarted.initialize();
  const detail = await restarted.getTransaction(
    'env-one',
    prepared.transaction.transactionId
  );
  assert.equal(detail.status, 'reverting');
  assert.equal(detail.recoveryRequired, true);
  const credentials = await restarted.recover(
    'env-one',
    prepared.transaction.transactionId
  );
  const result = await restarted.rollback(
    'env-one',
    prepared.transaction.transactionId,
    credentials.transactionToken,
    { receipts: [{ alias, removed: true }] }
  );
  assert.equal(result.status, 'rolled_back');
});

test('faults after backup and commit durability are recovered without false authorization or lost commit', async (t) => {
  const original = Buffer.from('param count = 1\n');
  let faultStage = 'after-backup-write';
  const { root, store } = await fixture({
    faultInjector(stage) {
      if (stage === faultStage) throw new Error(`injected ${stage}`);
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const prepared = await store.prepare(proposal(original));
  await assert.rejects(
    store.uploadBackup(
      'env-one',
      prepared.transaction.transactionId,
      prepared.transaction.files[0].id,
      prepared.transactionToken,
      hash(original),
      original
    ),
    /injected/
  );
  const afterBackupCrash = new TransactionStore({ dataRoot: root });
  await afterBackupCrash.initialize();
  const abandoned = await afterBackupCrash.getTransaction(
    'env-one',
    prepared.transaction.transactionId
  );
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.files[0].backupVerified, false);

  faultStage = null;
  const next = await prepareBackedUp(afterBackupCrash, original);
  const authorization = await afterBackupCrash.authorize(
    'env-one',
    next.transaction.transactionId,
    next.transactionToken
  );
  const final = Buffer.from('param count = 2\n');
  await afterBackupCrash.beginCommit(
    'env-one',
    next.transaction.transactionId,
    authorization.authorizationToken,
    {
      manifestHash: authorization.manifestHash,
      files: [
        {
          alias: 'bicep/main.bicepparam',
          originalHash: hash(original),
          finalHash: hash(final),
          finalSize: final.length,
        },
      ],
    }
  );
  afterBackupCrash.faultInjector = (stage) => {
    if (stage === 'after-commit-manifest') throw new Error('injected commit crash');
  };
  await assert.rejects(
    afterBackupCrash.commitReceipt(
      'env-one',
      next.transaction.transactionId,
      authorization.authorizationToken,
      {
        receipts: [
          { alias: 'bicep/main.bicepparam', hash: hash(final), size: final.length },
        ],
      }
    ),
    /injected commit crash/
  );
  const afterCommitCrash = new TransactionStore({ dataRoot: root });
  await afterCommitCrash.initialize();
  const committed = await afterCommitCrash.getTransaction(
    'env-one',
    next.transaction.transactionId
  );
  assert.equal(committed.status, 'committed');
  assert.equal(committed.auditRecorded, true);
});

test('retention preserves the minimum journals per target and removes older failed journals', async (t) => {
  let now = Date.parse('2025-01-01T00:00:00.000Z');
  const original = Buffer.from('param count = 1\n');
  const { root, store } = await fixture({
    now: () => now,
    minimumPerTarget: 2,
    failedRetentionDays: 30,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const prepared = await store.prepare(proposal(original));
    ids.push(prepared.transaction.transactionId);
    await store.abandon('env-one', prepared.transaction.transactionId, prepared.transactionToken);
    now += 24 * 60 * 60 * 1000;
  }
  now += 31 * 24 * 60 * 60 * 1000;
  await store.applyRetention('env-one');
  const transactionRoot = join(root, 'environments', 'env-one', 'transactions');
  await assert.rejects(stat(join(transactionRoot, ids[0])), (error) => error.code === 'ENOENT');
  assert.ok((await readdir(transactionRoot)).includes(ids[1]));
  assert.ok((await readdir(transactionRoot)).includes(ids[2]));
});
