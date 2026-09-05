/**
 * Response parsing.
 *
 * Two shapes matter and the notebook handles both:
 *   1. APIM's MCP runtime answers `initialize` / `tools/list` / `tools/call`
 *      with either `application/json` or `text/event-stream` (cell 20).
 *   2. A2A and MCP both speak JSON-RPC 2.0, where an *HTTP 200* can still
 *      carry an `error` member. The notebook's A2A cell (22) only checks the
 *      status code, so a JSON-RPC error reads as a pass there. The playground
 *      treats it as a failure, and says so in the guide.
 */

/** Read a header case-insensitively from a plain object or a Headers-like. */
export function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const viaGet = headers.get(name);
    if (viaGet !== null && viaGet !== undefined) return viaGet;
  }
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return undefined;
}

export const MAX_SSE_EVENTS = 128;

function selectJsonRpcResponse(payloads, jsonRpcId) {
  const candidates = [];
  for (const payload of payloads) {
    if (Array.isArray(payload)) candidates.push(...payload);
    else candidates.push(payload);
  }
  for (const message of candidates) {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0' ||
      !Object.prototype.hasOwnProperty.call(message, 'id') ||
      message.id !== jsonRpcId
    ) {
      continue;
    }
    const hasMethod = Object.prototype.hasOwnProperty.call(message, 'method');
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
    if (hasMethod && !hasResult && !hasError) continue;
    if (hasMethod || hasResult === hasError) return { data: null, malformed: true };
    if (hasError && (!message.error || typeof message.error !== 'object' || Array.isArray(message.error))) {
      return { data: null, malformed: true };
    }
    return { data: message, malformed: false };
  }
  return { data: null, malformed: false };
}

/** Return the id carried by an outbound JSON-RPC request, if the body is one. */
export function jsonRpcRequestId(body) {
  let parsed = body;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.jsonrpc !== '2.0' ||
    !Object.prototype.hasOwnProperty.call(parsed, 'id')
  ) {
    return undefined;
  }
  return parsed.id;
}

/**
 * Parse bounded SSE `data:` events with spec-compatible multi-line folding.
 *
 * When `jsonRpcId` is supplied, notifications and responses for unrelated ids
 * are ignored and only the matching JSON-RPC response is returned. A malformed
 * or over-limit stream is rejected as a whole.
 */
export function parseSseBody(text, options = {}) {
  const expectsJsonRpc = Object.prototype.hasOwnProperty.call(options, 'jsonRpcId');
  const maxEvents = Number.isInteger(options.maxEvents) && options.maxEvents > 0 ? options.maxEvents : MAX_SSE_EVENTS;
  const events = [];
  let buffer = [];
  let eventCount = 0;
  let malformed = false;
  let limitExceeded = false;
  const flush = () => {
    if (buffer.length === 0) return;
    const payload = buffer.join('\n');
    buffer = [];
    if (limitExceeded) return;
    eventCount += 1;
    if (eventCount > maxEvents) {
      limitExceeded = true;
      return;
    }
    try {
      events.push(JSON.parse(payload));
    } catch {
      malformed = true;
    }
  };
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue; // comment/keep-alive
    if (line.startsWith('data:')) {
      buffer.push(line.slice(5).replace(/^ /, ''));
    }
  }
  flush();
  const selection = expectsJsonRpc
    ? selectJsonRpcResponse(events, options.jsonRpcId)
    : { data: events[0] ?? null, malformed: false };
  malformed ||= selection.malformed;
  return {
    events,
    data: malformed || limitExceeded ? null : selection.data,
    malformed,
    limitExceeded,
    eventCount,
  };
}

/**
 * Normalise an HTTP response into `{ format, data, text }`.
 *
 * @param {{status?: number, headers?: object, text?: string}} response
 */
export function parseHttpResponse(response = {}, options = {}) {
  const text = typeof response.text === 'string' ? response.text : '';
  const contentType = String(readHeader(response.headers, 'content-type') ?? '');
  const expectsJsonRpc = Object.prototype.hasOwnProperty.call(options, 'jsonRpcId');
  if (contentType.includes('text/event-stream')) {
    const parsed = parseSseBody(text, options);
    return {
      format: 'sse',
      data: parsed.data,
      events: parsed.events,
      text,
      contentType,
      jsonRpc: expectsJsonRpc
        ? {
            matched: parsed.data !== null,
            malformed: parsed.malformed,
            limitExceeded: parsed.limitExceeded,
          }
        : null,
    };
  }
  if (text.trim() === '') {
    return {
      format: 'empty',
      data: null,
      events: [],
      text,
      contentType,
      jsonRpc: expectsJsonRpc ? { matched: false, malformed: false, limitExceeded: false } : null,
    };
  }
  try {
    const payload = JSON.parse(text);
    const selection = expectsJsonRpc
      ? selectJsonRpcResponse([payload], options.jsonRpcId)
      : { data: payload, malformed: false };
    const data = selection.malformed ? null : selection.data;
    return {
      format: 'json',
      data,
      events: [],
      text,
      contentType,
      jsonRpc: expectsJsonRpc
        ? { matched: data !== null, malformed: selection.malformed, limitExceeded: false }
        : null,
    };
  } catch {
    return {
      format: 'text',
      data: null,
      events: [],
      text,
      contentType,
      jsonRpc: expectsJsonRpc ? { matched: false, malformed: true, limitExceeded: false } : null,
    };
  }
}

/**
 * Classify a JSON-RPC exchange.
 *
 * An HTTP 2xx carrying `error` is a FAILURE. This is the correctness point the
 * notebook's A2A cell misses, and it is asserted by the A2A tests.
 */
export function interpretJsonRpc({ status, body } = {}) {
  const httpOk = typeof status === 'number' && status >= 200 && status < 300;
  const responseEnvelope =
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    body.jsonrpc === '2.0' &&
    Object.prototype.hasOwnProperty.call(body, 'id');
  if (!responseEnvelope) {
    return {
      outcome: httpOk ? 'inconclusive' : 'failure',
      httpOk,
      reason: httpOk
        ? 'HTTP succeeded but the body was not a valid JSON-RPC response; treat as inconclusive rather than a pass.'
        : `HTTP ${status ?? 'error'} with no JSON-RPC body.`,
      error: null,
      result: null,
    };
  }
  const hasMethod = Object.prototype.hasOwnProperty.call(body, 'method');
  const hasResult = Object.prototype.hasOwnProperty.call(body, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(body, 'error');
  const validError = hasError && body.error && typeof body.error === 'object' && !Array.isArray(body.error);
  if (hasMethod || hasResult === hasError || (hasError && !validError)) {
    return {
      outcome: httpOk ? 'inconclusive' : 'failure',
      httpOk,
      reason: httpOk
        ? 'HTTP succeeded but the JSON-RPC response envelope was malformed.'
        : `HTTP ${status ?? 'error'} carried a malformed JSON-RPC response.`,
      error: null,
      result: null,
    };
  }
  if (hasError) {
    const code = body.error?.code;
    const message = body.error?.message ?? 'JSON-RPC error';
    return {
      outcome: 'failure',
      httpOk,
      reason: httpOk
        ? `HTTP ${status} carried JSON-RPC error ${code ?? '(no code)'}: ${message}. A 2xx with a JSON-RPC error is a failure.`
        : `HTTP ${status} and JSON-RPC error ${code ?? '(no code)'}: ${message}.`,
      error: body.error,
      result: null,
    };
  }
  if (!httpOk) {
    return {
      outcome: 'failure',
      httpOk,
      reason: `HTTP ${status}.`,
      error: null,
      result: body.result ?? null,
    };
  }
  return { outcome: 'success', httpOk, reason: 'JSON-RPC result returned.', error: null, result: body.result };
}

/** Tool names from a `tools/list` result. */
export function extractToolNames(result) {
  const tools = result?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => tool?.name).filter((name) => typeof name === 'string');
}

/**
 * First textual content block from a `tools/call` result, matching the
 * notebook's `content[0]['text']` access in cell 29.
 */
export function extractToolCallText(result) {
  const content = result?.content;
  if (!Array.isArray(content) || content.length === 0) return '';
  const first = content[0];
  return typeof first?.text === 'string' ? first.text : '';
}

/**
 * The Weather mock policy returns a JSON document as MCP text content.
 * Parse it defensively; the caller decides what a missing field means.
 */
export function parseWeatherPayload(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
