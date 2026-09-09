import { BrowserDirectoryProvider, sha256 } from './directory-provider.mjs';
import { snapshotError as fail, validateLocalFolderName, validateLocalSnapshot } from '../../shared/repository-snapshot.mjs';
import { verifyLocalSourceBytes } from './local-source-client.mjs';

async function permission(handle, request = false) {
  let value = typeof handle.queryPermission === 'function' ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted';
  if (request && value !== 'granted' && typeof handle.requestPermission === 'function') {
    value = await handle.requestPermission({ mode: 'readwrite' });
  }
  if (value !== 'granted') throw fail('LOCAL_IMPORT_PERMISSION', 'Read/write folder permission is required. Grant access, then retry this import.', 403);
}

export async function assertEmptyImportFolder(handle, { request = false } = {}) {
  if (!handle || handle.kind !== 'directory') throw fail('LOCAL_IMPORT_FOLDER_REQUIRED', 'Choose an empty local folder.');
  await permission(handle, request);
  for await (const _entry of handle.entries()) {
    throw fail('LOCAL_IMPORT_NOT_EMPTY', 'The selected folder is not empty, including hidden files or .git. Choose a different empty folder; nothing was overwritten.', 409);
  }
}

const conflict = () => fail('LOCAL_IMPORT_CONFLICT',
  'The import folder contains a new, changed or replaced entry. Nothing conflicting will be overwritten. Keep the partial folder and choose another empty destination.', 409);

async function sameEntry(actual, expected) {
  if (!actual || !expected || actual.kind !== expected.kind || typeof actual.isSameEntry !== 'function' ||
      !await actual.isSameEntry(expected)) throw conflict();
}

async function fileState(handle, maxSize) {
  const file = await handle.getFile();
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxSize) throw conflict();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size || bytes.length > maxSize) throw conflict();
  return { size: bytes.length, hash: await sha256(bytes), lastModified: file.lastModified };
}

/**
 * A source import creates the reviewed child of an empty selected folder.
 * FSA has no atomic "create if absent" or portable no-replace directory publish.
 * Checks and exclusive browser streams reduce races, but do not lock out OS
 * writers. Never promote a staging tree over existing paths or auto-delete it.
 */
export class LocalSourceCopy {
  constructor(prepared, { folderName = null } = {}) {
    this.snapshot = validateLocalSnapshot(prepared.manifest);
    this.blobs = prepared.blobs;
    this.childName = folderName === null ? null : validateLocalFolderName(folderName);
    this.parent = null;
    this.root = null;
    this.directories = new Map();
    this.files = new Map();
    this.state = 'ready';
    this.pending = null;
    this.cancelled = false;
    this.result = null;
  }

  nameFolder(value) {
    if (this.root || this.pending) throw fail('LOCAL_IMPORT_STARTED', 'The destination name cannot change after copying starts.');
    this.childName = validateLocalFolderName(value);
    return this.childName;
  }

  async chooseFolder(handle) {
    if (this.root || this.pending) throw fail('LOCAL_IMPORT_STARTED', 'This import already owns its destination. Keep it for retry or start a separate import.');
    await assertEmptyImportFolder(handle, { request: true });
    this.parent = handle;
    return this.childName;
  }

  check() {
    if (this.cancelled) throw fail('LOCAL_IMPORT_CANCELLED', 'Import paused. The partial folder is retained; retry resumes only unchanged files.', 409);
  }

  cancel() {
    if (this.state === 'registering' || this.state === 'complete') return false;
    this.cancelled = true;
    return true;
  }

  async rootUnchanged() {
    this.check();
    await permission(this.parent);
    if (!this.root) return;
    await sameEntry(await this.parent.getDirectoryHandle(this.childName, { create: false }), this.root);
    let count = 0;
    for await (const [name, handle] of this.parent.entries()) {
      if (name !== this.childName) throw conflict();
      await sameEntry(handle, this.root);
      count++;
    }
    if (count !== 1) throw conflict();
    await permission(this.root);
    this.check();
  }

  async directory(path) {
    await this.rootUnchanged();
    let directory = this.root;
    let prefix = '';
    for (const part of path ? path.split('/') : []) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const expected = this.directories.get(prefix);
      if (expected) {
        const actual = await directory.getDirectoryHandle(part, { create: false });
        await sameEntry(actual, expected);
        directory = actual;
      } else {
        this.check();
        try {
          await directory.getDirectoryHandle(part, { create: false });
          throw conflict();
        } catch (error) {
          if (error?.name !== 'NotFoundError') throw error;
        }
        this.check();
        directory = await directory.getDirectoryHandle(part, { create: true });
        await assertEmptyImportFolder(directory);
        this.directories.set(prefix, directory);
      }
    }
    return directory;
  }

  async recheckFile(parent, leaf, record, baseline = null) {
    const split = record.file.path.lastIndexOf('/');
    const directoryPath = split < 0 ? '' : record.file.path.slice(0, split);
    await sameEntry(await this.directory(directoryPath), parent);
    await sameEntry(await parent.getFileHandle(leaf, { create: false }), record.handle);
    const current = await fileState(record.handle, record.file.size);
    if (baseline) {
      if (current.size !== baseline.size || current.hash !== baseline.hash || current.lastModified !== baseline.lastModified) throw conflict();
    } else if (current.hash !== record.file.hash || current.size !== record.file.size) throw conflict();
    this.check();
    return current;
  }

  async copyFile(file) {
    const split = file.path.lastIndexOf('/');
    const directoryPath = split < 0 ? '' : file.path.slice(0, split);
    const leaf = file.path.slice(split + 1);
    const parent = await this.directory(directoryPath);
    let record = this.files.get(file.path);
    if (record?.complete) {
      await this.recheckFile(parent, leaf, record);
      return;
    }
    if (!record) {
      try {
        await parent.getFileHandle(leaf, { create: false });
        throw conflict();
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
      this.check();
      const handle = await parent.getFileHandle(leaf, { create: true });
      const before = await fileState(handle, 0);
      record = { handle, file, before, complete: false };
      this.files.set(file.path, record);
    }
    // A lost close acknowledgement may already have published our exact bytes.
    const current = await fileState(record.handle, file.size);
    if (current.hash === file.hash && current.size === file.size) {
      await this.recheckFile(parent, leaf, record);
      record.complete = true;
      return;
    }
    await this.recheckFile(parent, leaf, record, record.before);
    const bytes = this.blobs.get(file.sha);
    await verifyLocalSourceBytes(bytes, file);
    const stream = await record.handle.createWritable({ keepExistingData: false, mode: 'exclusive' });
    try {
      await this.recheckFile(parent, leaf, record, record.before);
      await stream.write(bytes);
      // The destination is still the original empty entry until close(). Abort
      // rather than publish if someone replaced or edited it during staging.
      await this.recheckFile(parent, leaf, record, record.before);
      await stream.close();
    } catch (error) {
      try { await stream.abort(); }
      catch {
        error.message += ' The write stream could not be aborted; retry will inspect its actual bytes before doing anything.';
      }
      throw error;
    }
    await this.recheckFile(parent, leaf, record);
    record.complete = true;
  }

  async verify(onProgress) {
    await this.rootUnchanged();
    let completed = 0;
    let directories = 0;
    const walk = async (handle, prefix = '') => {
      for await (const [name, child] of handle.entries()) {
        this.check();
        const path = prefix ? `${prefix}/${name}` : name;
        if (child.kind === 'directory') {
          await sameEntry(child, this.directories.get(path));
          directories++;
          await walk(child, path);
        } else {
          const record = this.files.get(path);
          if (!record) throw conflict();
          await sameEntry(child, record.handle);
          const current = await fileState(child, record.file.size);
          if (current.hash !== record.file.hash || current.size !== record.file.size) {
            // Unpublished empty entries may resume, but never pass final verification.
            if (this.state === 'copying' && !record.complete &&
                current.hash === record.before.hash && current.size === 0 && current.lastModified === record.before.lastModified) continue;
            throw conflict();
          }
          record.complete = true;
          onProgress?.({ phase: 'verify', completed: ++completed, total: this.snapshot.files.length, currentPath: path });
        }
      }
    };
    await walk(this.root);
    if (directories !== this.directories.size || (this.state !== 'copying' && completed !== this.snapshot.files.length)) throw conflict();
    // An owned entry removed between attempts is also a conflict, not permission
    // to create a replacement under a reused name.
    for (const [path, record] of this.files) {
      const parts = path.split('/');
      const leaf = parts.pop();
      const parent = parts.length ? this.directories.get(parts.join('/')) : this.root;
      await sameEntry(await parent.getFileHandle(leaf, { create: false }), record.handle);
    }
    await this.rootUnchanged();
  }

  run({ scan, attach, onProgress = () => {} }) {
    if (this.pending) return this.pending;
    if (this.result) return Promise.resolve(this.result);
    this.cancelled = false;
    this.pending = this.perform({ scan, attach, onProgress }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async perform({ scan, attach, onProgress }) {
    try {
      if (!this.parent) throw fail('LOCAL_IMPORT_FOLDER_REQUIRED', 'Choose an empty destination folder before importing.');
      validateLocalFolderName(this.childName);
      this.state = 'copying';
      onProgress({ phase: 'source', completed: 0, total: this.snapshot.files.length });
      for (const file of this.snapshot.files) {
        this.check();
        await verifyLocalSourceBytes(this.blobs.get(file.sha), file);
      }
      if (!this.root) {
        await assertEmptyImportFolder(this.parent);
        try {
          await this.parent.getDirectoryHandle(this.childName, { create: false });
          throw fail('LOCAL_IMPORT_DESTINATION_EXISTS', 'That project subfolder already exists. Choose another empty parent or a different folder name; even an empty existing child will not be adopted.', 409);
        } catch (error) {
          if (error.name !== 'NotFoundError') throw error;
        }
        this.check();
        this.root = await this.parent.getDirectoryHandle(this.childName, { create: true });
        if (this.root.name !== this.childName) throw conflict();
        await assertEmptyImportFolder(this.root);
      }
      await this.verify();
      for (const path of this.snapshot.directories) await this.directory(path);
      let completed = 0;
      for (const file of this.snapshot.files) {
        onProgress({ phase: 'copy', completed, total: this.snapshot.files.length, currentPath: file.path });
        await this.copyFile(file);
        onProgress({ phase: 'copy', completed: ++completed, total: this.snapshot.files.length, currentPath: file.path });
      }
      this.state = 'verifying';
      await this.verify(onProgress);
      onProgress({ phase: 'compatibility', completed, total: completed });
      const provider = new BrowserDirectoryProvider(this.root);
      const inspected = await scan(provider);
      if (inspected.compatibility !== 'supported') throw fail('IMPORT_SOURCE_UNSUPPORTED', 'The copied folder is not a supported Citadel workspace.');
      await this.verify(onProgress);
      this.check();
      this.state = 'registering';
      onProgress({ phase: 'register', completed, total: completed });
      this.result = await attach({ handle: this.root, provider, scan: inspected });
      this.state = 'complete';
      onProgress({ phase: 'complete', completed, total: completed });
      return this.result;
    } catch (error) {
      this.state = this.cancelled ? 'paused' : 'failed';
      if (!error.code || ['NotAllowedError', 'NotFoundError', 'AbortError', 'QuotaExceededError', 'NoModificationAllowedError'].includes(error.name)) {
        throw fail('LOCAL_IMPORT_WRITE_FAILED', `${error.message || 'The browser could not finish the local import.'} ${this.root
          ? 'The partial folder is retained. Restore access and retry; changed or foreign files will not be overwritten.'
          : 'No project was registered. Choose an empty folder and retry.'}`, 409);
      }
      throw error;
    }
  }
}
