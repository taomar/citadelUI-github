import {
  readSubscriptionIdFromText,
  validateAzdEnvironmentName,
  validateSubscriptionId,
  writeSubscriptionIdToText,
} from './subscription-env.mjs';
import {
  isEnvironmentFile,
  isSkippedDirectory,
  isSourceExtension,
  MAX_ENV_BYTES,
  MAX_SOURCE_BYTES,
  normalizeAlias,
  normalizeDirectoryAlias,
  sha256,
  sourceExtension,
  sourceScope,
} from '../../shared/source-scope.mjs';
import { publicDonorAlias, PUBLIC_DONOR_LIMITS } from '../../shared/migration-public-github.mjs';

export { sha256, sourceScope };

async function readSource(provider, safe) {
  const handle = await provider.fileHandle(safe);
  const file = await handle.getFile();
  if (Number(file.size) > MAX_SOURCE_BYTES) {
    throw Object.assign(new Error(`Source exceeds the 8 MiB limit: ${safe}`), { code: 'SOURCE_TOO_LARGE' });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw Object.assign(new Error(`Source exceeds the 8 MiB limit: ${safe}`), { code: 'SOURCE_TOO_LARGE' });
  }
  const result = {
    alias: safe, bytes, text: new TextDecoder().decode(bytes), size: bytes.byteLength,
    lastModified: file.lastModified, hash: await sha256(bytes),
  };
  result.version = result.hash;
  result.workspaceHead = null;
  provider.instrument({ operation: 'read', alias: safe, size: result.size, hash: result.hash });
  return result;
}

async function permission(handle, request = false, mode = 'readwrite') {
  const options = { mode };
  let state = typeof handle.queryPermission === 'function' ? await handle.queryPermission(options) : 'granted';
  if (state !== 'granted' && request && typeof handle.requestPermission === 'function') {
    state = await handle.requestPermission(options);
  }
  return state;
}

/**
 * Ephemeral donor access. This is intentionally NOT a subclass of the editor
 * provider: it has no write/create/remove methods and no subscription bridge.
 * Old repositories need no current-workspace compatibility scan to be read.
 */
export class BrowserReadOnlyDirectoryProvider {
  constructor(handle, { parameterJson = false } = {}) {
    if (!handle || handle.kind !== 'directory') throw new Error('Directory handle required.');
    this.root = handle;
    this.instrument = () => {};
    this.parameterJson = parameterJson;
  }

  async permission(options = {}) {
    return permission(this.root, Boolean(options.request), 'read');
  }

  async assertReadable(options = {}) {
    if (await this.permission(options) !== 'granted') throw new Error('Read folder permission is required.');
  }

  safeAlias(alias) {
    if (this.parameterJson) return publicDonorAlias(alias);
    const safe = normalizeAlias(alias);
    if (safe.split('/').slice(0, -1).some(isSkippedDirectory) ||
        safe.split('/').at(-1).startsWith('.') ||
        !['.bicepparam', '.bicep'].includes(sourceExtension(safe))) {
      throw new Error('Unsupported donor source scope.');
    }
    return safe;
  }

  async entries() {
    await this.assertReadable();
    const files = [];
    const walk = async (directory, prefix = '') => {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'directory') {
          if (!isSkippedDirectory(name)) await walk(handle, prefix ? `${prefix}/${name}` : name);
        } else if (['.bicepparam', '.bicep', ...(this.parameterJson ? ['.json'] : [])].includes(sourceExtension(name))) {
          if (isEnvironmentFile(name) || name.startsWith('.')) continue;
          const alias = this.safeAlias(prefix ? `${prefix}/${name}` : name);
          files.push({ alias, kind: sourceExtension(name).slice(1) });
          if (files.length > PUBLIC_DONOR_LIMITS.files) throw new Error('Source inventory exceeds its bounded file count.');
        }
      }
    };
    await walk(this.root);
    return files.sort((left, right) => left.alias.localeCompare(right.alias));
  }

  async fileHandle(alias) {
    const parts = this.safeAlias(alias).split('/');
    const leaf = parts.pop();
    let directory = this.root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: false });
    return directory.getFileHandle(leaf, { create: false });
  }

  async read(alias) {
    await this.assertReadable();
    // Reuse byte limits/hashing, but resolve only through our read-only scope.
    return readSource(this, this.safeAlias(alias));
  }
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
          if (isSkippedDirectory(name)) continue;
          await walk(handle, prefix ? `${prefix}/${name}` : name);
          continue;
        }
        const alias = prefix ? `${prefix}/${name}` : name;
        if (isEnvironmentFile(name)) continue;
        if (!isSourceExtension(name)) continue;
        files.push({ alias, kind: sourceExtension(name).slice(1) });
      }
    };
    await walk(this.root);
    files.sort((a, b) => a.alias.localeCompare(b.alias));
    this.instrument({ operation: 'enumerate', count: files.length });
    return files;
  }

  async subscriptionEnvironmentFile(environmentName, options = {}) {
    const name = validateAzdEnvironmentName(environmentName);
    const create = Boolean(options.create);
    try {
      const azure = await this.root.getDirectoryHandle('.azure', { create });
      const environment = await azure.getDirectoryHandle(name, { create });
      const handle = await environment.getFileHandle('.env', { create });
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
    if (
      (before.available && (typeof expectedHash !== 'string' || before.hash !== expectedHash)) ||
      (!before.available && expectedHash !== null)
    ) {
      throw new Error('The azd environment file changed outside Citadel UI. Reload before saving.');
    }
    const target = await this.subscriptionEnvironmentFile(before.environmentName, {
      create: !before.available,
    });
    const file = await target.handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (
      (before.available && await sha256(bytes) !== expectedHash) ||
      (!before.available && bytes.byteLength > 0)
    ) {
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
    return readSource(this, normalizeAlias(alias));
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
    await options.validateBeforeWrite?.();
    const stream = await handle.createWritable({ keepExistingData: false });
    try {
      await options.validateBeforeWrite?.();
      await stream.write(content);
      // File System Access stages writes until close. An operation-specific
      // invalidation while opening/writing the stream must abort, not publish.
      await options.validateBeforeWrite?.();
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
