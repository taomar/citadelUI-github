import { sha256 } from '../../shared/source-scope.mjs';
import { workspaceScope } from '../../shared/workspace-configuration.mjs';
import { unitForAlias } from '../../shared/workspace-configuration.mjs';
import { assertNativeDependencySafe, assertNativeFileSafe, decodeNativeBytes, readUnitSchema } from '../../shared/terraform/workspace.mjs';
import { githubBranchKey, githubHeadRevision } from './github-head-state.mjs';
import { decodeSourceBytes } from '../../shared/source-text.mjs';

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
    this.scope = workspaceScope(options.configuration);
    this.configuration = this.scope.configuration;
    this.instrument = options.instrument || (() => {});
    this.snapshot = null;
    this.blobs = new Map();
    // In-flight reads keyed by blob SHA, so concurrent readers of the same
    // content share one request rather than racing each other.
    this.pending = new Map();
    this.generation = 0;
    this.treePending = null;
    this.branchKey = githubBranchKey(options.source);
    this.branchRevision = githubHeadRevision(this.branchKey);
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
    this.syncBranch();
    if (options.refresh) this.reset();
    if (this.snapshot) return this.snapshot;
    if (this.treePending) return this.treePending;
    const generation = this.generation;
    const work = (async () => {
      const snapshot = await this.request(`${this.base()}/tree`);
      this.assertGeneration(generation);
      for (const file of snapshot.files) this.scope.read(file.alias);
      this.snapshot = snapshot;
      this.instrument({ operation: 'enumerate', count: snapshot.files.length, head: snapshot.head });
      return snapshot;
    })();
    this.treePending = work;
    try { return await work; }
    finally { if (this.treePending === work) this.treePending = null; }
  }

  reset() {
    this.generation += 1;
    this.snapshot = null;
    this.treePending = null;
    this.blobs.clear();
    this.pending.clear();
  }

  syncBranch() {
    const revision = githubHeadRevision(this.branchKey);
    if (revision !== this.branchRevision) { this.branchRevision = revision; this.reset(); }
  }

  assertGeneration(generation) {
    this.syncBranch();
    if (generation !== this.generation) throw Object.assign(new Error('This GitHub read was superseded by a refresh or shared-branch save. Retry against the current head; drafts are preserved.'), { code: 'GITHUB_READ_SUPERSEDED' });
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
    this.scope.read(alias);
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
    const generation = this.generation, snapshot = this.snapshot;
    const key = this.scope.native ? `${snapshot.head}:${alias}:${file.sha}` : file.sha;
    const cached = this.blobs.get(key);
    if (cached) return this.copy(cached, alias);
    // Two aliases can name the same blob — a contract copied from another, a
    // template shared by every instance. Caching the finished record alone only
    // deduplicates readers that happen to be sequential; discovery reads with
    // several requests in flight, so without sharing the in-flight promise the
    // same bytes are fetched twice by whichever two callers raced. This is the
    // same correction `discoverWorkspace` makes for aliases, applied to the
    // content those aliases resolve to.
    const pending = this.pending.get(key);
    if (pending) {
      const record = await pending;
      this.assertGeneration(generation);
      return this.copy(record, alias);
    }
    const work = this.fetch(alias, file, snapshot, generation, key);
    this.pending.set(key, work);
    try {
      const record = await work;
      this.assertGeneration(generation);
      return this.copy(record, alias);
    } finally {
      if (this.pending.get(key) === work) this.pending.delete(key);
    }
  }

  /**
   * A private copy, named for the alias that asked.
   *
   * The bytes are shared content, but the alias is the caller's — a record
   * cached under one path must not tell the next caller it is a different file.
   */
  copy(record, alias) {
    this.scope.read(alias);
    return { ...record, alias, bytes: record.bytes.slice() };
  }

  async fetch(alias, file, snapshot, generation, key) {
    const payload = await this.request(
      `${this.base()}/blob?alias=${encodeURIComponent(alias)}&sha=${encodeURIComponent(file.sha)}`
    );
    this.assertGeneration(generation);
    const bytes = Uint8Array.from(atob(payload.content), (character) => character.charCodeAt(0));
    if (bytes.byteLength !== payload.size) {
      throw new Error(`Source size did not match its contents: ${alias}`);
    }
    const hash = await sha256(bytes);
    if (hash !== payload.hash) {
      throw new Error(`Source hash verification failed: ${alias}`);
    }
    this.assertGeneration(generation);
    const record = {
      alias,
      bytes,
      ...(this.scope.native ? { text: decodeNativeBytes(bytes) } : decodeSourceBytes(bytes)),
      size: bytes.byteLength,
      lastModified: null,
      hash,
      version: file.sha,
      workspaceHead: snapshot.head,
    };
    // Immutable content keyed by blob SHA: safe to keep in memory, never in
    // IndexedDB or /data.
    const unit = unitForAlias(this.configuration, alias);
    if (this.scope.native) await assertNativeDependencySafe(record.text, alias);
    if (this.scope.native && unit) {
      const { parameters } = await readUnitSchema(this, unit);
      await assertNativeFileSafe(record.text, unit, parameters);
    }
    this.assertGeneration(generation);
    this.scope.read(alias);
    this.blobs.set(key, record);
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
    if (this.scope.native) throw new Error('The azd bridge is unavailable for native Terraform.');
    return this.request(
      `${this.base()}/subscription?environmentName=${encodeURIComponent(environmentName)}`
    );
  }

  async writeSubscriptionId(environmentName, value, expectedHash) {
    if (this.scope.native) throw new Error('The azd bridge is unavailable for native Terraform.');
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
