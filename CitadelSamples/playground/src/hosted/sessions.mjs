import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AUTH_PURPOSES, RESOURCE_PURPOSES } from './credentialPurposes.mjs';

export const SESSION_COOKIE = '__Host-citadel';
export const CORRELATION_COOKIE = '__Host-citadel-login';
export const PREAUTH_COOKIE = '__Host-citadel-preauth';
export const randomToken = () => randomBytes(32).toString('base64url');

export function sameToken(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^[\w-]{43}$/.test(a) && /^[\w-]{43}$/.test(b)
    && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function cookieValue(request, name) {
  const raw = request.headers?.cookie ?? '';
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  const values = raw.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}

export function sessionCookie(value, { correlation = false, preauth = false, clear = false } = {}) {
  return `${preauth ? PREAUTH_COOKIE : correlation ? CORRELATION_COOKIE : SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=${correlation ? 'Lax' : 'Strict'}${clear ? '; Max-Age=0' : correlation || preauth ? '; Max-Age=300' : ''}`;
}

export function entitled(claims, policy) {
  if (!policy || !claims) return false;
  return (policy.requiredRole && Array.isArray(claims.roles) && claims.roles.includes(policy.requiredRole))
    || policy.allowedPrincipalIds.includes(claims.oid)
    || (Array.isArray(claims.groups) && claims.groups.some((group) => policy.allowedGroupIds.includes(group)));
}

export function createSessions(config, { now = Date.now } = {}) {
  const sessions = new Map();
  const pending = new Map();
  const transactions = new Map();
  const clients = new Map();
  const invalidators = new Set();
  let loginWindow = 0;
  let logins = 0;
  function removeTransaction(tx) {
    tx.invalidated = true;
    tx.onCancel?.();
    if (tx.method !== 'device-code' || tx.settled) transactions.delete(tx.state);
  }
  function revoke(session) {
    if (!session) return;
    session.controller.abort();
    session.contextController.abort();
    session.run?.controller.abort();
    for (const invalidate of invalidators) invalidate(session);
    session.stagedResolution?.clearSecrets?.();
    session.stagedResolution = null;
    session.stagedReview = null;
    session.consentIntents?.clear();
    session.credentials = {};
    session.cache = null;
    session.account = null;
    sessions.delete(session.id);
    pending.delete(session.id);
    for (const transaction of transactions.values()) if (transaction.sessionId === session.id) removeTransaction(transaction);
  }
  function sweep() {
    const time = now();
    for (const session of [...sessions.values(), ...pending.values()]) {
      if (time - session.touched >= config.idleMs || time - session.created >= config.absoluteMs
        || (pending.has(session.id) && time - session.created >= config.transactionMs)
        || (session.claims && session.claims.exp * 1000 <= time)) revoke(session);
    }
    for (const tx of transactions.values()) if (tx.expires <= time) {
      removeTransaction(tx);
      const owner = sessions.get(tx.sessionId);
      if (owner) owner.authPending = false;
    }
    for (const [id, client] of clients) if (time - client.start >= 60000) clients.delete(id);
  }
  const stored = (id) => sessions.get(id) ?? pending.get(id);
  function invalidateContext(session) {
    session.contextController.abort();
    session.contextController = new AbortController();
    for (const tx of transactions.values()) {
      if (tx.method === 'device-code' && tx.sessionId === session.id && tx.pendingContextVersion !== undefined) removeTransaction(tx);
    }
    session.contextVersion++;
    session.resolutionGeneration++;
    session.review = null;
    session.stagedReview = null;
    session.stagedResolution?.clearSecrets?.();
    session.stagedResolution = null;
    session.consentIntents.clear();
    session.run?.controller.abort();
    session.subscription = null;
    for (const invalidate of invalidators) invalidate(session);
  }
  function newSession() {
    const session = { id: randomToken(), csrf: randomToken(), created: now(), touched: now(), claims: null,
      account: null, cache: null, credentials: {}, subscription: null, contextVersion: 0, authGeneration: 0,
      resolutionGeneration: 0, consentIntents: new Map(), controller: new AbortController(),
      contextController: new AbortController(), run: null };
    session.invalidateContext = () => invalidateContext(session);
    return session;
  }
  function create() {
    sweep();
    if (sessions.size >= config.maxSessions) throw Object.assign(new Error('Session capacity reached; retry later.'), { status: 429 });
    const session = newSession();
    sessions.set(session.id, session);
    return session;
  }
  return Object.freeze({
    create, revoke, sweep, now, invalidateContext,
    onInvalidate(listener) { invalidators.add(listener); return () => invalidators.delete(listener); },
    get(id, { touch = true } = {}) {
      sweep();
      const session = stored(id);
      if (session && touch) session.touched = now();
      return session ?? null;
    },
    authorized(session) {
      sweep();
      return Boolean(session && sessions.get(session.id) === session && session.claims
        && session.claims.tid === config.tenantId && entitled(session.claims, config.policy));
    },
    begin(session, purpose, client, clientId = 'internal-test-client', intent = null, method = 'browser') {
      sweep();
      if (!['browser', 'device-code'].includes(method)) throw new TypeError('Unknown authentication method.');
      if (!AUTH_PURPOSES.includes(purpose)) throw Object.assign(new Error('Unknown authentication purpose.'), { status: 400 });
      if (RESOURCE_PURPOSES.includes(purpose) && (!intent || session?.consentIntents.get(intent.consentIntentId) !== intent
        || intent.purpose !== purpose || intent.expiresAt <= now() || intent.contextVersion !== session.contextVersion
        || intent.resolutionId !== session.stagedResolution?.id)) {
        throw Object.assign(new Error('Resolve this recipe again before resource consent.'), { status: 409, code: 'consent-intent-stale' });
      }
      if (session && stored(session.id) !== session) throw Object.assign(new Error('Session expired. Sign in again.'), { status: 401 });
      if (!session && purpose !== 'signin') throw Object.assign(new Error('Operator sign-in required.'), { status: 401 });
      for (const tx of transactions.values()) if (session && tx.sessionId === session.id) throw Object.assign(new Error('Sign-in is already pending.'), { status: 409 });
      clientId = session && sessions.get(session.id) === session && session.claims?.tid === config.tenantId && entitled(session.claims, config.policy)
        ? `operator:${session.claims.oid}` : `connection:${clientId}`;
      if ([...transactions.values()].filter((tx) => tx.clientId === clientId).length >= 2) {
        throw Object.assign(new Error('This client already has two pending sign-ins. Complete or cancel one first.'), { status: 429 });
      }
      const bucket = clients.get(clientId);
      if ((bucket?.count ?? 0) >= 3 || (!bucket && clients.size >= 1024)) throw Object.assign(new Error('This connection has reached its sign-in limit. Retry after one minute.'), { status: 429 });
      if (now() - loginWindow >= 60000) { loginWindow = now(); logins = 0; }
      if (logins >= 30 || transactions.size >= config.maxTransactions
        || (!session && pending.size >= config.maxTransactions)) throw Object.assign(new Error('Sign-in capacity reached; retry shortly.'), { status: 429 });
      if (!session) { session = newSession(); pending.set(session.id, session); }
      if (intent) session.consentIntents.delete(intent.consentIntentId);
      const state = randomToken();
      const tx = { state, method, ...(method === 'browser' ? { correlation: randomToken(), nonce: randomToken(), verifier: randomToken() } : {}),
        expires: now() + config.transactionMs, sessionId: session.id, purpose, client, clientId,
        expectedOid: purpose !== 'signin' ? session.claims?.oid : null,
        expectedTid: purpose !== 'signin' ? session.claims?.tid : null,
        expectedHomeAccountId: purpose !== 'signin' ? session.account?.homeAccountId : null,
        intent, authGeneration: ++session.authGeneration };
      transactions.set(state, tx);
      clients.set(clientId, { start: bucket?.start ?? now(), count: (bucket?.count ?? 0) + 1 });
      logins++;
      return tx;
    },
    consume(state, correlation) {
      sweep();
      const tx = transactions.get(state);
      if (!tx || tx.method !== 'browser' || tx.invalidated || tx.consumed || !sameToken(tx.correlation, correlation)) throw Object.assign(new Error('Sign-in expired or browser correlation failed. Start again.'), { status: 400 });
      tx.consumed = true;
      if (!stored(tx.sessionId)) throw Object.assign(new Error('Sign-in session expired.'), { status: 400 });
      return tx;
    },
    hasTransaction(tx) { return Boolean(tx && !tx.invalidated && transactions.get(tx.state) === tx && tx.expires > now()); },
    consumeDevice(session, tx) {
      sweep();
      if (!tx || tx.method !== 'device-code' || tx.invalidated || tx.consumed || !tx.settled
        || transactions.get(tx.state) !== tx || tx.expires <= now() || stored(session?.id) !== session
        || tx.sessionId !== session.id || tx.authGeneration !== session.authGeneration
        || tx.pendingContextVersion !== session.contextVersion) {
        throw Object.assign(new Error('Device sign-in expired or no longer belongs to this browser.'), { status: 409 });
      }
      tx.consumed = true;
      return tx;
    },
    settleDevice(tx) {
      if (tx.method !== 'device-code') throw new TypeError('Not a device transaction.');
      tx.settled = true;
      if (tx.invalidated) transactions.delete(tx.state);
    },
    bindPendingContext(tx, session) {
      if (transactions.get(tx.state) !== tx || tx.sessionId !== session.id) throw new Error('Authentication transaction is no longer current.');
      tx.pendingContextVersion = session.contextVersion;
    },
    finish(prior, verified, tx) {
      sweep();
      if (tx && (tx.invalidated || transactions.get(tx.state) !== tx || tx.sessionId !== prior?.id || !tx.consumed || tx.expires <= now())) {
        throw Object.assign(new Error('Sign-in transaction expired or was cancelled.'), { status: 409 });
      }
      if (stored(prior?.id) !== prior) throw Object.assign(new Error('Sign-in session expired.'), { status: 401 });
      if (tx && (tx.authGeneration !== prior.authGeneration
        || (tx.pendingContextVersion !== undefined && tx.pendingContextVersion !== prior.contextVersion))) {
        throw Object.assign(new Error('Sign-in context changed or was cancelled.'), { status: 409 });
      }
      if (tx?.purpose !== 'signin' && tx && (verified.claims?.oid !== tx.expectedOid || verified.claims?.tid !== tx.expectedTid)) {
        throw Object.assign(new Error('Resource consent must retain the same operator.'), { status: 403 });
      }
      const consent = tx && tx.purpose !== 'signin';
      const operatorClaims = consent ? prior.claims : verified.claims;
      const operator = operatorClaims?.tid === config.tenantId && entitled(operatorClaims, config.policy);
      const destination = operator ? sessions : pending;
      const limit = operator ? config.maxSessions : config.maxTransactions;
      if (!destination.has(prior.id) && destination.size >= limit) throw Object.assign(new Error('Operator session capacity reached; retry later.'), { status: 429 });
      const next = Object.assign(newSession(), verified);
      if (consent) { next.claims = prior.claims; next.account = prior.account; }
      next.contextVersion = prior.contextVersion + 1;
      const credentials = {};
      const validAccount = (account) => account?.localAccountId === verified.claims?.oid && account?.tenantId === verified.claims?.tid
        && (!account.homeAccountId || !verified.account?.homeAccountId || account.homeAccountId === verified.account.homeAccountId);
      if (tx && tx.purpose !== 'signin') {
        for (const [purpose, credential] of Object.entries(prior.credentials)) {
          if (!validAccount(credential.account)) throw Object.assign(new Error('Cached resource identity changed.'), { status: 403 });
          credentials[purpose] = credential;
        }
        if (!validAccount(verified.account)) throw Object.assign(new Error('Resource account did not match the operator.'), { status: 403 });
        credentials[tx.purpose] = { ...verified.credentials?.[tx.purpose], cache: verified.cache, account: verified.account,
          grantGeneration: (credentials[tx.purpose]?.grantGeneration ?? 0) + 1 };
      }
      next.credentials = credentials;
      next.azure = Boolean(credentials.azure);
      if (credentials.azure) next.cache = credentials.azure.cache;
      next.invalidateContext = () => invalidateContext(next);
      revoke(prior);
      destination.set(next.id, next);
      return next;
    },
    endAuth(session, tx) {
      if (!session || stored(session.id) !== session) return;
      if (tx && transactions.get(tx.state) !== tx) return;
      for (const active of transactions.values()) if (active.sessionId === session.id && (!tx || active === tx)) removeTransaction(active);
      session.authPending = [...transactions.values()].some((active) => !active.invalidated && active.sessionId === session.id);
    },
    close() { for (const session of [...sessions.values(), ...pending.values()]) revoke(session); transactions.clear(); clients.clear(); },
  });
}
