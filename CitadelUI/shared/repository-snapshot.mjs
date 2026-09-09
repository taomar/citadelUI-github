import { parseRepositorySource } from './repository-source.mjs';

export const REPOSITORY_SNAPSHOT_LIMITS = Object.freeze({
  totalBytes: 64 * 1024 * 1024, blobBytes: 8 * 1024 * 1024,
  files: 10_000, entries: 20_000, directories: 2000,
  manifestBytes: 8 * 1024 * 1024,
});

export const snapshotError = (code, message, status = 422) =>
  Object.assign(new Error(message), { code, status, github: true });

export function repositorySnapshotPath(value, single = false) {
  if (typeof value !== 'string' || !value ||
      new TextEncoder().encode(value).length > 1024 ||
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value)) !== value ||
      /[\u0000-\u001f\u007f\\]/u.test(value) || (single && value.includes('/')) ||
      value.split('/').length > 64 ||
      value.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw snapshotError('IMPORT_UNSAFE_PATH', 'The source contains an unsafe Git path.');
  }
  return value;
}

const localKey = (value) => value.normalize('NFKC').toUpperCase().toLowerCase();

/** Full import policy, not an extension of the configuration editor's scope. */
export function validateLocalSnapshotPaths(entries) {
  const names = new Set();
  for (const entry of entries) {
    const path = repositorySnapshotPath(entry.path);
    for (const part of path.split('/')) {
      const normalized = localKey(part);
      if (part.length > 255 || /[<>:"|?*/\\\u0080-\u009f\u202a-\u202e\u2066-\u2069]/u.test(normalized) ||
          /[. ]$/.test(normalized) || normalized === '.git' ||
          /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9]|lpt[1-9]) *(?:\.|$)/.test(normalized)) {
        throw snapshotError('LOCAL_IMPORT_UNSAFE_PATH', 'The source contains a name that is unsafe for a local Windows folder.');
      }
    }
    const key = localKey(path);
    if (names.has(key)) {
      throw snapshotError('LOCAL_IMPORT_PATH_COLLISION', 'The source contains case- or Unicode-equivalent local paths.');
    }
    names.add(key);
  }
}

export function validateLocalFolderName(value) {
  const invalid = () => snapshotError('LOCAL_IMPORT_INVALID_FOLDER_NAME',
    'Enter one Windows-safe project folder name of at most 160 characters, without separators, traversal, reserved names, .azure/.env names, or leading/trailing whitespace. The name will not be automatically changed.');
  if (typeof value !== 'string' || value !== value.trim() || value.length > 160 ||
      /^\.azure$|^\.env(?:\.|$)/.test(localKey(value))) throw invalid();
  try {
    repositorySnapshotPath(value, true);
    validateLocalSnapshotPaths([{ path: value }]);
  } catch (error) {
    if (!['IMPORT_UNSAFE_PATH', 'LOCAL_IMPORT_UNSAFE_PATH'].includes(error.code)) throw error;
    throw invalid();
  }
  return value;
}

/** Validate the entire browser transfer before any directory is created. */
export function validateLocalSnapshot(manifest) {
  const limits = REPOSITORY_SNAPSHOT_LIMITS;
  const invalid = () => snapshotError('LOCAL_IMPORT_INVALID_SNAPSHOT', 'The prepared source manifest is incomplete or invalid.');
  const source = manifest?.source;
  if (!source || !/^[0-9a-f]{40}$/.test(source.commit || '') || !/^[0-9a-f]{40}$/.test(source.tree || '') ||
      !Number.isSafeInteger(source.repositoryId) || source.repositoryId <= 0 ||
      typeof source.ref !== 'string' || !source.ref) throw invalid();
  const parsed = parseRepositorySource(`https://github.com/${source.fullName}/tree/${source.ref}`);
  if (parsed.fullName !== source.fullName || parsed.ref !== source.ref ||
      !Array.isArray(manifest.entries) || manifest.entries.length > limits.entries) throw invalid();
  validateLocalSnapshotPaths(manifest.entries);
  const files = [];
  const directories = new Set(['']);
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    if (!/^[0-9a-f]{40}$/.test(entry.sha || '')) throw invalid();
    if (entry.type === 'tree' && entry.mode === '040000') directories.add(entry.path);
    else if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)) {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.blobBytes ||
          !/^[0-9a-f]{64}$/.test(entry.hash || '')) throw invalid();
      totalBytes += entry.size;
      files.push(Object.freeze({
        path: entry.path, sha: entry.sha, hash: entry.hash, size: entry.size, mode: entry.mode,
      }));
    } else throw snapshotError('IMPORT_UNSUPPORTED_MODE', 'Symlinks, submodules and unsupported Git modes cannot be imported.');
  }
  if (!files.length || files.length > limits.files || directories.size > limits.directories ||
      totalBytes > limits.totalBytes || source.fileCount !== files.length || source.totalBytes !== totalBytes) throw invalid();
  for (const entry of manifest.entries) {
    const parent = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')));
    if (!directories.has(parent)) throw invalid();
  }
  return Object.freeze({
    source: Object.freeze({
      fullName: source.fullName, ref: source.ref, commit: source.commit, tree: source.tree,
      repositoryId: source.repositoryId, fileCount: files.length, totalBytes,
    }),
    files: Object.freeze(files),
    directories: Object.freeze([...directories].filter(Boolean).sort((a, b) => a.split('/').length - b.split('/').length)),
  });
}
