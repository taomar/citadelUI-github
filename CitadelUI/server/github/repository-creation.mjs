/**
 * Full-snapshot importer, intentionally separate from the filtered editor.
 *
 * One runner and one serialized journal own all imports in this server process.
 * The data root must have a single server writer, as for the other app stores.
 * Only metadata/object hashes are durable; credentials, sessions and source
 * contents never enter the journal. At most one bounded source cache is held.
 *
 * Defaults: 64 MiB aggregate, 8 MiB/blob, 10,000 files, 20,000 manifest entries,
 * 2,000 directories, 16 MiB/tree request. Content writes are paced and a durable
 * rolling 60/minute, 450/hour budget pauses rather than sleeping for hours.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from '../atomic-json.mjs';
import { githubError } from './api.mjs';
import { inspectRepositoryCompatibility } from './compatibility.mjs';
import { isLfsPointer } from './repositories.mjs';
import { refNameProblem } from '../../shared/git-refs.mjs';
import { DEFAULT_REPOSITORY_SOURCE, parseRepositorySource, validateNewRepositoryName } from '../../shared/repository-source.mjs';

const DEFAULT_LIMITS = Object.freeze({
  totalBytes: 64 * 1024 * 1024, blobBytes: 8 * 1024 * 1024,
  files: 10_000, entries: 20_000, directories: 2000,
  treeBytes: 16 * 1024 * 1024, manifestBytes: 8 * 1024 * 1024,
  operations: 100, writeIntervalMs: 1100, writesPerMinute: 60, writesPerHour: 450,
});
const ACTIVE = new Set(['preparing', 'creating', 'copying', 'verifying']);
const STAGES = Object.freeze({
  queued: 'Waiting for the importer.',
  source: 'Resolving the source repository.',
  manifest: 'Checking the complete source tree.',
  blobs: 'Validating every source file.',
  compatibility: 'Checking Citadel compatibility.',
  ready: 'Source checked. Ready to create a private repository.',
  identity: 'Verifying the connected GitHub account.',
  'creating-private-repository': 'Creating the private repository.',
  objects: 'Copying the complete source snapshot.',
  'publishing-main': 'Publishing the snapshot on main.',
  'default-branch': 'Setting main as the default branch.',
  'bootstrap-cleanup': 'Removing the verified bootstrap branch.',
  'verify-snapshot': 'Verifying imported files and private repository settings.',
  complete: 'Private repository created and verified.',
  pausing: 'Pausing after the current request finishes.',
  paused: 'Paused at a safe checkpoint.',
  failed: 'Import stopped. Review the error before resuming.',
  interrupted: 'Interrupted. Reconnect and resume to continue.',
  superseded: 'Replaced by a newer read-only preparation.',
});
const SHA = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const UUID = /^[0-9a-f-]{36}$/;
const fail = (code, message, status = 409) => githubError(status, code, message);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const objectHash = (type, bytes) =>
  createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
const sha = (value) => {
  if (!SHA.test(value || '')) throw fail('IMPORT_INVALID_OBJECT', 'GitHub returned an invalid Git object.', 502);
  return value;
};
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const ep = (name) => `/repos/${name}`;
const refPath = (name, branch) => `${ep(name)}/git/ref/heads/${encodeURIComponent(branch)}`;
const sameName = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

function safePath(value, single = false) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 ||
      /[\u0000-\u001f\u007f\\]/u.test(value) || Buffer.from(value).toString('utf8') !== value ||
      (single && value.includes('/')) || value.split('/').length > 64 ||
      value.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw fail('IMPORT_UNSAFE_PATH', 'The source contains an unsafe Git path.', 422);
  }
  return value;
}

function treeHash(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(
    Buffer.from(a.path + (a.type === 'tree' ? '/' : '')),
    Buffer.from(b.path + (b.type === 'tree' ? '/' : ''))
  ));
  return objectHash('tree', Buffer.concat(sorted.map((entry) => Buffer.concat([
    Buffer.from(`${entry.type === 'tree' ? '40000' : entry.mode} ${entry.path}\0`),
    Buffer.from(entry.sha, 'hex'),
  ]))));
}

function decodeBlob(data, entry, limit) {
  if (data?.encoding !== 'base64' || data.sha !== entry.sha ||
      !Number.isSafeInteger(data.size) || data.size < 0 || data.size > limit ||
      data.size !== entry.size || typeof data.content !== 'string') {
    throw fail('IMPORT_INVALID_BLOB', 'The source blob encoding or declared size is invalid.', 422);
  }
  const encoded = data.content.replace(/[\r\n]/g, '');
  if (encoded.length > Math.ceil(limit / 3) * 4 || encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw fail('IMPORT_INVALID_BLOB', 'The source blob has invalid base64 content.', 422);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== data.size || bytes.toString('base64') !== encoded || objectHash('blob', bytes) !== entry.sha) {
    throw fail('IMPORT_HASH_MISMATCH', 'The source blob does not match its Git object hash.', 422);
  }
  const text = bytes.toString('utf8');
  if (isLfsPointer(text)) throw fail('IMPORT_LFS_UNSUPPORTED', 'Git LFS pointers cannot be imported as complete source files.', 422);
  return { bytes, text: !bytes.includes(0) && Buffer.from(text, 'utf8').equals(bytes) ? text : null };
}

function treeEntry(entry, blobs) {
  const base = { path: entry.path, type: entry.type, mode: entry.mode };
  const text = entry.type === 'blob' ? blobs.get(entry.sha).text : null;
  return text === null ? { ...base, sha: entry.sha } : { ...base, content: text };
}

function sanitizedError(error, op) {
  const messages = {
    IMPORT_PAUSED: 'Paused at a safe checkpoint. An already-sent request may have finished.',
    IMPORT_SUPERSEDED: 'A newer read-only request replaced this preparation. Use the newer operation.',
    IMPORT_AUTH_REQUIRED: 'Reconnect the same GitHub account before resuming.',
    IMPORT_WRONG_ACCOUNT: 'Reconnect the original GitHub account before resuming.',
    IMPORT_RATE_LIMITED: 'GitHub write budget or rate limit reached. Wait before resuming.',
    IMPORT_DESTINATION_EXISTS: 'That repository already exists. Citadel will not adopt or overwrite it.',
    IMPORT_DESTINATION_CHANGED: 'The destination identity, privacy, settings or branch changed outside this operation. Nothing will be overwritten.',
    IMPORT_BOOTSTRAP_PENDING: 'The private repository is not initialized yet. Resume to check its initial commit.',
    IMPORT_BOOTSTRAP_CHANGED: 'The initial repository content was not the expected bootstrap. Nothing will be overwritten.',
    IMPORT_SOURCE_CHANGED: 'The pinned source repository identity or Git object changed.',
    IMPORT_SOURCE_UNSUPPORTED: 'The source does not contain a supported Citadel workspace.',
    IMPORT_LIMIT: 'The source exceeds the importer file, directory, request or byte limit.',
    IMPORT_UNSAFE_PATH: 'The source contains an unsafe Git path.',
    IMPORT_UNSUPPORTED_MODE: 'The source contains a symlink, submodule or unsupported Git mode.',
    IMPORT_TRUNCATED: 'GitHub could not return a complete source tree.',
    IMPORT_INVALID_OBJECT: 'GitHub returned an invalid Git object.',
    IMPORT_INVALID_BLOB: 'A source blob has invalid encoding or size.',
    IMPORT_HASH_MISMATCH: 'Git object verification failed; the complete snapshot was not proven.',
    IMPORT_LFS_UNSUPPORTED: 'Git LFS files cannot be imported as complete source files.',
    IMPORT_ACTIONS_ENABLED: 'Repository Actions must remain disabled while importing workflows.',
    IMPORT_RENAME_PENDING: 'GitHub has not confirmed the branch rename yet. Resume this same operation to check again.',
    IMPORT_STORAGE_UNAVAILABLE: 'The recovery journal could not be written. No further GitHub requests will be sent. Restore data-directory access, then resume this attempt.',
    IMPORT_FAILED: 'GitHub could not finish the import. Check permissions and resume the same operation.',
  };
  const code = error?.status === 401 ? 'IMPORT_AUTH_REQUIRED'
    : error?.code === 'GITHUB_RATE_LIMITED' || error?.status === 429
    ? 'IMPORT_RATE_LIMITED'
    : Object.hasOwn(messages, error?.code) ? error.code : 'IMPORT_FAILED';
  const retained = op.repositoryId
    ? ' The created repository is retained; Citadel will not delete it.'
    : op.createAttempted ? ' Creation may have succeeded; resume this operation to reconcile it safely.' : '';
  return { code, message: messages[code] + retained };
}

export class RepositoryCreationService {
  constructor({ dataRoot, client, note, validateSession = null, now = () => Date.now(), wait, limits = {} }) {
    this.path = join(dataRoot, 'repository-creations.json');
    this.client = client;
    this.note = note;
    this.validateSession = validateSession;
    this.now = now;
    this.wait = wait;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < (key === 'writeIntervalMs' ? 0 : 1)) throw new Error('Invalid importer limits.');
    }
    this.records = new Map();
    this.writeTimes = [];
    this.tail = Promise.resolve();
    this.networkTail = Promise.resolve();
    this.queue = [];
    this.running = null;
    this.pauses = new Set();
    this.pacingWaits = new Set();
    this.cache = null;
    this.stopping = false;
    this.initialized = false;
    this.fatalError = null;
  }

  serial(fn) {
    const pending = this.tail.then(fn);
    this.tail = pending.catch(() => {});
    return pending;
  }

  async save() {
    await atomicJson(this.path, { version: 1, operations: [...this.records.values()], writeTimes: this.writeTimes });
  }

  async initialize() {
    return this.serial(async () => {
      if (this.initialized) return;
      let stored;
      try { stored = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stored) {
        if (stored.version !== 1 || !Array.isArray(stored.operations) ||
            stored.operations.length > this.limits.operations || !Array.isArray(stored.writeTimes)) {
          throw new Error('Invalid repository creation journal.');
        }
        for (const op of stored.operations) {
          if (!UUID.test(op.id) || !UUID.test(op.nonce) || !validId(op.accountId) || !LOGIN.test(op.login) ||
              validateNewRepositoryName(op.name) !== op.name || !SHA.test(op.source?.commit || '0'.repeat(40))) {
            throw new Error('Invalid repository creation journal.');
          }
          if (op.state !== 'complete') {
            op.state = 'paused';
            op.stage = op.superseded ? 'superseded' : 'interrupted';
            op.error = sanitizedError({ code: op.superseded ? 'IMPORT_SUPERSEDED' : 'IMPORT_PAUSED' }, op);
          }
          this.records.set(op.id, op);
        }
        this.writeTimes = stored.writeTimes.filter((stamp) => Number.isFinite(stamp) && this.now() - stamp < 3_600_000);
      }
      await this.save();
      this.initialized = true;
    });
  }

  authorize(session, op = null) {
    this.validateSession?.(session);
    if (!session?.token || typeof session.token !== 'string' || !validId(session.accountId) || !LOGIN.test(session.login || '')) {
      throw fail('IMPORT_AUTH_REQUIRED', 'Connect GitHub before using repository creation.', 401);
    }
    if (op && session.accountId !== op.accountId) throw fail('IMPORT_WRONG_ACCOUNT', 'This operation belongs to another GitHub account.', 403);
    return session.token;
  }

  find(session, id) {
    this.authorize(session);
    const op = this.records.get(id);
    if (!op || op.accountId !== session.accountId) throw fail('IMPORT_NOT_FOUND', 'Repository creation operation not found.', 404);
    return op;
  }

  public(op) {
    const running = this.queue.some((job) => job.id === op.id) || this.currentId === op.id;
    return {
      id: op.id, state: op.state, stage: STAGES[op.stage] || 'Preparing the repository import.',
      sourceUrl: op.sourceUrl, running,
      source: op.source ? {
        fullName: op.source.fullName, ref: op.source.ref, commit: op.source.commit,
        tree: op.source.tree, fileCount: op.source.fileCount, totalBytes: op.source.totalBytes,
        hasWorkflows: op.source.hasWorkflows,
      } : null,
      destination: {
        name: op.name, fullName: `${op.login}/${op.name}`, private: true,
        repositoryId: op.repositoryId || null, branch: 'main',
        htmlUrl: `https://github.com/${op.login}/${op.name}`,
      },
      progress: { ...op.progress }, error: op.error ? { ...op.error } : null,
      created: Boolean(op.repositoryId), actionsDisabled: Boolean(op.actionsDisabled),
      canStart: op.state === 'ready' && !running && !op.superseded && !this.stopping && !this.fatalError,
      canResume: !running && !op.superseded && !this.stopping && ['paused', 'failed'].includes(op.state),
      canPause: running && !this.pauses.has(op.id) && !this.stopping,
    };
  }

  replaceable(op) {
    return !op.authorized && !op.createAttempted && !op.repositoryId && !this.isScheduled(op.id) &&
      ['ready', 'paused', 'failed'].includes(op.state);
  }

  requireCurrent(op) {
    if (op.superseded) throw fail('IMPORT_SUPERSEDED', 'A newer preparation replaced this operation. Use the newer operation.', 409);
  }

  async prepare(session, input) {
    return this.serial(async () => {
      this.authorize(session);
      if (this.fatalError) throw this.fatalError;
      if (!this.initialized || this.stopping) throw fail('IMPORT_UNAVAILABLE', 'Repository creation is unavailable.', 503);
      if (!input || Object.keys(input).some((key) => !['name', 'sourceUrl', 'operationKey'].includes(key))) {
        throw fail('IMPORT_INVALID_INPUT', 'Only a name, source URL and operation key are accepted.', 400);
      }
      let name, parsed;
      try {
        name = validateNewRepositoryName(input.name);
        parsed = parseRepositorySource(input.sourceUrl ?? DEFAULT_REPOSITORY_SOURCE);
      } catch { throw fail('IMPORT_INVALID_INPUT', 'Use a valid repository name and a GitHub repository-root source URL.', 400); }
      if (typeof input.operationKey !== 'string' || input.operationKey.length < 8 || input.operationKey.length > 200 ||
          /[\u0000-\u0020\u007f]/.test(input.operationKey)) {
        throw fail('IMPORT_INVALID_INPUT', 'Supply a stable operation key of 8-200 non-space characters.', 400);
      }
      const keyHash = hash(input.operationKey);
      const prior = [...this.records.values()].find((op) => op.accountId === session.accountId && op.keyHash === keyHash);
      if (prior) {
        if (prior.name !== name || prior.sourceUrl !== parsed.url) throw fail('IMPORT_KEY_CONFLICT', 'That operation key was already used with different inputs.', 409);
        return this.public(prior);
      }
      const reservations = [...this.records.values()].filter((op) =>
        op.accountId === session.accountId && sameName(op.name, name) && !op.superseded);
      if (reservations.some((op) => !this.replaceable(op))) {
        throw fail('IMPORT_DESTINATION_RESERVED', 'Another operation already owns this destination name. Resume that operation.', 409);
      }
      // Idempotency for read-only intents lasts for the bounded history window.
      // Retire oldest superseded/failed preparations first, then inactive ready
      // ones. NEVER discard authorized creation/nonces or retained-repo recovery
      // checkpoints merely to make space for another preparation.
      let evicted;
      if (this.records.size >= this.limits.operations) {
        const priority = (op) => op.superseded ? 0 : op.state === 'failed' ? 1 : op.state === 'paused' ? 2 : 3;
        evicted = [...this.records.values()].filter((op) => this.replaceable(op))
          .sort((a, b) => priority(a) - priority(b))[0];
        if (!evicted) throw fail('IMPORT_LIMIT', 'Repository creation history is full of active or recovery-protected operations.', 429);
      }
      const op = {
        id: randomUUID(), nonce: randomUUID(), accountId: session.accountId, login: session.login,
        profileId: UUID.test(session.profileId || '') ? session.profileId : null,
        name, sourceUrl: parsed.url, keyHash,
        state: 'preparing', stage: 'queued', source: null, repositoryId: null,
        authorized: false, createAttempted: false, actionsDisabled: false,
        progress: { completed: 0, total: 0, unit: 'files' }, error: null,
        createdAt: new Date(this.now()).toISOString(),
        uploadedBlobs: [], uploadedTrees: [],
      };
      for (const previous of reservations) {
        previous.superseded = true;
        previous.state = 'paused';
        previous.stage = 'superseded';
        previous.error = sanitizedError({ code: 'IMPORT_SUPERSEDED' }, previous);
        if (this.cache?.id === previous.id) this.cache = null;
      }
      if (evicted) {
        this.records.delete(evicted.id);
        this.pauses.delete(evicted.id);
        if (this.cache?.id === evicted.id) this.cache = null;
      }
      this.records.set(op.id, op);
      await this.save();
      this.enqueue(op, session);
      return this.public(op);
    });
  }

  async list(session) {
    return this.serial(() => {
      this.authorize(session);
      return { operations: [...this.records.values()].filter((op) => op.accountId === session.accountId).map((op) => this.public(op)) };
    });
  }

  async status(session, id) { return this.serial(() => this.public(this.find(session, id))); }

  async start(session, id) {
    return this.serial(async () => {
      if (this.stopping) throw fail('IMPORT_UNAVAILABLE', 'Repository creation is shutting down.', 503);
      const op = this.find(session, id);
      this.requireCurrent(op);
      if (this.fatalError) throw this.fatalError;
      if (this.isScheduled(id) || op.state === 'complete') return this.public(op);
      if (op.state !== 'ready') throw fail('IMPORT_NOT_READY', 'Complete read-only source validation before creating the repository.', 409);
      op.authorized = true;
      op.state = 'creating';
      op.stage = 'queued';
      await this.save();
      this.enqueue(op, session);
      return this.public(op);
    });
  }

  async resume(session, id) {
    return this.serial(async () => {
      if (this.stopping) throw fail('IMPORT_UNAVAILABLE', 'Repository creation is shutting down.', 503);
      const op = this.find(session, id);
      this.requireCurrent(op);
      if (this.fatalError) {
        try { await this.save(); }
        catch { throw this.fatalError; }
        this.fatalError = null;
      }
      if (this.isScheduled(id) || op.state === 'complete' || op.state === 'ready') return this.public(op);
      if (!['paused', 'failed'].includes(op.state)) throw fail('IMPORT_NOT_RESUMABLE', 'This operation cannot be resumed yet.', 409);
      if (op.retryAt && this.now() < op.retryAt) return this.public(op);
      op.state = 'preparing';
      op.stage = 'queued';
      op.error = null;
      await this.save();
      this.enqueue(op, session);
      return this.public(op);
    });
  }

  async pause(session, id) {
    // Set the stop flag before waiting for the journal lock. An in-flight
    // request is checkpointed when it returns, never described as cancelled.
    const op = this.find(session, id);
    if (this.fatalError) return this.public(op);
    if (op.superseded) return this.public(op);
    this.pauses.add(id);
    return this.serial(async () => {
      if (!this.isScheduled(id) && op.state !== 'complete') {
        op.state = 'paused';
        op.stage = 'paused';
        op.error = sanitizedError({ code: 'IMPORT_PAUSED' }, op);
        if (this.cache?.id === id) this.cache = null;
        await this.save();
      } else if (op.state !== 'complete') {
        op.stage = 'pausing';
        await this.save();
      }
      return this.public(op);
    });
  }

  isScheduled(id) { return this.currentId === id || this.queue.some((job) => job.id === id); }

  enqueue(op, session) {
    if (this.fatalError) throw this.fatalError;
    if (this.stopping) throw fail('IMPORT_UNAVAILABLE', 'Repository creation is shutting down.', 503);
    this.pauses.delete(op.id);
    this.queue.push({ id: op.id, session });
    if (!this.running) {
      this.running = Promise.resolve().then(async () => {
        while (this.queue.length) {
          const job = this.queue.shift();
          this.currentId = job.id;
          try {
            await this.run(this.records.get(job.id), job.session);
          } catch {
            // run() already tried to checkpoint its failure. Preserve this
            // fatal outcome in memory when even that journal write failed.
            this.fatalError = fail('IMPORT_STORAGE_UNAVAILABLE',
              'The recovery journal could not be written. Restore data-directory access, then resume the retained attempt.', 503);
            for (const record of this.records.values()) {
              if (ACTIVE.has(record.state) || record.id === job.id) {
                record.state = 'paused';
                record.stage = 'failed';
                record.error = sanitizedError(this.fatalError, record);
              }
            }
            this.queue.length = 0;
            this.cache = null;
            break;
          } finally {
            this.currentId = null;
          }
        }
      }).finally(() => { this.running = null; });
    }
  }

  async settled() {
    while (this.running) await this.running;
    await this.networkTail;
    await this.tail;
    if (this.fatalError) throw this.fatalError;
  }

  shutdown() {
    // Synchronous for the server's close event: revoke all future calls and
    // clear owned timers now. Tests/controlled teardown await settled() to let
    // an already-sent API request finish and checkpoint its proven result.
    this.stopping = true;
    for (const op of this.records.values()) if (ACTIVE.has(op.state)) this.pauses.add(op.id);
    for (const waiting of this.pacingWaits) waiting.cancel();
    this.pacingWaits.clear();
    if (!this.running) this.cache = null;
  }

  async pace(ms) {
    let timer;
    let release;
    const cancelled = new Promise((resolve) => { release = resolve; });
    const waiting = { cancel: () => { clearTimeout(timer); release(); } };
    this.pacingWaits.add(waiting);
    try {
      const elapsed = this.wait
        ? Promise.resolve().then(() => this.stopping ? undefined : this.wait(ms))
        : new Promise((resolve) => { timer = setTimeout(resolve, ms); });
      await Promise.race([elapsed, cancelled]);
    } finally {
      clearTimeout(timer);
      this.pacingWaits.delete(waiting);
    }
  }

  async checkpoint(op, patch = {}) {
    await this.serial(async () => {
      Object.assign(op, patch);
      await this.save();
    });
  }

  check(op, session) {
    if (this.fatalError) throw this.fatalError;
    const token = this.authorize(session, op);
    if (this.stopping || this.pauses.has(op.id)) throw fail('IMPORT_PAUSED', 'Import paused.');
    return token;
  }

  async request(op, session, path, options = {}) {
    // Compatibility discovery can request several blobs concurrently. Serialize
    // those too, and read the mutable session only when the call actually starts.
    const pending = this.networkTail.then(() => {
      const token = this.check(op, session);
      return this.client.request(path, { ...options, token });
    });
    this.networkTail = pending.catch(() => {});
    return pending;
  }

  async read(op, session, path, options) { return (await this.request(op, session, path, options)).data; }

  async optional(op, session, path, options) {
    try { return await this.read(op, session, path, options); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }

  async budget(op, session) {
    this.check(op, session);
    let stamps = this.writeTimes.filter((stamp) => this.now() - stamp < 3_600_000);
    const minute = stamps.filter((stamp) => this.now() - stamp < 60_000);
    if (stamps.length >= this.limits.writesPerHour || minute.length >= this.limits.writesPerMinute) {
      const retryAt = stamps.length >= this.limits.writesPerHour ? stamps[0] + 3_600_000 : minute[0] + 60_000;
      await this.checkpoint(op, { retryAt });
      throw fail('IMPORT_RATE_LIMITED', 'Importer write budget reached.', 429);
    }
    const delay = stamps.length ? Math.max(0, stamps.at(-1) + this.limits.writeIntervalMs - this.now()) : 0;
    if (delay) await this.pace(Math.min(delay, 2000));
    this.check(op, session);
    // Count attempts, including responses lost in transit, before sending.
    await this.serial(async () => {
      stamps = this.writeTimes.filter((stamp) => this.now() - stamp < 3_600_000);
      this.writeTimes = [...stamps, this.now()];
      await this.save();
    });
  }

  async write(op, session, path, method, body, guard = true) {
    await this.budget(op, session);
    if (guard) await this.guard(op, session);
    if (guard && !path.endsWith('/actions/permissions')) await this.requireActionsDisabled(op, session);
    return this.read(op, session, path, { method, ...(body === undefined ? {} : { body }), limit: this.limits.manifestBytes });
  }

  async run(op, session) {
    try {
      this.check(op, session);
      await this.preflight(op, session);
      this.check(op, session);
      if (!op.authorized) {
        await this.checkpoint(op, { state: 'ready', stage: 'ready', error: null });
        this.check(op, session);
        return;
      }
      await this.create(op, session);
      await this.copy(op, session);
      await this.verify(op, session);
      this.check(op, session);
      await this.checkpoint(op, { state: 'complete', stage: 'complete', error: null });
      await this.activity(op, 'ok');
    } catch (error) {
      const clean = sanitizedError(error, op);
      const paused = ['IMPORT_PAUSED', 'IMPORT_AUTH_REQUIRED', 'IMPORT_WRONG_ACCOUNT', 'IMPORT_RATE_LIMITED',
        'IMPORT_DESTINATION_CHANGED', 'IMPORT_BOOTSTRAP_PENDING', 'IMPORT_BOOTSTRAP_CHANGED', 'IMPORT_ACTIONS_ENABLED', 'IMPORT_RENAME_PENDING'].includes(clean.code);
      const retryAfter = Number(error?.retryAfterSeconds);
      const resetAt = Date.parse(error?.rateResetAt);
      const retryAt = clean.code === 'IMPORT_RATE_LIMITED'
        ? Math.max(op.retryAt || 0, this.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 86_400) * 1000 : 60_000),
          Number.isFinite(resetAt) ? Math.min(resetAt, this.now() + 86_400_000) : 0)
        : null;
      await this.checkpoint(op, { state: paused ? 'paused' : 'failed', stage: paused ? 'paused' : 'failed', error: clean, retryAt });
      if (clean.code !== 'IMPORT_PAUSED') await this.activity(op, op.createAttempted ? 'failed' : 'refused');
    } finally {
      // Keep only a ready operation's cache. Failed/paused jobs refetch pinned
      // immutable objects; a new preflight evicts any previous ready cache.
      if ((this.stopping || op.state !== 'ready') && this.cache?.id === op.id) this.cache = null;
    }
  }

  async activity(op, outcome) {
    if (!this.note) return;
    try {
      await this.note({ action: 'repository.create', outcome, target: `${op.login}/${op.name}`,
        account: op.login, reason: outcome === 'ok' ? 'repository-created' : outcome === 'refused' ? 'repository-create-refused' : 'repository-create-failed' });
    } catch { /* Activity failure does not undo a proven Git checkpoint. */ }
  }

  async manifest(op, session, name, root) {
    const limit = this.limits.manifestBytes;
    const recursive = await this.read(op, session, `${ep(name)}/git/trees/${root}?recursive=1`, { limit });
    if (recursive?.sha !== root || !Array.isArray(recursive.tree)) throw fail('IMPORT_INVALID_OBJECT', 'Invalid tree.', 502);
    let entries;
    if (recursive.truncated === false) entries = recursive.tree;
    else if (recursive.truncated === true) {
      entries = [];
      const queue = [{ tree: root, prefix: '' }];
      let directories = 0;
      while (queue.length) {
        if (++directories > this.limits.directories) throw fail('IMPORT_LIMIT', 'Too many directories.', 413);
        const current = queue.shift();
        const node = await this.read(op, session, `${ep(name)}/git/trees/${current.tree}`, { limit });
        if (node?.sha !== current.tree || node.truncated !== false || !Array.isArray(node.tree)) throw fail('IMPORT_TRUNCATED', 'Incomplete source tree.', 422);
        for (const entry of node.tree) {
          safePath(entry.path, true);
          const path = current.prefix + entry.path;
          entries.push({ ...entry, path });
          if (entries.length > this.limits.entries) throw fail('IMPORT_LIMIT', 'Too many entries.', 413);
          if (entry.type === 'tree') queue.push({ tree: sha(entry.sha), prefix: `${path}/` });
        }
      }
    } else throw fail('IMPORT_TRUNCATED', 'Missing tree completeness flag.', 422);
    if (entries.length > this.limits.entries) throw fail('IMPORT_LIMIT', 'Too many entries.', 413);
    const byPath = new Map();
    const directories = new Map([['', { path: '', sha: root, entries: [] }]]);
    const files = [];
    let totalBytes = 0;
    for (const raw of entries) {
      const path = safePath(raw.path);
      sha(raw.sha);
      if (byPath.has(path)) throw fail('IMPORT_UNSAFE_PATH', 'Duplicate Git path.', 422);
      const entry = { path, type: raw.type, mode: raw.mode, sha: raw.sha };
      if (entry.type === 'tree' && entry.mode === '040000') {
        directories.set(path, { path, sha: entry.sha, entries: [] });
      } else if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)) {
        if (!Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > this.limits.blobBytes) throw fail('IMPORT_LIMIT', 'Invalid or excessive blob size.', 413);
        entry.size = raw.size;
        totalBytes += entry.size;
        files.push(entry);
      } else throw fail('IMPORT_UNSUPPORTED_MODE', 'Unsupported Git mode.', 422);
      byPath.set(path, entry);
    }
    if (files.length > this.limits.files || totalBytes > this.limits.totalBytes || directories.size > this.limits.directories) {
      throw fail('IMPORT_LIMIT', 'Source limits exceeded.', 413);
    }
    for (const entry of byPath.values()) {
      const index = entry.path.lastIndexOf('/');
      const parent = directories.get(index < 0 ? '' : entry.path.slice(0, index));
      if (!parent) throw fail('IMPORT_UNSAFE_PATH', 'Missing Git directory.', 422);
      parent.entries.push({ ...entry, path: entry.path.slice(index + 1), fullPath: entry.path });
    }
    for (const dir of directories.values()) {
      if (treeHash(dir.entries) !== dir.sha) throw fail('IMPORT_HASH_MISMATCH', 'Source tree hash mismatch.', 422);
    }
    return { files, directories, totalBytes, entries: [...byPath.values()] };
  }

  async preflight(op, session) {
    if (this.cache?.id === op.id) return;
    this.cache = null;
    await this.checkpoint(op, { state: 'preparing', stage: 'source', error: null });
    const parsed = parseRepositorySource(op.sourceUrl);
    const metadata = await this.read(op, session, ep(parsed.fullName));
    if (!validId(metadata?.id) || !sameName(metadata.full_name, parsed.fullName) ||
        (op.source && op.source.repositoryId !== metadata.id)) throw fail('IMPORT_SOURCE_CHANGED', 'Source identity changed.');
    const ref = op.source?.ref || parsed.ref || metadata.default_branch;
    if (typeof ref !== 'string' || refNameProblem(ref)) throw fail('IMPORT_INVALID_OBJECT', 'Invalid source ref.', 422);
    const pinned = op.source?.commit;
    const commit = await this.read(op, session, `${ep(parsed.fullName)}/commits/${encodeURIComponent(pinned || ref)}`);
    sha(commit?.sha);
    const root = sha(commit?.commit?.tree?.sha);
    if (pinned && (commit.sha !== pinned || root !== op.source.tree)) throw fail('IMPORT_SOURCE_CHANGED', 'Pinned source changed.');
    const source = {
      fullName: parsed.fullName, repositoryId: metadata.id, ref, commit: commit.sha, tree: root,
      fileCount: 0, totalBytes: 0, hasWorkflows: false,
    };
    // Persist pin before the potentially long walk. Resume never resolves a
    // moving ref again, even if pause occurs during the first blob read.
    await this.checkpoint(op, { source, stage: 'manifest' });
    const manifest = await this.manifest(op, session, source.fullName, root);
    source.fileCount = manifest.files.length;
    source.totalBytes = manifest.totalBytes;
    source.hasWorkflows = manifest.files.some((file) => /^\.github\/workflows\//i.test(file.path));
    await this.checkpoint(op, { source, stage: 'blobs', progress: { completed: 0, total: source.fileCount, unit: 'files' } });
    const blobs = new Map();
    let completed = 0;
    for (const entry of manifest.files) {
      if (!blobs.has(entry.sha)) {
        const data = await this.read(op, session, `${ep(source.fullName)}/git/blobs/${entry.sha}`, { limit: Math.ceil(this.limits.blobBytes * 1.4) + 4096 });
        blobs.set(entry.sha, decodeBlob(data, entry, this.limits.blobBytes));
      } else if (blobs.get(entry.sha).bytes.length !== entry.size) throw fail('IMPORT_HASH_MISMATCH', 'Inconsistent repeated blob size.', 422);
      completed += 1;
      await this.checkpoint(op, { progress: { completed, total: source.fileCount, unit: 'files' } });
    }
    // Bound actual wire JSON, including text escaping, before creation. Every
    // exact UTF-8 file is inline; ONLY binary blobs use the base64 write API.
    // Count entries incrementally so an oversized directory is never assembled
    // into one oversized JSON string just to discover it exceeds the bound.
    for (const dir of manifest.directories.values()) {
      let wireBytes = Buffer.byteLength('{"tree":[]}');
      for (const entry of dir.entries) {
        wireBytes += Buffer.byteLength(JSON.stringify(treeEntry(entry, blobs))) + 1;
        if (wireBytes > this.limits.treeBytes) throw fail('IMPORT_LIMIT', 'A Git tree exceeds the request bound.', 413);
      }
    }
    await this.checkpoint(op, { stage: 'compatibility' });
    // The compatibility helper's requests also re-resolve the live session.
    const guarded = { request: (path, options = {}) => this.request(op, session, path, options) };
    const verdict = await inspectRepositoryCompatibility(guarded, null, source.fullName, source.commit);
    if (!verdict.supported) throw fail('IMPORT_SOURCE_UNSUPPORTED', 'Unsupported Citadel source.', 422);
    this.check(op, session);
    this.cache = { id: op.id, ...manifest, blobs };
  }

  description(op) { return `Citadel full snapshot operation ${op.nonce}`; }

  validateDestination(op, repo) {
    if (!repo || !validId(repo.id) || (op.repositoryId && repo.id !== op.repositoryId) ||
        repo.owner?.id !== op.accountId || repo.owner?.type !== 'User' || repo.private !== true ||
        !sameName(repo.full_name, `${op.login}/${op.name}`) || repo.description !== this.description(op) ||
        repo.fork === true || repo.archived === true || repo.disabled === true) {
      throw fail('IMPORT_DESTINATION_CHANGED', 'Destination identity or privacy changed.');
    }
    return repo;
  }

  async destination(op, session) {
    return this.validateDestination(op, await this.read(op, session, ep(`${op.login}/${op.name}`)));
  }

  async branch(op, session, name) {
    const data = await this.optional(op, session, refPath(`${op.login}/${op.name}`, name));
    if (data === null) return null;
    if (data?.object?.type !== 'commit' || data.ref !== `refs/heads/${name}`) throw fail('IMPORT_INVALID_OBJECT', 'Invalid Git ref.', 502);
    return sha(data.object.sha);
  }

  async guard(op, session) {
    const repo = await this.destination(op, session);
    if (!op.bootstrap) return repo;
    const { branch, head } = op.bootstrap;
    if (op.defaultSet ? repo.default_branch !== 'main'
      : repo.default_branch !== branch && !(op.renameIntent && repo.default_branch === 'main')) {
      throw fail('IMPORT_DESTINATION_CHANGED', 'Default branch changed.');
    }
    const main = await this.branch(op, session, 'main');
    const published = op.bootstrapPublished || op.mainPublished;
    if (branch === 'main') {
      if (published ? main !== op.commitSha : main !== head && !(op.refIntent && main === op.commitSha)) {
        throw fail('IMPORT_DESTINATION_CHANGED', 'Main changed outside this operation.');
      }
    } else {
      const original = await this.branch(op, session, branch);
      if (op.mainPublished) {
        if (main !== op.commitSha || original !== null) throw fail('IMPORT_DESTINATION_CHANGED', 'Published branch identity changed.');
      } else if (op.renameIntent) {
        if (!op.bootstrapPublished || (main !== null && main !== op.commitSha) ||
            (original !== null && original !== op.commitSha) || (main === null && original === null)) {
          throw fail('IMPORT_DESTINATION_CHANGED', 'Branch rename conflicts with an external change.');
        }
      } else if (main !== null ||
          (published ? original !== op.commitSha : original !== head && !(op.refIntent && original === op.commitSha))) {
        throw fail('IMPORT_DESTINATION_CHANGED', 'Bootstrap or destination branch changed outside this operation.');
      }
    }
    return repo;
  }

  async create(op, session) {
    await this.checkpoint(op, { state: 'creating', stage: 'identity' });
    const identity = await this.read(op, session, '/user');
    if (identity?.id !== op.accountId || identity.type !== 'User' || !sameName(identity.login, op.login)) {
      throw fail('IMPORT_WRONG_ACCOUNT', 'GitHub identity differs from the creating account.', 403);
    }
    let repository = await this.optional(op, session, ep(`${op.login}/${op.name}`));
    if (repository) {
      if (!op.createAttempted) throw fail('IMPORT_DESTINATION_EXISTS', 'Existing destination.', 409);
      this.validateDestination(op, repository);
    } else {
      if (op.repositoryId) throw fail('IMPORT_DESTINATION_CHANGED', 'Created repository is missing.');
      // Durable authority and nonce precede the POST. A lost response can only
      // adopt this exact nonce/owner/private tuple, never a name by itself.
      await this.checkpoint(op, { createAttempted: true, stage: 'creating-private-repository' });
      repository = await this.write(op, session, '/user/repos', 'POST', {
        name: op.name, private: true, auto_init: true, description: this.description(op),
      }, false);
      this.validateDestination(op, repository);
      await this.checkpoint(op, { repositoryId: repository.id });
      repository = await this.destination(op, session);
    }
    await this.checkpoint(op, { repositoryId: repository.id });
    if (!op.bootstrap) {
      if (typeof repository.default_branch !== 'string' || refNameProblem(repository.default_branch)) throw fail('IMPORT_BOOTSTRAP_PENDING', 'Bootstrap pending.');
      const head = await this.branch(op, session, repository.default_branch);
      if (!head) throw fail('IMPORT_BOOTSTRAP_PENDING', 'Bootstrap pending.');
      const commit = await this.read(op, session, `${ep(`${op.login}/${op.name}`)}/git/commits/${head}`);
      if (commit?.sha !== head || !Array.isArray(commit.parents) || commit.parents.length !== 0) throw fail('IMPORT_BOOTSTRAP_CHANGED', 'Bootstrap was advanced.');
      const tree = sha(commit.tree?.sha);
      const snapshot = await this.manifest(op, session, `${op.login}/${op.name}`, tree);
      if (snapshot.files.length !== 1 || snapshot.entries.length !== 1 ||
          snapshot.files[0].path !== 'README.md' || snapshot.files[0].mode !== '100644') throw fail('IMPORT_BOOTSTRAP_CHANGED', 'Unexpected bootstrap.');
      const entry = snapshot.files[0];
      const blob = await this.read(op, session, `${ep(`${op.login}/${op.name}`)}/git/blobs/${entry.sha}`);
      if (!decodeBlob(blob, entry, this.limits.blobBytes).text?.includes(this.description(op))) throw fail('IMPORT_BOOTSTRAP_CHANGED', 'Bootstrap provenance missing.');
      const date = op.createdAt;
      await this.checkpoint(op, {
        bootstrap: { branch: repository.default_branch, head, tree },
        commitBody: {
          message: `Import full snapshot ${op.source.fullName}@${op.source.commit}\n\nCitadel-Operation: ${op.nonce}`,
          tree: op.source.tree, parents: [head],
          author: { name: 'Citadel snapshot importer', email: 'snapshot@citadel.invalid', date },
          committer: { name: 'Citadel snapshot importer', email: 'snapshot@citadel.invalid', date },
        },
      });
    }
    await this.guard(op, session);
    if (op.source.hasWorkflows) {
      const path = `${ep(`${op.login}/${op.name}`)}/actions/permissions`;
      const permissions = await this.read(op, session, path);
      if (permissions?.enabled !== false) {
        if (op.actionsDisabled) throw fail('IMPORT_ACTIONS_ENABLED', 'Actions were re-enabled.');
        await this.write(op, session, path, 'PUT', { enabled: false });
      }
      if ((await this.read(op, session, path))?.enabled !== false) throw fail('IMPORT_ACTIONS_ENABLED', 'Actions remain enabled.');
      await this.checkpoint(op, { actionsDisabled: true });
    }
  }

  async requireActionsDisabled(op, session) {
    if (op.source.hasWorkflows &&
        (await this.read(op, session, `${ep(`${op.login}/${op.name}`)}/actions/permissions`))?.enabled !== false) {
      throw fail('IMPORT_ACTIONS_ENABLED', 'Actions must remain disabled.');
    }
  }

  async copy(op, session) {
    const base = ep(`${op.login}/${op.name}`);
    const cache = this.cache;
    await this.checkpoint(op, { state: 'copying', stage: 'objects', progress: { completed: 0, total: op.source.fileCount, unit: 'files' } });
    const uploaded = new Set(op.uploadedBlobs);
    // Complete bottom-up directory trees, never base_tree overlays. All UTF-8
    // content is inline; only binary/NUL/non-UTF8 bytes use base64 blob writes.
    const directories = [...cache.directories.values()].sort((a, b) => b.path.split('/').length - a.path.split('/').length || b.path.length - a.path.length);
    let completed = 0;
    for (const dir of directories) {
      const tree = dir.entries.map((entry) => treeEntry(entry, cache.blobs));
      for (let i = 0; i < dir.entries.length; i += 1) {
        const entry = dir.entries[i];
        if (entry.type !== 'blob') continue;
        const blob = cache.blobs.get(entry.sha);
        if (blob.text === null) {
          // Unreferenced objects can be garbage collected between runs. A
          // journal hash is proof of a previous write, not continued existence.
          if (uploaded.has(entry.sha)) {
            const existing = await this.optional(op, session, `${base}/git/blobs/${entry.sha}`, { limit: Math.ceil(this.limits.blobBytes * 1.4) + 4096 });
            if (existing) decodeBlob(existing, entry, this.limits.blobBytes);
            else uploaded.delete(entry.sha);
          }
          if (!uploaded.has(entry.sha)) {
            const created = await this.write(op, session, `${base}/git/blobs`, 'POST', { content: blob.bytes.toString('base64'), encoding: 'base64' });
            if (created?.sha !== entry.sha) throw fail('IMPORT_HASH_MISMATCH', 'Uploaded blob hash differs.');
            uploaded.add(entry.sha);
            await this.checkpoint(op, { uploadedBlobs: [...uploaded] });
          }
        }
        completed += 1;
      }
      let exists = false;
      if (op.uploadedTrees.includes(dir.sha)) {
        const existing = await this.optional(op, session, `${base}/git/trees/${dir.sha}`, { limit: this.limits.manifestBytes });
        if (existing) {
          if (existing.sha !== dir.sha || existing.truncated !== false || !Array.isArray(existing.tree) ||
              treeHash(existing.tree) !== dir.sha) throw fail('IMPORT_HASH_MISMATCH', 'Checkpointed tree no longer matches.');
          exists = true;
        }
      }
      if (!exists) {
        const created = await this.write(op, session, `${base}/git/trees`, 'POST', { tree });
        if (created?.sha !== dir.sha) throw fail('IMPORT_HASH_MISMATCH', 'Uploaded tree hash differs.');
        await this.checkpoint(op, { uploadedTrees: [...new Set([...op.uploadedTrees, dir.sha])] });
      }
      await this.checkpoint(op, { progress: { completed, total: op.source.fileCount, unit: 'files' } });
    }
    if (!op.commitSha || !await this.optional(op, session, `${base}/git/commits/${op.commitSha}`)) {
      const commit = await this.write(op, session, `${base}/git/commits`, 'POST', op.commitBody);
      const commitSha = sha(commit?.sha);
      if (op.commitSha && commitSha !== op.commitSha) throw fail('IMPORT_HASH_MISMATCH', 'Replayed commit was not deterministic.');
      await this.checkpoint(op, { commitSha });
    }
    await this.verifyCommit(op, session);
    await this.guard(op, session);
    if (op.mainPublished) return;
    const original = op.bootstrap.branch;
    if (!op.bootstrapPublished) {
      if (await this.branch(op, session, original) !== op.commitSha) {
        await this.checkpoint(op, { refIntent: true, stage: 'publishing-main' });
        await this.write(op, session, `${base}/git/refs/heads/${encodeURIComponent(original)}`, 'PATCH', { sha: op.commitSha, force: false });
      }
      if (await this.branch(op, session, original) !== op.commitSha) throw fail('IMPORT_DESTINATION_CHANGED', 'Snapshot publication was not confirmed.');
      await this.checkpoint(op, { bootstrapPublished: true });
    }
    if (original === 'main') {
      await this.guard(op, session);
      await this.checkpoint(op, { mainPublished: true, defaultSet: true });
      return;
    }
    if (!op.mainPublished) {
      await this.guard(op, session);
      if (await this.branch(op, session, 'main') === null) {
        await this.checkpoint(op, { renameIntent: true, stage: 'default-branch' });
        // Rename preserves the branch's current commit atomically. A separate
        // head-check + DELETE could erase a concurrent commit and is never used.
        await this.write(op, session, `${base}/branches/${encodeURIComponent(original)}/rename`, 'POST', { new_name: 'main' });
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const repo = await this.guard(op, session);
        if (repo.default_branch === 'main' &&
            await this.branch(op, session, 'main') === op.commitSha &&
            await this.branch(op, session, original) === null) {
          await this.checkpoint(op, { mainPublished: true, defaultSet: true, bootstrapRenamed: true });
          return;
        }
        if (attempt < 3) { await this.pace(250 * (attempt + 1)); this.check(op, session); }
      }
      throw fail('IMPORT_RENAME_PENDING', 'Branch rename has not been confirmed.');
    }
  }

  async verifyCommit(op, session) {
    const commit = await this.read(op, session, `${ep(`${op.login}/${op.name}`)}/git/commits/${op.commitSha}`);
    if (commit?.sha !== op.commitSha || commit.tree?.sha !== op.source.tree ||
        !Array.isArray(commit.parents) || commit.parents.length !== 1 || commit.parents[0]?.sha !== op.bootstrap.head ||
        commit.message !== op.commitBody.message) throw fail('IMPORT_HASH_MISMATCH', 'Import commit does not match the pinned tree and parent.');
    for (const role of ['author', 'committer']) {
      const expected = op.commitBody[role];
      const actual = commit[role];
      if (actual?.name !== expected.name || actual?.email !== expected.email ||
          Math.floor(Date.parse(actual?.date) / 1000) !== Math.floor(Date.parse(expected.date) / 1000)) {
        throw fail('IMPORT_HASH_MISMATCH', 'Import commit metadata does not match its deterministic intent.');
      }
    }
  }

  async verify(op, session) {
    await this.checkpoint(op, { state: 'verifying', stage: 'verify-snapshot' });
    await this.verifyCommit(op, session);
    const actual = await this.manifest(op, session, `${op.login}/${op.name}`, op.source.tree);
    const comparable = (entries) => JSON.stringify([...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (comparable(actual.entries) !== comparable(this.cache.entries)) throw fail('IMPORT_HASH_MISMATCH', 'Destination manifest differs from source.');
    // Tree hashes attest all blob hashes; read back every unique blob as well,
    // so mock/API success alone never proves uploaded binary content fidelity.
    const seen = new Set();
    for (const entry of actual.files) {
      if (seen.has(entry.sha)) continue;
      const data = await this.read(op, session, `${ep(`${op.login}/${op.name}`)}/git/blobs/${entry.sha}`, { limit: Math.ceil(this.limits.blobBytes * 1.4) + 4096 });
      decodeBlob(data, entry, this.limits.blobBytes);
      seen.add(entry.sha);
    }
    await this.requireActionsDisabled(op, session);
    const repo = await this.guard(op, session);
    if (repo.default_branch !== 'main' || await this.branch(op, session, 'main') !== op.commitSha ||
        (op.bootstrap.branch !== 'main' && await this.branch(op, session, op.bootstrap.branch) !== null)) {
      throw fail('IMPORT_DESTINATION_CHANGED', 'Final repository verification failed.');
    }
  }
}
