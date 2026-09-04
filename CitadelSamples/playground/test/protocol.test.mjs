/**
 * Protocol behaviour: MCP session binding, JSON and SSE parsing, and the
 * JSON-RPC rule the notebook gets wrong — an HTTP 200 carrying `error`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSamplePlan, getSample } from '../src/catalogue/index.mjs';
import { MCP_PROTOCOL_VERSION, MCP_SESSION_HEADER } from '../src/core/types.mjs';
import { mcpCallStep, mcpInitializeStep, mcpPayload } from '../src/core/mcp.mjs';
import {
  extractToolCallText,
  extractToolNames,
  interpretJsonRpc,
  parseHttpResponse,
  parseSseBody,
  parseWeatherPayload,
  readHeader,
} from '../src/core/parsing.mjs';
import { makeFixtureReader } from './helpers/fixtures.mjs';

const ENDPOINT = 'https://gw.test/mcp/weather-tool-mcp/mcp';

/* ------------------------------------------------------- session binding */

test('the initialize step captures the session header and later steps consume it', () => {
  const init = mcpInitializeStep({ endpoint: ENDPOINT });
  assert.equal(init.request.capture.sessionId, `response.headers['${MCP_SESSION_HEADER}']`);
  assert.ok(init.produces.includes('sessionId'));

  const list = mcpCallStep({
    id: 'tools-list',
    endpoint: ENDPOINT,
    method: 'tools/list',
    params: {},
    jsonRpcId: 2,
  });
  assert.equal(list.request.headers[MCP_SESSION_HEADER], '{{steps.mcp-initialize.sessionId}}');
  assert.deepEqual(list.consumes, ['mcp-initialize.sessionId']);
});

test('the JSON-RPC id must be an integer, because APIM rejects string ids', () => {
  assert.throws(() => mcpPayload({ id: 'a-uuid', method: 'initialize' }), /must be an integer/);
  assert.throws(() => mcpPayload({ id: 1.5, method: 'initialize' }), /must be an integer/);
  assert.deepEqual(mcpPayload({ id: 1, method: 'initialize' }), { jsonrpc: '2.0', id: 1, method: 'initialize' });
});

test('every MCP recipe pins the protocol version and sends both accepted media types', () => {
  for (const id of ['weather-mcp-discovery', 'learn-mcp-discovery', 'weather-tools-call']) {
    const { plan } = buildSamplePlan(getSample(id), makeFixtureReader());
    const init = plan.steps.find((step) => step.id === 'mcp-initialize');
    assert.equal(init.request.body.params.protocolVersion, MCP_PROTOCOL_VERSION, `${id} pins the wrong version`);
    assert.equal(init.request.headers.Accept, 'application/json, text/event-stream', `${id} accepts the wrong types`);
    const follow = plan.steps.find((step) => step.id !== 'mcp-initialize' && step.type === 'http');
    assert.equal(follow.request.headers[MCP_SESSION_HEADER], '{{steps.mcp-initialize.sessionId}}');
    assert.equal(follow.request.body.id, 2, `${id} does not increment the JSON-RPC id`);
  }
});

/* ------------------------------------------------------------- parsing */

test('a JSON response is parsed as JSON', () => {
  const parsed = parseHttpResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    text: '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get-weather"}]}}',
  });
  assert.equal(parsed.format, 'json');
  assert.deepEqual(extractToolNames(parsed.data.result), ['get-weather']);
});

test('an SSE response yields the first JSON data frame, as the notebook does', () => {
  const body = [
    ': keep-alive',
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}',
    '',
    'data: {"jsonrpc":"2.0","id":2,"result":{"ignored":true}}',
    '',
  ].join('\n');
  const parsed = parseHttpResponse({
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    text: body,
  });
  assert.equal(parsed.format, 'sse');
  assert.equal(parsed.data.id, 1);
  assert.equal(parsed.events.length, 2);
});

test('SSE data folding across lines is reassembled before parsing', () => {
  const body = ['data: {"jsonrpc":"2.0",', 'data: "id":7,', 'data: "result":{"ok":true}}', ''].join('\n');
  const { data } = parseSseBody(body);
  assert.deepEqual(data, { jsonrpc: '2.0', id: 7, result: { ok: true } });
});

test('a non-JSON SSE frame is skipped rather than throwing', () => {
  const { events, data } = parseSseBody('data: not json\n\ndata: {"id":2}\n\n');
  assert.deepEqual(events, [{ id: 2 }]);
  assert.deepEqual(data, { id: 2 });
});

test('CRLF line endings and an empty body are handled', () => {
  const { data } = parseSseBody('data: {"id":3}\r\n\r\n');
  assert.deepEqual(data, { id: 3 });
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
