import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { createPrivateAzureCliContext } from '../src/server/azureCliContext.mjs';
import {
  ACCOUNT_LIST_ARGS,
  ACCOUNT_SHOW_ARGS,
  SYSTEM_AZURE_LOGIN_ARGS,
  createExecutionContextManager,
} from '../src/server/executionContextManager.mjs';
import { createProcessEnvironment } from '../src/server/transports.mjs';
import { createPlaygroundServer } from '../server.mjs';

function temporaryRoot() {
  return mkdtempSync(join(tmpdir(), 'citadel-private-cli-test-'));
}

test('each launch gets one isolated private Azure CLI profile and ignores the ambient default', async () => {
  const root = temporaryRoot();
  const first = createPrivateAzureCliContext({ tempRoot: root });
  const second = createPrivateAzureCliContext({ tempRoot: root });
  try {
    assert.notEqual(first.directory, second.directory);
    const expectedPrefix =
      process.platform === 'win32'
        ? 'citadel-publish-playground-azure-cli-'
        : `citadel-publish-playground-${process.getuid()}-azure-cli-`;
    assert.equal(basename(first.directory).startsWith(expectedPrefix), true);
    assert.equal(existsSync(first.directory), true);
    assert.equal(existsSync(second.directory), true);
    if (process.platform !== 'win32') {
      assert.equal(statSync(first.directory).mode & 0o077, 0);
      assert.equal(statSync(second.directory).mode & 0o077, 0);
    }

    const calls = [];
    const spawn = first.bindSpawn(async (options) => {
      calls.push(options);
      const environment = createProcessEnvironment(
        options.env,
        {
          PATH: 'safe-path',
          AZURE_CONFIG_DIR: join(root, 'ambient-default'),
        },
        {
          profile: options.environmentProfile,
          azureConfigDir: options.azureConfigDir,
        },
      );
      return {
        code: 1,
        stdout: '',
        stderr: `failure under ${environment.AZURE_CONFIG_DIR}`,
        timedOut: false,
        aborted: false,
      };
    });

    const result = await spawn({
      executable: 'az',
      args: ['account', 'show'],
      cwd: root,
    });
    assert.equal(calls[0].azureConfigDir, first.directory);
    assert.notEqual(calls[0].azureConfigDir, join(root, 'ambient-default'));
    assert.equal(result.stderr.includes(first.directory), false);
    assert.match(result.stderr, /\[private Azure CLI context\]/);
  } finally {
    await first.close();
    await second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('graceful close removes only its own marked launch directory', async () => {
  const root = temporaryRoot();
  const context = createPrivateAzureCliContext({ tempRoot: root });
  const sibling = join(dirname(context.directory), 'not-owned');
  mkdirSync(sibling);
  await context.close();
  assert.equal(existsSync(context.directory), false);
  assert.equal(existsSync(sibling), true);
  rmSync(root, { recursive: true, force: true });
});

test('graceful close waits for every bound child before removing the profile', async () => {
  const root = temporaryRoot();
  const context = createPrivateAzureCliContext({ tempRoot: root });
  let release;
  const held = new Promise((done) => {
    release = done;
  });
  const spawn = context.bindSpawn(async () => {
    await held;
    return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
  });
  const child = spawn({ executable: 'az', args: ['version'], cwd: root });
  const cleanup = context.close();
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(existsSync(context.directory), true);
  release();
  await child;
  await cleanup;
  assert.equal(existsSync(context.directory), false);
  rmSync(root, { recursive: true, force: true });
});

test('later startup reaps only old marked directories whose owner process is gone', async () => {
  const root = temporaryRoot();
  const stale = createPrivateAzureCliContext({
    tempRoot: root,
    now: () => 1_000,
    pid: 111_111,
    random: (bytes) => 'a'.repeat(bytes * 2),
    staleAfterMs: 1_000,
    isProcessAlive: () => true,
  });
  const prefix = basename(stale.directory).slice(0, -32);
  const unmarked = join(dirname(stale.directory), `${prefix}${'c'.repeat(32)}`);
  mkdirSync(unmarked);

  const current = createPrivateAzureCliContext({
    tempRoot: root,
    now: () => 2_001,
    pid: 222_222,
    random: (bytes) => 'b'.repeat(bytes * 2),
    staleAfterMs: 1_000,
    isProcessAlive: () => false,
  });
  try {
    assert.equal(existsSync(stale.directory), false);
    assert.equal(existsSync(unmarked), true);
    assert.equal(existsSync(current.directory), true);
  } finally {
    await current.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale cleanup preserves a profile while an owned child process group is alive', async () => {
  const root = temporaryRoot();
  const stale = createPrivateAzureCliContext({
    tempRoot: root,
    now: () => 1_000,
    pid: 111_111,
    random: (bytes) => 'd'.repeat(bytes * 2),
    staleAfterMs: 1_000,
    isProcessAlive: () => true,
  });
  let releaseChild;
  let childStarted;
  const started = new Promise((done) => {
    childStarted = done;
  });
  const held = new Promise((done) => {
    releaseChild = done;
  });
  const child = stale.bindSpawn(async (options) => {
    const releaseOwnership = options.onSpawn({ pid: 333_333, processGroupId: 333_333 });
    childStarted();
    await held;
    releaseOwnership();
    return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
  })({ executable: 'az', args: ['version'], cwd: root });
  await started;

  const current = createPrivateAzureCliContext({
    tempRoot: root,
    now: () => 2_001,
    pid: 222_222,
    random: (bytes) => 'e'.repeat(bytes * 2),
    staleAfterMs: 1_000,
    isProcessAlive: (pid) => pid === 333_333,
    isProcessGroupAlive: (processGroupId) => processGroupId === 333_333,
  });
  try {
    assert.equal(existsSync(stale.directory), true);
    releaseChild();
    await child;
    await stale.close();
  } finally {
    await current.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows creation applies restrictive ACL handling to the launch directory', async () => {
  const root = temporaryRoot();
  const protectedPaths = [];
  const context = createPrivateAzureCliContext({
    tempRoot: root,
    platform: 'win32',
    windowsAcl: (path) => protectedPaths.push(path),
  });
  try {
    assert.equal(protectedPaths.length, 1);
    assert.equal(protectedPaths.includes(context.directory), true);
  } finally {
    await context.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('login, account, subscription, and activation operations share the launch-private profile', async () => {
  const root = temporaryRoot();
  const context = createPrivateAzureCliContext({ tempRoot: root });
  const subscriptionId = '00000000-1111-2222-3333-444444444444';
  const account = {
    id: subscriptionId,
    name: 'Sandbox',
    tenantId: 'tenant-1',
    user: { name: 'operator@example.test', type: 'user' },
    isDefault: true,
    state: 'Enabled',
  };
  const calls = [];
  const spawn = context.bindSpawn(async (options) => {
    calls.push(options);
    if (options.args.join(' ') === ACCOUNT_SHOW_ARGS.join(' ')) {
      return { code: 0, stdout: JSON.stringify(account), stderr: '', timedOut: false, aborted: false };
    }
    if (options.args.join(' ') === ACCOUNT_LIST_ARGS.join(' ')) {
      return { code: 0, stdout: JSON.stringify([account]), stderr: '', timedOut: false, aborted: false };
    }
    if (options.args[0] === 'account' && options.args[1] === 'set') {
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    if (options.args.join(' ') === SYSTEM_AZURE_LOGIN_ARGS.join(' ')) {
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    throw new Error(`Unexpected command ${options.args.join(' ')}`);
  });
  const manager = createExecutionContextManager({
    playgroundRoot: root,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  try {
    await manager.readAzureCliAccount();
    await manager.listSubscriptions();
    await manager.activateSubscription(subscriptionId);
    const started = manager.startSystemLogin();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (manager.statusSystemLogin(started.login.id).login.state === 'ready') break;
      await new Promise((done) => setTimeout(done, 2));
    }
    assert.equal(manager.statusSystemLogin(started.login.id).login.state, 'ready');
    assert.ok(calls.length >= 9);
    assert.equal(calls.every((call) => call.azureConfigDir === context.directory), true);
  } finally {
    await manager.cancelAll();
    await context.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('loopback execute owns cleanup while a hosted relay creates no private CLI profile', async () => {
  const managers = {
    executionContextManager: { cancelAll: async () => {} },
    runManager: { cancelAll: async () => {}, cancel: () => ({ cancelled: false }) },
    codeValidationManager: { cancelAll: async () => {} },
  };
  let created = 0;
  let bound = 0;
  let closed = 0;
  const factory = () => {
    created += 1;
    return {
      bindTransports: (transports) => {
        bound += 1;
        return transports;
      },
      close: () => {
        closed += 1;
      },
    };
  };
  const local = createPlaygroundServer({
    mode: 'execute',
    ...managers,
    privateAzureCliContextFactory: factory,
  });
  await new Promise((done) => local.listen(0, '127.0.0.1', done));
  await new Promise((done, reject) => local.close((error) => (error ? reject(error) : done())));
  assert.deepEqual({ created, bound, closed }, { created: 1, bound: 1, closed: 1 });

  const relay = createPlaygroundServer({
    mode: 'execute',
    ...managers,
    relay: {
      enabled: true,
      url: 'https://relay.example.test/execute',
      token: 'relay-token',
      allowedSampleIds: [],
    },
    privateAzureCliContextFactory: () => {
      throw new Error('hosted relay must not create a local Azure CLI profile');
    },
  });
  await new Promise((done) => relay.listen(0, '127.0.0.1', done));
  await new Promise((done, reject) => relay.close((error) => (error ? reject(error) : done())));
});
