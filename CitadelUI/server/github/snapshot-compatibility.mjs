import { createHash } from 'node:crypto';
import { discoverWorkspace } from '../../shared/citadel-core.mjs';
import { citadelSourcePlan, planScope } from '../../shared/source-plan.mjs';
import { isEnvironmentFile, isSkippedDirectory, isSourceExtension, sourceExtension } from '../../shared/source-scope.mjs';
import { snapshotError } from '../../shared/repository-snapshot.mjs';

/** Inspect the already verified snapshot instead of downloading its files again. */
export async function assertSnapshotCompatibility(manifest, blobs) {
  const files = manifest.files.filter((file) =>
    !file.path.split('/').slice(0, -1).some(isSkippedDirectory) &&
    !isEnvironmentFile(file.path.split('/').at(-1)) && isSourceExtension(file.path)
  ).map((file) => ({ ...file, alias: file.path, kind: sourceExtension(file.path).slice(1) }));
  const byPath = new Map(files.map((file) => [file.alias, file]));
  const provider = {
    remote: true,
    entries: async () => files,
    read: async (alias) => {
      const file = byPath.get(alias);
      const blob = file && blobs.get(file.sha);
      if (!blob || blob.text === null) {
        throw snapshotError('IMPORT_SOURCE_UNSUPPORTED', 'A required Citadel source is missing or is not UTF-8 text.');
      }
      return { text: blob.text, size: blob.bytes.length,
        hash: blob.hash || createHash('sha256').update(blob.bytes).digest('hex') };
    },
  };
  const catalog = await discoverWorkspace(provider, { scope: planScope(citadelSourcePlan(files), 'capabilities') });
  if (catalog.compatibility !== 'supported') {
    throw snapshotError('IMPORT_SOURCE_UNSUPPORTED', 'The complete snapshot is not a supported Citadel workspace.');
  }
  return catalog;
}
