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

/**
 * Parse an SSE body, returning the first `data:` line that is valid JSON.
 * Mirrors the notebook's `mcp_call` loop, including its "first wins" rule, and
 * additionally supports multi-line `data:` folding from the SSE spec.
 */
export function parseSseBody(text) {
  const events = [];
  let buffer = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const payload = buffer.join('\n');
    buffer = [];
    try {
      events.push(JSON.parse(payload));
    } catch {
      /* a non-JSON data frame is ignored, exactly as the notebook does */
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
  return { events, data: events.length > 0 ? events[0] : null };
}

/**
 * Normalise an HTTP response into `{ format, data, text }`.
 *
 * @param {{status?: number, headers?: object, text?: string}} response
 */
export function parseHttpResponse(response = {}) {
  const text = typeof response.text === 'string' ? response.text : '';
  const contentType = String(readHeader(response.headers, 'content-type') ?? '');
  if (contentType.includes('text/event-stream')) {
    const { events, data } = parseSseBody(text);
    return { format: 'sse', data, events, text, contentType };
  }
  if (text.trim() === '') {
    return { format: 'empty', data: null, events: [], text, contentType };
  }
  try {
    return { format: 'json', data: JSON.parse(text), events: [], text, contentType };
  } catch {
    return { format: 'text', data: null, events: [], text, contentType };
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
  if (!body || typeof body !== 'object') {
    return {
      outcome: httpOk ? 'inconclusive' : 'failure',
      httpOk,
      reason: httpOk
        ? 'HTTP succeeded but the body was not a JSON-RPC object; treat as inconclusive rather than a pass.'
        : `HTTP ${status ?? 'error'} with no JSON-RPC body.`,
      error: null,
      result: null,
    };
  }
  if (Object.prototype.hasOwnProperty.call(body, 'error') && body.error) {
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
  if (!Object.prototype.hasOwnProperty.call(body, 'result')) {
    return {
      outcome: 'inconclusive',
      httpOk,
      reason: 'HTTP 2xx JSON-RPC response contained neither `result` nor `error`.',
      error: null,
      result: null,
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
