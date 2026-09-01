import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { sha256 } from '../web/js/directory-provider.mjs';
import { createTransactionCommit } from '../web/js/transaction-client.mjs';

globalThis.crypto ||= webcrypto;

const bytes = (value) => new TextEncoder().encode(value);

class MemoryProvider {
  constructor(files, failAlias = null, hooks = {}) {
    this.files = new Map(Object.entries(files).map(([alias, value]) => [alias, bytes(value)]));
    this.failAlias = failAlias;
    this.hooks = hooks;
    this.trace = [];
    this.missing = [];
  }

  async read(alias) {
    this.trace.push(`read:${alias}`);
    if (!this.files.has(alias)) throw new DOMException('Not found', 'NotFoundError');
    const value = this.files.get(alias).slice();
    return { alias, bytes: value, text: new TextDecoder().decode(value), hash: await sha256(value), size: value.length };
  }

  async write(alias, value, options) {
    this.trace.push(`write:${alias}`);
    await this.hooks.beforeWrite?.(alias, this);
    const current = this.files.get(alias);
    const currentHash = current ? await sha256(current) : null;
    assert.equal(currentHash, options.expectedHash);
    if (alias === this.failAlias) {
      this.failAlias = null;
      throw new Error(`injected write failure: ${alias}`);
    }
    this.files.set(alias, value.slice());
    return this.read(alias);
  }

  async missingDirectories() {
    return [...this.missing];
  }

  async remove(alias) {
    this.trace.push(`remove:${alias}`);
    const options = arguments[1] || {};
    const current = this.files.get(alias);
    if (!current) throw new DOMException('Not found', 'NotFoundError');
    if (options.expectedHash !== undefined) {
      assert.equal(await sha256(current), options.expectedHash);
    }
    this.files.delete(alias);
  }
}

function transactionApi(originals, hooks = {}) {
  const trace = [];
  const backups = new Map();
  let preparation = null;
  const request = async (path, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    if (path === '/api/transactions/prepare') {
      trace.push('prepare');
      preparation = body;
      return {
        transaction: {
          transactionId: 'tx-1',
          files: body.files.map((file, index) => ({ ...file, id: `file-${index + 1}` })),
        },
        transactionToken: 'transaction-token',
      };
    }
    if (/\/backups\/file-\d+$/.test(path) && options.method === 'PUT') {
      trace.push(`backup:${path.split('/').at(-1)}`);
      const id = path.split('/').at(-1);
      const file = preparation.files[Number(id.slice(5)) - 1];
      assert.deepEqual(options.body, originals.get(file.alias));
      backups.set(id, options.body.slice());
      return { verified: true };
    }
    if (path.endsWith('/authorize')) {
      trace.push('authorize');
      assert.equal(backups.size, preparation.files.filter((file) => file.existed).length);
      await hooks.onAuthorize?.();
      return { authorizationToken: 'authorization-token', manifestHash: 'a'.repeat(64) };
    }
    if (path.endsWith('/committing')) {
      trace.push('committing');
      assert.equal(body.files.length, preparation.files.length);
      return { status: 'committing' };
    }
    if (path.includes('/backups/') && options.responseType === 'bytes') {
      trace.push(`restore:${path.split('?')[0].split('/').at(-1)}`);
      return { bytes: backups.get(path.split('?')[0].split('/').at(-1)) };
    }
    if (path.endsWith('/receipt')) {
      trace.push('receipt');
      return { status: 'committed' };
    }
    if (path.endsWith('/rollback')) {
      trace.push('rollback');
      assert.equal(body.receipts.length, preparation.files.length);
      return { status: 'rolled-back' };
    }
    if (path.endsWith('/fail')) {
      trace.push('fail');
      return { status: 'failed' };
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${path}`);
  };
  return { request, trace };
}

test('browser coordinator backs up and authorizes before the first source write', async () => {
  const provider = new MemoryProvider({ 'bicep/main.bicepparam': 'before' });
  const original = await provider.read('bicep/main.bicepparam');
  provider.trace.length = 0;
  const api = transactionApi(new Map([['bicep/main.bicepparam', original.bytes]]));
  const commit = createTransactionCommit(api.request);
  await commit(
    [{
      alias: original.alias,
      before: original.bytes,
      beforeHash: original.hash,
      after: bytes('after'),
      changed: ['enabled'],
    }],
    {
      action: 'parameter-edit',
      context: {
        projectId: 'project-one',
        environment: { id: 'env-one', label: 'Development' },
        provider,
      },
    }
  );
  assert.deepEqual(api.trace, ['prepare', 'backup:file-1', 'authorize', 'committing', 'receipt']);
  assert.equal(new TextDecoder().decode(provider.files.get(original.alias)), 'after');
});

test('fault after one multi-file write restores every target before rollback receipt', async () => {
  const provider = new MemoryProvider(
    {
      'bicep/one.bicepparam': 'one-before',
      'bicep/two.bicepparam': 'two-before',
    },
    'bicep/two.bicepparam'
  );
  const one = await provider.read('bicep/one.bicepparam');
  const two = await provider.read('bicep/two.bicepparam');
  const api = transactionApi(new Map([
    [one.alias, one.bytes],
    [two.alias, two.bytes],
  ]));
  const commit = createTransactionCommit(api.request);
  await assert.rejects(
    commit(
      [
        { alias: one.alias, before: one.bytes, beforeHash: one.hash, after: bytes('one-after') },
        { alias: two.alias, before: two.bytes, beforeHash: two.hash, after: bytes('two-after') },
      ],
      {
        action: 'copy',
        context: {
          projectId: 'project-one',
          environment: { id: 'env-one', label: 'Test' },
          provider,
        },
      }
    ),
    /injected write failure/
  );
  assert.equal(new TextDecoder().decode(provider.files.get(one.alias)), 'one-before');
  assert.equal(new TextDecoder().decode(provider.files.get(two.alias)), 'two-before');
  assert.equal(api.trace.at(-1), 'rollback');
});

test('an unwritten target changed before its write remains external while completed targets roll back', async () => {
  const oneAlias = 'bicep/one.bicepparam';
  const twoAlias = 'bicep/two.bicepparam';
  const external = bytes('two-external');
  const provider = new MemoryProvider(
    { [oneAlias]: 'one-before', [twoAlias]: 'two-before' },
    null,
    {
      beforeWrite(alias, target) {
        if (alias === twoAlias) target.files.set(twoAlias, external.slice());
      },
    }
  );
  const one = await provider.read(oneAlias);
  const two = await provider.read(twoAlias);
  const api = transactionApi(new Map([[oneAlias, one.bytes], [twoAlias, two.bytes]]));

  await assert.rejects(
    createTransactionCommit(api.request)(
      [
        { alias: oneAlias, before: one.bytes, beforeHash: one.hash, after: bytes('one-after') },
        { alias: twoAlias, before: two.bytes, beforeHash: two.hash, after: bytes('two-after') },
      ],
      {
        context: {
          projectId: 'project-one',
          environment: { id: 'env-one', label: 'Test' },
          provider,
        },
      }
    ),
    /Recovery still requires attention for bicep\/two\.bicepparam/
  );
  assert.deepEqual(provider.files.get(oneAlias), one.bytes);
  assert.deepEqual(provider.files.get(twoAlias), external);
  assert.equal(api.trace.at(-1), 'fail');
  assert.equal(provider.trace.includes(`write:${oneAlias}`), true);
  assert.equal(provider.trace.filter((entry) => entry === `write:${twoAlias}`).length, 1);
});

test('a post-write external edit is preserved and marks recovery required', async () => {
  const oneAlias = 'bicep/one.bicepparam';
  const twoAlias = 'bicep/two.bicepparam';
  const external = bytes('one-external-after-write');
  const provider = new MemoryProvider(
    { [oneAlias]: 'one-before', [twoAlias]: 'two-before' },
    twoAlias,
    {
      beforeWrite(alias, target) {
        if (alias === twoAlias) target.files.set(oneAlias, external.slice());
      },
    }
  );
  const one = await provider.read(oneAlias);
  const two = await provider.read(twoAlias);
  const api = transactionApi(new Map([[oneAlias, one.bytes], [twoAlias, two.bytes]]));

  await assert.rejects(
    createTransactionCommit(api.request)(
      [
        { alias: oneAlias, before: one.bytes, beforeHash: one.hash, after: bytes('one-after') },
        { alias: twoAlias, before: two.bytes, beforeHash: two.hash, after: bytes('two-after') },
      ],
      {
        context: {
          projectId: 'project-one',
          environment: { id: 'env-one', label: 'Test' },
          provider,
        },
      }
    ),
    /Recovery still requires attention for bicep\/one\.bicepparam/
  );
  assert.deepEqual(provider.files.get(oneAlias), external);
  assert.deepEqual(provider.files.get(twoAlias), two.bytes);
  assert.equal(provider.trace.includes(`remove:${oneAlias}`), false);
  assert.equal(api.trace.at(-1), 'fail');
});

test('create races never remove an externally created unwritten target', async () => {
  const oneAlias = 'contracts/one/main.bicepparam';
  const twoAlias = 'contracts/two/main.bicepparam';
  const external = bytes('external-create');
  const provider = new MemoryProvider(
    {},
    null,
    {
      beforeWrite(alias, target) {
        if (alias === twoAlias) target.files.set(twoAlias, external.slice());
      },
    }
  );
  const api = transactionApi(new Map());

  await assert.rejects(
    createTransactionCommit(api.request)(
      [
        { alias: oneAlias, before: null, beforeHash: null, after: bytes('one-created'), create: true },
        { alias: twoAlias, before: null, beforeHash: null, after: bytes('two-created'), create: true },
      ],
      {
        action: 'contract-create',
        context: {
          projectId: 'project-one',
          environment: { id: 'env-one', label: 'Test' },
          provider,
        },
      }
    ),
    /Recovery still requires attention for contracts\/two\/main\.bicepparam/
  );
  assert.equal(provider.files.has(oneAlias), false);
  assert.deepEqual(provider.files.get(twoAlias), external);
  assert.equal(provider.trace.includes(`remove:${twoAlias}`), false);
  assert.equal(api.trace.at(-1), 'fail');
});

test('a post-write edit to a created target is preserved instead of removed', async () => {
  const oneAlias = 'contracts/one/main.bicepparam';
  const twoAlias = 'contracts/two/main.bicepparam';
  const external = bytes('external-created-edit');
  const provider = new MemoryProvider(
    {},
    twoAlias,
    {
      beforeWrite(alias, target) {
        if (alias === twoAlias) target.files.set(oneAlias, external.slice());
      },
    }
  );
  const api = transactionApi(new Map());

  await assert.rejects(
    createTransactionCommit(api.request)(
      [
        { alias: oneAlias, before: null, beforeHash: null, after: bytes('one-created'), create: true },
        { alias: twoAlias, before: null, beforeHash: null, after: bytes('two-created'), create: true },
      ],
      {
        action: 'contract-create',
        context: {
          projectId: 'project-one',
          environment: { id: 'env-one', label: 'Test' },
          provider,
        },
      }
    ),
    /Recovery still requires attention for contracts\/one\/main\.bicepparam/
  );
  assert.deepEqual(provider.files.get(oneAlias), external);
  assert.equal(provider.files.has(twoAlias), false);
  assert.equal(provider.trace.includes(`remove:${oneAlias}`), false);
  assert.equal(api.trace.at(-1), 'fail');
});

test('external change after transaction review is rejected before the first write', async () => {
  const alias = 'bicep/main.bicepparam';
  const provider = new MemoryProvider({ [alias]: 'before' });
  const original = await provider.read(alias);
  const external = bytes('external');
  const api = transactionApi(new Map([[alias, original.bytes]]), {
    onAuthorize: async () => {
      provider.files.set(alias, external);
    },
  });
  const commit = createTransactionCommit(api.request);
  await assert.rejects(
    () => commit(
      [{
        alias,
        before: original.bytes,
        beforeHash: original.hash,
        after: bytes('after'),
        changed: ['value'],
      }],
      {
        action: 'history-restore',
        context: {
          projectId: 'project-one',
          environment: { id: 'env-one', label: 'Development' },
          provider,
        },
      }
    ),
    /File changed outside Citadel UI\. Reload before saving\./
  );
  assert.equal(new TextDecoder().decode(provider.files.get(alias)), 'external');
  assert.equal(api.trace.includes('committing'), false);
});

test('created-directory changes reject before the first source write', async () => {
  const alias =
    'bicep/infra/citadel-access-contracts/contracts/qa-alpha/main.bicepparam';
  const provider = new MemoryProvider({});
  provider.missing = [
    'bicep/infra/citadel-access-contracts/contracts',
    'bicep/infra/citadel-access-contracts/contracts/qa-alpha',
  ];
  const api = transactionApi(new Map(), {
    onAuthorize: async () => {
      provider.missing = [];
    },
  });
  const commit = createTransactionCommit(api.request);
  await assert.rejects(
    () =>
      commit(
        [
          {
            alias,
            before: null,
            beforeHash: null,
            after: bytes('created'),
            changed: ['create'],
            create: true,
          },
        ],
        {
          action: 'contract-create',
          context: {
            projectId: 'project-one',
            environment: { id: 'env-one', label: 'Development' },
            provider,
          },
        }
      ),
    /Source directories changed outside Citadel UI/
  );
  assert.equal(provider.files.has(alias), false);
  assert.equal(api.trace.includes('committing'), false);
  assert.equal(api.trace.at(-1), 'fail');
});
