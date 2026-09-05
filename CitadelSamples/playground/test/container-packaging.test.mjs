import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXECUTION_PROTOCOL_VERSION, SOURCE_NOTEBOOK } from '../src/core/types.mjs';

const PLAYGROUND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SAMPLES_ROOT = resolve(PLAYGROUND_ROOT, '..');

const RELAY_PACKAGE = Object.freeze([
  ['playground/relay-server.mjs', 'app/relay-server.mjs'],
  ['playground/src/catalogue', 'app/src/catalogue'],
  ['playground/src/core', 'app/src/core'],
  ['playground/src/relay', 'app/src/relay'],
  ['playground/src/server/assertions.mjs', 'app/src/server/assertions.mjs'],
  ['playground/src/server/redaction.mjs', 'app/src/server/redaction.mjs'],
  ['playground/src/server/runRequest.mjs', 'app/src/server/runRequest.mjs'],
]);

const PLAYGROUND_PACKAGE = Object.freeze([
  ['citadel-publish-contract-tests.ipynb', 'app/citadel-publish-contract-tests.ipynb'],
  ['playground/package.json', 'app/playground/package.json'],
  ['playground/server.mjs', 'app/playground/server.mjs'],
  ['playground/src', 'app/playground/src'],
  ['playground/web', 'app/playground/web'],
  ['playground/runtime', 'app/playground/runtime'],
  ['playground/.gitignore', 'app/playground/.gitignore'],
]);

const RELAY_IGNORE = Object.freeze([
  '*',
  '!playground/',
  'playground/*',
  '!playground/relay-server.mjs',
  '!playground/src/',
  'playground/src/*',
  '!playground/src/catalogue/',
  '!playground/src/catalogue/**',
  '!playground/src/core/',
  '!playground/src/core/**',
  '!playground/src/relay/',
  '!playground/src/relay/**',
  '!playground/src/server/',
  'playground/src/server/*',
  '!playground/src/server/assertions.mjs',
  '!playground/src/server/redaction.mjs',
  '!playground/src/server/runRequest.mjs',
]);

const PLAYGROUND_IGNORE = Object.freeze([
  '*',
  '!citadel-publish-contract-tests.ipynb',
  '!playground/',
  'playground/*',
  '!playground/.gitignore',
  '!playground/package.json',
  '!playground/server.mjs',
  '!playground/src/',
  '!playground/src/**',
  '!playground/web/',
  '!playground/web/**',
  '!playground/runtime/',
  '!playground/runtime/**',
]);

function lines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

async function copyPackage(root, entries) {
  for (const [source, target] of entries) {
    const destination = resolve(root, target);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(SAMPLES_ROOT, source), destination, { recursive: true });
  }
}

async function temporaryPackage(entries, body) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-image-package-'));
  try {
    await copyPackage(root, entries);
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return port;
}

function environmentWithout(prefix) {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith(prefix)));
}

function relayEnvironment(port) {
  return {
    ...environmentWithout('CITADEL_RELAY_'),
    NODE_ENV: 'production',
    CITADEL_RELAY_ENTRA_AUTHENTICATED: 'true',
    CITADEL_RELAY_PORT: String(port),
    CITADEL_RELAY_HOST: '127.0.0.1',
    CITADEL_RELAY_TENANT_ID: 'packaging-test-tenant',
    CITADEL_RELAY_ALLOWED_PRINCIPAL_ID: 'packaging-test-principal',
    CITADEL_RELAY_ALLOWED_SAMPLE_IDS: '[]',
    CITADEL_RELAY_ALLOWED_ORIGINS: '["https://gateway.example.test"]',
    CITADEL_RELAY_REQUEST_POLICY: '{}',
    CITADEL_RELAY_SECRET_MAPPINGS: '{}',
    CITADEL_RELAY_KEY_VAULT_URI: 'https://packaging-test.vault.azure.net',
    CITADEL_RELAY_MANAGED_IDENTITY_CLIENT_ID: 'packaging-test-client',
  };
}

function playgroundEnvironment(port) {
  return {
    ...environmentWithout('CITADEL_PLAYGROUND_'),
    NODE_ENV: 'production',
    CITADEL_PLAYGROUND_PORT: String(port),
    CITADEL_PLAYGROUND_HOST: '127.0.0.1',
  };
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 2_000)),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

async function withNodeEntrypoint(entrypoint, env, body) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: dirname(entrypoint),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  try {
    return await body(child, () => output);
  } finally {
    await stopProcess(child);
  }
}

async function waitForResponse(url, { child = null, output = () => '', ...init } = {}) {
  const deadline = Date.now() + 10_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Entrypoint exited with code ${child.exitCode} before ${url} was ready.\n${output()}`);
    }
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? 'no response'}\n${output()}`);
}

async function assertMissing(path) {
  await assert.rejects(
    () => stat(path),
    (error) => error?.code === 'ENOENT',
    `${path} should not be packaged`,
  );
}

function dockerAvailable() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && result.stdout.trim() !== '';
}

async function runDocker(args, { allowFailure = false } = {}) {
  const child = spawn('docker', args, {
    cwd: SAMPLES_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, 'exit');
  if (code !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(' ')} failed with code ${code}\n${stdout}${stderr}`);
  }
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function containerLogs(name) {
  const result = await runDocker(['logs', name], { allowFailure: true });
  return `${result.stdout}\n${result.stderr}`.trim();
}

test('Dockerfiles use complete image-specific allowlists from the CitadelSamples context', async () => {
  const [playgroundDockerfile, relayDockerfile, playgroundIgnore, relayIgnore, localIgnore] = await Promise.all([
    readFile(resolve(PLAYGROUND_ROOT, 'Dockerfile.playground'), 'utf8'),
    readFile(resolve(PLAYGROUND_ROOT, 'Dockerfile.relay'), 'utf8'),
    readFile(resolve(PLAYGROUND_ROOT, 'Dockerfile.playground.dockerignore'), 'utf8'),
    readFile(resolve(PLAYGROUND_ROOT, 'Dockerfile.relay.dockerignore'), 'utf8'),
    readFile(resolve(PLAYGROUND_ROOT, '.dockerignore'), 'utf8'),
  ]);

  assert.match(playgroundDockerfile, /^WORKDIR \/app\/playground$/m);
  assert.match(playgroundDockerfile, /^COPY playground\/runtime \.\/runtime$/m);
  assert.match(playgroundDockerfile, /^COPY playground\/\.gitignore \.\/\.gitignore$/m);
  assert.match(
    playgroundDockerfile,
    /^COPY citadel-publish-contract-tests\.ipynb \/app\/citadel-publish-contract-tests\.ipynb$/m,
  );
  assert.match(relayDockerfile, /^COPY playground\/src\/server\/assertions\.mjs /m);
  assert.match(relayDockerfile, /^COPY playground\/src\/server\/redaction\.mjs /m);
  assert.doesNotMatch(playgroundDockerfile + relayDockerfile, /--chown=node:node/);
  assert.match(playgroundDockerfile, /^USER node$/m);
  assert.match(relayDockerfile, /^USER node$/m);

  assert.deepEqual(lines(playgroundIgnore), PLAYGROUND_IGNORE);
  assert.deepEqual(lines(relayIgnore), RELAY_IGNORE);
  assert.equal(lines(localIgnore).includes('runtime'), false);
  assert.equal(lines(localIgnore).includes('runtime/'), false);
  assert.ok(lines(localIgnore).includes('!runtime/**'));
});

test('the relay temporary image layout starts and serves health without process-capable assets', async () => {
  await temporaryPackage(RELAY_PACKAGE, async (root) => {
    const appRoot = resolve(root, 'app');
    await assertMissing(resolve(appRoot, 'runtime'));
    await assertMissing(resolve(appRoot, 'server.mjs'));
    await assertMissing(resolve(appRoot, 'src/server/localExecutor.mjs'));
    await assertMissing(resolve(appRoot, 'src/server/transports.mjs'));
    await assertMissing(resolve(appRoot, 'web'));

    const port = await reservePort();
    await withNodeEntrypoint(resolve(appRoot, 'relay-server.mjs'), relayEnvironment(port), async (child, output) => {
      const response = await waitForResponse(`http://127.0.0.1:${port}/healthz`, { child, output });
      assert.deepEqual(await response.json(), { status: 'ok' });
    });
  });
});

test('the playground temporary image layout serves protected source and passes its offline self-test', async () => {
  await temporaryPackage(PLAYGROUND_PACKAGE, async (root) => {
    const appRoot = resolve(root, 'app');
    const playgroundRoot = resolve(appRoot, 'playground');
    assert.equal((await stat(resolve(appRoot, SOURCE_NOTEBOOK.fileName))).isFile(), true);
    assert.equal((await stat(resolve(playgroundRoot, 'runtime/accelerator'))).isDirectory(), true);
    assert.equal((await stat(resolve(playgroundRoot, '.gitignore'))).isFile(), true);
    await assertMissing(resolve(playgroundRoot, 'test'));
    await assertMissing(resolve(playgroundRoot, 'scripts'));

    const port = await reservePort();
    await withNodeEntrypoint(resolve(playgroundRoot, 'server.mjs'), playgroundEnvironment(port), async (child, output) => {
      await waitForResponse(`http://127.0.0.1:${port}/api/health`, { child, output });

      const sourceResponse = await fetch(`http://127.0.0.1:${port}/api/source/weather-mcp-discovery`);
      assert.equal(sourceResponse.status, 200);
      const source = await sourceResponse.json();
      assert.equal(source.notebook.fileName, SOURCE_NOTEBOOK.fileName);
      assert.equal(source.notebook.sha256, SOURCE_NOTEBOOK.sha256);
      assert.ok(source.cells.length > 0);

      const selfTestResponse = await fetch(`http://127.0.0.1:${port}/api/self-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
      });
      assert.equal(selfTestResponse.status, 200);
      const selfTest = await selfTestResponse.json();
      assert.equal(selfTest.state, 'passed');
      assert.equal(selfTest.azureContacted, false);
      assert.equal(selfTest.liveEvidence, false);
      assert.ok(selfTest.checks.every((check) => check.passed));
    });
  });
});

test('Docker builds and runs both least-privilege images when Docker is available', { skip: !dockerAvailable() }, async () => {
  const suffix = `${process.pid}-${Date.now()}`.toLowerCase();
  const relayImage = `citadel-relay-packaging-test:${suffix}`;
  const playgroundImage = `citadel-playground-packaging-test:${suffix}`;
  const relayContainer = `citadel-relay-packaging-${suffix}`;
  const playgroundContainer = `citadel-playground-packaging-${suffix}`;

  try {
    await Promise.all([
      runDocker(['build', '--quiet', '--file', 'playground/Dockerfile.relay', '--tag', relayImage, '.']),
      runDocker(['build', '--quiet', '--file', 'playground/Dockerfile.playground', '--tag', playgroundImage, '.']),
    ]);

    assert.equal((await runDocker(['image', 'inspect', '--format', '{{.Config.User}}', relayImage])).stdout, 'node');
    assert.equal((await runDocker(['image', 'inspect', '--format', '{{.Config.User}}', playgroundImage])).stdout, 'node');

    await runDocker([
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      relayImage,
      '-c',
      [
        'set -eu',
        'test "$(id -u)" != "0"',
        'test ! -w /app',
        'test ! -w /app/relay-server.mjs',
        'test -f /app/src/server/assertions.mjs',
        'test -f /app/src/server/redaction.mjs',
        'test ! -e /app/runtime',
        'test ! -e /app/server.mjs',
        'test ! -e /app/web',
        'test ! -e /app/src/server/localExecutor.mjs',
        'test ! -e /app/src/server/transports.mjs',
        '! command -v python >/dev/null 2>&1',
        '! command -v python3 >/dev/null 2>&1',
        '! command -v az >/dev/null 2>&1',
      ].join('; '),
    ]);

    await runDocker([
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      playgroundImage,
      '-c',
      [
        'set -eu',
        'test "$(id -u)" != "0"',
        'test ! -w /app/playground',
        'test ! -w /app/playground/server.mjs',
        'test -f /app/citadel-publish-contract-tests.ipynb',
        'test -f /app/playground/.gitignore',
        'test -d /app/playground/runtime/accelerator',
        'test ! -e /app/playground/test',
        'test ! -e /app/playground/scripts',
        'test ! -e /app/playground/relay-server.mjs',
      ].join('; '),
    ]);

    const relayPort = await reservePort();
    const playgroundPort = await reservePort();
    const relayEnv = relayEnvironment(8080);
    relayEnv.CITADEL_RELAY_HOST = '0.0.0.0';
    const relayArgs = ['run', '--detach', '--name', relayContainer, '--publish', `127.0.0.1:${relayPort}:8080`];
    for (const [name, value] of Object.entries(relayEnv).filter(([name]) => name.startsWith('CITADEL_RELAY_'))) {
      relayArgs.push('--env', `${name}=${value}`);
    }
    relayArgs.push(relayImage);

    await runDocker(relayArgs);
    await runDocker([
      'run',
      '--detach',
      '--name',
      playgroundContainer,
      '--publish',
      `127.0.0.1:${playgroundPort}:8080`,
      '--env',
      'CITADEL_PLAYGROUND_PUBLIC_ORIGIN=https://playground.packaging.test',
      playgroundImage,
    ]);

    try {
      const relayHealth = await waitForResponse(`http://127.0.0.1:${relayPort}/healthz`);
      assert.deepEqual(await relayHealth.json(), { status: 'ok' });

      await waitForResponse(`http://127.0.0.1:${playgroundPort}/api/health`);
      const sourceResponse = await fetch(`http://127.0.0.1:${playgroundPort}/api/source/weather-mcp-discovery`);
      assert.equal(sourceResponse.status, 200);
      assert.equal((await sourceResponse.json()).notebook.sha256, SOURCE_NOTEBOOK.sha256);

      const selfTestResponse = await fetch(`http://127.0.0.1:${playgroundPort}/api/self-test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://playground.packaging.test',
        },
        body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
      });
      assert.equal(selfTestResponse.status, 200);
      const selfTest = await selfTestResponse.json();
      assert.equal(selfTest.state, 'passed');
      assert.ok(selfTest.checks.every((check) => check.passed));
    } catch (error) {
      const [relayLogs, playgroundLogs] = await Promise.all([
        containerLogs(relayContainer),
        containerLogs(playgroundContainer),
      ]);
      throw new Error(`${error.message}\nRelay logs:\n${relayLogs}\nPlayground logs:\n${playgroundLogs}`);
    }
  } finally {
    spawnSync('docker', ['rm', '--force', relayContainer, playgroundContainer], {
      cwd: SAMPLES_ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
    spawnSync('docker', ['image', 'rm', '--force', relayImage, playgroundImage], {
      cwd: SAMPLES_ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
  }
});
