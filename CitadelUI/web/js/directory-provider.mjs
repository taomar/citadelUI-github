import {
  readSubscriptionIdFromText,
  validateAzdEnvironmentName,
  validateSubscriptionId,
  writeSubscriptionIdToText,
} from './subscription-env.mjs';

const SOURCE_EXTENSIONS = new Set(['.bicepparam', '.bicep', '.xml']);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ENV_BYTES = 1024 * 1024;
const SKIP_DIRECTORIES = new Set([
  '.azure',
  '.git',
  '.github',
  '.vscode',
  'node_modules',
  '.venv',
  '__pycache__',
  'CitadelUI',
  '.backups',
  '.baseline',
  '.qa',
  '.shots',
  '.snapshots',
].map((name) => name.toLowerCase()));

function normalizeAlias(alias) {
  const value = String(alias || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = value.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`Unsafe workspace alias: ${alias}`);
  }

  if (parts.some((part) => part.toLowerCase() === '.azure')) {
    throw new Error('Citadel UI never accesses .azure directories.');
  }
  const leaf = parts.at(-1);
  if (leaf === '.env' || leaf.startsWith('.env.')) {
    throw new Error('Citadel UI never accesses environment files.');
  }
  const dot = leaf.lastIndexOf('.');
  const extension = dot < 0 ? '' : leaf.slice(dot).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported source type: ${leaf}`);
  }
  return parts.join('/');
}

function normalizeDirectoryAlias(alias) {
  const value = String(alias || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = value.split('/').filter(Boolean);
  if (
    !parts.length ||
    parts.some((part) => part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part))
  ) {
    throw new Error(`Unsafe workspace directory alias: ${alias}`);
  }
  if (parts.some((part) => part.toLowerCase() === '.azure')) {
    throw new Error('Citadel UI never accesses .azure directories.');
  }
  return parts.join('/');
}

export async function sha256(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function permission(handle, request = false) {
  const options = { mode: 'readwrite' };
  let state = typeof handle.queryPermission === 'function' ? await handle.queryPermission(options) : 'granted';
  if (state !== 'granted' && request && typeof handle.requestPermission === 'function') {
    state = await handle.requestPermission(options);
  }
  return state;
}

export class BrowserDirectoryProvider {
  constructor(handle, options = {}) {
    if (!handle || handle.kind !== 'directory') throw new Error('Directory handle required.');
    this.root = handle;
    this.instrument = options.instrument || (() => {});
  }

  async permission(options = {}) {
    return permission(this.root, Boolean(options.request));
  }

  async assertWritable(options = {}) {
    const state = await this.permission(options);
    if (state !== 'granted') throw new Error('Read/write folder permission is required. Reconnect the environment.');
  }

  async entries() {
    await this.assertWritable();
    const files = [];
    const walk = async (directory, prefix = '') => {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'directory') {
          if (name.startsWith('.') || SKIP_DIRECTORIES.has(name.toLowerCase())) continue;
          await walk(handle, prefix ? `${prefix}/${name}` : name);
          continue;
        }
        const alias = prefix ? `${prefix}/${name}` : name;
        const lower = name.toLowerCase();
        if (lower === '.env' || lower.startsWith('.env.')) continue;
        const extension = lower.slice(lower.lastIndexOf('.'));
        if (!SOURCE_EXTENSIONS.has(extension)) continue;
        files.push({ alias, kind: extension.slice(1) });
      }
    };
    await walk(this.root);
    files.sort((a, b) => a.alias.localeCompare(b.alias));
    this.instrument({ operation: 'enumerate', count: files.length });
    return files;
  }

  async subscriptionEnvironmentFile(environmentName) {
    const name = validateAzdEnvironmentName(environmentName);
    try {
      const azure = await this.root.getDirectoryHandle('.azure');
      const environment = await azure.getDirectoryHandle(name);
      const handle = await environment.getFileHandle('.env');
      return { name, handle, alias: `.azure/${name}/.env` };
    } catch (error) {
      if (error?.name === 'NotFoundError') return { name, handle: null, alias: `.azure/${name}/.env` };
      throw error;
    }
  }

  async readSubscriptionId(environmentName) {
    await this.assertWritable();
    const target = await this.subscriptionEnvironmentFile(environmentName);
    if (!target.handle) {
      return {
        available: false,
        configured: false,
        environmentName: target.name,
        source: target.alias,
        value: '',
        valid: false,
        hash: null,
      };
    }
    const file = await target.handle.getFile();
    if (Number(file.size) > MAX_ENV_BYTES) {
      throw new Error('The azd environment file exceeds the 1 MiB safety limit.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_ENV_BYTES) {
      throw new Error('The azd environment file exceeds the 1 MiB safety limit.');
    }
    const parsed = readSubscriptionIdFromText(new TextDecoder().decode(bytes));
    const result = {
      available: true,
      configured: parsed.found,
      environmentName: target.name,
      source: target.alias,
      value: parsed.value,
      valid: parsed.valid,
      hash: await sha256(bytes),
    };
    this.instrument({
      operation: 'read-subscription-id',
      environmentName: target.name,
      configured: result.configured,
      valid: result.valid,
    });
    return result;
  }

  async writeSubscriptionId(environmentName, value, expectedHash) {
    const id = validateSubscriptionId(value);
    await this.assertWritable();
    const before = await this.readSubscriptionId(environmentName);
    if (!before.available) throw new Error(`No azd environment file exists at ${before.source}.`);
    if (typeof expectedHash !== 'string' || before.hash !== expectedHash) {
      throw new Error('The azd environment file changed outside Citadel UI. Reload before saving.');
    }
    const target = await this.subscriptionEnvironmentFile(before.environmentName);
    const file = await target.handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (await sha256(bytes) !== expectedHash) {
      throw new Error('The azd environment file changed outside Citadel UI. Reload before saving.');
    }
    const text = new TextDecoder().decode(bytes);
    const afterText = writeSubscriptionIdToText(text, id);
    if (afterText === text) return { ...before, changed: false };

    const afterBytes = new TextEncoder().encode(afterText);
    const stream = await target.handle.createWritable({ keepExistingData: false });
    try {
      await stream.write(afterBytes);
      await stream.close();
    } catch (error) {
      await stream.abort?.();
      throw error;
    }
    const verified = await this.readSubscriptionId(before.environmentName);
    const expectedFinalHash = await sha256(afterBytes);
    if (verified.hash !== expectedFinalHash || verified.value !== id) {
      throw new Error('Subscription ID write verification failed.');
    }
    this.instrument({
      operation: 'write-subscription-id',
      environmentName: before.environmentName,
    });
    return { ...verified, changed: true };
  }

  async fileHandle(alias, options = {}) {
    const safe = normalizeAlias(alias);
    const parts = safe.split('/');
    const leaf = parts.pop();
    let directory = this.root;
    for (const part of parts) {
      directory = await directory.getDirectoryHandle(part, { create: Boolean(options.create) });
    }
    return directory.getFileHandle(leaf, { create: Boolean(options.create) });
  }

  async missingDirectories(alias) {
    const safe = normalizeAlias(alias);
    const parts = safe.split('/');
    parts.pop();
    const missing = [];
    let directory = this.root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      try {
        directory = await directory.getDirectoryHandle(part);
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
        for (let missingIndex = index; missingIndex < parts.length; missingIndex += 1) {
          missing.push(parts.slice(0, missingIndex + 1).join('/'));
        }
        break;
      }
    }
    return missing;
  }

  async read(alias) {
    const safe = normalizeAlias(alias);
    const handle = await this.fileHandle(safe);
    const file = await handle.getFile();
    if (Number(file.size) > MAX_SOURCE_BYTES) {
      throw new Error(`Source exceeds the 8 MiB limit: ${safe}`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(`Source exceeds the 8 MiB limit: ${safe}`);
    }
    const result = {
      alias: safe,
      bytes,
      text: new TextDecoder().decode(bytes),
      size: bytes.byteLength,
      lastModified: file.lastModified,
      hash: await sha256(bytes),
    };
    this.instrument({ operation: 'read', alias: safe, size: result.size, hash: result.hash });
    return result;
  }

  async write(alias, bytes, options = {}) {
    const safe = normalizeAlias(alias);
    const content = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (content.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(`Source exceeds the 8 MiB limit: ${safe}`);
    }
    await this.assertWritable();
    if (options.expectedHash !== undefined) {
      let current = null;
      try {
        current = await this.read(safe);
      } catch (error) {
        if (!options.create || error.name !== 'NotFoundError') throw error;
      }
      const actual = current ? current.hash : null;
      if (actual !== options.expectedHash) {
        throw new Error('File changed outside Citadel UI. Reload before saving.');
      }
    }
    const handle = await this.fileHandle(safe, { create: Boolean(options.create) });
    const stream = await handle.createWritable({ keepExistingData: false });
    try {
      await stream.write(content);
      await stream.close();
    } catch (error) {
      await stream.abort?.();
      throw error;
    }
    const verified = await this.read(safe);
    const expectedFinalHash = options.finalHash || await sha256(content);
    if (verified.hash !== expectedFinalHash) throw new Error(`Final hash verification failed: ${safe}`);
    this.instrument({ operation: 'write', alias: safe, size: verified.size, hash: verified.hash });
    return verified;
  }

  async remove(alias, options = {}) {
    const safe = normalizeAlias(alias);
    const parts = safe.split('/');
    const leaf = parts.pop();
    let boundaryParts = null;
    if (options.pruneEmptyTo) {
      const boundary = normalizeDirectoryAlias(options.pruneEmptyTo);
      boundaryParts = boundary.split('/');
      if (
        parts.length <= boundaryParts.length ||
        boundaryParts.some((part, index) => parts[index] !== part)
      ) {
        throw new Error('Directory cleanup boundary does not contain the removed source.');
      }
    }
    const exactCleanup = options.removeEmptyDirectories || [];
    if (!Array.isArray(exactCleanup)) {
      throw new Error('Directory cleanup aliases must be an array.');
    }
    const cleanupDirectories = [...new Set(exactCleanup.map(normalizeDirectoryAlias))];
    if (
      cleanupDirectories.some(
        (candidate) => !safe.startsWith(`${candidate}/`)
      )
    ) {
      throw new Error('Directory cleanup alias does not contain the removed source.');
    }
    await this.assertWritable();
    let directory = this.root;
    const chain = [];
    for (const part of parts) {
      const parent = directory;
      directory = await directory.getDirectoryHandle(part);
      chain.push({ name: part, parent, handle: directory });
    }
    if (options.expectedHash !== undefined) {
      const current = await this.read(safe);
      if (current.hash !== options.expectedHash) {
        throw new Error('File changed outside Citadel UI. Reload before saving.');
      }
    }
    await directory.removeEntry(leaf);
    this.instrument({ operation: 'remove', alias: safe });

    if (boundaryParts) {
      for (let index = chain.length - 1; index >= boundaryParts.length; index -= 1) {
        const entry = chain[index];
        try {
          // No recursive option: File System Access refuses a non-empty
          // directory, which is the safety boundary for unrelated files.
          await entry.parent.removeEntry(entry.name);
          this.instrument({ operation: 'remove-empty-directory', alias: parts.slice(0, index + 1).join('/') });
        } catch (error) {
          if (error?.name === 'InvalidModificationError' || /not empty/i.test(error?.message || '')) break;
          if (error?.name !== 'NotFoundError') throw error;
        }
      }
    }
    for (const candidate of cleanupDirectories.sort(
      (left, right) => right.split('/').length - left.split('/').length
    )) {
      const candidateParts = candidate.split('/');
      const name = candidateParts.pop();
      let parent = this.root;
      try {
        for (const part of candidateParts) {
          parent = await parent.getDirectoryHandle(part);
        }
        // Deliberately non-recursive: hidden and unrelated entries make this
        // fail closed rather than broadening History undo.
        await parent.removeEntry(name);
        this.instrument({ operation: 'remove-empty-directory', alias: candidate });
      } catch (error) {
        if (
          error?.name !== 'NotFoundError' &&
          error?.name !== 'InvalidModificationError' &&
          !/not empty/i.test(error?.message || '')
        ) {
          throw error;
        }
      }
    }
  }
}

export const sourceScope = Object.freeze({
  extensions: [...SOURCE_EXTENSIONS],
  skippedDirectories: [...SKIP_DIRECTORIES],
  normalizeAlias,
  maxSourceBytes: MAX_SOURCE_BYTES,
  subscriptionEnvironmentKey: 'AZURE_SUBSCRIPTION_ID',
});
