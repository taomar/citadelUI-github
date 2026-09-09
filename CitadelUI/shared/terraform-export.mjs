import { documentFromText, extractSchema } from './citadel-core.mjs';
import { parseBicepParam } from './bicepparam/parser.mjs';
import { literalBicep, readBicepParameters, sameLiteralValue } from './migration-input.mjs';
import { readMigrationSchema, typeMatches, checkMigrationValue } from './migration-schema.mjs';
import { assertBalancedXml } from './policy.mjs';
import {
  ACCESS_MAPPING, BREAKER_DEFAULTS, COORDINATE_FIELDS, EXPORT_AREAS, FOUNDRY_CONFIG_FIELDS,
  FOUNDRY_COORDINATES, INSIGHTS_DEFAULTS, MAIN_INPUTS, MAIN_UNUSED, MODEL_DEFAULTS, MONITOR_DEFAULTS,
  POLICY_FRAGMENTS, SOURCE_MAPPING, TERRAFORM_CONTRACT, USE_CASE_FIELDS, targetVariablesProblems,
} from './terraform-contract.mjs';
import { assertExportValue, exportEnvironmentName, exportSecret, TerraformExportError, terraformVariables } from './terraform-literals.mjs';

export const exportPathKey = (path) => JSON.stringify(path);
export const EXPORT_STATUS = Object.freeze({
  mapped: 'Mapped', transformed: 'Transformed', input: 'Needs input', change: 'Requires Terraform change',
});
const rank = { mapped: 0, transformed: 1, input: 2, change: 3 };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = (value) => value === '' || value === null ||
  (Array.isArray(value) && !value.length) || (isObject(value) && !Object.keys(value).length);
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const targetPath = (area, environment) => area === 'deployment'
  ? `environments/${environment || '<environment>'}.tfvars`
  : `${area === 'llm' ? 'llm-backend-onboarding' : 'citadel-access-contracts'}/terraform.tfvars`;

function issue(row, status, reason, path = [row.source], targets = row.targets) {
  if (rank[status] > rank[row.status]) row.status = status;
  row.notes.push({ status, reason, path, targets });
}

function transform(row, reason) {
  issue(row, 'transformed', reason);
}

function sourceType(path, descriptor) {
  if (path.length === 1) return descriptor.type;
  const name = path.at(-1);
  if (['sessionAwareModel', 'networkInjectionEnabled', 'isSharedToAll', 'enabled', 'acceptRetryAfter', 'publishAllAssetEndpoints'].includes(name)) return 'bool';
  if (['capacity', 'timeout', 'priority', 'weight', 'aiserviceIndex', 'failureCount', 'min', 'max', 'bytes', 'maxSizeInBytes'].includes(name)) return 'int';
  if (['supportedModels', 'staticModels', 'models', 'weights', 'statusCodeRanges', 'headers', 'assetEndpoints'].includes(name)) return 'array';
  if (['authConfig', 'customHeaders', 'circuitBreaker', 'sessionAffinity', 'body', 'frontend', 'backend', 'request', 'response', 'largeLanguageModel', 'requests', 'responses'].includes(name)) return 'object';
  return 'string';
}

function unresolved(row, path, descriptor, inputs, definition, reason) {
  const key = `source:${exportPathKey(path)}`;
  const type = sourceType(path, descriptor);
  row.inputs.push({ key, label: path.join('.'), type, reason, source: true });
  if (Object.hasOwn(inputs, key)) {
    const value = inputs[key];
    if (!typeMatches(value, type)) {
      issue(row, 'input', `The explicit value for ${path.join('.')} must be a ${type}; no coercion is performed.`, path);
      return undefined;
    }
    if (exportSecret(value, String(path.at(-1)))) {
      issue(row, 'change', 'Secret material is not permitted in export-only inputs.', path);
      return undefined;
    }
    assertExportValue(value);
    const problems = path.length === 1 && definition?.known ? checkMigrationValue(value, definition) : [];
    if (problems.length) {
      for (const problem of problems) issue(row, 'input', problem, path);
      return undefined;
    }
    transform(row, `${path.join('.')} uses an explicit export-only value, not an evaluated expression.`);
    return value;
  }
  issue(row, 'input', reason, path);
  return undefined;
}

function readNode(node, text, path, row, descriptor, inputs, definition, policies) {
  const literal = literalBicep(text.slice(node.start, node.end));
  if (literal.status === 'literal') return literal.value;
  if (node.kind === 'call' && node.callee === 'loadTextContent' &&
      path.length === 3 && path[0] === 'services' && path[2] === 'policyXml') {
    const policy = policies[exportPathKey(path)];
    if (policy) {
      transform(row, `Source policy ${policy.path} is embedded literally, not emitted as file().`);
      return policy.text;
    }
    issue(row, 'input', 'The referenced source policy could not be read inside the permitted repository boundary.', path);
    return undefined;
  }
  if (node.kind === 'array') return node.items.map((item, index) => readNode(item, text, [...path, index], row, descriptor, inputs, definition, policies));
  if (node.kind === 'object') {
    const result = Object.create(null);
    const seen = new Set();
    for (const property of node.properties) {
      const key = property.key.toLowerCase();
      if (seen.has(key) || ['__proto__', 'prototype', 'constructor', '__expr'].includes(key) ||
          (property.quoted && literalBicep(text.slice(property.keyStart, property.keyEnd)).status !== 'literal')) {
        issue(row, 'change', 'Duplicate, computed or unsupported object keys cannot be mapped faithfully.', path);
        return undefined;
      }
      seen.add(key);
      result[property.key] = readNode(property.value, text, [...path, property.key], row, descriptor, inputs, definition, policies);
    }
    return result;
  }
  return unresolved(row, path, descriptor, inputs, definition, 'No static source value is available. Supply this export-only literal; environment fallbacks are not used.');
}

function hasUndefined(value) {
  return value === undefined || (Array.isArray(value) ? value.some(hasUndefined) :
    isObject(value) && Object.values(value).some(hasUndefined));
}

function inspectSource(area, source, choices) {
  const mapping = SOURCE_MAPPING[area];
  const parsed = readBicepParameters(source.text);
  const schema = readMigrationSchema(source.templateText);
  if (!schema.complete) throw new TerraformExportError('schema', 'The selected source template has no usable parameter schema.');
  const guidance = extractSchema(source.templateText);
  const assignments = new Map();
  const duplicates = new Set();
  for (const parameter of parsed.parameters) {
    if (assignments.has(parameter.name.toLowerCase())) duplicates.add(parameter.name.toLowerCase());
    assignments.set(parameter.name.toLowerCase(), parameter);
  }
  const definitions = new Map(schema.definitions.map((entry) => [entry.name, entry]));
  const names = [...new Set([...parsed.parameters.map((entry) => entry.name), ...schema.definitions.map((entry) => entry.name)])];
  const rows = [];
  const values = Object.create(null);
  for (const name of names) {
    const descriptor = mapping.find((entry) => entry.source === name);
    const assignment = assignments.get(name.toLowerCase());
    const definition = definitions.get(name);
    const row = {
      source: name, sources: [name], targets: descriptor?.target || [], service: descriptor?.service || 'Unmapped source',
      type: descriptor?.type || definition?.type || 'unknown', status: 'mapped', notes: [], inputs: [], nested: [],
      origin: assignment ? 'Saved source' : 'Source template default', sourceValue: undefined,
      evidence: descriptor?.evidence || `${area === 'deployment' ? '' : area === 'llm' ? 'llm-backend-onboarding/' : 'citadel-access-contracts/'}variables.tf; main.tf`,
    };
    rows.push(row);
    if (!descriptor) {
      issue(row, 'change', 'This source parameter is not in the versioned mapping. It is not silently dropped.');
      continue;
    }
    if (duplicates.has(name.toLowerCase()) || definition?.duplicate) {
      issue(row, 'change', 'Duplicate source declarations make this parameter ambiguous.');
      continue;
    }
    if (!definition?.known || definition.type !== descriptor.type) {
      issue(row, 'change', 'The source template type or constraints are missing, changed or unsupported by this mapping.');
      continue;
    }
    let value;
    if (assignment?.status === 'literal') value = assignment.value;
    else if (assignment) {
      const raw = source.text.slice(assignment.valueStart, assignment.valueEnd);
      const wrapper = `param value = ${raw}`;
      let tree = null;
      try {
        const candidate = parseBicepParam(wrapper);
        if (candidate.params.length === 1 && candidate.params[0].value.end === wrapper.length) tree = candidate.params[0].value;
      } catch (error) {
        if (!['ParseError', 'LexError'].includes(error.name)) throw error;
      }
      value = tree
        ? readNode(tree, wrapper, [name], row, descriptor, choices, definition, source.policies || {})
        : unresolved(row, [name], descriptor, choices, definition, 'This expression is not statically known. Supply an explicit export-only literal.');
    } else if (definition.default.status === 'literal') value = definition.default.value;
    else if (name === 'rotationKeySeed') value = undefined;
    else value = unresolved(row, [name], descriptor, choices, definition, definition.required
      ? 'A required source parameter is unassigned. Supply an explicit export-only value.'
      : 'The source template default is not a static literal. Supply an explicit export-only value.');
    row.sensitive = Boolean(guidance[name]?.secure) || descriptor.rule === 'secret' || exportSecret(value);
    values[name] = value;
    row.sourceValue = row.sensitive && !empty(value) ? '[Sensitive value withheld]' : value;
    if (!hasUndefined(value) && !row.sensitive) {
      assertExportValue(value);
      for (const problem of checkMigrationValue(value, definition)) issue(row, 'input', problem);
    }
  }
  if (!parsed.parameters.length) throw new TerraformExportError('empty', 'The selected parameter file contains no assigned parameters.');
  return { rows, values, definitions, parsed };
}

function literalInput(result, row, key, label, type, choices, reason, extra = {}) {
  const spec = { key, label, type, reason, ...extra };
  row.inputs.push(spec);
  if (!Object.hasOwn(choices, key)) {
    issue(row, 'input', reason);
    return undefined;
  }
  const value = choices[key];
  if (!typeMatches(value, type) || (extra.uuid && !uuid(value)) ||
      (extra.enum && !extra.enum.includes(value)) ||
      (extra.min !== undefined && value < extra.min) || (extra.max !== undefined && value > extra.max) ||
      (extra.required && empty(value)) || exportSecret(value, label)) {
    issue(row, 'input', `Enter a valid nonsecret ${label} (${type}).`);
    return undefined;
  }
  assertExportValue(value);
  return value;
}

function decision(row, choices, key, reason) {
  row.inputs.push({ key, label: 'Accept generated Terraform names', type: 'bool', confirmation: true, reason });
  if (choices[key] !== true) issue(row, 'input', reason);
  else transform(row, `Explicitly accepted: ${reason}`);
}

function checkObject(row, value, path, fields, required = []) {
  if (!isObject(value)) { issue(row, 'input', `${path.join('.')} must be an object.`, path); return false; }
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  for (const key of unknown) issue(row, 'change', `Unmapped nested property ${[...path, key].join('.')}; no property is silently discarded.`, [...path, key]);
  for (const key of required) if (!Object.hasOwn(value, key)) issue(row, 'input', `${[...path, key].join('.')} is required.`, [...path, key]);
  return true;
}

function nested(row, path, targets, value, status = 'mapped', reason = '') {
  row.nested.push({ path, targets, value, status, reason });
  if (status === 'change' || status === 'input') issue(row, status, reason, path, targets);
}

function renameObject(row, value, path, fields, root, required = [], types = {}) {
  if (!checkObject(row, value, path, Object.keys(fields), required)) return {};
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(fields, key)) continue;
    const target = `${root}.${fields[key]}`;
    if (types[key] && !typeMatches(item, types[key])) {
      nested(row, [...path, key], [target], undefined, 'input', `Requires a ${types[key]}, without coercion.`);
      continue;
    }
    output[fields[key]] = item;
    nested(row, [...path, key], [target], item, key === fields[key] ? 'mapped' : 'transformed');
  }
  transform(row, 'Properties are mapped explicitly; identities and case-sensitive payload keys are preserved.');
  return output;
}

function checkIdentity(row, value, path) {
  if (!identity(value)) issue(row, 'input', `${path.join('.')} needs a nonempty portable identity (letters, numbers, dots, underscores or hyphens).`, path);
}

function checkCoordinates(row, value, fields, root, split = false) {
  const output = renameObject(row, value, [row.source], fields, root, Object.keys(fields),
    Object.fromEntries(Object.keys(fields).map((key) => [key, 'string'])));
  if (!uuid(value?.subscriptionId)) issue(row, 'input', 'Supply the explicit subscription UUID; no lookup is performed.');
  for (const key of Object.keys(fields).filter((key) => key !== 'subscriptionId')) checkIdentity(row, value?.[key], [row.source, key]);
  if (split) {
    row.nested.forEach((entry) => { entry.targets = entry.targets.map((target) => target.replace(/^\./, '')); });
  }
  return output;
}

function checkList(row, value, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && !value.length)) {
    issue(row, 'input', `${row.source} must be ${nonempty ? 'a nonempty' : 'an'} array.`);
    return false;
  }
  return true;
}

function mapBackends(row, values) {
  const list = values.llmBackendConfig;
  if (!checkList(row, list, true)) return [];
  const ids = new Set();
  // Source llm-policy-fragments.bicep:199-205 reduces all backends, first exact
  // model name wins. Pinned llm-backend-onboarding/main.tf:247-272 instead reads
  // the first backend's matching-model list via [0][0], or its fixed defaults.
  const firstMetadata = new Map();
  const metadataProperties = ['apiVersion', 'timeout', 'inferenceApiVersion'];
  return list.map((backend, index) => {
    const path = [row.source, index];
    const root = `llm_backend_config[${index}]`;
    const fields = {
      backendId: 'backend_id', backendType: 'backend_type', endpoint: 'endpoint', authScheme: 'auth_scheme',
      authType: 'auth_type', authConfig: 'auth_config', supportedModels: 'supported_models', priority: 'priority', weight: 'weight',
    };
    if (!checkObject(row, backend, path, [...Object.keys(fields), 'circuitBreaker', 'sessionAffinity'], ['backendId', 'backendType', 'endpoint', 'supportedModels'])) return {};
    const output = {};
    for (const key of ['backendId', 'backendType', 'endpoint']) output[fields[key]] = backend[key];
    checkIdentity(row, backend.backendId, [...path, 'backendId']);
    if (ids.has(backend.backendId)) issue(row, 'change', 'Backend identities must be unique; Terraform uses them as resource keys.', path);
    ids.add(backend.backendId);
    if (!['ai-foundry', 'azure-openai', 'external'].includes(backend.backendType)) {
      issue(row, 'change', 'This backend/auth provider requires unsupported wiring or a secret workflow; it is not exported by this experiment.', [...path, 'backendType']);
    }
    try {
      const url = new URL(backend.endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new TypeError('url');
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      issue(row, 'input', 'Backend endpoint must be an explicit HTTPS URL without credentials, query or fragment.', [...path, 'endpoint']);
    }
    const auth = backend.authType ?? (backend.backendType === 'external' ? 'none' : 'managed-identity');
    if (!['managed-identity', 'api-key-bearer', 'api-key-header', 'none'].includes(auth)) {
      issue(row, 'change', 'The active authType is not supported by the pinned target consumer.', [...path, 'authType']);
    }
    const scheme = auth === 'managed-identity' ? 'managedIdentity' : auth === 'none' ? 'token' : 'apiKey';
    if (backend.authScheme !== undefined && typeof backend.authScheme !== 'string') issue(row, 'input', 'Legacy authScheme must be a string.', [...path, 'authScheme']);
    output.auth_scheme = scheme;
    output.auth_type = auth;
    transform(row, 'Bicep no longer consumes legacy authScheme. The exported auth_scheme follows effective authType because the target still checks it for native credentials.');
    if (backend.authConfig != null) {
      output.auth_config = renameObject(row, backend.authConfig, [...path, 'authConfig'],
        { namedValueKey: 'named_value_key', keyVaultSecretUri: 'key_vault_secret_uri', secretValue: 'secret_value' }, `${root}.auth_config`);
      if (backend.authConfig.secretValue) issue(row, 'change', 'Plaintext backend credentials are never exported.', [...path, 'authConfig', 'secretValue']);
    }
    if (auth.startsWith('api-key-') && !identity(backend.authConfig?.namedValueKey)) {
      issue(row, 'input', 'API-key authentication requires an explicit named-value reference, not a recovered secret.', [...path, 'authConfig', 'namedValueKey']);
    }
    output.priority = backend.priority ?? 1;
    output.weight = backend.weight ?? 100;
    if (!Number.isSafeInteger(output.priority) || output.priority < 1 || output.priority > 5 ||
        !Number.isSafeInteger(output.weight) || output.weight < 1 || output.weight > 1000) {
      issue(row, 'input', 'Backend priority must be 1-5 and weight 1-1000.', path);
    }
    if (backend.circuitBreaker != null && values.configureCircuitBreaker !== false) {
      issue(row, 'change', 'Per-backend circuit breaker overrides have no target input, including enabled overrides.', [...path, 'circuitBreaker']);
    }
    if (backend.sessionAffinity != null && values.configureSessionAffinity !== false) {
      issue(row, 'change', 'Per-backend session-affinity wiring is absent in the target.', [...path, 'sessionAffinity']);
    }
    const models = backend.supportedModels;
    if (!Array.isArray(models) || !models.length) {
      issue(row, 'input', 'Each backend must have a nonempty supportedModels array.', [...path, 'supportedModels']);
      output.supported_models = [];
    } else {
      const seen = new Set();
      output.supported_models = models.map((model, modelIndex) => {
        const modelPath = [...path, 'supportedModels', modelIndex];
        const target = `${root}.supported_models[${modelIndex}]`;
        if (!checkObject(row, model, modelPath, ['name', ...Object.keys(MODEL_DEFAULTS), 'sessionAwareModel'], ['name'])) return {};
        checkIdentity(row, model.name, [...modelPath, 'name']);
        if (seen.has(model.name)) issue(row, 'change', 'Duplicate model identity within this backend.', modelPath);
        seen.add(model.name);
        if (model.sessionAwareModel != null && typeof model.sessionAwareModel !== 'boolean') issue(row, 'input', 'sessionAwareModel must be Boolean.', modelPath);
        if (model.sessionAwareModel === true) {
          nested(row, [...modelPath, 'sessionAwareModel'], ['pool.sessionAffinity (not wired)'], undefined, 'change',
            'Active sessionAwareModel metadata and sticky routing cannot be preserved by the pinned target.');
        }
        const result = { name: model.name };
        for (const key of Object.keys(MODEL_DEFAULTS)) result[key] = model[key] ?? MODEL_DEFAULTS[key];
        const earlier = firstMetadata.get(model.name);
        if (!earlier && identity(model.name)) firstMetadata.set(model.name, { backendId: backend.backendId, index });
        for (const [key, value] of Object.entries(result)) {
          let status = 'mapped';
          let reason = '';
          if (metadataProperties.includes(key) && identity(model.name)) {
            if (earlier) {
              status = 'transformed';
              reason = `Runtime ${key} follows the first occurrence of model "${model.name}" in backend "${earlier.backendId}" [${earlier.index}]. ` +
                'This later occurrence does not replace its metadata. Any source/target metadata loss is reported on that first occurrence.';
            } else if (index > 0) {
              const fallback = MODEL_DEFAULTS[key];
              const matches = Object.is(value, fallback);
              status = matches ? 'transformed' : 'change';
              reason = `Model "${model.name}" first occurs in backend "${backend.backendId}" [${index}]. ` +
                `Bicep uses ${key} = ${JSON.stringify(value)}. Pinned Terraform metadata_models [0][0] only searches backend zero "${list[0]?.backendId}" for this exact-case name. ` +
                (matches
                  ? `Its fallback ${JSON.stringify(fallback)} agrees with the effective Bicep value.`
                  : `It falls back to ${JSON.stringify(fallback)}, so the target metadata lookup requires a Terraform change; emitting the supplied value cannot preserve this behavior.`);
            }
          }
          nested(row, [...modelPath, key], [`${target}.${key}`], value, status, reason);
        }
        if (!Number.isSafeInteger(result.capacity) || result.capacity < 1 || !Number.isSafeInteger(result.timeout) || result.timeout < 1) {
          issue(row, 'input', 'Model capacity and timeout must be positive integers.', modelPath);
        }
        return result;
      });
    }
    for (const [key, target] of Object.entries(fields).filter(([key]) => !['supportedModels', 'authConfig'].includes(key))) {
      nested(row, [...path, key], [`${root}.${target}`], output[target], key === target ? 'mapped' : 'transformed');
    }
    return output;
  });
}

function mapFoundries(row, value, values, choices) {
  if (!checkList(row, value, true)) return [];
  const names = new Set();
  return value.map((instance, index) => {
    const path = [row.source, index];
    const fields = { name: 'name', location: 'location', customSubDomainName: 'custom_subdomain', defaultProjectName: 'default_project_name', networkInjectionEnabled: 'network_injection_enabled' };
    const output = renameObject(row, instance, path, fields, `ai_foundry_instances[${index}]`, ['name', 'location']);
    if (!isObject(instance)) return output;
    if (instance.name === '') decision(row, choices, `generated:${exportPathKey([...path, 'name'])}`, 'An empty Foundry name uses a different Terraform generator; this is not the same resource identity.');
    else checkIdentity(row, instance.name, [...path, 'name']);
    if (instance.name && names.has(instance.name)) issue(row, 'change', 'Foundry account names must be unique.', path);
    names.add(instance.name);
    if (typeof instance.location !== 'string' || !instance.location) issue(row, 'input', 'Every Foundry location must be explicit.', path);
    output.custom_subdomain = instance.customSubDomainName ?? '';
    output.default_project_name = instance.defaultProjectName ?? 'citadel-governance-project';
    const globalInjection = values.foundryNetworkInjectionEnabled;
    output.network_injection_enabled = globalInjection === true && (instance.networkInjectionEnabled ?? true);
    if (globalInjection === true && instance.networkInjectionEnabled === false) issue(row, 'change',
      'The root accepts network_injection_enabled but the child Foundry type drops it and falls back to true. Per-instance opt-out requires a Terraform module change.', [...path, 'networkInjectionEnabled']);
    if (globalInjection === false) transform(row, 'Global network injection is false; the dropped per-instance field cannot activate it.');
    return output;
  });
}

function mapFoundryModels(row, value, values) {
  if (!checkList(row, value)) return [];
  const seen = new Set();
  return value.map((model, index) => {
    const path = [row.source, index];
    const fields = { name: 'name', publisher: 'publisher', version: 'version', sku: 'sku', capacity: 'capacity', aiserviceIndex: 'ai_service_index' };
    if (!checkObject(row, model, path, [...Object.keys(fields), 'retirementDate', 'apiVersion', 'timeout', 'inferenceApiVersion'], ['name', 'version'])) return {};
    const output = {};
    for (const [key, target] of Object.entries(fields)) if (Object.hasOwn(model, key)) {
      output[target] = model[key];
      nested(row, [...path, key], [`ai_foundry_models[${index}].${target}`], model[key], key === target ? 'mapped' : 'transformed');
    }
    checkIdentity(row, model.name, [...path, 'name']);
    if (!Number.isSafeInteger(model.aiserviceIndex) || model.aiserviceIndex < 0 ||
        !Array.isArray(values.aiFoundryInstances) || model.aiserviceIndex >= values.aiFoundryInstances.length) {
      issue(row, 'change', 'An explicit valid aiserviceIndex is required. Bicep omission means all Foundries; Terraform omission means index 0.', [...path, 'aiserviceIndex']);
    }
    const id = JSON.stringify([model.aiserviceIndex, model.name]);
    if (seen.has(id)) issue(row, 'change', 'Duplicate model deployment identity on the same Foundry.', path);
    seen.add(id);
    output.publisher ??= 'OpenAI'; output.sku ??= 'GlobalStandard'; output.capacity ??= 100;
    if (output.publisher !== 'OpenAI') issue(row, 'change', 'Root auto-backend metadata hard-codes modelFormat = OpenAI, losing this publisher.', [...path, 'publisher']);
    const fixed = { retirementDate: '', apiVersion: '2024-02-15-preview', timeout: 120, inferenceApiVersion: '' };
    for (const [key, defaultValue] of Object.entries(fixed)) {
      if (Object.hasOwn(model, key) && !sameLiteralValue(model[key], defaultValue)) {
        nested(row, [...path, key], [`auto_llm_backends.supported_models.${key} (fixed or omitted)`], undefined, 'change',
          `The target drops or hard-codes ${key}; this active metadata needs root/type wiring.`);
      } else if (Object.hasOwn(model, key)) nested(row, [...path, key], [`auto_llm_backends.supported_models.${key}`], defaultValue, 'transformed', 'Equal to fixed target behavior; not emitted as an unknown variable.');
    }
    return output;
  });
}

function policyProblems(row, xml, path) {
  if (typeof xml !== 'string' || !xml.trim()) { issue(row, 'input', 'A nonempty literal source policy is required; the target default has different allowed models.', path); return; }
  try { assertBalancedXml(xml); } catch { issue(row, 'input', 'Source policy XML is not balanced; correct the source and reload the review.', path); return; }
  const active = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(active) || !/<policies(?:\s|>)/.test(active)) {
    issue(row, 'change', 'Only an APIM policies document without external entities is supported.', path);
  }
  for (const match of active.matchAll(/<include-fragment\b[^>]*\bfragment-id\s*=\s*(["'])(.*?)\1/g)) {
    if (!POLICY_FRAGMENTS.includes(match[2])) issue(row, 'change', 'A required fragment is not in the pinned Terraform fragment contract; no runtime dependency is fetched or guessed.', path);
  }
  if (exportSecret(xml)) issue(row, 'change', 'Policy contains recognizable credential material and cannot be exported.', path);
}

function mapServices(row, value, values, source) {
  if (!checkList(row, value, true)) return [];
  const seen = new Set();
  return value.map((service, index) => {
    const path = [row.source, index];
    if (!checkObject(row, service, path,
      ['code', 'endpointSecretName', 'apiKeySecretName', 'policyXml', 'assetEndpoints', 'publishAllAssetEndpoints', 'foundryApiName'],
      ['code', 'endpointSecretName', 'apiKeySecretName'])) return {};
    checkIdentity(row, service.code, [...path, 'code']);
    if (seen.has(service.code)) issue(row, 'change', 'A contract cannot contain duplicate service codes.', path);
    seen.add(service.code);
    for (const key of ['endpointSecretName', 'apiKeySecretName']) checkIdentity(row, service[key], [...path, key]);
    for (const key of ['assetEndpoints', 'publishAllAssetEndpoints', 'foundryApiName']) {
      if (Object.hasOwn(service, key) && !empty(service[key]) && service[key] !== false) {
        issue(row, 'change', `${key} changes multi-asset endpoint behavior that the target cannot consume.`, [...path, key]);
      }
    }
    const apis = values.apiNameMapping?.[service.code];
    if (!Array.isArray(apis) || !apis.length || apis.some((api) => !identity(api))) issue(row, 'input', 'Each service code must select a nonempty list of valid API identities.', path);
    if (values.useTargetFoundry === true && Array.isArray(apis)) {
      const firstLlm = apis.findIndex((api) => ['universal-llm-api', 'azure-openai-api', 'unified-ai-api'].includes(api));
      if (firstLlm > 0) issue(row, 'change', 'Bicep selects the first known LLM API for Foundry; Terraform uses the first API. Reordering is not a faithful transform.', path);
    }
    let xml = service.policyXml;
    if (xml === undefined || xml === '') {
      const multi = ['TOOL', 'AGENT', 'MULTI'].includes(String(service.code).toUpperCase());
      xml = (multi ? source.defaultMultiPolicy : source.defaultPolicy)?.text;
      transform(row, 'The saved Bicep default policy is embedded literally; the different Terraform default is not substituted.');
    }
    policyProblems(row, xml, [...path, 'policyXml']);
    const output = { code: service.code, endpoint_secret_name: service.endpointSecretName, api_key_secret_name: service.apiKeySecretName, policy_xml: xml };
    for (const [key, target] of Object.entries({ code: 'code', endpointSecretName: 'endpoint_secret_name', apiKeySecretName: 'api_key_secret_name', policyXml: 'policy_xml' })) {
      nested(row, [...path, key], [`services[${index}].${target}`], output[target], key === target ? 'mapped' : 'transformed');
    }
    return output;
  });
}

function applyMapping(area, result, source, choices) {
  const { rows, values } = result;
  const output = result.output;
  const byName = new Map(rows.map((row) => [row.source, row]));
  for (const descriptor of SOURCE_MAPPING[area]) {
    const row = byName.get(descriptor.source);
    if (!row || row.status === 'change') continue;
    const value = values[descriptor.source];
    const sku = values.apimSku;
    const knownSku = ['Developer', 'Premium', 'StandardV2', 'PremiumV2'].includes(sku);
    const wrongGeneration = descriptor.apimGeneration && knownSku &&
      (descriptor.apimGeneration === 'v2') !== ['StandardV2', 'PremiumV2'].includes(sku);
    const existingNetwork = descriptor.newNetworkOnly && values.useExistingVnet === true;
    const inactiveGate = descriptor.gate && values[descriptor.gate[0]] !== undefined &&
      values[descriptor.gate[0]] !== descriptor.gate[1];
    const inactive = inactiveGate || wrongGeneration || existingNetwork;
    if (inactive) {
      row.status = 'transformed'; row.notes = []; row.inputs = [];
      transform(row, `Proven inactive: ${existingNetwork ? 'the VNet is reused, not created' :
        wrongGeneration ? `APIM SKU ${sku} does not consume this generation-specific setting` :
          `${descriptor.gate[0]} is ${JSON.stringify(values[descriptor.gate[0]])}`}. No value is emitted.`);
      row.inactive = true;
      continue;
    }
    if (descriptor.rule === 'rotation-seed' && values.keyRotationEnabled === false) {
      row.status = 'transformed'; row.notes = []; row.inputs = [];
      transform(row, 'Key rotation is disabled; its seed is never evaluated or exported.');
      continue;
    }
    if (descriptor.rule === 'secret') {
      row.inputs = [];
      if (value !== undefined && empty(value)) {
        row.status = 'transformed'; row.notes = [];
        transform(row, 'Empty sensitive setting; no secret is exported.');
      } else issue(row, 'change', 'Sensitive or unresolved secret input cannot be copied or recovered. Configure a supported credential-reference workflow outside this export.');
      continue;
    }
    if (row.sensitive) { row.inputs = []; issue(row, 'change', 'Recognizable credential material is withheld and blocks export.'); continue; }
    if (hasUndefined(value) || row.status === 'input') continue;
    if (!typeMatches(value, descriptor.type)) { issue(row, 'input', `Requires a literal ${descriptor.type}.`); continue; }
    if (descriptor.enum && !descriptor.enum.includes(value)) issue(row, 'input', 'The value is outside the mapped target enum.');
    if (descriptor.min !== undefined && value < descriptor.min) issue(row, 'input', `Requires a value of at least ${descriptor.min}.`);
    if (descriptor.shape === 'string-map' && Object.values(value).some((item) => typeof item !== 'string')) issue(row, 'input', 'Target requires a map of string values, with keys preserved.');
    if (descriptor.shape === 'api-map' && Object.values(value).some((item) => !Array.isArray(item) || item.some((name) => typeof name !== 'string'))) issue(row, 'input', 'Target requires a map of service codes to string arrays.');
    if (!descriptor.rule) {
      output[descriptor.target[0]] = value;
      if (descriptor.source === 'apimSkuUnits' && values.apimSku === 'Developer') {
        output.apim_sku_units = 1;
        transform(row, 'The Bicep APIM resource fixes Developer capacity to one, regardless of the source units setting. The emitted target value preserves that behavior.');
      }
      if (descriptor.naming && value === '') decision(row, choices, `generated:${descriptor.source}`, 'The empty source name permits Terraform-generated naming. Generated resources will not have the Bicep-generated identity.');
      if (descriptor.subnet && !value) issue(row, 'input', 'An empty source subnet name cannot be sent to the target. Supply an explicit saved-source name; no target default is substituted.');
      if (descriptor.source === 'enableAIGatewayPiiRedaction') transform(row, 'Maps to consumed enable_pii_anonymization, not the similarly named unused declaration.');
      continue;
    }
    switch (descriptor.rule) {
      case 'generated':
        if (value === '') decision(row, choices, `generated:${descriptor.source}`, 'This resource name is generated in Terraform. Accept its different naming only because the source override is empty.');
        else issue(row, 'change', 'The target resource exists, but its name is generated. A root/module name input must be wired to preserve this custom override.');
        break;
      case 'missing-nsg':
        issue(row, 'change', 'The target does not create this separate NSG/subnet association. New-network parity needs Terraform resource and input wiring, not an unused tfvars key.');
        break;
      case 'foundry-name':
        row.sources = ['aiFoundryResourceName', 'aiFoundryInstances'];
        if (Array.isArray(values.aiFoundryInstances) && values.aiFoundryInstances.every((entry) => isObject(entry) && typeof entry.name === 'string')) {
          transform(row, 'Resolved instance names are authoritative. The scalar is only a Bicep default-expression input; it never overwrites explicit instance identities.');
        } else issue(row, 'input', 'Resolve each actual Foundry instance name; the scalar does not identify which expression used it.');
        break;
      case 'workspace-id': {
        row.sources = ['existingLogAnalyticsSubscriptionId', 'existingLogAnalyticsRG', 'existingLogAnalyticsName'];
        const subscription = values.existingLogAnalyticsSubscriptionId || output.subscription_id;
        if (!uuid(subscription) || !identity(values.existingLogAnalyticsRG) || !identity(values.existingLogAnalyticsName)) {
          issue(row, 'input', 'A workspace resource ID needs an explicit subscription UUID, resource group and name. No cloud coordinates are guessed.');
        } else {
          output.existing_log_analytics_subscription_id = values.existingLogAnalyticsSubscriptionId;
          output.existing_log_analytics_id = `/subscriptions/${subscription}/resourceGroups/${values.existingLogAnalyticsRG}/providers/Microsoft.OperationalInsights/workspaces/${values.existingLogAnalyticsName}`;
          transform(row, 'Constructs one Azure workspace ID from all three explicit coordinates; an empty subscription uses the explicit export subscription.');
        }
        break;
      }
      case 'enabled-bool':
        output[descriptor.target[0]] = value === 'Enabled';
        transform(row, 'Enabled/Disabled maps explicitly to true/false.');
        break;
      case 'vault-network':
        output.kv_public_network_access_enabled = value === 'Enabled';
        if (value === 'Disabled') {
          output.network_acl_default_action = 'Deny';
          transform(row, 'Disabled maps to public access false plus Deny, with no bootstrap allowlist.');
        } else {
          output.network_acl_default_action = literalInput(result, row, 'target:network_acl_default_action', 'network_acl_default_action', 'string', choices,
            'Enabled does not decide Allow versus public-with-Deny. Choose the target ACL explicitly.', { enum: ['Allow', 'Deny'] });
        }
        break;
      case 'redis-toggle':
        output.enable_redis_cache = value; output.enable_embeddings_backend = value;
        transform(row, 'The one source flag controls both Redis and its embeddings backend; both targets are emitted.');
        break;
      case 'monitor-logs':
      case 'insights-logs':
        if (sameLiteralValue(value, descriptor.rule === 'monitor-logs' ? MONITOR_DEFAULTS : INSIGHTS_DEFAULTS)) {
          transform(row, 'Equal to the rich child-module default. Root logging objects are wrong-shaped/unconsumed, so no misleading root variable is emitted.');
        } else issue(row, 'change', 'Rich diagnostic types exist in child modules, but root types/wiring do not consume this value. Headers/body/LLM log differences require Terraform changes.');
        break;
      case 'logic-capacity':
        if (value === 1) transform(row, 'Matches the pinned target fixed minimum of one instance. Other baseline capacities require wiring; provider-wide scaling equivalence is not asserted.');
        else issue(row, 'change', 'The target fixes elastic_instance_minimum = 1. This source capacity requires target wiring and provider-semantic validation.');
        break;
      case 'redis-ha':
        issue(row, 'change', 'The target uses the Redis AzAPI resource but omits highAvailability. Active Redis requires that body property and root/module input wiring.');
        break;
      case 'search':
        output.ai_search_instances = value.map((entry, index) => {
          const path = [row.source, index];
          if (!checkObject(row, entry, path, ['name', 'url', 'description'], ['name', 'url'])) return {};
          if (Object.hasOwn(entry, 'description') && entry.description !== 'AI Search backend') issue(row, 'change', 'Target hard-codes "AI Search backend"; this description would be lost.', [...path, 'description']);
          return renameObject(row, Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'description')),
            path, { name: 'name', url: 'endpoint' }, `ai_search_instances[${index}]`, ['name', 'url']);
        });
        break;
      case 'foundries': output.ai_foundry_instances = mapFoundries(row, value, values, choices); break;
      case 'foundry-models': output.ai_foundry_models = mapFoundryModels(row, value, values); break;
      case 'embeddings': {
        const name = values.aiFoundryInstances?.[0]?.name;
        row.sources = ['aiFoundryInstances', 'primaryFoundryEmbeddingModelName', 'enableManagedRedis'];
        if (identity(name) && identity(value)) {
          output.embeddings_backend_url = `https://${name}.cognitiveservices.azure.com/openai/deployments/${value}/embeddings`;
          transform(row, 'URL uses the explicit primary Foundry resource name and embedding model, not a display label.');
        } else output.embeddings_backend_url = literalInput(result, row, 'target:embeddings_backend_url', 'embeddings_backend_url', 'string', choices,
          'The primary resource name is unresolved. Supply the exact embeddings backend URL explicitly.', { required: true });
        break;
      }
      case 'injection':
        output.foundry_network_injection_enabled = value; output.enable_agent_subnet = value;
        transform(row, 'The source global injection flag controls both target injection and creation of the agent subnet.');
        break;
      case 'llm-apim':
        Object.assign(output, checkCoordinates(row, value, { subscriptionId: 'subscription_id', resourceGroupName: 'resource_group_name', name: 'apim_name' }, '', true));
        break;
      case 'client-id':
        checkCoordinates(row, value, COORDINATE_FIELDS, 'source identity');
        output.managed_identity_client_id = literalInput(result, row, 'target:managed_identity_client_id', 'managed_identity_client_id', 'string', choices,
          'Resource coordinates do not determine a client ID. Enter the explicit managed-identity client UUID.', { uuid: true, required: true });
        break;
      case 'backends': output.llm_backend_config = mapBackends(row, values); break;
      case 'breaker':
        if (values.configureCircuitBreaker === false) transform(row, 'Circuit breakers are disabled; these defaults are inactive.');
        else if (checkObject(row, value, [row.source], Object.keys(BREAKER_DEFAULTS)) && sameLiteralValue({ ...BREAKER_DEFAULTS, ...value }, BREAKER_DEFAULTS)) {
          transform(row, 'Equal to target hard-coded 3 failures / PT5M / PT1M / Retry-After / 429 and 500-503. No defaults variable is needed.');
        } else issue(row, 'change', 'The target hard-codes breaker defaults. This customization requires a defaults variable and body wiring.');
        break;
      case 'affinity': {
        const backends = values.llmBackendConfig;
        if (Array.isArray(backends) && backends.every((backend) => Array.isArray(backend?.supportedModels) &&
            backend.supportedModels.every((model) => model?.sessionAwareModel !== true) && backend.sessionAffinity == null)) {
          transform(row, 'No session-aware model or per-backend affinity is active. The global toggle/defaults have no pool behavior to export.');
        } else if (values.configureSessionAffinity === false) transform(row, 'Global session affinity is disabled; defaults are inactive. Model metadata is checked separately.');
        else issue(row, 'change', 'Active sticky routing requires APIM pool.sessionAffinity wiring in the Terraform root.');
        break;
      }
      case 'aliases':
        output.model_aliases = value.map((alias, index) => {
          const path = [row.source, index];
          if (!checkObject(row, alias, path, ['name', 'models', 'strategy', 'weights'], ['name', 'models'])) return {};
          const result = { name: alias.name, models: alias.models, strategy: alias.strategy ?? 'priority', weights: alias.weights ?? [] };
          checkIdentity(row, result.name, [...path, 'name']);
          const models = new Set((Array.isArray(values.llmBackendConfig) ? values.llmBackendConfig : [])
            .flatMap((backend) => (Array.isArray(backend?.supportedModels) ? backend.supportedModels : []).map((model) => model?.name)));
          if (!Array.isArray(result.models) || !result.models.length || result.models.some((name) => !models.has(name))) issue(row, 'input', 'Aliases must reference models in the selected backend configuration.', path);
          if (!['priority', 'weighted'].includes(result.strategy) ||
              (result.strategy === 'weighted' && (!Array.isArray(result.weights) || result.weights.length !== result.models?.length ||
                result.weights.some((weight) => !Number.isSafeInteger(weight) || weight <= 0)))) issue(row, 'input', 'Alias strategy/weights do not match the selected models.', path);
          return result;
        });
        break;
      case 'anthropic':
        if (Array.isArray(values.llmBackendConfig) && !values.llmBackendConfig.some((entry) => String(entry.backendType).includes('anthropic'))) transform(row, 'No Anthropic backend is active; the source header version is unused.');
        else issue(row, 'change', 'The active Anthropic header version has no target wiring.');
        break;
      case 'llm-vault':
        if (value === '') transform(row, 'No source Key Vault override. Target key_vault_name is declared but unused.');
        else issue(row, 'change', 'The target key_vault_name is unconsumed; this source credential-storage setting cannot be preserved.');
        break;
      case 'coordinates': output[descriptor.target[0]] = checkCoordinates(row, value, COORDINATE_FIELDS, descriptor.target[0]); break;
      case 'foundry-coordinates': output.foundry = checkCoordinates(row, value, FOUNDRY_COORDINATES, 'foundry'); break;
      case 'use-case':
        output.use_case = renameObject(row, value, [row.source], USE_CASE_FIELDS, 'use_case', Object.keys(USE_CASE_FIELDS));
        for (const name of Object.keys(USE_CASE_FIELDS)) checkIdentity(row, value[name], [row.source, name]);
        break;
      case 'services': output.services = mapServices(row, value, values, source); break;
      case 'foundry-config':
        output.foundry_config = renameObject(row, value, [row.source], FOUNDRY_CONFIG_FIELDS, 'foundry_config');
        output.foundry_config.connection_category ??= 'ApiManagement';
        if (!['ApiManagement', 'ModelGateway'].includes(output.foundry_config.connection_category) ||
            (value.deploymentInPath !== undefined && !['true', 'false'].includes(value.deploymentInPath)) ||
            (value.deploymentProvider !== undefined && !['', 'AzureOpenAI', 'OpenAI'].includes(value.deploymentProvider))) issue(row, 'input', 'Foundry category, string deploymentInPath or provider is outside the target enums.');
        break;
      case 'empty-only':
        if (empty(value)) transform(row, 'Empty source extension: the single-gateway target preserves the active behavior.');
        else issue(row, 'change', 'The active resiliency/global-gateway extension has no target input or resource iteration.');
        break;
      case 'primary-key':
        if (value === true) transform(row, 'Matches target primary-key selection; no key value is read or exported.');
        else issue(row, 'change', 'The target always consumes primary_key. Secondary selection requires target/provider wiring.');
        break;
      case 'rotation':
        if (value === false) transform(row, 'Rotation is disabled in both implementations.');
        else issue(row, 'change', 'The target has no subscription-key rotation action.');
        break;
      case 'rotation-seed': issue(row, 'change', 'Active rotation has no target implementation; seeds are not evaluated.'); break;
      default: issue(row, 'change', 'Mapping implementation is unavailable.');
    }
  }
}

/** Pure, versioned projection. Blockers never produce a partial file. */
export function projectTerraformExport(area, source, choices = {}) {
  if (!EXPORT_AREAS.some((entry) => entry.id === area)) throw new TerraformExportError('area', 'Choose a supported export area.');
  assertExportValue(choices);
  const result = inspectSource(area, source, choices);
  result.area = area; result.output = {}; result.extras = []; result.contract = TERRAFORM_CONTRACT;
  if (area === 'deployment') {
    for (const spec of MAIN_INPUTS) {
      const row = { source: spec.name, sources: [], targets: [spec.name], service: spec.service, status: 'mapped', notes: [], inputs: [], type: spec.type, origin: 'Export only' };
      result.extras.push(row);
      if (spec.omit) { transform(row, spec.reason); continue; }
      const key = `target:${spec.name}`;
      if (spec.fixed) {
        row.inputs.push({ ...spec, key, label: spec.name, acceptDefault: true });
        if (!Object.hasOwn(choices, key)) issue(row, 'input', `Review and accept: ${spec.reason}`);
        else if (!sameLiteralValue(choices[key], spec.default)) issue(row, 'change', 'This experiment supports only the displayed target-only default; active extensions are not silently substituted.');
        else { result.output[spec.name] = choices[key]; transform(row, spec.reason); }
      } else {
        const value = literalInput(result, row, key, spec.name, spec.type, choices, spec.reason, { ...spec, acceptDefault: !spec.required });
        if (value !== undefined) result.output[spec.name] = value;
      }
    }
  }
  applyMapping(area, result, source, choices);
  const required = area === 'deployment' ? ['environment_name', 'location', 'ai_foundry_instances', 'ai_foundry_models', 'subscription_id'] :
    area === 'llm' ? ['subscription_id', 'resource_group_name', 'apim_name', 'managed_identity_client_id', 'llm_backend_config'] :
      ['apim', 'use_case', 'api_name_mapping', 'services'];
  for (const name of required) if (!Object.hasOwn(result.output, name) &&
      !result.rows.some((row) => row.targets.includes(name) && rank[row.status] >= 2)) {
    result.extras.push({ source: name, sources: [], targets: [name], service: 'Required target', status: 'input', notes: [{ status: 'input', reason: 'The required target has no mapped source value. Add the corresponding source parameter and reload.' }], inputs: [], type: 'unknown' });
  }
  if (area === 'deployment' && typeof result.output.environment_name === 'string') {
    try { exportEnvironmentName(result.output.environment_name); } catch (error) {
      if (!(error instanceof TerraformExportError)) throw error;
      const row = result.rows.find((entry) => entry.source === 'environmentName');
      issue(row, 'input', error.message);
    }
  }
  if (area === 'deployment' && result.output.use_existing_resource_group === true && !result.output.resource_group_name) {
    issue(result.extras.find((row) => row.source === 'use_existing_resource_group'), 'input', 'Existing resource-group mode requires an explicit source resourceGroupName.');
  }
  const allRows = [...result.rows, ...result.extras];
  result.path = targetPath(area, result.output.environment_name);
  for (const row of allRows) {
    row.outputPath = result.path;
    row.proposed = Object.fromEntries(row.targets.filter((name) => Object.hasOwn(result.output, name)).map((name) => [name, result.output[name]]));
  }
  for (const [name, value] of Object.entries(result.output)) {
    for (const problem of targetVariablesProblems(area, { [name]: value })) {
      const row = allRows.find((entry) => entry.targets.includes(name));
      if (row) issue(row, 'input', problem);
      else throw new TerraformExportError('target-shape', problem);
    }
  }
  result.blockers = allRows.filter((row) => rank[row.status] >= 2);
  result.unusedTargets = area === 'deployment' ? MAIN_UNUSED : area === 'llm' ? ['key_vault_name'] : [];
  if (!result.blockers.length) {
    result.text = terraformVariables(result.output);
  } else result.text = null;
  result.document = exportDocument(source, result);
  delete result.values; delete result.definitions; delete result.parsed;
  return result;
}

function exportDocument(source, result) {
  let document;
  try { document = documentFromText(source.path, source.text); } catch (error) {
    if (!['ParseError', 'LexError'].includes(error.name)) throw error;
    // Strict readBicepParameters already established complete declarations.
    // Unsupported expressions still receive visible rows, never fallback values.
    document = documentFromText(source.path, result.rows.map((row) => `param ${row.source} = ''`).join('\n'));
  }
  document.schema = { parameters: Object.fromEntries(result.rows.map((row) => [row.source, { name: row.source, type: row.type, secure: row.sensitive }])) };
  const sanitize = (value) => {
    if (value === undefined) return '[Unresolved expression]';
    if (Array.isArray(value)) return value.map(sanitize);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    return value;
  };
  const assigned = new Set(document.params.map((entry) => entry.name));
  for (const row of result.rows) {
    let param = document.params.find((entry) => entry.name === row.source);
    if (!param) { param = { name: row.source, kind: row.type, raw: '' }; document.params.push(param); }
    param.value = sanitize(row.sourceValue);
    if (row.sensitive) param.previewStatus = 'sensitive';
    else if (row.sourceValue === undefined) param.previewStatus = 'not-evaluated';
    else param.previewStatus = 'literal';
    param.raw = '';
    if (!assigned.has(row.source)) param.doc = null;
  }
  delete document.subscription;
  // Raw source, AST and template guidance never leave this sanitized projection.
  delete document.text; delete document.parsed;
  return document;
}

export function acceptedTerraformDefaults() {
  return Object.fromEntries(MAIN_INPUTS.filter((entry) => !entry.required && !entry.omit).map((entry) => [`target:${entry.name}`, structuredClone(entry.default)]));
}
