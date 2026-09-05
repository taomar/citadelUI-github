/**
 * Protocol behaviour: MCP session binding, JSON and SSE parsing, and the
 * JSON-RPC rule the notebook gets wrong — an HTTP 200 carrying `error`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSamplePlan, getSample } from '../src/catalogue/index.mjs';
import {
  MCP_PROTOCOL_HEADER,
  MCP_PROTOCOL_VERSION,
  MCP_SESSION_HEADER,
} from '../src/core/types.mjs';
import {
  mcpCallStep,
  mcpInitializedStep,
  mcpInitializeStep,
  mcpNotificationPayload,
  mcpPayload,
} from '../src/core/mcp.mjs';
import {
  extractToolCallText,
  extractToolNames,
  interpretJsonRpc,
  MAX_SSE_EVENTS,
  parseHttpResponse,
  parseSseBody,
  parseWeatherPayload,
  readHeader,
} from '../src/core/parsing.mjs';
import { evaluateAssertion } from '../src/server/assertions.mjs';
import { makeFixtureReader } from './helpers/fixtures.mjs';

const ENDPOINT = 'https://gw.test/mcp/weather-tool-mcp/mcp';

/* ------------------------------------------------------- session binding */

test('the MCP handshake captures and binds the negotiated session and protocol', () => {
  const init = mcpInitializeStep({ endpoint: ENDPOINT });
  assert.equal(init.request.capture.sessionId, `response.headers['${MCP_SESSION_HEADER}']`);
  assert.equal(init.request.capture.protocolVersion, 'response.jsonrpc.result.protocolVersion');
  assert.ok(init.produces.includes('sessionId'));
  assert.ok(init.produces.includes('protocolVersion'));

  const initialized = mcpInitializedStep({ endpoint: ENDPOINT });
  assert.deepEqual(initialized.request.body, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  assert.equal(Object.hasOwn(initialized.request.body, 'id'), false);
  assert.equal(initialized.request.headers[MCP_SESSION_HEADER], '{{steps.mcp-initialize.sessionId}}');
  assert.equal(initialized.request.headers[MCP_PROTOCOL_HEADER], '{{steps.mcp-initialize.protocolVersion}}');
  assert.deepEqual(initialized.consumes, [
    'mcp-initialize.sessionId',
    'mcp-initialize.protocolVersion',
  ]);

  const list = mcpCallStep({
    id: 'tools-list',
    endpoint: ENDPOINT,
    method: 'tools/list',
    params: {},
    jsonRpcId: 2,
  });
  assert.equal(list.request.headers[MCP_SESSION_HEADER], '{{steps.mcp-initialize.sessionId}}');
  assert.equal(list.request.headers[MCP_PROTOCOL_HEADER], '{{steps.mcp-initialize.protocolVersion}}');
  assert.deepEqual(list.consumes, [
    'mcp-initialize.sessionId',
    'mcp-initialize.protocolVersion',
  ]);
});

test('the JSON-RPC id must be an integer, because APIM rejects string ids', () => {
  assert.throws(() => mcpPayload({ id: 'a-uuid', method: 'initialize' }), /must be an integer/);
  assert.throws(() => mcpPayload({ id: 1.5, method: 'initialize' }), /must be an integer/);
  assert.deepEqual(mcpPayload({ id: 1, method: 'initialize' }), { jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.deepEqual(mcpNotificationPayload({ method: 'notifications/initialized' }), {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
});

test('every MCP recipe emits initialize, initialized, then the tool request with required headers', () => {
  for (const id of ['weather-mcp-discovery', 'learn-mcp-discovery', 'weather-tools-call']) {
    const { plan } = buildSamplePlan(getSample(id), makeFixtureReader());
    const init = plan.steps.find((step) => step.id === 'mcp-initialize');
    assert.equal(init.request.body.params.protocolVersion, MCP_PROTOCOL_VERSION, `${id} pins the wrong version`);
    assert.equal(init.request.headers.Accept, 'application/json, text/event-stream', `${id} accepts the wrong types`);
    const initialized = plan.steps.find((step) => step.id === 'mcp-initialized');
    const follow = plan.steps.find((step) => ['tools-list', 'tools-call'].includes(step.id));
    assert.ok(plan.steps.indexOf(init) < plan.steps.indexOf(initialized), `${id} initializes out of order`);
    assert.ok(plan.steps.indexOf(initialized) < plan.steps.indexOf(follow), `${id} sends the tool request too early`);
    assert.equal(initialized.request.body.method, 'notifications/initialized');
    assert.equal(Object.hasOwn(initialized.request.body, 'id'), false);
    assert.equal(initialized.request.headers[MCP_SESSION_HEADER], '{{steps.mcp-initialize.sessionId}}');
    assert.equal(initialized.request.headers[MCP_PROTOCOL_HEADER], '{{steps.mcp-initialize.protocolVersion}}');
    assert.equal(follow.request.headers[MCP_SESSION_HEADER], '{{steps.mcp-initialize.sessionId}}');
    assert.equal(follow.request.headers[MCP_PROTOCOL_HEADER], '{{steps.mcp-initialize.protocolVersion}}');
    assert.equal(follow.request.body.id, 2, `${id} does not increment the JSON-RPC id`);
  }
});

/* ------------------------------------------------------------- parsing */

test('a JSON response is parsed as JSON', () => {
  const parsed = parseHttpResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    text: '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get-weather"}]}}',
  }, { jsonRpcId: 1 });
  assert.equal(parsed.format, 'json');
  assert.equal(parsed.jsonRpc.matched, true);
  assert.deepEqual(extractToolNames(parsed.data.result), ['get-weather']);
});

test('a JSON response for an unrelated id is not accepted as the request response', () => {
  const parsed = parseHttpResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    text: '{"jsonrpc":"2.0","id":9,"result":{"ignored":true}}',
  }, { jsonRpcId: 1 });
  assert.equal(parsed.data, null);
  assert.equal(parsed.jsonRpc.matched, false);
});

test('an SSE response ignores notifications and unrelated ids before the matching response', () => {
  const body = [
    ': keep-alive',
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
    '',
    'data: {"jsonrpc":"2.0","id":99,"result":{"ignored":true}}',
    '',
    'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get-weather"}]}}',
    '',
  ].join('\n');
  const parsed = parseHttpResponse({
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    text: body,
  }, { jsonRpcId: 2 });
  assert.equal(parsed.format, 'sse');
  assert.equal(parsed.data.id, 2);
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.jsonRpc.matched, true);
});

test('SSE data folding across lines is reassembled before parsing', () => {
  const body = ['data: {"jsonrpc":"2.0",', 'data: "id":7,', 'data: "result":{"ok":true}}', ''].join('\n');
  const { data } = parseSseBody(body, { jsonRpcId: 7 });
  assert.deepEqual(data, { jsonrpc: '2.0', id: 7, result: { ok: true } });
});

test('a matching JSON-RPC error is selected for normal failure interpretation', () => {
  const { data } = parseSseBody(
    'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"unavailable"}}\n\n',
    { jsonRpcId: 2 },
  );
  assert.equal(data.id, 2);
  assert.equal(data.error.code, -32000);
});

test('a same-id server request does not shadow a later matching response', () => {
  const { data, malformed } = parseSseBody(
    [
      'data: {"jsonrpc":"2.0","id":2,"method":"sampling/createMessage","params":{}}',
      '',
      'data: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}',
      '',
    ].join('\n'),
    { jsonRpcId: 2 },
  );
  assert.deepEqual(data, { jsonrpc: '2.0', id: 2, result: { ok: true } });
  assert.equal(malformed, false);
});

test('a matching envelope with both result and error is malformed, never a success', () => {
  const parsed = parseSseBody(
    'data: {"jsonrpc":"2.0","id":2,"result":{"ok":true},"error":null}\n\n',
    { jsonRpcId: 2 },
  );
  assert.equal(parsed.data, null);
  assert.equal(parsed.malformed, true);
  assert.equal(
    interpretJsonRpc({
      status: 200,
      body: { jsonrpc: '2.0', id: 2, result: { ok: true }, error: null },
    }).outcome,
    'inconclusive',
  );
});

test('an SSE stream with no matching id is inconclusive', () => {
  const parsed = parseSseBody(
    'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":9,"result":{}}\n\n',
    { jsonRpcId: 2 },
  );
  assert.equal(parsed.data, null);
  assert.equal(parsed.malformed, false);
});

test('a malformed SSE data event rejects the stream even if a later id matches', () => {
  const parsed = parseSseBody(
    'data: not json\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n',
    { jsonRpcId: 2 },
  );
  assert.equal(parsed.data, null);
  assert.equal(parsed.malformed, true);
});

test('SSE response selection is bounded', () => {
  const notifications = Array.from(
    { length: MAX_SSE_EVENTS },
    (_, index) => `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"index":${index}}}\n\n`,
  ).join('');
  const parsed = parseSseBody(`${notifications}data: {"jsonrpc":"2.0","id":2,"result":{"tooLate":true}}\n\n`, {
    jsonRpcId: 2,
  });
  assert.equal(parsed.data, null);
  assert.equal(parsed.limitExceeded, true);
});

test('CRLF line endings and an empty body are handled', () => {
  const { data } = parseSseBody('data: {"jsonrpc":"2.0","id":3,"result":{}}\r\n\r\n', { jsonRpcId: 3 });
  assert.deepEqual(data, { jsonrpc: '2.0', id: 3, result: {} });
  assert.equal(parseHttpResponse({ status: 204, headers: {}, text: '' }).format, 'empty');
  assert.equal(parseHttpResponse({ status: 200, headers: {}, text: 'plain' }).format, 'text');
});

test('headers are read case-insensitively from an object or a Headers-like', () => {
  assert.equal(readHeader({ 'Mcp-Session-Id': 'abc' }, 'mcp-session-id'), 'abc');
  assert.equal(readHeader({ 'mcp-session-id': 'abc' }, 'Mcp-Session-Id'), 'abc');
  assert.equal(readHeader(new Map([['x', 'y']]), 'z'), undefined);
  const headersLike = { get: (name) => (name === 'Mcp-Session-Id' ? 'from-get' : null) };
  assert.equal(readHeader(headersLike, 'Mcp-Session-Id'), 'from-get');
});

/* --------------------------------------------------- JSON-RPC semantics */

test('an HTTP 200 carrying a JSON-RPC error is a FAILURE, not a pass', () => {
  const verdict = interpretJsonRpc({
    status: 200,
    body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } },
  });
  assert.equal(verdict.outcome, 'failure');
  assert.equal(verdict.httpOk, true);
  assert.match(verdict.reason, /2xx with a JSON-RPC error is a failure/);
  assert.equal(verdict.error.code, -32603);
  assert.equal(verdict.result, null);
});

test('an HTTP 200 with a result is a success', () => {
  const verdict = interpretJsonRpc({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { ok: true } } });
  assert.equal(verdict.outcome, 'success');
  assert.deepEqual(verdict.result, { ok: true });
});

test('an HTTP 200 with neither result nor error is inconclusive, never a pass', () => {
  const verdict = interpretJsonRpc({ status: 200, body: { jsonrpc: '2.0', id: 1 } });
  assert.equal(verdict.outcome, 'inconclusive');
});

test('a non-2xx is a failure whether or not it carries a JSON-RPC body', () => {
  assert.equal(interpretJsonRpc({ status: 429, body: { jsonrpc: '2.0', id: 1, result: {} } }).outcome, 'failure');
  assert.equal(interpretJsonRpc({ status: 500, body: null }).outcome, 'failure');
});

test('a 2xx with a non-object body is inconclusive rather than a pass', () => {
  assert.equal(interpretJsonRpc({ status: 200, body: null }).outcome, 'inconclusive');
  assert.equal(interpretJsonRpc({ status: 200, body: 'plain text' }).outcome, 'inconclusive');
});

test('MCP assertions cannot pass without the required session capture', () => {
  const outputs = new Map([
    ['mcp-initialize.status', 200],
    ['tools-list.status', 200],
    ['tools-call.status', 200],
  ]);
  const stepResults = [
    { id: 'mcp-initialize', jsonRpcBody: { jsonrpc: '2.0', id: 1, result: {} } },
    { id: 'tools-list', jsonRpcBody: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get-weather' }] } } },
    {
      id: 'tools-call',
      jsonRpcBody: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                city: 'Seattle',
                temperature: 61,
                temperature_format: 'Fahrenheit',
                description: 'cloudy',
                humidity: 71,
                wind_speed: 4,
              }),
            },
          ],
        },
      },
    },
  ];
  const tools = evaluateAssertion(
    { assertion: { kind: 'mcp-tools' }, produces: [] },
    { outputs, stepResults },
  );
  const weather = evaluateAssertion(
    {
      assertion: {
        kind: 'weather-payload',
        expectedFields: ['city', 'temperature', 'temperature_format', 'description', 'humidity', 'wind_speed'],
        expectedUnit: 'Fahrenheit',
      },
      produces: [],
    },
    { outputs, stepResults },
  );
  assert.equal(tools.status, 'failed');
  assert.equal(weather.status, 'failed');
  assert.deepEqual(tools.evidence, { sessionCaptured: false });
  assert.deepEqual(weather.evidence, { sessionCaptured: false });
});

test('MCP assertions cannot pass when initialize returns a matching JSON-RPC error', () => {
  const outputs = new Map([
    ['mcp-initialize.status', 200],
    ['mcp-initialize.sessionId', 'session-abc'],
    ['tools-list.status', 200],
    ['tools-call.status', 200],
  ]);
  const stepResults = [
    {
      id: 'mcp-initialize',
      jsonRpcBody: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'initialization failed' } },
    },
    { id: 'tools-list', jsonRpcBody: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get-weather' }] } } },
    {
      id: 'tools-call',
      jsonRpcBody: {
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: '{"city":"Seattle"}' }] },
      },
    },
  ];
  const tools = evaluateAssertion(
    { assertion: { kind: 'mcp-tools' }, produces: [] },
    { outputs, stepResults },
  );
  const weather = evaluateAssertion(
    { assertion: { kind: 'weather-payload', expectedFields: ['city'] }, produces: [] },
    { outputs, stepResults },
  );
  assert.equal(tools.status, 'failed');
  assert.equal(weather.status, 'failed');
});

test('MCP assertions independently reject a mismatched negotiated protocol version', () => {
  const outputs = new Map([
    ['mcp-initialize.status', 200],
    ['mcp-initialize.sessionId', 'session-abc'],
    ['mcp-initialize.protocolVersion', '2024-11-05'],
    ['tools-list.status', 200],
  ]);
  const stepResults = [
    {
      id: 'mcp-initialize',
      state: 'completed',
      jsonRpcBody: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } },
    },
    { id: 'mcp-initialized', state: 'completed' },
    { id: 'tools-list', state: 'completed', jsonRpcBody: { jsonrpc: '2.0', id: 2, result: { tools: [] } } },
  ];
  const result = evaluateAssertion(
    { assertion: { kind: 'mcp-tools' }, produces: [] },
    { outputs, stepResults },
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.evidence, { sessionCaptured: true, protocolCompatible: false });
});

test('MCP assertions independently reject a missing initialized notification', () => {
  const outputs = new Map([
    ['mcp-initialize.status', 200],
    ['mcp-initialize.sessionId', 'session-abc'],
    ['mcp-initialize.protocolVersion', MCP_PROTOCOL_VERSION],
    ['tools-list.status', 200],
  ]);
  const stepResults = [
    {
      id: 'mcp-initialize',
      state: 'completed',
      jsonRpcBody: { jsonrpc: '2.0', id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION } },
    },
    { id: 'tools-list', state: 'completed', jsonRpcBody: { jsonrpc: '2.0', id: 2, result: { tools: [] } } },
  ];
  const result = evaluateAssertion(
    { assertion: { kind: 'mcp-tools' }, produces: [] },
    { outputs, stepResults },
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.evidence, {
    sessionCaptured: true,
    protocolCompatible: true,
    notificationAccepted: false,
  });
});

test('role-assignment readback requires the exact reviewed id, name, and scope', () => {
  const scope =
    '/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aif/projects/proj';
  const step = (expected, assignment) => {
    const outputs = new Map([['verify.assignments', [assignment]]]);
    return evaluateAssertion(
      {
        produces: ['granted'],
        assertion: {
          kind: 'role-assignment',
          source: '{{steps.verify.assignments}}',
          expectedScope: scope,
          ...expected,
        },
      },
      { outputs, stepResults: [] },
    );
  };

  const consumer = {
    expectedRoleDefinitionName: 'Foundry Agent Consumer',
    expectedRoleDefinitionNames: ['Foundry Agent Consumer'],
    expectedRoleDefinitionId: 'eed3b665-ab3a-47b6-8f48-c9382fb1dad6',
  };
  const foundryUser = {
    expectedRoleDefinitionName: 'Foundry User',
    expectedRoleDefinitionNames: ['Foundry User', 'Azure AI User'],
    expectedRoleDefinitionId: '53ca6127-db72-4b80-b1b0-d745d6d5456d',
  };

  assert.equal(
    step(consumer, {
      roleDefinitionName: 'Foundry Agent Consumer',
      roleDefinitionId:
        '/subscriptions/00000000-1111-2222-3333-444444444444/providers/Microsoft.Authorization/roleDefinitions/eed3b665-ab3a-47b6-8f48-c9382fb1dad6',
      scope,
    }).status,
    'passed',
  );
  for (const roleDefinitionName of ['Foundry User', 'Azure AI User']) {
    assert.equal(
      step(foundryUser, {
        roleDefinitionName,
        roleDefinitionId: '53ca6127-db72-4b80-b1b0-d745d6d5456d',
        scope,
      }).status,
      'passed',
    );
  }
  for (const assignment of [
    {
      roleDefinitionName: 'Foundry User',
      roleDefinitionId: 'eed3b665-ab3a-47b6-8f48-c9382fb1dad6',
      scope,
    },
    {
      roleDefinitionName: 'Foundry Owner',
      roleDefinitionId: '53ca6127-db72-4b80-b1b0-d745d6d5456d',
      scope,
    },
    {
      roleDefinitionName: 'Foundry User',
      roleDefinitionId: '53ca6127-db72-4b80-b1b0-d745d6d5456d',
      scope: `${scope}/agents/other`,
    },
  ]) {
    assert.equal(step(foundryUser, assignment).status, 'failed');
  }
});

test('the A2A recipe asserts on the JSON-RPC body, not only on the status', () => {
  const { plan } = buildSamplePlan(getSample('a2a-message-send'), makeFixtureReader());
  const send = plan.steps.find((step) => step.id === 'message-send');
  assert.equal(send.request.capture.error, 'response.jsonrpc.error');
  assert.ok(send.produces.includes('error'));

  const assertion = plan.steps.at(-1).assertion;
  assert.equal(assertion.kind, 'jsonrpc');
  const text = assertion.expectations.join(' ');
  assert.match(text, /no `error` member/);
  assert.match(text, /HTTP 2xx carrying `error` fails/);
});

test('the A2A message object carries the kind field Foundry v0.3 requires', () => {
  const { plan } = buildSamplePlan(getSample('a2a-message-send'), makeFixtureReader());
  const message = plan.steps[0].request.body.params.message;
  assert.equal(message.kind, 'message');
  assert.equal(message.role, 'user');
  assert.equal(message.parts[0].kind, 'text');
  assert.equal(plan.steps[0].request.body.id, 1);
});

test('the burst body reuses the same JSON-RPC shape as the single call', () => {
  const { plan } = buildSamplePlan(getSample('agent-rate-limit-burst'), makeFixtureReader());
  const burst = plan.steps.find((step) => step.id === 'burst');
  assert.equal(burst.request.body.method, 'message/send');
  assert.equal(burst.request.body.params.message.kind, 'message');
});

/* ----------------------------------------------------- tool-call payload */

test('tool-call content is read from the first text block', () => {
  const result = { content: [{ type: 'text', text: '{"city":"London"}' }] };
  assert.equal(extractToolCallText(result), '{"city":"London"}');
  assert.equal(extractToolCallText({ content: [] }), '');
  assert.equal(extractToolCallText({}), '');
});

test('the weather payload parses, and a non-JSON payload does not throw', () => {
  const payload = parseWeatherPayload(
    '{"city":"London","temperature":12.3,"temperature_format":"Celsius","description":"Overcast","humidity":70,"wind_speed":3.2}',
  );
  assert.equal(payload.city, 'London');
  assert.equal(payload.temperature_format, 'Celsius');
  assert.equal(parseWeatherPayload('not json'), null);
  assert.equal(parseWeatherPayload(''), null);
  assert.equal(parseWeatherPayload('"a string"'), null);
});
