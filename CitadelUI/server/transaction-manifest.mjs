import { createHash } from 'node:crypto';
import { workspaceScope } from '../shared/workspace-configuration.mjs';

const HASH_RE = /^[a-f0-9]{64}$/;
const ALLOWED_SOURCE_EXTENSIONS = new Set(['.bicep', '.bicepparam', '.xml']);

export function transactionError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function normalizeSourceAlias(alias, configuration) {
  if (configuration?.format === 'terraform') return workspaceScope(configuration).write(alias);
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

export function contractCreationBoundary(files) {
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

export function contractCreationDirectory(files) {
  const boundary = contractCreationBoundary(files);
  if (!boundary) return null;
  return files[0].alias.slice(0, files[0].alias.lastIndexOf('/'));
}

export function normalizeCreatedDirectories(value, files) {
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

export function assertHash(value, name = 'hash') {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw transactionError(400, 'INVALID_HASH', `Invalid ${name}.`);
  }
  return value;
}

export function assertSize(value, name = 'size') {
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

export function normalizeChangedNames(value, aliases, configuration) {
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
    const alias = normalizeSourceAlias(candidateAlias, configuration);
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

export function normalizeManifestFiles(candidates, configuration) {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 250) {
    throw transactionError(400, 'INVALID_FILES', 'One to 250 source files are required.');
  }
  const aliases = new Set();
  const files = candidates.map((candidate, index) => {
    const alias = normalizeSourceAlias(candidate?.alias, configuration);
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
  return { aliases, files };
}

export function normalizeChangedAliases(value, aliases, configuration) {
  const requestedChanges = value ?? [...aliases];
  if (!Array.isArray(requestedChanges) || requestedChanges.length < 1) {
    throw transactionError(400, 'INVALID_CHANGES', 'At least one changed alias is required.');
  }
  const changedAliases = [...new Set(requestedChanges.map((alias) => normalizeSourceAlias(alias, configuration)))].sort();
  if (changedAliases.some((alias) => !aliases.has(alias))) {
    throw transactionError(400, 'UNKNOWN_CHANGED_ALIAS', 'Changed alias is not in the manifest.');
  }
  return changedAliases;
}

export function validateCommitPlan(manifest, candidates) {
  if (!Array.isArray(candidates) || candidates.length !== manifest.changedAliases.length) {
    throw transactionError(400, 'INVALID_COMMIT_PLAN', 'Commit plan must cover every changed alias.');
  }
  const planned = new Map();
  for (const candidate of candidates) {
    const alias = normalizeSourceAlias(candidate?.alias, manifest.configuration);
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
  return planned;
}

export function normalizeFailedChangedAliases(manifest, value) {
  const changedAliases = value ?? [];
  if (!Array.isArray(changedAliases)) throw transactionError(400, 'INVALID_CHANGES', 'Invalid changed aliases.');
  const changed = [...new Set(changedAliases.map((alias) => normalizeSourceAlias(alias, manifest.configuration)))].sort();
  if (changed.some((alias) => !manifest.changedAliases.includes(alias))) {
    throw transactionError(400, 'UNKNOWN_CHANGED_ALIAS', 'Unknown changed alias.');
  }
  return changed;
}

export function validateReceipts(manifest, candidates, rollback) {
  if (!Array.isArray(candidates) || candidates.length !== manifest.changedAliases.length) {
    throw transactionError(400, 'INVALID_RECEIPTS', 'Receipts must cover every changed alias.');
  }
  const receipts = new Map();
  for (const candidate of candidates) {
    const alias = normalizeSourceAlias(candidate?.alias, manifest.configuration);
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

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function publicManifest(manifest) {
  return structuredClone(manifest);
}

export function serializeImmutableManifest(manifest) {
  return JSON.stringify({
    version: manifest.version,
    transactionId: manifest.transactionId,
    environmentId: manifest.environmentId,
    targetId: manifest.targetId,
    changedAliases: manifest.changedAliases,
    changedNames: manifest.changedNames,
    createdDirectories: manifest.createdDirectories,
    ownedCleanupDirectories: manifest.ownedCleanupDirectories,
    ...(manifest.configuration ? { configuration: manifest.configuration, nativeProof: manifest.nativeProof } : {}),
    files: manifest.files.map((file) => ({
      id: file.id,
      alias: file.alias,
      existed: file.existed,
      originalSize: file.originalSize,
      originalHash: file.originalHash,
    })),
  });
}

export function immutableManifestHash(manifest) {
  return sha256(serializeImmutableManifest(manifest));
}

export const transactionValidation = Object.freeze({
  allowedExtensions: [...ALLOWED_SOURCE_EXTENSIONS],
  normalizeSourceAlias,
});
