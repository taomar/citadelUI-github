// Unlike the old editor double, this models FSA's unpublished writable stream:
// write() stages bytes; only close() replaces the visible file.
export class LocalFile {
  kind = 'file';
  constructor(name, bytes, owner, path) {
    this.name = name;
    this.bytes = new Uint8Array(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
    this.owner = owner;
    this.path = path;
    this.modified = 1;
    this.locked = false;
  }
  async event(operation) {
    this.owner.trace.push({ operation, path: this.path });
    await this.owner.before?.({ operation, path: this.path, handle: this });
  }
  change(bytes) {
    this.bytes = new Uint8Array(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
    this.modified++;
  }
  async getFile() {
    await this.event('getFile');
    const bytes = this.bytes.slice();
    return { size: bytes.length, lastModified: this.modified, arrayBuffer: async () => bytes.buffer };
  }
  async createWritable(options) {
    await this.event('createWritable');
    if (this.locked) throw new DOMException('File locked', 'NoModificationAllowedError');
    if (options?.mode !== 'exclusive' || options?.keepExistingData !== false) throw new Error('Expected an exclusive unpublished stream');
    this.locked = true;
    let pending = null;
    let closed = false;
    return {
      write: async (bytes) => {
        await this.event('write');
        pending = new Uint8Array(bytes);
      },
      close: async () => {
        await this.event('close');
        this.change(pending);
        closed = true;
        this.locked = false;
        await this.owner.afterClose?.(this);
      },
      abort: async () => {
        await this.event('abort');
        this.locked = false;
        if (closed) throw new DOMException('Already closed', 'InvalidStateError');
        pending = null;
      },
    };
  }
  async isSameEntry(other) { return other === this; }
}

export class LocalDirectory {
  kind = 'directory';
  constructor(name = 'empty-parent', owner = null, path = '') {
    this.name = name;
    this.children = new Map();
    this.owner = owner || { trace: [], before: null, afterClose: null, permission: 'granted' };
    this.path = path;
  }
  async event(operation, suffix = '') {
    const path = [this.path, suffix].filter(Boolean).join('/');
    this.owner.trace.push({ operation, path });
    await this.owner.before?.({ operation, path, handle: this });
  }
  async queryPermission() {
    await this.event('queryPermission');
    return this.owner.permission;
  }
  async requestPermission() {
    await this.event('requestPermission');
    return this.owner.permission;
  }
  async *entries() {
    await this.event('entries');
    yield* this.children;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    await this.event(create ? 'createDirectory' : 'getDirectory', name);
    let entry = this.children.get(name);
    if (entry && entry.kind !== 'directory') throw new DOMException('Not a directory', 'TypeMismatchError');
    if (!entry && create) {
      entry = new LocalDirectory(name, this.owner, [this.path, name].filter(Boolean).join('/'));
      this.children.set(name, entry);
    }
    if (!entry) throw new DOMException('Missing directory', 'NotFoundError');
    return entry;
  }
  async getFileHandle(name, { create = false } = {}) {
    await this.event(create ? 'createFile' : 'getFileHandle', name);
    let entry = this.children.get(name);
    if (entry && entry.kind !== 'file') throw new DOMException('Not a file', 'TypeMismatchError');
    if (!entry && create) {
      entry = new LocalFile(name, new Uint8Array(), this.owner, [this.path, name].filter(Boolean).join('/'));
      this.children.set(name, entry);
    }
    if (!entry) throw new DOMException('Missing file', 'NotFoundError');
    return entry;
  }
  async isSameEntry(other) { return other === this; }
  async removeEntry() { throw new Error('The importer must not remove any local entry'); }
  put(path, bytes) {
    const parts = path.split('/');
    const leaf = parts.pop();
    let parent = this;
    for (const part of parts) {
      if (!parent.children.has(part)) parent.children.set(part, new LocalDirectory(part, this.owner, [parent.path, part].filter(Boolean).join('/')));
      parent = parent.children.get(part);
    }
    const file = new LocalFile(leaf, bytes, this.owner, [parent.path, leaf].filter(Boolean).join('/'));
    parent.children.set(leaf, file);
    return file;
  }
  allFiles(prefix = '') {
    return [...this.children].flatMap(([name, handle]) => handle.kind === 'directory'
      ? handle.allFiles(`${prefix}${name}/`) : [{ path: prefix + name, bytes: handle.bytes }]);
  }
}
