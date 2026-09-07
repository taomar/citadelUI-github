import { BrowserReadOnlyDirectoryProvider } from './directory-provider.mjs';
import { resolveAlias } from '../../shared/citadel-core.mjs';
import { MAX_ALIAS_LENGTH, MAX_SOURCE_BYTES, isSkippedDirectory, normalizeAlias, sha256, sourceExtension } from '../../shared/source-scope.mjs';
import { MigrationError, MIGRATION_LIMITS, safeLabel } from '../../shared/migration-input.mjs';

function fileAlias(name) {
  const value = String(name || '');
  if (!value || value.length > MAX_ALIAS_LENGTH || /[/\\\u0000-\u001f\u007f]/.test(value) ||
      value.startsWith('.') || safeLabel(value) !== value ||
      !['.bicepparam', '.json', '.bicep'].includes(sourceExtension(value))) {
    throw new MigrationError('scope');
  }
  return value;
}

export function migrationTargetAlias(alias) {
  try {
    const safe = normalizeAlias(alias);
    if (safeLabel(safe) !== safe || safe.split('/').slice(0, -1).some(isSkippedDirectory) ||
        safe.split('/').at(-1).startsWith('.') ||
        !['.bicepparam', '.bicep'].includes(sourceExtension(safe))) throw new MigrationError('scope');
    return safe;
  } catch { throw new MigrationError('scope'); }
}

export function migrationTemplateAlias(alias, using) {
  if (!using || typeof using !== 'string' || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|[/\\])/.test(using)) return null;
  try {
    const target = migrationTargetAlias(resolveAlias(alias, using));
    return sourceExtension(target) === '.bicep' ? target : null;
  } catch { return null; }
}

async function same(left, right) {
  if (!left || !right || typeof left.isSameEntry !== 'function' || typeof right.isSameEntry !== 'function') {
    throw new MigrationError('identity');
  }
  try { return await left.isSameEntry(right); } catch { throw new MigrationError('identity'); }
}

async function contains(directory, handle) {
  if (typeof directory?.resolve !== 'function') throw new MigrationError('identity');
  try { return await directory.resolve(handle) !== null; } catch { throw new MigrationError('identity'); }
}

/** A donor never enters the registry, WorkspaceService, or a mutation factory. */
export class MigrationDonor {
  #files;
  #folder;

  constructor({ folder = null, files = null }) {
    if (Boolean(folder) === Boolean(files)) throw new MigrationError('scope');
    this.id = globalThis.crypto.randomUUID();
    this.kind = folder ? 'local-folder' : 'local-files';
    this.label = folder ? safeLabel(folder.name, 'Selected donor folder') : 'Explicitly selected local files';
    this.#folder = folder ? new BrowserReadOnlyDirectoryProvider(folder) : null;
    this.#files = files ? [...files].map((handle, index) => {
      if (handle?.kind !== 'file') throw new MigrationError('scope');
      return { id: `file-${index + 1}`, alias: fileAlias(handle.name), handle };
    }) : null;
    if (this.#files && (!this.#files.length || this.#files.length > MIGRATION_LIMITS.files)) {
      throw new MigrationError('limit');
    }
    Object.freeze(this);
  }

  async entries({ request = false } = {}) {
    try {
      if (this.#folder) {
        await this.#folder.assertReadable({ request });
        return (await this.#folder.entries()).map((entry) => {
          migrationTargetAlias(entry.alias);
          return { ...entry, id: entry.alias, format: entry.kind };
        });
      }
      for (let index = 0; index < this.#files.length; index += 1) {
        const { handle } = this.#files[index];
        const options = { mode: 'read' };
        let state = typeof handle.queryPermission === 'function' ? await handle.queryPermission(options) : 'granted';
        if (state !== 'granted' && request && typeof handle.requestPermission === 'function') {
          state = await handle.requestPermission(options);
        }
        if (state !== 'granted') throw new MigrationError('permission');
        for (const prior of this.#files.slice(0, index)) {
          if (await same(prior.handle, handle)) throw new MigrationError('identity');
        }
      }
      return this.#files.map(({ id, alias }) => ({ id, alias, format: sourceExtension(alias).slice(1) }));
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError('permission');
    }
  }

  async handle(id) {
    if (this.#folder) {
      try { return await this.#folder.fileHandle(id); } catch { throw new MigrationError('unavailable'); }
    }
    const file = this.#files.find((entry) => entry.id === id);
    if (!file) throw new MigrationError('scope');
    return file.handle;
  }

  async read(id) {
    try {
      if (this.#folder) {
        const source = await this.#folder.read(id);
        return {
          ...source, text: new TextDecoder('utf-8', { fatal: true }).decode(source.bytes),
          id, handle: await this.handle(id),
        };
      }
      const record = this.#files.find((entry) => entry.id === id);
      if (!record) throw new MigrationError('scope');
      const file = await record.handle.getFile();
      if (file.size > MAX_SOURCE_BYTES) throw new MigrationError('limit');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength > MAX_SOURCE_BYTES) throw new MigrationError('limit');
      return {
        id, alias: record.alias, handle: record.handle, size: bytes.byteLength,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), hash: await sha256(bytes),
      };
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      if (error?.name === 'NotFoundError') throw new MigrationError('missing');
      if (error?.code === 'SOURCE_TOO_LARGE') throw new MigrationError('limit');
      throw new MigrationError('unavailable');
    }
  }

  async template(parameter, using) {
    const alias = migrationTemplateAlias(parameter.alias, using);
    if (!alias) return { id: null, alias: null, source: null };
    if (this.#folder) {
      try { return { id: alias, alias, source: await this.read(alias) }; }
      catch (error) {
        // Still bind the absent reference: it appearing later invalidates a plan.
        // Unreadable existing templates are NOT the same as missing templates:
        // their unknown metadata could mark otherwise innocent names @secure.
        if (error.code !== 'missing') throw error;
        return { id: alias, alias, source: null };
      }
    }
    // Explicit files have no parent path grant. Only an unambiguous, selected
    // sibling template may satisfy a simple `using './template.bicep'`.
    if (alias.includes('/')) return { id: null, alias, source: null };
    const candidates = this.#files.filter((file) => file.alias.toLowerCase() === alias.toLowerCase());
    if (candidates.length > 1) throw new MigrationError('donor-template');
    if (!candidates.length) return { id: null, alias, source: null };
    return { id: candidates[0].id, alias, source: await this.read(candidates[0].id) };
  }

  async assertDistinct(destination, ids, targetAliases = []) {
    const remote = destination.provider.remote === true;
    if (remote) return; // Browser handles and immutable remote blobs are different storage identities.
    const root = destination.provider.root;
    if (root?.kind !== 'directory') throw new MigrationError('identity');
    if (this.#folder) {
      const donor = this.#folder.root;
      if (await same(root, donor) || await contains(root, donor) || await contains(donor, root)) {
        throw new MigrationError('identity');
      }
    }
    const handles = [];
    for (const id of ids) {
      const handle = await this.handle(id);
      if (await contains(root, handle)) throw new MigrationError('identity');
      for (const previous of handles) if (await same(previous, handle)) throw new MigrationError('identity');
      handles.push(handle);
    }
    for (const alias of targetAliases.filter(Boolean)) {
      let handle;
      try { handle = await destination.provider.fileHandle(alias, { create: false }); }
      catch (error) {
        if (error?.name === 'NotFoundError') continue;
        throw new MigrationError('identity');
      }
      for (const donor of handles) if (await same(donor, handle)) throw new MigrationError('identity');
    }
  }

  async assertSameFile(id, previousHandle) {
    if (!await same(previousHandle, await this.handle(id))) throw new MigrationError('stale');
  }
}
