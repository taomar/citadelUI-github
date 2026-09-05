/**
 * MCP request construction.
 *
 * Three details from the notebook are load-bearing and are encoded here once:
 *
 *  1. The JSON-RPC `id` must be NUMERIC. APIM's MCP runtime rejects a string id
 *     (a UUID, for instance) as "Invalid JSON payload". The notebook increments
 *     a counter on the function object; here the ids are explicit and
 *     sequential so a generated plan is reproducible.
 *  2. `initialize` returns an `Mcp-Session-Id` response header that every
 *     subsequent call on that session must echo back.
 *  3. `Accept` lists both `application/json` and `text/event-stream`, so the
 *     response parser has to handle either.
 */

import { MCP_ACCEPT, MCP_PROTOCOL_VERSION, MCP_SESSION_HEADER } from './types.mjs';
import { secretRef } from './secrets.mjs';
import { step } from './plan.mjs';

export const MCP_CLIENT_INFO = Object.freeze({ name: 'citadel-validation', version: '1.0' });

export function mcpHeaders({ apiKeyHeader = 'api-key', sessionBinding = null } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: MCP_ACCEPT,
    [apiKeyHeader]: secretRef('gatewayAccess.apiKey', { label: 'Access-contract api-key' }),
  };
  if (sessionBinding) headers[MCP_SESSION_HEADER] = sessionBinding;
  return headers;
}

export function mcpPayload({ id, method, params }) {
  if (!Number.isInteger(id)) {
    throw new TypeError('MCP JSON-RPC id must be an integer — APIM rejects string ids.');
  }
  const payload = { jsonrpc: '2.0', id, method };
  if (params !== undefined) payload.params = params;
  return payload;
}

export function initializeParams({ clientInfo = MCP_CLIENT_INFO } = {}) {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { ...clientInfo },
  };
}

/**
 * The `initialize` step. It produces `sessionId`, captured from the response
 * header, which the follow-up step consumes.
 */
export function mcpInitializeStep({
  id = 'mcp-initialize',
  endpoint,
  apiKeyHeader = 'api-key',
  clientInfo = MCP_CLIENT_INFO,
  jsonRpcId = 1,
  title = 'MCP initialize',
  detail = 'Opens the MCP session. The response header carries the session id every later call must echo.',
} = {}) {
  return step.http({
    id,
    title,
    detail,
    request: {
      method: 'POST',
      url: endpoint,
      headers: mcpHeaders({ apiKeyHeader }),
      body: mcpPayload({ id: jsonRpcId, method: 'initialize', params: initializeParams({ clientInfo }) }),
      accepts: ['application/json', 'text/event-stream'],
      capture: {
        sessionId: `response.headers['${MCP_SESSION_HEADER}']`,
        status: 'response.status',
        result: 'response.jsonrpc.result',
      },
      timeoutSeconds: 60,
    },
    produces: ['sessionId', 'status', 'result'],
  });
}

/** A follow-up MCP call bound to the session opened by `initializeStepId`. */
export function mcpCallStep({
  id,
  endpoint,
  method,
  params,
  jsonRpcId,
  apiKeyHeader = 'api-key',
  initializeStepId = 'mcp-initialize',
  title,
  detail,
  produces = ['status', 'result'],
}) {
  return step.http({
    id,
    title: title ?? `MCP ${method}`,
    detail: detail ?? `Sent on the session opened by \`${initializeStepId}\`.`,
    request: {
      method: 'POST',
      url: endpoint,
      headers: mcpHeaders({
        apiKeyHeader,
        sessionBinding: `{{steps.${initializeStepId}.sessionId}}`,
      }),
      body: mcpPayload({ id: jsonRpcId, method, params }),
      accepts: ['application/json', 'text/event-stream'],
      capture: {
        status: 'response.status',
        result: 'response.jsonrpc.result',
        error: 'response.jsonrpc.error',
      },
      timeoutSeconds: 60,
    },
    produces,
  });
}

/** Shared expectation text so every MCP assertion says the same thing. */
export function mcpHandshakeExpectations(label) {
  return [
    `${label}: \`initialize\` returns an HTTP 2xx.`,
    'The body is a JSON-RPC response with a `result` member and no `error` member — an HTTP 2xx carrying `error` is a failure.',
    `A \`${MCP_SESSION_HEADER}\` response header is present and is echoed on the follow-up call.`,
    'The body parses as JSON, or as the bounded `text/event-stream` response whose JSON-RPC id matches the request.',
  ];
}
