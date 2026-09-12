import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubApiClient, githubError } from '../server/github/api.mjs';
import { isReachable } from '../server/github/git-reader.mjs';
import { createGitHubHistory } from '../server/github/history.mjs';
import * as workspace from '../server/github/workspace.mjs';
import { configurationKey } from '../shared/workspace-configuration.mjs';
import { sha256 } from '../shared/source-scope.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN } from './_github-mock.mjs';
import { nativeConfiguration, NATIVE_FILES } from './_native-fixture.mjs';

const ALIAS = 'bicep/infra/main.bicepparam';
const ADDED = 'bicep/policies/added.xml';
const REMOVED = 'bicep/policies/removed.xml';
const BEFORE = {
  [ALIAS]: "\ufeffparam location = 'before'\r\n",
  [REMOVED]: { content: '<before />\r\n', mode: '100755' },
};
const AFTER = {
  [ALIAS]: "\ufeffparam location = 'after'\r\n",
  [ADDED]: { content: '<added />\r\n', mode: '100755' },
};

const content = (file) => typeof file === 'string' ? file : file.content;
const message = (environmentId) => `Synthetic change\n\nCitadel-Action: parameter-edit\nCitadel-Environment: ${environmentId}\nCitadel-Transaction: a5-original-change`;

async function fixture(settings = {}) {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9801, fullName: 'synthetic/a5-history' });
  const branch = 'citadel-ui/a5-history', environmentId = 'a5-history';
  const before = settings.before || BEFORE, after = settings.after || AFTER;
  const parent = github.seed(repository, branch, before);
  const commit = github.seed(repository, branch, after, { parents: [parent], message: message(environmentId) });
  const events = [], requests = [], writerCalls = [];
  const client = new GitHubApiClient({
    fetch: (href, init) => {
      const url = new URL(href);
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(init.headers.Authorization, `Bearer ${TEST_TOKEN}`);
      const call = {
        kind: 'request', method: init.method, path: url.pathname + url.search,
        body: init.body === undefined ? null : JSON.parse(init.body),
        redirect: init.redirect, cache: init.cache,
      };
      requests.push(call);
      events.push(call);
      return settings.respond ? settings.respond(href, init, github) : github.fetch(href, init);
    },
  });
  const audit = new MemoryAudit();
  const aliases = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((alias) => JSON.stringify(before[alias]) !== JSON.stringify(after[alias]));
  const record = {
    repositoryId: repository.id, fullName: repository.full_name, branch, environmentId,
    action: 'parameter-edit', transactionId: 'a5-original-change', baseCommit: parent, commit, aliases,
    ...(settings.configuration ? { configurationKey: configurationKey(settings.configuration), nativeCreation: false } : {}),
  };
  await audit.record(record);
  for (const name of ['find', 'listForEnvironment', 'record']) {
    const original = audit[name].bind(audit);
    audit[name] = (...args) => {
      events.push({ kind: `audit.${name}`, args });
      return original(...args);
    };
  }
  const history = createGitHubHistory({
    parseTrailers: workspace.parseTrailers,
    commitChangeSet: (actualClient, token, options) => {
      writerCalls.push({ client: actualClient, token, options });
      events.push({ kind: 'writer' });
      return (settings.writer || workspace.commitChangeSet)(actualClient, token, options);
    },
  });
  const options = {
    fullName: repository.full_name, branch, commitSha: commit, environmentId,
    transactionId: 'a5-inverse-change', repositoryId: repository.id, audit,
    configuration: settings.configuration,
  };
  const reset = () => { events.length = 0; requests.length = 0; writerCalls.length = 0; };
  return {
    github, repository, branch, environmentId, parent, commit, before, after, record,
    client, audit, history, options, events, requests, writerCalls, settings, reset,
    undo: () => history.revertCommit(client, TEST_TOKEN, options),
    base: `/repos/${repository.full_name}`,
    listing: `/repos/${repository.full_name}/commits?sha=${encodeURIComponent(branch)}&per_page=100`,
  };
}

function assertOnlyReads(f) {
  assert(f.requests.every((call) => call.method === 'GET' && call.body === null));
  assert(f.requests.every((call) => call.redirect === 'manual' && call.cache === 'no-store'));
}

function entry(f, commit, alias) {
  return f.github.treeOf(commit).find((file) => file.path === alias);
}

test('A5 Git history: facades retain signatures and share bounded reachability with mutation', async () => {
  const f = await fixture();
  assert.equal(workspace.isReachable, isReachable);
  assert.equal(isReachable.length, 5);
  for (const [name, arity] of Object.entries({ loadHistory: 5, inspectCommit: 5, revertCommit: 3 })) {
    assert.equal(workspace[name].length, arity);
    assert.equal(f.history[name].length, arity);
    assert.equal(workspace[name].name, name);
  }
  assert.deepEqual(Object.keys(f.history), ['loadHistory', 'inspectCommit', 'revertCommit']);
  assert.deepEqual(await workspace.loadHistory(f.client, TEST_TOKEN, f.repository.full_name, f.branch, f.environmentId, { audit: f.audit }),
    await f.history.loadHistory(f.client, TEST_TOKEN, f.repository.full_name, f.branch, f.environmentId, { audit: f.audit }));
  assert.equal(f.writerCalls.length, 0);
  assertOnlyReads(f);
});

test('A5 Git history: listing is audit-first and excludes forged trailers and incompatible native scope', async () => {
  const f = await fixture();
  const forged = f.github.seed(f.repository, f.branch, AFTER, { parents: [f.commit], message: message(f.environmentId) });
  const alien = f.github.seed(f.repository, f.branch, AFTER, { parents: [forged], message: message('another-environment') });
  await f.audit.record({ ...f.record, commit: alien });
  const native = f.github.seed(f.repository, f.branch, AFTER, { parents: [alien], message: message(f.environmentId) });
  await f.audit.record({ ...f.record, commit: native, configurationKey: 'another-native-binding' });
  f.reset();
  const rows = await f.history.loadHistory(f.client, TEST_TOKEN, f.repository.full_name, f.branch, f.environmentId, { audit: f.audit });
  assert.deepEqual(f.events.map((event) => event.kind), ['audit.listForEnvironment', 'request']);
  assert.deepEqual(f.events[0].args, [f.environmentId, f.branch]);
  assert.deepEqual(f.requests.map((call) => call.path), [f.listing]);
  assert.deepEqual(rows, [{
    transactionId: f.record.transactionId, id: f.commit, commit: f.commit,
    parent: f.parent, parents: [f.parent], status: 'committed',
    targetLabel: f.record.action, action: f.record.action,
    aliases: f.record.aliases, files: f.record.aliases.map((alias) => ({ alias })),
    author: 'Citadel UI', committedAt: '2026-02-01T00:00:00Z', completedAt: '2026-02-01T00:00:00Z',
    subject: 'Synthetic change', canUndo: true, isHead: false,
  }]);
  assertOnlyReads(f);
});

test('A5 Git history: listing caps 101 eligible results at 100 without requesting another page', async () => {
  const f = await fixture();
  f.audit.commits.length = 0;
  const commits = [];
  for (let index = 1; index <= 101; index += 1) {
    const sha = index.toString(16).padStart(40, '0');
    commits.push({ sha, parents: [{ sha: f.parent }], commit: { message: message(f.environmentId) } });
    await f.audit.record({ ...f.record, commit: sha });
  }
  f.settings.respond = (href, _init, github) => {
    assert.equal(new URL(href).pathname + new URL(href).search, f.listing);
    return github.json(200, commits);
  };
  f.reset();
  const rows = await f.history.loadHistory(f.client, TEST_TOKEN, f.repository.full_name, f.branch, f.environmentId, { audit: f.audit });
  assert.equal(rows.length, 100);
  assert.deepEqual(rows.map((row) => row.commit), commits.slice(0, 100).map((row) => row.sha));
  assert.equal(rows[0].isHead, true);
  assert.deepEqual(f.requests.map((call) => call.path), [f.listing]);
  assertOnlyReads(f);
});

test('A5 Git history: reachability is an uncached one-page read and propagates provider errors', async () => {
  const f = await fixture();
  const tree = f.github.commits.get(f.commit).tree, chain = [];
  let parent = f.parent;
  for (let index = 0; index < 101; index += 1) {
    parent = f.github.writeCommit(tree, [parent], `Synthetic bounded ancestor ${index}`);
    chain.push(parent);
  }
  f.repository.refs.set(f.branch, parent);
  assert.equal(await isReachable(f.client, TEST_TOKEN, f.repository.full_name, f.branch, chain[1]), true);
  assert.equal(await isReachable(f.client, TEST_TOKEN, f.repository.full_name, f.branch, chain[0]), false);
  f.repository.refs.set(f.branch, f.parent);
  assert.equal(await isReachable(f.client, TEST_TOKEN, f.repository.full_name, f.branch, chain[1]), false);
  assert.deepEqual(f.requests.map((call) => call.path), [f.listing, f.listing, f.listing]);
  const failure = githubError(503, 'SYNTHETIC_READ_FAILURE', 'Synthetic read failure');
  await assert.rejects(isReachable({ request: async () => { throw failure; } }, TEST_TOKEN, f.repository.full_name, f.branch, chain[0]),
    (error) => error === failure);
  assertOnlyReads(f);
});

for (const mismatch of ['audit', 'record', 'repositoryId', 'environmentId', 'branch']) {
  test(`A5 Git history: ${mismatch} authority fails before any remote read or writer call`, async () => {
    const f = await fixture();
    if (mismatch === 'audit') f.options.audit = null;
    else if (mismatch === 'record') f.audit.commits.length = 0;
    else f.options[mismatch] = mismatch === 'repositoryId' ? 9802 : 'another-scope';
    await assert.rejects(f.undo(), {
      status: mismatch === 'audit' ? 500 : 403,
      code: mismatch === 'audit' ? 'AUDIT_UNAVAILABLE' : 'UNAUDITED_COMMIT',
    });
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.writerCalls, []);
    if (mismatch !== 'audit') {
      assert.deepEqual(f.events, [{
        kind: 'audit.find',
        args: [{ commit: f.commit, repositoryId: f.options.repositoryId, environmentId: f.options.environmentId, branch: f.options.branch }],
      }]);
    }
  });
}

test('A5 Git history: audit errors and unreachable commits are not success-shaped inverse plans', async () => {
  const f = await fixture();
  const read = f.audit.find, failure = new Error('Synthetic audit read failure');
  f.audit.find = async () => { throw failure; };
  await assert.rejects(f.undo(), (error) => error === failure);
  assert.deepEqual(f.requests, []);
  f.audit.find = read;
  f.repository.refs.set(f.branch, f.parent);
  await assert.rejects(f.undo(), { status: 409, code: 'UNREACHABLE_COMMIT' });
  assert.deepEqual(f.requests.map((call) => call.path), [f.listing]);
  assert.deepEqual(f.writerCalls, []);
  assertOnlyReads(f);
});

for (const changed of ['bytes', 'mode', 'symlink', 'submodule']) {
  test(`A5 Git history: current ${changed} changes block inspection eligibility and inverse publication`, async () => {
    const f = await fixture();
    const replacement = changed === 'bytes' ? "\ufeffparam location = 'collaborator'\r\n" : {
      content: AFTER[ALIAS],
      mode: { mode: '100755', symlink: '120000', submodule: '160000' }[changed],
    };
    f.github.seed(f.repository, f.branch, { ...AFTER, [ALIAS]: replacement }, { parents: [f.commit] });
    const inspection = await f.history.inspectCommit(f.client, TEST_TOKEN, f.repository.full_name, f.branch, f.commit, { record: f.record });
    assert.equal(inspection.canRevert, false);
    assert.equal(inspection.files.find((file) => file.alias === ALIAS).state, 'unexpected');
    f.reset();
    await assert.rejects(f.undo(), { status: 409, code: 'STALE_SOURCE' });
    assert.equal(f.events[0].kind, 'audit.find');
    assert.deepEqual(f.requests.slice(0, 3).map((call) => call.path), [
      f.listing, `${f.base}/commits/${f.commit}`, `${f.base}/git/ref/heads/${f.branch}`,
    ]);
    assert.deepEqual(f.writerCalls, []);
    assertOnlyReads(f);
  });
}

const outcomes = [
  { outcome: 'applied', applied: true, changed: true, commit: 'a'.repeat(40) },
  { outcome: 'unchanged', applied: false, changed: false, commit: null, equivalentCommit: 'b'.repeat(40), proposedCommit: 'a'.repeat(40) },
  { outcome: 'pending', applied: false, changed: false, commit: 'a'.repeat(40), unresolved: { kind: 'branch-protected' } },
  { outcome: 'indeterminate', applied: null, changed: false, commit: 'a'.repeat(40), indeterminate: true, unresolved: { kind: 'outcome-unknown' } },
  { outcome: 'applied', applied: true, changed: true, commit: 'b'.repeat(40), alreadyApplied: true, duplicateCommit: 'a'.repeat(40), attemptTransactionId: 'a5-attempt' },
];

for (const outcome of outcomes) {
  test(`A5 Git history: one injected writer receives the exact inverse and retains ${outcome.alreadyApplied ? 'already-applied' : outcome.outcome} provenance`, async () => {
    const answer = Object.freeze({ ...outcome, transactionId: 'a5-actual-change', warnings: ['Synthetic warning'] });
    const f = await fixture({ writer: () => answer });
    assert.equal(await f.undo(), answer);
    assert.equal(f.writerCalls.length, 1);
    const write = f.writerCalls[0];
    assert.equal(write.client, f.client);
    assert.equal(write.token, TEST_TOKEN);
    assert.deepEqual(write.options, {
      fullName: f.repository.full_name, branch: f.branch, expectedHead: f.commit,
      requestBudget: false,
      files: [
        {
          alias: ALIAS, blobSha: entry(f, f.commit, ALIAS).sha, beforeHash: await sha256(Buffer.from(AFTER[ALIAS])),
          after: Buffer.from(BEFORE[ALIAS]).toString('base64'), mode: '100644',
        },
        {
          alias: ADDED, remove: true, blobSha: entry(f, f.commit, ADDED).sha,
          beforeHash: await sha256(Buffer.from(content(AFTER[ADDED]))), mode: '100755',
        },
        {
          alias: REMOVED, create: true,
          after: Buffer.from(content(BEFORE[REMOVED])).toString('base64'), mode: '100755',
        },
      ],
      action: 'history-undo', environmentId: f.environmentId, transactionId: 'a5-inverse-change',
      repositoryId: f.repository.id, audit: f.audit, subscriptionAlias: null,
      configuration: undefined, nativeHistory: false,
    });
    const tree = f.github.commits.get(f.commit).tree, parentTree = f.github.commits.get(f.parent).tree;
    assert.deepEqual(f.requests.map((call) => call.path), [
      f.listing, `${f.base}/commits/${f.commit}`, `${f.base}/git/ref/heads/${f.branch}`,
      `${f.base}/git/commits/${f.commit}`, `${f.base}/git/trees/${tree}?recursive=1`,
      `${f.base}/git/commits/${f.commit}`, `${f.base}/git/trees/${tree}?recursive=1`,
      `${f.base}/git/commits/${f.parent}`, `${f.base}/git/trees/${parentTree}?recursive=1`,
      `${f.base}/git/blobs/${entry(f, f.parent, ALIAS).sha}`,
      `${f.base}/git/blobs/${entry(f, f.commit, ALIAS).sha}`,
      `${f.base}/git/blobs/${entry(f, f.commit, ADDED).sha}`,
      `${f.base}/git/blobs/${entry(f, f.parent, REMOVED).sha}`,
    ]);
    assert.equal(f.events[0].kind, 'audit.find');
    assert.equal(f.events.at(-1).kind, 'writer');
    assert.equal(f.repository.refs.get(f.branch), f.commit);
    assert.equal(f.audit.commits.length, 1);
    assertOnlyReads(f);
  });
}

test('A5 Git history: actual inverse publication uses the existing audited nonforced writer', async () => {
  const f = await fixture();
  const result = await f.undo();
  assert.equal(f.writerCalls.length, 1);
  assert.equal(result.outcome, 'applied');
  assert.equal(f.repository.refs.get(f.branch), result.commit);
  assert.deepEqual(f.github.commits.get(result.commit).parents, [f.commit]);
  const writes = f.requests.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes.map((call) => [call.method, call.path]), [
    ['POST', `${f.base}/git/blobs`], ['POST', `${f.base}/git/blobs`],
    ['POST', `${f.base}/git/trees`], ['POST', `${f.base}/git/commits`],
    ['PATCH', `${f.base}/git/refs/heads/${f.branch}`],
  ]);
  assert.deepEqual(writes.at(-1).body, { sha: result.commit, force: false });
  assert.deepEqual(Object.keys(writes[3].body).sort(), ['message', 'parents', 'tree']);
  const audited = f.events.findIndex((event) => event.kind === 'audit.record');
  const published = f.events.findIndex((event) => event.kind === 'request' && event.method === 'PATCH');
  assert(audited > 0 && audited < published);
  assert.deepEqual(workspace.parseTrailers(writes[3].body.message), {
    action: 'history-undo', environmentId: f.environmentId, transactionId: 'a5-inverse-change',
  });
  assert.equal(f.github.fileText(f.repository, f.branch, ALIAS), BEFORE[ALIAS]);
  assert.equal(f.github.fileText(f.repository, f.branch, REMOVED), content(BEFORE[REMOVED]));
  assert.equal(entry(f, result.commit, REMOVED).mode, '100755');
  assert.equal(f.github.fileText(f.repository, f.branch, ADDED), null);
});

test('A5 Git history: writer errors and audit publication failures are never converted or retried', async () => {
  const failure = githubError(409, 'SYNTHETIC_WRITER_FAILURE', 'Synthetic writer failure');
  const f = await fixture({ writer: () => { throw failure; } });
  await assert.rejects(f.undo(), (error) => error === failure);
  assert.equal(f.writerCalls.length, 1);
  assertOnlyReads(f);
  f.settings.writer = workspace.commitChangeSet;
  f.audit.record = async () => { throw new Error('Synthetic audit write failure'); };
  f.reset();
  await assert.rejects(f.undo(), { status: 503, code: 'AUDIT_UNAVAILABLE' });
  assert.equal(f.writerCalls.length, 1);
  assert.equal(f.requests.some((call) => call.method === 'PATCH'), false);
  assert.equal(f.repository.refs.get(f.branch), f.commit);
});

test('A5 Git history: truncated parent lookup restores the exact internal subscription capability', async () => {
  const alias = '.azure/dev/.env';
  const before = 'AZURE_SUBSCRIPTION_ID=11111111-1111-4111-8111-111111111111\r\nOTHER=preserved\r\n';
  const after = before.replaceAll('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
  const f = await fixture({ before: { [alias]: before }, after: { [alias]: after }, writer: () => ({ outcome: 'pending' }) });
  f.github.truncateTrees = true;
  await f.undo();
  assert.equal(f.writerCalls.length, 1);
  assert.equal(f.writerCalls[0].options.subscriptionAlias, alias);
  assert.deepEqual(f.writerCalls[0].options.files, [{
    alias, blobSha: entry(f, f.commit, alias).sha, beforeHash: await sha256(Buffer.from(after)),
    after: Buffer.from(before).toString('base64'), mode: '100644',
  }]);
  assert(f.requests.some((call) => /\/git\/trees\/[0-9a-f]+$/.test(call.path)));
  assertOnlyReads(f);
});

test('A5 Git history: native scope gates inspection before reading and preserves inverse native identity', async () => {
  const configuration = nativeConfiguration(['deployment']);
  const ordinary = await fixture();
  await assert.rejects(ordinary.history.inspectCommit(ordinary.client, TEST_TOKEN, ordinary.repository.full_name, ordinary.branch,
    ordinary.commit, { record: ordinary.record, configuration }), { code: 'NATIVE_HISTORY_SCOPE' });
  assert.deepEqual(ordinary.requests, []);
  const alias = 'environments/development.tfvars';
  const f = await fixture({
    before: NATIVE_FILES, after: { ...NATIVE_FILES, [alias]: NATIVE_FILES[alias].replace('"synthetic-dev"', '"synthetic-after"') },
    configuration, writer: () => ({ outcome: 'pending' }),
  });
  await f.undo();
  assert.equal(f.writerCalls.length, 1);
  assert.equal(f.writerCalls[0].options.configuration, configuration);
  assert.equal(f.writerCalls[0].options.nativeHistory, true);
  assert.deepEqual(f.writerCalls[0].options.files.map((file) => file.alias), [alias]);
  assert.equal(Buffer.from(f.writerCalls[0].options.files[0].after, 'base64').toString('utf8'), NATIVE_FILES[alias]);
  assertOnlyReads(f);
});
