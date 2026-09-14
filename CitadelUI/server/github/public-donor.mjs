/**
 * Owner-gated, anonymous public GitHub GETs only. No credential/session store,
 * registry, audit, attachment, or mutation coordinator is available here.
 *
 * Snapshots retain bounded metadata, not source blobs, in process memory. An
 * alias may read only the regular blob indexed in its exact pinned tree.
 */
import { createHash, randomUUID } from 'node:crypto';
import { GitHubApiClient } from './api.mjs';
import {
  BLOB_MODE_FILE, BLOB_MODE_EXECUTABLE, filterSourceTree, MAX_TREE_ENTRIES,
  listRepositoryBranches, validateCommitSha, validateRepositoryId,
} from './repositories.mjs';
import { readBlob } from './workspace.mjs';
import { isSkippedDirectory, MAX_SOURCE_BYTES, sourceExtension } from '../../shared/source-scope.mjs';
import { inspectArmParameterJson, MigrationError, readArmParameters, safeLabel } from '../../shared/migration-input.mjs';
import {
  PUBLIC_DONOR_LIMITS, publicDonorAlias, publicDonorFailure, publicDonorRef, publicRepositoryName,
} from '../../shared/migration-public-github.mjs';

const encodePath = (name) => name.split('/').map(encodeURIComponent).join('/');
const publicError = (code, status = 400) => Object.assign(new MigrationError(code), { status, github: true });

function sourceTree(entries) {
  const seen = new Set();
  for (const entry of entries) {
    try { publicDonorAlias(entry?.path); } catch { continue; }
    if (seen.has(entry.path)) throw publicError('public-tree', 413);
    seen.add(entry.path);
  }
  // Reuse the normal Bicep scope/mode/SHA/size policy without widening it.
  const bicep = entries.filter((entry) => ['.bicep', '.bicepparam'].includes(sourceExtension(entry?.path)));
  const filtered = filterSourceTree(bicep.filter((entry) => ['blob', 'commit'].includes(entry.type)));
  const files = filtered.files.filter((file) => {
    try { publicDonorAlias(file.alias); return true; } catch { return false; }
  });
  const rejected = filtered.rejected.map((entry) => ({ alias: safeLabel(entry.path), reason: entry.reason }));
  for (const entry of bicep.filter((file) => !['blob', 'commit'].includes(file.type))) {
    try { publicDonorAlias(entry.path); }
    catch { continue; }
    // A directory or unknown object occupying a template alias is unreadable,
    // not positive evidence that a schema is absent.
    rejected.push({ alias: safeLabel(entry.path), reason: 'not-a-regular-blob' });
  }
  for (const entry of entries.filter((item) => sourceExtension(item?.path) === '.json')) {
    if (entry.path.split('/').some(isSkippedDirectory)) continue;
    try {
      publicDonorAlias(entry.path);
      validateCommitSha(entry.sha, 'blob');
      if (entry.type !== 'blob' || ![BLOB_MODE_FILE, BLOB_MODE_EXECUTABLE].includes(entry.mode) ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_SOURCE_BYTES) throw publicError('public-scope');
      files.push({ alias: entry.path, kind: 'json', sha: entry.sha, mode: entry.mode, size: entry.size });
    } catch { rejected.push({ alias: safeLabel(entry.path), reason: 'unsupported-json-entry' }); }
  }
  if (files.length + rejected.length > PUBLIC_DONOR_LIMITS.files || new Set(files.map((file) => file.alias)).size !== files.length) {
    throw publicError('public-tree', 413);
  }
  return { files: files.sort((left, right) => left.alias.localeCompare(right.alias)), rejected };
}

export class GitHubDonorReader {
  constructor(options = {}) {
    this.allowPrivate = options.allowPrivate === true;
    // Helpers can use their ordinary request shape, but this facade cannot
    // forward a credential, body, method, arbitrary header, or raw-media option.
    this.client = {
      request: (path, request = {}) => {
        if ((request.method && request.method !== 'GET') || request.token || request.body !== undefined) {
          throw publicError('public-read-only');
        }
        return options.readOnlyRequest(path, { limit: request.limit });
      },
      paginate(path, request) {
        return GitHubApiClient.prototype.paginate.call(this, path, request);
      },
    };
    this.now = options.now || Date.now;
    this.snapshots = new Map();
  }

  async repository(input, expectedId = null) {
    const requested = publicRepositoryName(input);
    const id = expectedId === null ? null : validateRepositoryId(expectedId);
    const { data } = await this.client.request(id ? `/repositories/${id}` : `/repos/${requested}`);
    if (!data || typeof data.private !== 'boolean' || data.disabled ||
        (!this.allowPrivate && (data.private || (data.visibility && data.visibility !== 'public')))) {
      throw publicError('public-not-found', 404);
    }
    const fullName = publicRepositoryName(data.full_name);
    const repositoryId = validateRepositoryId(data.id);
    if ((id !== null && repositoryId !== id) || fullName.toLowerCase() !== requested.toLowerCase()) {
      throw publicError('public-stale', 409);
    }
    return {
      id: repositoryId, fullName, visibility: data.private || data.visibility === 'internal' ? 'private' : 'public',
      defaultBranch: data.default_branch ? publicDonorRef('branch', data.default_branch).name : null,
      archived: Boolean(data.archived),
    };
  }

  async branches(input, expectedId) {
    const repository = await this.repository(input, expectedId);
    const result = await listRepositoryBranches(this.client, undefined, repository);
    for (const branch of result.branches) publicDonorRef('branch', branch.name);
    return result;
  }

  async revision(repository, ref) {
    if (ref.type === 'commit') return { commit: ref.name, refSha: ref.name };
    const namespace = ref.type === 'branch' ? 'heads' : 'tags';
    const { data } = await this.client.request(`/repos/${repository.fullName}/git/ref/${namespace}/${encodePath(ref.name)}`);
    if (data?.ref !== `refs/${namespace}/${ref.name}` || !['commit', 'tag'].includes(data?.object?.type) ||
        (ref.type === 'branch' && data.object.type !== 'commit')) throw publicError('public-read', 502);
    const refSha = validateCommitSha(data.object.sha);
    let object = data.object;
    const visited = new Set();
    while (object.type === 'tag') {
      const sha = validateCommitSha(object.sha, 'tag');
      if (visited.has(sha) || visited.size >= 5) throw publicError('public-read', 502);
      visited.add(sha);
      const tag = await this.client.request(`/repos/${repository.fullName}/git/tags/${sha}`);
      if (tag.data?.sha !== sha || !['tag', 'commit'].includes(tag.data?.object?.type)) throw publicError('public-read', 502);
      object = tag.data.object;
    }
    return { commit: validateCommitSha(object.sha), refSha };
  }

  async commitTree(repository, commit) {
    const { data } = await this.client.request(`/repos/${repository.fullName}/git/commits/${validateCommitSha(commit)}`);
    if (data?.sha !== commit) throw publicError('public-read', 502);
    return validateCommitSha(data?.tree?.sha, 'tree');
  }

  async snapshot(input) {
    const ref = publicDonorRef(input.refType, input.ref);
    const repository = await this.repository(input.repository, input.repositoryId ?? null);
    const revision = await this.revision(repository, ref);
    const treeSha = await this.commitTree(repository, revision.commit);
    const { data } = await this.client.request(`/repos/${repository.fullName}/git/trees/${treeSha}?recursive=1`, {
      limit: PUBLIC_DONOR_LIMITS.treeBytes,
    });
    // Anonymous quota must not turn a truncated tree into thousands of fallback
    // calls, or turn an incomplete tree into a false "missing template" result.
    if (data?.sha !== treeSha || !Array.isArray(data.tree) || data.truncated ||
        data.tree.length > MAX_TREE_ENTRIES) throw publicError('public-tree', 413);
    const scoped = sourceTree(data.tree);
    const snapshot = {
      selectionId: randomUUID(), repository, ref, ...revision, treeSha, ...scoped,
      expiresAt: this.now() + PUBLIC_DONOR_LIMITS.lifetimeMs,
    };
    this.snapshots.set(snapshot.selectionId, snapshot);
    for (const [id, entry] of this.snapshots) if (entry.expiresAt <= this.now()) this.snapshots.delete(id);
    while (this.snapshots.size > PUBLIC_DONOR_LIMITS.snapshots) this.snapshots.delete(this.snapshots.keys().next().value);
    return structuredClone(snapshot);
  }

  selected(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id || ''))) throw publicError('public-input');
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.expiresAt <= this.now()) {
      this.snapshots.delete(id);
      throw publicError('public-expired', 409);
    }
    return snapshot;
  }

  async verify(id) {
    const snapshot = this.selected(id);
    const repository = await this.repository(snapshot.repository.fullName, snapshot.repository.id);
    const revision = await this.revision(repository, snapshot.ref);
    const treeSha = snapshot.ref.type === 'commit'
      ? await this.commitTree(repository, revision.commit) : snapshot.treeSha;
    if (repository.visibility !== snapshot.repository.visibility ||
        revision.commit !== snapshot.commit || revision.refSha !== snapshot.refSha || treeSha !== snapshot.treeSha) {
      this.snapshots.delete(id);
      throw publicError('public-stale', 409);
    }
    return { repository, ref: snapshot.ref, ...revision, treeSha, selectionId: id };
  }

  async selectedBlob(id, input) {
    const alias = publicDonorAlias(input);
    const snapshot = this.selected(id);
    const entry = snapshot.files.find((file) => file.alias === alias);
    if (!entry) throw publicError('public-scope');
    // Reconfirm public visibility even when a caller retained a snapshot ID.
    // There is no authenticated fallback if the repository has become private.
    const repository = await this.repository(snapshot.repository.fullName, snapshot.repository.id);
    if (repository.visibility !== snapshot.repository.visibility) throw publicError('public-stale', 409);
    const blob = await readBlob(this.client, undefined, snapshot.repository.fullName, entry.sha);
    const gitHash = createHash(entry.sha.length === 40 ? 'sha1' : 'sha256')
      .update(`blob ${blob.bytes.length}\0`).update(blob.bytes).digest('hex');
    if (blob.size !== entry.size || gitHash !== entry.sha) throw publicError('public-read', 502);
    return { alias, snapshot, entry, blob };
  }

  async jsonCandidate(id, input) {
    const { alias, snapshot, entry, blob } = await this.selectedBlob(id, input);
    if (entry.kind !== 'json') throw publicError('public-scope');
    return {
      alias, repositoryId: snapshot.repository.id, commit: snapshot.commit, treeSha: snapshot.treeSha,
      sha: entry.sha, size: blob.size, ...inspectArmParameterJson(blob.text),
    };
  }

  async blob(id, input) {
    const { alias, snapshot, entry, blob } = await this.selectedBlob(id, input);
    if (entry.kind === 'json') {
      try { readArmParameters(blob.text); } catch { throw publicError('public-format', 422); }
    }
    return {
      alias, repositoryId: snapshot.repository.id, commit: snapshot.commit, treeSha: snapshot.treeSha,
      sha: entry.sha, hash: blob.hash, size: blob.size, content: blob.bytes.toString('base64'),
    };
  }

  async handle({ req, url, operation }) {
    try {
      if (req.method !== 'GET') throw publicError('public-read-only', 405);
      const allowed = {
        repository: ['repository'],
        branches: ['repository', 'repositoryId'],
        snapshot: ['repository', 'repositoryId', 'refType', 'ref'],
        verify: ['selectionId'],
        blob: ['selectionId', 'alias'],
        'json-candidate': ['selectionId', 'alias'],
      }[operation];
      if (!allowed || [...url.searchParams.keys()].some((key) => !allowed.includes(key)) ||
          allowed.some((key) => url.searchParams.getAll(key).length > 1)) throw publicError('public-input');
      const input = Object.fromEntries(url.searchParams);
      if (operation === 'repository') return await this.repository(input.repository);
      if (operation === 'branches') return await this.branches(input.repository, input.repositoryId ?? null);
      if (operation === 'snapshot') return await this.snapshot(input);
      if (operation === 'verify') return await this.verify(input.selectionId);
      if (operation === 'json-candidate') return await this.jsonCandidate(input.selectionId, input.alias);
      return await this.blob(input.selectionId, input.alias);
    } catch (error) {
      const safe = publicDonorFailure(error);
      throw Object.assign(safe, {
        status: Number.isInteger(error?.status) ? error.status : safe.code === 'public-input' ? 400 : 502,
        github: true,
      });
    }
  }

}

export class PublicGitHubDonorRoutes extends GitHubDonorReader {
  constructor(options = {}) {
    const client = options.client || new GitHubApiClient(options.clientOptions);
    super({
      ...options, allowPrivate: false,
      readOnlyRequest: (path, { limit }) => client.request(path, { method: 'GET', anonymous: true, limit }),
    });
  }
}
