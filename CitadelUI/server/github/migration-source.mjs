import { createHash } from 'node:crypto';
import { GitHubSessionStore, classifyToken } from './sessions.mjs';
import { GitHubDonorReader } from './public-donor.mjs';
import { MigrationError, safeLabel } from '../../shared/migration-input.mjs';
import { MIGRATION_ATTEMPT_HEADER, MIGRATION_SOURCE_HEADER, privateDonorFailure } from '../../shared/migration-github-auth.mjs';

const fingerprint = (value) => createHash('sha256').update(String(value)).digest('hex');
const fail = (code, status = 400) => Object.assign(new MigrationError(code), { status, github: true });

/** Source credentials and snapshots never enter the editable session/cache realm. */
export class MigrationSourceRoutes {
  constructor(options) {
    this.client = options.client;
    this.editableSessions = options.editableSessions;
    this.profiles = options.profiles;
    this.vault = options.vault;
    this.listConnections = options.listConnections;
    this.allowClassicTokens = options.allowClassicTokens === true;
    this.sessions = new GitHubSessionStore(options.sessionOptions);
    this.readerOptions = options.readerOptions || {};
    this.readers = new Map();
    this.attempts = new Map();
  }

  prune() {
    this.sessions.prune();
    for (const [key, record] of this.readers) {
      if (!this.sessions.sessions.has(key)) {
        record.reader.snapshots.clear();
        this.readers.delete(key);
      }
    }
    for (const [key, attempt] of this.attempts) {
      if (this.sessions.now() - attempt.createdAt > 30 * 60 * 1000) {
        attempt.cancelled = true;
        this.attempts.delete(key);
      }
    }
  }

  eraseKey(key) {
    this.readers.get(key)?.reader.snapshots.clear();
    this.readers.delete(key);
    this.sessions.forget(key);
  }

  erase(id) {
    this.eraseKey(fingerprint(id));
    return { erased: true };
  }

  attempt(id, cancel = false) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw fail('private-input');
    this.prune();
    const key = fingerprint(id);
    let record = this.attempts.get(key);
    if (record && !cancel) throw fail('private-stale', 409);
    if (!record) {
      record = { createdAt: this.sessions.now(), cancelled: false, sessionKey: null };
      this.attempts.set(key, record);
      while (this.attempts.size > 64) {
        const oldest = this.attempts.keys().next().value;
        const evicted = this.attempts.get(oldest);
        evicted.cancelled = true;
        if (evicted.sessionKey) this.eraseKey(evicted.sessionKey);
        this.attempts.delete(oldest);
      }
    }
    if (cancel) {
      record.cancelled = true;
      if (record.sessionKey) this.eraseKey(record.sessionKey);
    }
    return record;
  }

  async identify(token) {
    const { data } = await this.client.request('/user', { token, method: 'GET', migrationRead: true });
    if (!Number.isSafeInteger(data?.id) || data.id <= 0 || typeof data.login !== 'string' ||
        !data.login || data.login.length > 100 || safeLabel(data.login) !== data.login) throw fail('private-read', 502);
    return { id: data.id, login: data.login, type: data.type || 'User' };
  }

  async profile(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || !this.profiles) {
      throw fail('private-profile', 409);
    }
    const profile = await this.profiles.get(id);
    if (!profile) throw fail('private-profile', 409);
    return profile;
  }

  async resolve(id) {
    this.prune();
    const session = this.sessions.resolve(id);
    const record = this.readers.get(fingerprint(id));
    if (!record) throw fail('private-auth-expired', 401);
    if (record.profile) {
      const current = await this.profile(record.profile.id);
      if (fingerprint(JSON.stringify(current)) !== record.profileFingerprint ||
          String(current.accountId) !== String(session.accountId)) {
        this.erase(id);
        throw fail('private-profile', 409);
      }
    }
    return { session, record };
  }

  status(session, record) {
    const description = this.sessions.describe(session);
    return {
      connected: true,
      account: { id: description.accountId, login: safeLabel(description.login) },
      profile: record.profile ? { id: record.profile.id, name: safeLabel(record.profile.name) } : null,
      credentialSource: record.profile ? 'saved-connection' : 'session-pat',
      idleExpiresAt: description.idleExpiresAt,
      absoluteExpiresAt: description.absoluteExpiresAt,
    };
  }

  async connect(body, attemptId) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !['token', 'profileId'].includes(Object.keys(body)[0])) throw fail('private-input');
    this.prune();
    this.sessions.assertLoginAllowed();
    const attempt = this.attempt(attemptId);
    let profile = null;
    let token;
    if (Object.hasOwn(body, 'profileId')) {
      profile = await this.profile(body.profileId);
      // Do not call resume/reconnect: those revoke ordinary destination sessions.
      token = this.editableSessions.findByProfile(profile.id)?.token;
      if (!token && this.vault?.available) token = await this.vault.load(profile.id, profile.accountId);
      if (!token) throw fail('private-profile', 409);
    } else token = body.token;
    const classified = classifyToken(token, { allowClassic: this.allowClassicTokens });
    token = classified.token;
    const identity = await this.identify(token);
    if (profile && String(identity.id) !== String(profile.accountId)) throw fail('private-account', 409);
    if (profile && fingerprint(JSON.stringify(await this.profile(profile.id))) !== fingerprint(JSON.stringify(profile))) {
      throw fail('private-stale', 409);
    }
    if (attempt.cancelled) throw fail('private-stale', 409);
    const created = this.sessions.create(token, identity, { tokenKind: classified.kind, profileId: profile?.id });
    const id = created.id;
    attempt.sessionKey = fingerprint(id);
    const record = {
      profile,
      profileFingerprint: profile ? fingerprint(JSON.stringify(profile)) : null,
      reader: new GitHubDonorReader({
        ...this.readerOptions,
        allowPrivate: true,
        readOnlyRequest: async (path, { limit }) => {
          try {
            const { session } = await this.resolve(id);
            const response = await this.client.request(path, {
              token: session.token, method: 'GET', migrationRead: true, limit,
            });
            await this.resolve(id);
            return response;
          } catch (error) {
            if (error?.status === 401 || /GITHUB_SESSION_/.test(error?.code || '')) this.erase(id);
            throw error;
          }
        },
      }),
    };
    this.readers.set(fingerprint(id), record);
    return { sessionId: id, status: this.status(this.sessions.resolve(id), record) };
  }

  async handle({ req, url, operation, readBody }) {
    const id = req.headers[MIGRATION_SOURCE_HEADER.toLowerCase()];
    const attemptId = req.headers[MIGRATION_ATTEMPT_HEADER.toLowerCase()];
    try {
      if (operation === 'session') {
        if ([...url.searchParams].length) throw fail('private-input');
        if (req.method === 'POST') {
          if (id) throw fail('private-input');
          return await this.connect(await readBody(), attemptId);
        }
        if (req.method === 'DELETE') {
          if (attemptId && id) throw fail('private-input');
          if (attemptId && !id) {
            this.attempt(attemptId, true);
            return { erased: true };
          }
          if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw fail('private-auth-required', 401);
          return this.erase(id);
        }
        if (req.method === 'GET') {
          const { session, record } = await this.resolve(id);
          return { status: this.status(session, record) };
        }
        throw fail('private-read-only', 405);
      }
      if (req.method !== 'GET') throw fail('private-read-only', 405);
      if (operation === 'connections') {
        if ([...url.searchParams].length) throw fail('private-input');
        if (!this.profiles) throw fail('private-profile', 409);
        const connections = await this.listConnections();
        return {
          vault: { available: connections.vault.available === true },
          profiles: connections.profiles.map((profile) => ({
            id: profile.id, name: safeLabel(profile.name), accountLogin: safeLabel(profile.accountLogin),
            accountId: profile.accountId, status: profile.status, credentialMode: profile.credentialMode,
          })),
        };
      }
      if (!['repository', 'snapshot', 'verify', 'blob'].includes(operation)) throw fail('private-input');
      const { record } = await this.resolve(id);
      const result = await record.reader.handle({ req, url, operation });
      await this.resolve(id);
      return result;
    } catch (error) {
      const safe = privateDonorFailure(error);
      if (['private-auth-expired', 'private-auth-invalid', 'private-profile'].includes(safe.code) && id) this.erase(id);
      throw Object.assign(safe, {
        status: Number.isInteger(error?.status) ? error.status : safe.code === 'private-input' ? 400 : 502,
        github: true,
      });
    }
  }
}
