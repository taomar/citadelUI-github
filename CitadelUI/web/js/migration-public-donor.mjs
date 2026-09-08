import { localRequest } from './local-api.mjs';
import { environmentSourceOf } from './registry.mjs';
import { migrationTemplateAlias } from './migration-donor.mjs';
import { MigrationError, MIGRATION_LIMITS, safeLabel } from '../../shared/migration-input.mjs';
import { MAX_SOURCE_BYTES, sha256, sourceExtension } from '../../shared/source-scope.mjs';
import { MIGRATION_SOURCE_ENDPOINT, privateDonorFailure } from '../../shared/migration-github-auth.mjs';
import {
  PUBLIC_DONOR_LIMITS, publicDonorAlias, publicDonorFailure, publicDonorRef, publicRepositoryName,
} from '../../shared/migration-public-github.mjs';

const BASE = '/api/github/public-donor';
const validSha = (sha) => typeof sha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha);

async function publicRead(request, operation, parameters, endpoint = BASE, failure = publicDonorFailure) {
  try {
    // Never githubRequest: the caller is anonymous or carries an isolated source
    // session. Neither path selects the editable destination's credential.
    return await request(`${endpoint}/${operation}?${new URLSearchParams(parameters)}`, { method: 'GET' });
  } catch (error) { throw failure(error); }
}

export async function inspectPublicDonorRepository(input, request = localRequest) {
  const name = publicRepositoryName(input);
  const repository = await publicRead(request, 'repository', { repository: name });
  if (!Number.isSafeInteger(repository?.id) || repository.id <= 0 || repository.visibility !== 'public' ||
      publicRepositoryName(repository.fullName).toLowerCase() !== name.toLowerCase()) throw new MigrationError('public-read');
  if (repository.defaultBranch) publicDonorRef('branch', repository.defaultBranch);
  return repository;
}

export function validateDonorBranches(result, repository) {
  if (result?.repository?.id !== repository.id ||
      typeof result.repository.fullName !== 'string' ||
      result.repository.fullName.toLowerCase() !== repository.fullName.toLowerCase() ||
      !Array.isArray(result.branches) || result.branches.length > 500 || typeof result.truncated !== 'boolean') {
    throw new MigrationError('public-read');
  }
  const names = new Set();
  const branches = result.branches.map((branch) => {
    const name = publicDonorRef('branch', branch?.name).name;
    if (names.has(name) || (branch.commit !== null && !validSha(branch.commit))) throw new MigrationError('public-read');
    names.add(name);
    return { name, commit: branch.commit, protected: branch.protected === true };
  });
  return { repository: result.repository, branches, truncated: result.truncated };
}

export async function listPublicDonorBranches(repository, request = localRequest) {
  const result = await publicRead(request, 'branches', {
    repository: publicRepositoryName(repository.fullName), repositoryId: repository.id,
  });
  return validateDonorBranches(result, repository);
}

/**
 * Shared read-only GitHub donor. Pinned blobs can be reused in memory; the
 * selected ref and access/visibility are re-resolved before each review,
 * export, and transaction boundary. No write or subscription methods exist.
 */
export class ReadOnlyGitHubMigrationDonor {
  #request;
  #selection;
  #snapshot = null;
  #loading = null;
  #blobs = new Map();
  #cacheBytes = 0;
  #pending = new Map();
  #failure = null;
  #authenticated;
  #guard;
  #authorize;
  #failureOf;
  #endpoint;

  constructor({ repository, repositoryId = null, refType, ref, request = localRequest, authenticated = false, guard = () => {}, authorize = async () => {} }) {
    const fullName = publicRepositoryName(repository);
    const selectedRef = publicDonorRef(refType, ref);
    if (repositoryId !== null && (!Number.isSafeInteger(repositoryId) || repositoryId <= 0)) throw new MigrationError('public-input');
    this.#selection = Object.freeze({ repository: fullName, refType: selectedRef.type, ref: selectedRef.name, repositoryId });
    this.#request = request;
    this.#authenticated = authenticated;
    this.#guard = guard;
    this.#authorize = authorize;
    this.#failureOf = authenticated ? privateDonorFailure : publicDonorFailure;
    this.#endpoint = authenticated ? MIGRATION_SOURCE_ENDPOINT : BASE;
    this.id = globalThis.crypto.randomUUID();
    this.kind = authenticated ? 'authenticated-github' : 'public-github';
    Object.freeze(this);
  }

  get label() {
    return `${this.#snapshot?.repository.fullName || this.#selection.repository} @ ${this.#selection.refType} ${this.#selection.ref}`;
  }

  #assertOpen() {
    if (this.#failure) throw this.#failure;
    try { this.#guard(); } catch (error) { throw this.#fail(error); }
  }

  #fail(error) {
    this.#failure = this.#failureOf(error);
    this.#blobs.clear();
    this.#cacheBytes = 0;
    this.#pending.clear();
    return this.#failure;
  }

  async #read(operation, parameters) {
    this.#assertOpen();
    const result = await publicRead(this.#request, operation, parameters, this.#endpoint, this.#failureOf);
    this.#assertOpen();
    return result;
  }

  #validVisibility(visibility) {
    return visibility === 'public' || (this.#authenticated && visibility === 'private');
  }

  async #load() {
    this.#assertOpen();
    if (this.#snapshot) return this.#snapshot;
    if (this.#loading) return this.#loading;
    this.#loading = (async () => {
      try {
        const parameters = { ...this.#selection };
        if (parameters.repositoryId === null) delete parameters.repositoryId;
        const snapshot = await this.#read('snapshot', parameters);
        if (!this.#validVisibility(snapshot?.repository?.visibility) || !Number.isSafeInteger(snapshot.repository.id) ||
            publicRepositoryName(snapshot.repository.fullName).toLowerCase() !== this.#selection.repository.toLowerCase() ||
            (this.#selection.repositoryId !== null && snapshot.repository.id !== this.#selection.repositoryId) ||
            snapshot.ref?.type !== this.#selection.refType || snapshot.ref?.name !== this.#selection.ref ||
            !validSha(snapshot.commit) || !validSha(snapshot.treeSha) || !validSha(snapshot.refSha) ||
            !/^[a-f0-9-]{36}$/.test(snapshot.selectionId || '') ||
            !Array.isArray(snapshot.files) || snapshot.files.length > PUBLIC_DONOR_LIMITS.files ||
            !Array.isArray(snapshot.rejected)) throw new MigrationError('public-read');
        const aliases = new Set();
        for (const file of snapshot.files) {
          const alias = publicDonorAlias(file.alias);
          if (aliases.has(alias) || !validSha(file.sha) || !Number.isSafeInteger(file.size) ||
              file.size < 0 || file.size > MAX_SOURCE_BYTES ||
              file.kind !== sourceExtension(alias).slice(1)) throw new MigrationError('public-read');
          aliases.add(alias);
        }
        this.#snapshot = structuredClone(snapshot);
        return this.#snapshot;
      } catch (error) { throw this.#fail(error); }
    })();
    try { return await this.#loading; } finally { this.#loading = null; }
  }

  provenance() {
    this.#assertOpen();
    const snapshot = this.#snapshot;
    if (!snapshot) throw new MigrationError('public-read');
    return {
      provider: this.#authenticated ? 'authenticated-github' : 'anonymous-public-github',
      repositoryId: snapshot.repository.id,
      repository: snapshot.repository.fullName,
      visibility: snapshot.repository.visibility,
      refType: snapshot.ref.type, ref: snapshot.ref.name,
      refSha: snapshot.refSha, commit: snapshot.commit, treeSha: snapshot.treeSha,
    };
  }

  exclusions() {
    return (this.#snapshot?.rejected || []).map((entry) => ({
      file: safeLabel(entry.alias), reason: safeLabel(entry.reason),
    }));
  }

  async entries() {
    try { await this.#authorize(); } catch (error) { throw this.#fail(error); }
    const snapshot = await this.#load();
    return snapshot.files.map((file) => ({ id: file.alias, alias: file.alias, format: file.kind }));
  }

  async inspectJsonCandidate(input) {
    try {
      await this.#authorize();
      const alias = publicDonorAlias(input);
      const snapshot = await this.#load();
      const entry = snapshot.files.find((file) => file.alias === alias && file.kind === 'json');
      if (!entry) throw new MigrationError('public-scope');
      const result = await this.#read('json-candidate', { selectionId: snapshot.selectionId, alias });
      if (result.alias !== alias || result.repositoryId !== snapshot.repository.id ||
          result.commit !== snapshot.commit || result.treeSha !== snapshot.treeSha ||
          result.sha !== entry.sha || result.size !== entry.size ||
          !['parameters', 'unrelated', 'invalid'].includes(result.kind) ||
          (result.kind === 'invalid' && !['format', 'envelope', 'json-duplicate', 'limit'].includes(result.code))) {
        throw new MigrationError('public-read');
      }
      return { kind: result.kind, code: result.code };
    } catch (error) { throw this.#fail(error); }
  }

  async assertFresh(expected) {
    const snapshot = await this.#load();
    try {
      if (JSON.stringify(this.provenance()) !== JSON.stringify(expected)) throw new MigrationError('public-stale');
      const result = await this.#read('verify', { selectionId: snapshot.selectionId });
      if (result.selectionId !== snapshot.selectionId || result.repository?.id !== snapshot.repository.id ||
          result.repository?.visibility !== snapshot.repository.visibility || result.repository?.fullName !== snapshot.repository.fullName ||
          result.commit !== snapshot.commit || result.treeSha !== snapshot.treeSha || result.refSha !== snapshot.refSha ||
          result.ref?.type !== snapshot.ref.type || result.ref?.name !== snapshot.ref.name) {
        throw new MigrationError('public-stale');
      }
    } catch (error) { throw this.#fail(error); }
  }

  async read(input) {
    try { await this.#authorize(); } catch (error) { throw this.#fail(error); }
    const alias = publicDonorAlias(input);
    const snapshot = await this.#load();
    const entry = snapshot.files.find((file) => file.alias === alias);
    if (!entry) throw new MigrationError('public-scope');
    let blob = this.#blobs.get(entry.sha);
    if (!blob) {
      let pending = this.#pending.get(entry.sha);
      if (!pending) {
        pending = (async () => {
          const payload = await this.#read('blob', { selectionId: snapshot.selectionId, alias });
          if (payload.alias !== alias || payload.repositoryId !== snapshot.repository.id ||
              payload.commit !== snapshot.commit || payload.treeSha !== snapshot.treeSha ||
              payload.sha !== entry.sha || payload.size !== entry.size || typeof payload.content !== 'string' ||
              payload.content.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4 + 4) throw new MigrationError('public-read');
          const bytes = Uint8Array.from(atob(payload.content), (character) => character.charCodeAt(0));
          if (bytes.length !== entry.size || await sha256(bytes) !== payload.hash) throw new MigrationError('public-read');
          return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), size: bytes.length, hash: payload.hash };
        })();
        this.#pending.set(entry.sha, pending);
      }
      try {
        blob = await pending;
        this.#assertOpen();
        const previous = this.#blobs.get(entry.sha);
        if (previous) { this.#cacheBytes -= previous.size; this.#blobs.delete(entry.sha); }
        while (this.#blobs.size && (this.#cacheBytes + blob.size > MIGRATION_LIMITS.totalBytes || this.#blobs.size >= 64)) {
          const key = this.#blobs.keys().next().value;
          this.#cacheBytes -= this.#blobs.get(key).size;
          this.#blobs.delete(key);
        }
        this.#blobs.set(entry.sha, blob);
        this.#cacheBytes += blob.size;
      } catch (error) { throw this.#fail(error); }
      finally { this.#pending.delete(entry.sha); }
    } else {
      this.#blobs.delete(entry.sha);
      this.#blobs.set(entry.sha, blob);
    }
    return {
      ...blob, bytes: blob.bytes.slice(), id: alias, alias, version: entry.sha,
      // An immutable Git identity, NOT an emulated writable browser handle.
      handle: { ...this.provenance(), alias, blobSha: entry.sha },
    };
  }

  async template(parameter, using) {
    const alias = migrationTemplateAlias(parameter.alias, using);
    if (!alias) return { id: null, alias: null, source: null };
    const snapshot = await this.#load();
    if (snapshot.rejected.some((entry) => entry.alias === alias)) throw new MigrationError('public-scope');
    if (!snapshot.files.some((file) => file.alias === alias)) {
      // Positive absence in a complete pinned tree, NOT a swallowed API error.
      return { id: alias, alias, source: null };
    }
    return { id: alias, alias, source: await this.read(alias) };
  }

  async assertSameFile(alias, previousIdentity) {
    const snapshot = await this.#load();
    const entry = snapshot.files.find((file) => file.alias === alias);
    const expected = entry ? { ...this.provenance(), alias, blobSha: entry.sha } : null;
    if (!expected || JSON.stringify(previousIdentity) !== JSON.stringify(expected)) throw new MigrationError('public-stale');
  }

  async assertDistinct(destination) {
    const snapshot = await this.#load();
    if (destination.provider.remote !== true) return; // GitHub objects and local handles are separate storage.
    const source = environmentSourceOf(destination.environment);
    if (source.kind !== 'github' || !source.repositoryId) throw new MigrationError('identity');
    const current = await destination.provider.tree();
    const sameRepository = String(source.repositoryId) === String(snapshot.repository.id);
    if (!sameRepository && source.fullName?.toLowerCase() === snapshot.repository.fullName.toLowerCase()) {
      throw new MigrationError('identity');
    }
    if (sameRepository && (current.head === snapshot.commit ||
        (snapshot.ref.type === 'branch' && source.workingBranch === snapshot.ref.name))) {
      throw new MigrationError('identity');
    }
  }

}

export class PublicGitHubMigrationDonor extends ReadOnlyGitHubMigrationDonor {
  constructor(options) {
    super({ ...options, authenticated: false, guard: () => {}, authorize: async () => {} });
  }
}
