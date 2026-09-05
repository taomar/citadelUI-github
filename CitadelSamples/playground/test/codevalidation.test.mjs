/**
 * Offline Python compile runner: real process, exact source, cancellation,
 * timeout, honest blocked state, report artifact, and mandatory cleanup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGUE } from '../src/catalogue/index.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';
import {
  CODE_VALIDATION_SCENARIO,
  createCodeValidationManager,
} from '../src/server/codeValidation.mjs';
import { RequestRefused } from '../src/server/runRequest.mjs';
import { spawnProcess } from '../src/server/transports.mjs';

const PLAYGROUND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REQUEST = Object.freeze({ protocolVersion: EXECUTION_PROTOCOL_VERSION });

async function makeFixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'citadel-code-validation-'));
  const samplesRoot = join(temporaryRoot, 'CitadelSamples');
  const playgroundRoot = join(samplesRoot, 'playground');
  const scriptTarget = join(playgroundRoot, 'runtime', 'python', 'validate_notebook_source.py');
  await mkdir(dirname(scriptTarget), { recursive: true });
  await copyFile(
    resolve(PLAYGROUND_ROOT, '..', CATALOGUE.sourceNotebook.fileName),
    join(samplesRoot, CATALOGUE.sourceNotebook.fileName),
  );
  await copyFile(resolve(PLAYGROUND_ROOT, 'runtime', 'python', 'validate_notebook_source.py'), scriptTarget);
  return {
    temporaryRoot,
    playgroundRoot,
    async cleanup() {
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('the real Python runner compiles exact protected source and removes its workspace', async (t) => {
  const python = process.env.CITADEL_PLAYGROUND_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const probe = await spawnProcess({
    executable: python,
    args: ['--version'],
    cwd: PLAYGROUND_ROOT,
    timeoutMs: 5000,
    allowedExecutables: [python],
  });
  if (probe.spawnFailed || probe.code !== 0) {
    t.skip('Python is not installed on this test host');
    return;
  }

  const fixture = await makeFixture();
  try {
    const progress = [];
    const manager = createCodeValidationManager({
      playgroundRoot: fixture.playgroundRoot,
      pythonExecutable: python,
    });
    const result = await manager.start('azure-context-check', REQUEST, {
      onProgress: (event) => progress.push(event),
    });

    assert.equal(result.scenario, CODE_VALIDATION_SCENARIO);
    assert.equal(result.sampleId, 'azure-context-check');
    assert.equal(result.state, 'passed');
    assert.equal(result.mode, 'offline-local');
    assert.equal(result.validation, 'python-compile-only');
    assert.equal(result.sourceEditable, false);
    assert.equal(result.sourceExecuted, false);
    assert.equal(result.azureContacted, false);
    assert.equal(result.networkContacted, false);
    assert.equal(result.liveEvidence, false);
    assert.equal(result.workspaceRemoved, true);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].cellIndex, 4);
    assert.equal(result.checks[0].passed, true);
    assert.equal(result.artifact.retainedInWorkspace, false);
    assert.equal(JSON.parse(result.artifact.text).sampleId, 'azure-context-check');
    assert.deepEqual(
      progress.map((event) => event.type),
      ['run-start', 'step-start', 'step', 'result'],
    );
    assert.equal(await pathExists(join(fixture.playgroundRoot, '.runs', result.runId)), false);
  } finally {
    await fixture.cleanup();
  }
});

test('missing Python is an honest blocked result and still removes the workspace', async () => {
  const fixture = await makeFixture();
  try {
    const manager = createCodeValidationManager({
      playgroundRoot: fixture.playgroundRoot,
      spawn: async () => ({
        code: -1,
        stdout: '',
        stderr: 'not found',
        timedOut: false,
        spawnFailed: true,
      }),
    });
    const result = await manager.start('azure-context-check', REQUEST);
    assert.equal(result.state, 'blocked');
    assert.match(result.summary, /Python interpreter is not available/);
    assert.equal(result.azureContacted, false);
    assert.equal(result.liveEvidence, false);
    assert.equal(result.workspaceRemoved, true);
    assert.equal(await pathExists(join(fixture.playgroundRoot, '.runs', result.runId)), false);
  } finally {
    await fixture.cleanup();
  }
});

test('plain spawn ENOENT is blocked and Python starts isolated from site customizations', async () => {
  const fixture = await makeFixture();
  try {
    let args = [];
    const manager = createCodeValidationManager({
      playgroundRoot: fixture.playgroundRoot,
      spawn: async (options) => {
        args = options.args;
        return {
          code: -1,
          stdout: '',
          stderr: 'spawn python3 ENOENT',
          timedOut: false,
        };
      },
    });
    const result = await manager.start('azure-context-check', REQUEST);
    assert.equal(result.state, 'blocked');
    assert.deepEqual(args.slice(0, 2), ['-I', '-S']);
    assert.equal(result.workspaceRemoved, true);
  } finally {
    await fixture.cleanup();
  }
});

test('timeout and cancellation remain distinct and clean up their workspaces', async () => {
  const fixture = await makeFixture();
  try {
    const timedOut = createCodeValidationManager({
      playgroundRoot: fixture.playgroundRoot,
      spawn: async () => ({ code: -1, stdout: '', stderr: '', timedOut: true }),
      limits: { timeoutMs: 25 },
    });
    const timeoutResult = await timedOut.start('azure-context-check', REQUEST);
    assert.equal(timeoutResult.state, 'failed');
    assert.match(timeoutResult.summary, /timed out/);
    assert.equal(timeoutResult.workspaceRemoved, true);

    let started;
    const startedPromise = new Promise((resolveStarted) => {
      started = resolveStarted;
    });
    const cancellable = createCodeValidationManager({
      playgroundRoot: fixture.playgroundRoot,
      spawn: ({ signal }) =>
        new Promise((resolveSpawn) => {
          const finish = () => resolveSpawn({ code: -1, stdout: '', stderr: 'aborted', timedOut: false });
          if (signal.aborted) finish();
          else signal.addEventListener('abort', finish, { once: true });
        }),
    });
    const pending = cancellable.start('azure-context-check', REQUEST, {
      onStart: ({ runId }) => started(runId),
    });
    const runId = await startedPromise;
    assert.deepEqual(cancellable.cancel(runId), {
      cancelled: true,
      runId,
      sampleId: 'azure-context-check',
    });
    const cancelled = await pending;
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.workspaceRemoved, true);
    assert.equal(await pathExists(join(fixture.playgroundRoot, '.runs', runId)), false);
  } finally {
    await fixture.cleanup();
  }
});

test('a cleanup failure fails closed instead of claiming an ephemeral run', async () => {
  const fixture = await makeFixture();
  try {
    const manager = createCodeValidationManager({
      playgroundRoot: fixture.playgroundRoot,
      spawn: async () => ({
        code: -1,
        stdout: '',
        stderr: 'not found',
        timedOut: false,
        spawnFailed: true,
      }),
      removeImpl: async () => {
        throw new Error('cleanup refused');
      },
    });
    const result = await manager.start('azure-context-check', REQUEST);
    assert.equal(result.state, 'failed');
    assert.equal(result.workspaceRemoved, false);
    assert.match(result.summary, /workspace could not be removed/);
  } finally {
    await fixture.cleanup();
  }
});

test('cancelAll waits for process exit and workspace cleanup, and repeated drains clean up once', async () => {
  const fixture = await makeFixture();
  try {
    let markProcessStarted;
    const processStarted = new Promise((resolveStarted) => {
      markProcessStarted = resolveStarted;
    });
    let markProcessAborted;
    const processAborted = new Promise((resolveAborted) => {
      markProcessAborted = resolveAborted;
    });
    let releaseProcess;
    const processExit = new Promise((resolveExit) => {
      releaseProcess = resolveExit;
    });
    let markCleanupStarted;
    const cleanupStarted = new Promise((resolveStarted) => {
      markCleanupStarted = resolveStarted;
    });
    let releaseCleanup;
    const cleanupRelease = new Promise((resolveCleanup) => {
      releaseCleanup = resolveCleanup;
    });
    let cleanupCalls = 0;
    const manager = createCodeValidationManager({
      playgroundRoot: fixture.playgroundRoot,
      spawn: ({ signal }) =>
        new Promise((resolveSpawn) => {
          markProcessStarted();
          const finish = () => {
            markProcessAborted();
            void processExit.then(() => {
              resolveSpawn({ code: -1, stdout: '', stderr: 'aborted', timedOut: false, aborted: true });
            });
          };
          if (signal.aborted) finish();
          else signal.addEventListener('abort', finish, { once: true });
        }),
      removeImpl: async (path, options) => {
        cleanupCalls += 1;
        markCleanupStarted();
        await cleanupRelease;
        await rm(path, options);
      },
    });
    const pending = manager.start('azure-context-check', REQUEST);
    await processStarted;

    let drained = false;
    const firstDrain = manager.cancelAll().then(() => {
      drained = true;
    });
    const secondDrain = manager.cancelAndDrain();
    await processAborted;
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(drained, false, 'drain must wait for the child process to exit');

    releaseProcess();
    await cleanupStarted;
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(drained, false, 'drain must wait for finally workspace cleanup');

    releaseCleanup();
    const [result] = await Promise.all([pending, firstDrain, secondDrain]);
    assert.equal(result.state, 'cancelled');
    assert.equal(result.workspaceRemoved, true);
    assert.equal(cleanupCalls, 1);
    assert.equal(manager.activeCount, 0);
    assert.equal(await pathExists(join(fixture.playgroundRoot, '.runs', result.runId)), false);
  } finally {
    await fixture.cleanup();
  }
});

test('a validation start racing shutdown is refused before it creates a workspace', async () => {
  const fixture = await makeFixture();
  try {
    let sourceReads = 0;
    const manager = createCodeValidationManager({
      playgroundRoot: fixture.playgroundRoot,
      sourceReader: async () => {
        sourceReads += 1;
        throw new Error('source must not be read after shutdown starts');
      },
    });
    const draining = manager.cancelAll();
    await assert.rejects(
      () => manager.start('azure-context-check', REQUEST),
      (error) => error instanceof RequestRefused && error.code === 'code-validation-manager-closed' && error.status === 409,
    );
    await draining;
    assert.equal(sourceReads, 0);
    assert.equal(manager.activeCount, 0);
    assert.equal(await pathExists(join(fixture.playgroundRoot, '.runs')), false);
  } finally {
    await fixture.cleanup();
  }
});
