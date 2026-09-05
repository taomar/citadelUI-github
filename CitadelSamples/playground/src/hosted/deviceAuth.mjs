import { purposeScopes } from './credentialPurposes.mjs';

const VERIFICATION_URIS = Object.freeze(['https://microsoft.com/devicelogin', 'https://www.microsoft.com/devicelogin']);
const terminal = new Set(['cancelled', 'expired', 'declined', 'failed', 'complete']);
const refuse = (message, status = 409, code = 'device-flow-stale') => {
  throw Object.assign(new Error(message), { status, code });
};

export function createDeviceAuth(config, sessions, auth, { testVerificationUris } = {}) {
  if (testVerificationUris && !process.env.NODE_TEST_CONTEXT && process.env.CITADEL_AUTH_TEST_CONTAINER !== '1') {
    throw new TypeError('Verification URI injection is only available to isolated tests.');
  }
  const verificationUris = testVerificationUris ?? VERIFICATION_URIS;
  if (!verificationUris.every((uri) => {
    const url = new URL(uri);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  })) throw new TypeError('Verification destinations require exact HTTPS URLs.');
  const flows = new Map();
  const cooldowns = new Map();
  let closed = false;
  const now = sessions.now;
  function live(flow) {
    return !closed && !terminal.has(flow.state) && flow.state !== 'cancelling'
      && sessions.hasTransaction(flow.tx) && now() < flow.expiresAt
      && sessions.get(flow.tx.sessionId, { touch: false }) === flow.owner
      && flow.owner.authGeneration === flow.tx.authGeneration
      && flow.owner.contextVersion === flow.tx.pendingContextVersion;
  }
  function fence(flow, state = 'cancelled', code = 'device-cancelled') {
    if (flow.committing || terminal.has(flow.state)) return;
    flow.state = state === 'cancelled' && !flow.tx.settled ? 'cancelling' : state;
    flow.code = code;
    flow.display = null;
    flow.verified = null;
    if (flow.request) flow.request.cancel = true;
    flow.controller.abort();
    sessions.endAuth(flow.owner, flow.tx);
  }
  function sweep() {
    for (const flow of flows.values()) {
      if (!terminal.has(flow.state) && flow.state !== 'cancelling' && !live(flow)) fence(flow, 'expired', 'device-expired');
      if (flow.tx.settled && terminal.has(flow.state) && now() >= Math.max(flow.deadlineAt, cooldowns.get(flow.tx.clientId) ?? 0)) flows.delete(flow.tx.state);
    }
    for (const [key, expiry] of cooldowns) if (now() >= expiry) cooldowns.delete(key);
  }
  const timer = setInterval(sweep, 250);
  timer.unref();
  function view(flow, display = false) {
    return {
      flowId: flow.tx.state, purpose: flow.tx.purpose, state: flow.state,
      deadlineAt: flow.deadlineAt, expiresAt: flow.expiresAt,
      retryAfterMs: Math.max(0, (cooldowns.get(flow.tx.clientId) ?? 0) - now()),
      settled: flow.tx.settled === true, ...(flow.code ? { code: flow.code } : {}),
      ...(display && flow.state === 'pending' && flow.display ? flow.display : {}),
    };
  }
  function find(session, id) {
    sweep();
    const flow = flows.get(id);
    if (!session || !flow || flow.owner !== session) refuse('Device sign-in was not found for this browser.', 404, 'device-flow-not-found');
    return flow;
  }
  async function run(flow) {
    try {
      if (!live(flow)) return;
      const signal = AbortSignal.any([flow.controller.signal, AbortSignal.timeout(Math.max(1, flow.deadlineAt - now()))]);
      const request = {
        scopes: purposeScopes(config, flow.tx.purpose), cancel: false,
        timeout: Math.max(1, Math.floor((flow.deadlineAt - now()) / 1000)),
        deviceCodeCallback(response) {
          if (!live(flow)) { request.cancel = true; refuse('Device sign-in expired.'); }
          if (!verificationUris.includes(response.verificationUri)
            || typeof response.userCode !== 'string' || !/^[A-Z0-9-]{4,32}$/.test(response.userCode)
            || typeof response.deviceCode !== 'string' || !response.deviceCode || response.deviceCode.length > 8192
            || !Number.isSafeInteger(response.expiresIn) || response.expiresIn < 1
            || !Number.isSafeInteger(response.interval) || response.interval < 1 || response.interval > 60) {
            refuse('The identity provider returned an invalid device response.', 503, 'device-response-invalid');
          }
          flow.expiresAt = Math.min(flow.deadlineAt, flow.deviceRequestedAt + response.expiresIn * 1000);
          flow.tx.expires = flow.expiresAt;
          if (!live(flow)) { request.cancel = true; refuse('Device sign-in expired.'); }
          flow.display = { userCode: response.userCode, verificationUri: response.verificationUri };
          flow.state = 'pending';
        },
      };
      flow.request = request;
      flow.tx.client = auth.client('device-code', {
        signal,
        onResponse(url, body) {
          if (new URL(url).pathname.endsWith('/token') && typeof body?.error === 'string') {
            flow.providerError = ['authorization_pending', 'slow_down', 'authorization_declined', 'access_denied', 'expired_token'].includes(body.error)
              ? body.error : 'identity-error';
          }
        },
      });
      flow.deviceRequestedAt = now();
      const result = await flow.tx.client.acquireTokenByDeviceCode(request);
      if (!live(flow)) return;
      const verified = await auth.verifyDevice(flow.tx, result, signal);
      if (!live(flow)) return;
      flow.verified = verified;
      flow.display = null;
      flow.state = 'ready';
    } catch {
      if (live(flow)) {
        const error = flow.providerError;
        if (error === 'slow_down') {
          cooldowns.set(flow.tx.clientId, now() + 30000);
          fence(flow, 'failed', 'device-rate-limited');
        } else if (['authorization_declined', 'access_denied'].includes(error)) fence(flow, 'declined', 'device-declined');
        else if (error === 'expired_token') fence(flow, 'expired', 'device-expired');
        else fence(flow, 'failed', 'device-signin-failed');
      }
    } finally {
      sessions.settleDevice(flow.tx);
      flow.tx.client = null;
      flow.request = null;
      if (flow.state === 'cancelling') flow.state = 'cancelled';
      if (!live(flow) && !terminal.has(flow.state)) fence(flow, 'expired', 'device-expired');
    }
  }
  return Object.freeze({
    begin(session, purpose, connection, intent) {
      sweep();
      if (closed) refuse('Device sign-in is unavailable.', 503);
      const clientKey = sessions.authorized(session) ? `operator:${session.claims.oid}` : `connection:${connection}`;
      if ((cooldowns.get(clientKey) ?? 0) > now()) refuse('Microsoft asked to slow down. Wait 30 seconds, then retry.', 429, 'device-rate-limited');
      for (const old of flows.values()) if (old.owner === session && old.tx.settled && terminal.has(old.state)) flows.delete(old.tx.state);
      if ([...flows.values()].filter((flow) => !flow.tx.settled || !terminal.has(flow.state)).length >= 8
        || flows.size >= config.maxTransactions) refuse('Device sign-in capacity reached. Retry later.', 429, 'device-capacity');
      const tx = sessions.begin(session, purpose, null, connection, intent, 'device-code');
      const owner = sessions.get(tx.sessionId, { touch: false });
      sessions.invalidateContext(owner);
      sessions.bindPendingContext(tx, owner);
      owner.authPending = true;
      // A later context invalidation cannot cancel this admission before it is bound.
      for (const old of flows.values()) if (old.owner === owner && old.tx.settled && terminal.has(old.state)) flows.delete(old.tx.state);
      const flow = { tx, owner, state: 'starting', deadlineAt: tx.expires, expiresAt: tx.expires,
        controller: new AbortController(), display: null, verified: null };
      tx.onCancel = () => {
        if (flow.committing || flow.controller.signal.aborted) return;
        fence(flow);
      };
      flows.set(tx.state, flow);
      return { session: owner, ...view(flow) };
    },
    start(session, id) {
      const flow = flows.get(id);
      if (!flow || flow.owner !== session || flow.task || flow.tx.settled) return;
      flow.task = run(flow);
    },
    status(session, id) { return view(find(session, id), true); },
    pending(session) {
      sweep();
      const flow = [...flows.values()].find((item) => item.owner === session && item.state !== 'complete');
      return flow ? view(flow) : null;
    },
    cancel(session, id) {
      const flow = find(session, id);
      fence(flow);
      if (!flow.task) { sessions.settleDevice(flow.tx); flow.state = 'cancelled'; }
      return view(flow);
    },
    abandon(session, id) {
      // Response-close notifications may arrive after the owning flow expired.
      const flow = flows.get(id);
      if (!flow || flow.owner !== session) return;
      fence(flow);
      if (!flow.task) { sessions.settleDevice(flow.tx); flow.state = 'cancelled'; }
    },
    complete(session, id) {
      const flow = find(session, id);
      if (!live(flow) || flow.state !== 'ready' || !flow.verified || !flow.tx.settled) refuse('Device sign-in is not ready or has expired.');
      sessions.consumeDevice(session, flow.tx);
      flow.committing = true;
      try {
        const next = sessions.finish(session, flow.verified, flow.tx);
        flow.state = 'complete';
        flows.delete(id);
        return next;
      } catch (error) {
        flow.committing = false;
        fence(flow, 'failed', 'device-completion-failed');
        throw error;
      } finally { flow.verified = null; flow.display = null; }
    },
    async close() {
      closed = true;
      clearInterval(timer);
      for (const flow of flows.values()) {
        fence(flow);
        if (!flow.task) sessions.settleDevice(flow.tx);
      }
      await Promise.all([...flows.values()].map((flow) => flow.task));
      flows.clear();
      cooldowns.clear();
    },
  });
}
