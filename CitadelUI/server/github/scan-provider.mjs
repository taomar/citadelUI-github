import { unitForAlias, workspaceScope } from '../../shared/workspace-configuration.mjs';
import { assertNativeDependencySafe, assertNativeFileSafe, decodeNativeBytes, readUnitSchema } from '../../shared/terraform/workspace.mjs';
import { decodeSourceBytes } from '../../shared/source-text.mjs';
import { githubError } from './api.mjs';
import { readBlob } from './git-reader.mjs';

/** Sources read during one scan, so a malformed repository cannot be a workload. */
const MAX_SCANNED_SOURCES = 400;

/**
 * A read-only discovery provider backed by one commit's tree.
 *
 * Only entries, source reads and the pinned workspace head are exposed.
 */
export function githubScanProvider(client, token, fullName, snapshot, configuration = undefined) {
  const blobs = new Map();
  const scope = workspaceScope(configuration);
  let reads = 0;
  return {
    // Reads cross a network, so discovery scopes itself. This scan passes an
    // explicit narrower scope as well; stating it here keeps the provider
    // honest if that ever stops being true.
    remote: true,
    configuration,
    workspaceHead: async () => snapshot.commit,
    async entries() {
      return snapshot.files.map((file) => ({ alias: file.alias, kind: file.kind }));
    },
    async read(alias) {
      scope.read(alias);
      const file = snapshot.files.find((item) => item.alias === alias);
      if (!file) {
        throw githubError(404, 'SOURCE_NOT_FOUND', `Source not found: ${alias}`);
      }
      const key = scope.native ? `${alias}:${file.sha}` : file.sha;
      const cached = blobs.get(key);
      if (cached) return { ...cached, alias };
      reads += 1;
      if (reads > MAX_SCANNED_SOURCES) {
        throw githubError(
          413,
          'REPOSITORY_TOO_LARGE',
          'This repository has too many Citadel sources to validate.'
        );
      }
      const blob = await readBlob(client, token, fullName, file.sha);
      const record = { alias, ...(scope.native ? { text: decodeNativeBytes(blob.bytes) } : decodeSourceBytes(blob.bytes)),
        bytes: blob.bytes, size: blob.size, hash: blob.hash, workspaceHead: snapshot.commit };
      if (scope.native) {
        await assertNativeDependencySafe(record.text, alias);
        const unit = unitForAlias(scope.configuration, alias);
        if (unit) {
          const { parameters } = await readUnitSchema(this, unit);
          await assertNativeFileSafe(record.text, unit, parameters);
        }
      }
      blobs.set(key, record);
      return record;
    },
  };
}
