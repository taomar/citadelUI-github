#!/usr/bin/env node
/**
 * A minimal static server for the playground.
 *
 * Deliberately small: it serves two directories, answers a health/capabilities
 * probe, and — only when explicitly configured — forwards a narrow execute
 * request to an approved relay.
 *
 * Security posture:
 *   * binds 127.0.0.1 unless CITADEL_PLAYGROUND_HOST says otherwise
 *   * serves only `web/` and `src/`, with paths resolved and re-checked
 *   * sends a restrictive CSP with no inline script and no remote origins
 *   * never sends the relay token, or its presence-as-a-value, to the browser
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SERVED_ROOTS = ['web', 'src'].map((dir) => resolve(ROOT, dir));

const PORT = Number(process.env.CITADEL_PLAYGROUND_PORT ?? 4173);
const HOST = process.env.CITADEL_PLAYGROUND_HOST ?? '127.0.0.1';

/**
 * Relay configuration. The URL and the token are read here and never sent to
 * the browser: the browser only ever posts to the same-origin `/api/execute`.
 */
const RELAY_URL = process.env.CITADEL_PLAYGROUND_RELAY_URL ?? '';
const RELAY_TOKEN = process.env.CITADEL_PLAYGROUND_RELAY_TOKEN ?? '';
const RELAY_ENABLED = RELAY_URL !== '';

const MIME = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
  }),
);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cache-Control': 'no-store',
  };
}

/**
 * Resolve a request path to a file inside an allowed root, or null.
 * Exported so a test can assert traversal attempts are refused.
 */
export function resolveServedPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const requested = decoded === '/' ? '/web/index.html' : decoded;
  if (requested.includes('\0')) return null;
  const candidate = resolve(ROOT, `.${normalize(requested)}`);
  const allowed = SERVED_ROOTS.some((root) => candidate === root || candidate.startsWith(root + sep));
  return allowed ? candidate : null;
}

/** What the browser is told about execution capability. No secrets, ever. */
export function capabilitiesPayload() {
  return {
    status: 'ok',
    application: 'citadel-publish-playground',
    executor: RELAY_ENABLED
      ? {
          kind: 'relay',
          canExecute: true,
          endpoint: '/api/execute',
          supportedStepTypes: ['http', 'assertion'],
          reason: 'An approved relay is configured on the local server. It executes a fixed set of catalogue samples.',
        }
      : {
          kind: 'unavailable',
          canExecute: false,
          endpoint: null,
          supportedStepTypes: [],
          reason:
            'No execution runtime is attached. Plans are generated and previewed only; nothing is sent anywhere.',
        },
    // Presence only. The URL and the token are never disclosed.
    relayConfigured: RELAY_ENABLED,
  };
}

function send(response, status, headers, body) {
  response.writeHead(status, headers);
  response.end(body);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  send(response, status, securityHeaders('application/json; charset=utf-8'), body);
}

async function readBody(request, limitBytes = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function handleExecute(request, response) {
  if (!RELAY_ENABLED) {
    sendJson(response, 501, {
      state: 'blocked',
      summary: 'Not run — no relay is configured on this server.',
      detail:
        'Set CITADEL_PLAYGROUND_RELAY_URL (and a token if the relay needs one) to attach an approved execution relay. Without it the playground generates and previews plans only.',
    });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    sendJson(response, 400, { state: 'failed', summary: 'Malformed request body.' });
    return;
  }
  if (typeof payload?.sampleId !== 'string' || payload.sampleId === '') {
    sendJson(response, 400, { state: 'failed', summary: 'A sampleId is required.' });
    return;
  }
  // Only the three declared members are forwarded. A caller cannot smuggle a
  // URL, a header set, or a raw request through this endpoint.
  const forwarded = {
    protocolVersion: payload.protocolVersion ?? 1,
    sampleId: payload.sampleId,
    inputs: payload.inputs ?? {},
    secretRefs: Array.isArray(payload.secretRefs) ? payload.secretRefs : [],
  };
  try {
    const upstream = await fetch(RELAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(RELAY_TOKEN ? { Authorization: `Bearer ${RELAY_TOKEN}` } : {}),
      },
      body: JSON.stringify(forwarded),
    });
    const text = await upstream.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      sendJson(response, 502, {
        state: 'inconclusive',
        summary: 'The relay answered with something that is not JSON.',
        detail: 'Treating an unrecognised relay response as inconclusive rather than as a pass.',
      });
      return;
    }
    sendJson(response, upstream.ok ? 200 : 502, parsed);
  } catch (error) {
    sendJson(response, 502, {
      state: 'failed',
      summary: 'The relay could not be reached.',
      detail: String(error?.message ?? error),
    });
  }
}

async function handleStatic(request, response) {
  const filePath = resolveServedPath(request.url ?? '/');
  if (!filePath) {
    send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
      return;
    }
    const body = await readFile(filePath);
    const contentType = MIME.get(extname(filePath)) ?? 'application/octet-stream';
    send(response, 200, securityHeaders(contentType), body);
  } catch {
    send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
  }
}

export function createPlaygroundServer() {
  return createServer(async (request, response) => {
    const url = request.url ?? '/';
    if (url === '/api/health' || url === '/api/capabilities') {
      if (request.method !== 'GET') {
        sendJson(response, 405, { status: 'error', detail: 'Use GET.' });
        return;
      }
      sendJson(response, 200, capabilitiesPayload());
      return;
    }
    if (url === '/api/execute') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { state: 'failed', summary: 'Use POST.' });
        return;
      }
      await handleExecute(request, response);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, securityHeaders('text/plain; charset=utf-8'), 'Method not allowed');
      return;
    }
    await handleStatic(request, response);
  });
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const server = createPlaygroundServer();
  server.listen(PORT, HOST, () => {
    const capability = capabilitiesPayload();
    process.stdout.write(`Citadel Publish Playground: http://${HOST}:${PORT}/\n`);
    process.stdout.write(`Execution capability: ${capability.executor.kind} (canExecute=${capability.executor.canExecute})\n`);
    if (!RELAY_ENABLED) {
      process.stdout.write('No relay configured — plans are generated and previewed only.\n');
    }
  });
}

export { PORT, HOST, RELAY_ENABLED, join };
