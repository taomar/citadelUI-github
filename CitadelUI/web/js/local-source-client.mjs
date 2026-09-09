import { localRequest } from './local-api.mjs';
import { sha256 } from '../../shared/source-scope.mjs';
import { snapshotError as fail, validateLocalSnapshot } from '../../shared/repository-snapshot.mjs';

const base = '/api/github/local-imports';

async function blobHash(bytes) {
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(prefix.length + bytes.length);
  object.set(prefix);
  object.set(bytes, prefix.length);
  const digest = await crypto.subtle.digest('SHA-1', object);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyLocalSourceBytes(bytes, file) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== file.size ||
      await sha256(bytes) !== file.hash || await blobHash(bytes) !== file.sha) {
    throw fail('LOCAL_IMPORT_HASH_MISMATCH', 'The downloaded source file failed byte and hash verification. No alternate content was used.');
  }
}

export function createLocalSourceClient(request = localRequest) {
  const post = (path, body = {}) => request(path, { method: 'POST', body: JSON.stringify(body) });
  const path = (id) => {
    if (!/^[0-9a-f-]{36}$/.test(id || '')) throw fail('LOCAL_IMPORT_INVALID_INPUT', 'Invalid source preparation identity.');
    return `${base}/${id}`;
  };
  return {
    prepare: (body) => post(base, body),
    status: (id) => request(path(id)),
    resume: (id) => post(`${path(id)}/resume`),
    cancel: (id) => post(`${path(id)}/cancel`),
    release: (id) => request(path(id), { method: 'DELETE' }),
    async download(id, { source, signal, onProgress = () => {} } = {}) {
      const manifest = await request(`${path(id)}/manifest`, { signal });
      const snapshot = validateLocalSnapshot(manifest);
      if (!source || ['repositoryId', 'fullName', 'ref', 'commit', 'tree', 'fileCount', 'totalBytes']
        .some((key) => source[key] !== snapshot.source[key])) {
        throw fail('LOCAL_IMPORT_SOURCE_CHANGED', 'The prepared source no longer matches the reviewed revision.');
      }
      const blobs = new Map();
      let completed = 0;
      for (const file of snapshot.files) {
        signal?.throwIfAborted();
        onProgress({ completed, total: snapshot.files.length, currentPath: file.path });
        if (!blobs.has(file.sha)) {
          const data = await request(`${path(id)}/blobs/${file.sha}`, { signal });
          if (data?.sha !== file.sha || data.hash !== file.hash || data.size !== file.size ||
              typeof data.content !== 'string' || data.content.length !== Math.ceil(file.size / 3) * 4 ||
              !/^[A-Za-z0-9+/]*={0,2}$/.test(data.content)) {
            throw fail('LOCAL_IMPORT_INVALID_BLOB', 'A source transfer was incomplete or invalid.');
          }
          const bytes = Uint8Array.from(atob(data.content), (character) => character.charCodeAt(0));
          await verifyLocalSourceBytes(bytes, file);
          blobs.set(file.sha, bytes);
        } else await verifyLocalSourceBytes(blobs.get(file.sha), file);
        onProgress({ completed: ++completed, total: snapshot.files.length, currentPath: file.path });
      }
      signal?.throwIfAborted();
      return { manifest, snapshot, blobs };
    },
  };
}
