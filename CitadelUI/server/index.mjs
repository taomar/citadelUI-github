/**
 * Container-owned Citadel UI server.
 *
 * The browser owns every handle to Citadel source. This process serves the
 * packaged application, performs content-only transformations, and stores
 * transaction journals, backup bytes and explicitly captured migration sources
 * under CITADEL_DATA_ROOT. It never
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
import { ConnectionProfileStore } from './connections.mjs';
import { CredentialVault } from './credentials.mjs';
import { OwnerAccount } from './owner.mjs';
import { ActivityStore, ACTIVITY_ACTIONS } from './activity.mjs';
import { MigrationSnapshotStore } from './migration-snapshots.mjs';
import { MigrationError } from '../shared/migration-input.mjs';
import { SNAPSHOT_ENDPOINT, SNAPSHOT_LIMITS } from '../shared/migration-snapshot.mjs';
import { GitHubRoutes } from './github/routes.mjs';
import { GitHubAuditStore } from './github/audit.mjs';
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
/**
 * GitHub commit bodies carry base64-encoded sources, so the advertised 8 MiB
 * source limit needs roughly 4/3 for base64 plus JSON framing. Without this the
 * transport would reject a file the product says it supports. The aggregate
 * decoded size stays bounded by the per-file and per-change-set limits enforced
 * in the change-set validator.
 */
const GITHUB_COMMIT_BODY_LIMIT = 12 * 1024 * 1024;

/**
 * The activity actions a browser may append.
 *
 * Opening and detaching a workspace happen entirely in the browser, so the
 * server would otherwise never learn of them. Everything a credential touches is
 * recorded server-side instead, where it cannot be forged or omitted — a browser
 * cannot claim a connection was created, reconnected or persisted.
 */
const CLIENT_ACTIVITY_ACTIONS = new Set(
  ['environment.open', 'repository.detach', 'validation.failure'].filter((action) =>
    Object.hasOwn(ACTIVITY_ACTIONS, action)
  )
);

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

/**
 * Decide the one origin a state-changing request may carry.
 *
 * Until this deployment the answer could simply be derived: the server only ever
 * ran on loopback, so the origin was `http://` plus the host it already
 * enforced. Behind a Container Apps ingress that derivation is wrong. TLS is
 * terminated at the edge, so the browser sends `https://<fqdn>` while the
 * derived value still says `http://`, and the exact-match in
 * `assertBrowserRequest` then rejects every write with 403.
 *
 * That failure is worth naming, because it is the nastiest shape available: the
 * page loads, the health probe passes, the container reports healthy, and only
 * saving fails. "Looks fine, is broken" costs far more to diagnose than a
 * container that refuses to start.
 *
 * So the origin becomes configurable — and *only* configurable. The comparison
 * stays an exact string match. There is no prefix matching, no scheme-agnostic
 * compare and no wildcard here, because each of those would turn a control that
 * answers "yes or no" into one that answers "probably".
 *
 * A path, query, fragment or embedded credential is refused outright rather than
 * trimmed. An `Origin` header never contains any of them, so a value carrying
 * one cannot match anything, and quietly repairing it would hide the operator's
 * mistake behind the same silent-write-failure this exists to prevent.
 */
export function resolveAllowedOrigin(explicit, allowedHost, env = process.env) {
  const configured = (explicit || env.CITADEL_ALLOWED_ORIGIN || '').trim();
  if (!configured) return `http://${allowedHost}`;
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('Invalid Citadel allowed origin.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid Citadel allowed origin.');
  }
  return url.origin;
}

/**
 * The checks that qualify a request as coming from this application's own page,
 * independent of who is signed in.
 *
 * Split out from the session check because the owner claim and sign-in routes
 * have to be reachable before a session token exists, and they must not become
 * a hole in everything else while they are. They still have to arrive on the
 * right host, from a same-origin fetch, and — when they change state — carry the
 * exact allowed origin. Only the token check is skipped, because the token is
 * precisely what those two routes exist to issue.
 */
function assertBrowserTransport(req, allowedHost, allowedOrigin, stateChanging) {
  if (req.headers.host !== allowedHost) {
    throw transactionError(421, 'INVALID_HOST', 'Request host is not allowed.');
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw transactionError(403, 'INVALID_FETCH_SITE', 'Request site is not allowed.');
  }
  if (stateChanging && req.headers.origin !== allowedOrigin) {
    throw transactionError(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
  }
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

/**
 * What the page is told before anyone has signed in.
 *
 * This used to carry the session token, which meant every `GET /` handed a
 * working API credential to whoever asked. That was defensible while the server
 * only ever answered on loopback and indefensible the moment it was published,
 * and it is the specific thing the owner credential replaces.
 *
 * The token is no longer here at all. It is returned in the JSON response to a
 * successful claim or sign-in and nowhere else, so an unauthenticated request
 * cannot obtain one by reading the markup. What is left is the authentication
 * state, which the page needs in order to know whether to offer "create the
 * owner" or "sign in" — and which reveals nothing beyond whether this container
 * has been claimed.
 */
function injectBootstrapMetadata(html, authState, registryNamespace, testRuntime) {
  const meta = [
    `<meta name="citadel-auth" content="${authState}" />`,
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

/**
 * Claim the container, or sign in to it.
 *
 * Three routes, and the set is closed on purpose. `GET /api/owner` reports
 * whether this container has been claimed, which is what the page needs to
 * decide between offering "create the owner" and "sign in". The two POSTs are
 * the only ways a session token is ever issued.
 *
 * What is absent is the point: no route updates the credential, no route deletes
 * it, and no route creates a second one. Resetting a forgotten password means
 * redeploying with fresh state — the honest operation for a container whose
 * identity is one file — rather than a route that would have to be defended.
 */
async function handleOwnerApi(context) {
  const { req, res, url, correlationId, ownerAccount, sessionToken } = context;

  if (url.pathname === '/api/owner') {
    if (req.method !== 'GET') {
      return sendJson(
        res,
        405,
        { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', correlationId } },
        correlationId,
        { Allow: 'GET' }
      );
    }
    // A corrupt record throws 503 from here rather than reporting "unclaimed",
    // so a damaged volume never invites a fresh claim on a live deployment.
    const state = await ownerAccount.read();
    return sendJson(res, 200, { state: state.state }, correlationId);
  }

  const claiming = url.pathname === '/api/owner/claim';
  const signingIn = url.pathname === '/api/owner/session';
  if (!claiming && !signingIn) {
    throw transactionError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
  }
  if (req.method !== 'POST') {
    return sendJson(
      res,
      405,
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', correlationId } },
      correlationId,
      { Allow: 'POST' }
    );
  }

  const body = await readLimitedBody(req, context.jsonBodyLimit, true);
  assertBodyKeys(body, new Set(['username', 'password']));

  if (claiming) {
    await ownerAccount.claim(body.username, body.password);
    // The token is handed over exactly once here and never appears in the
    // markup, so possession of it is the proof of ownership from now on.
    return sendJson(res, 201, { state: 'claimed', sessionToken }, correlationId);
  }

  await ownerAccount.verify(body.username, body.password);
  return sendJson(res, 200, { state: 'claimed', sessionToken }, correlationId);
}

async function handleApi(context) {
  const {
    req,
    res,
    url,
    correlationId,
    store,
    registryStore,
    activityStore,
    allowedHost,
    allowedOrigin,
    sessionToken,
  } = context;
  const stateChanging = req.method !== 'GET' && req.method !== 'HEAD';

  /**
   * The owner routes, dispatched before the session check.
   *
   * They have to be, because they are how a session token is obtained: applying
   * the token check to them would make signing in require being signed in. Every
   * other guard still applies — `assertBrowserTransport` enforces the exact
   * host, the fetch site and, for the two POSTs, the exact origin — so this is a
   * narrower door, not an unguarded one.
   *
   * The route table is the enforcement. There is no route that creates a second
   * account and none that resets a password, so neither can be reached by
   * guessing a method or a path; anything under `/api/owner` that is not one of
   * these three falls through to the 404 below.
   */
  if (url.pathname === '/api/owner' || url.pathname.startsWith('/api/owner/')) {
    assertBrowserTransport(req, allowedHost, allowedOrigin, stateChanging);
    return await handleOwnerApi(context);
  }

  assertBrowserRequest(req, allowedHost, allowedOrigin, sessionToken, stateChanging);

  // GitHub routes own their own method set (they need DELETE to disconnect), so
  // they are dispatched before the method allow-list that governs every other
  // API route. That list stays exactly as narrow as it was.
  if (url.pathname === '/api/github' || url.pathname.startsWith('/api/github/')) {
    if (!context.githubRoutes) {
      throw transactionError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
    }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      return sendJson(
        res,
        405,
        { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', correlationId } },
        correlationId,
        { Allow: 'GET, POST, DELETE' }
      );
    }
    const result = await context.githubRoutes.handle({
      req,
      url,
      parts: routeParts(url.pathname),
      readBody: () =>
        readLimitedBody(
          req,
          // Only the routes that carry encoded source get the larger ceiling.
          /\/(commits|reverts)$/.test(url.pathname)
            ? context.githubCommitBodyLimit
            : context.jsonBodyLimit,
          true
        ),
    });
    return sendJson(res, 200, result, correlationId);
  }

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

  if (url.pathname === SNAPSHOT_ENDPOINT || url.pathname.startsWith(`${SNAPSHOT_ENDPOINT}/`)) {
    const parts = routeParts(url.pathname).slice(2);
    const snapshots = context.snapshotStore;
    try {
      let result;
      if (req.method === 'GET' && !parts.length) result = { sources: await snapshots.list() };
      else if (req.method === 'POST' && !parts.length) {
        result = await snapshots.begin(await readLimitedBody(req, SNAPSHOT_LIMITS.metadataBytes, true));
      } else if (req.method === 'GET' && parts.length === 1) result = await snapshots.get(parts[0]);
      else if (req.method === 'GET' && parts.length === 3 && parts[1] === 'files') {
        const file = await snapshots.read(parts[0], parts[2]);
        res.writeHead(200, {
          ...securityHeaders(correlationId), 'Content-Type': 'application/octet-stream',
          'Content-Length': file.bytes.length, 'X-Citadel-Content-SHA256': file.hash,
        });
        return res.end(file.bytes);
      } else if (req.method === 'PUT' && parts.length === 3 && parts[1] === 'files') {
        if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/octet-stream') {
          throw transactionError(415, 'BINARY_REQUIRED', 'Source uploads require application/octet-stream.');
        }
        result = await snapshots.upload(parts[0], parts[2], req.headers['x-citadel-content-sha256'],
          await readLimitedBody(req, SNAPSHOT_LIMITS.bytes, false));
      } else if (req.method === 'POST' && parts.length === 2 && ['complete', 'delete'].includes(parts[1])) {
        assertBodyKeys(await readLimitedBody(req, context.jsonBodyLimit, true), new Set());
        result = await snapshots[parts[1]](parts[0]);
      } else throw transactionError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
      return sendJson(res, 200, result, correlationId);
    } catch (error) {
      if (error instanceof MigrationError) throw transactionError(409, error.code, error.message);
      throw error;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/registry') {
    return sendJson(res, 200, await registryStore.read(), correlationId);
  }

  /**
   * Workspace governance activity.
   *
   * The browser may append, because opening and detaching a workspace happen
   * entirely in the browser and the server never learns of them otherwise. What
   * it may append is deliberately narrow: an action from the fixed vocabulary,
   * an outcome, and names the user themselves chose. There is no free-text
   * field, so nothing a caller holds — a path, a parameter, a credential — has a
   * place to travel in.
   */
  if (req.method === 'GET' && url.pathname === '/api/activity') {
    if (!activityStore) throw transactionError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
    const requested = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
    return sendJson(res, 200, { events: await activityStore.list(limit) }, correlationId);
  }

  if (req.method === 'POST' && url.pathname === '/api/activity') {
    if (!activityStore) throw transactionError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
    const body = await readLimitedBody(req, context.jsonBodyLimit, true);
    assertBodyKeys(body, new Set(['action', 'outcome', 'reason', 'target', 'account']));
    if (!CLIENT_ACTIVITY_ACTIONS.has(String(body.action))) {
      throw transactionError(400, 'INVALID_ACTIVITY_ACTION', 'That activity action is not accepted.');
    }
    const event = await activityStore.record({ ...body, origin: 'client' });
    return sendJson(res, 200, { recorded: Boolean(event), event }, correlationId);
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
  const { req, res, url, correlationId, webRoot, sharedRoot, bootstrapFor } = context;
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
        ? await bootstrapFor()
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
  const allowedOrigin = resolveAllowedOrigin(options.allowedOrigin, allowedHost);
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
  const connectionStore = options.connectionStore || new ConnectionProfileStore({ dataRoot });
  const activityStore = options.activityStore || new ActivityStore({ dataRoot });
  const snapshotStore = options.snapshotStore || new MigrationSnapshotStore({ dataRoot, ...(options.snapshotOptions || {}) });
  // The key is read from a path, never from an environment value: a variable is
  // visible in `docker inspect`, in a process listing, and in a crash report,
  // and would put the master key in all three.
  const credentialVault =
    options.credentialVault ||
    new CredentialVault({ dataRoot, keyFile: options.credentialKeyFile });
  // The one account this container will ever have. Claimed on first run; after
  // that it is the only way to obtain the session token above.
  const ownerAccount =
    options.ownerAccount ||
    new OwnerAccount({ dataRoot, ...(options.ownerOptions || {}) });
  const githubRoutes =
    options.githubRoutes === null
      ? null
      : options.githubRoutes ||
        new GitHubRoutes({
          dataRoot,
          registryStore,
          audit: new GitHubAuditStore({ dataRoot }),
          profiles: connectionStore,
          vault: credentialVault,
          activity: activityStore,
          ...(options.githubOptions || {}),
        });
  await store.initialize();
  await snapshotStore.initialize();
  await registryStore.initialize();
  await connectionStore.initialize();
  await credentialVault.initialize();
  await githubRoutes?.creations?.initialize();
  const indexHtml = await readFile(resolve(webRoot, 'index.html'), 'utf8');
  /**
   * The bootstrap is chosen per request now, not baked once at startup.
   *
   * It has to be: the page is told whether this container has an owner, and that
   * answer changes the moment someone claims it. Both variants are rendered
   * once and picked between, so the only per-request cost is reading one small
   * file.
   *
   * A record that cannot be read yields `unavailable` rather than `unclaimed`.
   * The page still loads and can say something useful, but it never invites a
   * claim on a deployment that may already have an owner — the claim and
   * sign-in routes refuse it anyway, and the two answers must agree.
   */
  const bootstraps = {
    unclaimed: injectBootstrapMetadata(indexHtml, 'unclaimed', registryNamespace, testRuntime),
    claimed: injectBootstrapMetadata(indexHtml, 'claimed', registryNamespace, testRuntime),
    unavailable: injectBootstrapMetadata(indexHtml, 'unavailable', registryNamespace, testRuntime),
  };
  const bootstrapFor = async () => {
    try {
      return bootstraps[(await ownerAccount.read()).state] || bootstraps.unavailable;
    } catch {
      return bootstraps.unavailable;
    }
  };
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
        bootstrapFor,
        store,
        registryStore,
        activityStore,
        snapshotStore,
        githubRoutes,
        ownerAccount,
        allowedHost,
        allowedOrigin,
        sessionToken,
        jsonBodyLimit: options.jsonBodyLimit ?? JSON_BODY_LIMIT,
        githubCommitBodyLimit: options.githubCommitBodyLimit ?? GITHUB_COMMIT_BODY_LIMIT,
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
      // A `githubError` is constructed to be shown: its message is redacted at
      // the point of creation and carries no token, header, or GitHub request
      // id. Some of them are deliberately 5xx — `INDETERMINATE_SAVE` (503) and
      // `SAVE_NOT_APPLIED` (502) exist precisely to tell the user whether a
      // retry is safe. Flattening those into "Internal server error" would erase
      // the one instruction that prevents a duplicate commit, so they are
      // exempted from sanitization rather than being demoted to 4xx.
      const disclosable = error.github === true;
      const code = error.code && (status < 500 || disclosable) ? error.code : 'INTERNAL_ERROR';
      const message = status < 500 || disclosable ? error.message : 'Internal server error.';
      const detail = {};
      if (disclosable && error.indeterminate) {
        detail.indeterminate = true;
        if (error.commit) detail.commit = error.commit;
      }
      // A boolean provenance marker, carrying no repository, branch, or
      // credential detail: the browser needs it to tell an unresolved attach
      // apart from a definite rejection, whatever the status says.
      if (error.attachUnconfirmed) detail.attachUnconfirmed = true;
      // The local id of a saved connection the user should act on. Not a
      // credential and not a session: it is a value the browser already holds
      // for every connection in its own list, and without it "reconnect that
      // one instead" is advice the UI cannot carry out.
      if (disclosable && typeof error.profileId === 'string') detail.profileId = error.profileId;
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
        { error: { code, message, correlationId, ...detail } },
        correlationId,
        status === 413 ? { Connection: 'close' } : {}
      );
    }
  });
  server.headersTimeout = options.headersTimeout ?? 10_000;
  server.requestTimeout = options.requestTimeout ?? 30_000;
  server.keepAliveTimeout = options.keepAliveTimeout ?? 5_000;
  server.once('close', () => githubRoutes?.creations?.shutdown());

  return {
    server,
    store,
    registryStore,
    connectionStore,
    credentialVault,
    activityStore,
    snapshotStore,
    githubRoutes,
    ownerAccount,
    sessionToken,
  };
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
