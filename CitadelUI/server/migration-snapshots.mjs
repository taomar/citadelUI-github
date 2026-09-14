import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicJson } from './atomic-json.mjs';
import { atomicWrite } from './transactions.mjs';
import { MigrationError, readArmParameters, readBicepParameters } from '../shared/migration-input.mjs';
import { excludedMigrationSource, migrationTemplateAlias } from '../shared/migration-source-scope.mjs';
import {
  SNAPSHOT_LIMITS, snapshotFacts, snapshotFile, snapshotHash, snapshotId, snapshotKeys, snapshotSource,
} from '../shared/migration-snapshot.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const credential = /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Immutable, sensitive source data; never a workspace or credential store. */
export class MigrationSnapshotStore {
  #serial = Promise.resolve();

  constructor({ dataRoot, limits = {}, faultInjector = () => {} }) {
    this.root = resolve(dataRoot, 'migration-sources');
    this.limits = { ...SNAPSHOT_LIMITS, ...limits };
    this.faultInjector = faultInjector;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new MigrationError('snapshot-corrupt');
    await chmod(this.root, 0o700);
  }

  #locked(operation) {
    const result = this.#serial.then(operation);
    this.#serial = result.catch(() => {});
    return result;
  }

  #path(id, leaf) {
    if (!snapshotId(id)) throw new MigrationError('snapshot-format');
    return join(this.root, id, leaf);
  }

  async #directory(id) {
    const path = this.#path(id, '');
    const info = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') throw new MigrationError('snapshot-unavailable');
      throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new MigrationError('snapshot-corrupt');
    return path;
  }

  async #bytes(path, maximum) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new MigrationError('snapshot-corrupt');
    const bytes = await readFile(path);
    if (bytes.length !== info.size || bytes.length > maximum) throw new MigrationError('snapshot-corrupt');
    return bytes;
  }

  async #manifest(id, complete = true) {
    await this.#directory(id);
    try {
      const bytes = await this.#bytes(this.#path(id, complete ? 'complete.json' : 'staging.json'), this.limits.metadataBytes);
      const record = JSON.parse(bytes.toString('utf8'));
      snapshotKeys(record, ['manifest', 'hash']);
      const m = record.manifest;
      if (!snapshotHash(record.hash) || hash(JSON.stringify(m)) !== record.hash ||
          m?.version !== 1 || m.id !== id || m.status !== (complete ? 'complete' : 'staging') ||
          !Array.isArray(m.files) || !m.files.length || m.files.length > this.limits.files ||
          !Array.isArray(m.templates)) throw new MigrationError('snapshot-corrupt');
      snapshotSource(m.source);
      snapshotFacts(m.facts);
      const ids = new Set();
      for (const file of m.files) {
        const { id: fileId, ...input } = file;
        snapshotFile(input);
        if (!snapshotId(fileId) || ids.has(fileId)) throw new MigrationError('snapshot-corrupt');
        ids.add(fileId);
      }
      return { ...m, manifestHash: record.hash };
    } catch (error) {
      if (error.code === 'ENOENT') throw new MigrationError(complete ? 'snapshot-incomplete' : 'snapshot-unavailable');
      if (error instanceof MigrationError || error instanceof SyntaxError) throw new MigrationError('snapshot-corrupt');
      throw new MigrationError('snapshot-unavailable');
    }
  }

  async #existsComplete(id) {
    try { await lstat(this.#path(id, 'complete.json')); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async #writeManifest(id, manifest, leaf) {
    const record = { manifest, hash: hash(JSON.stringify(manifest)) };
    if (Buffer.byteLength(JSON.stringify(record)) > this.limits.metadataBytes) throw new MigrationError('snapshot-limit');
    await atomicJson(this.#path(id, leaf), record);
    return { ...manifest, manifestHash: record.hash };
  }

  async list() {
    const result = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!snapshotId(entry.name)) throw new MigrationError('snapshot-corrupt');
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new MigrationError('snapshot-corrupt');
      let manifest;
      try {
        const complete = await this.#existsComplete(entry.name);
        manifest = complete ? await this.get(entry.name) : await this.#manifest(entry.name, false);
        result.push({
          id: manifest.id, status: manifest.status, source: manifest.source, createdAt: manifest.createdAt,
          files: manifest.files.length, bytes: manifest.bytes,
        });
      } catch (error) {
        if (!(error instanceof MigrationError)) throw error;
        result.push({ id: entry.name, status: 'unavailable', code: error.code });
      }
    }
    return result.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  begin(input) {
    return this.#locked(async () => {
      snapshotKeys(input, ['source', 'files', 'templates', 'facts']);
      const source = snapshotSource(input.source);
      const facts = snapshotFacts(input.facts);
      if (!Array.isArray(input.files) || !input.files.length || input.files.length > this.limits.files ||
          !Array.isArray(input.templates)) throw new MigrationError('snapshot-limit');
      const files = input.files.map((file) => ({ id: randomUUID(), ...snapshotFile(file) }));
      if (new Set(files.map((file) => file.sourceId)).size !== files.length ||
          !files.some((file) => file.format !== 'bicep')) throw new MigrationError('snapshot-format');
      if (files.some((file) => file.format !== 'bicep' && excludedMigrationSource(file.alias))) throw new MigrationError('snapshot-format');
      const templates = input.templates.map((record) => {
        snapshotKeys(record, ['sourceId', 'templateSourceId', 'alias', 'status']);
        const file = files.find((file) => file.sourceId === record.sourceId && file.format !== 'bicep');
        const template = files.find((file) => file.sourceId === record.templateSourceId && file.format === 'bicep');
        if (!file || !['present', 'missing', 'unresolved'].includes(record.status) ||
            (record.status === 'present' ? !template || template.alias !== record.alias : record.templateSourceId !== null) ||
            (record.alias !== null && !migrationTemplateAlias(file.alias, relativeReference(file.alias, record.alias)))) {
          throw new MigrationError('snapshot-format');
        }
        return { sourceId: file.id, templateId: template?.id || null, alias: record.alias, status: record.status };
      });
      if (templates.length !== files.filter((file) => file.format !== 'bicep').length ||
          new Set(templates.map((record) => record.sourceId)).size !== templates.length ||
          files.some((file) => file.format === 'bicep' && !templates.some((record) => record.templateId === file.id))) {
        throw new MigrationError('snapshot-format');
      }
      const bytes = files.reduce((sum, file) => sum + file.size, 0);
      if (bytes > this.limits.snapshotBytes) throw new MigrationError('snapshot-limit');
      const stored = await this.list();
      // Incomplete/corrupt captures consume a slot, too. Only the owner deletes
      // them; an active source is never silently evicted to make room.
      if (stored.length >= this.limits.snapshots || stored.some((item) => item.status === 'unavailable') ||
          stored.reduce((sum, item) => sum + item.bytes, 0) + bytes > this.limits.totalBytes) {
        throw new MigrationError('snapshot-limit');
      }
      const id = randomUUID();
      await mkdir(this.#path(id, ''), { mode: 0o700 });
      const manifest = {
        version: 1, id, status: 'staging', createdAt: new Date().toISOString(),
        source, files, templates, facts, bytes,
      };
      return this.#writeManifest(id, manifest, 'staging.json');
    });
  }

  upload(id, fileId, expectedHash, bytes) {
    return this.#locked(async () => {
      if (await this.#existsComplete(id)) throw new MigrationError('snapshot-immutable');
      const manifest = await this.#manifest(id, false);
      const file = manifest.files.find((file) => file.id === fileId);
      if (!file || expectedHash !== file.hash || bytes.length !== file.size || hash(bytes) !== file.hash) {
        throw new MigrationError('snapshot-corrupt');
      }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new MigrationError('snapshot-format'); }
      if (credential.test(text)) throw new MigrationError('snapshot-credential');
      if (file.format === 'json') readArmParameters(text);
      else if (file.format === 'bicepparam') readBicepParameters(text);
      const path = this.#path(id, `${file.id}.bin`);
      await atomicWrite(path, bytes, { mode: 0o600, faultInjector: this.faultInjector });
      await this.#readFile(manifest, file);
      return { verified: true, id: file.id, hash: file.hash };
    });
  }

  async #readFile(manifest, file) {
    try {
      const bytes = await this.#bytes(this.#path(manifest.id, `${file.id}.bin`), this.limits.bytes);
      if (bytes.length !== file.size || hash(bytes) !== file.hash) throw new MigrationError('snapshot-corrupt');
      return bytes;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof MigrationError) throw new MigrationError('snapshot-corrupt');
      throw new MigrationError('snapshot-unavailable');
    }
  }

  async #verify(manifest) {
    for (const file of manifest.files) {
      const bytes = await this.#readFile(manifest, file);
      if (file.format === 'bicep') continue;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed = file.format === 'json' ? readArmParameters(text) : readBicepParameters(text);
      const ref = manifest.templates.find((ref) => ref.sourceId === file.id);
      const alias = migrationTemplateAlias(file.alias, parsed.using);
      if (!ref || alias !== ref.alias || (ref.status === 'unresolved' && alias !== null) ||
          (ref.status === 'present' && !manifest.files.some((entry) => entry.id === ref.templateId && entry.alias === alias && entry.format === 'bicep')) ||
          (ref.status !== 'present' && ref.templateId !== null)) throw new MigrationError('snapshot-corrupt');
    }
  }

  complete(id) {
    return this.#locked(async () => {
      if (await this.#existsComplete(id)) return this.get(id);
      const staged = await this.#manifest(id, false);
      await this.#verify(staged);
      this.faultInjector('complete');
      const { manifestHash: _, ...manifest } = staged;
      manifest.status = 'complete';
      // All lifecycle writes are serialized, the manifest is fixed at begin,
      // and completed IDs reject uploads. Publish with the existing atomic
      // storage primitive, without requiring hard-link support from the volume.
      const result = await this.#writeManifest(id, manifest, 'complete.json');
      await unlink(this.#path(id, 'staging.json'));
      return result;
    });
  }

  async get(id) {
    const manifest = await this.#manifest(id);
    await this.#verify(manifest);
    return manifest;
  }

  async read(id, fileId) {
    const manifest = await this.#manifest(id);
    const file = manifest.files.find((file) => file.id === fileId);
    if (!file) throw new MigrationError('snapshot-format');
    return { bytes: await this.#readFile(manifest, file), hash: file.hash };
  }

  delete(id) {
    return this.#locked(async () => {
      await this.#directory(id);
      // The path is exactly one validated, server-generated capture directory.
      await rm(this.#path(id, ''), { recursive: true });
      return { deleted: true, id };
    });
  }
}

function relativeReference(from, to) {
  const base = from.split('/').slice(0, -1);
  const target = String(to).split('/');
  while (base.length && target.length && base[0] === target[0]) { base.shift(); target.shift(); }
  return `${'../'.repeat(base.length)}${target.join('/')}`;
}
