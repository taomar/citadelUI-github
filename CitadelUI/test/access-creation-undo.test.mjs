import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { TransactionStore } from '../server/transactions.mjs';
import { createTransactionCommit } from '../web/js/transaction-client.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';

globalThis.crypto ||= webcrypto;

const CONTRACTS = 'bicep/infra/citadel-access-contracts/contracts';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function safePath(root, alias) {
  const path = resolve(root, ...String(alias).split('/'));
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Unsafe alias.');
  return path;
}

class FilesystemProvider {
  constructor(root) {
    this.root = root;
  }

  async read(alias) {
    const path = safePath(this.root, alias);
    try {
      const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
      return {
        alias,
        bytes: new Uint8Array(bytes),
        text: bytes.toString('utf8'),
        size: bytes.length,
        hash: digest(bytes),
        lastModified: info.mtimeMs,
      };
    } catch (error) {
      if (error.code === 'ENOENT') throw new DOMException('Not found', 'NotFoundError');
      throw error;
    }
  }

  async missingDirectories(alias) {
    safePath(this.root, alias);
    const parts = alias.split('/');
    parts.pop();
    for (let index = 0; index < parts.length; index += 1) {
      try {
        const info = await stat(safePath(this.root, parts.slice(0, index + 1).join('/')));
        if (!info.isDirectory()) throw new Error('Source parent is not a directory.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return parts.slice(index).map((_, offset) =>
          parts.slice(0, index + offset + 1).join('/')
        );
      }
    }
    return [];
  }

  async write(alias, value, options = {}) {
    let current = null;
    try {
      current = await this.read(alias);
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
    assert.equal(current?.hash ?? null, options.expectedHash);
    const path = safePath(this.root, alias);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
    const verified = await this.read(alias);
    assert.equal(verified.hash, options.finalHash);
    return verified;
  }

  async remove(alias, options = {}) {
    const current = await this.read(alias);
    assert.equal(current.hash, options.expectedHash);
    await rm(safePath(this.root, alias));
    for (const directory of [...new Set(options.removeEmptyDirectories || [])].sort(
      (left, right) => right.split('/').length - left.split('/').length
    )) {
      assert.ok(alias.startsWith(`${directory}/`));
      try {
        await rmdir(safePath(this.root, directory));
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
  }
}

function storeRequest(getStore) {
  return async (path, options = {}) => {
    const route = path.split('?', 1)[0];
    const parts = route.split('/').filter(Boolean);
    const body =
      typeof options.body === 'string' && options.body
        ? JSON.parse(options.body)
        : options.body;
    const environmentId =
      options.headers?.['X-Citadel-Environment'] ||
      new URL(`http://isolated${path}`).searchParams.get('environmentId');
    const store = getStore();
    if (route === '/api/transactions/prepare') return store.prepare(body);
    if (route === '/api/transactions') {
      return { transactions: await store.history(environmentId) };
    }
    const transactionId = parts[2];
    const action = parts[3];
    const transactionToken = options.headers?.['X-Citadel-Transaction'];
    const authorizationToken = options.headers?.['X-Citadel-Authorization'];
    if (parts.length === 3) {
      return { transaction: await store.getTransaction(environmentId, transactionId) };
    }
    if (action === 'authorize') {
      return store.authorize(environmentId, transactionId, transactionToken);
    }
    if (action === 'committing') {
      return store.beginCommit(
        environmentId,
        transactionId,
        authorizationToken,
        body
      );
    }
    if (action === 'receipt') {
      return store.commitReceipt(
        environmentId,
        transactionId,
        authorizationToken,
        body
      );
    }
    if (action === 'fail') {
      return store.fail(environmentId, transactionId, transactionToken, body);
    }
    if (action === 'rollback') {
      return store.rollback(environmentId, transactionId, transactionToken, body);
    }
    if (action === 'revert') return store.beginRevert(environmentId, transactionId);
    if (action === 'recover') return store.recover(environmentId, transactionId);
    throw new Error(`Unsupported request: ${options.method || 'GET'} ${path}`);
  };
}

async function tree(root) {
  const entries = [];
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const alias = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push(`${alias}/`);
        await walk(path, alias);
      } else {
        const bytes = await readFile(path);
        entries.push(`${alias}:${bytes.length}:${digest(bytes)}`);
      }
    }
  };
  await walk(root);
  return entries.sort();
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function commitContract(commitFiles, name) {
  const base = `${CONTRACTS}/${name}`;
  const parameter = new TextEncoder().encode(`using '../../main.bicep'\nparam name = '${name}'\n`);
  const policy = new TextEncoder().encode(`<policies id="${name}" />\n`);
  const committed = await commitFiles(
    [
      {
        alias: `${base}/main.bicepparam`,
        before: null,
        beforeHash: null,
        after: parameter,
        changed: ['using', 'name'],
        create: true,
      },
      {
        alias: `${base}/ai-product-policy.xml`,
        before: null,
        beforeHash: null,
        after: policy,
        changed: ['policyXml'],
        create: true,
      },
    ],
    { action: 'contract-create' }
  );
  return committed.transactionId;
}

const scenarios = [
  { name: 'absent parent, reverse undo', baseline: 'absent', order: [2, 1, 0] },
  { name: 'absent parent, interleaved undo after restart', baseline: 'absent', order: [1, 0, 2], restart: true },
  { name: 'pre-existing empty parent', baseline: 'empty', order: [0, 2, 1] },
  { name: 'nonempty parent with hidden unrelated content', baseline: 'nonempty', order: [2, 0, 1] },
];

for (const scenario of scenarios) {
  test(`Access creation undo restores exact tree: ${scenario.name}`, async (t) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'citadel-access-undo-'));
    const sourceRoot = join(fixtureRoot, 'source');
    const dataRoot = join(fixtureRoot, 'data');
    t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    await mkdir(join(sourceRoot, 'bicep', 'infra', 'citadel-access-contracts'), {
      recursive: true,
    });
    if (scenario.baseline !== 'absent') {
      await mkdir(join(sourceRoot, ...CONTRACTS.split('/')), { recursive: true });
    }
    if (scenario.baseline === 'nonempty') {
      await mkdir(join(sourceRoot, ...CONTRACTS.split('/'), '.qa-retained'));
      await writeFile(
        join(sourceRoot, ...CONTRACTS.split('/'), '.qa-retained', 'hidden.txt'),
        'unrelated'
      );
    }
    const baseline = await tree(sourceRoot);
    const provider = new FilesystemProvider(sourceRoot);
    let store = new TransactionStore({ dataRoot });
    await store.initialize();
    const request = storeRequest(() => store);
    const context = {
      projectId: 'project-one',
      environment: { id: 'environment-one', label: 'Integration' },
      provider,
    };
    const commitFiles = createTransactionCommit(request);
    const boundCommit = (files, options) =>
      commitFiles(files, { ...options, context });
    const workspace = new WorkspaceService({
      request,
      commitFiles: boundCommit,
      contextProvider: () => context,
    });
    const transactionIds = [];
    for (const name of ['qa-alpha', 'qa-beta', 'qa-gamma']) {
      transactionIds.push(await commitContract(boundCommit, name));
    }

    const first = await store.getTransaction('environment-one', transactionIds[0]);
    assert.ok(first.createdDirectories.every((alias) => !/^(?:[A-Za-z]:|[\\/])/.test(alias)));
    assert.equal(first.createdDirectories.includes(CONTRACTS), scenario.baseline === 'absent');
    for (const [index, transactionId] of transactionIds.entries()) {
      const transaction =
        index === 0
          ? first
          : await store.getTransaction('environment-one', transactionId);
      assert.ok(
        transaction.createdDirectories.includes(
          `${CONTRACTS}/${['qa-alpha', 'qa-beta', 'qa-gamma'][index]}`
        )
      );
      if (index > 0) assert.equal(transaction.createdDirectories.includes(CONTRACTS), false);
      assert.equal(
        transaction.ownedCleanupDirectories.includes(CONTRACTS),
        scenario.baseline === 'absent'
      );
    }

    if (scenario.restart) {
      store = new TransactionStore({ dataRoot });
      await store.initialize();
    }

    for (const [position, index] of scenario.order.entries()) {
      await workspace.restoreTransaction(transactionIds[index]);
      const parentExists = await exists(join(sourceRoot, ...CONTRACTS.split('/')));
      if (scenario.baseline === 'absent') {
        assert.equal(parentExists, position < scenario.order.length - 1);
      } else {
        assert.equal(parentExists, true);
      }
    }
    assert.deepEqual(await tree(sourceRoot), baseline);

    const auditText = await readFile(
      join(dataRoot, 'environments', 'environment-one', 'audit.jsonl'),
      'utf8'
    );
    assert.equal(auditText.includes(sourceRoot), false);
    const audit = auditText.trim().split('\n').map(JSON.parse);
    for (let index = 0; index < audit.length; index += 1) {
      const { hash, ...entry } = audit[index];
      assert.equal(digest(JSON.stringify(entry)), hash);
      if (index > 0) {
        assert.equal(audit[index].sequence, audit[index - 1].sequence + 1);
        assert.equal(audit[index].previousHash, audit[index - 1].hash);
      }
    }
    const reverting = audit.filter((entry) => entry.event === 'reverting');
    assert.equal(reverting.length, 3);
    assert.equal(
      reverting.some((entry) => entry.cleanupDirectories.includes(CONTRACTS)),
      scenario.baseline === 'absent'
    );
  });
}

test('Access creation undo rejects a changed created file before journalling revert', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'citadel-access-changed-'));
  const sourceRoot = join(fixtureRoot, 'source');
  const dataRoot = join(fixtureRoot, 'data');
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await mkdir(join(sourceRoot, 'bicep', 'infra', 'citadel-access-contracts'), {
    recursive: true,
  });
  const provider = new FilesystemProvider(sourceRoot);
  const store = new TransactionStore({ dataRoot });
  await store.initialize();
  const request = storeRequest(() => store);
  const context = {
    projectId: 'project-one',
    environment: { id: 'environment-one', label: 'Integration' },
    provider,
  };
  const commit = createTransactionCommit(request);
  const boundCommit = (files, options) => commit(files, { ...options, context });
  const transactionId = await commitContract(boundCommit, 'qa-alpha');
  const changedAlias = `${CONTRACTS}/qa-alpha/main.bicepparam`;
  await writeFile(safePath(sourceRoot, changedAlias), 'external change');
  const workspace = new WorkspaceService({
    request,
    commitFiles: boundCommit,
    contextProvider: () => context,
  });

  await assert.rejects(
    () => workspace.restoreTransaction(transactionId),
    /Created source changed outside Citadel UI/
  );
  assert.equal(
    (await store.getTransaction('environment-one', transactionId)).status,
    'committed'
  );
  const audit = await readFile(
    join(dataRoot, 'environments', 'environment-one', 'audit.jsonl'),
    'utf8'
  );
  assert.equal(audit.includes('"event":"reverting"'), false);
  assert.equal(await exists(join(sourceRoot, ...CONTRACTS.split('/'))), true);
});

test('interrupted Access removal retains parent cleanup authority across restart', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'citadel-access-restart-'));
  const sourceRoot = join(fixtureRoot, 'source');
  const dataRoot = join(fixtureRoot, 'data');
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await mkdir(join(sourceRoot, 'bicep', 'infra', 'citadel-access-contracts'), {
    recursive: true,
  });
  const baseline = await tree(sourceRoot);
  const provider = new FilesystemProvider(sourceRoot);
  let store = new TransactionStore({ dataRoot });
  await store.initialize();
  const request = storeRequest(() => store);
  const context = {
    projectId: 'project-one',
    environment: { id: 'environment-one', label: 'Integration' },
    provider,
  };
  const commit = createTransactionCommit(request);
  const transactionId = await commitContract(
    (files, options) => commit(files, { ...options, context }),
    'qa-alpha'
  );
  const reverting = await store.beginRevert('environment-one', transactionId);
  assert.deepEqual(reverting.cleanupDirectories, [
    CONTRACTS,
    `${CONTRACTS}/qa-alpha`,
  ]);

  store = new TransactionStore({ dataRoot });
  await store.initialize();
  const workspace = new WorkspaceService({
    request,
    contextProvider: () => context,
  });
  const result = await workspace.recoverTransaction(transactionId, 'complete');
  assert.equal(result.status, 'rolled_back');
  assert.deepEqual(await tree(sourceRoot), baseline);
});
