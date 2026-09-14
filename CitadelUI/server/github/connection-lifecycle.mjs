import { githubError } from './api.mjs';
import { classifyToken } from './sessions.mjs';
import { profileName as profileNameOf } from '../connections.mjs';
import { sameAccount } from '../credentials.mjs';

/**
 * The one definition of what a connection's status word means.
 *
 * Computed server-side and sent as a word, rather than sent as three booleans
 * the catalogue re-derives: the badge in the connections list, the badge on a
 * saved workspace row, and any future surface must all agree, and they only
 * agree if one place decides.
 */
export function connectionStatus({ connected, persisted, vaultAvailable }) {
  if (connected) return persisted ? 'persistent' : 'session';
  if (persisted) return vaultAvailable ? 'persistent-idle' : 'unavailable';
  return 'reconnect';
}

/** Borrow the route owner's stores and cache erasure; create no credential state. */
export function createConnectionLifecycle(ports) {
  const { assertKeys } = ports;
  return {
    get sessions() { return ports.sessions; },
    get profiles() { return ports.profiles; },
    get vault() { return ports.vault; },
    get client() { return ports.client; },
    get allowClassicTokens() { return ports.allowClassicTokens; },
    note(event) { return ports.note(event); },
    forgetCaches() { return ports.forgetCaches(); },

    requireProfiles() {
      if (!this.profiles) {
        throw githubError(
          503,
          'CONNECTIONS_UNAVAILABLE',
          'Saved GitHub connections are not available in this deployment.'
        );
      }
      return this.profiles;
    },

    profileIdOf(value) {
      const id = String(value || '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
        throw githubError(400, 'INVALID_CONNECTION', 'Invalid connection id.');
      }
      return id;
    },

    async connect(body) {
      assertKeys(body, new Set(['token']));
      this.sessions.assertLoginAllowed();
      const { token, kind } = classifyToken(body.token, { allowClassic: this.allowClassicTokens });
      const identity = await this.identify(token);
      // The credential is handed to the store and nothing else. It is never
      // returned, logged, or written to disk.
      return this.sessions.create(token, identity, { tokenKind: kind });
    },

    /** Validate a credential against GitHub and read the account it belongs to. */
    async identify(token) {
      const { data } = await this.client.request('/user', { token });
      if (!data || typeof data.login !== 'string' || typeof data.id !== 'number') {
        throw githubError(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected account.');
      }
      return { login: data.login, id: data.id, type: data.type || 'User' };
    },

    /**
     * Every saved connection, with the one status word the UI renders.
     *
     * Carries no credential and no session id. A browser that has lost its opaque
     * id learns from this only *that* a connection can be resumed, and must ask
     * for a session explicitly.
     */
    async connections() {
      const profiles = await this.requireProfiles().list();
      const vaultAvailable = Boolean(this.vault?.available);
      const rows = [];
      for (const profile of profiles) {
        const persisted = this.vault ? await this.vault.has(profile.id) : false;
        rows.push({
          ...profile,
          persisted,
          connected: this.sessions.hasProfile(profile.id),
          status: connectionStatus({
            connected: this.sessions.hasProfile(profile.id),
            persisted,
            vaultAvailable,
          }),
        });
      }
      return { vault: this.vault ? this.vault.status() : { available: false, reason: 'disabled' }, profiles: rows };
    },

    /**
     * Seal a credential for later, or refuse honestly.
     *
     * Persistence failing is never allowed to fail the connection: the user is
     * connected either way, and the response says whether the box they ticked
     * actually took effect. Silently reporting success for a credential that was
     * not stored would promise a restart-survival that does not exist.
     */
    async persist(profile, token) {
      if (!this.vault?.available) return { persisted: false, reason: 'persistence-unavailable' };
      try {
        const stored = await this.vault.store(profile.id, profile.accountId, token);
        return stored
          ? { persisted: true, reason: null }
          : { persisted: false, reason: 'persistence-unavailable' };
      } catch {
        return { persisted: false, reason: 'persistence-unavailable' };
      }
    },

    /** Shape of every successful connect/reconnect/resume answer. */
    async connectionResult(profile, session, persisted, reason = null) {
      return {
        profile: {
          ...profile,
          persisted,
          connected: true,
          status: connectionStatus({
            connected: true,
            persisted,
            vaultAvailable: Boolean(this.vault?.available),
          }),
        },
        session,
        persisted,
        persistenceReason: reason,
        vault: this.vault ? this.vault.status() : { available: false, reason: 'disabled' },
      };
    },

    /**
     * Create a named connection from a freshly entered credential.
     *
     * The name is required before the token is accepted, and is validated first,
     * so a rejected name never costs the user a token paste. If the account is
     * already saved under another name the request is refused rather than
     * duplicated — the same identity twice is a mistake, not two connections.
     */
    async createConnection(body) {
      assertKeys(body, new Set(['name', 'token', 'persist']));
      const profiles = this.requireProfiles();
      const name = profileNameOf(body.name);
      this.sessions.assertLoginAllowed();
      const { token, kind } = classifyToken(body.token, { allowClassic: this.allowClassicTokens });
      let identity;
      try {
        identity = await this.identify(token);
      } catch (error) {
        this.note({ action: 'connection.create', outcome: 'failed', target: name });
        throw error;
      }
      const existing = await profiles.findByAccount(identity.id);
      if (existing) {
        this.note({
          action: 'connection.create',
          outcome: 'refused',
          reason: 'duplicate-name',
          target: name,
          account: identity.login,
        });
        throw githubError(
          409,
          'CONNECTION_ACCOUNT_TAKEN',
          `${identity.login} is already saved as "${existing.name}". Reconnect that connection instead.`,
          { profileId: existing.id }
        );
      }
      const profile = await profiles.create({
        name,
        accountId: identity.id,
        accountLogin: identity.login,
        accountType: identity.type,
        credentialMode: body.persist === true ? 'persistent' : 'session',
      });
      const { persisted, reason } =
        body.persist === true ? await this.persist(profile, token) : { persisted: false, reason: null };
      if (body.persist === true && !persisted) {
        await profiles.update(profile.id, { credentialMode: 'session' });
      }
      const session = this.sessions.create(token, identity, {
        tokenKind: kind,
        profileId: profile.id,
      });
      this.note({
        action: 'connection.create',
        outcome: 'ok',
        target: profile.name,
        account: identity.login,
      });
      if (persisted) {
        this.note({
          action: 'connection.persistence-enabled',
          outcome: 'ok',
          target: profile.name,
          account: identity.login,
        });
      }
      return this.connectionResult(
        { ...profile, credentialMode: persisted ? 'persistent' : 'session' },
        session,
        persisted,
        reason
      );
    },

    /**
     * Replace the credential behind an existing connection.
     *
     * The new token must resolve to the same immutable account id. A token for a
     * different account is refused and the user is told to create a separate
     * connection: rebinding would leave every workspace attached to this profile
     * silently pointing at repositories chosen by someone else.
     */
    async reconnectConnection(profileId, body) {
      assertKeys(body, new Set(['token', 'persist']));
      const profiles = this.requireProfiles();
      const profile = await profiles.get(profileId);
      if (!profile) {
        throw githubError(404, 'UNKNOWN_CONNECTION', 'That GitHub connection is not saved.');
      }
      this.sessions.assertLoginAllowed();
      const { token, kind } = classifyToken(body.token, { allowClassic: this.allowClassicTokens });
      const identity = await this.identify(token);
      if (!sameAccount(identity.id, profile.accountId)) {
        this.note({
          action: 'connection.reconnect',
          outcome: 'refused',
          reason: 'account-mismatch',
          target: profile.name,
          account: identity.login,
        });
        throw githubError(
          409,
          'CONNECTION_ACCOUNT_MISMATCH',
          `That token belongs to ${identity.login}, but "${profile.name}" is bound to ${profile.accountLogin}. Add a separate connection for ${identity.login}.`,
          { expectedLogin: profile.accountLogin, actualLogin: identity.login }
        );
      }
      this.sessions.destroyProfile(profile.id);
      const wantsPersistence = body.persist === undefined
        ? profile.credentialMode === 'persistent'
        : body.persist === true;
      // The previous envelope goes first, unconditionally. Sealing can fail — a
      // full or read-only data volume — and `persist` reports that without
      // throwing, so gating removal on the outcome would leave the *old* token on
      // disk under a profile now marked session-only. A later restart would then
      // silently reconnect with the credential the user came here to replace.
      await this.vault?.remove(profile.id);
      const { persisted, reason } = wantsPersistence
        ? await this.persist(profile, token)
        : { persisted: false, reason: null };
      const updated = await profiles.update(profile.id, {
        credentialMode: persisted ? 'persistent' : 'session',
        connected: true,
      });
      const session = this.sessions.create(token, identity, {
        tokenKind: kind,
        profileId: profile.id,
      });
      this.note({
        action: 'connection.reconnect',
        outcome: 'ok',
        target: updated.name,
        account: updated.accountLogin,
      });
      return this.connectionResult(updated, session, persisted, reason);
    },

    /**
     * Restore a connection from its encrypted envelope, with no user interaction.
     *
     * This is the whole point of the checkbox: the browser asks for a session, the
     * server unseals the credential it already holds, validates it is still good,
     * and hands back an opaque id. The token never crosses the process boundary.
     */
    async resumeConnection(profileId) {
      const profiles = this.requireProfiles();
      const profile = await profiles.get(profileId);
      if (!profile) {
        throw githubError(404, 'UNKNOWN_CONNECTION', 'That GitHub connection is not saved.');
      }
      if (!this.vault?.available) {
        throw githubError(
          409,
          'CREDENTIAL_UNAVAILABLE',
          'The encrypted credential store is unavailable. Reconnect this connection with a token.'
        );
      }
      const token = await this.vault.load(profile.id, profile.accountId);
      if (!token) {
        this.note({
          action: 'connection.restore',
          outcome: 'failed',
          reason: 'credential-unavailable',
          target: profile.name,
          account: profile.accountLogin,
        });
        throw githubError(
          409,
          'CREDENTIAL_UNAVAILABLE',
          `The saved credential for "${profile.name}" could not be opened. Reconnect it with a token.`
        );
      }
      let identity;
      try {
        identity = await this.identify(token);
      } catch (error) {
        this.note({
          action: 'connection.restore',
          outcome: 'failed',
          reason: 'credential-expired',
          target: profile.name,
          account: profile.accountLogin,
        });
        throw error;
      }
      if (!sameAccount(identity.id, profile.accountId)) {
        // The sealed credential no longer belongs to the account this profile is
        // bound to. Refuse and remove it rather than connect as someone else.
        await this.vault.remove(profile.id);
        this.note({
          action: 'connection.restore',
          outcome: 'refused',
          reason: 'account-mismatch',
          target: profile.name,
          account: profile.accountLogin,
        });
        throw githubError(
          409,
          'CONNECTION_ACCOUNT_MISMATCH',
          `The saved credential for "${profile.name}" no longer belongs to ${profile.accountLogin}. Reconnect it with a token.`
        );
      }
      this.sessions.destroyProfile(profile.id);
      const session = this.sessions.create(token, identity, {
        tokenKind: 'fine-grained',
        profileId: profile.id,
      });
      const updated = await profiles.update(profile.id, { connected: true });
      this.note({
        action: 'connection.restore',
        outcome: 'ok',
        target: updated.name,
        account: updated.accountLogin,
      });
      return this.connectionResult(updated, session, true, null);
    },

    async renameConnection(profileId, body) {
      assertKeys(body, new Set(['name']));
      const profiles = this.requireProfiles();
      const updated = await profiles.update(profileId, { name: profileNameOf(body.name) });
      this.note({
        action: 'connection.rename',
        outcome: 'ok',
        target: updated.name,
        account: updated.accountLogin,
      });
      return { profile: updated };
    },

    /**
     * Turn encrypted persistence on or off for one connection.
     *
     * Turning it on needs the live credential, because the envelope is sealed from
     * the token itself — there is nothing to encrypt if the connection is idle.
     * Turning it off deletes the envelope immediately rather than marking it
     * disabled, so unchecking the box actually removes the stored bytes.
     */
    async setConnectionPersistence(profileId, body) {
      assertKeys(body, new Set(['persist']));
      const profiles = this.requireProfiles();
      const profile = await profiles.get(profileId);
      if (!profile) {
        throw githubError(404, 'UNKNOWN_CONNECTION', 'That GitHub connection is not saved.');
      }
      if (body.persist === true) {
        if (!this.vault?.available) {
          throw githubError(
            409,
            'PERSISTENCE_UNAVAILABLE',
            'This deployment has no credential key mounted, so connections cannot be saved on this device.'
          );
        }
        const session = this.sessions.findByProfile(profile.id);
        if (!session) {
          throw githubError(
            409,
            'CONNECTION_NOT_LIVE',
            `Reconnect "${profile.name}" first, then save it on this device.`
          );
        }
        const { persisted, reason } = await this.persist(profile, session.token);
        if (!persisted) {
          throw githubError(
            500,
            'PERSISTENCE_FAILED',
            'The credential could not be encrypted. It has not been saved.',
            { reason }
          );
        }
        const updated = await profiles.update(profile.id, { credentialMode: 'persistent' });
        this.note({
          action: 'connection.persistence-enabled',
          outcome: 'ok',
          target: updated.name,
          account: updated.accountLogin,
        });
        return { profile: { ...updated, persisted: true, connected: true, status: 'persistent' } };
      }
      await this.vault?.remove(profile.id);
      const updated = await profiles.update(profile.id, { credentialMode: 'session' });
      this.note({
        action: 'connection.persistence-disabled',
        outcome: 'ok',
        target: updated.name,
        account: updated.accountLogin,
      });
      const connected = this.sessions.hasProfile(profile.id);
      return {
        profile: {
          ...updated,
          persisted: false,
          connected,
          status: connectionStatus({
            connected,
            persisted: false,
            vaultAvailable: Boolean(this.vault?.available),
          }),
        },
      };
    },

    /** End the live session but keep the connection and any stored credential. */
    async disconnectConnection(profileId) {
      const profiles = this.requireProfiles();
      const profile = await profiles.get(profileId);
      if (!profile) {
        throw githubError(404, 'UNKNOWN_CONNECTION', 'That GitHub connection is not saved.');
      }
      const removed = this.sessions.destroyProfile(profile.id);
      this.forgetCaches();
      const persisted = this.vault ? await this.vault.has(profile.id) : false;
      this.note({
        action: 'connection.disconnect',
        outcome: 'ok',
        target: profile.name,
        account: profile.accountLogin,
      });
      return {
        disconnected: removed > 0,
        profile: {
          ...profile,
          persisted,
          connected: false,
          status: connectionStatus({
            connected: false,
            persisted,
            vaultAvailable: Boolean(this.vault?.available),
          }),
        },
      };
    },

    /**
     * Remove a saved connection and its credential.
     *
     * This deletes metadata and encrypted bytes on this device. It does not touch
     * GitHub: no branch is deleted, no token is revoked, and every workspace that
     * referenced this connection stays exactly where it is, marked as needing a
     * reconnection.
     */
    async removeConnection(profileId) {
      const profiles = this.requireProfiles();
      const profile = await profiles.remove(profileId);
      if (!profile) {
        throw githubError(404, 'UNKNOWN_CONNECTION', 'That GitHub connection is not saved.');
      }
      this.sessions.destroyProfile(profile.id);
      this.forgetCaches();
      await this.vault?.remove(profile.id);
      this.note({
        action: 'connection.remove',
        outcome: 'ok',
        target: profile.name,
        account: profile.accountLogin,
      });
      return { removed: true, profileId: profile.id };
    },
  };
}
