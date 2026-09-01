import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALLOWED_SOURCE_EXTENSIONS = new Set(['.bicep', '.bicepparam', '.xml']);
const TERMINAL = new Set(['committed', 'rolled_back', 'failed', 'abandoned']);
const ZERO_HASH = '0'.repeat(64);

export function transactionError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function assertId(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value) || value === '.' || value === '..') {
    throw transactionError(400, 'INVALID_ID', `Invalid ${name}.`);
  }
  return value;
}

function optionalLabel(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw transactionError(400, 'INVALID_LABEL', `Invalid ${name}.`);
  const label = value.trim();
  if (!label || label.length > 160 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw transactionError(400, 'INVALID_LABEL', `Invalid ${name}.`);
  }
  return label;
}

export function normalizeSourceAlias(alias) {
  if (typeof alias !== 'string' || !alias || alias.length > 512 || alias.includes('\0')) {
    throw transactionError(400, 'INVALID_ALIAS', 'Invalid source alias.');
  }
  if (
    alias.startsWith('/') ||
    alias.startsWith('\\') ||
    /^[A-Za-z]:/.test(alias) ||
    alias.includes('\\')
  ) {
    throw transactionError(400, 'INVALID_ALIAS', 'Source aliases must be relative POSIX paths.');
  }
  const parts = alias.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.length > 255 ||
        /[\u0000-\u001f\u007f]/.test(part)
    )
  ) {
    throw transactionError(400, 'INVALID_ALIAS', 'Source alias contains an unsafe segment.');
  }
  if (parts.some((part) => part.toLowerCase() === '.azure')) {
    throw transactionError(400, 'EXCLUDED_ALIAS', 'The .azure directory is excluded.');
  }
  const leaf = parts.at(-1).toLowerCase();
  if (leaf === '.env' || leaf.startsWith('.env.')) {
    throw transactionError(400, 'EXCLUDED_ALIAS', 'Environment files are excluded.');
  }
  const dot = leaf.lastIndexOf('.');
  const extension = dot < 0 ? '' : leaf.slice(dot);
  if (!ALLOWED_SOURCE_EXTENSIONS.has(extension)) {
    throw transactionError(400, 'UNSUPPORTED_ALIAS', 'Unsupported source file type.');
  }
  return parts.join('/');
}

function normalizeDirectoryAlias(alias) {
  if (typeof alias !== 'string' || !alias || alias.length > 512 || alias.includes('\0')) {
    throw transactionError(400, 'INVALID_DIRECTORY_ALIAS', 'Invalid directory alias.');
  }
  if (
    alias.startsWith('/') ||
    alias.startsWith('\\') ||
    /^[A-Za-z]:/.test(alias) ||
    alias.includes('\\')
  ) {
    throw transactionError(
      400,
      'INVALID_DIRECTORY_ALIAS',
      'Directory aliases must be relative POSIX paths.'
    );
  }
  const parts = alias.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.length > 255 ||
        /[\u0000-\u001f\u007f]/.test(part)
    )
  ) {
    throw transactionError(
      400,
      'INVALID_DIRECTORY_ALIAS',
      'Directory alias contains an unsafe segment.'
    );
  }
  if (parts.some((part) => part.toLowerCase() === '.azure')) {
    throw transactionError(400, 'EXCLUDED_ALIAS', 'The .azure directory is excluded.');
  }
  return parts.join('/');
}

function contractCreationBoundary(files) {
  const matches = files.map((file) =>
    /^(.*\/citadel-access-contracts\/contracts)\/([^/]+)\/[^/]+$/.exec(file.alias)
  );
  if (
    matches.some((match) => !match) ||
    matches.some((match) => match[1] !== matches[0][1] || match[2] !== matches[0][2])
  ) {
    return null;
  }
  return matches[0][1];
}

function contractCreationDirectory(files) {
  const boundary = contractCreationBoundary(files);
  if (!boundary) return null;
  return files[0].alias.slice(0, files[0].alias.lastIndexOf('/'));
}

function normalizeCreatedDirectories(value, files) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 250) {
    throw transactionError(
      400,
      'INVALID_CREATED_DIRECTORIES',
      'Created directories must be an array of at most 250 aliases.'
    );
  }
  const newAliases = files.filter((file) => !file.existed).map((file) => file.alias);
  const directories = [...new Set(value.map(normalizeDirectoryAlias))];
  if (
    directories.some(
      (directory) => !newAliases.some((alias) => alias.startsWith(`${directory}/`))
    )
  ) {
    throw transactionError(
      400,
      'INVALID_CREATED_DIRECTORY',
      'Created directories must contain a newly created source.'
    );
  }
  return directories.sort(
    (left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right)
  );
}

function assertHash(value, name = 'hash') {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw transactionError(400, 'INVALID_HASH', `Invalid ${name}.`);
  }
  return value;
}

function assertSize(value, name = 'size') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw transactionError(400, 'INVALID_SIZE', `Invalid ${name}.`);
  }
  return value;
}

function normalizeChangedName(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z_][A-Za-z0-9_.\-[\]]*$/.test(value)
  ) {
    throw transactionError(400, 'INVALID_CHANGED_NAME', 'Invalid changed name.');
  }
  return value;
}

function normalizeChangedNameList(value) {
  if (!Array.isArray(value) || value.length > 100) {
    throw transactionError(
      400,
      'INVALID_CHANGED_NAMES',
      'Changed names must be an array of at most 100 names.'
    );
  }
  return [...new Set(value.map(normalizeChangedName))].sort();
}

function normalizeChangedNames(value, aliases) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return normalizeChangedNameList(value);
  if (!value || typeof value !== 'object') {
    throw transactionError(
      400,
      'INVALID_CHANGED_NAMES',
      'Changed names must be a list or an alias-to-list object.'
    );
  }
  const entries = Object.entries(value);
  if (entries.length > 250) {
    throw transactionError(400, 'INVALID_CHANGED_NAMES', 'Too many changed-name aliases.');
  }
  const normalized = {};
  let count = 0;
  for (const [candidateAlias, names] of entries) {
    const alias = normalizeSourceAlias(candidateAlias);
    if (!aliases.has(alias)) {
      throw transactionError(
        400,
        'UNKNOWN_CHANGED_NAME_ALIAS',
        'Changed-name alias is not in the manifest.'
      );
    }
    normalized[alias] = normalizeChangedNameList(names);
    count += normalized[alias].length;
  }
  if (count > 500) {
    throw transactionError(400, 'INVALID_CHANGED_NAMES', 'Too many changed names.');
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tokenMatches(token, digest) {
  if (typeof token !== 'string' || !digest) return false;
  const actual = Buffer.from(sha256(token), 'hex');
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicManifest(manifest) {
  return structuredClone(manifest);
}

function immutableManifestHash(manifest) {
  return sha256(
    JSON.stringify({
      version: manifest.version,
      transactionId: manifest.transactionId,
      environmentId: manifest.environmentId,
      targetId: manifest.targetId,
      changedAliases: manifest.changedAliases,
      changedNames: manifest.changedNames,
      createdDirectories: manifest.createdDirectories,
      ownedCleanupDirectories: manifest.ownedCleanupDirectories,
      files: manifest.files.map((file) => ({
        id: file.id,
        alias: file.alias,
        existed: file.existed,
        originalSize: file.originalSize,
        originalHash: file.originalHash,
      })),
    })
  );
}

async function syncDirectory(path) {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
  }
}

export async function atomicWrite(path, bytes, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await open(temp, 'wx', options.mode ?? 0o600);
    try {
      options.faultInjector?.('write');
      await handle.writeFile(bytes);
      options.faultInjector?.('sync');
      await handle.sync();
    } finally {
      await handle.close();
    }
    options.faultInjector?.('rename');
    await rename(temp, path);
    renamed = true;
    await syncDirectory(dirname(path));
  } finally {
    if (!renamed) await rm(temp, { force: true }).catch(() => {});
  }
}

async function atomicJson(path, value, options) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function directorySize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

export class TransactionStore {
  constructor(options = {}) {
    if (!options.dataRoot) throw new Error('TransactionStore requires dataRoot.');
    this.dataRoot = resolve(options.dataRoot);
    this.environmentsRoot = join(this.dataRoot, 'environments');
    this.now = options.now || (() => Date.now());
    this.randomToken = options.randomToken || (() => randomBytes(32).toString('base64url'));
    this.faultInjector = options.faultInjector || (() => {});
    this.leaseTtlMs = options.leaseTtlMs ?? 5 * 60 * 1000;
    this.recoveryTokenTtlMs = options.recoveryTokenTtlMs ?? 10 * 60 * 1000;
    this.backupReadTokenTtlMs = options.backupReadTokenTtlMs ?? 10 * 60 * 1000;
    this.retentionDays = options.retentionDays ?? 90;
    this.failedRetentionDays = options.failedRetentionDays ?? 30;
    this.minimumPerTarget = options.minimumPerTarget ?? 20;
    this.softBytesPerEnvironment = options.softBytesPerEnvironment ?? 2 * 1024 ** 3;
    this.queues = new Map();
  }

  async initialize() {
    await mkdir(this.environmentsRoot, { recursive: true });
    const environments = await readdir(this.environmentsRoot, { withFileTypes: true });
    for (const entry of environments) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      await this.withEnvironment(entry.name, async () => {
        await this.recoverEnvironment(entry.name);
        await this.applyRetentionInternal(entry.name);
      });
    }
  }

  environmentRoot(environmentId) {
    return this.inside(this.environmentsRoot, assertId(environmentId, 'environment id'));
  }

  transactionRoot(environmentId, transactionId) {
    return this.inside(
      this.environmentRoot(environmentId),
      'transactions',
      assertId(transactionId, 'transaction id')
    );
  }

  inside(root, ...parts) {
    const candidate = resolve(root, ...parts);
    const rel = relative(root, candidate);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw transactionError(400, 'UNSAFE_DATA_PATH', 'Unsafe durable-state path.');
    }
    return candidate;
  }

  manifestPath(environmentId, transactionId) {
    return join(this.transactionRoot(environmentId, transactionId), 'manifest.json');
  }

  secretPath(environmentId, transactionId) {
    return join(this.transactionRoot(environmentId, transactionId), 'secret.json');
  }

  leasePath(environmentId) {
    return join(this.environmentRoot(environmentId), 'lease.json');
  }

  auditPath(environmentId) {
    return join(this.environmentRoot(environmentId), 'audit.jsonl');
  }

  withEnvironment(environmentId, work) {
    const id = assertId(environmentId, 'environment id');
    const previous = this.queues.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.queues.set(id, current);
    return current.finally(() => {
      if (this.queues.get(id) === current) this.queues.delete(id);
    });
  }

  async readManifest(environmentId, transactionId) {
    try {
      const manifest = await readJson(this.manifestPath(environmentId, transactionId));
      if (
        manifest.environmentId !== environmentId ||
        manifest.transactionId !== transactionId
      ) {
        throw new Error('Transaction identity mismatch.');
      }
      return manifest;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw transactionError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.');
      }
      throw error;
    }
  }

  async readSecret(environmentId, transactionId) {
    try {
      return await readJson(this.secretPath(environmentId, transactionId));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw transactionError(409, 'TRANSACTION_CREDENTIALS_MISSING', 'Transaction credentials unavailable.');
      }
      throw error;
    }
  }

  async assertTransactionToken(environmentId, transactionId, token) {
    const secret = await this.readSecret(environmentId, transactionId);
    if (
      secret.transactionTokenExpiresAt &&
      Date.parse(secret.transactionTokenExpiresAt) <= this.now()
    ) {
      throw transactionError(401, 'EXPIRED_TRANSACTION_TOKEN', 'Transaction token has expired.');
    }
    if (!tokenMatches(token, secret.transactionTokenHash)) {
      throw transactionError(401, 'INVALID_TRANSACTION_TOKEN', 'Invalid transaction token.');
    }
    return secret;
  }

  async assertAuthorizationToken(environmentId, transactionId, token) {
    const secret = await this.readSecret(environmentId, transactionId);
    if (
      secret.authorizationTokenExpiresAt &&
      Date.parse(secret.authorizationTokenExpiresAt) <= this.now()
    ) {
      throw transactionError(401, 'EXPIRED_AUTHORIZATION_TOKEN', 'Authorization token has expired.');
    }
    if (!tokenMatches(token, secret.authorizationTokenHash)) {
      throw transactionError(401, 'INVALID_AUTHORIZATION_TOKEN', 'Invalid authorization token.');
    }
    return secret;
  }

  async assertBackupReadToken(environmentId, transactionId, token) {
    const secret = await this.readSecret(environmentId, transactionId);
    if (
      !secret.backupReadTokenExpiresAt ||
      Date.parse(secret.backupReadTokenExpiresAt) <= this.now()
    ) {
      throw transactionError(401, 'EXPIRED_BACKUP_READ_TOKEN', 'Backup-read token has expired.');
    }
    if (!tokenMatches(token, secret.backupReadTokenHash)) {
      throw transactionError(401, 'INVALID_BACKUP_READ_TOKEN', 'Invalid backup-read token.');
    }
    return secret;
  }

  async prepare(input) {
    const environmentId = assertId(input?.environmentId, 'environment id');
    return this.withEnvironment(environmentId, async () => {
      const targetId = assertId(input?.targetId, 'target id');
      const environmentLabel = optionalLabel(input?.environmentLabel, 'environment label');
      const targetLabel = optionalLabel(input?.targetLabel, 'target label');
      if (!Array.isArray(input?.files) || input.files.length < 1 || input.files.length > 250) {
        throw transactionError(400, 'INVALID_FILES', 'One to 250 source files are required.');
      }

      const aliases = new Set();
      const files = input.files.map((candidate, index) => {
        const alias = normalizeSourceAlias(candidate?.alias);
        if (aliases.has(alias)) throw transactionError(400, 'DUPLICATE_ALIAS', 'Duplicate source alias.');
        aliases.add(alias);
        const existed = candidate.existed ?? candidate.exists;
        if (typeof existed !== 'boolean') {
          throw transactionError(400, 'INVALID_EXISTENCE', 'File existence must be declared.');
        }
        const originalSize = assertSize(candidate.size ?? candidate.originalSize, 'original size');
        let originalHash = candidate.hash ?? candidate.originalHash ?? null;
        if (existed) originalHash = assertHash(originalHash, 'original hash');
        else if (originalHash !== null || originalSize !== 0) {
          throw transactionError(400, 'INVALID_NEW_FILE', 'New files must have null hash and zero size.');
        }
        return {
          id: `file-${index + 1}`,
          alias,
          existed,
          originalSize,
          originalHash,
          backupVerified: false,
          finalSize: null,
          finalHash: null,
          receiptVerified: false,
        };
      });

      const requestedChanges = input.changedAliases ?? [...aliases];
      if (!Array.isArray(requestedChanges) || requestedChanges.length < 1) {
        throw transactionError(400, 'INVALID_CHANGES', 'At least one changed alias is required.');
      }
      const changedAliases = [...new Set(requestedChanges.map(normalizeSourceAlias))].sort();
      if (changedAliases.some((alias) => !aliases.has(alias))) {
        throw transactionError(400, 'UNKNOWN_CHANGED_ALIAS', 'Changed alias is not in the manifest.');
      }
      const changedNames = normalizeChangedNames(input.changedNames, aliases);
      const createdDirectories = normalizeCreatedDirectories(input.createdDirectories, files);

      await mkdir(join(this.environmentRoot(environmentId), 'transactions'), { recursive: true });
      await this.acquireLeaseInternal(environmentId);

      const ownedCleanupDirectories = [...createdDirectories];
      const boundary =
        targetLabel === 'contract-create' ? contractCreationBoundary(files) : null;
      if (boundary && !ownedCleanupDirectories.includes(boundary)) {
        const transactionDirectory = join(
          this.environmentRoot(environmentId),
          'transactions'
        );
        const entries = await readdir(transactionDirectory, { withFileTypes: true }).catch(
          () => []
        );
        for (const entry of entries) {
          if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
          const prior = await this.readManifest(environmentId, entry.name).catch(() => null);
          if (
            prior?.targetId === targetId &&
            prior.targetLabel === 'contract-create' &&
            contractCreationBoundary(prior.files || []) === boundary &&
            prior.files.every((file) => file.receiptVerified) &&
            (prior.ownedCleanupDirectories || prior.createdDirectories || []).includes(boundary)
          ) {
            ownedCleanupDirectories.push(boundary);
            break;
          }
        }
      }
      ownedCleanupDirectories.sort(
        (left, right) =>
          left.split('/').length - right.split('/').length || left.localeCompare(right)
      );

      const transactionId = randomUUID();
      const transactionToken = this.randomToken();
      const createdAt = new Date(this.now()).toISOString();
      const manifest = {
        version: 1,
        transactionId,
        environmentId,
        environmentLabel,
        targetId,
        targetLabel,
        status: 'preparing',
        recoveryRequired: false,
        createdAt,
        updatedAt: createdAt,
        changedAliases,
        changedNames,
        createdDirectories,
        ownedCleanupDirectories,
        files,
        authorizedManifestHash: null,
        auditRecorded: false,
      };
      const secret = {
        version: 1,
        transactionTokenHash: sha256(transactionToken),
        authorizationTokenHash: null,
        transactionTokenExpiresAt: null,
        authorizationTokenExpiresAt: null,
        backupReadTokenHash: null,
        backupReadTokenExpiresAt: null,
      };

      await this.createLeaseInternal(environmentId, {
        version: 1,
        environmentId,
        transactionId,
        status: 'active',
        acquiredAt: createdAt,
        expiresAt: new Date(this.now() + this.leaseTtlMs).toISOString(),
      });
      await atomicJson(this.secretPath(environmentId, transactionId), secret, { mode: 0o600 });
      await atomicJson(this.manifestPath(environmentId, transactionId), manifest);
      await this.faultInjector('after-prepare-manifest', { environmentId, transactionId });
      await this.appendAudit(environmentId, manifest, 'prepared');
      return { transaction: publicManifest(manifest), transactionToken };
    });
  }

  async acquireLeaseInternal(environmentId) {
    let lease;
    try {
      lease = await readJson(this.leasePath(environmentId));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    let manifest;
    try {
      manifest = await this.readManifest(environmentId, lease.transactionId);
    } catch (error) {
      if (error.status === 404) {
        if (Date.parse(lease.expiresAt) > this.now()) {
          throw transactionError(409, 'ENVIRONMENT_LEASED', 'Environment already has an active mutation.');
        }
        await rm(this.leasePath(environmentId), { force: true });
        return;
      }
      throw error;
    }
    if (TERMINAL.has(manifest.status) && !manifest.recoveryRequired) {
      if (!manifest.auditRecorded) {
        await this.ensureTerminalAudit(environmentId, manifest, manifest.status);
      }
      await rm(this.leasePath(environmentId), { force: true });
      return;
    }
    const expired = Date.parse(lease.expiresAt) <= this.now();
    if (!expired) {
      throw transactionError(409, 'ENVIRONMENT_LEASED', 'Environment already has an active mutation.');
    }
    if (manifest.status === 'preparing' || manifest.status === 'authorized') {
      await this.abandonInternal(environmentId, manifest, 'stale-lease');
      return;
    }
    manifest.recoveryRequired = true;
    manifest.updatedAt = new Date(this.now()).toISOString();
    await atomicJson(this.manifestPath(environmentId, manifest.transactionId), manifest);
    throw transactionError(
      409,
      'ENVIRONMENT_RECOVERY_REQUIRED',
      'Environment has a mutation that requires recovery.'
    );
  }

  async createLeaseInternal(environmentId, lease) {
    const path = this.leasePath(environmentId);
    await mkdir(dirname(path), { recursive: true });
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw transactionError(409, 'ENVIRONMENT_LEASED', 'Environment already has an active mutation.');
      }
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  }

  async uploadBackup(environmentId, transactionId, fileId, token, expectedHash, bytes) {
    assertId(fileId, 'file id');
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      await this.assertTransactionToken(environmentId, transactionId, token);
      if (manifest.status !== 'preparing') {
        throw transactionError(409, 'INVALID_TRANSACTION_STATE', 'Transaction is not accepting backups.');
      }
      const file = manifest.files.find((entry) => entry.id === fileId);
      if (!file || !file.existed) {
        throw transactionError(404, 'BACKUP_NOT_EXPECTED', 'Backup is not expected for this file.');
      }
      if (assertHash(expectedHash, 'backup hash') !== file.originalHash) {
        throw transactionError(409, 'STALE_ORIGINAL_HASH', 'Backup hash does not match the prepared source.');
      }
      if (bytes.length !== file.originalSize || sha256(bytes) !== file.originalHash) {
        throw transactionError(409, 'BACKUP_VERIFICATION_FAILED', 'Backup bytes failed verification.');
      }
      const backupPath = join(this.transactionRoot(environmentId, transactionId), 'files', `${file.id}.backup`);
      await atomicWrite(backupPath, bytes, { mode: 0o600 });
      await this.faultInjector('after-backup-write', { environmentId, transactionId, fileId });
      const durableBytes = await readFile(backupPath);
      if (durableBytes.length !== file.originalSize || sha256(durableBytes) !== file.originalHash) {
        throw transactionError(500, 'DURABLE_BACKUP_VERIFICATION_FAILED', 'Durable backup verification failed.');
      }
      file.backupVerified = true;
      manifest.updatedAt = new Date(this.now()).toISOString();
      await atomicJson(this.manifestPath(environmentId, transactionId), manifest);
      await this.renewLeaseInternal(environmentId, transactionId);
      return { fileId: file.id, alias: file.alias, size: file.originalSize, hash: file.originalHash, verified: true };
    });
  }

  async authorize(environmentId, transactionId, token) {
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      const secret = await this.assertTransactionToken(environmentId, transactionId, token);
      if (manifest.status !== 'preparing') {
        throw transactionError(409, 'INVALID_TRANSACTION_STATE', 'Transaction cannot be authorized.');
      }
      for (const file of manifest.files.filter((entry) => entry.existed)) {
        if (!file.backupVerified) {
          throw transactionError(409, 'BACKUPS_INCOMPLETE', 'All existing sources must be backed up first.');
        }
        const bytes = await readFile(
          join(this.transactionRoot(environmentId, transactionId), 'files', `${file.id}.backup`)
        ).catch(() => null);
        if (!bytes || bytes.length !== file.originalSize || sha256(bytes) !== file.originalHash) {
          throw transactionError(409, 'BACKUPS_INCOMPLETE', 'A durable backup is missing or invalid.');
        }
      }
      const authorizationToken = this.randomToken();
      const manifestHash = immutableManifestHash(manifest);
      secret.authorizationTokenHash = sha256(authorizationToken);
      manifest.status = 'authorized';
      manifest.authorizedManifestHash = manifestHash;
      manifest.updatedAt = new Date(this.now()).toISOString();
      await atomicJson(this.secretPath(environmentId, transactionId), secret, { mode: 0o600 });
      await atomicJson(this.manifestPath(environmentId, transactionId), manifest);
      await this.faultInjector('after-authorization', { environmentId, transactionId });
      await this.renewLeaseInternal(environmentId, transactionId);
      await this.appendAudit(environmentId, manifest, 'authorized');
      return { transactionId, status: manifest.status, manifestHash, authorizationToken };
    });
  }

  async recover(environmentId, transactionId) {
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      if (
        !manifest.recoveryRequired ||
        (manifest.status !== 'committing' &&
          manifest.status !== 'reverting' &&
          manifest.status !== 'failed')
      ) {
        throw transactionError(
          409,
          'RECOVERY_NOT_REQUIRED',
          'Transaction is not in a recoverable state.'
        );
      }
      const secret = await this.readSecret(environmentId, transactionId);
      const transactionToken = this.randomToken();
      const authorizationToken = this.randomToken();
      const expiresAt = new Date(this.now() + this.recoveryTokenTtlMs).toISOString();
      secret.transactionTokenHash = sha256(transactionToken);
      secret.authorizationTokenHash = sha256(authorizationToken);
      secret.transactionTokenExpiresAt = expiresAt;
      secret.authorizationTokenExpiresAt = expiresAt;
      await atomicJson(this.secretPath(environmentId, transactionId), secret, { mode: 0o600 });
      await this.faultInjector('after-recovery-token-rotation', {
        environmentId,
        transactionId,
      });
      await this.appendAudit(environmentId, manifest, 'recovery_tokens_rotated');
      return {
        transactionId,
        status: manifest.status,
        recoveryRequired: true,
        transactionToken,
        authorizationToken,
        expiresAt,
      };
    });
  }

  /**
   * Reopen a committed creation transaction so its newly created sources can
   * be removed by the browser that owns the directory handle.
   */
  async beginRevert(environmentId, transactionId) {
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      if (
        manifest.status !== 'committed' ||
        manifest.targetLabel !== 'contract-create' ||
        !manifest.files.length ||
        !contractCreationBoundary(manifest.files) ||
        manifest.files.some(
          (file) =>
            file.existed ||
            !file.receiptVerified ||
            typeof file.finalHash !== 'string' ||
            !Number.isSafeInteger(file.finalSize)
        )
      ) {
        throw transactionError(
          409,
          'CREATION_REVERT_NOT_ALLOWED',
          'Only a committed contract creation can be removed from History.'
        );
      }

      await this.acquireLeaseInternal(environmentId);
      const boundary = contractCreationBoundary(manifest.files);
      const contractDirectory = contractCreationDirectory(manifest.files);
      const ownedCleanupDirectories =
        manifest.ownedCleanupDirectories || manifest.createdDirectories || [];
      manifest.revertCleanupDirectories = [
        contractDirectory,
        ownedCleanupDirectories.includes(boundary) ? boundary : null,
      ]
        .filter(Boolean)
        .sort(
          (left, right) =>
            left.split('/').length - right.split('/').length ||
            left.localeCompare(right)
        );
      const transactionToken = this.randomToken();
      const expiresAt = new Date(this.now() + this.recoveryTokenTtlMs).toISOString();
      const secret = await this.readSecret(environmentId, transactionId);
      secret.transactionTokenHash = sha256(transactionToken);
      secret.transactionTokenExpiresAt = expiresAt;
      await this.createLeaseInternal(environmentId, {
        version: 1,
        environmentId,
        transactionId,
        status: 'recovery-required',
        acquiredAt: new Date(this.now()).toISOString(),
        expiresAt,
      });
      await atomicJson(this.secretPath(environmentId, transactionId), secret, { mode: 0o600 });
      manifest.status = 'reverting';
      manifest.recoveryRequired = true;
      manifest.updatedAt = new Date(this.now()).toISOString();
      manifest.auditRecorded = false;
      await atomicJson(this.manifestPath(environmentId, transactionId), manifest);
      await this.faultInjector('after-revert-manifest', { environmentId, transactionId });
      await this.appendAudit(environmentId, manifest, 'reverting');
      return {
        transactionId,
        status: manifest.status,
        recoveryRequired: true,
        transactionToken,
        expiresAt,
        files: manifest.files.map((file) => ({
          alias: file.alias,
          finalHash: file.finalHash,
          finalSize: file.finalSize,
        })),
        cleanupDirectories: manifest.revertCleanupDirectories,
      };
    });
  }

  async issueRestoreToken(environmentId, transactionId) {
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      if (manifest.status !== 'committed' && manifest.status !== 'rolled_back') {
        throw transactionError(
          409,
          'RESTORE_TOKEN_NOT_ALLOWED',
          'Backup access is available only for committed or rolled-back history.'
        );
      }
      const secret = await this.readSecret(environmentId, transactionId);
      const backupReadToken = this.randomToken();
      const expiresAt = new Date(this.now() + this.backupReadTokenTtlMs).toISOString();
      secret.backupReadTokenHash = sha256(backupReadToken);
      secret.backupReadTokenExpiresAt = expiresAt;
      await atomicJson(this.secretPath(environmentId, transactionId), secret, { mode: 0o600 });
      await this.faultInjector('after-backup-read-token-rotation', {
        environmentId,
        transactionId,
      });
      await this.appendAudit(environmentId, manifest, 'restore_token_issued');
      return {
        transactionId,
        status: manifest.status,
        backupReadToken,
        expiresAt,
      };
    });
  }

  async beginCommit(environmentId, transactionId, authorizationToken, input) {
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      await this.assertAuthorizationToken(environmentId, transactionId, authorizationToken);
      if (manifest.status !== 'authorized') {
        throw transactionError(409, 'INVALID_TRANSACTION_STATE', 'Transaction cannot enter committing.');
      }
      if (input?.manifestHash !== manifest.authorizedManifestHash) {
        throw transactionError(409, 'STALE_MANIFEST_HASH', 'Authorized manifest hash is stale.');
      }
      if (!Array.isArray(input?.files) || input.files.length !== manifest.changedAliases.length) {
        throw transactionError(400, 'INVALID_COMMIT_PLAN', 'Commit plan must cover every changed alias.');
      }
      const planned = new Map();
      for (const candidate of input.files) {
        const alias = normalizeSourceAlias(candidate?.alias);
        if (planned.has(alias)) throw transactionError(400, 'DUPLICATE_ALIAS', 'Duplicate commit alias.');
        const file = manifest.files.find((entry) => entry.alias === alias);
        if (!file || !manifest.changedAliases.includes(alias)) {
          throw transactionError(400, 'UNKNOWN_CHANGED_ALIAS', 'Unknown commit alias.');
        }
        const originalHash = candidate.originalHash ?? null;
        if (originalHash !== file.originalHash) {
          throw transactionError(409, 'STALE_ORIGINAL_HASH', 'Prepared source hash is stale.');
        }
        planned.set(alias, {
          finalHash: assertHash(candidate.finalHash, 'final hash'),
          finalSize: assertSize(candidate.finalSize, 'final size'),
        });
      }
      for (const alias of manifest.changedAliases) {
        if (!planned.has(alias)) throw transactionError(400, 'INVALID_COMMIT_PLAN', 'Commit alias is missing.');
      }
      for (const file of manifest.files) {
        const plan = planned.get(file.alias);
        if (plan) Object.assign(file, plan);
      }
      manifest.status = 'committing';
      manifest.recoveryRequired = false;
      manifest.updatedAt = new Date(this.now()).toISOString();
      await atomicJson(this.manifestPath(environmentId, transactionId), manifest);
      await this.faultInjector('after-committing', { environmentId, transactionId });
      await this.renewLeaseInternal(environmentId, transactionId);
      await this.appendAudit(environmentId, manifest, 'committing');
      return { transactionId, status: manifest.status, files: manifest.files.filter((file) => manifest.changedAliases.includes(file.alias)).map((file) => ({ id: file.id, alias: file.alias, finalSize: file.finalSize, finalHash: file.finalHash })) };
    });
  }

  async commitReceipt(environmentId, transactionId, authorizationToken, input) {
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      await this.assertAuthorizationToken(environmentId, transactionId, authorizationToken);
      if (manifest.status !== 'committing') {
        throw transactionError(409, 'INVALID_TRANSACTION_STATE', 'Transaction is not committing.');
      }
      const receipts = this.validateReceipts(manifest, input?.receipts, false);
      for (const file of manifest.files) {
        if (receipts.has(file.alias)) file.receiptVerified = true;
      }
      manifest.status = 'committed';
      manifest.recoveryRequired = false;
      manifest.committedAt = new Date(this.now()).toISOString();
      manifest.updatedAt = manifest.committedAt;
      manifest.auditRecorded = false;
      await atomicJson(this.manifestPath(environmentId, transactionId), manifest);
      await this.faultInjector('after-commit-manifest', { environmentId, transactionId });
      await this.ensureTerminalAudit(environmentId, manifest, 'committed');
      await this.releaseLeaseInternal(environmentId, transactionId);
      await this.applyRetentionInternal(environmentId);
      return { transactionId, status: manifest.status, committedAt: manifest.committedAt };
    });
  }

  validateReceipts(manifest, candidates, rollback) {
    if (!Array.isArray(candidates) || candidates.length !== manifest.changedAliases.length) {
      throw transactionError(400, 'INVALID_RECEIPTS', 'Receipts must cover every changed alias.');
    }
    const receipts = new Map();
    for (const candidate of candidates) {
      const alias = normalizeSourceAlias(candidate?.alias);
      if (receipts.has(alias) || !manifest.changedAliases.includes(alias)) {
        throw transactionError(400, 'INVALID_RECEIPTS', 'Receipt alias is duplicate or unknown.');
      }
      const file = manifest.files.find((entry) => entry.alias === alias);
      if (rollback && !file.existed) {
        if (candidate.removed !== true) {
          throw transactionError(409, 'ROLLBACK_RECEIPT_FAILED', 'New source was not removed.');
        }
      } else {
        const expectedHash = rollback ? file.originalHash : file.finalHash;
        const expectedSize = rollback ? file.originalSize : file.finalSize;
        if (candidate.hash !== expectedHash || candidate.size !== expectedSize) {
          throw transactionError(409, rollback ? 'ROLLBACK_RECEIPT_FAILED' : 'FINAL_RECEIPT_FAILED', 'Receipt does not match the expected source hash and size.');
        }
      }
      receipts.set(alias, candidate);
    }
    return receipts;
  }

  async fail(environmentId, transactionId, token, input = {}) {
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      await this.assertTransactionToken(environmentId, transactionId, token);
      if (!['preparing', 'authorized', 'committing'].includes(manifest.status)) {
        throw transactionError(409, 'INVALID_TRANSACTION_STATE', 'Transaction cannot be marked failed.');
      }
      const changedAliases = input.changedAliases ?? [];
      if (!Array.isArray(changedAliases)) throw transactionError(400, 'INVALID_CHANGES', 'Invalid changed aliases.');
      const changed = [...new Set(changedAliases.map(normalizeSourceAlias))].sort();
      if (changed.some((alias) => !manifest.changedAliases.includes(alias))) {
        throw transactionError(400, 'UNKNOWN_CHANGED_ALIAS', 'Unknown changed alias.');
      }
      manifest.status = 'failed';
      manifest.failedChangedAliases = changed;
      manifest.recoveryRequired = changed.length > 0;
      manifest.updatedAt = new Date(this.now()).toISOString();
      manifest.auditRecorded = false;
      await atomicJson(this.manifestPath(environmentId, transactionId), manifest);
      await this.ensureTerminalAudit(environmentId, manifest, 'failed');
      if (!manifest.recoveryRequired) {
        await this.releaseLeaseInternal(environmentId, transactionId);
        await this.applyRetentionInternal(environmentId);
      } else {
        await this.markRecoveryLeaseInternal(environmentId, transactionId);
      }
      return { transactionId, status: manifest.status, recoveryRequired: manifest.recoveryRequired };
    });
  }

  async abandon(environmentId, transactionId, token) {
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      await this.assertTransactionToken(environmentId, transactionId, token);
      if (!['preparing', 'authorized'].includes(manifest.status)) {
        throw transactionError(409, 'INVALID_TRANSACTION_STATE', 'Transaction cannot be abandoned.');
      }
      await this.abandonInternal(environmentId, manifest, 'client');
      await this.applyRetentionInternal(environmentId);
      return { transactionId, status: manifest.status };
    });
  }

  async abandonInternal(environmentId, manifest, reason) {
    manifest.status = 'abandoned';
    manifest.recoveryRequired = false;
    manifest.abandonReason = reason;
    manifest.updatedAt = new Date(this.now()).toISOString();
    manifest.auditRecorded = false;
    await atomicJson(this.manifestPath(environmentId, manifest.transactionId), manifest);
    await this.ensureTerminalAudit(environmentId, manifest, 'abandoned');
    await this.releaseLeaseInternal(environmentId, manifest.transactionId);
  }

  async rollback(environmentId, transactionId, token, input) {
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      await this.assertTransactionToken(environmentId, transactionId, token);
      if (
        manifest.status !== 'committing' &&
        manifest.status !== 'reverting' &&
        !(manifest.status === 'failed' && manifest.recoveryRequired)
      ) {
        throw transactionError(409, 'INVALID_TRANSACTION_STATE', 'Transaction does not require rollback.');
      }
      this.validateReceipts(manifest, input?.receipts, true);
      manifest.status = 'rolled_back';
      manifest.recoveryRequired = false;
      manifest.rolledBackAt = new Date(this.now()).toISOString();
      manifest.updatedAt = manifest.rolledBackAt;
      manifest.auditRecorded = false;
      await atomicJson(this.manifestPath(environmentId, transactionId), manifest);
      await this.ensureTerminalAudit(environmentId, manifest, 'rolled_back');
      await this.releaseLeaseInternal(environmentId, transactionId);
      await this.applyRetentionInternal(environmentId);
      return { transactionId, status: manifest.status, rolledBackAt: manifest.rolledBackAt };
    });
  }

  async renewLease(environmentId, transactionId, token) {
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      await this.assertTransactionToken(environmentId, transactionId, token);
      if (TERMINAL.has(manifest.status)) {
        throw transactionError(409, 'INVALID_TRANSACTION_STATE', 'Terminal transaction has no renewable lease.');
      }
      return this.renewLeaseInternal(environmentId, transactionId);
    });
  }

  async renewLeaseInternal(environmentId, transactionId) {
    let lease;
    try {
      lease = await readJson(this.leasePath(environmentId));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw transactionError(409, 'LEASE_LOST', 'Mutation lease is unavailable.');
      }
      throw error;
    }
    if (lease.transactionId !== transactionId) {
      throw transactionError(409, 'LEASE_LOST', 'Mutation lease belongs to another transaction.');
    }
    lease.expiresAt = new Date(this.now() + this.leaseTtlMs).toISOString();
    await atomicJson(this.leasePath(environmentId), lease);
    return { transactionId, expiresAt: lease.expiresAt, status: lease.status };
  }

  async markRecoveryLeaseInternal(environmentId, transactionId) {
    const now = new Date(this.now()).toISOString();
    await atomicJson(this.leasePath(environmentId), {
      version: 1,
      environmentId,
      transactionId,
      status: 'recovery-required',
      acquiredAt: now,
      expiresAt: now,
    });
  }

  async releaseLeaseInternal(environmentId, transactionId) {
    try {
      const lease = await readJson(this.leasePath(environmentId));
      if (lease.transactionId === transactionId) {
        await rm(this.leasePath(environmentId), { force: true });
        await syncDirectory(this.environmentRoot(environmentId));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async getTransaction(environmentId, transactionId) {
    return this.withEnvironment(environmentId, async () =>
      publicManifest(await this.readManifest(environmentId, transactionId))
    );
  }

  async history(environmentId, options = {}) {
    return this.withEnvironment(environmentId, async () => {
      const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
      const targetId = options.targetId ? assertId(options.targetId, 'target id') : null;
      const transactionDirectory = join(this.environmentRoot(environmentId), 'transactions');
      const entries = await readdir(transactionDirectory, { withFileTypes: true }).catch(() => []);
      const manifests = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
        try {
          const manifest = await this.readManifest(environmentId, entry.name);
          if (!targetId || manifest.targetId === targetId) manifests.push(publicManifest(manifest));
        } catch {
          // A partial journal is ignored rather than exposing raw filesystem errors.
        }
      }
      return manifests
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit);
    });
  }

  async getBackup(environmentId, transactionId, fileId, token) {
    assertId(fileId, 'file id');
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      await this.assertTransactionToken(environmentId, transactionId, token);
      return this.readVerifiedBackup(environmentId, transactionId, manifest, fileId);
    });
  }

  async getBackupForRestore(environmentId, transactionId, fileId, token) {
    assertId(fileId, 'file id');
    return this.withEnvironment(environmentId, async () => {
      const manifest = await this.readManifest(environmentId, transactionId);
      if (manifest.status !== 'committed' && manifest.status !== 'rolled_back') {
        throw transactionError(
          409,
          'RESTORE_TOKEN_NOT_ALLOWED',
          'Backup access is available only for committed or rolled-back history.'
        );
      }
      await this.assertBackupReadToken(environmentId, transactionId, token);
      return this.readVerifiedBackup(environmentId, transactionId, manifest, fileId);
    });
  }

  async readVerifiedBackup(environmentId, transactionId, manifest, fileId) {
    const file = manifest.files.find((entry) => entry.id === fileId);
    if (!file || !file.existed || !file.backupVerified) {
      throw transactionError(404, 'BACKUP_NOT_FOUND', 'Verified backup not found.');
    }
    const bytes = await readFile(
      join(this.transactionRoot(environmentId, transactionId), 'files', `${file.id}.backup`)
    ).catch(() => null);
    if (!bytes || bytes.length !== file.originalSize || sha256(bytes) !== file.originalHash) {
      throw transactionError(409, 'BACKUP_VERIFICATION_FAILED', 'Stored backup failed verification.');
    }
    return {
      bytes,
      metadata: {
        fileId: file.id,
        alias: file.alias,
        size: file.originalSize,
        hash: file.originalHash,
      },
    };
  }

  async appendAudit(environmentId, manifest, event) {
    const path = this.auditPath(environmentId);
    await mkdir(dirname(path), { recursive: true });
    const text = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const lines = text.trim().split('\n').filter(Boolean);
    let previous = null;
    if (lines.length) previous = JSON.parse(lines.at(-1));
    const entry = {
      version: 1,
      sequence: (previous?.sequence || 0) + 1,
      timestamp: new Date(this.now()).toISOString(),
      event,
      transactionId: manifest.transactionId,
      environmentId: manifest.environmentId,
      environmentLabel: manifest.environmentLabel,
      targetId: manifest.targetId,
      targetLabel: manifest.targetLabel,
      status: manifest.status,
      changedAliases: manifest.changedAliases,
      changedNames: manifest.changedNames,
      createdDirectories: manifest.createdDirectories || [],
      cleanupDirectories: manifest.revertCleanupDirectories || [],
      fileCount: manifest.files.length,
      totalOriginalSize: manifest.files.reduce((sum, file) => sum + file.originalSize, 0),
      manifestHash: manifest.authorizedManifestHash,
      previousHash: previous?.hash || ZERO_HASH,
    };
    entry.hash = sha256(JSON.stringify(entry));
    const handle = await open(path, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return entry;
  }

  async ensureTerminalAudit(environmentId, manifest, event) {
    const path = this.auditPath(environmentId);
    const text = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const found = text
      .trim()
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        try {
          const entry = JSON.parse(line);
          return entry.transactionId === manifest.transactionId && entry.event === event;
        } catch {
          return false;
        }
      });
    if (!found) await this.appendAudit(environmentId, manifest, event);
    manifest.auditRecorded = true;
    await atomicJson(this.manifestPath(environmentId, manifest.transactionId), manifest);
  }

  async recoverEnvironment(environmentId) {
    const transactionDirectory = join(this.environmentRoot(environmentId), 'transactions');
    const entries = await readdir(transactionDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      let manifest;
      try {
        manifest = await this.readManifest(environmentId, entry.name);
      } catch {
        continue;
      }
      if (manifest.status === 'preparing' || manifest.status === 'authorized') {
        await this.abandonInternal(environmentId, manifest, 'startup-recovery');
      } else if (manifest.status === 'committing' || manifest.status === 'reverting') {
        manifest.recoveryRequired = true;
        manifest.updatedAt = new Date(this.now()).toISOString();
        await atomicJson(this.manifestPath(environmentId, manifest.transactionId), manifest);
        await this.markRecoveryLeaseInternal(environmentId, manifest.transactionId);
        await this.appendAudit(environmentId, manifest, 'recovery_required');
      } else if (manifest.status === 'failed' && manifest.recoveryRequired) {
        await this.markRecoveryLeaseInternal(environmentId, manifest.transactionId);
      } else if (TERMINAL.has(manifest.status)) {
        if (!manifest.auditRecorded) await this.ensureTerminalAudit(environmentId, manifest, manifest.status);
        await this.releaseLeaseInternal(environmentId, manifest.transactionId);
      }
    }
  }

  async applyRetention(environmentId) {
    return this.withEnvironment(environmentId, () => this.applyRetentionInternal(environmentId));
  }

  async applyRetentionInternal(environmentId) {
    const root = join(this.environmentRoot(environmentId), 'transactions');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      try {
        const manifest = await this.readManifest(environmentId, entry.name);
        if (!TERMINAL.has(manifest.status) || manifest.recoveryRequired) continue;
        const secret = await this.readSecret(environmentId, entry.name).catch(() => null);
        if (
          secret?.backupReadTokenExpiresAt &&
          Date.parse(secret.backupReadTokenExpiresAt) > this.now()
        ) {
          continue;
        }
        rows.push({
          manifest,
          path: join(root, entry.name),
          created: Date.parse(manifest.createdAt),
          bytes: await directorySize(join(root, entry.name)),
        });
      } catch {
        // Partial journals are retained for manual diagnosis.
      }
    }
    const ranked = new Map();
    for (const row of [...rows].sort((a, b) => b.created - a.created)) {
      const count = ranked.get(row.manifest.targetId) || 0;
      row.targetRank = count;
      ranked.set(row.manifest.targetId, count + 1);
    }
    const now = this.now();
    const normalCutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    const failedCutoff = now - this.failedRetentionDays * 24 * 60 * 60 * 1000;
    // The newest minimumPerTarget journals and every journal inside its age
    // window are protected even when the soft byte target is exceeded.
    const removable = rows
      .filter((row) => {
        if (row.targetRank < this.minimumPerTarget) return false;
        if (row.manifest.status === 'failed' || row.manifest.status === 'abandoned') {
          return row.created < failedCutoff;
        }
        return row.created < normalCutoff;
      })
      .sort((a, b) => a.created - b.created);
    const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    if (totalBytes > this.softBytesPerEnvironment) {
      // This is deliberately a soft limit: only already age-eligible journals
      // may be removed, so byte pressure never defeats the minimum/age floors.
      removable.sort((a, b) => b.bytes - a.bytes || a.created - b.created);
    }
    for (const row of removable) {
      await rm(row.path, { recursive: true, force: true });
    }
  }
}

export const transactionValidation = Object.freeze({
  allowedExtensions: [...ALLOWED_SOURCE_EXTENSIONS],
  normalizeSourceAlias,
});
