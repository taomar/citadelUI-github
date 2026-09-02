/**
 * Losing the answer is not the same as failing.
 *
 * The defect these cover was observed in production: the UI showed a 502 and a
 * correlation id while `/api/activity` recorded `repository.attach outcome: ok`
 * for the same moment. The server had created the working branch; the transport
 * lost the response; the browser reported a failure and stopped.
 *
 * So the tests here are about ambiguity, not about errors. They drive the real
 * `attachGitHubEnvironment` against a server that succeeds and then loses its
 * answer, and require exactly one workspace, one branch and one reservation to
 * come out the other side.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { installDom } from './_dom-stub.mjs';
import { createCitadelServer } from '../server/index.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MockGitHub, TEST_TOKEN } from './_github-mock.mjs';

installDom();

const { ATTACH_STAGES, StageTracker } = await import('../web/js/stage-progress.mjs');
const { attachGitHubEnvironment } = await import('../web/js/workspace-context.mjs');

/** A registry double with exactly the durability the attach path depends on. */
function memoryRegistry() {
  const store = {
    projects: [],
    environments: [],
    pending: [],
    tombstones: { projectIds: [], environmentIds: [] },
    active: null,
  };
  return {
    store,
    async createProject(label) {
      const project = { id: `project-${store.projects.length + 1}`, label };
      store.projects.push(project);
      return project;
    },
    async removeProject(id) {
      store.projects = store.projects.filter((item) => item.id !== id);
    },
    async addGitHubEnvironment(projectId, label, source, options = {}) {
      const environment = { id: options.id, projectId, label, source };
      store.environments.push(environment);
      return environment;
    },
    async updateEnvironment(id, updates) {
      const index = store.environments.findIndex((item) => item.id === id);
      store.environments[index] = { ...store.environments[index], ...updates };
      return store.environments[index];
    },
    async removeEnvironment(id) {
      store.environments = store.environments.filter((item) => item.id !== id);
    },
    async getHandle() {
      return null;
    },
    setActive(projectId, environmentId) {
      store.active = { projectId, environmentId };
    },
    pendingAttachment(selection) {
      return (
        store.pending.find(
          (entry) =>
            entry.repositoryId === selection.repositoryId &&
            entry.sourceBranch === selection.sourceBranch &&
            entry.writeMode === selection.writeMode
        ) || null
      );
    },
    savePendingAttachment(value) {
      store.pending = store.pending.filter((entry) => entry.operationKey !== value.operationKey);
      store.pending.push(value);
    },
    clearPendingAttachment(key) {
      store.pending = store.pending.filter((entry) => entry.operationKey !== key);
    },
    addTombstones({ projectIds = [], environmentIds = [] }) {
      store.tombstones.projectIds.push(...projectIds);
      store.tombstones.environmentIds.push(...environmentIds);
    },
    removeTombstones({ projectIds = [], environmentIds = [] }) {
      store.tombstones.projectIds = store.tombstones.projectIds.filter((id) => !projectIds.includes(id));
      store.tombstones.environmentIds = store.tombstones.environmentIds.filter(
        (id) => !environmentIds.includes(id)
      );
    },
    clearTombstones() {
      store.tombstones = { projectIds: [], environmentIds: [] };
    },
  };
}

/**
 * A provider over the same Citadel fixture the server scans, so the attach path
 * runs its real discovery rather than a stub that would hide a regression in it.
 */
function fixtureProvider() {
  const files = citadelRepositoryFiles();
  const textOf = (value) => (typeof value === 'string' ? value : value.content);
  // `kind` is what discovery filters on, and it comes from the extension exactly
  // as the real providers derive it. Labelling everything `file` would make
  // discovery see no parameter files and report the workspace incompatible.
  const kindOf = (alias) =>
    alias.endsWith('.bicepparam')
      ? 'bicepparam'
      : alias.endsWith('.bicep')
        ? 'bicep'
        : alias.endsWith('.xml')
          ? 'policy'
          : 'other';
  return {
    async entries() {
      return Object.keys(files).map((alias) => ({ alias, kind: kindOf(alias) }));
    },
    async read(alias) {
      const value = files[alias];
      if (value === undefined) throw new Error(`Source not found: ${alias}`);
      const text = textOf(value);
      return { text, size: text.length, hash: 'a'.repeat(64) };
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-attach-recovery-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await mkdir(join(root, 'shared'), { recursive: true });
  await writeFile(
    join(root, 'web', 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body></body></html>'
  );
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9001, fullName: 'taomar/citadelQA' });
  github.seed(repository, 'CitadelQA', citadelRepositoryFiles());
  const created = await createCitadelServer({
    webRoot: join(root, 'web'),
    sharedRoot: join(root, 'shared'),
    dataRoot: join(root, 'data'),
    allowedHost: '127.0.0.1:4173',
    allowedOrigin: 'http://127.0.0.1:4173',
    sessionToken: 'browser-session',
    githubOptions: { clientOptions: { fetch: github.fetch } },
  });
  t.after(async () => {
    await created.activityStore.settled();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const routes = created.githubRoutes;
  const session = routes.sessions.create(
    TEST_TOKEN,
    { login: 'octo-dev', id: 4242, type: 'User' },
    { tokenKind: 'fine-grained' }
  );
  const req = { method: 'POST', headers: { 'x-citadel-github-session': session.id } };
  return {
    github,
    routes,
    // The two calls the browser makes, straight onto the real route handlers.
    attach: (payload) => routes.attach(req, payload),
    attachmentStatus: (payload) => routes.attachmentStatus(req, payload),
  };
}

function transportFailure(status) {
  return Object.assign(new Error(`GitHub could not be reached (${status}).`), {
    status,
    code: 'GITHUB_REQUEST_FAILED',
  });
}

test('a created branch whose response is lost is recovered, not reported as a failure', async (t) => {
  const server = await fixture(t);
  const registry = memoryRegistry();
  const stages = [];
  let attachCalls = 0;
  let statusCalls = 0;

  const result = await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'QA',
    repositoryId: 9001,
    sourceBranch: 'CitadelQA',
    registry,
    mirror: async () => {},
    makeProvider: async () => fixtureProvider(),
    activate: false,
    wait: async () => {},
    stage: (id) => stages.push(id),
    attach: async (payload) => {
      attachCalls += 1;
      // The server really does the work. Only the answer is lost, exactly as in
      // production: the branch exists, the activity says `ok`, the browser sees
      // a 502.
      const real = await server.attach(payload);
      if (attachCalls === 1) throw transportFailure(502);
      return real;
    },
    attachmentStatus: async (payload) => {
      statusCalls += 1;
      // The first reconcile attempt also fails, so recovery cannot depend on the
      // status read succeeding.
      if (statusCalls === 1) throw transportFailure(504);
      return server.attachmentStatus(payload);
    },
  });

  assert.ok(result.environment, 'no workspace was produced');
  assert.equal(result.attachment.source.fullName, 'taomar/citadelQA');
  assert.equal(result.attachment.source.sourceBranch, 'CitadelQA');

  // Exactly one workspace, one project, and no residue.
  assert.equal(registry.store.environments.length, 1);
  assert.equal(registry.store.projects.length, 1);
  assert.deepEqual(registry.store.pending, [], 'the pending attempt was not retired');
  assert.deepEqual(registry.store.tombstones, { projectIds: [], environmentIds: [] });

  // Exactly one working branch. A second would mean the retry minted a new key.
  const branches = [...server.github.repositories.get(9001).refs.keys()].filter((ref) =>
    ref.startsWith('citadel-ui/')
  );
  assert.equal(branches.length, 1, `expected one working branch, found ${branches.join(', ')}`);
  assert.equal(branches[0], result.attachment.source.workingBranch);

  // The recovery went through the status read and the replay, in that order.
  assert.ok(statusCalls >= 1, 'the status endpoint was never consulted');
  assert.ok(attachCalls >= 2, 'the idempotent attach was never replayed');

  // And the stages the user watched are the real ones, in order.
  assert.deepEqual(stages, ['revalidate', 'branch', 'metadata', 'open', 'ready']);
});

test('a replayed attach returns the original reservation rather than a second branch', async (t) => {
  const server = await fixture(t);
  const payload = {
    repositoryId: 9001,
    sourceBranch: 'CitadelQA',
    environmentId: 'env-replay',
    writeMode: 'working-branch',
    operationKey: 'replay-key-00000001',
  };
  const first = await server.attach(payload);
  const second = await server.attach(payload);
  const third = await server.attach(payload);

  assert.equal(first.operationId, second.operationId);
  assert.equal(second.operationId, third.operationId);
  assert.deepEqual(first.source, third.source);
  const branches = [...server.github.repositories.get(9001).refs.keys()].filter((ref) =>
    ref.startsWith('citadel-ui/')
  );
  assert.equal(branches.length, 1);

  // And the status endpoint reports the same result the attach would have.
  const status = await server.attachmentStatus({ operationKey: payload.operationKey });
  assert.equal(status.state, 'attached');
  assert.deepEqual(status.result.source, first.source);
});

test('an operation key the server has never seen is unknown, not attached', async (t) => {
  const server = await fixture(t);
  const status = await server.attachmentStatus({ operationKey: 'never-issued-00000001' });
  assert.deepEqual(status, { state: 'unknown', result: null });
  await assert.rejects(
    server.attachmentStatus({ operationKey: 'bad key!' }),
    (error) => error.code === 'INVALID_OPERATION_KEY'
  );
  await assert.rejects(
    server.attachmentStatus({ operationKey: 'ok-key-00000001', extra: true }),
    (error) => error.code === 'INVALID_CONTENT'
  );
});

test('an unresolved attempt keeps its key, is not terminal, and can be retried', async (t) => {
  const server = await fixture(t);
  const registry = memoryRegistry();
  const stages = [];
  let attachCalls = 0;

  // Everything after the first call fails ambiguously, so reconciliation runs
  // out of budget without ever proving anything either way.
  const failure = await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'QA',
    repositoryId: 9001,
    sourceBranch: 'CitadelQA',
    registry,
    mirror: async () => {},
    makeProvider: async () => fixtureProvider(),
    activate: false,
    wait: async () => {},
    reconcileDelays: [0, 0],
    stage: (id) => stages.push(id),
    attach: async (payload) => {
      attachCalls += 1;
      if (attachCalls === 1) {
        await server.attach(payload);
        throw transportFailure(502);
      }
      throw transportFailure(502);
    },
    attachmentStatus: async () => {
      throw transportFailure(504);
    },
  }).then(
    () => null,
    (error) => error
  );

  assert.ok(failure, 'an unresolved attach resolved successfully');
  assert.equal(failure.code, 'ATTACH_UNRESOLVED');
  assert.equal(failure.attachUnresolved, true);
  // Marked so the UI refuses to call it a failure and offers a resuming retry.
  assert.equal(failure.attachUnconfirmed, true);
  assert.match(failure.message, /may have completed/i);
  assert.match(failure.message, /will not create a second branch/i);

  // The durable attempt survives: it is the only thing that can address the
  // branch the server may already have created.
  assert.equal(registry.store.pending.length, 1, 'the pending attempt was discarded');
  const retained = registry.store.pending[0];

  // Retrying reuses that exact attempt and completes one workspace.
  const recovered = await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'QA',
    repositoryId: 9001,
    sourceBranch: 'CitadelQA',
    registry,
    mirror: async () => {},
    makeProvider: async () => fixtureProvider(),
    activate: false,
    wait: async () => {},
    stage: () => {},
    attach: (payload) => server.attach(payload),
    attachmentStatus: (payload) => server.attachmentStatus(payload),
  });
  assert.equal(recovered.environment.id, retained.environmentId);
  assert.equal(registry.store.environments.length, 1);
  const branches = [...server.github.repositories.get(9001).refs.keys()].filter((ref) =>
    ref.startsWith('citadel-ui/')
  );
  assert.equal(branches.length, 1, 'a second working branch was created');
});

test('a positively terminal rejection abandons immediately and never retries', async (t) => {
  const server = await fixture(t);
  const registry = memoryRegistry();
  let attachCalls = 0;
  let statusCalls = 0;

  const failure = await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'QA',
    repositoryId: 9001,
    sourceBranch: 'CitadelQA',
    registry,
    mirror: async () => {},
    makeProvider: async () => fixtureProvider(),
    activate: false,
    wait: async () => {},
    stage: () => {},
    attach: async () => {
      attachCalls += 1;
      throw Object.assign(new Error('Archived repositories cannot be attached for editing.'), {
        status: 400,
        code: 'REPOSITORY_ARCHIVED',
      });
    },
    attachmentStatus: async () => {
      statusCalls += 1;
      return { state: 'unknown', result: null };
    },
  }).then(
    () => null,
    (error) => error
  );

  assert.equal(failure.code, 'REPOSITORY_ARCHIVED');
  assert.equal(attachCalls, 1, 'a definite rejection was retried');
  assert.equal(statusCalls, 0, 'a definite rejection was reconciled');
  // Nothing was created, so nothing is retained to reconcile later.
  assert.deepEqual(registry.store.pending, []);
  assert.equal(registry.store.environments.length, 0);
  // The initial request covers revalidate/reserve/branch as one round trip; a
  // definite rejection lands on the first of them, which is where a retry would
  // resume.
  assert.equal(failure.attachStage, 'revalidate');
  assert.equal(server.github.repositories.get(9001).refs.has('citadel-ui/'), false);
});

test('a metadata failure after a successful branch resumes at metadata, not at the branch', async (t) => {
  const server = await fixture(t);
  const registry = memoryRegistry();
  const stages = [];

  const failure = await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'QA',
    repositoryId: 9001,
    sourceBranch: 'CitadelQA',
    registry,
    // The branch succeeds; persisting the workspace does not.
    mirror: async () => {
      throw new Error('The container did not accept the registry update.');
    },
    makeProvider: async () => fixtureProvider(),
    activate: false,
    wait: async () => {},
    stage: (id) => stages.push(id),
    attach: (payload) => server.attach(payload),
    attachmentStatus: (payload) => server.attachmentStatus(payload),
  }).then(
    () => null,
    (error) => error
  );

  assert.ok(failure);
  // The step named is the one that actually failed. Narrating this as a branch
  // failure would send a retry back to create a branch that already exists.
  assert.equal(failure.attachStage, 'metadata');
  assert.deepEqual(stages, ['revalidate', 'metadata']);
  assert.match(failure.message, /registry update|working branch/i);
});

test('the stage vocabulary is the one the workflow reports, in order', () => {
  assert.deepEqual(
    ATTACH_STAGES.map((stage) => stage.id),
    ['revalidate', 'reserve', 'branch', 'metadata', 'open', 'ready']
  );
  assert.deepEqual(
    ATTACH_STAGES.map((stage) => stage.label),
    [
      'Revalidating Citadel branch',
      'Reserving attachment',
      'Creating or recovering working branch',
      'Saving workspace metadata',
      'Opening workspace',
      'Ready',
    ]
  );

  // Entering a stage completes everything before it, so a checkmark can never
  // appear ahead of the work it claims.
  const tracker = new StageTracker(ATTACH_STAGES);
  tracker.begin('branch');
  const states = new Map(tracker.list().map((stage) => [stage.id, stage.state]));
  assert.equal(states.get('revalidate'), 'done');
  assert.equal(states.get('reserve'), 'done');
  assert.equal(states.get('branch'), 'active');
  assert.equal(states.get('metadata'), 'pending');

  // A failure stops at the step that failed and keeps the ones already done.
  tracker.fail('lost', 'metadata');
  const failed = new Map(tracker.list().map((stage) => [stage.id, stage.state]));
  assert.equal(failed.get('reserve'), 'done');
  assert.equal(failed.get('metadata'), 'failed');
  assert.equal(tracker.running, false);
});

test('the review step renders the stages with a spinner, checkmarks and a live region', () => {
  const catalog = readFileSync(new URL('../web/js/workspace-catalog.mjs', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../web/css/components.css', import.meta.url), 'utf8');
  assert.match(catalog, /new StageTracker\(ATTACH_STAGES/);
  assert.match(catalog, /createStageRegion\(\{ label: 'Attachment progress'/);
  assert.match(catalog, /stage: track/);
  // An unresolved attempt is never labelled a failure, and the button resumes.
  assert.match(catalog, /GitHub may have completed this step; checking/);
  assert.match(catalog, /'Retry this attempt'/);
  assert.match(catalog, /cannot create a second branch/);

  const progress = readFileSync(new URL('../web/js/stage-progress.mjs', import.meta.url), 'utf8');
  assert.match(progress, /list\.setAttribute\('role', 'status'\)/);
  assert.match(progress, /list\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(progress, /textContent = stage\.state === 'done' \? '\\u2713'/);
  // The running step is the only moving element, and it stops moving when the
  // user has asked for reduced motion.
  assert.match(styles, /\.stage-active \.stage-mark::before \{[^}]*animation: setup-github-spin/s);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.stage-active \.stage-mark::before \{\s*animation: none;/
  );
});

test('a reload resumes the pending operation instead of starting a new one', async (t) => {
  const server = await fixture(t);
  const registry = memoryRegistry();

  // First attempt: the branch is created and the answer is lost for good.
  await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'QA',
    repositoryId: 9001,
    sourceBranch: 'CitadelQA',
    registry,
    mirror: async () => {},
    makeProvider: async () => fixtureProvider(),
    activate: false,
    wait: async () => {},
    reconcileDelays: [0],
    attach: async (payload) => {
      await server.attach(payload);
      throw transportFailure(502);
    },
    attachmentStatus: async () => {
      throw transportFailure(504);
    },
  }).catch(() => {});

  const retained = registry.store.pending[0];
  assert.ok(retained, 'nothing survived the reload');

  // A reload keeps only what the durable store holds. The next attempt reads it
  // back and must reuse the same environment id and operation key.
  const resumed = await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'QA',
    repositoryId: 9001,
    sourceBranch: 'CitadelQA',
    registry,
    mirror: async () => {},
    makeProvider: async () => fixtureProvider(),
    activate: false,
    wait: async () => {},
    attach: (payload) => {
      assert.equal(payload.operationKey, retained.operationKey, 'a new operation key was minted');
      assert.equal(payload.environmentId, retained.environmentId, 'a new environment id was minted');
      return server.attach(payload);
    },
    attachmentStatus: (payload) => server.attachmentStatus(payload),
  });

  assert.equal(resumed.environment.id, retained.environmentId);
  assert.deepEqual(registry.store.pending, [], 'the attempt was not retired after success');
  const branches = [...server.github.repositories.get(9001).refs.keys()].filter((ref) =>
    ref.startsWith('citadel-ui/')
  );
  assert.equal(branches.length, 1);
});
