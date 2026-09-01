import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { sha256 } from '../web/js/directory-provider.mjs';
import {
  STALE_SOURCE_MESSAGE,
  WorkspaceService,
} from '../web/js/workspace-service.mjs';

globalThis.crypto ||= webcrypto;

const encode = (value) => new TextEncoder().encode(value);

class MemoryProvider {
  constructor(files) {
    this.files = new Map(Object.entries(files).map(([alias, text]) => [alias, encode(text)]));
    this.removed = [];
  }

  async read(alias) {
    const bytes = this.files.get(alias)?.slice();
    if (!bytes) throw new DOMException('Not found', 'NotFoundError');
    return {
      alias,
      bytes,
      text: new TextDecoder().decode(bytes),
      size: bytes.byteLength,
      hash: await sha256(bytes),
    };
  }

  replace(alias, text) {
    this.files.set(alias, encode(text));
  }

  async remove(alias, options = {}) {
    const source = await this.read(alias);
    assert.equal(source.hash, options.expectedHash);
    this.files.delete(alias);
    this.removed.push({ alias, options });
  }
}

function service(provider, commits) {
  return new WorkspaceService({
    contextProvider: () => ({
      projectId: 'project',
      environment: { id: 'development', label: 'Development' },
      provider,
    }),
    commitFiles: async (files) => {
      commits.push(files);
      return {
        transactionId: 'transaction',
        files: files.map((file) => ({ alias: file.alias, hash: file.beforeHash })),
      };
    },
  });
}

for (const external of [
  "param backend = 'external'\nparam model = 'one'\n",
  "param backend = 'one'\nparam model = 'external'\n",
]) {
  test(`parameter save rejects external ${external.includes("backend = 'external'") ? 'same-field' : 'different-field'} changes`, async () => {
    const alias = 'bicep/main.bicepparam';
    const provider = new MemoryProvider({
      [alias]: "param backend = 'one'\nparam model = 'one'\n",
    });
    const loaded = await provider.read(alias);
    const commits = [];
    provider.replace(alias, external);
    await assert.rejects(
      () => service(provider, commits).save(
        alias,
        [{ op: 'set', path: ['backend'], value: 'citadel' }],
        loaded.hash
      ),
      { message: STALE_SOURCE_MESSAGE }
    );
    assert.equal((await provider.read(alias)).text, external);
    assert.equal(commits.length, 0);
  });
}

test('review-to-save race rejects and keeps the reviewed hash as transaction beforeHash', async () => {
  const alias = 'bicep/main.bicepparam';
  const provider = new MemoryProvider({ [alias]: "param backend = 'one'\n" });
  const loaded = await provider.read(alias);
  const commits = [];
  const workspace = service(provider, commits);
  const operations = [{ op: 'set', path: ['backend'], value: 'citadel' }];
  const preview = await workspace.preview(alias, operations, loaded.hash);
  assert.equal(preview.beforeHash, loaded.hash);
  provider.replace(alias, "param backend = 'external'\n");
  await assert.rejects(
    () => workspace.save(alias, operations, preview.beforeHash),
    { message: STALE_SOURCE_MESSAGE }
  );
  assert.equal(commits.length, 0);

  provider.replace(alias, loaded.text);
  await workspace.save(alias, operations, loaded.hash);
  assert.equal(commits[0][0].beforeHash, loaded.hash);
});

test('policy save rejects a changed source after review', async () => {
  const alias = 'policies/main.xml';
  const provider = new MemoryProvider({ [alias]: '<policies><inbound /></policies>' });
  const loaded = await provider.read(alias);
  const commits = [];
  const workspace = service(provider, commits);
  await workspace.previewPolicy(alias, {}, '<policies><inbound><base /></inbound></policies>', loaded.hash);
  provider.replace(alias, '<policies><inbound><external /></inbound></policies>');
  await assert.rejects(
    () => workspace.savePolicy({
      path: alias,
      text: '<policies><inbound><base /></inbound></policies>',
      expectedHash: loaded.hash,
    }),
    { message: STALE_SOURCE_MESSAGE }
  );
  assert.equal(commits.length, 0);
});

test('copy rejects a target changed after preview', async () => {
  const sourceAlias = 'bicep/source.bicepparam';
  const targetAlias = 'bicep/target.bicepparam';
  const provider = new MemoryProvider({
    [sourceAlias]: "param backend = 'source'\n",
    [targetAlias]: "param backend = 'target'\n",
  });
  const loadedSource = await provider.read(sourceAlias);
  const commits = [];
  const workspace = service(provider, commits);
  workspace.compareEnvironment = async () => {
    const [source, destination] = await Promise.all([
      provider.read(sourceAlias),
      provider.read(targetAlias),
    ]);
    return {
      source: {
        ...source,
        params: [{ name: 'backend', value: 'source', kind: 'string' }],
        schema: { parameters: { backend: { type: 'string', secure: false } } },
      },
      destination: {
        ...destination,
        params: [{ name: 'backend', value: 'target', kind: 'string' }],
        schema: { parameters: { backend: { type: 'string', secure: false } } },
      },
      parameters: [{
        name: 'backend',
        source: 'source',
        target: 'target',
        status: 'different',
      }],
      targetAlias,
      target: {
        projectId: 'project',
        environment: { id: 'target', label: 'Target' },
        provider,
      },
    };
  };
  const preview = await workspace.previewCopy('target', sourceAlias, ['backend'], loadedSource.hash);
  provider.replace(targetAlias, "param backend = 'external'\n");
  await assert.rejects(
    () => workspace.copyParameters(
      'target',
      sourceAlias,
      ['backend'],
      preview.sourceHash,
      preview.targetHash
    ),
    { message: STALE_SOURCE_MESSAGE }
  );
  assert.equal(commits.length, 0);
});

test('History undo removes an unchanged committed contract creation and no unrelated source', async () => {
  const base = 'bicep/infra/citadel-access-contracts/contracts/qa-alpha';
  const provider = new MemoryProvider({
    [`${base}/main.bicepparam`]: 'created params',
    [`${base}/ai-product-policy.xml`]: '<policies />',
    'bicep/infra/citadel-access-contracts/contracts/unrelated/keep.xml': '<keep />',
  });
  const files = await Promise.all(
    [`${base}/main.bicepparam`, `${base}/ai-product-policy.xml`].map(async (alias) => {
      const source = await provider.read(alias);
      return {
        id: alias.endsWith('.xml') ? 'file-2' : 'file-1',
        alias,
        existed: false,
        originalHash: null,
        originalSize: 0,
        finalHash: source.hash,
        finalSize: source.size,
      };
    })
  );
  const transaction = {
    transactionId: 'creation-transaction',
    status: 'committed',
    targetLabel: 'contract-create',
    files,
  };
  const requests = [];
  const workspace = new WorkspaceService({
    contextProvider: () => ({
      projectId: 'project',
      environment: { id: 'development', label: 'Development' },
      provider,
    }),
    request: async (path, options = {}) => {
      requests.push({ path, options });
      if (path.includes('?environmentId=')) return { transaction };
      if (path.endsWith('/revert')) {
        return {
          status: 'reverting',
          transactionToken: 'revert-token',
          cleanupDirectories: [base],
        };
      }
      if (path.endsWith('/rollback')) return { status: 'rolled_back' };
      throw new Error(`Unexpected request ${path}`);
    },
  });

  const result = await workspace.restoreTransaction(transaction.transactionId);
  assert.equal(result.status, 'rolled_back');
  assert.equal(provider.files.has(`${base}/main.bicepparam`), false);
  assert.equal(provider.files.has(`${base}/ai-product-policy.xml`), false);
  assert.equal(
    new TextDecoder().decode(
      provider.files.get('bicep/infra/citadel-access-contracts/contracts/unrelated/keep.xml')
    ),
    '<keep />'
  );
  assert.equal(requests.filter((entry) => entry.path.endsWith('/revert')).length, 1);
  assert.equal(requests.filter((entry) => entry.path.endsWith('/rollback')).length, 1);
  assert.ok(
    provider.removed.every(
      (entry) => entry.options.removeEmptyDirectories.includes(base)
    )
  );
});

test('History undo rejects a changed created file before opening a revert journal', async () => {
  const base = 'bicep/infra/citadel-access-contracts/contracts/qa-alpha';
  const provider = new MemoryProvider({
    [`${base}/main.bicepparam`]: 'changed params',
    [`${base}/ai-product-policy.xml`]: '<policies />',
  });
  const policy = await provider.read(`${base}/ai-product-policy.xml`);
  const transaction = {
    transactionId: 'creation-transaction',
    status: 'committed',
    targetLabel: 'contract-create',
    files: [
      {
        id: 'file-1',
        alias: `${base}/main.bicepparam`,
        existed: false,
        finalHash: '0'.repeat(64),
        finalSize: 14,
      },
      {
        id: 'file-2',
        alias: `${base}/ai-product-policy.xml`,
        existed: false,
        finalHash: policy.hash,
        finalSize: policy.size,
      },
    ],
  };
  let revertRequested = false;
  const workspace = new WorkspaceService({
    contextProvider: () => ({
      projectId: 'project',
      environment: { id: 'development', label: 'Development' },
      provider,
    }),
    request: async (path) => {
      if (path.includes('?environmentId=')) return { transaction };
      if (path.endsWith('/revert')) revertRequested = true;
      throw new Error(`Unexpected request ${path}`);
    },
  });
  await assert.rejects(
    () => workspace.restoreTransaction(transaction.transactionId),
    /Created source changed outside Citadel UI/
  );
  assert.equal(revertRequested, false);
  assert.equal(provider.files.size, 2);
});
