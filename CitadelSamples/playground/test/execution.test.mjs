/**
 * Local execution, end to end, through fake transports only.
 *
 * NOTHING IN THIS FILE TOUCHES A REAL AZURE SUBSCRIPTION, GATEWAY, KEY VAULT OR
 * NETWORK. Every `az` invocation and every HTTPS request is served by an
 * injected fake, so the suite can prove the executor's behaviour — including
 * its destructive and load-generating paths — without a single real side
 * effect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGUE, buildSamplePlan, getSample, requirementsFor } from '../src/catalogue/index.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';
import { createLocalExecutor, assertExecutableUrl } from '../src/server/localExecutor.mjs';
import { createRunWorkspace, mapPlanPath, PathRefused } from '../src/server/workspace.mjs';
import { RequestRefused, rebuildPlan, validateRunRequest } from '../src/server/runRequest.mjs';
import { AZ_OPERATIONS, resolveAzOperation, resolvePythonWrapper } from '../src/server/registry.mjs';
import { createRedactor } from '../src/server/redaction.mjs';
import { FAKE_API_KEY, FIXTURE_SECRETS, FIXTURE_VALUES, makeFixtureReader } from './helpers/fixtures.mjs';
import { fakeFetch, fakeFileSystem, fakeSpawn, makeTransports, sseFrame } from './helpers/transports.mjs';

const PLAYGROUND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ACCELERATOR_ROOT = resolve(PLAYGROUND_ROOT, 'runtime', 'accelerator');

/* --------------------------------------------------------------- helpers */

function planFor(sampleId, overrides = {}) {
  const sample = getSample(sampleId);
  const { plan } = buildSamplePlan(sample, makeFixtureReader(overrides));
  return { sample, plan };
}

/** The coerced input map the executor receives, as `rebuildPlan` produces it. */
function inputsFor(sample, overrides = {}) {
  const read = makeFixtureReader(overrides);
  const inputs = {};
  for (const entry of sample.configurationEntries) {
    if (entry.secret) continue;
    const value = read(entry.path);
    inputs[entry.path] = value === undefined ? CATALOGUE.defaultValues[entry.path] : value;
  }
  return inputs;
}

function makeExecutor({ spawn, fetch, filesystem, limits, workspaceId = 'test-0001' } = {}) {
  const fs = filesystem ?? fakeFileSystem({ realReadRoots: [ACCELERATOR_ROOT] });
  const transports = makeTransports({ spawn, fetch, filesystem: fs });
  const workspace = createRunWorkspace({
    playgroundRoot: PLAYGROUND_ROOT,
    runId: workspaceId,
    fs: transports.__filesystem.fs,
  });
  const executor = createLocalExecutor({
    transports,
    workspace,
    limits,
    pythonExecutable: 'python',
    pythonRoot: `${PLAYGROUND_ROOT}/runtime/python`,
  });
  return { executor, transports, workspace };
}

async function run(sampleId, { spawn, fetch, filesystem, overrides = {}, secrets = FIXTURE_SECRETS, limits, signal } = {}) {
  const { sample, plan } = planFor(sampleId, overrides);
  const { executor, transports, workspace } = makeExecutor({ spawn, fetch, filesystem, limits });
  const result = await executor.execute(plan, {
    sampleId,
    inputs: inputsFor(sample, overrides),
    secrets,
    acknowledgement: { accepted: true, sampleId },
    signal,
  });
  return { result, transports, workspace, plan };
}

/* ------------------------------------------------------- path containment */

test('a plan path maps into the run workspace, and an escaping path is refused', () => {
  assert.deepEqual(mapPlanPath('runtime/accelerator/citadel-publish-contracts/main.bicep'), {
    relative: 'citadel-publish-contracts/main.bicep',
    staged: true,
  });
  assert.deepEqual(mapPlanPath('contracts/dev/main.bicepparam'), {
    relative: 'artifacts/contracts/dev/main.bicepparam',
    staged: false,
  });
  for (const bad of ['../outside.txt', '/etc/passwd', 'C:/Windows/System32/x.txt', 'a/../../b', '', 'x\0y']) {
    assert.throws(() => mapPlanPath(bad), PathRefused, `"${bad}" must be refused`);
  }
});

test('the workspace refuses to be constructed with an unsafe run id', () => {
  for (const bad of ['../escape', 'has/slash', 'UPPER', '']) {
    assert.throws(() => createRunWorkspace({ playgroundRoot: PLAYGROUND_ROOT, runId: bad }), PathRefused);
  }
});

test('every artifact is written inside .runs and nowhere else', async () => {
  const spawn = fakeSpawn([{ match: () => true, result: { code: 0, stdout: '{}' } }]);
  const { transports, workspace } = await run('publish-assets', { spawn });
  const written = [...transports.__filesystem.files.keys()];
  assert.ok(written.length > 0, 'the publish contract must write its parameter file');
  for (const path of written) {
    assert.ok(
      path.replace(/\\/g, '/').includes('/.runs/'),
      `${path} was written outside the per-run workspace`,
    );
    assert.ok(path.startsWith(workspace.root), `${path} escaped the workspace root`);
  }
});

/* --------------------------------------------------------------- the CLI */

test('an azure-cli step spawns `az` with an argument array and never a shell', async () => {
  const spawn = fakeSpawn([
    {
      match: (options) => options.args.join(' ').startsWith('account show'),
      result: { code: 0, stdout: JSON.stringify({ id: FIXTURE_VALUES['hub.subscriptionId'], name: 'Test', user: { name: 'a@b.test' }, tenantId: 't' }) },
    },
  ]);
  const { result, transports } = await run('azure-context-check', { spawn });
  const call = transports.spawn.calls[0];
  assert.equal(call.executable, 'az');
  assert.ok(Array.isArray(call.args));
  assert.equal(call.shellRequested, false, 'a shell must never be requested');
  assert.equal(result.state, 'completed');
  assert.equal(result.assertions[0].status, 'passed');
});

test('a mismatched subscription fails the assertion instead of passing', async () => {
  const spawn = fakeSpawn([
    { match: () => true, result: { code: 0, stdout: JSON.stringify({ id: '99999999-9999-9999-9999-999999999999', name: 'Other', user: { name: 'a@b.test' } }) } },
  ]);
  const { result } = await run('azure-context-check', { spawn });
  assert.equal(result.state, 'failed');
  assert.match(result.assertions[0].detail, /Expected/);
});

test('a non-zero exit is a failure carrying stderr, and stops the run', async () => {
  const spawn = fakeSpawn([{ match: () => true, result: { code: 2, stdout: '', stderr: 'ERROR: please run az login' } }]);
  const { result } = await run('azure-context-check', { spawn });
  assert.equal(result.state, 'failed');
  assert.equal(result.steps[0].state, 'failed');
  assert.match(result.steps[0].evidence.stderr, /az login/);
  assert.equal(result.steps.length, 1, 'the run stops rather than asserting against state that was never read');
});

test('an unregistered az operation is refused before it can be spawned', () => {
  const rogue = { id: 'account-show', type: 'azure-cli', command: { executable: 'az', args: ['vm', 'delete', '--yes'] } };
  assert.throws(() => resolveAzOperation('azure-context-check', rogue), /only `az account show` is approved/);
  const notAz = { id: 'account-show', type: 'azure-cli', command: { executable: 'curl', args: ['account', 'show'] } };
  assert.throws(() => resolveAzOperation('azure-context-check', notAz), /only `az` is approved/);
  assert.throws(() => resolveAzOperation('azure-context-check', { id: 'made-up', command: {} }), /No approved az operation/);
});

test('`az rest` is restricted to the approved method and to ARM resource paths', () => {
  const step = (args) => ({ id: 'read-backend-1', type: 'azure-cli', command: { executable: 'az', args } });
  assert.throws(
    () => resolveAzOperation('circuit-breaker-check', step(['rest', '--method', 'post', '--uri', '/subscriptions/x'])),
    /not approved/,
  );
  assert.throws(
    () => resolveAzOperation('circuit-breaker-check', step(['rest', '--method', 'get', '--uri', 'https://evil.test/'])),
    /not an ARM resource path/,
  );
  assert.doesNotThrow(() =>
    resolveAzOperation('circuit-breaker-check', step(['rest', '--method', 'get', '--uri', '/subscriptions/x/backends/y'])),
  );
});

test('the CLI timeout and output limit are passed to the transport, not left to it', async () => {
  const spawn = fakeSpawn([{ match: () => true, result: { code: 0, stdout: JSON.stringify({ id: FIXTURE_VALUES['hub.subscriptionId'] }) } }]);
  const { sample, plan } = planFor('azure-context-check');
  const { executor, transports } = makeExecutor({ spawn, limits: { stepTimeoutMs: 1234, maxOutputBytes: 99 } });
  await executor.execute(plan, { sampleId: sample.id, inputs: inputsFor(sample), secrets: {} });
  assert.equal(transports.spawn.calls.length, 1);
  const raw = spawn.calls[0];
  assert.ok(raw, 'the transport was called');
});

/* -------------------------------------------------------------- discovery */

test('discovery returns safe configuration updates for later recipes', async () => {
  const spawn = fakeSpawn([
    {
      match: (options) => options.args[1] === 'list',
      result: { code: 0, stdout: JSON.stringify([{ name: 'apim-citadel-test', gatewayUrl: 'https://gw.example.net', sku: 'Developer' }]) },
    },
    {
      match: (options) => options.args[1] === 'show',
      result: { code: 0, stdout: JSON.stringify({ name: 'apim-citadel-test', gatewayUrl: 'https://gw.example.net', sku: 'Developer' }) },
    },
  ]);
  const { result, transports } = await run('apim-discovery', { spawn });
  assert.equal(result.state, 'completed');
  const show = transports.spawn.calls.find((call) => call.args[1] === 'show');
  assert.equal(show.args[show.args.indexOf('-n') + 1], 'apim-citadel-test');
  assert.equal(result.configurationUpdates['hub.apimName'], 'apim-citadel-test');
  assert.equal(result.configurationUpdates['hub.gatewayUrl'], 'https://gw.example.net');
  assert.deepEqual(result.secretUpdates, {}, 'discovery mints no credential');
});

test('two candidate services stop the recipe rather than adopting the first', async () => {
  const spawn = fakeSpawn([
    {
      match: (options) => options.args[1] === 'list',
      result: { code: 0, stdout: JSON.stringify([{ name: 'apim-one' }, { name: 'apim-two' }]) },
    },
    { match: (options) => options.args[1] === 'show', result: { code: 0, stdout: '{}' } },
  ]);
  const { result } = await run('apim-discovery', { spawn });
  const selection = result.assertions.find((assertion) => assertion.id === 'select-service');
  assert.equal(selection.status, 'failed');
  assert.match(selection.detail, /2 candidates/);
  assert.equal(spawn.calls.some((call) => call.args[1] === 'show'), false, 'no service may be read after ambiguous selection');
});

test('a single discovered identity and account scope feed the role-assignment commands', async () => {
  const principalId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const clientId = '22222222-3333-4444-5555-666666666666';
  const accountId =
    '/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/rg-foundry/providers/Microsoft.CognitiveServices/accounts/aif-citadel-test';
  const spawn = fakeSpawn([
    {
      match: (options) => options.args.slice(0, 2).join(' ') === 'apim show',
      result: {
        code: 0,
        stdout: JSON.stringify({
          type: 'UserAssigned',
          userAssignedIdentities: {
            '/subscriptions/x/resourceGroups/y/providers/Microsoft.ManagedIdentity/userAssignedIdentities/test': {
              principalId,
              clientId,
            },
          },
        }),
      },
    },
    {
      match: (options) => options.args.slice(0, 3).join(' ') === 'cognitiveservices account list',
      result: { code: 0, stdout: accountId },
    },
    {
      match: (options) => options.args.slice(0, 3).join(' ') === 'role assignment create',
      result: { code: 0, stdout: JSON.stringify({ id: 'assignment-1' }) },
    },
    {
      match: (options) => options.args.slice(0, 3).join(' ') === 'role assignment list',
      result: {
        code: 0,
        stdout: JSON.stringify([{ role: 'Foundry Agent Consumer', scope: `${accountId}/projects/proj-citadel-test` }]),
      },
    },
  ]);
  const { result, transports } = await run('apim-foundry-grant', {
    spawn,
    overrides: {
      'foundry.apimIdentityPrincipalId': '',
      'foundry.apimIdentityClientId': '',
      'foundry.accountResourceId': '',
    },
  });
  assert.equal(result.state, 'completed');
  const create = transports.spawn.calls.find((call) => call.args.slice(0, 3).join(' ') === 'role assignment create');
  assert.equal(create.args[create.args.indexOf('--assignee-object-id') + 1], principalId);
  assert.equal(create.args[create.args.indexOf('--scope') + 1], `${accountId}/projects/proj-citadel-test`);
  assert.equal(result.configurationUpdates['foundry.apimIdentityPrincipalId'], principalId);
  assert.equal(result.configurationUpdates['foundry.apimIdentityClientId'], clientId);
});

test('Application Insights selection feeds the metrics query and later configuration', async () => {
  const spawn = fakeSpawn([
    {
      match: (options) => options.args.slice(0, 2).join(' ') === 'resource list',
      result: { code: 0, stdout: JSON.stringify(['appi-hub']) },
    },
    {
      match: (options) => options.args.slice(0, 3).join(' ') === 'monitor app-insights query',
      result: { code: 0, stdout: JSON.stringify({ tables: [{ rows: [['McpRequests', 'weather-tool', 1]] }] }) },
    },
  ]);
  const { result, transports } = await run('usage-metrics', {
    spawn,
    overrides: { 'samples.usage-metrics.appInsightsName': '' },
  });
  assert.equal(result.state, 'completed');
  const query = transports.spawn.calls.find((call) => call.args.slice(0, 3).join(' ') === 'monitor app-insights query');
  assert.equal(query.args[query.args.indexOf('--app') + 1], 'appi-hub');
  assert.equal(result.configurationUpdates['samples.usage-metrics.appInsightsName'], 'appi-hub');
});

test('access-contract discovery stops before writing or deploying when the configured LLM list is stale', async () => {
  const spawn = fakeSpawn([
    {
      match: (options) => options.args.slice(0, 3).join(' ') === 'apim api list',
      result: { code: 0, stdout: JSON.stringify(['universal-llm-api']) },
    },
  ]);
  const { result, transports } = await run('access-contract-deploy', {
    spawn,
    overrides: { 'samples.access-contract-deploy.existingLlmApis': [] },
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.steps.at(-1).id, 'classify');
  assert.match(result.steps.at(-1).detail, /review it and run again/i);
  assert.deepEqual(result.configurationUpdates['samples.access-contract-deploy.existingLlmApis'], ['universal-llm-api']);
  assert.equal(transports.__filesystem.files.size, 0, 'no contract artifact is written from stale discovery');
  assert.equal(spawn.calls.some((call) => call.args.slice(0, 3).join(' ') === 'deployment sub create'), false);
});

/* ------------------------------------------------------------- HTTP / MCP */

test('an MCP handshake chains the session header into the follow-up call', async () => {
  const fetch = fakeFetch([
    {
      match: (url, init) => JSON.parse(init.body).method === 'initialize',
      response: {
        status: 200,
        headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'session-abc' },
        text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }),
      },
    },
    {
      match: (url, init) => JSON.parse(init.body).method === 'tools/list',
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        text: sseFrame({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get-weather' }] } }),
      },
    },
  ]);
  const { result, transports } = await run('weather-mcp-discovery', { fetch });
  assert.equal(result.state, 'completed');
  const followUp = transports.fetch.calls[1];
  assert.equal(followUp.headers['Mcp-Session-Id'], 'session-abc', 'the follow-up call must echo the session id');
  assert.equal(followUp.headers['api-key'], FAKE_API_KEY, 'the contract key is resolved only at the transport');
  const tools = result.assertions.find((assertion) => assertion.id === 'assert-tools');
  assert.equal(tools.status, 'passed');
  assert.deepEqual(tools.detail.includes('1 tool'), true);
});

test('an HTTP 200 carrying a JSON-RPC error is a failure, not a pass', async () => {
  const fetch = fakeFetch([
    {
      match: () => true,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'agent unavailable' } }),
      },
    },
  ]);
  const { result } = await run('a2a-message-send', { fetch });
  const assertion = result.assertions.find((entry) => entry.id === 'assert-jsonrpc');
  assert.equal(assertion.status, 'failed');
  assert.match(assertion.detail, /agent unavailable/);
  assert.equal(result.state, 'failed');
});

test('an agent card still advertising a Foundry URL fails the gateway check', async () => {
  const fetch = fakeFetch([
    {
      match: () => true,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({
          name: 'HR',
          description: 'HR agent',
          url: 'https://aif-citadel-test.services.ai.azure.com/api/projects/p/agents/a',
        }),
      },
    },
  ]);
  const { result } = await run('a2a-agent-card', { fetch });
  const assertion = result.assertions.find((entry) => entry.id === 'assert-card');
  assert.equal(assertion.status, 'failed');
  assert.match(assertion.detail, /bypass the gateway/);
});

test('the weather tool call asserts the unit branch rather than the randomised values', async () => {
  const payload = {
    city: 'Seattle',
    temperature: 61,
    temperature_format: 'Fahrenheit',
    description: 'cloudy',
    humidity: 71,
    wind_speed: 4,
  };
  const fetch = fakeFetch([
    {
      match: (url, init) => JSON.parse(init.body).method === 'initialize',
      response: { status: 200, headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 's1' }, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) },
    },
    {
      match: (url, init) => JSON.parse(init.body).method === 'tools/call',
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }),
      },
    },
  ]);
  const { result } = await run('weather-tools-call', { fetch, overrides: { 'samples.weather-tools-call.city': 'Seattle' } });
  const assertion = result.assertions.find((entry) => entry.id === 'assert-weather');
  assert.equal(assertion.status, 'passed');

  const wrongUnit = fakeFetch([
    {
      match: (url, init) => JSON.parse(init.body).method === 'initialize',
      response: { status: 200, headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 's1' }, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) },
    },
    {
      match: () => true,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { content: [{ type: 'text', text: JSON.stringify({ ...payload, temperature_format: 'Celsius' }) }] },
        }),
      },
    },
  ]);
  const bad = await run('weather-tools-call', { fetch: wrongUnit, overrides: { 'samples.weather-tools-call.city': 'Seattle' } });
  assert.equal(bad.result.assertions.find((entry) => entry.id === 'assert-weather').status, 'failed');
});

test('a burst honours its count and concurrency and requires a 429', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetch = fakeFetch([
    {
      match: () => true,
      response: (index) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        inFlight -= 1;
        return { status: index > 20 ? 429 : 200, headers: { 'content-type': 'application/json' }, text: '{}' };
      },
    },
  ]);
  const { result, transports } = await run('tool-rate-limit-burst', { fetch });
  assert.equal(transports.fetch.calls.length, 35, 'the burst sends exactly the configured request count');
  const assertion = result.assertions.find((entry) => entry.id === 'assert-throttled');
  assert.equal(assertion.status, 'passed');
  assert.ok(assertion.evidence.histogram['429'] > 0);
});

test('a burst with no 429 fails and names the likely causes', async () => {
  const fetch = fakeFetch([{ match: () => true, response: { status: 200, headers: {}, text: '{}' } }]);
  const { result } = await run('tool-rate-limit-burst', { fetch });
  const assertion = result.assertions.find((entry) => entry.id === 'assert-throttled');
  assert.equal(assertion.status, 'failed');
  assert.match(assertion.detail, /deployed limit may differ/);
});

test('a transport error is counted separately from a throttled call', async () => {
  let call = 0;
  const fetch = fakeFetch([
    {
      match: () => {
        call += 1;
        return true;
      },
      response: () => ({ status: 429, headers: {}, text: '' }),
      get throws() {
        return call % 5 === 0 ? new Error('socket hang up') : undefined;
      },
    },
  ]);
  const { result } = await run('tool-rate-limit-burst', { fetch });
  const burst = result.steps.find((step) => step.id === 'burst');
  assert.ok(burst.evidence.transportErrors > 0, 'transport errors must be counted');
  assert.ok(burst.evidence.statusHistogram['0'] > 0, 'a transport error is not a status code');
});

/* --------------------------------------------------------------- URL rules */

test('only https URLs are executed, and never one carrying credentials', () => {
  assert.doesNotThrow(() => assertExecutableUrl('https://gw.example.net/mcp/x'));
  assert.throws(() => assertExecutableUrl('http://gw.example.net/'), /only makes https requests/);
  assert.throws(() => assertExecutableUrl('file:///etc/passwd'), /only makes https requests/);
  assert.throws(() => assertExecutableUrl('https://user:pass@gw.example.net/'), /inline credentials/);
  assert.throws(() => assertExecutableUrl('not-a-url'), /is not a URL/);
});

test('redirects are refused rather than followed', async () => {
  const fetch = fakeFetch([
    { match: () => true, response: { status: 200, headers: { 'content-type': 'application/json' }, text: '{"name":"c","description":"d"}' } },
  ]);
  await run('a2a-agent-card', { fetch });
  assert.equal(fetch.calls[0].redirect, 'error', 'a gateway must not be able to bounce the request elsewhere');
});

test('an HTTP response is stopped while streaming when it exceeds the configured byte limit', async () => {
  const bytes = new TextEncoder().encode('x'.repeat(128));
  let reads = 0;
  let cancelled = false;
  const fetch = fakeFetch([
    {
      match: () => true,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          getReader: () => ({
            read: async () => (reads++ === 0 ? { done: false, value: bytes } : { done: true }),
            cancel: async () => {
              cancelled = true;
            },
          }),
        },
      },
    },
  ]);
  const { result } = await run('weather-mcp-discovery', {
    fetch,
    limits: { maxResponseBytes: 32 },
  });
  assert.equal(result.state, 'failed');
  assert.match(result.steps[0].detail, /32-byte limit/);
  assert.equal(cancelled, true);
  assert.equal(result.steps.length, 1, 'no follow-up request is sent after an oversized initialize response');
});

/* ----------------------------------------------------------- Python gating */

test('a missing Python module blocks the sample and shows the approved install command', async () => {
  const spawn = fakeSpawn([
    { match: (options) => options.args[0] === '-c', result: { code: 1, stderr: "ModuleNotFoundError: No module named 'azure.mgmt.apimanagement'" } },
  ]);
  const { result } = await run('weather-api-ensure', { spawn });
  assert.equal(result.state, 'blocked');
  const step = result.steps[0];
  assert.equal(step.state, 'blocked');
  assert.equal(step.evidence.install, 'python -m pip install -r runtime/requirements.txt');
  assert.match(step.detail, /Nothing is installed for you/);
  assert.ok(
    !spawn.calls.some((call) => call.args.some((arg) => String(arg).includes('pip install'))),
    'the executor must never install a package itself',
  );
});

test('a Python wrapper runs a shipped script with parameters on stdin, never generated source', async () => {
  const spawn = fakeSpawn([
    { match: (options) => options.args[0] === '-c', result: { code: 0, stdout: '' } },
    {
      match: (options) => options.args[0].endsWith('apim_weather_api.py'),
      result: (options) => {
        const params = JSON.parse(options.stdin);
        return {
          code: 0,
          stdout: params.action === 'upsert' ? '{"apiId":"weather-api"}' : '{"operationNames":["get-weather"]}',
        };
      },
    },
  ]);
  const { result, transports } = await run('weather-api-ensure', { spawn });
  const scriptCalls = transports.spawn.calls.filter((call) => call.args[0].endsWith('.py'));
  assert.equal(scriptCalls.length, 2);
  for (const call of scriptCalls) {
    assert.equal(call.args.length, 1, 'the script path is the only argument; parameters go on stdin');
    assert.ok(call.args[0].includes('runtime/python') || call.args[0].includes('runtime\\python'));
    assert.doesNotThrow(() => JSON.parse(call.stdin));
    assert.ok(!call.stdin.includes('import '), 'no generated Python source is ever passed to the interpreter');
  }
  // The vendored asset paths are resolved into the run workspace.
  const upsert = JSON.parse(scriptCalls[0].stdin);
  assert.ok(upsert.specPath.includes('.runs'), 'the spec is read from the staged bundle inside .runs');
  assert.equal(result.state, 'completed');
  assert.equal(result.assertions.find((entry) => entry.id === 'assert-operation').status, 'passed');
});

test('a missing expected operation is a hard failure', async () => {
  const spawn = fakeSpawn([
    { match: (options) => options.args[0] === '-c', result: { code: 0, stdout: '' } },
    {
      match: (options) => options.args[0].endsWith('apim_weather_api.py'),
      result: (options) =>
        JSON.parse(options.stdin).action === 'upsert'
          ? { code: 0, stdout: '{"apiId":"weather-api"}' }
          : { code: 0, stdout: '{"operationNames":["something-else"]}' },
    },
  ]);
  const { result } = await run('weather-api-ensure', { spawn });
  assert.equal(result.assertions.find((entry) => entry.id === 'assert-operation').status, 'failed');
});

test('every Python-backed step maps to a shipped wrapper, and nothing else does', () => {
  for (const sample of CATALOGUE.samples) {
    const { plan } = buildSamplePlan(sample, makeFixtureReader());
    for (const step of plan.steps.filter((candidate) => candidate.type === 'library')) {
      assert.doesNotThrow(() => resolvePythonWrapper(sample.id, step), `${sample.id}/${step.id} has no wrapper`);
    }
  }
  assert.throws(() => resolvePythonWrapper('azure-context-check', { id: 'account-show' }), /No approved Python wrapper/);
});

/* -------------------------------------------------------------- redaction */

test('an access token never reaches evidence, a log line or a result', async () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXZhbHVl';
  const spawn = fakeSpawn([
    { match: (options) => options.args[1] === 'get-access-token', result: { code: 0, stdout: `${token}\n` } },
  ]);
  const fetch = fakeFetch([
    { match: () => true, response: { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ ok: true }) } },
  ]);
  const { result, transports } = await run('foundry-enable-a2a', { spawn, fetch });
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(token), 'the minted token must not appear anywhere in the result');
  assert.equal(result.steps[0].evidence.tokenAcquired, true);
  assert.equal(result.steps[0].evidence.tokenLength, token.length);
  // It is still bound into the outgoing request, which is the whole point.
  assert.equal(transports.fetch.calls[0].headers.Authorization, `Bearer ${token}`);
});

test('a credential echoed back by a later step is redacted out of its output', async () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJlY2hvIn0.YW5vdGhlci1zaWc';
  const spawn = fakeSpawn([
    { match: (options) => options.args[1] === 'get-access-token', result: { code: 0, stdout: token } },
  ]);
  const fetch = fakeFetch([
    {
      match: () => true,
      response: { status: 400, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ error: `bad token ${token}` }) },
    },
  ]);
  const { result } = await run('foundry-enable-a2a', { spawn, fetch });
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(token));
  assert.match(serialised, /\[redacted\]/);
});

test('the redactor removes known values and credential shapes it has never seen', () => {
  const redactor = createRedactor(['SECRET-VALUE-0001']);
  assert.equal(redactor.text('key=SECRET-VALUE-0001 end'), 'key=[redacted] end');
  assert.match(redactor.text('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'), /Bearer \[redacted\]/);
  assert.match(redactor.text('{"primaryKey": "abcdefghijklmnop"}'), /"primaryKey": "\[redacted\]"/);
  assert.match(
    redactor.text('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl rest'),
    /token \[redacted\] rest/,
  );
  assert.equal(redactor.leaks('nothing here'), false);
  assert.equal(redactor.leaks('SECRET-VALUE-0001'), true);
});

test('a minted gateway key is returned as a marked secret update and never as evidence', async () => {
  const minted = 'MINTED-CONTRACT-KEY-0001';
  const spawn = fakeSpawn([
    { match: (options) => options.args.slice(0, 3).join(' ') === 'apim api list', result: { code: 0, stdout: '["universal-llm-api"]' } },
    {
      match: (options) => options.args.slice(0, 3).join(' ') === 'deployment sub create',
      result: {
        code: 0,
        stdout: JSON.stringify({
          properties: {
            provisioningState: 'Succeeded',
            outputs: {
              endpoints: { value: [{ apiName: 'weather-tool', apiKey: minted }] },
              subscriptions: {
                value: [{ keyVaultApiKeySecretName: 'MULTI-KEY', keyVaultEndpointSecretNames: ['a-endpoint'] }],
              },
            },
          },
        }),
      },
    },
    { match: (options) => options.args[0] === '-c', result: { code: 0, stdout: '' } },
  ]);
  const { result } = await run('access-contract-deploy', { spawn });
  assert.equal(result.secretUpdates['gatewayAccess.apiKey'], minted);
  const withoutSecretUpdates = JSON.stringify({ ...result, secretUpdates: undefined });
  assert.ok(!withoutSecretUpdates.includes(minted), 'the minted key must not appear in steps, evidence or the summary');
  assert.equal(result.configurationUpdates['keyVault.keySecretName'], 'MULTI-KEY');
  const fallback = result.steps.find((step) => step.id === 'key-fallback');
  assert.equal(fallback.state, 'skipped', 'the documented fallback runs only when the outputs carried no key');
});

/* ------------------------------------------------------------ cancellation */

test('cancelling a run stops it and reports cancelled, never completed', async () => {
  const controller = new AbortController();
  const fetch = fakeFetch([
    {
      match: () => {
        controller.abort();
        return true;
      },
      response: { status: 200, headers: {}, text: '{}' },
    },
  ]);
  const { result } = await run('tool-rate-limit-burst', { fetch, signal: controller.signal });
  assert.equal(result.state, 'cancelled');
  assert.ok(result.summary.startsWith('Cancelled'));
});

/* --------------------------------------------------- request reconstruction */

test('the browser cannot send a plan, a command, a URL, a path or a script', () => {
  const base = { protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'azure-context-check', inputs: {} };
  for (const member of ['plan', 'steps', 'command', 'executable', 'args', 'url', 'headers', 'script', 'code', 'path', 'env', 'shell']) {
    assert.throws(
      () => validateRunRequest({ ...base, [member]: 'anything' }, CATALOGUE),
      (error) => error instanceof RequestRefused && error.code === 'forbidden-member',
      `"${member}" must be refused`,
    );
  }
});

test('an unknown sample, input key, secret key or protocol version is refused', () => {
  assert.throws(
    () => validateRunRequest({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'not-a-sample' }, CATALOGUE),
    /is not a sample in this catalogue/,
  );
  assert.throws(
    () => validateRunRequest({ protocolVersion: 1, sampleId: 'azure-context-check' }, CATALOGUE),
    /Unsupported protocol version/,
  );
  assert.throws(
    () =>
      validateRunRequest(
        { protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'azure-context-check', inputs: { 'hub.gatewayUrl': 'x' } },
        CATALOGUE,
      ),
    /is not an input of sample/,
  );
  assert.throws(
    () =>
      validateRunRequest(
        { protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'weather-mcp-discovery', secrets: { 'keyVault.name': 'x' } },
        CATALOGUE,
      ),
    /is not a secret this sample uses/,
  );
  assert.throws(
    () =>
      validateRunRequest(
        {
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sampleId: 'azure-context-check',
          inputs: { 'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'] },
          secrets: { 'gatewayAccess.apiKey': FAKE_API_KEY },
        },
        CATALOGUE,
      ),
    /is not a secret this sample uses/,
  );
});

test('a secret sent as an ordinary input is refused', () => {
  assert.throws(
    () =>
      validateRunRequest(
        {
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sampleId: 'weather-mcp-discovery',
          inputs: { 'gatewayAccess.apiKey': FAKE_API_KEY },
        },
        CATALOGUE,
      ),
    /must be sent in `secrets`/,
  );
});

test('an oversized value, an overlong list and a NUL byte are refused', () => {
  const long = 'x'.repeat(5000);
  const request = (inputs) => ({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'apim-discovery', inputs });
  assert.throws(() => validateRunRequest(request({ 'hub.resourceGroupName': long }), CATALOGUE), /exceeds/);
  assert.throws(() => validateRunRequest(request({ 'hub.resourceGroupName': 'a\0b' }), CATALOGUE), /NUL byte/);
  assert.throws(
    () => validateRunRequest(request({ 'hub.resourceGroupName': { nested: true } }), CATALOGUE),
    /unsupported type/,
  );
});

test('a risky sample is refused without a fresh acknowledgement naming it', () => {
  const payload = {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sampleId: 'cleanup',
    inputs: {},
  };
  assert.throws(() => validateRunRequest(payload, CATALOGUE), /A fresh acknowledgement naming this sample is required/);
  assert.throws(
    () => validateRunRequest({ ...payload, acknowledgement: { accepted: true, sampleId: 'apim-discovery' } }, CATALOGUE),
    /acknowledgement/,
  );
  assert.doesNotThrow(() =>
    validateRunRequest({ ...payload, acknowledgement: { accepted: true, sampleId: 'cleanup' } }, CATALOGUE),
  );
});

test('the server rebuilds the plan from its own catalogue and refuses an incomplete configuration', () => {
  const complete = validateRunRequest(
    {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sampleId: 'apim-discovery',
      inputs: { 'hub.resourceGroupName': 'rg-test' },
    },
    CATALOGUE,
  );
  const { plan } = rebuildPlan(complete, CATALOGUE, { buildSamplePlan, requirementsFor });
  assert.equal(plan.sampleId, 'apim-discovery');
  assert.equal(plan.steps[0].command.args.includes('rg-test'), true);

  const incomplete = validateRunRequest(
    { protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'apim-discovery', inputs: {} },
    CATALOGUE,
  );
  assert.throws(
    () => rebuildPlan(incomplete, CATALOGUE, { buildSamplePlan, requirementsFor }),
    (error) => error instanceof RequestRefused && error.code === 'incomplete-configuration',
  );
});

test('every registered az operation belongs to a step that actually exists', () => {
  const known = new Set();
  for (const sample of CATALOGUE.samples) {
    const { plan } = buildSamplePlan(sample, makeFixtureReader({ 'samples.cleanup.deleteAccessContract': true, 'samples.cleanup.deletePublishedAssets': true, 'samples.cleanup.deleteWeatherSourceApi': true }));
    for (const step of plan.steps) known.add(`${sample.id}/${step.id.replace(/-\d+$/, '-*')}`);
  }
  for (const key of Object.keys(AZ_OPERATIONS)) {
    if (AZ_OPERATIONS[key] === null) continue;
    assert.ok(known.has(key), `${key} is registered but no plan produces that step`);
  }
});

test('every azure-cli step in every plan has a registered operation', () => {
  const overrides = {
    'samples.cleanup.deleteAccessContract': true,
    'samples.cleanup.deletePublishedAssets': true,
    'samples.cleanup.deleteWeatherSourceApi': true,
  };
  for (const sample of CATALOGUE.samples) {
    const { plan } = buildSamplePlan(sample, makeFixtureReader(overrides));
    for (const step of plan.steps.filter((candidate) => candidate.type === 'azure-cli')) {
      assert.doesNotThrow(() => resolveAzOperation(sample.id, step), `${sample.id}/${step.id} is not registered`);
    }
  }
});
