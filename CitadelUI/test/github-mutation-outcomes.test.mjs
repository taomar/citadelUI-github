import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { githubWorkspaceFixture } from './_github-workspace-fixture.mjs';
import { TEST_TOKEN } from './_github-mock.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { commitChangeSet } from '../server/github/workspace.mjs';
import { GitHubCommitCoordinator } from '../web/js/github-coordinator.mjs';
import { mutationComplete } from '../shared/mutation-outcome.mjs';

const MAIN = 'bicep/infra/main.bicepparam';
const POLICY = 'bicep/infra/citadel-access-contracts/policies/default-ai-product-policy.xml';
const apiSource = await readFile(new URL('../web/js/api.mjs', import.meta.url), 'utf8');
function apiFor(workspace) {
  const scope = { workspace };
  vm.runInNewContext(apiSource.slice(apiSource.indexOf('export const api =')).replace('export const api =', 'globalThis.api ='), scope);
  return scope.api;
}
const refPatch = (href, init) => init.method === 'PATCH' && new URL(href).pathname.includes('/git/refs/heads/');
const refRead = (href, init) => (!init.method || init.method === 'GET') && new URL(href).pathname.includes('/git/ref/heads/');
const createBody = (head, transactionId) => ({
  expectedHead: head, transactionId, action: 'parameter-edit',
  files: [{ alias: 'bicep/infra/reconciled.bicepparam', create: true, after: Buffer.from("param value = 'reviewed'\n").toString('base64') }],
});
const send = (f, body) => commitChangeSet(f.client, TEST_TOKEN, {
  ...body, fullName: f.repository.full_name, repositoryId: f.repository.id,
  branch: f.environment.source.workingBranch, environmentId: f.environment.id, audit: f.audit,
});

for (const refusal of ['moved', 'protected']) {
  test(`mutation outcomes: ${refusal} contract creation stays pending through routes, coordinator, service and API`, async () => {
    const f = await githubWorkspaceFixture(), api = apiFor(f.service), branch = f.environment.source.workingBranch;
    const catalog = await f.service.deployments(), head = await f.provider.workspaceHead();
    if (refusal === 'protected') f.github.protectedBranches.add(branch);
    else f.github.failNextRefUpdate = true;
    const result = await api.createContract({ name: 'pending-contract' }, f.context);
    assert.equal(result.outcome, 'pending'); assert.equal(result.applied, false); assert.equal(result.changed, false);
    assert.equal(result.id, undefined); assert.equal(result.created, undefined); assert.equal(result.files.length, 0);
    assert.equal(result.plannedFiles.length, 2); assert.equal(result.intended.id, 'contracts/pending-contract');
    assert.equal(result.unresolved.commit, result.commit);
    assert.equal(result.unresolved.kind, refusal === 'protected' ? 'branch-protected' : 'branch-moved');
    assert.equal(await f.service.deployments(), catalog, 'Pending creation must not invalidate the live catalog.');
    assert.equal(await f.provider.workspaceHead(), head);
    assert.equal(f.repository.refs.get(branch), head);
    assert.equal((await api.history(f.context)).transactions.length, 0);
    assert.equal(f.raw(`${result.intended.dir}/main.bicepparam`), null);
    f.github.protectedBranches.delete(branch);
    const applied = await api.createContract({ name: 'pending-contract' }, f.context);
    assert.equal(applied.outcome, 'applied'); assert.equal(applied.applied, true); assert.equal(applied.created.length, 2);
    assert.equal(applied.id, result.intended.id); assert(f.raw(`${applied.dir}/main.bicepparam`));
    const history = await api.history(f.context);
    assert.equal(history.transactions.length, 1); assert.equal(history.transactions[0].commit, applied.commit);
  });
}

test('mutation outcomes: explicit branch choice preserves pending creation metadata and never retargets the workspace', async () => {
  const f = await githubWorkspaceFixture(), api = apiFor(f.service), branch = f.environment.source.workingBranch;
  const head = await f.provider.workspaceHead(), refs = [...f.repository.refs];
  f.github.failNextRefUpdate = true;
  const pending = await api.createContract({ name: 'named-copy' }, f.context);
  assert.deepEqual([...f.repository.refs], refs);
  const selected = await api.createCommitBranch(pending.commit, 'operator/keep-reviewed-change', f.context);
  assert.equal(selected.created, true); assert.equal(selected.commit, pending.commit);
  assert.equal(f.environment.source.workingBranch, branch); assert.equal(f.repository.refs.get(branch), head);
  assert.equal(f.repository.refs.get(selected.branch), pending.commit);
  const repeated = await api.createCommitBranch(pending.commit, selected.branch, f.context);
  assert.equal(repeated.created, false);
  assert.equal((await api.history(f.context)).transactions.length, 0);
  assert.equal(pending.id, undefined); assert.equal(pending.created, undefined);
});

for (const kind of ['parameter', 'policy', 'creation']) {
  test(`mutation outcomes: lost ${kind} response preserves indeterminate provenance without reporting a receipt`, async () => {
    const f = await githubWorkspaceFixture(), api = apiFor(f.service), head = await f.provider.workspaceHead();
    let committed;
    f.hooks.afterRequest = (path, init, result) => {
      if (path.endsWith('/commits') && init.method === 'POST') {
        committed = result; throw new Error('Synthetic response lost after the route committed.');
      }
    };
    const before = await f.provider.read(kind === 'policy' ? POLICY : MAIN);
    const result = kind === 'creation'
      ? await api.createContract({ name: 'lost-response' }, f.context)
      : kind === 'policy'
        ? await api.savePolicy({ path: POLICY, expectedHash: before.hash, changes: { variables: { jwtRequired: true } } }, f.context)
        : await api.save(MAIN, [{ op: 'set', path: ['environmentName'], value: 'reviewed' }], before.hash, null, f.context);
    assert.equal(result.outcome, 'indeterminate'); assert.equal(result.applied, null); assert.equal(result.changed, false);
    assert.equal(result.indeterminate, true); assert.equal(mutationComplete(result), false);
    assert.equal(result.transactionId, committed.transactionId);
    assert.equal(result.files.length, 0); assert.equal(result.hash, undefined);
    assert.match(result.warnings.join(' '), /not confirmed.*History/);
    assert.equal(await f.provider.workspaceHead(), head, 'An unknown outcome must not publish a new client head.');
    assert.equal((await api.history(f.context)).transactions[0].commit, committed.commit);
    if (kind === 'creation') {
      assert.equal(result.created, undefined); assert.equal(result.id, undefined);
      assert(f.raw(`${result.intended.dir}/main.bicepparam`), 'The real applied bytes must remain intact.');
    } else assert.equal(result.archived, null);
  });
}

test('mutation outcomes: parameter and policy successes retain actual commit, receipt and History metadata', async () => {
  const f = await githubWorkspaceFixture(), api = apiFor(f.service);
  const before = await f.provider.read(MAIN);
  const saved = await api.save(MAIN, [{ op: 'set', path: ['environmentName'], value: 'reviewed' }], before.hash, null, f.context);
  assert.equal(saved.applied, true); assert.equal(saved.outcome, 'applied');
  assert.equal(saved.archived, saved.commit); assert.notEqual(saved.transactionId, saved.commit);
  assert.equal((await api.history(f.context)).transactions[0].commit, saved.archived);
  const policy = await f.provider.read(POLICY);
  const changed = await api.savePolicy({ path: POLICY, expectedHash: policy.hash, changes: { variables: { jwtRequired: true } } }, f.context);
  assert.equal(changed.archived, changed.commit); assert.equal(changed.hash, (await f.provider.read(POLICY)).hash);
  assert.equal(changed.files[0].alias, POLICY); assert.match(changed.files[0].sha, /^[a-f0-9]{40}$/);
});

test('mutation outcomes: copy refuses and retries only the selected destination, leaving source bytes untouched', async () => {
  const source = await githubWorkspaceFixture({ environmentId: 'copy-source' });
  const target = await githubWorkspaceFixture({ environmentId: 'copy-target', files: {
    [MAIN]: citadelRepositoryFiles()[MAIN].replace("environmentName = 'dev'", "environmentName = 'target'"),
  } });
  source.service.registry = { listEnvironments: async () => [source.environment, target.environment], getHandle: async () => null };
  source.service.createProvider = async (environment) => environment.id === target.environment.id ? target.provider : source.provider;
  source.service.coordinator = new GitHubCommitCoordinator({
    contextProvider: () => source.context,
    request: (path, init) => path.includes(`/workspaces/${target.environment.id}/`) ? target.request(path, init) : source.request(path, init),
  });
  const api = apiFor(source.service), before = source.raw(MAIN), originalTarget = target.raw(MAIN);
  const sourceFile = await source.provider.read(MAIN);
  const preview = await api.previewCopy(target.environment.id, MAIN, ['environmentName'], sourceFile.hash, source.context);
  target.github.failNextRefUpdate = true;
  const pending = await api.copyParameters(target.environment.id, MAIN, ['environmentName'], preview.sourceHash, preview.targetHash, source.context);
  assert.equal(pending.applied, false); assert.equal(pending.outcome, 'pending');
  assert.equal(pending.unresolved.intendedBranch, target.environment.source.workingBranch);
  assert.equal(pending.files.length, 0); assert.equal(pending.plannedFiles[0].alias, MAIN);
  assert.deepEqual(target.raw(MAIN), originalTarget); assert.deepEqual(source.raw(MAIN), before);
  const copied = await api.copyParameters(target.environment.id, MAIN, ['environmentName'], preview.sourceHash, preview.targetHash, source.context);
  assert.equal(copied.applied, true); assert.equal(copied.branch, target.environment.source.workingBranch);
  assert.deepEqual(source.raw(MAIN), before);
  assert.match(new TextDecoder().decode(target.raw(MAIN)), /environmentName = 'dev'/);
  assert.equal((await target.service.history()).transactions[0].commit, copied.commit);
});

test('mutation outcomes: refused and uncertain History restores retain truthful branch and audit state', async () => {
  const f = await githubWorkspaceFixture(), api = apiFor(f.service);
  const before = await f.provider.read(MAIN);
  const saved = await api.save(MAIN, [{ op: 'set', path: ['environmentName'], value: 'reviewed' }], before.hash, null, f.context);
  const current = f.raw(MAIN);
  f.github.failNextRefUpdate = true;
  const pending = await api.restoreTransaction(saved.commit, f.context);
  assert.equal(pending.outcome, 'pending'); assert.equal(pending.applied, false); assert.equal(pending.files.length, 0);
  assert.deepEqual(f.raw(MAIN), current); assert.equal((await api.history(f.context)).transactions.length, 1);
  f.hooks.afterRequest = (path, init) => {
    if (path.endsWith('/reverts') && init.method === 'POST') throw new Error('Synthetic restore response lost.');
  };
  const unknown = await api.restoreTransaction(saved.commit, f.context);
  assert.equal(unknown.outcome, 'indeterminate'); assert.equal(unknown.applied, null);
  assert.deepEqual(f.raw(MAIN), before.bytes);
  assert.equal((await api.history(f.context)).transactions.length, 2);
});

for (const reverted of [false, true]) for (const refusal of [403, 409, 422]) {
  test(`GitHub reconciliation: ${refusal} with ${reverted ? 'reverted ancestor' : 'current collaborator equivalence'} has truthful authorship`, async () => {
    const f = await githubWorkspaceFixture(), branch = f.environment.source.workingBranch;
    const base = f.repository.refs.get(branch), refs = [...f.repository.refs.keys()];
    const fetch = f.client.fetch;
    let collaborator, proposal;
    f.client.fetch = async (href, init = {}) => {
      if (refPatch(href, init)) {
        proposal = JSON.parse(init.body).sha;
        collaborator = f.github.writeCommit(f.github.commits.get(proposal).tree, [base], 'Independent collaborator change');
        f.github.commits.get(collaborator).author.name = 'Independent collaborator';
        f.repository.refs.set(branch, reverted
          ? f.github.writeCommit(f.github.commits.get(base).tree, [collaborator], 'Independent collaborator revert') : collaborator);
        return f.github.json(refusal, { message: 'Synthetic ref refusal' });
      }
      return fetch(href, init);
    };
    const result = await apiFor(f.service).createContract({ name: 'equivalent-contract' }, f.context);
    assert.equal(result.alreadyApplied, undefined);
    assert.equal(result.applied, false); assert.equal(result.changed, false);
    assert.equal(result.outcome, reverted ? 'pending' : 'unchanged');
    if (reverted) {
      assert.equal(result.id, undefined); assert.equal(result.created, undefined);
      assert.equal(result.commit, proposal); assert.equal(result.unresolved.commit, proposal);
      assert.equal(f.raw(`${result.intended.dir}/main.bicepparam`), null);
    } else {
      assert.equal(result.commit, null); assert.equal(result.author, null);
      assert.equal(result.equivalentCommit, collaborator); assert.equal(result.proposedCommit, proposal);
      assert.equal(result.created.length, 0); assert(f.raw(`${result.dir}/main.bicepparam`));
      assert.match(result.warnings.join(' '), /No Citadel commit was applied/);
    }
    assert.equal((await f.service.history()).transactions.length, 0);
    assert.equal(f.audit.commits.some((record) => record.commit === collaborator), false);
    assert.deepEqual([...f.repository.refs.keys()], refs);
  });
}

for (const author of ['First actual writer', null]) for (const reverted of [false, true]) test(`GitHub reconciliation: audited duplicate after a collaborator ${reverted ? 'revert' : 'addition'} keeps real History attribution with ${author ? 'known' : 'unknown'} author`, async () => {
  const f = await githubWorkspaceFixture(), branch = f.environment.source.workingBranch;
  const base = f.repository.refs.get(branch), fetch = f.client.fetch;
  let first = null;
  f.client.fetch = async (href, init = {}) => {
    const response = await fetch(href, init);
    if (refPatch(href, init) && !first && response.ok) {
      first = JSON.parse(init.body).sha;
      f.github.commits.get(first).author.name = author;
      const tree = reverted ? f.github.commits.get(base).tree : f.github.writeNestedTree([
        ...f.github.treeOf(first),
        { path: 'collaborator.txt', mode: '100644', type: 'blob', sha: f.github.writeBlob('later independent work') },
      ]);
      f.repository.refs.set(branch, f.github.writeCommit(tree, [first], 'Later collaborator work'));
    }
    return response;
  };
  const results = await Promise.all([send(f, createBody(base, 'first-reviewed-attempt')), send(f, createBody(base, 'second-reviewed-attempt'))]);
  const duplicate = results.find((result) => result.alreadyApplied);
  assert(duplicate); assert.equal(duplicate.applied, true); assert.equal(duplicate.commit, first);
  assert.equal(duplicate.author, author);
  assert.equal(duplicate.movedAfterSave, true); assert.notEqual(duplicate.duplicateCommit, first);
  const history = await f.service.history();
  assert.equal(history.transactions.length, 1); assert.equal(history.transactions[0].commit, first);
  assert.equal(duplicate.transactionId, f.audit.commits.find((record) => record.commit === first).transactionId);
  assert.equal(f.repository.refs.size, 2);
  if (reverted) assert.deepEqual(f.github.treeOf(f.repository.refs.get(branch)), f.github.treeOf(base));
});

test('GitHub reconciliation: current equivalence is checked again before completing an unaudited no-op', async () => {
  const f = await githubWorkspaceFixture(), branch = f.environment.source.workingBranch;
  const base = f.repository.refs.get(branch), fetch = f.client.fetch;
  let refused = false, inspections = 0;
  f.client.fetch = async (href, init = {}) => {
    if (refPatch(href, init)) {
      const proposal = f.github.commits.get(JSON.parse(init.body).sha);
      f.repository.refs.set(branch, f.github.writeCommit(proposal.tree, [base], 'Collaborator equivalence'));
      refused = true;
      return f.github.json(422, { message: 'Synthetic refusal' });
    }
    if (refused && refRead(href, init) && ++inspections === 2) {
      const current = f.repository.refs.get(branch);
      f.repository.refs.set(branch, f.github.writeCommit(f.github.commits.get(base).tree, [current], 'Reverted before proof'));
    }
    return fetch(href, init);
  };
  const result = await send(f, createBody(base, 'late-revert-attempt'));
  assert.equal(result.outcome, 'pending'); assert.equal(result.applied, false);
  assert.equal(result.alreadyApplied, undefined); assert.equal(result.equivalentCommit, undefined);
  assert.equal(f.github.fileText(f.repository, branch, 'bicep/infra/reconciled.bicepparam'), null);
});

test('GitHub reconciliation: unreadable refusal inspection remains indeterminate with an explicit branch decision', async () => {
  const f = await githubWorkspaceFixture(), branch = f.environment.source.workingBranch;
  const base = await f.provider.workspaceHead(), fetch = f.client.fetch;
  let refused = false;
  f.client.fetch = async (href, init = {}) => {
    if (refPatch(href, init)) { refused = true; return f.github.json(422, { message: 'Synthetic refusal' }); }
    if (refused && refRead(href, init)) throw new Error('Synthetic inspection unavailable');
    return fetch(href, init);
  };
  const result = await apiFor(f.service).createContract({ name: 'unconfirmed-contract' }, f.context);
  assert.equal(result.outcome, 'indeterminate'); assert.equal(result.applied, null);
  assert.equal(result.unresolved.kind, 'outcome-unknown'); assert.equal(result.unresolved.commit, result.commit);
  assert.equal(result.created, undefined); assert.equal(result.id, undefined);
  assert.equal(f.repository.refs.get(branch), base); assert.equal(f.repository.refs.size, 2);
  assert.equal(await f.provider.workspaceHead(), base);
});
