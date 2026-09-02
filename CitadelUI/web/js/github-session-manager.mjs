/**
 * The browser's single GitHub credential, shared by every panel.
 *
 * A repository picker appears in four places: the landing page, workspace
 * settings, New project, and Add environment. Each used to own its own connect
 * lock, which reads as safe but is not: the lock is per panel while the session
 * id is per browser. Two panels connecting at once both wrote that one id, so
 * the loser kept showing its own account while its repository list, and every
 * later attach and commit, ran under the winner's credential.
 *
 * Connecting is therefore owned here, once, for the whole application:
 *
 *   - Only one exchange runs at a time, across every panel.
 *   - Each attempt takes a generation. A response from a superseded attempt is
 *     discarded and its credential is revoked rather than left live on the
 *     server, unreachable and consuming a session slot.
 *   - Callers bind their reads to the session they were handed, so a stale
 *     panel cannot publish another credential's repositories.
 */
import {
  adoptGitHubSession,
  connectGitHub,
  disconnectGitHub,
  forgetGitHubSession,
  githubSessionId,
  githubStatus,
} from './github-session.mjs';
import {
  createConnection,
  reconnectConnection,
  resumeConnection,
  revokeGitHubSession,
} from './github-connections.mjs';

/**
 * Shape a connection-route answer like the account object every caller already
 * expects, so a profile-backed credential and a bare token behave identically
 * from here on.
 *
 * `revoke` is part of that shape, not an optional extra. A superseded or
 * displaced credential that cannot revoke itself stays live on the server,
 * holding one of eight session slots and a token in memory, with no id the
 * browser can still address — and after a few connection switches every further
 * connect fails with a limit the user cannot clear.
 */
function accountOf(result) {
  const session = result?.session || {};
  return {
    ...session,
    sessionId: session.id,
    profileId: result?.profile?.id || session.profileId || null,
    profile: result?.profile || null,
    persisted: Boolean(result?.persisted),
    persistenceReason: result?.persistenceReason || null,
    revoke: session.id
      ? async () => {
          if (githubSessionId() === session.id) forgetGitHubSession();
          await revokeGitHubSession(session.id);
        }
      : undefined,
  };
}

export class GitHubSessionManager {
  constructor(options = {}) {
    this.exchange = options.connect || connectGitHub;
    this.release = options.disconnect || disconnectGitHub;
    this.adopt = options.adopt || adoptGitHubSession;
    this.status = options.status || githubStatus;
    this.sessionId = options.sessionId || githubSessionId;
    this.generation = 0;
    this.pending = null;
    this.restoring = null;
    this.account = null;
    this.listeners = new Set();
  }

  /** Notified whenever the active credential changes, for every open panel. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    // A panel that fails to render must not break the credential for every
    // other panel — and, because `notify` is called on the path that releases
    // the connect lock, must not be able to strand it either.
    for (const listener of this.listeners) {
      try {
        listener(this);
      } catch {
        // Deliberately ignored: the manager owns the credential, not the view.
      }
    }
  }

  get connecting() {
    return this.pending !== null;
  }

  /** True while the manager is asking the server whether a session survives. */
  get isRestoring() {
    return this.restoring !== null;
  }

  /** No panel may connect while any of these are in progress. */
  get busy() {
    return this.pending !== null || this.restoring !== null;
  }

  get connected() {
    return this.account !== null;
  }

  /**
   * Adopt a session the server still holds.
   *
   * Restoring goes through the manager rather than each panel, so a session
   * found by one panel becomes the whole application's credential and every
   * other panel sees it. Run once and shared: concurrent callers await the same
   * request rather than each issuing their own and racing to publish.
   */
  async restore() {
    // The cached account is only trustworthy while the durable session id it
    // belongs to still exists. `githubStatus()` forgets that id when the server
    // reports the session gone, and it is reachable outside this manager — so a
    // cache hit is revalidated against the id rather than trusted blindly.
    // Without this, a container restart leaves panels rendering "Connected as
    // …" with the token field and Connect button both disabled, and no way
    // forward except a reload.
    if (this.account && this.sessionId()) return this.account;
    if (this.account) {
      this.account = null;
      this.notify();
    }
    if (this.restoring) return this.restoring;
    const generation = this.generation;
    const attempt = (async () => {
      try {
        const current = await this.status();
        if (!current?.connected || generation !== this.generation) return null;
        this.account = current;
        return current;
      } catch {
        return null;
      }
    })();
    this.restoring = attempt;
    try {
      this.notify();
      return await attempt;
    } finally {
      if (this.restoring === attempt) {
        this.restoring = null;
        this.notify();
      }
    }
  }

  /**
   * Exchange a token for a session, one attempt at a time application-wide.
   *
   * Returns the account plus the generation it belongs to. A caller must pass
   * that generation back to `isCurrent` before publishing anything derived from
   * it.
   */
  async connect(token) {
    if (this.busy) {
      throw new Error('A GitHub connection is already in progress.');
    }
    const generation = ++this.generation;
    const attempt = (async () => {
      // A replacement credential must not leave the previous one live on the
      // server, where it would keep a session slot the browser no longer tracks.
      const superseded = this.account;
      const account = await this.exchange(token);
      if (generation !== this.generation) {
        // Superseded: revoke rather than leave a live credential the browser no
        // longer tracks and cannot disconnect.
        await account?.revoke?.().catch?.(() => {});
        return null;
      }
      if (superseded && superseded.sessionId !== account.sessionId) {
        await superseded.revoke?.().catch?.(() => {});
      }
      // Only the winner becomes the browser's active credential.
      this.adopt(account.sessionId);
      this.account = account;
      return account;
    })();
    this.pending = attempt;
    try {
      this.notify();
      const account = await attempt;
      return account ? { account, generation } : null;
    } finally {
      if (this.pending === attempt) {
        this.pending = null;
        this.notify();
      }
    }
  }

  /** Is work started under `generation` still the active credential's work? */
  isCurrent(generation) {
    return generation === this.generation && this.account !== null;
  }

  /**
   * Establish a credential through a saved connection.
   *
   * Shares the application-wide lock and generation with `connect`, so a token
   * exchange and a profile resume cannot both publish a session. The exchange
   * itself is injected because create, reconnect and resume differ only in what
   * they send: the concurrency rules they need are identical, and duplicating
   * them per call site is how two of the three end up subtly wrong.
   */
  async establish(exchange) {
    if (this.busy) {
      throw new Error('A GitHub connection is already in progress.');
    }
    const generation = ++this.generation;
    const attempt = (async () => {
      const superseded = this.account;
      const account = accountOf(await exchange());
      if (!account.sessionId) {
        throw new Error('GitHub returned an unusable session identifier.');
      }
      if (generation !== this.generation) {
        await account.revoke?.().catch?.(() => {});
        return null;
      }
      if (superseded && superseded.sessionId !== account.sessionId) {
        await superseded.revoke?.().catch?.(() => {});
      }
      // The connection routes adopt the session id themselves, because a caller
      // that forgot would hold a connected profile whose every later request
      // fails. Adopting again here is idempotent and keeps the invariant local.
      this.adopt(account.sessionId);
      this.account = account;
      return account;
    })();
    this.pending = attempt;
    try {
      this.notify();
      const account = await attempt;
      return account ? { account, generation } : null;
    } finally {
      if (this.pending === attempt) {
        this.pending = null;
        this.notify();
      }
    }
  }

  /** Create a named connection from a token the user just entered. */
  async connectProfile({ name, token, persist }) {
    return this.establish(() => createConnection({ name, token, persist }));
  }

  /** Replace the credential behind an existing connection. */
  async reconnectProfile(profileId, { token, persist }) {
    return this.establish(() => reconnectConnection(profileId, { token, persist }));
  }

  /**
   * Bring a saved connection back with no user interaction.
   *
   * The token is unsealed and validated entirely inside the server; this side
   * receives an opaque id and an account summary.
   */
  async resumeProfile(profileId) {
    return this.establish(() => resumeConnection(profileId));
  }

  /**
   * Disconnect the active credential.
   *
   * The generation advances first, so a connect still in flight is superseded
   * and revokes itself instead of quietly becoming active afterwards.
   */
  async disconnect() {
    this.generation += 1;
    const result = await this.release();
    this.account = null;
    this.notify();
    return result;
  }

  /** Forget the active credential without contacting the server. */
  reset() {
    this.generation += 1;
    this.account = null;
    this.notify();
  }
}

/** The one manager every panel shares. */
export const githubSessions = new GitHubSessionManager();
