import { createHash } from 'node:crypto';
import { isLfsPointer } from './repositories.mjs';
import { repositorySnapshotPath, snapshotError as fail } from '../../shared/repository-snapshot.mjs';

export const gitObjectHash = (type, bytes) =>
  createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');

export function objectSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value || '')) throw fail('IMPORT_INVALID_OBJECT', 'GitHub returned an invalid Git object.', 502);
  return value;
}

export function treeHash(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(
    Buffer.from(a.path + (a.type === 'tree' ? '/' : '')),
    Buffer.from(b.path + (b.type === 'tree' ? '/' : ''))
  ));
  return gitObjectHash('tree', Buffer.concat(sorted.map((entry) => Buffer.concat([
    Buffer.from(`${entry.type === 'tree' ? '40000' : entry.mode} ${entry.path}\0`),
    Buffer.from(entry.sha, 'hex'),
  ]))));
}

export function verifySnapshotBytes(bytes, entry, limit) {
  if (!Buffer.isBuffer(bytes) || bytes.length > limit || bytes.length !== entry.size ||
      gitObjectHash('blob', bytes) !== entry.sha) {
    throw fail('IMPORT_HASH_MISMATCH', 'The source blob does not match its Git object hash.');
  }
  const text = bytes.toString('utf8');
  if (isLfsPointer(text)) throw fail('IMPORT_LFS_UNSUPPORTED', 'Git LFS pointers cannot be imported as complete source files.');
  return { bytes, text: !bytes.includes(0) && Buffer.from(text, 'utf8').equals(bytes) ? text : null };
}

export function decodeSnapshotBlob(data, entry, limit) {
  if (data?.encoding !== 'base64' || data.sha !== entry.sha ||
      !Number.isSafeInteger(data.size) || data.size < 0 || data.size > limit ||
      data.size !== entry.size || typeof data.content !== 'string') {
    throw fail('IMPORT_INVALID_BLOB', 'The source blob encoding or declared size is invalid.');
  }
  const encoded = data.content.replace(/[\r\n]/g, '');
  if (encoded.length > Math.ceil(limit / 3) * 4 || encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw fail('IMPORT_INVALID_BLOB', 'The source blob has invalid base64 content.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw fail('IMPORT_HASH_MISMATCH', 'Invalid source blob encoding.');
  return verifySnapshotBytes(bytes, entry, limit);
}

/** Prove the complete Git tree, including every subtree, before using its paths. */
export async function readRepositoryManifest(read, name, root, limits) {
  const limit = limits.manifestBytes;
  const ep = `/repos/${name}/git/trees`;
  const recursive = await read(`${ep}/${root}?recursive=1`, { limit });
  if (recursive?.sha !== root || !Array.isArray(recursive.tree)) throw fail('IMPORT_INVALID_OBJECT', 'Invalid tree.', 502);
  let entries;
  if (recursive.truncated === false) entries = recursive.tree;
  else if (recursive.truncated === true) {
    entries = [];
    const queue = [{ tree: root, prefix: '' }];
    let directories = 0;
    while (queue.length) {
      if (++directories > limits.directories) throw fail('IMPORT_LIMIT', 'Too many directories.', 413);
      const current = queue.shift();
      const node = await read(`${ep}/${current.tree}`, { limit });
      if (node?.sha !== current.tree || node.truncated !== false || !Array.isArray(node.tree)) throw fail('IMPORT_TRUNCATED', 'Incomplete source tree.');
      for (const entry of node.tree) {
        repositorySnapshotPath(entry.path, true);
        const path = current.prefix + entry.path;
        entries.push({ ...entry, path });
        if (entries.length > limits.entries) throw fail('IMPORT_LIMIT', 'Too many entries.', 413);
        if (entry.type === 'tree') queue.push({ tree: objectSha(entry.sha), prefix: `${path}/` });
      }
    }
  } else throw fail('IMPORT_TRUNCATED', 'Missing tree completeness flag.');
  if (entries.length > limits.entries) throw fail('IMPORT_LIMIT', 'Too many entries.', 413);
  const byPath = new Map();
  const directories = new Map([['', { path: '', sha: root, entries: [] }]]);
  const files = [];
  let totalBytes = 0;
  for (const raw of entries) {
    const path = repositorySnapshotPath(raw.path);
    objectSha(raw.sha);
    if (byPath.has(path)) throw fail('IMPORT_UNSAFE_PATH', 'Duplicate Git path.');
    const entry = { path, type: raw.type, mode: raw.mode, sha: raw.sha };
    if (entry.type === 'tree' && entry.mode === '040000') {
      directories.set(path, { path, sha: entry.sha, entries: [] });
    } else if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)) {
      if (!Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > limits.blobBytes) throw fail('IMPORT_LIMIT', 'Invalid or excessive blob size.', 413);
      entry.size = raw.size;
      totalBytes += entry.size;
      files.push(entry);
    } else throw fail('IMPORT_UNSUPPORTED_MODE', 'Unsupported Git mode.');
    byPath.set(path, entry);
  }
  if (files.length > limits.files || totalBytes > limits.totalBytes || directories.size > limits.directories) {
    throw fail('IMPORT_LIMIT', 'Source limits exceeded.', 413);
  }
  for (const entry of byPath.values()) {
    const index = entry.path.lastIndexOf('/');
    const parent = directories.get(index < 0 ? '' : entry.path.slice(0, index));
    if (!parent) throw fail('IMPORT_UNSAFE_PATH', 'Missing Git directory.');
    parent.entries.push({ ...entry, path: entry.path.slice(index + 1), fullPath: entry.path });
  }
  for (const dir of directories.values()) {
    if (treeHash(dir.entries) !== dir.sha) throw fail('IMPORT_HASH_MISMATCH', 'Source tree hash mismatch.');
  }
  return { files, directories, totalBytes, entries: [...byPath.values()] };
}
