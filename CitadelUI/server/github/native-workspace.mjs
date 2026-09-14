import { configurationKey, unitForAlias, workspaceScope } from '../../shared/workspace-configuration.mjs';
import { assertNativeFileSafe, decodeNativeBytes, nativeDependencyProof, nativeDocument, readUnitSchema } from '../../shared/terraform/workspace.mjs';
import { nativeError } from '../../shared/terraform/parser.mjs';
import { validateNativeAfter, validateNativeTransactionProof } from '../../shared/terraform/review.mjs';
import { githubScanProvider } from './scan-provider.mjs';
import { loadTree, readBlob } from './git-reader.mjs';

export async function validateNativeChangeSet(client, token, options, changes, head) {
  const configuration = options.configuration;
  const scope = workspaceScope(configuration);
  const snapshot = await loadTree(client, token, options.fullName, head, configuration);
  const provider = githubScanProvider(client, token, options.fullName, snapshot, configuration);
  const proof = options.nativeHistory ? null
    : await validateNativeTransactionProof(configuration, changes.map((change) => change.alias), options.nativeProof);
  for (const change of changes) {
    scope.write(change.alias);
    const unit = unitForAlias(configuration, change.alias);
    const document = await nativeDocument(provider, configuration, unit);
    if (!options.nativeHistory && (
      options.nativeIdentity?.hash !== document.nativeIdentity.hash ||
      options.nativeIdentity?.unitId !== unit.id ||
      proof.units.find((item) => item.unitId === unit.id)?.dependencies.some((item) =>
        document.nativeIdentity.dependencies.find((dependency) => dependency.alias === item.alias)?.hash !== item.hash)
    )) {
      throw nativeError('The native schema/module/policy bytes or branch head changed after approval. Keep the draft and review the new source.', null, 'NATIVE_REVIEW_STALE');
    }
    if (change.remove) {
      if (!options.nativeHistory) throw nativeError('Deleting an entire native operator file is allowed only through its scoped History undo.');
      continue;
    }
    const text = decodeNativeBytes(change.after);
    await assertNativeFileSafe(text, unit, document.schema.parameters);
    if (!options.nativeHistory) validateNativeAfter(document, text);
  }
  return configurationKey(configuration);
}

export function assertNativeAuditScope(record, configuration) {
  if (configuration?.format !== 'terraform') {
    if (record?.configurationKey) throw nativeError('Native commit history cannot be opened under Bicep scope.', null, 'NATIVE_HISTORY_SCOPE');
    return;
  }
  if (!record || record.configurationKey !== configurationKey(configuration)) {
    throw nativeError('This commit does not belong to the registered native profile and unit bindings.', null, 'NATIVE_HISTORY_SCOPE');
  }
  for (const alias of record.aliases || []) workspaceScope(configuration).write(alias);
}

export async function assertNativeHistoryBytes(client, token, fullName, head, configuration, aliases) {
  const snapshot = await loadTree(client, token, fullName, head, configuration);
  const provider = githubScanProvider(client, token, fullName, snapshot, configuration);
  const dependencies = [];
  for (const alias of aliases) {
    const unit = unitForAlias(configuration, workspaceScope(configuration).write(alias));
    dependencies.push({ alias, dependencies: (await nativeDependencyProof(provider, configuration, unit)).dependencies });
    const entry = snapshot.files.find((item) => item.alias === alias);
    if (!entry) continue;
    const { parameters } = await readUnitSchema(provider, unit);
    const blob = await readBlob(client, token, fullName, entry.sha);
    await assertNativeFileSafe(decodeNativeBytes(blob.bytes), unit, parameters);
  }
  return dependencies;
}
