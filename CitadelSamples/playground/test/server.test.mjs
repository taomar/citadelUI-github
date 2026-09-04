/**
 * The server surface and the vendored runtime bundle.
 *
 * Two things are proved here without any real execution:
 *
 *   1. preview mode and operator mode differ in exactly the documented way, and
 *      every state-changing endpoint is guarded before it reaches a manager;
 *   2. the vendored accelerator bundle is byte-identical to its recorded
 *      provenance and is closed under its own relative references, so a run
 *      never needs a file from outside `CitadelSamples`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  capabilitiesPayload,
  checkStateChangingRequest,
  createPlaygroundServer,
  isLoopbackHost,
  probeRuntimes,
  resolveServedPath,
} from '../server.mjs';
import { CATALOGUE } from '../src/catalogue/index.mjs';
import { ACCELERATOR_ROOT, EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';
import { describeSampleCapability, probeFromCapabilityPayload, summariseCapability } from '../src/core/capability.mjs';
import { resolveSpawnInvocation, spawnProcess } from '../src/server/transports.mjs';
import { fakeSpawn } from './helpers/transports.mjs';

const PLAYGROUND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUNDLE_ROOT = resolve(PLAYGROUND_ROOT, ACCELERATOR_ROOT);

/** Start a server on an ephemeral port and hand back a fetch helper. */
async function withServer(options, body) {
  const server = createPlaygroundServer(options);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const call = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
  try {
    return await body({ call, port, server });
  } finally {
    await new Promise((done) => server.close(done));
  }
}

/* --------------------------------------------------------------- modes */

test('preview mode executes nothing and says how to attach the executor', async () => {
  await withServer({ mode: 'preview' }, async ({ call }) => {
    const capabilities = await (await call('/api/capabilities')).json();
    assert.equal(capabilities.mode, 'preview');
    assert.equal(capabilities.executor.canExecute, false);
    assert.equal(capabilities.capability.label, 'Preview only');
    assert.match(capabilities.executor.reason, /start:execute/);

    const run = await call('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'azure-context-check' }),
    });
    assert.equal(run.status, 501);
    const payload = await run.json();
    assert.equal(payload.state, 'blocked');
    assert.match(payload.detail, /preview mode/i);
  });
});

test('operator mode reaches the run manager, and the manager decides', async () => {
  const started = [];
  const manager = {
    start: async (payload) => {
      started.push(payload);
      return { runId: 'test-0001', state: 'completed', summary: 'ok', steps: [], assertions: [] };
    },
    cancel: (runId) => ({ cancelled: true, runId }),
    cancelAll: () => {},
    activeCount: 0,
    listActive: () => [],
  };
  await withServer({ mode: 'execute', runManager: manager, probe: { azureCli: { available: true } } }, async ({ call }) => {
    const capabilities = await (await call('/api/capabilities')).json();
    assert.equal(capabilities.mode, 'execute');
    assert.equal(capabilities.executor.kind, 'local');
    assert.equal(capabilities.executor.endpoint, '/api/run');

    const response = await call('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'azure-context-check', inputs: {} }),
    });

    test('the relay endpoint applies the same-origin JSON guard before forwarding', async () => {
      await withServer({ mode: 'preview' }, async ({ call }) => {
        const crossSite = await call('/api/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            'Sec-Fetch-Site': 'cross-site',
          },
          body: '{}',
        });
        assert.equal(crossSite.status, 403);

        const wrongType = await call('/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '{}',
        });
        assert.equal(wrongType.status, 415);
      });
    });

    test('operator mode exposes the run id in response headers before the run finishes', async () => {
      let finish;
      const held = new Promise((resolve) => {
        finish = resolve;
      });
      const manager = {
        start: async (_payload, { onStart }) => {
          onStart({ runId: 'active-run-0001' });
          await held;
          return { runId: 'active-run-0001', state: 'cancelled', summary: 'cancelled', steps: [], assertions: [] };
        },
        cancel: (runId) => {
          finish();
          return { cancelled: true, runId };
        },
        cancelAll: () => finish(),
        activeCount: 1,
        listActive: () => [{ runId: 'active-run-0001' }],
      };
      await withServer({ mode: 'execute', runManager: manager }, async ({ call }) => {
        const response = await call('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'azure-context-check', inputs: {} }),
        });
        assert.equal(response.headers.get('X-Citadel-Run-Id'), 'active-run-0001');

        const cancelled = await call('/api/run/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: 'active-run-0001' }),
        });
        assert.equal((await cancelled.json()).cancelled, true);
        assert.equal((await response.json()).state, 'cancelled');
      });
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).runId, 'test-0001');
    assert.equal(started.length, 1);

    const cancelled = await call('/api/run/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'test-0001' }),
    });
    assert.deepEqual(await cancelled.json(), { cancelled: true, runId: 'test-0001' });
  });
});

test('local execution is refused on a non-loopback host', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('10.1.2.3'), false);
  assert.equal(isLoopbackHost('playground.example.net'), false);
});

/* ------------------------------------------------------ request guards */

test('a state-changing call must be same-origin and carry a JSON content type', () => {
  const make = (headers) => ({ headers });
  assert.equal(checkStateChangingRequest(make({ 'content-type': 'application/json' })).ok, true);

  const crossSite = checkStateChangingRequest(make({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }));
  assert.equal(crossSite.ok, false);
  assert.equal(crossSite.status, 403);

  const badOrigin = checkStateChangingRequest(
    make({ origin: 'https://evil.test', 'content-type': 'application/json' }),
    { port: 4173, host: '127.0.0.1' },
  );
  assert.equal(badOrigin.ok, false);
  assert.equal(badOrigin.status, 403);

  const formPost = checkStateChangingRequest(make({ 'content-type': 'application/x-www-form-urlencoded' }));
  assert.equal(formPost.ok, false);
  assert.equal(formPost.status, 415);
});

test('an oversized body is refused before it is parsed', async () => {
  const manager = { start: async () => ({ runId: 'x' }), cancel: () => ({}), cancelAll: () => {} };
  await withServer({ mode: 'execute', runManager: manager }, async ({ call }) => {
    const response = await call('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, sampleId: 'azure-context-check', pad: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.match((await response.json()).summary, /256 KB/);
  });
});

test('the server refuses to serve anything outside web/ and src/', () => {
  assert.equal(resolveServedPath('/../../secret.txt'), null);
  assert.equal(resolveServedPath('/package.json'), null);
  assert.equal(resolveServedPath('/runtime/accelerator/citadel-publish-contracts/main.bicep'), null);
  assert.equal(resolveServedPath('/.runs/anything'), null);
  assert.ok(resolveServedPath('/web/index.html'));
  assert.ok(resolveServedPath('/src/catalogue/index.mjs'));
});

test('the capability payload never discloses a relay URL or token', () => {
  const payload = JSON.stringify(capabilitiesPayload({ mode: 'preview' }));
  assert.ok(!payload.includes('RELAY_URL'));
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(payload), 'no external URL is disclosed');
  assert.equal(typeof capabilitiesPayload({ mode: 'preview' }).relayConfigured, 'boolean');
});

/* ----------------------------------------------------- capability model */

test('every sample reports preview-only until the executor is attached', () => {
  for (const sample of CATALOGUE.samples) {
    const capability = describeSampleCapability(sample, { mode: 'preview' });
    assert.equal(capability.state, 'preview-only');
    assert.equal(capability.ready, false);
    assert.match(capability.reasons[0], /preview mode/);
  }
  const summary = summariseCapability(CATALOGUE.samples, { mode: 'preview' });
  assert.equal(summary.ready, 0);
  assert.equal(summary.total, 19);
});

test('capability is per sample: the six gateway recipes need no CLI and no Python', () => {
  const probe = {
    mode: 'execute',
    azureCli: { available: false, reason: 'not installed' },
    python: { available: false, reason: 'not installed' },
    accelerator: { available: true, files: 22 },
  };
  const ready = CATALOGUE.samples.filter((sample) => describeSampleCapability(sample, probe).ready);
  assert.deepEqual(
    ready.map((sample) => sample.id).sort(),
    [
      'a2a-agent-card',
      'a2a-message-send',
      'agent-rate-limit-burst',
      'learn-mcp-discovery',
      'tool-rate-limit-burst',
      'weather-mcp-discovery',
      'weather-tools-call',
    ],
    'exactly the recipes that only need outbound HTTPS are runnable without the CLI or Python',
  );

  const blocked = describeSampleCapability(CATALOGUE.byId.get('weather-api-ensure'), probe);
  assert.equal(blocked.state, 'partial');
  assert.deepEqual(
    blocked.dependencies.filter((dependency) => dependency.available === false).map((dependency) => dependency.id),
    ['azure-cli', 'python'],
    'the recipe names each missing dependency rather than one global reason',
  );
});

test('a present Python with a missing module blocks only the samples that import it', () => {
  const probe = {
    mode: 'execute',
    azureCli: { available: true, version: '2.60.0' },
    accelerator: { available: true, files: 22 },
    python: { available: true, version: '3.12.0', modules: { 'agent_framework.a2a': false, 'azure.mgmt.apimanagement': true, 'azure.identity': true, httpx: true, nest_asyncio: true, 'a2a.client': true } },
  };
  const agentFramework = describeSampleCapability(CATALOGUE.byId.get('agent-framework-hr-question'), probe);
  assert.equal(agentFramework.ready, false);
  assert.match(agentFramework.reasons[0], /agent_framework\.a2a/);
  assert.match(agentFramework.reasons[0], /pip install -r runtime\/requirements\.txt/);

  const weather = describeSampleCapability(CATALOGUE.byId.get('weather-api-ensure'), probe);
  assert.equal(weather.ready, true, 'the weather recipe imports different modules and must stay runnable');
});

test('an unavailable optional Python key fallback does not block access-contract deployment', () => {
  const probe = {
    mode: 'execute',
    azureCli: { available: true, version: '2.77.0' },
    accelerator: { available: true, files: 22 },
    python: { available: false, reason: 'Python modules are not installed.' },
  };
  const capability = describeSampleCapability(CATALOGUE.byId.get('access-contract-deploy'), probe);
  assert.equal(capability.ready, true);
  assert.equal(capability.dependencies.find((dependency) => dependency.id === 'python').optional, true);
  assert.match(capability.advisories[0], /fallback/i);
});

test('the browser probe preserves missing modules from later Python-backed samples', () => {
  const probe = {
    mode: 'execute',
    azureCli: { available: true, version: '2.77.0' },
    accelerator: { available: true, files: 22 },
    python: {
      available: true,
      version: '3.11.9',
      modules: {
        'azure.mgmt.apimanagement': true,
        'azure.identity': true,
        httpx: false,
        nest_asyncio: false,
        'a2a.client': false,
        'agent_framework.a2a': false,
      },
    },
  };
  const payload = {
    mode: 'execute',
    capability: summariseCapability(CATALOGUE.samples, probe),
  };
  const reconstructed = probeFromCapabilityPayload(payload, CATALOGUE.byId);
  assert.equal(reconstructed.python.available, true);
  assert.equal(reconstructed.python.modules['azure.mgmt.apimanagement'], true);
  assert.equal(reconstructed.python.modules['agent_framework.a2a'], false);
  assert.equal(
    describeSampleCapability(CATALOGUE.byId.get('agent-framework-hr-question'), {
      ...reconstructed,
      mode: 'execute',
    }).ready,
    false,
  );
});

test('the runtime probe is skipped entirely in preview mode', async () => {
  const spawn = fakeSpawn([{ match: () => true, result: { code: 0, stdout: '{}' } }]);
  const probe = await probeRuntimes({ mode: 'preview', spawn });
  assert.deepEqual(probe, { mode: 'preview' });
  assert.equal(spawn.calls.length, 0, 'preview mode must not spawn anything at all');
});

test('the runtime probe reads the CLI and the interpreter, and nothing on the network', async () => {
  const spawn = fakeSpawn([
    { match: (options) => options.executable === 'az', result: { code: 0, stdout: '{"azure-cli":"2.61.0"}' } },
    {
      match: (options) => options.args[0] === '-c',
      result: { code: 0, stdout: '{"version":"3.12.1","modules":{"httpx":true}}' },
    },
  ]);
  const probe = await probeRuntimes({ mode: 'execute', python: 'python', spawn, root: PLAYGROUND_ROOT });
  assert.equal(probe.azureCli.available, true);
  assert.equal(probe.azureCli.version, '2.61.0');
  assert.equal(probe.python.available, true);
  assert.equal(probe.accelerator.available, true);
  assert.ok(probe.accelerator.files >= 20);
  const pythonProbe = spawn.calls.find((call) => call.executable === 'python');
  assert.match(pythonProbe.args[1], /except \(ImportError, ModuleNotFoundError\)/);
  for (const call of spawn.calls) {
    assert.ok(['az', 'python'].includes(call.executable), `the probe spawned ${call.executable}`);
  }
});

/* -------------------------------------------------- the vendored bundle */

async function walk(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, found);
    else found.push(full);
  }
  return found;
}

test('every vendored file matches its recorded SHA-256', async () => {
  const provenance = JSON.parse(await readFile(join(BUNDLE_ROOT, 'provenance.json'), 'utf-8'));
  assert.ok(provenance.files.length >= 20, 'the bundle should record every file it vendored');
  for (const record of provenance.files) {
    const bytes = await readFile(join(BUNDLE_ROOT, record.path.replace(/\//g, '/')));
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, record.sha256, `${record.path} has drifted from its recorded hash`);
    assert.equal(bytes.length, record.bytes, `${record.path} has drifted in size`);
  }
  const onDisk = (await walk(BUNDLE_ROOT))
    .map((file) => file.slice(BUNDLE_ROOT.length + 1).replace(/\\/g, '/'))
    .filter((file) => file !== 'provenance.json');
  assert.deepEqual(onDisk.sort(), provenance.files.map((file) => file.path).sort(), 'the bundle and its record disagree');
});

test('the vendored bundle is closed: every relative reference resolves inside it', async () => {
  const files = (await walk(BUNDLE_ROOT)).filter((file) => file.endsWith('.bicep'));
  assert.ok(files.length >= 12);
  const missing = [];
  for (const file of files) {
    const text = await readFile(file, 'utf-8');
    const references = [
      ...text.matchAll(/module\s+\w+\s+'([^']+\.bicep)'/g),
      ...text.matchAll(/loadTextContent\('([^']+)'\)/g),
      ...text.matchAll(/loadJsonContent\('([^']+)'\)/g),
    ].map((match) => match[1]);
    for (const reference of references) {
      const target = resolve(file, '..', reference);
      if (!target.startsWith(BUNDLE_ROOT)) {
        missing.push(`${file} references ${reference}, which resolves outside the bundle`);
        continue;
      }
      try {
        await readFile(target);
      } catch {
        missing.push(`${file} references ${reference}, which is not vendored`);
      }
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('the catalogue defaults point inside the vendored bundle, never at the wider repository', () => {
  // Only defaults that name a file or directory on disk. An agent-card route is
  // a URL path, not a filesystem path, and is excluded by construction.
  const pathDefaults = Object.entries(CATALOGUE.defaultValues).filter(
    ([, value]) => typeof value === 'string' && /\.(bicep|bicepparam|json|xml)$|contracts$/.test(value) && !value.startsWith('/'),
  );
  assert.ok(pathDefaults.length >= 4, 'the catalogue should carry template path defaults');
  for (const [path, value] of pathDefaults) {
    assert.ok(value.startsWith(`${ACCELERATOR_ROOT}/`), `${path} points at "${value}", outside the vendored bundle`);
    assert.ok(!value.includes('..'), `${path} escapes with a relative segment`);
  }
  // Nothing anywhere in the catalogue still points at the sibling repository.
  const everything = JSON.stringify(CATALOGUE.defaultValues);
  assert.ok(!everything.includes('../bicep/'), 'a default still reaches outside CitadelSamples');
});

test('the shipped Python wrappers exist and never build a command from a parameter', async () => {
  const scripts = await readdir(join(PLAYGROUND_ROOT, 'runtime', 'python'));
  assert.deepEqual(scripts.sort(), ['agent_framework_ask.py', 'apim_subscription_key.py', 'apim_weather_api.py']);
  for (const script of scripts) {
    const text = await readFile(join(PLAYGROUND_ROOT, 'runtime', 'python', script), 'utf-8');
    for (const forbidden of ['os.system', 'subprocess', 'shell=True', 'eval(', 'exec(']) {
      assert.ok(!text.includes(forbidden), `${script} uses ${forbidden}`);
    }
    assert.ok(text.includes('json.load(sys.stdin)'), `${script} must read its parameters from stdin`);
  }
});

test('a run workspace is git-ignored so nothing a run generates becomes a repository change', async () => {
  const ignore = await readFile(join(PLAYGROUND_ROOT, '.gitignore'), 'utf-8');
  assert.match(ignore, /^\.runs\/$/m);
});

test('the requirements file exists and installs nothing by itself', async () => {
  const requirements = await readFile(join(PLAYGROUND_ROOT, 'runtime', 'requirements.txt'), 'utf-8');
  assert.match(requirements, /NOTHING INSTALLS THESE FOR YOU/);
  for (const module of ['azure-mgmt-apimanagement', 'azure-identity', 'agent-framework', 'httpx', 'nest_asyncio']) {
    assert.match(requirements, new RegExp(`^${module}$`, 'm'), `${module} should be listed`);
  }
});

test('the real spawn transport refuses anything outside the executable allow-list', async () => {
  await assert.rejects(() => spawnProcess({ executable: 'bash', args: ['-c', 'echo hi'] }), /not on the executable allow-list/);
  await assert.rejects(() => spawnProcess({ executable: 'cmd', args: ['/c', 'dir'] }), /not on the executable allow-list/);
  await assert.rejects(() => spawnProcess({ executable: 'az', args: 'not-an-array' }), /array of strings/);
});

test('the Windows Azure CLI shim resolves to its bundled Python without a shell', () => {
  const existing = new Set([
    'c:\\azure\\cli2\\wbin\\az.cmd',
    'c:\\azure\\cli2\\python.exe',
  ]);
  const invocation = resolveSpawnInvocation('az', ['version', '-o', 'json'], {
    platform: 'win32',
    pathValue: 'C:\\Azure\\CLI2\\wbin',
    pathExt: '.EXE;.CMD',
    exists: (path) => existing.has(path.toLowerCase()),
  });
  assert.equal(invocation.executable.toLowerCase(), 'c:\\azure\\cli2\\python.exe');
  assert.deepEqual(invocation.args, ['-IBm', 'azure.cli', 'version', '-o', 'json']);
});

test('a Windows command shim other than the registered Azure CLI launcher is refused', () => {
  assert.throws(
    () =>
      resolveSpawnInvocation('python', ['--version'], {
        platform: 'win32',
        pathValue: 'C:\\Shims',
        pathExt: '.CMD',
        exists: (path) => path.toLowerCase() === 'c:\\shims\\python.cmd',
      }),
    /command shims require a shell/,
  );
});
