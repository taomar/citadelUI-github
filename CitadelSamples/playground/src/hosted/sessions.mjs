import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = '__Host-citadel';
export const CORRELATION_COOKIE = '__Host-citadel-login';
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

export function sessionCookie(value, { correlation = false, clear = false } = {}) {
  return `${correlation ? CORRELATION_COOKIE : SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=${correlation ? 'Lax' : 'Strict'}${clear ? '; Max-Age=0' : correlation ? '; Max-Age=300' : ''}`;
}

export function entitled(claims, policy) {
  if (!policy || !claims) return false;
  return (policy.requiredRole && Array.isArray(claims.roles) && claims.roles.includes(policy.requiredRole))
    || policy.allowedPrincipalIds.includes(claims.oid)
    || (Array.isArray(claims.groups) && claims.groups.some((group) => policy.allowedGroupIds.includes(group)));
}

export function createSessions(config, { now = Date.now } = {}) {
  const sessions = new Map();
  const transactions = new Map();
  let loginWindow = 0;
  let logins = 0;
  function revoke(session) {
    if (!session) return;
    session.controller.abort();
    session.cache = null;
    session.account = null;
    sessions.delete(session.id);
    for (const [id, transaction] of transactions) if (transaction.sessionId === session.id) transactions.delete(id);
  }
  function sweep() {
    const time = now();
    for (const session of sessions.values()) {
      if (time - session.touched >= config.idleMs || time - session.created >= config.absoluteMs
        || (session.claims && session.claims.exp * 1000 <= time)) revoke(session);
    }
    for (const [id, tx] of transactions) if (tx.expires <= time) transactions.delete(id);
  }
  function create() {
    sweep();
    if (sessions.size >= config.maxSessions) throw Object.assign(new Error('Session capacity reached; retry later.'), { status: 429 });
    const session = { id: randomToken(), csrf: randomToken(), created: now(), touched: now(), claims: null,
      account: null, cache: null, subscription: null, contextVersion: 0, controller: new AbortController(), run: null };
    sessions.set(session.id, session);
    return session;
  }
  return Object.freeze({
    create, revoke, sweep, now,
    get(id, { touch = true } = {}) {
      sweep();
      const session = sessions.get(id);
      if (session && touch) session.touched = now();
      return session ?? null;
    },
    authorized(session) {
      sweep();
      return Boolean(session && sessions.get(session.id) === session && session.claims
        && session.claims.tid === config.tenantId && entitled(session.claims, config.policy));
    },
    begin(session, purpose, client) {
      sweep();
      if (sessions.get(session?.id) !== session) throw Object.assign(new Error('Session expired. Sign in again.'), { status: 401 });
      if (now() - loginWindow >= 60000) { loginWindow = now(); logins = 0; }
      if (++logins > 30 || transactions.size >= config.maxTransactions) throw Object.assign(new Error('Sign-in limit reached; retry shortly.'), { status: 429 });
      for (const tx of transactions.values()) if (tx.sessionId === session.id) throw Object.assign(new Error('Sign-in is already pending.'), { status: 409 });
      const state = randomToken();
      const tx = { state, correlation: randomToken(), nonce: randomToken(), verifier: randomToken(),
        expires: now() + config.transactionMs, sessionId: session.id, purpose, client,
        expectedOid: purpose === 'azure' ? session.claims?.oid : null };
      transactions.set(state, tx);
      return tx;
    },
    consume(state, correlation) {
      sweep();
      const tx = transactions.get(state);
      if (!tx || !sameToken(tx.correlation, correlation)) throw Object.assign(new Error('Sign-in expired or browser correlation failed. Start again.'), { status: 400 });
      transactions.delete(state);
      if (!sessions.has(tx.sessionId)) throw Object.assign(new Error('Sign-in session expired.'), { status: 400 });
      return tx;
    },
    invalidateContext(session) {
      session.contextVersion++;
      session.review = null;
      session.run?.controller.abort();
      session.subscription = null;
    },
    close() { for (const session of sessions.values()) revoke(session); transactions.clear(); },
  });
}
