import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  captureContractEdits,
  editorPendingCount,
  restoreContractEdits,
} from '../web/js/contract-edit-state.mjs';
import { sha256 } from '../web/js/directory-provider.mjs';
import { commitActiveWorkspaceReconnect } from '../web/js/workspace-context.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';

globalThis.crypto ||= webcrypto;

const encode = (value) => new TextEncoder().encode(value);

class SourceProvider {
  constructor(files) {
    this.files = new Map(Object.entries(files).map(([alias, text]) => [alias, encode(text)]));
  }

  async read(alias) {
    const bytes = this.files.get(alias)?.slice();
    if (!bytes) throw new DOMException('Not found', 'NotFoundError');
    return {
      alias,
      bytes,
      text: new TextDecoder().decode(bytes),
      hash: await sha256(bytes),
      size: bytes.byteLength,
    };
  }

  async write(alias, bytes, options) {
    const current = await this.read(alias);
    assert.equal(current.hash, options.expectedHash);
    this.files.set(alias, bytes.slice());
    const written = await this.read(alias);
    assert.equal(written.hash, options.finalHash);
    return written;
  }
}

test('active reconnect switches the live save provider only after mirror success', async () => {
  const alias = 'bicep/main.bicepparam';
  const original = "param value = 'old'\n";
  const oldProvider = new SourceProvider({ [alias]: original });
  const newProvider = new SourceProvider({ [alias]: original });
  const current = {
    projectId: 'project-one',
    environment: { id: 'environment-one', label: 'Development', localPath: 'C:\\old' },
    handle: { name: 'old' },
    provider: oldProvider,
  };
  const next = {
    projectId: 'project-one',
    environment: { id: 'environment-one', label: 'Development', localPath: 'C:\\new' },
    handle: { name: 'new' },
    provider: newProvider,
  };

  await assert.rejects(
    commitActiveWorkspaceReconnect(current, next, async () => {
      throw new Error('Registry mirror failed.');
    }),
    /Registry mirror failed/
  );
  assert.equal(current.provider, oldProvider);
  assert.equal(current.environment.localPath, 'C:\\old');

  await commitActiveWorkspaceReconnect(current, next, async () => {});
  const service = new WorkspaceService({
    contextProvider: () => current,
    commitFiles: async (files) => {
      for (const file of files) {
        await current.provider.write(file.alias, file.after, {
          expectedHash: file.beforeHash,
          finalHash: await sha256(file.after),
        });
      }
      return {
        transactionId: 'reconnect-save',
        files: await Promise.all(
          files.map(async (file) => ({ alias: file.alias, hash: await sha256(file.after) }))
        ),
      };
    },
  });
  const source = await newProvider.read(alias);
  await service.save(
    alias,
    [{ op: 'set', path: ['value'], value: 'new-folder-only' }],
    source.hash
  );

  assert.equal((await oldProvider.read(alias)).text, original);
  assert.equal((await newProvider.read(alias)).text, "param value = 'new-folder-only'\n");
  assert.equal(current.handle, next.handle);
  assert.equal(current.environment.localPath, 'C:\\new');
});

function editorState() {
  return {
    current: { path: 'contracts/a/main.bicepparam', hash: 'param-one' },
    contract: {
      policy: { path: 'contracts/a/ai-product-policy.xml', hash: 'policy-one' },
    },
    operations: [{ op: 'set', path: ['secureValue'], value: 'pending-secret' }],
    policyChanges: { tokenLimit: { attributes: { 'tokens-per-minute': '2000' } } },
    policyRaw: null,
    policyMode: 'guided',
    policyPreview: {},
  };
}

test('parameter refresh keeps policy pending while clearing saved parameter operations', () => {
  const state = editorState();
  const beforeSave = captureContractEdits(state);
  state.current = { ...state.current, hash: 'param-two' };

  assert.deepEqual(
    restoreContractEdits(state, beforeSave, { parameters: false, policy: true }),
    []
  );
  assert.deepEqual(state.operations, []);
  assert.deepEqual(state.policyChanges, beforeSave.policyChanges);
  assert.equal(editorPendingCount(state), 1);
});

test('policy refresh keeps secure parameter operations while clearing saved policy changes', () => {
  const state = editorState();
  const beforeSave = captureContractEdits(state);
  state.contract = {
    policy: { ...state.contract.policy, hash: 'policy-two' },
  };

  assert.deepEqual(
    restoreContractEdits(state, beforeSave, { parameters: true, policy: false }),
    []
  );
  assert.deepEqual(state.operations, beforeSave.operations);
  assert.deepEqual(state.policyChanges, {});
  assert.equal(state.policyRaw, null);
  assert.equal(editorPendingCount(state), 1);
});

test('raw policy and parameter pending state survive either save order', () => {
  const parameterFirst = editorState();
  parameterFirst.policyChanges = {};
  parameterFirst.policyRaw = '<policies><inbound><set-header /></inbound></policies>';
  const beforeParameterSave = captureContractEdits(parameterFirst);
  parameterFirst.current = { ...parameterFirst.current, hash: 'param-two' };
  restoreContractEdits(
    parameterFirst,
    beforeParameterSave,
    { parameters: false, policy: true }
  );
  assert.equal(parameterFirst.policyRaw, beforeParameterSave.policyRaw);

  const beforePolicySave = captureContractEdits(parameterFirst);
  parameterFirst.contract = {
    policy: { ...parameterFirst.contract.policy, hash: 'policy-two' },
  };
  restoreContractEdits(
    parameterFirst,
    beforePolicySave,
    { parameters: true, policy: false }
  );
  assert.deepEqual(parameterFirst.operations, []);

  const policyFirst = editorState();
  const beforeFirstSave = captureContractEdits(policyFirst);
  policyFirst.contract = {
    policy: { ...policyFirst.contract.policy, hash: 'policy-two' },
  };
  restoreContractEdits(policyFirst, beforeFirstSave, { parameters: true, policy: false });
  assert.deepEqual(policyFirst.operations, beforeFirstSave.operations);
  const beforeSecondSave = captureContractEdits(policyFirst);
  policyFirst.current = { ...policyFirst.current, hash: 'param-two' };
  restoreContractEdits(policyFirst, beforeSecondSave, { parameters: false, policy: true });
  assert.deepEqual(policyFirst.policyChanges, {});
  assert.equal(editorPendingCount(policyFirst), 0);
});
