import { sha256 } from '../../shared/source-scope.mjs';

/**
 * Read-only Citadel source provider backed by a GitHub repository.
 *
 * Implements the same `RepositoryProvider` surface as the local folder provider
 * so discovery, parsing, preview, validation, compare, and contract logic reuse
 * the editor unchanged.
 *
 * Every read is addressed by immutable SHA through the same-origin server. The
 * browser never holds a credential and never contacts GitHub directly. Writes do
 * not exist here: a Git repository needs one atomic commit per operation, which
 * is the `GitHubCommitCoordinator`'s responsibility.
 */
export class GitHubRepositoryProvider {
  constructor(options = {}) {
    this.request = options.request;
    this.environmentId = options.environmentId;
    this.instrument = options.instrument || (() => {});
    this.snapshot = null;
    this.blobs = new Map();
    // In-flight reads keyed by blob SHA, so concurrent readers of the same
    // content share one request rather than racing each other.
    this.pending = new Map();
  }

  /**
   * Every read here crosses a network.
   *
   * Discovery reads this to decide whether to scope itself to what Citadel's
   * three editors need. It is stated by the provider rather than passed by the
   * caller because it is a fact about this source, not a preference of whoever
   * happens to be opening it — and because the eight call sites that open a
   * workspace all forgot to pass it when it was an option.
   */
  remote = true;

  base() {
    return `/api/github/workspaces/${encodeURIComponent(this.environmentId)}`;
  }

  async permission() {
    try {
      await this.tree({ refresh: true });
      return 'granted';
    } catch (error) {
      // A missing session, a revoked or narrowed token, a renamed or transferred
      // repository, and a deleted branch are all recoverable by reconnecting or
      // reselecting. None of them should strand startup with an exception.
      if (
        error?.code === 'GITHUB_SESSION_REQUIRED' ||
        error?.code === 'GITHUB_SESSION_EXPIRED' ||
        error?.code === 'REPOSITORY_RENAMED' ||
        error?.code === 'REPOSITORY_NOT_FOUND' ||
        error?.code === 'UNKNOWN_ENVIRONMENT' ||
        error?.code === 'BRANCH_NOT_FOUND' ||
        error?.status === 401 ||
        error?.status === 403 ||
        error?.status === 404 ||
        error?.status === 409
      ) {
        this.unavailableReason = error.message;
        return 'reconnect-required';
      }
      throw error;
    }
  }

  async assertWritable() {
    const snapshot = await this.tree();
    if (snapshot.writeMode === 'read-only') {
      throw new Error('This GitHub environment is read-only. Reattach with push access.');
    }
  }

  /**
   * Load the branch head and the filtered source tree once per refresh.
   *
   * The whole workspace is pinned to one commit so a concurrent push cannot make
   * two files in the same operation come from different revisions.
   */
  async tree(options = {}) {
    if (!this.snapshot || options.refresh) {
      const snapshot = await this.request(`${this.base()}/tree`);
      if (this.snapshot && this.snapshot.head !== snapshot.head) {
        this.blobs.clear();
        this.pending.clear();
      }
      this.snapshot = snapshot;
      this.instrument({
        operation: 'enumerate',
        count: snapshot.files.length,
        head: snapshot.head,
      });
    }
    return this.snapshot;
  }

  reset() {
    this.snapshot = null;
    this.blobs.clear();
    this.pending.clear();
  }

  /** Current branch head, used as the optimistic concurrency token for saves. */
  async workspaceHead() {
    return (await this.tree()).head;
  }

  async entries() {
    const snapshot = await this.tree();
    return snapshot.files.map((file) => ({ alias: file.alias, kind: file.kind }));
  }

  async entry(alias) {
    const snapshot = await this.tree();
    const file = snapshot.files.find((item) => item.alias === alias);
    if (!file) {
      throw Object.assign(new Error(`Source not found: ${alias}`), { name: 'NotFoundError' });
    }
    return file;
  }

  /**
   * Directories are implicit in a Git tree, so nothing is ever missing. Returning
   * an empty list keeps the shared transaction journal shape without inventing
   * local filesystem semantics.
   */
  async missingDirectories() {
    return [];
  }

  async read(alias) {
    const file = await this.entry(alias);
    const cached = this.blobs.get(file.sha);
    if (cached) return this.copy(cached, alias);
    // Two aliases can name the same blob — a contract copied from another, a
    // template shared by every instance. Caching the finished record alone only
    // deduplicates readers that happen to be sequential; discovery reads with
    // several requests in flight, so without sharing the in-flight promise the
    // same bytes are fetched twice by whichever two callers raced. This is the
    // same correction `discoverWorkspace` makes for aliases, applied to the
    // content those aliases resolve to.
    const pending = this.pending.get(file.sha);
    if (pending) return this.copy(await pending, alias);
    const work = this.fetch(alias, file);
    this.pending.set(file.sha, work);
    try {
      return this.copy(await work, alias);
    } finally {
      this.pending.delete(file.sha);
    }
  }

  /**
   * A private copy, named for the alias that asked.
   *
   * The bytes are shared content, but the alias is the caller's — a record
   * cached under one path must not tell the next caller it is a different file.
   */
  copy(record, alias) {
    return { ...record, alias, bytes: record.bytes.slice() };
  }

  async fetch(alias, file) {
    const payload = await this.request(
      `${this.base()}/blob?alias=${encodeURIComponent(alias)}&sha=${encodeURIComponent(file.sha)}`
    );
    const bytes = Uint8Array.from(atob(payload.content), (character) => character.charCodeAt(0));
    if (bytes.byteLength !== payload.size) {
      throw new Error(`Source size did not match its contents: ${alias}`);
    }
    const hash = await sha256(bytes);
    if (hash !== payload.hash) {
      throw new Error(`Source hash verification failed: ${alias}`);
    }
    const snapshot = await this.tree();
    const record = {
      alias,
      bytes,
      text: new TextDecoder().decode(bytes),
      size: bytes.byteLength,
      lastModified: null,
      hash,
      version: file.sha,
      workspaceHead: snapshot.head,
    };
    // Immutable content keyed by blob SHA: safe to keep in memory, never in
    // IndexedDB or /data.
    this.blobs.set(file.sha, record);
    this.instrument({ operation: 'read', alias, size: record.size, hash });
    return record;
  }

  /**
   * Narrow subscription bridge.
   *
   * Only `AZURE_SUBSCRIPTION_ID` and version metadata cross this boundary; the
   * rest of the `.env` file never reaches the browser.
   */
  async readSubscriptionId(environmentName) {
    return this.request(
      `${this.base()}/subscription?environmentName=${encodeURIComponent(environmentName)}`
    );
  }

  async writeSubscriptionId(environmentName, value, expectedHash) {
    const snapshot = await this.tree({ refresh: true });
    const result = await this.request(`${this.base()}/subscription`, {
      method: 'POST',
      body: JSON.stringify({
        environmentName,
        value,
        expectedHead: snapshot.head,
        // The reviewed SHA-256 is the same precondition the local provider uses,
        // so staleness behaves identically for both sources.
        expectedHash: expectedHash ?? null,
        transactionId: globalThis.crypto.randomUUID(),
      }),
    });
    this.reset();
    return result;
  }

  async write() {
    throw new Error('GitHub sources are saved as one commit. Use the workspace save action.');
  }

  async remove() {
    throw new Error('GitHub sources are removed as one commit. Use History undo.');
  }
}
