/**
 * In-memory GitHub credential sessions.
 *
 * The credential exists only inside this process, only inside this map, and only
 * for the lifetime of the process. It is never written to `/data`, never placed
 * in a registry record, never returned to the browser, and never included in an
 * error, a log line, or an audit event.
 *
 * The browser receives an opaque session ID. Sessions are addressed by a
 * SHA-256 of that ID so that neither the map key nor any comparison exposes the
 * ID itself through timing.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { githubError } from './api.mjs';

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;

const FINE_GRAINED_PREFIX = 'github_pat_';
const CLASSIC_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];

function fingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Constant-time comparison for opaque identifiers of unequal length. */
export function sameOpaqueId(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(fingerprint(left), 'hex');
  const b = Buffer.from(fingerprint(right), 'hex');
  return timingSafeEqual(a, b);
}

/**
 * Validate the shape of a pasted credential before it is ever sent anywhere.
 *
 * Classic tokens are refused by default because their scope cannot be limited to
 * the selected repositories.
 */
export function classifyToken(value, options = {}) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) {
    throw githubError(400, 'GITHUB_TOKEN_REQUIRED', 'A GitHub token is required.');
  }
  if (token.length < 20 || token.length > 512) {
    throw githubError(400, 'GITHUB_TOKEN_INVALID', 'That does not look like a GitHub token.');
  }
  if (/[^\x21-\x7e]/.test(token)) {
    throw githubError(400, 'GITHUB_TOKEN_INVALID', 'That does not look like a GitHub token.');
  }
  if (token.startsWith(FINE_GRAINED_PREFIX)) return { token, kind: 'fine-grained' };
  if (CLASSIC_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    if (!options.allowClassic) {
      throw githubError(
        400,
        'GITHUB_TOKEN_CLASSIC',
        'Citadel UI requires a fine-grained personal access token limited to the intended repositories.'
      );
    }
    return { token, kind: 'classic' };
  }
  throw githubError(
    400,
    'GITHUB_TOKEN_INVALID',
    'Citadel UI requires a fine-grained personal access token (github_pat_...).'
  );
}

export class GitHubSessionStore {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.absoluteTimeoutMs = options.absoluteTimeoutMs ?? ABSOLUTE_TIMEOUT_MS;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.maxLoginAttempts = options.maxLoginAttempts ?? MAX_LOGIN_ATTEMPTS;
    this.loginWindowMs = options.loginWindowMs ?? LOGIN_WINDOW_MS;
    /** @type {Map<string, object>} keyed by SHA-256 of the opaque session ID */
    this.sessions = new Map();
    this.loginAttempts = [];
  }

  prune() {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (
        now - session.lastUsedAt > this.idleTimeoutMs ||
        now - session.createdAt > this.absoluteTimeoutMs
      ) {
        this.forget(key);
      }
    }
  }

  forget(key) {
    const session = this.sessions.get(key);
    if (session) session.token = null;
    this.sessions.delete(key);
  }

  /** Rate-limit credential submissions so a browser session cannot brute force. */
  assertLoginAllowed() {
    const now = this.now();
    this.loginAttempts = this.loginAttempts.filter(
      (stamp) => now - stamp < this.loginWindowMs
    );
    if (this.loginAttempts.length >= this.maxLoginAttempts) {
      throw githubError(
        429,
        'GITHUB_LOGIN_THROTTLED',
        'Too many GitHub connection attempts. Wait before retrying.'
      );
    }
    this.loginAttempts.push(now);
  }

  create(token, identity, meta = {}) {
    this.prune();
    if (this.sessions.size >= this.maxSessions) {
      throw githubError(
        429,
        'GITHUB_SESSION_LIMIT',
        'Too many GitHub sessions are active. Disconnect one first.'
      );
    }
    const id = randomBytes(32).toString('base64url');
    const now = this.now();
    this.sessions.set(fingerprint(id), {
      token,
      login: identity.login,
      accountId: identity.id,
      accountType: identity.type,
      tokenKind: meta.tokenKind || 'fine-grained',
      // Which saved connection this credential belongs to, or null for a
      // credential entered without one. Never leaves the process except as part
      // of a status word.
      profileId: meta.profileId || null,
      createdAt: now,
      lastUsedAt: now,
    });
    return { id, ...this.describe(this.sessions.get(fingerprint(id))) };
  }

  describe(session) {
    return {
      login: session.login,
      accountId: session.accountId,
      accountType: session.accountType,
      tokenKind: session.tokenKind,
      profileId: session.profileId || null,
      connectedAt: new Date(session.createdAt).toISOString(),
      idleExpiresAt: new Date(session.lastUsedAt + this.idleTimeoutMs).toISOString(),
      absoluteExpiresAt: new Date(session.createdAt + this.absoluteTimeoutMs).toISOString(),
    };
  }

  /**
   * Is a saved connection currently live?
   *
   * The opaque id is not retained anywhere, by design, so this answers only the
   * question the catalogue asks. Recovering a usable id for a profile means
   * minting a new session from the stored credential.
   */
  hasProfile(profileId) {
    if (!profileId) return false;
    this.prune();
    for (const session of this.sessions.values()) {
      if (session.profileId === profileId) return true;
    }
    return false;
  }

  /** The live credential for a saved connection, or null. */
  findByProfile(profileId) {
    if (!profileId) return null;
    this.prune();
    for (const session of this.sessions.values()) {
      if (session.profileId === profileId) return session;
    }
    return null;
  }

  /** Drop every session belonging to one saved connection. */
  destroyProfile(profileId) {
    if (!profileId) return 0;
    let removed = 0;
    for (const [key, session] of [...this.sessions]) {
      if (session.profileId === profileId) {
        this.forget(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Resolve a session and refresh its idle window.
   *
   * The returned object contains the credential and must never be serialized
   * into a response. Route handlers use `describe()` for anything user-visible.
   */
  resolve(sessionId) {
    this.prune();
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) {
      throw githubError(401, 'GITHUB_SESSION_REQUIRED', 'Connect GitHub to continue.');
    }
    const session = this.sessions.get(fingerprint(sessionId));
    if (!session) {
      throw githubError(401, 'GITHUB_SESSION_EXPIRED', 'The GitHub session expired. Reconnect GitHub.');
    }
    session.lastUsedAt = this.now();
    return session;
  }

  assertActive(session) {
    this.prune();
    if (!session || ![...this.sessions.values()].includes(session)) {
      throw githubError(401, 'GITHUB_SESSION_EXPIRED', 'The GitHub session expired. Reconnect GitHub.');
    }
    return session;
  }

  status(sessionId) {
    try {
      return { connected: true, ...this.describe(this.resolve(sessionId)) };
    } catch {
      return { connected: false };
    }
  }

  destroy(sessionId) {
    if (typeof sessionId !== 'string') return false;
    const key = fingerprint(sessionId);
    if (!this.sessions.has(key)) return false;
    this.forget(key);
    return true;
  }

  clear() {
    for (const key of [...this.sessions.keys()]) this.forget(key);
    this.loginAttempts = [];
  }

  get size() {
    this.prune();
    return this.sessions.size;
  }
}
