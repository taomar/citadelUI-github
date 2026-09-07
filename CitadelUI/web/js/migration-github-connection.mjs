import { localRequest } from './local-api.mjs';
import { ReadOnlyGitHubMigrationDonor } from './migration-public-donor.mjs';
import { MigrationError, safeLabel } from '../../shared/migration-input.mjs';
import { publicDonorRef, publicRepositoryName } from '../../shared/migration-public-github.mjs';
import { MIGRATION_ATTEMPT_HEADER, MIGRATION_SOURCE_ENDPOINT, MIGRATION_SOURCE_HEADER, privateDonorFailure } from '../../shared/migration-github-auth.mjs';

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(id);

/** An ephemeral source connection, never the destination's session manager. */
export class MigrationGitHubConnection {
  #request;
  #sessionId = null;
  #status = { connected: false };
  #generation = 0;
  #connecting = new Set();
  #pendingErase = new Set();
  #activeAttempts = new Set();
  #pendingCancel = new Set();
  #erasing = null;
  #disconnecting = null;

  constructor({ request = localRequest } = {}) {
    this.#request = request;
  }

  get connected() { return this.#sessionId !== null; }
  status() { return structuredClone(this.#status); }

  async #send(path, options = {}, sessionId = null) {
    try {
      return await this.#request(path, {
        ...options,
        ...(sessionId ? { headers: { [MIGRATION_SOURCE_HEADER]: sessionId } } : {}),
      });
    } catch (error) { throw privateDonorFailure(error); }
  }

  #forgetCurrent() {
    if (this.#sessionId) this.#pendingErase.add(this.#sessionId);
    this.#sessionId = null;
    this.#status = { connected: false };
  }

  #assert(generation) {
    if (generation !== this.#generation) throw new MigrationError('private-stale');
    if (!this.#sessionId) throw new MigrationError('private-auth-required');
  }

  async #cleanup() {
    if (this.#erasing) await this.#erasing;
    if (!this.#pendingErase.size && !this.#pendingCancel.size) return;
    this.#erasing = (async () => {
      for (const id of this.#pendingErase) {
        try {
          const result = await this.#send(`${MIGRATION_SOURCE_ENDPOINT}/session`, { method: 'DELETE' }, id);
          if (result?.erased !== true) throw new MigrationError('private-disconnect');
          this.#pendingErase.delete(id);
        } catch { throw new MigrationError('private-disconnect'); }
      }
      for (const attempt of this.#pendingCancel) {
        try {
          const result = await this.#send(`${MIGRATION_SOURCE_ENDPOINT}/session`, {
            method: 'DELETE', headers: { [MIGRATION_ATTEMPT_HEADER]: attempt },
          });
          if (result?.erased !== true) throw new MigrationError('private-disconnect');
          this.#pendingCancel.delete(attempt);
        } catch { throw new MigrationError('private-disconnect'); }
      }
    })();
    try { await this.#erasing; } finally { this.#erasing = null; }
  }

  #publicStatus(status) {
    if (status?.connected !== true || !Number.isSafeInteger(status.account?.id) ||
        typeof status.account.login !== 'string' || typeof status.idleExpiresAt !== 'string' ||
        typeof status.absoluteExpiresAt !== 'string' ||
        !['session-pat', 'saved-connection'].includes(status.credentialSource)) throw new MigrationError('private-read');
    return {
      connected: true,
      account: { id: status.account.id, login: safeLabel(status.account.login) },
      profile: status.profile ? { id: status.profile.id, name: safeLabel(status.profile.name) } : null,
      credentialSource: status.credentialSource,
      idleExpiresAt: status.idleExpiresAt,
      absoluteExpiresAt: status.absoluteExpiresAt,
    };
  }

  async listConnections() {
    const result = await this.#send(`${MIGRATION_SOURCE_ENDPOINT}/connections`, { method: 'GET' });
    if (!Array.isArray(result?.profiles)) throw new MigrationError('private-read');
    return {
      vault: { available: result.vault?.available === true },
      profiles: result.profiles.map((profile) => ({
        id: profile.id, name: safeLabel(profile.name), accountLogin: safeLabel(profile.accountLogin),
        accountId: profile.accountId, status: profile.status, credentialMode: profile.credentialMode,
      })),
    };
  }

  connect(choice) {
    if (this.#disconnecting) return Promise.reject(new MigrationError('private-stale'));
    const generation = ++this.#generation;
    this.#forgetCurrent();
    for (const attempt of this.#activeAttempts) this.#pendingCancel.add(attempt);
    const pending = this.#connect(choice, generation).finally(() => this.#connecting.delete(pending));
    this.#connecting.add(pending);
    return pending;
  }

  async #connect(choice, generation) {
    await this.#cleanup();
    if (generation !== this.#generation) throw new MigrationError('private-stale');
    if (!choice || typeof choice !== 'object' || Array.isArray(choice) ||
        Object.keys(choice).length !== 1 || !['token', 'profileId'].includes(Object.keys(choice)[0])) {
      throw new MigrationError('private-input');
    }
    const attempt = globalThis.crypto.randomUUID();
    this.#activeAttempts.add(attempt);
    let result;
    try {
      result = await this.#send(`${MIGRATION_SOURCE_ENDPOINT}/session`, {
        method: 'POST', body: JSON.stringify(choice), headers: { [MIGRATION_ATTEMPT_HEADER]: attempt },
      });
      if (!validId(result?.sessionId)) throw new MigrationError('private-read');
      const status = this.#publicStatus(result.status);
      if (generation !== this.#generation) throw new MigrationError('private-stale');
      this.#sessionId = result.sessionId;
      this.#status = status;
      return this.status();
    } catch (error) {
      // The attempt capability can erase a minted credential even when its
      // response (and therefore its server-generated session ID) was lost.
      this.#pendingCancel.add(attempt);
      if (validId(result?.sessionId)) this.#pendingErase.add(result.sessionId);
      await this.#cleanup();
      throw error;
    } finally { this.#activeAttempts.delete(attempt); }
  }

  async #signedRead(generation, path, options = {}) {
    this.#assert(generation);
    if (!path.startsWith(`${MIGRATION_SOURCE_ENDPOINT}/`) ||
        (options.method && options.method !== 'GET') || options.body !== undefined) throw new MigrationError('private-read-only');
    try {
      const result = await this.#send(path, { method: 'GET' }, this.#sessionId);
      this.#assert(generation);
      return result;
    } catch (error) {
      if (generation === this.#generation &&
          ['private-auth-required', 'private-auth-invalid', 'private-auth-expired', 'private-account', 'private-profile'].includes(error.code)) {
        this.#generation += 1;
        this.#forgetCurrent();
        for (const attempt of this.#activeAttempts) this.#pendingCancel.add(attempt);
      }
      throw error;
    }
  }

  async #authorize(generation) {
    const result = await this.#signedRead(generation, `${MIGRATION_SOURCE_ENDPOINT}/session`);
    const status = this.#publicStatus(result.status);
    if (status.account.id !== this.#status.account.id || status.profile?.id !== this.#status.profile?.id) {
      this.#generation += 1;
      this.#forgetCurrent();
      throw new MigrationError('private-account');
    }
    this.#status = status;
  }

  async inspectRepository(input) {
    const generation = this.#generation;
    try {
      const repository = publicRepositoryName(input);
      const result = await this.#signedRead(generation, `${MIGRATION_SOURCE_ENDPOINT}/repository?${new URLSearchParams({ repository })}`);
      if (!Number.isSafeInteger(result?.id) || !['public', 'private'].includes(result.visibility) ||
          publicRepositoryName(result.fullName).toLowerCase() !== repository.toLowerCase()) throw new MigrationError('private-read');
      if (result.defaultBranch) publicDonorRef('branch', result.defaultBranch);
      return {
        id: result.id, fullName: result.fullName, visibility: result.visibility,
        defaultBranch: result.defaultBranch || null, archived: result.archived === true,
      };
    } catch (error) { throw privateDonorFailure(error); }
  }

  createDonor(selection) {
    const generation = this.#generation;
    this.#assert(generation);
    try {
      return new ReadOnlyGitHubMigrationDonor({
        ...selection, authenticated: true,
        request: (path, options) => this.#signedRead(generation, path, options),
        guard: () => this.#assert(generation),
        authorize: () => this.#authorize(generation),
      });
    } catch (error) { throw privateDonorFailure(error); }
  }

  disconnect() {
    if (this.#disconnecting) return this.#disconnecting;
    this.#generation += 1;
    this.#forgetCurrent();
    for (const attempt of this.#activeAttempts) this.#pendingCancel.add(attempt);
    this.#disconnecting = (async () => {
      // Late successful submissions revoke themselves when their generation no
      // longer matches. Cleanup errors remain retryable through pendingErase.
      await this.#cleanup();
      await Promise.allSettled([...this.#connecting]);
      await this.#cleanup();
      return { erased: true };
    })().finally(() => { this.#disconnecting = null; });
    return this.#disconnecting;
  }
}
