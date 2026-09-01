/**
 * Container-owned Citadel UI server.
 *
 * The browser owns every handle to Citadel source. This process serves the
 * packaged application, performs content-only transformations, and stores
 * transaction journals and backup bytes under CITADEL_DATA_ROOT. It never
 * discovers, opens, or writes a host workspace.
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyEdits } from './bicepparam/edit.mjs';
import { nodeToValue, parseBicepParam } from './bicepparam/parser.mjs';
import { buildOutline } from './doclayer.mjs';
import { TransactionStore, transactionError } from './transactions.mjs';
import { RegistryStore } from './registry-store.mjs';
import {
  applyPolicyChanges,
  CONTENT_SAFETY_CATEGORIES,
  CONTENT_SAFETY_OUTPUT_TYPES,
  POLICY_VARIABLES,
  readPolicyControls,
  SEMANTIC_CACHE_SPEC,
  THROTTLE_SPECS,
} from '../shared/policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = resolve(here, '..', 'web');
const DEFAULT_SHARED_ROOT = resolve(here, '..', 'shared');
const DEFAULT_DATA_ROOT = resolve(process.env.CITADEL_DATA_ROOT || '/data');
const DEFAULT_PORT = Number(process.env.CITADEL_UI_PORT || 4173);
const DEFAULT_LISTEN_HOST = process.env.CITADEL_UI_HOST || '0.0.0.0';
const PRODUCTION_ALLOWED_HOST = '127.0.0.1:4173';
const PRODUCTION_CONTAINER_DATA_ROOT = resolve('/data');
const PRODUCTION_CHECKOUT_DATA_ROOT = resolve(here, '..', '.data');
const DEFAULT_ALLOWED_HOST = process.env.CITADEL_ALLOWED_HOST || PRODUCTION_ALLOWED_HOST;
const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const BACKUP_BODY_LIMIT = 32 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
].join('; ');

function securityHeaders(correlationId) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Correlation-ID': correlationId,
  };
}

function sendJson(res, status, body, correlationId, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(correlationId),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendEmpty(res, status, correlationId, extraHeaders = {}) {
  res.writeHead(status, { ...securityHeaders(correlationId), ...extraHeaders });
  res.end();
}

function safeCorrelationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value)
    ? value
    : randomUUID();
}

function sameToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertBrowserRequest(req, allowedHost, allowedOrigin, sessionToken, stateChanging) {
  if (req.headers.host !== allowedHost) {
    throw transactionError(421, 'INVALID_HOST', 'Request host is not allowed.');
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw transactionError(403, 'INVALID_FETCH_SITE', 'Request site is not allowed.');
  }
  if (!sameToken(req.headers['x-citadel-session'], sessionToken)) {
    throw transactionError(401, 'INVALID_SESSION', 'Invalid session token.');
  }
  if (stateChanging && req.headers.origin !== allowedOrigin) {
    throw transactionError(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
  }
}

async function readLimitedBody(req, limit, json) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw transactionError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  }
  if (json) {
    const mediaType = String(req.headers['content-type'] || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (mediaType !== 'application/json') {
      throw transactionError(415, 'JSON_REQUIRED', 'POST requests require application/json.');
    }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw transactionError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!json) return bytes;
  if (!bytes.length) throw transactionError(400, 'JSON_REQUIRED', 'A JSON body is required.');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw transactionError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
}

function contentDocument(alias, text) {
  if (typeof alias !== 'string' || typeof text !== 'string') {
    throw transactionError(400, 'INVALID_CONTENT', 'Alias and text are required.');
  }
  const doc = parseBicepParam(text);
  const outline = buildOutline(text, doc.params);
  return {
    alias,
    size: Buffer.byteLength(text),
    using: doc.using?.path || null,
    outline,
    params: doc.params.map((parameter) => ({
      name: parameter.name,
      kind: parameter.value.kind,
      value: nodeToValue(parameter.value),
      raw: text.slice(parameter.value.start, parameter.value.end),
      span: { start: parameter.value.start, end: parameter.value.end },
      doc: outline.paramDocs[parameter.name] || null,
    })),
  };
}

function policyDefinitions() {
  return {
    variables: POLICY_VARIABLES,
    throttles: THROTTLE_SPECS,
    semanticCache: SEMANTIC_CACHE_SPEC,
    contentSafety: {
      categories: CONTENT_SAFETY_CATEGORIES,
      outputTypes: CONTENT_SAFETY_OUTPUT_TYPES,
    },
  };
}

function assertBodyKeys(body, allowed) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.has(key))
  ) {
    throw transactionError(400, 'INVALID_CONTENT', 'Request contains unsupported fields.');
  }
}

function injectBootstrapMetadata(html, token, registryNamespace, testRuntime) {
  const meta = [
    `<meta name="citadel-session" content="${token}" />`,
    `<meta name="citadel-registry-namespace" content="${registryNamespace}" />`,
    `<meta name="citadel-test-runtime" content="${testRuntime ? 'true' : 'false'}" />`,
  ].join('\n    ');
  return html.includes('<meta charset=')
    ? html.replace(/(<meta charset=[^>]+>)/i, `$1\n    ${meta}`)
    : html.replace(/<head>/i, `<head>\n    ${meta}`);
}

function staticPath(webRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw transactionError(400, 'INVALID_PATH', 'Invalid URL path.');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw transactionError(400, 'INVALID_PATH', 'Invalid URL path.');
  }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = resolve(webRoot, rel);
  const fromRoot = relative(webRoot, target);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw transactionError(403, 'FORBIDDEN_PATH', 'Static path is outside the application.');
  }
  return target;
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean);
}

function requireQuery(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw transactionError(400, 'MISSING_QUERY', `Missing ${name}.`);
  return value;
}

async function handleApi(context) {
  const {
    req,
    res,
    url,
    correlationId,
    store,
    registryStore,
    allowedHost,
    allowedOrigin,
    sessionToken,
  } = context;
  const stateChanging = req.method !== 'GET' && req.method !== 'HEAD';
  assertBrowserRequest(req, allowedHost, allowedOrigin, sessionToken, stateChanging);

  if (!['GET', 'POST', 'PUT'].includes(req.method)) {
    return sendJson(
      res,
      405,
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', correlationId } },
      correlationId,
      { Allow: 'GET, POST, PUT' }
    );
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'citadel-ui' }, correlationId);
  }

  if (req.method === 'GET' && url.pathname === '/api/registry') {
    return sendJson(res, 200, await registryStore.read(), correlationId);
  }

  if (req.method === 'PUT' && url.pathname === '/api/registry') {
    const body = await readLimitedBody(req, context.jsonBodyLimit, true);
    assertBodyKeys(
      body,
      new Set([
        'expectedEpoch',
        'expectedRevision',
        'projects',
        'environments',
        'removedProjectIds',
        'removedEnvironmentIds',
      ])
    );
    return sendJson(res, 200, await registryStore.reconcile(body), correlationId);
  }

  if (req.method === 'POST' && url.pathname === '/api/content/bicepparam/parse') {
    const body = await readLimitedBody(req, context.jsonBodyLimit, true);
    return sendJson(res, 200, contentDocument(body.alias, body.text), correlationId);
  }

  if (req.method === 'POST' && url.pathname === '/api/content/bicepparam/preview') {
    const body = await readLimitedBody(req, context.jsonBodyLimit, true);
    if (typeof body.alias !== 'string' || typeof body.text !== 'string' || !Array.isArray(body.operations)) {
      throw transactionError(400, 'INVALID_CONTENT', 'Alias, text, and operations are required.');
    }
    const text = applyEdits(body.text, body.operations);
    return sendJson(res, 200, { text, document: contentDocument(body.alias, text) }, correlationId);
  }

  if (req.method === 'GET' && url.pathname === '/api/core/policy/specs') {
    return sendJson(res, 200, policyDefinitions(), correlationId);
  }

  if (req.method === 'POST' && url.pathname === '/api/core/policy/read') {
    const body = await readLimitedBody(req, context.jsonBodyLimit, true);
    assertBodyKeys(body, new Set(['text']));
    if (typeof body.text !== 'string') {
      throw transactionError(400, 'INVALID_CONTENT', 'Policy text is required.');
    }
    return sendJson(res, 200, { controls: readPolicyControls(body.text) }, correlationId);
  }

  if (req.method === 'POST' && url.pathname === '/api/core/policy/apply') {
    const body = await readLimitedBody(req, context.jsonBodyLimit, true);
    assertBodyKeys(body, new Set(['text', 'changes']));
    if (
      typeof body.text !== 'string' ||
      !body.changes ||
      typeof body.changes !== 'object' ||
      Array.isArray(body.changes)
    ) {
      throw transactionError(400, 'INVALID_CONTENT', 'Policy text and a changes object are required.');
    }
    const text = applyPolicyChanges(body.text, body.changes);
    return sendJson(
      res,
      200,
      {
        text,
        controls: readPolicyControls(text),
      },
      correlationId
    );
  }

  if (req.method === 'POST' && url.pathname === '/api/transactions/prepare') {
    const body = await readLimitedBody(req, context.jsonBodyLimit, true);
    return sendJson(res, 201, await store.prepare(body), correlationId);
  }

  if (req.method === 'GET' && url.pathname === '/api/transactions') {
    const environmentId = requireQuery(url, 'environmentId');
    const transactions = await store.history(environmentId, {
      targetId: url.searchParams.get('targetId'),
      limit: url.searchParams.get('limit'),
    });
    return sendJson(res, 200, { transactions }, correlationId);
  }

  const parts = routeParts(url.pathname);
  if (parts[0] !== 'api' || parts[1] !== 'transactions' || !parts[2]) {
    throw transactionError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
  }
  const transactionId = parts[2];
  const environmentId =
    req.method === 'GET' ? requireQuery(url, 'environmentId') : req.headers['x-citadel-environment'];
  if (typeof environmentId !== 'string' || !environmentId) {
    throw transactionError(400, 'MISSING_ENVIRONMENT', 'Environment id is required.');
  }
  const transactionToken = req.headers['x-citadel-transaction'];
  const authorizationToken = req.headers['x-citadel-authorization'];
  const backupReadToken = req.headers['x-citadel-backup-read'];

  if (req.method === 'GET' && parts.length === 3) {
    return sendJson(res, 200, { transaction: await store.getTransaction(environmentId, transactionId) }, correlationId);
  }

  if (req.method === 'GET' && parts[3] === 'backups' && parts[4] && parts.length === 5) {
    const backup = backupReadToken
      ? await store.getBackupForRestore(
          environmentId,
          transactionId,
          parts[4],
          backupReadToken
        )
      : await store.getBackup(environmentId, transactionId, parts[4], transactionToken);
    res.writeHead(200, {
      ...securityHeaders(correlationId),
      'Content-Type': 'application/octet-stream',
      'Content-Length': backup.bytes.length,
      'X-Citadel-File-ID': backup.metadata.fileId,
      'X-Citadel-Content-SHA256': backup.metadata.hash,
    });
    return res.end(backup.bytes);
  }

  if (req.method === 'PUT' && parts[3] === 'backups' && parts[4] && parts.length === 5) {
    const mediaType = String(req.headers['content-type'] || '').split(';', 1)[0].toLowerCase();
    if (mediaType !== 'application/octet-stream') {
      throw transactionError(415, 'BINARY_REQUIRED', 'Backup uploads require application/octet-stream.');
    }
    const bytes = await readLimitedBody(req, context.backupBodyLimit, false);
    const result = await store.uploadBackup(
      environmentId,
      transactionId,
      parts[4],
      transactionToken,
      req.headers['x-citadel-content-sha256'],
      bytes
    );
    return sendJson(res, 200, result, correlationId);
  }

  if (req.method !== 'POST' || parts.length !== 4) {
    throw transactionError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
  }
  const action = parts[3];
  const body = await readLimitedBody(req, context.jsonBodyLimit, true);
  let result;
  if (action === 'authorize') {
    result = await store.authorize(environmentId, transactionId, transactionToken);
  } else if (action === 'recover') {
    assertBodyKeys(body, new Set());
    result = await store.recover(environmentId, transactionId);
  } else if (action === 'restore-token') {
    assertBodyKeys(body, new Set());
    result = await store.issueRestoreToken(environmentId, transactionId);
  } else if (action === 'revert') {
    assertBodyKeys(body, new Set());
    result = await store.beginRevert(environmentId, transactionId);
  } else if (action === 'committing') {
    result = await store.beginCommit(environmentId, transactionId, authorizationToken, body);
  } else if (action === 'receipt') {
    result = await store.commitReceipt(environmentId, transactionId, authorizationToken, body);
  } else if (action === 'fail') {
    result = await store.fail(environmentId, transactionId, transactionToken, body);
  } else if (action === 'abandon') {
    result = await store.abandon(environmentId, transactionId, transactionToken);
  } else if (action === 'rollback') {
    result = await store.rollback(environmentId, transactionId, transactionToken, body);
  } else if (action === 'lease') {
    result = await store.renewLease(environmentId, transactionId, transactionToken);
  } else {
    throw transactionError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
  }
  return sendJson(res, 200, result, correlationId);
}

async function serveStatic(context) {
  const { req, res, url, correlationId, webRoot, sharedRoot, bootstrapHtml } = context;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendEmpty(res, 405, correlationId, { Allow: 'GET, HEAD' });
  }
  const sharedRequest = url.pathname === '/shared' || url.pathname.startsWith('/shared/');
  if (sharedRequest && (url.pathname === '/shared' || url.pathname === '/shared/')) {
    throw transactionError(404, 'STATIC_NOT_FOUND', 'Static asset not found.');
  }
  const root = sharedRequest ? sharedRoot : webRoot;
  const pathname = sharedRequest ? url.pathname.slice('/shared'.length) : url.pathname;
  const target = staticPath(root, pathname);
  let body;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    body =
      !sharedRequest && target === resolve(webRoot, 'index.html')
        ? bootstrapHtml
        : await readFile(target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const payload = Buffer.from('Not found');
      res.writeHead(404, {
        ...securityHeaders(correlationId),
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': payload.length,
      });
      return req.method === 'HEAD' ? res.end() : res.end(payload);
    }
    throw error;
  }
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(200, {
    ...securityHeaders(correlationId),
    'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': bytes.length,
  });
  return req.method === 'HEAD' ? res.end() : res.end(bytes);
}

export async function createCitadelServer(options = {}) {
  if (process.env.NODE_TEST_CONTEXT && !options.dataRoot) {
    throw new Error('Tests must provide an isolated dataRoot.');
  }
  const webRoot = resolve(options.webRoot || DEFAULT_WEB_ROOT);
  const sharedRoot = resolve(options.sharedRoot || DEFAULT_SHARED_ROOT);
  const dataRoot = resolve(options.dataRoot || DEFAULT_DATA_ROOT);
  const allowedHost = options.allowedHost || DEFAULT_ALLOWED_HOST;
  const allowedOrigin = options.allowedOrigin || `http://${allowedHost}`;
  const registryNamespace =
    options.registryNamespace || process.env.CITADEL_REGISTRY_NAMESPACE || 'citadel-ui';
  const testRuntime =
    options.testRuntime ?? process.env.CITADEL_TEST_RUNTIME === 'true';
  const testExecution = Boolean(process.env.NODE_TEST_CONTEXT) || testRuntime;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(registryNamespace)) {
    throw new Error('Invalid Citadel registry namespace.');
  }
  if (
    testExecution &&
    (dataRoot === PRODUCTION_CONTAINER_DATA_ROOT || dataRoot === PRODUCTION_CHECKOUT_DATA_ROOT)
  ) {
    throw new Error('Tests and QA must not use a production Citadel data root.');
  }
  if (
    testRuntime &&
    (registryNamespace === 'citadel-ui' || allowedHost === PRODUCTION_ALLOWED_HOST)
  ) {
    throw new Error('QA requires an isolated origin and registry namespace.');
  }
  const sessionToken = options.sessionToken || randomBytes(32).toString('base64url');
  const maxConcurrency = options.maxConcurrency ?? 32;
  const store = options.store || new TransactionStore({ dataRoot, ...(options.transactionOptions || {}) });
  const registryStore = options.registryStore || new RegistryStore({ dataRoot });
  await store.initialize();
  await registryStore.initialize();
  const indexHtml = await readFile(resolve(webRoot, 'index.html'), 'utf8');
  const bootstrapHtml = injectBootstrapMetadata(
    indexHtml,
    sessionToken,
    registryNamespace,
    testRuntime
  );
  let active = 0;

  const server = createServer(async (req, res) => {
    const correlationId = safeCorrelationId(req.headers['x-correlation-id']);
    if (active >= maxConcurrency) {
      return sendJson(
        res,
        503,
        { error: { code: 'SERVER_BUSY', message: 'Server concurrency limit reached.', correlationId } },
        correlationId,
        { 'Retry-After': '1' }
      );
    }
    active += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active -= 1;
      }
    };
    res.once('finish', release);
    res.once('close', release);

    try {
      if (req.headers.host !== allowedHost) {
        throw transactionError(421, 'INVALID_HOST', 'Request host is not allowed.');
      }
      const url = new URL(req.url || '/', allowedOrigin);
      if (url.pathname === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendEmpty(res, 405, correlationId, { Allow: 'GET, HEAD' });
        }
        return sendJson(res, 200, { ok: true }, correlationId);
      }
      const context = {
        req,
        res,
        url,
        correlationId,
        webRoot,
        sharedRoot,
        bootstrapHtml,
        store,
        registryStore,
        allowedHost,
        allowedOrigin,
        sessionToken,
        jsonBodyLimit: options.jsonBodyLimit ?? JSON_BODY_LIMIT,
        backupBodyLimit: options.backupBodyLimit ?? BACKUP_BODY_LIMIT,
      };
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return await handleApi(context);
      }
      return await serveStatic(context);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = Number.isInteger(error.status) ? error.status : 500;
      const code = error.code && status < 500 ? error.code : 'INTERNAL_ERROR';
      const message = status < 500 ? error.message : 'Internal server error.';
      if (status >= 500) {
        // Correlation and error class only: never log paths, bodies, source text, or tokens.
        console.error(
          JSON.stringify({
            event: 'request_error',
            correlationId,
            status,
            errorType: error?.constructor?.name || 'Error',
          })
        );
      }
      return sendJson(
        res,
        status,
        { error: { code, message, correlationId } },
        correlationId,
        status === 413 ? { Connection: 'close' } : {}
      );
    }
  });
  server.headersTimeout = options.headersTimeout ?? 10_000;
  server.requestTimeout = options.requestTimeout ?? 30_000;
  server.keepAliveTimeout = options.keepAliveTimeout ?? 5_000;

  return { server, store, registryStore };
}

export async function startCitadelServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host || DEFAULT_LISTEN_HOST;
  const created = await createCitadelServer(options);
  await new Promise((resolveListen, rejectListen) => {
    created.server.once('error', rejectListen);
    created.server.listen(port, host, () => {
      created.server.off('error', rejectListen);
      resolveListen();
    });
  });
  console.log(JSON.stringify({ event: 'citadel_ui_started', status: 'ready' }));
  return created;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startCitadelServer().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'citadel_ui_start_failed',
        status: 'failed',
        errorType: error?.constructor?.name || 'Error',
      })
    );
    process.exitCode = 1;
  });
}
