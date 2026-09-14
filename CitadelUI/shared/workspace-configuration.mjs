import { isSkippedDirectory, normalizeAlias } from './source-scope.mjs';

export const CONFIGURATION_VERSION = 1;
export const TERRAFORM_ADAPTER_VERSION = 1;
export const TERRAFORM_ROOTS = Object.freeze({
  deployment: '',
  llm: 'llm-backend-onboarding',
  access: 'citadel-access-contracts',
});
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const ROOT_MODULES = new Set([
  'access-contracts', 'apic', 'apim', 'cosmosdb', 'entra-id', 'eventhub',
  'foundry', 'logic-app', 'monitoring', 'networking', 'redis', 'security',
]);
const LEGACY = Object.freeze({ version: 1, format: 'bicep', profileId: 'legacy-bicep', revision: 1, units: [] });

export function configurationError(message, code = 'INVALID_CONFIGURATION') {
  return Object.assign(new Error(message), { status: 400, code });
}

function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    throw configurationError(`Invalid ${label}; unsupported fields.`);
  }
}

/** Canonical repository aliases, never display paths or normalized traversal. */
export function nativeAlias(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\') ||
      /[\u0000-\u001f\u007f:]/.test(value)) throw configurationError('Invalid native source alias.');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 160 ||
      part.endsWith('.') || part.endsWith(' ') || isSkippedDirectory(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw configurationError('Native source alias contains an excluded or unsafe segment.');
  }
  if (parts.some((part) => /(?:tfstate|tfplan|terraform\.plan|\.plan(?:\.|$)|credentials?|secrets?)(?:[._-]|$)/i.test(part)) ||
      /(?:^|\/)(?:plan|state)(?:[._-]|$)/i.test(value)) {
    throw configurationError('State, plans, credentials and secret files are outside the editor scope.', 'EXCLUDED_NATIVE_SOURCE');
  }
  return value;
}

export function validateConfiguration(value) {
  keys(value, ['version', 'format', 'profileId', 'revision', 'units'], 'configuration descriptor');
  if (value.version !== CONFIGURATION_VERSION || value.revision !== 1) {
    throw configurationError('Unsupported configuration version. Open with a compatible Citadel version; no bindings were changed.', 'CONFIGURATION_VERSION');
  }
  if (!['bicep', 'terraform'].includes(value.format) || !ID.test(value.profileId || '')) {
    throw configurationError('Invalid configuration format or profile identity.');
  }
  if (!Array.isArray(value.units) || value.units.length > 24 ||
      (value.format === 'terraform' ? !value.units.length : value.units.length)) {
    throw configurationError('Select one or more native Terraform root/value-file units.');
  }
  const ids = new Set(), aliases = new Set();
  const units = value.units.map((unit) => {
    keys(unit, ['id', 'area', 'rootAlias', 'valueAlias', 'syntax', 'allowCreate', 'nonsecret'], 'native unit');
    if (!ID.test(unit.id || '') || ids.has(unit.id)) throw configurationError('Native unit identities must be unique.');
    if (!Object.hasOwn(TERRAFORM_ROOTS, unit.area) || unit.rootAlias !== TERRAFORM_ROOTS[unit.area]) {
      throw configurationError('Choose a supported Terraform root: Deployment, LLM onboarding or Access contracts.');
    }
    const alias = nativeAlias(unit.valueAlias);
    const prefix = unit.area === 'deployment' ? 'environments/' : `${unit.rootAlias}/`;
    const leaf = alias.startsWith(prefix) ? alias.slice(prefix.length) : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.tfvars(?:\.json)?$/.test(leaf) ||
        leaf.includes('/') || /\.auto\.tfvars/i.test(leaf)) {
      throw configurationError('Select a named operator .tfvars (or explicit .tfvars.json) in the selected root. Examples and auto-loaded files are not edit targets.');
    }
    if (unit.syntax !== (alias.endsWith('.json') ? 'json-tfvars' : 'hcl-tfvars')) {
      throw configurationError('The selected value-file syntax does not match its alias.');
    }
    if (unit.nonsecret !== true || typeof unit.allowCreate !== 'boolean') {
      throw configurationError('Explicitly confirm a nonsecret operator file and whether to create it if absent.');
    }
    // Case folding is deliberately conservative across transports: a profile
    // must also have one unambiguous owner when reopened on Windows.
    if (aliases.has(alias.toLowerCase())) throw configurationError('A native value file can belong to only one unit.');
    ids.add(unit.id);
    aliases.add(alias.toLowerCase());
    return { id: unit.id, area: unit.area, rootAlias: unit.rootAlias, valueAlias: alias,
      syntax: unit.syntax, allowCreate: unit.allowCreate, nonsecret: true };
  });
  return { version: value.version, format: value.format, profileId: value.profileId, revision: value.revision, units };
}

export function configurationOf(environment) {
  return environment?.configuration === undefined ? LEGACY : validateConfiguration(environment.configuration);
}

export function configurationKey(configuration) {
  const config = configuration === undefined ? LEGACY : validateConfiguration(configuration);
  return JSON.stringify(config);
}

/** Logical selection equality excludes newly allocated profile/unit IDs. */
export function bindingKey(configuration) {
  const config = configuration === undefined ? LEGACY : validateConfiguration(configuration);
  return JSON.stringify([config.format, config.units.map(({ area, rootAlias, valueAlias, syntax, allowCreate, nonsecret }) =>
    ({ area, rootAlias, valueAlias, syntax, allowCreate, nonsecret })).sort((a, b) => a.valueAlias.localeCompare(b.valueAlias))]);
}

export function assertUnchangedConfiguration(previous, next) {
  if (configurationKey(previous) !== configurationKey(next)) {
    throw configurationError('Native bindings are immutable. Attach a new workspace for a different format, root or value file.', 'CONFIGURATION_RETARGET');
  }
}

export function assertUnchangedNativeSource(previous, next) {
  if (configurationOf(previous).format !== 'terraform') return;
  const identity = (environment) => {
    const source = environment.source;
    return source?.kind === 'github'
      ? [environment.projectId, source.kind, String(source.repositoryId), source.sourceBranch, source.workingBranch, source.connectionProfileId, source.writeMode]
      : [environment.projectId, source?.kind, source?.folderName];
  };
  if (JSON.stringify(identity(previous)) !== JSON.stringify(identity(next))) {
    throw configurationError('A native workspace cannot be retargeted to another repository, branch, connection or folder. Attach a new workspace with an intentional identity.', 'NATIVE_SOURCE_RETARGET');
  }
}

export function createConfiguration(format, units = []) {
  return validateConfiguration({ version: 1, revision: 1, profileId: crypto.randomUUID(), format,
    units: units.map((unit) => ({ ...unit, id: unit.id || crypto.randomUUID() })) });
}

export function unitForAlias(configuration, alias) {
  return configuration.units.find((unit) => unit.valueAlias === alias) || null;
}

export function unitDependencyAlias(unit, alias) {
  const prefix = unit.rootAlias ? `${unit.rootAlias}/` : '';
  if ([`${prefix}variables.tf`, `${prefix}main.tf`].includes(alias)) return true;
  if (unit.area === 'access' && alias === `${prefix}policies/default-ai-product-policy.xml`) return true;
  if (unit.area !== 'deployment') return false;
  const parts = alias.split('/');
  return parts[0] === 'modules' && ROOT_MODULES.has(parts[1]) && parts.length <= 5 &&
    /^[A-Za-z0-9_-]+\.tf$/.test(parts.at(-1)) && !/^(?:providers?|backend|outputs?)\.tf$/i.test(parts.at(-1));
}

export function nativeInventoryAlias(alias) {
  try { nativeAlias(alias); } catch { return false; }
  if (Object.entries(TERRAFORM_ROOTS).some(([area, rootAlias]) => unitDependencyAlias({ area, rootAlias }, alias))) return true;
  return /^(?:environments|llm-backend-onboarding|citadel-access-contracts)\/[^/]+\.tfvars(?:\.json|\.example)?$/.test(alias) &&
    !/\.auto\.tfvars/.test(alias);
}

/** Inventory is not authority: only registered units confer read/write scope. */
export function workspaceScope(configuration) {
  const config = configuration === undefined ? LEGACY : validateConfiguration(configuration);
  const native = config.format === 'terraform';
  const assert = (alias, write = false) => {
    if (!native) {
      try { return normalizeAlias(alias); }
      catch (error) { throw configurationError(error.message, 'INVALID_ALIAS'); }
    }
    const safe = nativeAlias(alias);
    if (!unitForAlias(config, safe) && (write || !config.units.some((unit) => unitDependencyAlias(unit, safe)))) {
      throw configurationError(write
        ? 'Only this workspace unit\'s selected nonsecret operator values can be written. Configuration and shared policies are read-only.'
        : 'This source is outside the registered native workspace bindings.', 'NATIVE_SOURCE_SCOPE');
    }
    return safe;
  };
  return Object.freeze({
    configuration: config, native,
    read: (alias) => assert(alias),
    write: (alias) => assert(alias, true),
    includes: (alias) => { try { assert(alias); return true; } catch { return false; } },
  });
}

export function assertNoWritableOverlap(environments) {
  const owners = new Map(), profiles = new Map(), units = new Map();
  for (const environment of environments) {
    const config = configurationOf(environment);
    if (config.format !== 'terraform') continue;
    if (environment.source?.kind === 'github') {
      for (const unit of config.units) {
        const key = `${environment.source.repositoryId}:${environment.source.workingBranch}:${unit.valueAlias.toLowerCase()}`;
        if (owners.has(key) && owners.get(key) !== environment.id) {
          throw configurationError('That repository, working branch and native value file already have a workspace owner. Open it or choose a separate branch/file.', 'NATIVE_OWNERSHIP_OVERLAP');
        }
        owners.set(key, environment.id);
      }
    }
    for (const [map, identity] of [[profiles, config.profileId], ...config.units.map((unit) => [units, unit.id])]) {
      if (map.has(identity) && map.get(identity) !== environment.id) {
        throw configurationError('A native profile or unit identity already belongs to another workspace. Create an intentional new workspace identity.', 'NATIVE_IDENTITY_OVERLAP');
      }
      map.set(identity, environment.id);
    }
  }
}
export function unconfirmedNativeCreation(transaction) {
  return transaction?.configuration?.format === 'terraform' && transaction.status !== 'reverting' &&
    transaction.files?.some((file) => file.existed === false && !file.receiptVerified);
}
