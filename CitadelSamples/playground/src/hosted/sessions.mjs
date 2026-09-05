import { randomBytes, timingSafeEqual } from 'node:crypto';

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
  let loginWindow = 0;
  let logins = 0;
  function revoke(session) {
    if (!session) return;
    session.controller.abort();
    session.cache = null;
    session.account = null;
    sessions.delete(session.id);
    pending.delete(session.id);
    for (const [id, transaction] of transactions) if (transaction.sessionId === session.id) transactions.delete(id);
  }
  function sweep() {
    const time = now();
    for (const session of [...sessions.values(), ...pending.values()]) {
      if (time - session.touched >= config.idleMs || time - session.created >= config.absoluteMs
        || (pending.has(session.id) && time - session.created >= config.transactionMs)
        || (session.claims && session.claims.exp * 1000 <= time)) revoke(session);
    }
    for (const [id, tx] of transactions) if (tx.expires <= time) {
      transactions.delete(id);
      const owner = sessions.get(tx.sessionId);
      if (owner) owner.authPending = false;
    }
    for (const [id, client] of clients) if (time - client.start >= 60000) clients.delete(id);
  }
  const stored = (id) => sessions.get(id) ?? pending.get(id);
  const newSession = () => ({ id: randomToken(), csrf: randomToken(), created: now(), touched: now(), claims: null,
    account: null, cache: null, subscription: null, contextVersion: 0, controller: new AbortController(), run: null });
  function create() {
    sweep();
    if (sessions.size >= config.maxSessions) throw Object.assign(new Error('Session capacity reached; retry later.'), { status: 429 });
    const session = newSession();
    sessions.set(session.id, session);
    return session;
  }
  return Object.freeze({
    create, revoke, sweep, now,
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
    begin(session, purpose, client, clientId = 'internal-test-client') {
      sweep();
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
      const state = randomToken();
      const tx = { state, correlation: randomToken(), nonce: randomToken(), verifier: randomToken(),
        expires: now() + config.transactionMs, sessionId: session.id, purpose, client, clientId,
        expectedOid: purpose === 'azure' ? session.claims?.oid : null };
      transactions.set(state, tx);
      clients.set(clientId, { start: bucket?.start ?? now(), count: (bucket?.count ?? 0) + 1 });
      logins++;
      return tx;
    },
    consume(state, correlation) {
      sweep();
      const tx = transactions.get(state);
      if (!tx || tx.consumed || !sameToken(tx.correlation, correlation)) throw Object.assign(new Error('Sign-in expired or browser correlation failed. Start again.'), { status: 400 });
      tx.consumed = true;
      if (!stored(tx.sessionId)) throw Object.assign(new Error('Sign-in session expired.'), { status: 400 });
      return tx;
    },
    hasTransaction(tx) { return Boolean(tx && transactions.get(tx.state) === tx && tx.expires > now()); },
    finish(prior, verified, tx) {
      sweep();
      if (tx && (transactions.get(tx.state) !== tx || tx.sessionId !== prior?.id || !tx.consumed || tx.expires <= now())) {
        throw Object.assign(new Error('Sign-in transaction expired or was cancelled.'), { status: 409 });
      }
      if (stored(prior?.id) !== prior) throw Object.assign(new Error('Sign-in session expired.'), { status: 401 });
      const operator = verified.claims?.tid === config.tenantId && entitled(verified.claims, config.policy);
      const destination = operator ? sessions : pending;
      const limit = operator ? config.maxSessions : config.maxTransactions;
      if (!destination.has(prior.id) && destination.size >= limit) throw Object.assign(new Error('Operator session capacity reached; retry later.'), { status: 429 });
      const next = Object.assign(newSession(), verified);
      revoke(prior);
      destination.set(next.id, next);
      return next;
    },
    endAuth(session, tx) {
      if (!session || stored(session.id) !== session) return;
      if (tx && transactions.get(tx.state) !== tx) return;
      for (const [id, active] of transactions) if (active.sessionId === session.id && (!tx || active === tx)) transactions.delete(id);
      session.authPending = [...transactions.values()].some((active) => active.sessionId === session.id);
    },
    invalidateContext(session) {
      session.contextVersion++;
      session.review = null;
      session.run?.controller.abort();
      session.subscription = null;
    },
    close() { for (const session of [...sessions.values(), ...pending.values()]) revoke(session); transactions.clear(); clients.clear(); },
  });
}
