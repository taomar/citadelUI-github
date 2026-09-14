import { configurationKey, unitForAlias, unitDependencyAlias, workspaceScope } from '../workspace-configuration.mjs';
import { nativeError, NATIVE_PARSER_VERSION } from './parser.mjs';
import { knownSensitiveValue } from './schema.mjs';

export function assertNativeDraft(configuration, alias, operations, identity) {
  workspaceScope(configuration).write(alias);
  const unit = unitForAlias(configuration, alias);
  if (!identity || identity.version !== NATIVE_PARSER_VERSION || identity.configuration !== configurationKey(configuration) ||
      identity.unitId !== unit.id || identity.valueAlias !== alias || identity.syntax !== unit.syntax ||
      !/^[a-f0-9]{64}$/.test(identity.hash || '') || !Array.isArray(identity.dependencies) || identity.dependencies.length > 150 ||
      identity.dependencies.some((entry) => !unitDependencyAlias(unit, entry.alias) || !/^[a-f0-9]{64}$/.test(entry.hash || ''))) {
    throw nativeError('The saved native draft does not belong to this profile, unit and schema identity.', null, 'NATIVE_DRAFT_IDENTITY');
  }
  if (!Array.isArray(operations) || operations.length > 1000) throw nativeError('Invalid native draft operations.');
  for (const operation of operations) {
    if (!['set', 'append', 'addProperty', 'remove'].includes(operation?.op) ||
        !Array.isArray(operation.path) || !operation.path.length || operation.path.length > 64 ||
        operation.path.some((key) => !(typeof key === 'string' && key.length <= 512 || Number.isSafeInteger(key) && key >= 0))) {
      throw nativeError('Invalid native draft operation address.');
    }
    const path = operation.op === 'addProperty' ? [...operation.path, operation.key] : operation.path;
    if (knownSensitiveValue(operation.value, null, path)) {
      throw nativeError('A known-sensitive draft value cannot be stored. No draft bytes were persisted.', null, 'NATIVE_SENSITIVE_FILE');
    }
  }
}

/** A changed shared head invalidates approval, not an otherwise unchanged draft. */
export function sameNativeDraftBinding(left, right) {
  if (!left || !right) return false;
  const projection = (value) => [value.version, value.configuration, value.unitId, value.valueAlias, value.syntax, value.dependencies];
  return JSON.stringify(projection(left)) === JSON.stringify(projection(right));
}
