import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_REPOSITORY_SOURCE, parseRepositorySource } from '../../shared/repository-source.mjs';
import {
  REPOSITORY_SNAPSHOT_LIMITS, snapshotError as fail, validateLocalSnapshot, validateLocalSnapshotPaths,
} from '../../shared/repository-snapshot.mjs';
import { objectSha, readRepositoryManifest, verifySnapshotBytes } from './repository-snapshot.mjs';
import { assertSnapshotCompatibility } from './snapshot-compatibility.mjs';
import { transientImportRead } from './import-errors.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const STAGES = {
  source: 'Resolving the public source to one commit.',
  manifest: 'Validating the complete source tree and local paths.',
  files: 'Reading and hash-checking every source file.',
  compatibility: 'Checking the pinned snapshot for Citadel support.',
  ready: 'Complete source prepared. No local folder has been changed.',
};

function sourceFailure(error) {
  if (['PUBLIC_DONOR_RATE_LIMIT', 'GITHUB_RATE_LIMITED'].includes(error?.code)) {
    return { code: 'LOCAL_IMPORT_RATE_LIMIT', message: 'GitHub public-read rate limit reached. Wait before retrying this pinned source; no token or repository creation is required.' };
  }
  if (transientImportRead(error)) {
    return { code: 'LOCAL_IMPORT_READ_TIMEOUT',
      message: `The pinned public source read failed${error.upstreamStatus ? ` (GitHub HTTP ${error.upstreamStatus})` : ''} after bounded retries. Check connectivity or the proxy, then retry the same preparation; verified source bytes remain in memory. No personal or organization credential is used and no folder was changed.` };
  }
  if (['PUBLIC_DONOR_READ_FAILED', 'LOCAL_IMPORT_READ_FAILED'].includes(error?.code)) {
    return { code: 'LOCAL_IMPORT_READ_FAILED', message: 'The public repository or selected revision could not be read. Check the source URL; private repositories are not supported here.' };
  }
  if (error?.github && /^(IMPORT_|LOCAL_IMPORT_|GITHUB_)/.test(error.code || '')) {
    return { code: error.code, message: error.message };
  }
  return { code: 'LOCAL_IMPORT_SOURCE_FAILED', message: 'The complete source could not be prepared. Retry this attempt; no local files have been written.' };
}

/**
 * One bounded, ephemeral public snapshot. It has no credential store, durable
 * source cache, local host path, repository creation, or remote mutation API.
 * A retry retains its pin and verified blobs; a server restart requires a fresh
 * preparation. The browser downloads the entire snapshot before picking a folder.
 */
export class LocalSourceImportService {
  constructor({ client, limits = {}, now = () => Date.now(), ttlMs = 30 * 60_000, timeoutMs = 10 * 60_000 } = {}) {
    this.client = client;
    this.limits = { ...REPOSITORY_SNAPSHOT_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > REPOSITORY_SNAPSHOT_LIMITS[key]) {
        throw new Error('Invalid local source import limits.');
      }
    }
    this.now = now;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.operation = null;
    this.stopping = false;
  }

  prune() {
    if (this.operation && this.now() >= this.operation.expiresAt && !this.operation.running) {
      this.operation.blobs.clear();
      this.operation = null;
    }
  }

  find(id) {
    this.prune();
    if (!UUID.test(id || '') || !this.operation || this.operation.id !== id) {
      throw fail('LOCAL_IMPORT_EXPIRED', 'This prepared source is no longer available. Prepare the source again before choosing a folder.', 404);
    }
    return this.operation;
  }

  public(op) {
    return {
      id: op.id, sourceUrl: op.sourceUrl, source: op.source ? { ...op.source } : null,
      state: op.state, stage: STAGES[op.stage] || 'Source preparation stopped.',
      stageId: op.stage, progress: { ...op.progress }, error: op.error, retryAt: op.retryAt,
      readRetry: op.readRetry ? { ...op.readRetry } : null,
      running: Boolean(op.running), expiresAt: new Date(op.expiresAt).toISOString(),
    };
  }

  prepare({ sourceUrl = DEFAULT_REPOSITORY_SOURCE, operationKey } = {}) {
    if (!UUID.test(operationKey || '')) throw fail('LOCAL_IMPORT_INVALID_INPUT', 'A new source preparation key is required.', 400);
    let parsed;
    try { parsed = parseRepositorySource(sourceUrl); }
    catch (error) { throw fail('LOCAL_IMPORT_INVALID_SOURCE', error.message, 400); }
    this.prune();
    if (this.operation) {
      if (this.operation.id === operationKey && this.operation.sourceUrl === parsed.url) return this.public(this.operation);
      throw fail('LOCAL_IMPORT_BUSY', 'Another local source preparation is retained. Close that import before preparing a different source.', 409);
    }
    const op = {
      id: operationKey, sourceUrl: parsed.url, source: null, manifest: null, blobs: new Map(),
      state: 'preparing', stage: 'source', progress: { completed: 0, total: 0 }, error: null,
      expiresAt: this.now() + this.ttlMs, retryAt: null, running: null,
    };
    this.operation = op;
    this.start(op);
    return this.public(op);
  }

  start(op) {
    if (this.stopping) throw fail('LOCAL_IMPORT_UNAVAILABLE', 'Source preparation is shutting down.', 503);
    if (op.running) return;
    if (op.retryAt && this.now() < op.retryAt) {
      throw fail('LOCAL_IMPORT_RATE_LIMIT', 'Wait for the public-read cooldown before retrying this attempt.', 429);
    }
    op.controller = new AbortController();
    op.deadline = this.now() + this.timeoutMs;
    op.expiresAt = this.now() + this.ttlMs;
    op.state = 'preparing';
    op.error = null;
    op.readRetry = null;
    op.retryAt = null;
    op.running = Promise.resolve().then(() => this.acquire(op)).catch((error) => {
      op.state = op.controller.signal.aborted ? 'cancelled' : 'failed';
      op.error = op.state === 'cancelled'
        ? { code: 'LOCAL_IMPORT_CANCELLED', message: 'Source preparation cancelled. No local files were written.' }
        : sourceFailure(error);
      if (op.error.code === 'LOCAL_IMPORT_RATE_LIMIT') {
        const reset = Date.parse(error.rateResetAt);
        const seconds = Number(error.retryAfterSeconds);
        op.retryAt = Math.max(this.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86_400) * 1000 : 60_000),
          Number.isFinite(reset) ? Math.min(reset, this.now() + 86_400_000) : 0);
      }
    }).finally(() => { op.running = null; op.readRetry = null; });
  }

  check(op) {
    if (this.stopping || op.controller.signal.aborted) throw fail('LOCAL_IMPORT_CANCELLED', 'Source preparation cancelled.', 409);
    if (this.now() > op.deadline) throw fail('LOCAL_IMPORT_TIMEOUT', 'Source preparation exceeded its ten-minute deadline. Retry the same pinned source.', 408);
  }

  async retryRead(op, work) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.check(op);
      try {
        const result = await work();
        this.check(op);
        op.readRetry = null;
        return result;
      } catch (error) {
        if (!transientImportRead(error) || attempt === 3 || op.controller.signal.aborted) throw error;
        op.readRetry = { attempt: attempt + 1, maximum: 3 };
        await delay(attempt * 1000, undefined, { signal: op.controller.signal });
      }
    }
  }

  async read(op, path, options = {}) {
    return this.retryRead(op, async () => {
      const result = await this.client.request(path, {
        ...options, method: 'GET', anonymous: true, signal: op.controller.signal, timeoutMs: 60_000,
      });
      return result.data;
    });
  }

  async acquire(op) {
    op.stage = 'source';
    const parsed = parseRepositorySource(op.sourceUrl);
    const ep = `/repos/${parsed.fullName}`;
    const metadata = await this.read(op, ep);
    if (metadata?.private !== false) throw fail('LOCAL_IMPORT_PUBLIC_ONLY', 'Choose a public GitHub repository. This import does not use a PAT.');
    if (!Number.isSafeInteger(metadata.id) || metadata.id <= 0 ||
        typeof metadata.full_name !== 'string' || metadata.full_name.toLowerCase() !== parsed.fullName.toLowerCase() ||
        (op.source && op.source.repositoryId !== metadata.id)) throw fail('IMPORT_SOURCE_CHANGED', 'The public source repository identity changed.');
    const ref = op.source?.ref || parsed.ref || metadata.default_branch;
    if (typeof ref !== 'string' || !ref) throw fail('IMPORT_INVALID_OBJECT', 'GitHub did not return a valid source revision.');
    const selected = parseRepositorySource(`https://github.com/${parsed.fullName}/tree/${ref}`);
    const commit = await this.read(op, `${ep}/commits/${encodeURIComponent(op.source?.commit || selected.ref)}`);
    const head = objectSha(commit?.sha);
    const tree = objectSha(commit?.commit?.tree?.sha);
    if (op.source && (op.source.commit !== head || op.source.tree !== tree)) throw fail('IMPORT_SOURCE_CHANGED', 'The pinned public source changed.');
    op.source ||= { fullName: parsed.fullName, repositoryId: metadata.id, ref, commit: head, tree, fileCount: 0, totalBytes: 0 };
    op.stage = 'manifest';
    if (!op.manifest) {
      const manifest = await readRepositoryManifest((path, options) => this.read(op, path, options), parsed.fullName, tree, this.limits);
      validateLocalSnapshotPaths(manifest.entries);
      op.manifest = manifest;
    }
    op.source.fileCount = op.manifest.files.length;
    op.source.totalBytes = op.manifest.totalBytes;
    op.stage = 'files';
    let cursor = 0;
    let completed = 0;
    let sourceError = null;
    op.progress = { completed, total: op.source.fileCount };
    // Four bounded reads, not thousands of requests scheduled ahead of a cancel.
    const readFiles = async () => {
      while (cursor < op.manifest.files.length && !sourceError) {
        this.check(op);
        const entry = op.manifest.files[cursor++];
        op.progress.currentPath = entry.path;
        if (!op.blobs.has(entry.sha)) {
          const bytes = await this.retryRead(op, () => this.client.publicFile(parsed.fullName, head, entry.path, {
            limit: this.limits.blobBytes, signal: op.controller.signal, timeoutMs: 60_000,
          }));
          this.check(op);
          const blob = verifySnapshotBytes(bytes, entry, this.limits.blobBytes);
          op.blobs.set(entry.sha, { ...blob, hash: sha256(bytes) });
        }
        if (op.blobs.get(entry.sha).bytes.length !== entry.size) throw fail('IMPORT_HASH_MISMATCH', 'Repeated source blob has an inconsistent size.');
        op.progress = { completed: ++completed, total: op.source.fileCount, currentPath: entry.path };
      }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => readFiles().catch((error) => {
      sourceError ||= error;
      throw error;
    })));
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
    this.check(op);
    op.stage = 'compatibility';
    await assertSnapshotCompatibility(op.manifest, op.blobs);
    validateLocalSnapshot(this.manifest(op.id, true));
    this.check(op);
    op.stage = 'ready';
    op.state = 'ready';
    op.expiresAt = this.now() + this.ttlMs;
  }

  manifest(id, preparing = false) {
    const op = this.find(id);
    if ((!preparing && op.state !== 'ready') || !op.manifest) throw fail('LOCAL_IMPORT_NOT_READY', 'The complete source is not ready to copy.', 409);
    const result = {
      source: { ...op.source },
      entries: op.manifest.entries.map((entry) => ({
        ...entry, ...(entry.type === 'blob' ? { hash: op.blobs.get(entry.sha)?.hash } : {}),
      })),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > this.limits.manifestBytes) {
      throw fail('IMPORT_LIMIT', 'The complete source manifest exceeds the transfer limit.', 413);
    }
    return result;
  }

  blob(id, sha) {
    const op = this.find(id);
    if (op.state !== 'ready') throw fail('LOCAL_IMPORT_NOT_READY', 'The complete source is not ready to copy.', 409);
    const blob = /^[0-9a-f]{40}$/.test(sha || '') && op.blobs.get(sha);
    if (!blob) throw fail('LOCAL_IMPORT_BLOB_NOT_FOUND', 'This file does not belong to the prepared source.', 404);
    return { sha, hash: blob.hash, size: blob.bytes.length, content: blob.bytes.toString('base64') };
  }

  async cancel(id, release = false) {
    const op = this.find(id);
    op.controller.abort();
    if (op.running) await op.running;
    if (release) {
      op.blobs.clear();
      this.operation = null;
      return { released: true };
    }
    op.state = 'cancelled';
    return this.public(op);
  }

  async handle({ req, url, tail, readBody }) {
    if ([...url.searchParams].length) throw fail('LOCAL_IMPORT_INVALID_INPUT', 'Source import does not accept query parameters.', 400);
    if (req.method === 'POST') {
      const body = await readBody();
      const keys = tail.length === 1 ? ['sourceUrl', 'operationKey'] : [];
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !keys.includes(key))) {
        throw fail('LOCAL_IMPORT_INVALID_INPUT', 'Source import accepts no host path, handle or credentials.', 400);
      }
      if (tail.length === 1) return this.prepare(body);
      if (tail.length === 3 && tail[2] === 'cancel') return this.cancel(tail[1]);
      if (tail.length === 3 && tail[2] === 'resume') {
        const op = this.find(tail[1]);
        if (op.state !== 'ready') this.start(op);
        return this.public(op);
      }
    }
    if (req.method === 'DELETE' && tail.length === 2) return this.cancel(tail[1], true);
    if (req.method === 'GET') {
      if (tail.length === 2) return this.public(this.find(tail[1]));
      if (tail.length === 3 && tail[2] === 'manifest') return this.manifest(tail[1]);
      if (tail.length === 4 && tail[2] === 'blobs') return this.blob(tail[1], tail[3]);
    }
    throw fail('LOCAL_IMPORT_ROUTE_NOT_FOUND', 'Source import route not found.', 404);
  }

  shutdown() {
    this.stopping = true;
    this.operation?.controller.abort();
  }

  async settled() { await this.operation?.running; }
}
