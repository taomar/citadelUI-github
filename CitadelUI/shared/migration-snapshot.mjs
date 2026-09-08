import { MigrationError, safeLabel } from './migration-input.mjs';
import { publicDonorAlias, publicDonorRef, publicRepositoryName } from './migration-public-github.mjs';
import { MAX_SOURCE_BYTES, sourceExtension } from './source-scope.mjs';

export const SNAPSHOT_ENDPOINT = '/api/migration-sources';
export const SNAPSHOT_LIMITS = Object.freeze({
  files: 256,
  bytes: MAX_SOURCE_BYTES,
  snapshotBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  snapshots: 8,
  facts: 2000,
  metadataBytes: 1024 * 1024,
});

export const snapshotId = (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const snapshotHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function snapshotKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) throw new MigrationError('snapshot-format');
}

export function snapshotLabel(value) {
  if (typeof value !== 'string' || !value || safeLabel(value) !== value) throw new MigrationError('snapshot-format');
  return value;
}

export function snapshotAlias(value) {
  try {
    const alias = publicDonorAlias(value);
    // Source documents may contain sensitive configuration, but credential
    // containers are not migration inputs even when renamed to a source suffix.
    if (/(?:^|\/)(?:\.?env|tokens?|credentials?|secrets?|id_rsa)(?:[._-]|$)/i.test(alias)) {
      throw new MigrationError('scope');
    }
    return alias;
  } catch { throw new MigrationError('snapshot-format'); }
}

export function snapshotSource(input) {
  snapshotKeys(input, ['kind', 'label', 'provenance', 'binding']);
  if (!['local-folder', 'local-files', 'public-github', 'authenticated-github'].includes(input.kind)) {
    throw new MigrationError('snapshot-format');
  }
  const source = { kind: input.kind, label: snapshotLabel(input.label), provenance: null, binding: null };
  if (input.kind.endsWith('github')) {
    const p = input.provenance;
    snapshotKeys(p, ['provider', 'repositoryId', 'repository', 'visibility', 'refType', 'ref', 'refSha', 'commit', 'treeSha']);
    if (!Number.isSafeInteger(p.repositoryId) || p.repositoryId <= 0 ||
        !['public', 'private'].includes(p.visibility) || (input.kind === 'public-github' && p.visibility !== 'public') ||
        ![p.refSha, p.commit, p.treeSha].every((sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))) {
      throw new MigrationError('snapshot-format');
    }
    publicDonorRef(p.refType, p.ref);
    source.provenance = {
      provider: input.kind === 'public-github' ? 'anonymous-public-github' : 'authenticated-github',
      repositoryId: p.repositoryId, repository: publicRepositoryName(p.repository), visibility: p.visibility,
      refType: p.refType, ref: p.ref, refSha: p.refSha, commit: p.commit, treeSha: p.treeSha,
    };
  } else if (input.provenance != null) throw new MigrationError('snapshot-format');
  if (input.binding != null) {
    snapshotKeys(input.binding, ['projectId', 'environmentId']);
    source.binding = {
      projectId: snapshotLabel(input.binding.projectId),
      environmentId: snapshotLabel(input.binding.environmentId),
    };
  }
  return source;
}

export function snapshotFacts(input = {}) {
  snapshotKeys(input, ['issues', 'exclusions', 'ignored']);
  const facts = { issues: [], exclusions: [], ignored: input.ignored ?? 0 };
  if (!Number.isSafeInteger(facts.ignored) || facts.ignored < 0 || facts.ignored > SNAPSHOT_LIMITS.facts) {
    throw new MigrationError('snapshot-format');
  }
  for (const key of ['issues', 'exclusions']) {
    const entries = input[key] || [];
    if (!Array.isArray(entries) || entries.length > SNAPSHOT_LIMITS.facts) throw new MigrationError('snapshot-limit');
    facts[key] = entries.map((entry) => {
      snapshotKeys(entry, ['file', 'reason']);
      return { file: snapshotLabel(entry.file), reason: snapshotLabel(entry.reason) };
    });
  }
  return facts;
}

export function snapshotFile(input) {
  snapshotKeys(input, ['sourceId', 'alias', 'format', 'size', 'hash']);
  const alias = snapshotAlias(input.alias);
  if (input.format !== sourceExtension(alias).slice(1) ||
      !snapshotHash(input.hash) || !Number.isSafeInteger(input.size) ||
      input.size < 0 || input.size > SNAPSHOT_LIMITS.bytes) throw new MigrationError('snapshot-format');
  return { sourceId: snapshotLabel(input.sourceId), alias, format: input.format, size: input.size, hash: input.hash };
}

export function snapshotFailure(error) {
  if (error instanceof MigrationError) return error;
  if (typeof error?.code === 'string' && error.code.startsWith('snapshot-')) return new MigrationError(error.code);
  if (error?.status === 413) return new MigrationError('snapshot-limit');
  return new MigrationError('snapshot-unavailable');
}
