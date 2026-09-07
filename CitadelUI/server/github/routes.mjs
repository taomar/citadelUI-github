/**
 * Same-origin GitHub routes.
 *
 * The browser never calls GitHub. Every route here runs after the existing host,
 * origin, fetch-site, session-token, body-size, and concurrency checks, and then
 * additionally requires an opaque GitHub credential session id, except for the
 * explicit anonymous, GET-only public-donor route.
 *
 * Editable workspace repository/branch identity comes from the authoritative
 * registry, never the request body. Public donors are separate ephemeral
 * selections: they cannot redirect or attach an editable environment.
 */
import { GitHubApiClient, githubError } from './api.mjs';
import { PublicGitHubDonorRoutes } from './public-donor.mjs';
import { MigrationSourceRoutes } from './migration-source.mjs';
import { classifyToken, GitHubSessionStore } from './sessions.mjs';
import {
  AttachmentReservations,
  RESERVATION_PENDING,
  reservationFingerprint,
} from './attachments.mjs';
import {
  getRepository,
  listBranches,
  listRepositories,
  validateBranchName,
  validateCommitSha,
  validateRepositoryId,
  workingBranchName,
  BLOB_MODE_FILE,
  WORKING_BRANCH_PREFIX,
} from './repositories.mjs';
import {
  assertAction,
  branchHead,
  commitChangeSet,
  createCommitBranch,
  ensureWorkingBranch,
  inspectCommit,
  loadHistory,
  loadTree,
  readBlob,
  readSourceBlob,
  readSubscriptionId,
  requireBranchHead,
  revertCommit,
} from './workspace.mjs';
import {
  readSubscriptionIdFromText,
  validateSubscriptionId,
  writeSubscriptionIdToText,
} from '../../shared/subscription-env.mjs';
import { MAX_ENV_BYTES, subscriptionEnvironmentAlias } from '../../shared/source-scope.mjs';
import {
  assertAttachableRepository,
  inspectBranchCompatibility,
} from './compatibility.mjs';
import { profileName as profileNameOf } from '../connections.mjs';
import { sameAccount } from '../credentials.mjs';

const SESSION_HEADER = 'x-citadel-github-session';

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

function assertKeys(body, allowed) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.has(key))
  ) {
    throw githubError(400, 'INVALID_CONTENT', 'Request contains unsupported fields.');
  }
}

function environmentIdOf(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw githubError(400, 'INVALID_ENVIRONMENT', 'Invalid environment id.');
  }
  return id;
}

function transactionIdOf(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    throw githubError(400, 'INVALID_TRANSACTION', 'Invalid transaction id.');
  }
  return id;
}

/** Client-chosen idempotency key for an attach, so a lost response can retry. */
function operationKeyOf(value, optional = false) {
  if (value === undefined || value === null) {
    if (optional) return null;
    return null;
  }
  const key = String(value);
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(key)) {
    throw githubError(400, 'INVALID_OPERATION_KEY', 'Invalid attachment operation key.');
  }
  return key;
}

export class GitHubRoutes {
  constructor(options = {}) {
    this.sessions = options.sessions || new GitHubSessionStore(options.sessionOptions);
    this.client = options.client || new GitHubApiClient(options.clientOptions);
    // Same fixed-host client, but no credential store or session is passed to
    // the public donor. Its separate facade permits anonymous GETs only.
    this.publicDonor = new PublicGitHubDonorRoutes({ client: this.client, ...(options.publicDonorOptions || {}) });
    this.registryStore = options.registryStore;
    this.audit = options.audit || null;
    this.profiles = options.profiles || null;
    this.vault = options.vault || null;
    this.activity = options.activity || null;
    this.attachments = options.attachments || new AttachmentReservations();
    this.allowClassicTokens = Boolean(options.allowClassicTokens);
    this.migrationSource = new MigrationSourceRoutes({
      client: this.client, editableSessions: this.sessions, profiles: this.profiles, vault: this.vault,
      listConnections: () => this.connections(), allowClassicTokens: this.allowClassicTokens,
      ...(options.migrationSourceOptions || {}),
    });
    // Trees are immutable for a given commit, so caching by commit SHA is safe
    // and keeps an alias-scoped blob read from refetching the tree per file.
    this.treeCache = new Map();
    this.treeCacheLimit = options.treeCacheLimit ?? 8;
    // Blobs are content-addressed, so a SHA hit is the same bytes by
    // definition. Bounded, in memory only, and never written to `/data`.
    this.blobCache = new Map();
    this.blobCacheLimit = options.blobCacheLimit ?? 512;
  }

  /** Governance events never fail the operation they describe. */
  note(event) {
    if (!this.activity) return;
    Promise.resolve(this.activity.record(event)).catch(() => {});
  }

  requireProfiles() {
    if (!this.profiles) {
      throw githubError(
        503,
        'CONNECTIONS_UNAVAILABLE',
        'Saved GitHub connections are not available in this deployment.'
      );
    }
    return this.profiles;
  }

  profileIdOf(value) {
    const id = String(value || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw githubError(400, 'INVALID_CONNECTION', 'Invalid connection id.');
    }
    return id;
  }

  async tree(token, fullName, commitSha) {
    const key = `${fullName}:${commitSha}`;
    if (!this.treeCache.has(key)) {
      const snapshot = await loadTree(this.client, token, fullName, commitSha);
      this.treeCache.set(key, snapshot);
      while (this.treeCache.size > this.treeCacheLimit) {
        this.treeCache.delete(this.treeCache.keys().next().value);
      }
    }
    return this.treeCache.get(key);
  }

  /**
   * Read one in-scope source, reusing an identical blob already in memory.
   *
   * A Git blob SHA is a hash of its bytes, so a hit is the same bytes by
   * construction — this is a content-addressed cache, not a guess about
   * freshness. Which blob a *path* points to still comes from the tree for the
   * exact head every time, so the cache can never answer with a stale revision
   * of a file: the key changes the moment the content does.
   *
   * It matters because ten templates were being fetched sixteen times for one
   * scan, and the whole scan ran again on reopen. The bytes live only in this
   * process and are never written to `/data`.
   */
  async blob(token, fullName, head, alias, sha, snapshot, repositoryId) {
    const entry = snapshot?.files?.find((file) => file.alias === alias) || null;
    // Only an entry the alias resolves to in this exact tree may be served from
    // cache. Anything else falls through to the authoritative read, which
    // performs the scope and precondition checks.
    const key = entry ? `${repositoryId}:${entry.sha}` : null;
    if (key && this.blobCache.has(key)) {
      const hit = this.blobCache.get(key);
      // Refresh recency: a Map preserves insertion order, so re-inserting is
      // what makes the bounded eviction least-recently-used rather than
      // first-in.
      this.blobCache.delete(key);
      this.blobCache.set(key, hit);
      return hit;
    }
    const blob = await readSourceBlob(this.client, token, fullName, head, alias, sha, snapshot);
    if (key && blob?.sha === entry.sha) {
      this.blobCache.set(key, blob);
      while (this.blobCache.size > this.blobCacheLimit) {
        this.blobCache.delete(this.blobCache.keys().next().value);
      }
    }
    return blob;
  }

  /** Forget cached trees and blobs, on disconnect or an identity change. */
  forgetCaches() {
    this.treeCache.clear();
    this.blobCache.clear();
  }

  session(req) {
    return this.sessions.resolve(req.headers[SESSION_HEADER]);
  }

  /** Authoritative GitHub source for an environment, from the /data mirror. */
  async source(environmentId) {
    const id = environmentIdOf(environmentId);
    const environment = await this.registryStore.getEnvironment(id);
    if (!environment) {
      throw githubError(404, 'UNKNOWN_ENVIRONMENT', 'That environment is not registered.');
    }
    if (environment.source?.kind !== 'github') {
      throw githubError(400, 'NOT_GITHUB_ENVIRONMENT', 'That environment is not a GitHub repository.');
    }
    return { environmentId: id, ...environment.source };
  }

  /**
   * Re-resolve the repository by immutable id on every workspace operation so a
   * rename or transfer cannot silently retarget an attached environment.
   *
   * Ownership is enforced here as well, because this is the one place every
   * read and every write passes through. A workspace attached through one
   * connection must not be edited under another account's credential: the
   * repository and branch were chosen with that connection's access, and the
   * commit would be attributed to whoever happens to be connected now.
   */
  async resolve(req, environmentId) {
    const session = this.session(req);
    const source = await this.source(environmentId);
    this.assertOwnership(session, source);
    const repository = await getRepository(this.client, session.token, source.repositoryId);
    if (repository.fullName !== source.fullName) {
      throw githubError(
        409,
        'REPOSITORY_RENAMED',
        `This repository is now ${repository.fullName}. Reattach the environment before saving.`
      );
    }
    return { session, source, repository, token: session.token };
  }

  /**
   * Refuse a credential that does not belong to the environment's connection.
   *
   * An environment with no recorded connection predates named connections and is
   * left alone here: it is refused earlier, in the browser, and marking it
   * unusable server-side would strand a v3 record with no path back.
   */
  assertOwnership(session, source) {
    if (!source.connectionProfileId) return;
    if (session.profileId === source.connectionProfileId) return;
    throw githubError(
      409,
      'CONNECTION_MISMATCH',
      'This workspace was attached through a different GitHub connection. Reconnect that connection before opening it.'
    );
  }

  async connect(body) {
    assertKeys(body, new Set(['token']));
    this.sessions.assertLoginAllowed();
    const { token, kind } = classifyToken(body.token, { allowClassic: this.allowClassicTokens });
    const identity = await this.identify(token);
    // The credential is handed to the store and nothing else. It is never
    // returned, logged, or written to disk.
    return this.sessions.create(token, identity, { tokenKind: kind });
  }

  /** Validate a credential against GitHub and read the account it belongs to. */
  async identify(token) {
    const { data } = await this.client.request('/user', { token });
    if (!data || typeof data.login !== 'string' || typeof data.id !== 'number') {
      throw githubError(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected account.');
    }
    return { login: data.login, id: data.id, type: data.type || 'User' };
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  /**
   * Route dispatcher for `/api/github/*`.
   *
   * @returns {Promise<object>} plain JSON payload, never containing a credential
   */
  async handle({ req, url, parts, readBody }) {
    const method = req.method;
    const tail = parts.slice(2);

    if (tail[0] === 'migration-source' && tail.length === 2) {
      return this.migrationSource.handle({ req, url, operation: tail[1], readBody });
    }

    // The normal owner/browser transport guard still runs in server/index.mjs.
    // This is the sole source-reading path that does NOT resolve a PAT/session.
    if (tail[0] === 'public-donor' && tail.length === 2) {
      return this.publicDonor.handle({ req, url, operation: tail[1] });
    }

    if (method === 'POST' && tail[0] === 'sessions' && tail.length === 1) {
      return this.connect(await readBody());
    }
    if (method === 'GET' && tail[0] === 'sessions' && tail.length === 1) {
      return this.sessions.status(req.headers[SESSION_HEADER]);
    }
    if (method === 'DELETE' && tail[0] === 'sessions' && tail.length === 2) {
      // Report what actually happened. The browser only forgets its opaque id
      // once the credential is confirmed gone, so a transport failure surfaces
      // rather than silently leaving a live session behind.
      const disconnected = this.sessions.destroy(tail[1]);
      this.forgetCaches();
      return { disconnected, erased: true };
    }

    // Saved connections. These manage credentials rather than use one, so they
    // are authorised by the browser session alone and never require a GitHub
    // session header — a browser that has lost its opaque id must still be able
    // to resume a connection it saved.
    if (method === 'GET' && tail[0] === 'connections' && tail.length === 1) {
      return this.connections();
    }
    if (method === 'POST' && tail[0] === 'connections' && tail.length === 1) {
      return this.createConnection(await readBody());
    }
    if (method === 'DELETE' && tail[0] === 'connections' && tail.length === 2) {
      return this.removeConnection(this.profileIdOf(tail[1]));
    }
    if (method === 'POST' && tail[0] === 'connections' && tail.length === 3) {
      const profileId = this.profileIdOf(tail[1]);
      if (tail[2] === 'reconnect') return this.reconnectConnection(profileId, await readBody());
      if (tail[2] === 'resume') return this.resumeConnection(profileId);
      if (tail[2] === 'rename') return this.renameConnection(profileId, await readBody());
      if (tail[2] === 'persistence') {
        return this.setConnectionPersistence(profileId, await readBody());
      }
      if (tail[2] === 'disconnect') return this.disconnectConnection(profileId);
    }

    if (method === 'GET' && tail[0] === 'repos' && tail.length === 1) {
      const session = this.session(req);
      return listRepositories(this.client, session.token);
    }
    if (method === 'GET' && tail[0] === 'repos' && tail[2] === 'branches' && tail.length === 3) {
      const session = this.session(req);
      return listBranches(this.client, session.token, validateRepositoryId(tail[1]));
    }
    // Read-only Citadel structure check for one repository and branch. Creates
    // nothing: the browser uses it to decide whether Attach may be enabled, and
    // attachment re-runs it against the head it is about to branch from.
    if (method === 'GET' && tail[0] === 'repos' && tail[2] === 'compatibility' && tail.length === 3) {
      const session = this.session(req);
      const repository = await getRepository(
        this.client,
        session.token,
        validateRepositoryId(tail[1])
      );
      const branch = validateBranchName(url.searchParams.get('branch'));
      const verdict = await inspectBranchCompatibility(
        this.client,
        session.token,
        repository.fullName,
        branch
      );
      this.note({
        action: verdict.supported ? 'repository.validate' : 'validation.failure',
        outcome: verdict.supported ? 'ok' : 'failed',
        reason: verdict.supported ? null : 'not-a-citadel-repository',
        target: `${repository.fullName} @ ${branch}`,
        account: session.login,
      });
      return {
        repositoryId: repository.id,
        fullName: repository.fullName,
        branch,
        ...verdict,
      };
    }

    if (method === 'POST' && tail[0] === 'attachments' && tail.length === 1) {
      return this.attach(req, await readBody());
    }

    if (method === 'POST' && tail[0] === 'attachments' && tail[1] === 'abandon') {
      return this.abandon(req, await readBody());
    }

    if (method === 'POST' && tail[0] === 'attachments' && tail[1] === 'status') {
      return this.attachmentStatus(req, await readBody());
    }

    if (tail[0] === 'workspaces' && tail.length >= 3) {
      return this.workspace({ req, url, environmentId: tail[1], operation: tail[2], readBody });
    }

    throw githubError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
  }

  /**
   * Validate a repository/branch selection and prepare the working branch.
   *
   * Nothing is persisted here; the browser writes the resulting source union
   * into the registry, which mirrors it to `/data`.
   *
   * The response carries an opaque `operationId`. That is the only authority
   * cleanup accepts, so a browser can never name someone else's branch for
   * deletion. Supplying the same `operationKey` again returns the original
   * result, so a lost response can be retried without creating a second branch
   * or orphaning the first.
   */
  async attach(req, body) {
    assertKeys(
      body,
      new Set([
        'repositoryId',
        'sourceBranch',
        'environmentId',
        'writeMode',
        'workingBranch',
        'adoptExisting',
        'operationKey',
        'expectedHead',
      ])
    );
    const session = this.session(req);
    const sessionFingerprint = reservationFingerprint(req.headers[SESSION_HEADER]);
    const clientKey = body.operationKey === undefined ? null : operationKeyOf(body.operationKey);
    // One attempt at a time per credential and key, so two identical requests
    // cannot both create a branch and both claim to own it.
    return this.attachments.serialize(sessionFingerprint, clientKey, async () => {
      const existing = this.attachments.findByKey(sessionFingerprint, clientKey);
      if (existing?.result) return existing.result;

      const environmentId = environmentIdOf(body.environmentId);
      const repository = await getRepository(
        this.client,
        session.token,
        validateRepositoryId(body.repositoryId)
      );
      if (repository.archived || repository.disabled) {
        throw githubError(
          400,
          'REPOSITORY_ARCHIVED',
          'Archived repositories cannot be attached for editing.'
        );
      }
      if (!repository.canPush) {
        throw githubError(
          403,
          'REPOSITORY_READ_ONLY',
          'This credential has no push access to that repository.'
        );
      }
      const sourceBranch = validateBranchName(body.sourceBranch);
      const writeMode = body.writeMode === 'direct' ? 'direct' : 'working-branch';
      // The authoritative Citadel check, immediately before anything is created.
      //
      // The browser runs the same scan to decide whether to enable Attach, but
      // that decision is advisory: a bypassed UI, a replayed verdict, or a push
      // that landed between the check and this call would all otherwise attach
      // an ordinary repository. Re-reading the head here and rescanning it means
      // a failure happens before the first mutation, so no working branch and no
      // registry record can exist for a repository that did not qualify.
      const validated = await assertAttachableRepository(
        this.client,
        session.token,
        repository.fullName,
        sourceBranch,
        body.expectedHead ? validateCommitSha(body.expectedHead, 'head') : null
      );
      const head = validated.head;
      // The branch is the user's to name. `citadel-ui/<environmentId>` remains
      // the answer only when a caller supplies no name at all, which keeps the
      // API contract that predates branch naming working; the browser always
      // supplies one.
      const namedByUser = body.workingBranch !== undefined && body.workingBranch !== null;
      const adoptExisting = body.adoptExisting === true;
      const workingBranch =
        writeMode === 'direct'
          ? sourceBranch
          : namedByUser
            ? validateBranchName(body.workingBranch)
            : workingBranchName(environmentId);
      if (writeMode === 'working-branch' && workingBranch === sourceBranch) {
        throw githubError(
          400,
          'INVALID_BRANCH',
          `${sourceBranch} is the branch you selected. Attach it directly instead of asking Citadel to create it.`
        );
      }

      // Provenance first. A create whose response is lost has still happened on
      // GitHub, and without a record written beforehand nothing could name the
      // branch to clean it up.
      const resumed = Boolean(existing);
      const reservation =
        existing ||
        this.attachments.reserve({
          sessionFingerprint,
          clientKey,
          repositoryId: repository.id,
          fullName: repository.fullName,
          environmentId,
          sourceBranch,
          workingBranch,
          writeMode,
        });

      let working;
      if (writeMode === 'direct') {
        working = { branch: sourceBranch, head, created: false, adopted: false };
      } else {
        try {
          working = await ensureWorkingBranch(
            this.client,
            session.token,
            repository.fullName,
            sourceBranch,
            workingBranch,
            {
              // Only a name a human typed can belong to somebody else. A derived
              // name embeds this environment's own id, and a resume is finishing
              // a branch this same operation already created.
              requireAbsent: namedByUser && !adoptExisting && !resumed,
            }
          );
        } catch (error) {
          // A name that already exists is a definite, answerable rejection, not
          // an ambiguous transport failure: nothing was created, so nothing has
          // to be reconciled or cleaned up. Letting it fall into the probe below
          // would find the branch, conclude the attach had half-succeeded, and
          // adopt the very branch this refusal exists to protect.
          if (error?.code === 'BRANCH_EXISTS') {
            this.attachments.discard(reservation);
            throw error;
          }
          // Ambiguous: the ref call may have succeeded before the failure. Ask
          // GitHub what actually exists rather than guessing.
          //
          // `branchHead` answers `null` only for a confirmed 404 and throws for
          // anything else, so the two cases stay apart. Collapsing a transient
          // lookup failure into "absent" would discard the reservation and leave
          // a branch nothing could ever name.
          let actual;
          try {
            actual = await branchHead(
              this.client,
              session.token,
              repository.fullName,
              workingBranch
            );
          } catch {
            // Neither confirmed created nor confirmed absent. The reservation
            // stays `pending`, so a retry with the same operation key reconciles
            // against whatever is really there.
            //
            // The status on this error is GitHub's own — a secondary rate limit
            // is a 403 and "Reference already exists" is a 422 — so status class
            // alone would read as a definite rejection and make the browser
            // discard the only handle that can resume or name the branch. The
            // marker says what the status cannot: this attach is unresolved.
            error.attachUnconfirmed = true;
            throw error;
          }
          if (actual === null) {
            // Positively absent: nothing was created, so nothing is left to
            // reconcile or clean up.
            this.attachments.discard(reservation);
            throw error;
          }
          // A branch sitting exactly at the source head is one this call just
          // created; anything else pre-existed and is not ours to remove.
          working = {
            branch: workingBranch,
            head: actual,
            created: actual === head,
            adopted: actual !== head,
          };
        }
        if (resumed && !working.created && working.head === head) {
          // Resuming this operation's own reservation. `ensureWorkingBranch`
          // sees a branch that already exists and reports `created: false`, but
          // the reservation is provenance that *this* operation was mid-create
          // when its answer was lost, so the branch is ours to clean up.
          working = { ...working, created: true, adopted: false };
        }
      }

      // Provenance, recorded rather than inferred later. A branch Citadel made
      // and a branch it was pointed at are different things to the person whose
      // repository it is, and only the moment of attaching knows which happened.
      const branchChoice =
        writeMode === 'direct' ? 'selected' : working.created ? 'created' : 'adopted';

      const result = {
        repository,
        source: {
          kind: 'github',
          // Ownership comes from the credential that performed the attach, never
          // from the request body. A browser cannot claim an environment was
          // attached through a connection it does not hold.
          connectionProfileId: session.profileId || null,
          repositoryId: repository.id,
          fullName: repository.fullName,
          sourceBranch,
          workingBranch: working.branch,
          writeMode,
          branchChoice,
          lastKnownHead: working.head,
          capabilities: validated.detected || [],
          validatedAt: new Date().toISOString(),
        },
        head: working.head,
        createdWorkingBranch: working.created,
        operationId: reservation.operationId,
      };
      this.attachments.attach(reservation, {
        workingBranch: working.branch,
        baseHead: working.head,
        created: working.created,
        result,
      });
      this.note({
        action: 'repository.attach',
        outcome: 'ok',
        target: `${repository.fullName} @ ${sourceBranch}`,
        account: session.login,
      });
      return result;
    });
  }

  /**
   * What happened to an attach whose answer the browser never received?
   *
   * The reservation is already the authority on this: `attach` records
   * provenance before it touches a branch and publishes the result when it
   * succeeds. This exposes that record by the client's own operation key, so a
   * lost 502 can be reconciled with a cheap read instead of a second mutation.
   *
   * It reads and never writes. `unknown` means only that this server has no
   * record — after a restart, or past the reservation TTL — and the caller must
   * fall back to replaying the idempotent attach rather than assuming nothing
   * was created.
   */
  async attachmentStatus(req, body) {
    assertKeys(body, new Set(['operationKey']));
    const sessionFingerprint = reservationFingerprint(req.headers[SESSION_HEADER]);
    // Resolving the session first keeps this behind the same credential check as
    // every other route, and refuses a caller with no live session.
    this.session(req);
    const clientKey = operationKeyOf(body.operationKey);
    if (!clientKey) {
      throw githubError(400, 'INVALID_OPERATION_KEY', 'An attachment operation key is required.');
    }
    const reservation = this.attachments.findByKey(sessionFingerprint, clientKey);
    if (!reservation) return { state: 'unknown', result: null };
    return {
      state: reservation.state === RESERVATION_PENDING ? 'pending' : 'attached',
      // Exactly the payload the original attach would have returned, so a
      // reconciling caller continues along the ordinary path.
      result: reservation.result || null,
    };
  }

  /**
   * Resolve an attachment operation, removing a branch this server created if it
   * is still exactly as created.
   *
   * The request supplies only the opaque operation id. Repository, branch and
   * base head come from the server's own record, so cleanup cannot be aimed at
   * another environment. The result always states what happened.
   *
   * The reservation is retired only once cleanup is confirmed, or confirmed
   * unnecessary. A transient lookup or delete failure leaves it in place so the
   * caller can retry with the same id; discarding it there would destroy the
   * only provenance that could ever remove the branch.
   */
  async abandon(req, body) {
    assertKeys(body, new Set(['operationId']));
    const session = this.session(req);
    const sessionFingerprint = reservationFingerprint(req.headers[SESSION_HEADER]);
    const reservation = this.attachments.find(sessionFingerprint, body.operationId);

    if (reservation.state === RESERVATION_PENDING) {
      // The branch mutation never reported an outcome. Whatever exists is found
      // by lookup, not assumed.
      const actual = await branchHead(
        this.client,
        session.token,
        reservation.fullName,
        reservation.workingBranch
      ).catch(() => undefined);
      if (actual === undefined) {
        return {
          removed: false,
          reason: 'lookup-failed',
          branch: reservation.workingBranch,
          retryable: true,
        };
      }
      if (!actual) {
        this.attachments.resolve(reservation);
        return { removed: true, reason: 'already-absent', branch: reservation.workingBranch };
      }
      this.attachments.attach(reservation, {
        workingBranch: reservation.workingBranch,
        baseHead: actual,
        created: true,
        result: reservation.result,
      });
    }

    if (!reservation.created) {
      this.attachments.resolve(reservation);
      return { removed: false, reason: 'not-created' };
    }
    const branch = reservation.workingBranch;
    if (!branch.startsWith(WORKING_BRANCH_PREFIX)) {
      // Never touch a branch outside the Citadel namespace, such as a direct
      // write-mode source branch.
      this.attachments.resolve(reservation);
      return { removed: false, reason: 'not-a-citadel-branch', branch };
    }
    let head;
    try {
      head = await branchHead(this.client, session.token, reservation.fullName, branch);
    } catch (error) {
      return { removed: false, reason: 'lookup-failed', branch, message: error.message, retryable: true };
    }
    if (!head) {
      this.attachments.resolve(reservation);
      return { removed: true, reason: 'already-absent', branch };
    }
    if (head !== reservation.baseHead) {
      this.attachments.resolve(reservation);
      return { removed: false, reason: 'branch-moved', branch };
    }
    try {
      await this.client.request(
        `/repos/${reservation.fullName}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
        { token: session.token, method: 'DELETE' }
      );
    } catch (error) {
      return { removed: false, reason: 'delete-failed', branch, message: error.message, retryable: true };
    }
    this.attachments.resolve(reservation);
    return { removed: true, branch };
  }

  async workspace({ req, url, environmentId, operation, readBody }) {
    const { token, source, repository } = await this.resolve(req, environmentId);
    const fullName = repository.fullName;
    const branch = source.workingBranch;

    if (req.method === 'GET' && operation === 'tree') {
      const head = await requireBranchHead(this.client, token, fullName, branch);
      const tree = await this.tree(token, fullName, head);
      return {
        repository,
        branch,
        sourceBranch: source.sourceBranch,
        writeMode: source.writeMode,
        head,
        files: tree.files,
        rejected: tree.rejected,
        truncated: tree.truncated,
      };
    }

    if (req.method === 'GET' && operation === 'blob') {
      const head = await requireBranchHead(this.client, token, fullName, branch);
      const alias = url.searchParams.get('alias');
      const snapshot = await this.tree(token, fullName, head);
      const blob = await this.blob(
        token,
        fullName,
        head,
        alias,
        url.searchParams.get('sha'),
        snapshot,
        repository.id
      );
      return {
        alias,
        sha: blob.sha,
        size: blob.size,
        hash: blob.hash,
        content: blob.bytes.toString('base64'),
      };
    }

    if (req.method === 'GET' && operation === 'history') {
      return {
        transactions: await loadHistory(this.client, token, fullName, branch, environmentId, {
          audit: this.audit,
        }),
      };
    }

    if (req.method === 'GET' && operation === 'commits') {
      const sha = validateCommitSha(url.searchParams.get('sha'));
      const record = this.audit
        ? await this.audit.find({
            commit: sha,
            repositoryId: repository.id,
            environmentId,
            branch,
          })
        : null;
      return {
        transaction: await inspectCommit(this.client, token, fullName, branch, sha, { record }),
      };
    }

    if (req.method === 'GET' && operation === 'subscription') {
      const head = await requireBranchHead(this.client, token, fullName, branch);
      return readSubscriptionId(
        this.client,
        token,
        fullName,
        head,
        String(url.searchParams.get('environmentName') || ''),
        { readSubscriptionIdFromText }
      );
    }

    if (req.method === 'POST' && operation === 'commits') {
      const body = await readBody();
      assertKeys(body, new Set(['action', 'expectedHead', 'transactionId', 'files']));
      return commitChangeSet(this.client, token, {
        fullName,
        branch,
        repositoryId: repository.id,
        expectedHead: body.expectedHead ? validateCommitSha(body.expectedHead) : null,
        files: body.files,
        action: assertAction(body.action),
        environmentId,
        transactionId: transactionIdOf(body.transactionId),
        audit: this.audit,
        // Deliberately omitted: the public endpoint never grants the
        // subscription capability, so no request can reach `.azure/**/.env`.
      });
    }

    if (req.method === 'POST' && operation === 'commit-branches') {
      // The user's answer to a refused save: put that commit on a branch of
      // this name. Nothing here runs without it — a refusal on its own creates
      // no ref at all.
      const body = await readBody();
      assertKeys(body, new Set(['commit', 'branch']));
      return createCommitBranch(this.client, token, {
        fullName,
        commitSha: validateCommitSha(body.commit),
        branch: body.branch,
        // The branch the refused save was aiming at. The audit record was
        // written against it, so it is how the commit is proven to belong to
        // this workspace.
        intendedBranch: branch,
        environmentId,
        repositoryId: repository.id,
        audit: this.audit,
      });
    }

    if (req.method === 'POST' && operation === 'subscription') {
      const body = await readBody();
      assertKeys(
        body,
        new Set(['environmentName', 'value', 'expectedHead', 'expectedHash', 'transactionId'])
      );
      return this.saveSubscriptionId({
        token,
        fullName,
        branch,
        environmentId,
        repository,
        body,
      });
    }

    if (req.method === 'POST' && operation === 'reverts') {
      const body = await readBody();
      assertKeys(body, new Set(['commit', 'transactionId']));
      return revertCommit(this.client, token, {
        fullName,
        branch,
        repositoryId: repository.id,
        commitSha: validateCommitSha(body.commit),
        environmentId,
        transactionId: transactionIdOf(body.transactionId),
        audit: this.audit,
      });
    }

    throw githubError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
  }

  /**
   * Patch only `AZURE_SUBSCRIPTION_ID` in a tracked `.azure/<env>/.env`.
   *
   * Staleness is checked with the SHA-256 the user reviewed, which is the same
   * precondition the local provider uses, so both sources behave identically:
   * an existing file requires a matching hash, and creating one requires the
   * caller to have observed that the file was absent.
   *
   * Every other byte of the file is preserved and never returned.
   */
  async saveSubscriptionId({ token, fullName, branch, environmentId, repository, body }) {
    const id = validateSubscriptionId(body.value);
    const environmentName = String(body.environmentName || '');
    const alias = subscriptionEnvironmentAlias(environmentName);
    const head = await requireBranchHead(this.client, token, fullName, branch);
    if (body.expectedHead && head !== body.expectedHead) {
      throw githubError(
        409,
        'STALE_WORKSPACE',
        'The branch moved after you reviewed this environment file. Reload before saving.'
      );
    }
    const current = await readSubscriptionId(
      this.client,
      token,
      fullName,
      head,
      environmentName,
      { readSubscriptionIdFromText }
    );
    const expectedHash = body.expectedHash ?? null;
    if (
      (current.available && (typeof expectedHash !== 'string' || current.hash !== expectedHash)) ||
      (!current.available && expectedHash !== null)
    ) {
      throw githubError(
        409,
        'STALE_SOURCE',
        'The azd environment file changed outside Citadel UI. Reload before saving.'
      );
    }
    const before = current.available
      ? (await readBlob(this.client, token, fullName, current.blobSha, { maxBytes: MAX_ENV_BYTES })).text
      : '';
    const after = writeSubscriptionIdToText(before, id);
    if (after === before) return { ...current, changed: false };
    const bytes = Buffer.from(after, 'utf8');
    if (bytes.byteLength > MAX_ENV_BYTES) {
      throw githubError(413, 'ENV_TOO_LARGE', 'The azd environment file exceeds the 1 MiB safety limit.');
    }
    const result = await commitChangeSet(this.client, token, {
      fullName,
      branch,
      repositoryId: repository?.id,
      expectedHead: head,
      files: [
        {
          alias,
          create: !current.available,
          blobSha: current.blobSha,
          beforeHash: current.hash,
          mode: current.mode || BLOB_MODE_FILE,
          after: bytes.toString('base64'),
        },
      ],
      action: 'subscription-edit',
      environmentId,
      transactionId: transactionIdOf(body.transactionId),
      audit: this.audit,
      // The only place this capability is ever granted, and only for this path.
      subscriptionAlias: alias,
    });
    // The commit has landed. A failed verification read is reported as a warning
    // on a committed result, never as a save failure that invites a retry.
    try {
      const verified = await readSubscriptionId(
        this.client,
        token,
        fullName,
        result.commit,
        environmentName,
        { readSubscriptionIdFromText }
      );
      return { ...verified, changed: true, commit: result.commit, warnings: result.warnings };
    } catch (error) {
      return {
        ...current,
        value: id,
        changed: true,
        commit: result.commit,
        verified: false,
        warnings: [
          ...(result.warnings || []),
          `The subscription was committed, but it could not be re-read: ${error.message}`,
        ],
      };
    }
  }
}

export { SESSION_HEADER };
