import { createServer } from 'node:https';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createSessions, cookieValue, sessionCookie, SESSION_COOKIE, CORRELATION_COOKIE, PREAUTH_COOKIE, sameToken, randomToken } from './sessions.mjs';
import { createMicrosoftAuth } from './auth.mjs';
import { createHostedRuntime } from './runtime.mjs';
import { CATALOGUE } from '../catalogue/index.mjs';
import { HOSTED_RECIPES, authMethods } from './config.mjs';
import { createDeviceAuth } from './deviceAuth.mjs';
import { readSampleSource } from '../server/sourceView.mjs';
import { createStagedRuntime } from './stagedRuntime.mjs';
import { RESOURCE_PURPOSES, purposeStates } from './credentialPurposes.mjs';

const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const fail = (message, status = 400, code = 'request-refused') => { throw Object.assign(new Error(message), { status, code }); };

function send(response, status, payload, extra = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  response.end(payload == null ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload));
}
async function body(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') fail('Use application/json.', 415);
  let size = 0;
  const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) fail('Request is too large.', 413);
    parts.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a JSON object.');
    return value;
  } catch { fail('Invalid JSON request.'); }
}
function exact(value, keys) {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail('Unexpected request fields.');
}

export function hostedCapabilities(config, sessions, session, runtime, csrf = null, device = null) {
  session ??= { claims: null, csrf, contextVersion: 0 };
  const authorized = sessions.authorized(session) && !session.authPending;
  const reason = config.authIssues.length ? 'Deployment owner must complete Microsoft sign-in configuration.'
    : !session.claims ? 'Sign in with Microsoft in this application.'
    : !authorized ? 'Signed in, but not authorized to operate this application.'
    : 'Seven Docker adapters are available when their target policy is configured; twelve require future protected adapters.';
  return {
    status: 'ok', protocolVersion: 2, mode: 'hosted',
    auth: { mode: 'bff', available: authMethods(config)[0].available, defaultMethod: 'browser',
      methods: authMethods(config), deviceFlow: device?.pending(session) ?? null, signedIn: Boolean(session.claims),
      authorized, pending: session.authPending === true, csrf: session.csrf, account: session.claims ? {
        name: session.claims.preferred_username || session.claims.oid, objectId: session.claims.oid, tenantId: session.claims.tid,
      } : null, azureConnected: session.azure === true, selectedSubscription: session.subscription,
      contextVersion: session.contextVersion, issues: config.issues, resourceManager: config.cloud?.resourceManager,
      resourceConsents: purposeStates(config, session) },
    sessionAuth: { required: true, state: authorized ? 'claimed' : 'unclaimed', claimEndpoint: null, message: reason },
    operatorAuthorization: { required: true, signedIn: Boolean(session.claims), authorized, message: reason },
    executor: { id: 'hosted-bff', kind: 'hosted-bff', canExecute: authorized && runtime.allowed.length > 0,
      endpoint: '/api/hosted/run', supportedStepTypes: ['http', 'assertion'], allowedSampleIds: runtime.allowed,
      supportedSampleIds: HOSTED_RECIPES, reason },
    capability: { mode: 'hosted', label: 'Hosted HTTPS adapters', detail: reason, total: 19,
      ready: authorized ? runtime.allowed.length : 0,
      perSample: CATALOGUE.samples.map((sample) => ({ id: sample.id, ready: authorized && runtime.allowed.includes(sample.id),
        state: runtime.allowed.includes(sample.id) ? 'ready' : 'partial', dependencies: [],
        reasons: runtime.allowed.includes(sample.id) ? [] : ['A configured, protected Docker adapter is not available for this recipe.'] })) },
    hosted: { supportedSampleIds: HOSTED_RECIPES, allowedSampleIds: runtime.allowed, resourceManager: config.cloud?.resourceManager,
      staged: { enabled: Boolean(runtime.staged), hostedFlowVersion: 1, allowedSampleIds: runtime.staged?.ids ?? [],
        reason: 'W1 foundation only. Additional production adapters and service contracts remain disabled.' } },
    executionContext: { endpoint: authorized ? '/api/execution-context' : null },
    selfTest: { available: false }, sourceValidation: { available: false },
    protectedSource: { available: true, editable: false, endpointTemplate: '/api/source/{sampleId}' },
    azureAuth: { systemLogin: { available: false }, subscriptions: { available: false } },
  };
}

export function createHostedServer({ config, tls, root, auth: injectedAuth, fetchImpl, now, testAdapters, testVerificationUris } = {}) {
  if (!tls?.cert || !tls?.key) throw new TypeError('Hosted serving requires mounted TLS certificate and key.');
  const sessions = createSessions(config, { ...(now ? { now } : {}) });
  const auth = injectedAuth ?? (authMethods(config).some((method) => method.available) ? createMicrosoftAuth(config, { fetchImpl }) : null);
  const device = auth ? createDeviceAuth(config, sessions, auth, { testVerificationUris }) : null;
  const staged = config.stagedEnabled ? createStagedRuntime(config, sessions, auth, { fetchImpl, testAdapters }) : null;
  const runtime = createHostedRuntime(config, sessions, auth, { fetchImpl, staged });
  const expectedHost = new URL(config.origin).host;
  async function handler(request, response) {
    try {
      if (!request.socket.encrypted || request.headers.host !== expectedHost) fail('HTTPS host is not the configured application origin.', 403);
      if (tls.expiresAt && Date.now() >= tls.expiresAt) fail('TLS certificate expired; deployment owner renewal is required.', 503);
      if ((request.url ?? '').length > 12000 || !request.url.startsWith('/') || request.url.startsWith('//')) fail('Invalid request target.');
      const url = new URL(request.url, config.origin);
      const path = url.pathname;
      if (path === '/auth/callback') {
        if (request.method !== 'GET' || !auth || !authMethods(config)[0].available) fail('Sign-in is not configured.', 400);
        let prior, next, tx;
        try {
          for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) fail('Duplicate authentication response fields.');
          tx = sessions.consume(url.searchParams.get('state'), cookieValue(request, CORRELATION_COOKIE));
          prior = sessions.get(tx.sessionId);
          if (url.searchParams.has('error')) fail('Microsoft sign-in was cancelled or denied.');
          const code = url.searchParams.get('code');
          if (!code || code.length > 10000) fail('Missing or invalid authorization code.');
          const verified = await auth.finish(tx, code);
          if (!sessions.get(tx.sessionId, { touch: false })) fail('Sign-in session expired.');
          next = sessions.finish(prior, verified, tx);
        } catch {
          const current = sessions.hasTransaction(tx);
          const retained = sessions.authorized(prior);
          if (current && retained) sessions.endAuth(prior, tx);
          else if (current) sessions.revoke(prior);
          send(response, 303, null, { Location: '/?signin=failed', 'Set-Cookie': [
            ...(prior && current ? [sessionCookie(retained ? prior.id : '', { clear: !retained }), sessionCookie('', { correlation: true, clear: true })] : []),
          ] });
          return;
        }
        send(response, 303, null, { Location: '/', 'Set-Cookie': [
          sessionCookie(next.id), sessionCookie('', { correlation: true, clear: true }), sessionCookie('', { preauth: true, clear: true }),
        ] });
        return;
      }
      if (path === '/api/live' && request.method === 'GET') { send(response, 200, { status: 'ok' }); return; }
      let session = sessions.get(cookieValue(request, SESSION_COOKIE));
      if (path === '/api/capabilities' && request.method === 'GET') {
        const crossSite = request.headers['sec-fetch-site'] === 'cross-site'
          || (request.headers.origin && request.headers.origin !== config.origin);
        const existing = cookieValue(request, PREAUTH_COOKIE);
        const csrf = session?.csrf ?? (!crossSite ? sameToken(existing, existing) ? existing : randomToken() : null);
        send(response, 200, hostedCapabilities(config, sessions, crossSite ? null : session, runtime, crossSite ? null : csrf, crossSite ? null : device),
          !session && !crossSite ? { 'Set-Cookie': sessionCookie(csrf, { preauth: true }) } : {});
        return;
      }
      if (request.method === 'POST') {
        if (request.headers.origin !== config.origin || !['same-origin', undefined].includes(request.headers['sec-fetch-site'])) fail('Same-origin request required.', 403);
        const csrf = session?.csrf ?? (['/api/auth/start', '/api/auth/device/start'].includes(path) ? cookieValue(request, PREAUTH_COOKIE) : null);
        if (!sameToken(request.headers['x-citadel-csrf'], csrf)) fail('Session expired or CSRF check failed. Reload to sign in.', 401, 'session-required');
        const payload = await body(request);
        if (session && sessions.get(session.id, { touch: false }) !== session) fail('Session changed while reading the request. Reload to continue.', 401, 'session-required');
        if (path.startsWith('/api/auth/device/')) {
          if (!device || !authMethods(config)[1].available) fail('Device sign-in is not configured by the deployment owner.', 503, 'device-unavailable');
          if (url.search || payload.protocolVersion !== 2 || payload.deviceFlowVersion !== 1) fail('Invalid device sign-in protocol.');
          if (path === '/api/auth/device/start') {
            const { deviceFlowVersion, ...consentPayload } = payload;
            let intent = null;
            if (RESOURCE_PURPOSES.includes(payload.purpose)) {
              if (!staged) fail('Staged resource consent is not enabled.', 403, 'service-contract-unverified');
              intent = staged.consentIntent(session, consentPayload);
            } else {
              exact(payload, ['protocolVersion', 'deviceFlowVersion', 'purpose']);
              if (!['signin', 'azure'].includes(payload.purpose)) fail('Unknown sign-in purpose.');
            }
            if (payload.purpose !== 'signin' && !sessions.authorized(session)) fail('Operator sign-in required.', 403);
            if (payload.purpose === 'azure' && !config.subscriptionIds.length) fail('Configure permitted subscriptions before Azure consent.', 403);
            const admitted = device.begin(session, payload.purpose, request.socket.remoteAddress, intent);
            session = admitted.session;
            let acknowledged = false;
            response.once('finish', () => { acknowledged = true; device.start(session, admitted.flowId); });
            response.once('close', () => { if (!acknowledged) device.abandon(session, admitted.flowId); });
            const { session: owner, ...status } = admitted;
            send(response, 202, { ...status, csrf: owner.csrf }, { 'Set-Cookie': [sessionCookie(owner.id)] });
          } else {
            exact(payload, ['protocolVersion', 'deviceFlowVersion', 'flowId']);
            if (typeof payload.flowId !== 'string' || !/^[\w-]{43}$/.test(payload.flowId)) fail('Invalid device flow handle.');
            if (path === '/api/auth/device/status') send(response, 200, device.status(session, payload.flowId));
            else if (path === '/api/auth/device/cancel') send(response, 200, device.cancel(session, payload.flowId));
            else if (path === '/api/auth/device/complete') {
              const next = device.complete(session, payload.flowId);
              send(response, 200, { state: 'complete', csrf: next.csrf }, { 'Set-Cookie': [
                sessionCookie(next.id), sessionCookie('', { preauth: true, clear: true }),
              ] });
            } else fail('Unknown device sign-in operation.', 404);
          }
          return;
        }
        if (path === '/api/auth/start') {
          let intent = null;
          if (RESOURCE_PURPOSES.includes(payload.purpose)) {
            if (!staged) fail('Staged resource consent is not enabled.', 403, 'service-contract-unverified');
            intent = staged.consentIntent(session, payload);
          } else {
            exact(payload, ['purpose']);
            if (!['signin', 'azure'].includes(payload.purpose)) fail('Sign-in configuration is incomplete.');
          }
          if (!auth || !authMethods(config)[0].available) fail('Sign-in configuration is incomplete.');
          if (payload.purpose === 'azure' && !sessions.authorized(session)) fail('Operator sign-in required.', 403);
          if (payload.purpose === 'azure' && !config.subscriptionIds.length) fail('The deployment owner must configure permitted subscriptions before Azure consent.', 403);
          const tx = sessions.begin(session, payload.purpose, auth.client(), request.socket.remoteAddress, intent);
          session = sessions.get(tx.sessionId);
          sessions.invalidateContext(session);
          sessions.bindPendingContext(tx, session);
          session.authPending = true;
          try {
            const location = await auth.start(tx, session);
            if (!sessions.hasTransaction(tx)) fail('Sign-in start was cancelled or expired.', 409);
            send(response, 200, { url: location }, { 'Set-Cookie': [sessionCookie(session.id), sessionCookie(tx.correlation, { correlation: true })] });
          } catch {
            if (sessions.authorized(session)) sessions.endAuth(session, tx);
            else sessions.revoke(session);
            fail('Microsoft sign-in could not start. Reload and retry; contact the deployment owner if it persists.', 503, 'signin-unavailable');
          }
          return;
        }
        if (path === '/api/auth/logout' || path === '/api/auth/cancel') {
          exact(payload, []);
          if (path.endsWith('cancel') && device?.pending(session)) fail('Cancel device sign-in with its exact flow handle.', 409, 'device-handle-required');
          const retained = path.endsWith('cancel') && sessions.authorized(session);
          if (retained) sessions.endAuth(session);
          else sessions.revoke(session);
          send(response, 200, { url: path.endsWith('logout') && auth ? auth.logoutUrl : '/' }, {
            'Set-Cookie': [sessionCookie(retained ? session.id : '', { clear: !retained }), sessionCookie('', { correlation: true, clear: true })],
          });
          return;
        }
        if (!sessions.authorized(session) || session.authPending) fail('This account is not authorized to operate.', 403, 'operator-required');
        if (payload.hostedFlowVersion !== undefined || ['/api/hosted/resolve', '/api/hosted/status', '/api/hosted/reconcile', '/api/hosted/recoverable'].includes(path)) {
          if (!staged) fail('Staged execution is disabled.', 403, 'staged-disabled');
          if (path === '/api/execution-context') send(response, 200, { context: staged.context(session, payload) });
          else if (path === '/api/hosted/resolve') send(response, 200, await staged.resolve(session, payload));
          else if (path === '/api/hosted/review') send(response, 200, staged.review(session, payload));
          else if (path === '/api/hosted/run') {
            const disconnected = new AbortController();
            let finished = false;
            const abort = () => { if (!finished) disconnected.abort(); };
            response.once('close', abort);
            response.once('finish', () => { finished = true; response.off('close', abort); });
            if (request.socket.destroyed) disconnected.abort();
            try { send(response, 202, staged.run(session, payload, { signal: disconnected.signal })); }
            catch (error) { disconnected.abort(); response.off('close', abort); throw error; }
          } else if (path === '/api/hosted/status') send(response, 200, staged.status(session, payload));
          else if (path === '/api/hosted/recoverable') send(response, 200, staged.recoverable(session, payload));
          else if (path === '/api/hosted/cancel') send(response, 200, staged.cancel(session, payload));
          else if (path === '/api/hosted/reconcile') send(response, 200, await staged.reconcile(session, payload));
          else fail('No staged operation exists at this endpoint.', 404);
          return;
        }
        if (path === '/api/execution-context') {
          exact(payload, ['protocolVersion', 'sampleId', 'configuredSubscriptionId', 'gateway']);
          if (payload.protocolVersion !== 2) fail('Unsupported protocol.');
          send(response, 200, { context: runtime.context(session, payload) });
        } else if (path === '/api/hosted/subscriptions') {
          exact(payload, []);
          send(response, 200, { subscriptions: await runtime.subscriptions(session) });
        } else if (path === '/api/hosted/subscription') {
          exact(payload, ['subscriptionId']);
          send(response, 200, { subscription: await runtime.select(session, payload.subscriptionId), contextVersion: session.contextVersion });
        } else if (path === '/api/hosted/review') {
          send(response, 200, runtime.review(session, payload));
        } else if (path === '/api/hosted/run') {
          const disconnected = new AbortController();
          const abort = () => { if (!response.writableEnded) disconnected.abort(); };
          response.once('close', abort);
          try { send(response, 200, await runtime.run(session, payload, { signal: disconnected.signal })); }
          finally { response.off('close', abort); }
        } else if (path === '/api/hosted/cancel') {
          exact(payload, []);
          send(response, 200, runtime.cancel(session));
        } else fail('No hosted operation exists at this endpoint.', 404);
        return;
      }
      if (request.method !== 'GET') fail('Method not allowed.', 405);
      const source = /^\/api\/source\/([a-z0-9-]+)$/.exec(path);
      if (source) {
        const sample = CATALOGUE.byId.get(source[1]);
        if (!sample) fail('Unknown sample.', 404);
        send(response, 200, await readSampleSource({ playgroundRoot: root, sample, notebook: CATALOGUE.sourceNotebook }));
        return;
      }
      const staticPath = path === '/' ? '/web/index.html' : path;
      if (!/^\/(?:web\/|src\/(?:core|catalogue|view)\/)/.test(staticPath)) fail('Not found.', 404);
      const file = resolve(root, `.${decodeURIComponent(staticPath)}`);
      const allowedRoots = ['web', 'src/core', 'src/catalogue', 'src/view'].map((directory) => resolve(root, directory) + sep);
      if (!allowedRoots.some((directory) => file.startsWith(directory)) || !types[extname(file)]) fail('Not found.', 404);
      let content;
      try {
        const canonical = await realpath(file);
        if (!allowedRoots.some((directory) => canonical.startsWith(directory))) fail('Not found.', 404);
        content = await readFile(canonical);
      } catch (error) { if (error.code === 'ENOENT') fail('Not found.', 404); throw error; }
      if (staticPath === '/web/index.html') content = content.toString('utf8').replace('<html ', '<html data-citadel-hosted="true" ');
      response.writeHead(200, { ...headers, 'Content-Type': types[extname(file)] });
      response.end(content);
    } catch (error) {
      const expected = Number.isInteger(error.status) && error.status >= 400 && error.status < 600;
      send(response, expected ? error.status : 500, { state: 'blocked',
        code: expected ? error.code ?? 'request-refused' : 'hosted-operation-failed',
        summary: expected ? error.message : 'The hosted operation could not complete. No automatic retry was made.' });
    }
  }
  const server = createServer({ ...tls, minVersion: 'TLSv1.2' }, handler);
  server.requestTimeout = 90000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 80;
  let closingStaged;
  const closeStaged = () => closingStaged ??= staged ? staged.close() : Promise.resolve();
  let closingDevice;
  const closeDevice = () => closingDevice ??= device ? device.close() : Promise.resolve();
  server.on('close', () => {
    sessions.close();
    closeDevice().catch(() => { process.exitCode = 1; process.stderr.write('Device sign-in could not close cleanly.\n'); });
    closeStaged().catch(() => { process.exitCode = 1; process.stderr.write('Staged storage could not close cleanly; owner recovery is required.\n'); });
  });
  return Object.assign(server, { sessions, runtime, closeStaged, closeDevice });
}
