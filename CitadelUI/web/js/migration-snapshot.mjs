import { localRequest } from './local-api.mjs';
import { environmentSourceOf } from './registry.mjs';
import { MigrationError, readArmParameters, readBicepParameters, safeLabel } from '../../shared/migration-input.mjs';
import { migrationTemplateAlias } from '../../shared/migration-source-scope.mjs';
import { sha256 } from '../../shared/source-scope.mjs';
import {
  SNAPSHOT_ENDPOINT as BASE, SNAPSHOT_LIMITS, snapshotFailure, snapshotHash, snapshotId, snapshotSource,
} from '../../shared/migration-snapshot.mjs';

async function requestSource(request, path, options) {
  try { return await request(path, options); } catch (error) { throw snapshotFailure(error); }
}

export class MigrationSnapshots {
  constructor({ request = localRequest, registry } = {}) {
    this.request = request;
    this.registry = registry;
  }

  async list() {
    const result = await requestSource(this.request, BASE);
    if (!Array.isArray(result?.sources) || result.sources.length > SNAPSHOT_LIMITS.snapshots) throw new MigrationError('snapshot-format');
    return result.sources;
  }

  async open(id, destination) {
    if (!snapshotId(id)) throw new MigrationError('snapshot-format');
    const manifest = await requestSource(this.request, `${BASE}/${id}`);
    const donor = new SnapshotMigrationDonor(manifest, this);
    await donor.assertDistinct(destination);
    return donor;
  }

  async delete(id) {
    if (!snapshotId(id)) throw new MigrationError('snapshot-format');
    const result = await requestSource(this.request, `${BASE}/${id}/delete`, { method: 'POST', body: '{}' });
    await this.registry?.forgetMigrationSnapshotTarget?.(id);
    return result;
  }

  async capture(donor, { destination, discover, onProgress = () => {} }) {
    const captured = new Map();
    let bytes = 0;
    const retain = async (id, source) => {
      if (captured.has(id)) return captured.get(id);
      const data = source.bytes || new TextEncoder().encode(source.text);
      if (data.length !== source.size || await sha256(data) !== source.hash) throw new MigrationError('stale');
      bytes += data.length;
      if (bytes > SNAPSHOT_LIMITS.snapshotBytes || captured.size >= SNAPSHOT_LIMITS.files) throw new MigrationError('snapshot-limit');
      const file = { ...source, bytes: data.slice() };
      captured.set(id, file);
      return file;
    };
    const entries = await donor.entries();
    const reader = {
      kind: donor.kind, id: donor.id, label: donor.label,
      entries: async () => entries,
      read: async (id) => captured.get(id) || retain(id, await donor.read(id)),
      assertDistinct: (...args) => donor.assertDistinct(...args),
      ...(donor.inspectJsonCandidate ? { inspectJsonCandidate: (id) => donor.inspectJsonCandidate(id) } : {}),
    };
    const inventory = await discover(reader, { onProgress, maxBytes: SNAPSHOT_LIMITS.snapshotBytes });
    const selected = [...inventory.items, ...inventory.unassigned, ...inventory.otherFiles];
    if (!selected.length) throw Object.assign(new MigrationError('snapshot-empty'), { acquisitionIssues: inventory.issues });
    // Malformed and unrelated discovery candidates are facts, not stored bytes.
    const selectedIds = new Set(selected.map((entry) => entry.id));
    for (const [id, file] of captured) if (!selectedIds.has(id)) { captured.delete(id); bytes -= file.size; }
    const templates = [];
    for (const entry of selected) {
      const file = captured.get(entry.id);
      const parsed = entry.format === 'json' ? readArmParameters(file.text) : readBicepParameters(file.text);
      const template = await donor.template(file, parsed.using);
      if (template.source) await retain(template.id, template.source);
      templates.push({
        sourceId: entry.id, templateSourceId: template.source ? template.id : null,
        alias: template.alias, status: template.source ? 'present' : template.alias ? 'missing' : 'unresolved',
      });
    }
    await donor.assertDistinct(destination, [...captured.keys()]);
    const provenance = donor.provenance?.() || null;
    await donor.assertFresh?.(provenance);
    if (!provenance) {
      // Finish the local capture against the exact entries/bytes inspected.
      if (JSON.stringify(await donor.entries()) !== JSON.stringify(entries)) throw new MigrationError('stale');
      for (const [id, file] of captured) {
        await donor.assertSameFile(id, file.handle);
        if ((await donor.read(id)).hash !== file.hash) throw new MigrationError('stale');
      }
    }
    const localBinding = donor.kind.startsWith('local-') && destination.provider.remote !== true;
    if (localBinding && typeof this.registry?.rememberMigrationSnapshotTarget !== 'function') {
      throw new MigrationError('snapshot-identity');
    }
    const source = snapshotSource({
      kind: donor.kind, label: safeLabel(donor.label), provenance,
      binding: localBinding ? { projectId: destination.projectId, environmentId: destination.environment.id } : null,
    });
    const stage = await requestSource(this.request, BASE, {
      method: 'POST', body: JSON.stringify({
        source,
        files: [...captured].map(([sourceId, file]) => ({
          sourceId, alias: file.alias, format: file.alias.split('.').at(-1).toLowerCase(), size: file.size, hash: file.hash,
        })),
        templates, facts: { issues: inventory.issues, exclusions: donor.exclusions?.() || [], ignored: inventory.ignored },
      }),
    });
    let completed = 0;
    for (const file of stage.files) {
      const content = captured.get(file.sourceId);
      if (!content || content.hash !== file.hash || content.size !== file.size || !snapshotId(file.id)) {
        throw new MigrationError('snapshot-format');
      }
      onProgress({ phase: 'storing', completed, total: stage.files.length });
      await requestSource(this.request, `${BASE}/${stage.id}/files/${file.id}`, {
        method: 'PUT', body: content.bytes,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Citadel-Content-SHA256': content.hash },
      });
      completed += 1;
    }
    if (localBinding) await this.registry.rememberMigrationSnapshotTarget(stage.id, destination.provider.root);
    onProgress({ phase: 'verifying', completed, total: stage.files.length });
    await requestSource(this.request, `${BASE}/${stage.id}/complete`, { method: 'POST', body: '{}' });
    return this.open(stage.id, destination);
  }
}

/** All methods use the owner-gated container copy. There is no original donor. */
export class SnapshotMigrationDonor {
  #manifest;
  #client;

  constructor(manifest, client) {
    if (!snapshotId(manifest?.id) || manifest.status !== 'complete' || !snapshotHash(manifest.manifestHash) ||
        !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > SNAPSHOT_LIMITS.files) {
      throw new MigrationError('snapshot-incomplete');
    }
    snapshotSource(manifest.source);
    this.#manifest = structuredClone(manifest);
    this.#client = client;
    this.id = manifest.id;
    this.kind = manifest.source.kind;
    this.label = manifest.source.label;
    this.snapshot = Object.freeze({ id: manifest.id, createdAt: manifest.createdAt, files: manifest.files.length, bytes: manifest.bytes });
    Object.freeze(this);
  }

  entries() {
    return Promise.resolve(this.#manifest.files.map((file) => ({ id: file.id, alias: file.alias, format: file.format })));
  }

  provenance() {
    return { ...this.#manifest.source.provenance, snapshotId: this.id, capturedAt: this.#manifest.createdAt, manifestHash: this.#manifest.manifestHash };
  }

  exclusions() { return structuredClone(this.#manifest.facts.exclusions); }
  acquisitionFacts() { return structuredClone(this.#manifest.facts); }

  async inspectJsonCandidate(id) {
    readArmParameters((await this.read(id)).text);
    return { kind: 'parameters' };
  }

  async read(id) {
    const file = this.#manifest.files.find((file) => file.id === id);
    if (!file) throw new MigrationError('snapshot-format');
    const result = await requestSource(this.#client.request, `${BASE}/${this.id}/files/${id}`, { responseType: 'bytes' });
    if (result.bytes?.length !== file.size || result.hash !== file.hash || await sha256(result.bytes) !== file.hash) {
      throw new MigrationError('snapshot-corrupt');
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes); }
    catch { throw new MigrationError('snapshot-corrupt'); }
    return {
      id, alias: file.alias, bytes: result.bytes, text, hash: file.hash, size: file.size, version: file.hash,
      handle: { snapshotId: this.id, fileId: id, hash: file.hash },
    };
  }

  async template(parameter, using) {
    const entry = this.#manifest.templates.find((entry) => entry.sourceId === parameter.id);
    if (!entry || migrationTemplateAlias(parameter.alias, using) !== entry.alias) throw new MigrationError('snapshot-corrupt');
    return { id: entry.templateId, alias: entry.alias, source: entry.templateId ? await this.read(entry.templateId) : null };
  }

  async assertFresh(expected) {
    if (JSON.stringify(this.provenance()) !== JSON.stringify(expected)) throw new MigrationError('snapshot-corrupt');
    const manifest = await requestSource(this.#client.request, `${BASE}/${this.id}`);
    if (manifest.status !== 'complete' || manifest.manifestHash !== this.#manifest.manifestHash) throw new MigrationError('snapshot-corrupt');
  }

  async assertSameFile(id, identity) {
    const file = this.#manifest.files.find((file) => file.id === id);
    if (!file || identity?.snapshotId !== this.id || identity.fileId !== id || identity.hash !== file.hash) {
      throw new MigrationError('snapshot-corrupt');
    }
  }

  async assertDistinct(destination) {
    const source = this.#manifest.source;
    const target = environmentSourceOf(destination.environment);
    if (source.provenance) {
      if (destination.provider.remote !== true) return;
      let current;
      try { current = await destination.provider.tree(); }
      catch { throw new MigrationError('target-unavailable'); }
      const same = String(target.repositoryId) === String(source.provenance.repositoryId);
      if ((!same && target.fullName?.toLowerCase() === source.provenance.repository.toLowerCase()) ||
          (same && (current.head === source.provenance.commit ||
            source.provenance.refType === 'branch' && target.workingBranch === source.provenance.ref))) {
        throw new MigrationError('identity');
      }
      return;
    }
    if (destination.provider.remote === true) return;
    const binding = source.binding;
    const root = await this.#client.registry?.migrationSnapshotTarget?.(this.id);
    if (binding?.projectId !== destination.projectId || binding.environmentId !== destination.environment.id ||
        !root || typeof destination.provider.root?.isSameEntry !== 'function' ||
        !await destination.provider.root.isSameEntry(root)) throw new MigrationError('snapshot-identity');
  }
}
