import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { createLocalExecutor } from '../src/server/localExecutor.mjs';
import {
  resolveAzOperation,
  resolvePythonWrapper,
  validateResolvedAzArguments,
} from '../src/server/registry.mjs';
import {
  createProcessEnvironment,
  spawnProcess,
} from '../src/server/transports.mjs';

const ROOT = resolve('.');
const PYTHON_ROOT = resolve('runtime', 'python');

test('the process transport uses an exact executable allow-list and a workspace cwd', async () => {
  await assert.rejects(
    () =>
      spawnProcess({
        executable: process.execPath,
        args: ['--version'],
        cwd: ROOT,
      }),
    /not on the executable allow-list/,
  );
  await assert.rejects(
    () =>
      spawnProcess({
        executable: 'python',
        args: ['--version'],
        cwd: '.',
      }),
    /absolute workspace cwd/,
  );
});

test('the child environment excludes ambient credentials and rejects arbitrary overrides', () => {
  const environment = createProcessEnvironment(
    { CITADEL_GATEWAY_ACCESS_API_KEY: 'wrapper-secret' },
    {
      PATH: 'safe-path',
      HOME: 'safe-home',
      GH_TOKEN: 'must-not-pass',
      AZURE_CLIENT_SECRET: 'must-not-pass',
    },
  );
  assert.equal(environment.PATH, 'safe-path');
  assert.equal(environment.HOME, 'safe-home');
  assert.equal(environment.CITADEL_GATEWAY_ACCESS_API_KEY, 'wrapper-secret');
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.AZURE_CLIENT_SECRET, undefined);
  assert.throws(() => createProcessEnvironment({ PATH: 'browser-choice' }, {}), /unapproved/);
});

test('one oversized subprocess chunk is clipped at the byte boundary', { timeout: 10_000 }, async () => {
  const result = await spawnProcess({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(128 * 1024))"],
    cwd: ROOT,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    allowedExecutables: [process.execPath],
  });
  assert.equal(result.code, 0);
  assert.equal(Buffer.byteLength(result.stdout, 'utf-8'), 1024);
});

test('a multibyte sequence crossing the output limit cannot expand past it', { timeout: 10_000 }, async () => {
  const result = await spawnProcess({
    executable: process.execPath,
    args: ['-e', "process.stdout.write(Buffer.from([0xe2, 0x82, 0xac]))"],
    cwd: ROOT,
    timeoutMs: 5000,
    maxOutputBytes: 2,
    allowedExecutables: [process.execPath],
  });
  assert.equal(result.code, 0);
  assert.ok(Buffer.byteLength(result.stdout, 'utf-8') <= 2);
});

test('timeout terminates the spawned process tree without a shell', { timeout: 15_000 }, async () => {
  const childSource = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'console.log(child.pid);',
    'setInterval(() => {}, 1000);',
  ].join('');
  const result = await spawnProcess({
    executable: process.execPath,
    args: ['-e', childSource],
    cwd: ROOT,
    timeoutMs: 500,
    maxOutputBytes: 1024,
    allowedExecutables: [process.execPath],
  });
  const descendantPid = Number.parseInt(result.stdout.trim(), 10);
  assert.equal(result.timedOut, true);
  assert.ok(Number.isInteger(descendantPid), 'the child should report its descendant pid');
  assert.equal(await remainsAlive(descendantPid), false, `descendant ${descendantPid} survived cancellation`);
});

test('the registry approves the complete command shape, not just its verb prefix', () => {
  const exact = {
    id: 'account-show',
    command: { executable: 'az', args: ['account', 'show', '-o', 'json'] },
  };
  assert.doesNotThrow(() => resolveAzOperation('azure-context-check', exact));
  assert.throws(
    () =>
      resolveAzOperation('azure-context-check', {
        ...exact,
        command: { ...exact.command, args: [...exact.command.args, '--debug'] },
      }),
    /complete approved az command shape/,
  );
});

test('resolved bindings cannot turn a value position into an Azure CLI option', () => {
  const step = {
    id: 'show-service',
    command: {
      executable: 'az',
      args: [
        'apim',
        'show',
        '-g',
        'rg-test',
        '-n',
        '{{steps.select-service.apimName}}',
        '--query',
        '{name:name, gatewayUrl:gatewayUrl, sku:sku.name, location:location, publicIPs:publicIpAddresses}',
        '-o',
        'json',
      ],
    },
  };
  assert.doesNotThrow(() => resolveAzOperation('apim-discovery', step));
  assert.throws(
    () =>
      validateResolvedAzArguments(
        'apim-discovery',
        step.id,
        step.command.args.map((value) => (value === '{{steps.select-service.apimName}}' ? '--debug' : value)),
      ),
    /invalid Azure resource name/,
  );
});

test('Python wrapper paths stay registry-owned when inputs carry path-like values', () => {
  const wrapper = resolvePythonWrapper('weather-api-ensure', { id: 'upsert-api' });
  const params = wrapper.params({
    inputs: {
      'hub.subscriptionId': '00000000-1111-2222-3333-444444444444',
      'hub.resourceGroupName': 'rg-test',
      'hub.apimName': 'apim-test',
      'samples.weather-api-ensure.apiId': 'weather-api',
      'samples.weather-api-ensure.apiPath': 'weather',
      'samples.weather-api-ensure.displayName': 'Weather API',
      'gatewayAccess.weatherSourceKeyHeader': 'x-mcp-sub-key',
      'samples.weather-api-ensure.specPath': '../../outside/openapi.json',
      'samples.weather-api-ensure.policyPath': 'C:\\outside\\policy.xml',
    },
  });
  assert.equal(params.specPath, 'runtime/accelerator/modules/apim/sample/weather/openapi.json');
  assert.equal(params.policyPath, 'runtime/accelerator/modules/apim/sample/weather/policy.xml');
});

test('progress carries bounded redacted metadata and never raw credential output', async () => {
  const token = 'SECRET-TOKEN-CROSS-CHUNK-BOUNDARY';
  const calls = [];
  const progress = [];
  const executor = createLocalExecutor({
    transports: {
      spawn: async (options) => {
        calls.push(options);
        return { code: 0, stdout: token, stderr: '', timedOut: false, aborted: false };
      },
      fetch: async () => {
        throw new Error('network must not be reached');
      },
      writeFile: async () => {},
      access: async () => {},
    },
    workspace: { root: ROOT },
    pythonExecutable: 'python',
    pythonRoot: PYTHON_ROOT,
  });
  const result = await executor.execute(
    {
      sampleId: 'foundry-enable-a2a',
      steps: [
        {
          id: 'acquire-token',
          type: 'azure-cli',
          title: 'Acquire token',
          command: {
            executable: 'az',
            args: [
              'account',
              'get-access-token',
              '--resource',
              'https://ai.azure.com',
              '--query',
              'accessToken',
              '-o',
              'tsv',
            ],
          },
        },
      ],
    },
    {
      sampleId: 'foundry-enable-a2a',
      inputs: {},
      secrets: {},
      onProgress: (event) => progress.push(event),
    },
  );
  assert.equal(calls[0].cwd, ROOT);
  assert.deepEqual(calls[0].allowedExecutables, ['az', 'python']);
  assert.equal(JSON.stringify(progress).includes(token), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(progress.at(-1).step.evidence, {});
});

async function remainsAlive(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    } catch {
      return false;
    }
  }
  return true;
}
