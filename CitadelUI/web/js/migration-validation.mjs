import { validateDocument, VALIDATION_INPUTS } from './validation.mjs';
import {
  BACKEND_TYPES, BACKEND_FIELDS, MODEL_FIELDS, CIRCUIT_BREAKER_FIELDS, SESSION_AFFINITY_FIELDS, validateBackends,
  authTypeInfo, backendType,
} from './llmschema.mjs';

function fieldProblems(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} requires an object.`];
  const problems = [];
  for (const field of fields) {
    if (!Object.hasOwn(value, field.key)) {
      if (field.required) problems.push(`${label}: ${field.key} is required by the current field definition.`);
      continue;
    }
    const entry = value[field.key];
    const validType = field.type === 'number' ? Number.isSafeInteger(entry)
      : field.type === 'boolean' ? typeof entry === 'boolean' : typeof entry === 'string';
    const validEnum = field.type !== 'enum' || (field.options
      ? field.options.includes(entry)
      : field.enumSource === 'backendTypes' ? Boolean(backendType(entry))
        : field.enumSource === 'authTypes' && Boolean(authTypeInfo(entry)));
    if (!validType || !validEnum || (field.required && entry === '') ||
        (field.type === 'number' && (entry < (field.min ?? -Infinity) || entry > (field.max ?? Infinity))) ||
        (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(entry))) {
      problems.push(`${label}: ${field.key} does not satisfy the current ${field.type} field constraints.`);
    }
  }
  return problems;
}

export const llmMigrationPolicy = Object.freeze({
  backendTypes: BACKEND_TYPES,
  modelFields: MODEL_FIELDS,
  validateField(key, value, provider) {
    const field = MODEL_FIELDS.find((entry) => entry.key === key &&
      (!entry.appliesTo || entry.appliesTo.includes(provider)));
    return field ? fieldProblems({ [key]: value }, [field], field.label)
      : ['This field is not supported by the new backend provider.'];
  },
});

/** Intrinsic, current nested field checks; never a legacy shape translator. */
export function validateMigrationCandidate(name, value) {
  const key = name.toLowerCase();
  if (key === 'circuitbreakerdefaults') return fieldProblems(value, CIRCUIT_BREAKER_FIELDS, 'Circuit breaker defaults');
  if (key === 'sessionaffinitydefaults') return fieldProblems(value, SESSION_AFFINITY_FIELDS, 'Session affinity defaults');
  if (key !== 'llmbackendconfig') return [];
  if (!Array.isArray(value)) return ['LLM backends require an array.'];
  const problems = [];
  for (const [index, backend] of value.entries()) {
    const label = `LLM backend ${index + 1}`;
    const fields = fieldProblems(backend, BACKEND_FIELDS, label);
    problems.push(...fields);
    if (!backend || typeof backend !== 'object' || Array.isArray(backend)) continue;
    if (!Array.isArray(backend.supportedModels)) problems.push(`${label}: supportedModels requires an array.`);
    else {
      const names = new Set();
      backend.supportedModels.forEach((model, modelIndex) => {
        problems.push(...fieldProblems(model, MODEL_FIELDS, `${label}, model ${modelIndex + 1}`));
        if (typeof model?.name === 'string') {
          if (names.has(model.name)) problems.push(`${label}: duplicate model identity within the backend.`);
          names.add(model.name);
        }
      });
    }
    if (Object.hasOwn(backend, 'circuitBreaker')) problems.push(...fieldProblems(backend.circuitBreaker, CIRCUIT_BREAKER_FIELDS, `${label}, circuit breaker`));
    if (Object.hasOwn(backend, 'sessionAffinity')) problems.push(...fieldProblems(backend.sessionAffinity, SESSION_AFFINITY_FIELDS, `${label}, session affinity`));
  }
  if (!problems.length && validateBackends(value).some((finding) => finding.level === 'error')) {
    problems.push('Current LLM provider/authentication/model constraints are not satisfied. Review the current onboarding guidance.');
  }
  return problems;
}

/**
 * Reuse current Citadel constraints, but only on proven, non-sensitive literals.
 * No donor expression objects reach editableValue/parameterMap. The existing
 * validators sometimes quote input; migration publishes fixed diagnostics.
 */
export function validateMigrationFeatures(literals, plan = null) {
  const names = new Map(literals.map((entry) => [entry.name.toLowerCase(), entry.name]));
  const literalsByName = new Map(literals.map((entry) => [entry.name.toLowerCase(), entry.value]));
  const values = {
    get: (name) => literalsByName.get(name.toLowerCase()),
    has: (name) => literalsByName.has(name.toLowerCase()),
  };
  const findings = [];
  const declared = new Set([
    ...(plan?.rows || []).filter((row) => !row.removed).map((row) => row.name.toLowerCase()),
    ...(plan?.schema.definitions || []).map((definition) => definition.name.toLowerCase()),
    ...names.keys(),
  ]);
  const unavailable = (rule, active, required = []) => {
    const dependencies = VALIDATION_INPUTS[rule];
    if (!active || !dependencies.some((name) => declared.has(name.toLowerCase()))) return;
    const missing = dependencies.filter((name) =>
      (declared.has(name.toLowerCase()) || required.includes(name)) && !values.has(name));
    if (missing.length) findings.push({
      name: names.get(dependencies[0].toLowerCase()) || dependencies[0],
      code: 'feature-unresolved', rule, severity: 'error', dependencies,
      message: `Validating a change to ${dependencies.join(', ')} requires readable ${missing.join(', ')}. Keep the dependent change, or configure these values explicitly in the target outside migration and replan. Retained expressions are not evaluated.`,
    });
  };
  try {
    const models = literalsByName.get('aifoundrymodelsconfig');
    const indexedModels = Array.isArray(models)
      ? models.filter((model) => model && Object.hasOwn(model, 'aiserviceIndex')) : [];
    const unknownInstances = indexedModels.length > 0 && !literalsByName.has('aifoundryinstances');
    const invalidIndex = indexedModels.some((model) => !Number.isSafeInteger(model.aiserviceIndex) || model.aiserviceIndex < 0);
    unavailable('apimCapacity', true, ['apimSku', 'apimSkuUnits']);
    unavailable('apiCenter', values.get('enableAPICenter') !== false &&
      (declared.has('enableapicenter') || declared.has('apiclocation')), ['enableAPICenter', 'apicLocation', 'location']);
    unavailable('network', values.get('useExistingVnet') !== true &&
      VALIDATION_INPUTS.network.slice(0, 7).some((name) => declared.has(name.toLowerCase())), ['vnetAddressPrefix']);
    unavailable('modelServices', indexedModels.length > 0 ||
      declared.has('aifoundrymodelsconfig') && !values.has('aiFoundryModelsConfig'), ['aiFoundryInstances']);
    unavailable('targetFoundry', values.get('useTargetFoundry') !== false && declared.has('usetargetfoundry'));
    unavailable('targetKeyVault', values.get('useTargetAzureKeyVault') !== false && declared.has('usetargetazurekeyvault'));
    unavailable('additionalFoundries', declared.has('additionalfoundries') &&
      (!values.has('additionalFoundries') || values.get('additionalFoundries')?.length > 0));
    if (unknownInstances) {
      findings.push({
        name: names.get('aifoundrymodelsconfig'), code: 'feature-unresolved', severity: 'error',
        dependencies: VALIDATION_INPUTS.modelServices,
        message: 'Model-to-service index validation requires a literal aiFoundryInstances value. Its unavailable/dynamic value is not treated as an empty list; configure or review that dependency outside migration.',
      });
    }
    for (const [flag, dependency] of [
      ['useTargetFoundry', 'foundry'], ['useTargetAzureKeyVault', 'keyVault'],
    ]) {
      if (values.get(flag) === true && !values.has(dependency)) {
        findings.push({
          name: names.get(flag.toLowerCase()), code: 'feature-unresolved', severity: 'error',
          dependencies: [flag, dependency],
          message: `The enabled current feature requires literal ${dependency} coordinates. Withheld or dynamic coordinates cannot be validated or treated as configured.`,
        });
      }
    }
    for (const literal of literals) {
      for (const message of validateMigrationCandidate(literal.name, literal.value)) {
        findings.push({ name: literal.name, code: 'feature-constraint', severity: 'error', dependencies: [literal.name], message });
      }
    }
    for (const finding of validateDocument({}, { values })) {
      // The normal editor can evaluate current environment fallbacks. Migration
      // cannot: the real public-main sample exposes this dependency as dynamic.
      // Do not manufacture an out-of-range error from a missing literal map.
      if (finding.param.toLowerCase() === 'aifoundrymodelsconfig' && unknownInstances && !invalidIndex) continue;
      const name = names.get(finding.param.toLowerCase());
      if (!name) continue;
      findings.push({
        name, code: 'feature-constraint', severity: finding.severity,
        dependencies: finding.dependencies,
        message: 'Current Citadel feature constraints need attention. Inspect this field and its dependencies in the current editor/template.',
      });
    }
    const backends = literals.find((entry) => entry.name.toLowerCase() === 'llmbackendconfig');
    if (backends) {
      if (!Array.isArray(backends.value) || backends.value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
        findings.push({ name: backends.name, code: 'feature-constraint', severity: 'error', message: 'Each LLM backend must be an object with the current backend/provider/model fields.' });
      } else {
        for (const finding of validateBackends(backends.value)) {
          findings.push({
            name: backends.name, code: 'feature-constraint', severity: finding.level === 'error' ? 'error' : 'warning',
            message: 'Current LLM onboarding constraints need review (provider, authentication, models, priority, or weight). No legacy auth/model translation is inferred.',
          });
        }
      }
    }
  } catch {
    findings.push({ name: null, code: 'feature-constraint', severity: 'error', message: 'The current feature validators cannot validate this configuration. Review its structure outside migration.' });
  }
  return findings.filter((finding, index, all) =>
    all.findIndex((other) => JSON.stringify(other) === JSON.stringify(finding)) === index
  );
}
