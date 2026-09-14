import { MigrationError, safeLabel, sensitiveValue, sameLiteralValue as same } from './migration-input.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identityFields = new Set(['name', 'modelPath']);
const fail = () => { throw new MigrationError('decision'); };

function counts(values, key) {
  const result = new Map();
  for (const value of values) {
    const name = value?.[key];
    if (typeof name === 'string' && name) result.set(name, (result.get(name) || 0) + 1);
  }
  return result;
}

function backends(values, prefix, policy, source = null) {
  const ids = counts(values, 'backendId');
  return values.map((value, index) => {
    const type = object(value) ? policy.backendTypes.find((entry) => entry.id === value.backendType) : null;
    const id = value?.backendId;
    const issue = !object(value) ? 'Backend is not an object.'
      : typeof id !== 'string' || !id ? 'Backend ID is missing.'
        : ids.get(id) !== 1 ? 'Duplicate backend ID.'
          : !type ? 'Unknown backend provider.'
            : !Array.isArray(value.supportedModels) ? 'Models are not a literal array.' : null;
    const models = Array.isArray(value?.supportedModels) ? value.supportedModels : [];
    const names = counts(models, 'name');
    const key = `${prefix}:backend-${index}`;
    return {
      key, index, value, type, source, issue,
      models: models.map((model, modelIndex) => ({
        key: `${key}:model-${modelIndex}`, index: modelIndex, value: model,
        issue: !object(model) || typeof model.name !== 'string' || !model.name
          ? 'Model identity is missing.'
          : names.get(model.name) !== 1 ? 'Duplicate model identity within this backend.'
            : type?.requiresModelPath && (typeof model.modelPath !== 'string' || !model.modelPath)
              ? 'The provider routing identity (modelPath) is missing.' : null,
      })),
    };
  });
}

/** Private, bounded literals only. No catalogue, pool name, prefix or position matching. */
export function buildLlmValueReview({ current, candidates, definition, policy }) {
  const issue = !policy ? 'Current model review policy is unavailable.'
    : !definition?.known || definition.type !== 'array' || definition.secure ? 'The current LLM schema is unresolved or sensitive.'
      : current?.status !== 'literal' || !Array.isArray(current.value) ? 'The new backend array contains unresolved or unsupported expressions.'
        : sensitiveValue(current.value, 'llmBackendConfig') ? 'The new backend structure is withheld because it contains sensitive material.' : null;
  const review = {
    available: !issue, issue, policy, current: issue ? null : structuredClone(current.value),
    targets: [], sources: [], sourceIssues: [], pairs: new Map(), choices: new Map(), keepRest: false,
  };
  if (issue) return review;
  review.targets = backends(review.current, 'new', policy);
  for (const [index, candidate] of candidates.entries()) {
    const source = { ...candidate.source, parameter: candidate.name, candidateId: candidate.id };
    if (candidate.status !== 'literal' || candidate.schemaUnknown || candidate.sensitive ||
        !Array.isArray(candidate.value) || sensitiveValue(candidate.value, 'llmBackendConfig')) {
      review.sourceIssues.push({
        file: safeLabel(source.file), parameter: safeLabel(source.parameter),
        message: 'This old backend array is sensitive, unresolved, or unsupported; its values are not imported.',
      });
      continue;
    }
    review.sources.push(...backends(structuredClone(candidate.value), `old-${index}`, policy, source));
  }
  return review;
}

function targetBackend(review, key) {
  const backend = review.targets.find((entry) => entry.key === key);
  if (!review.available || !backend) fail();
  return backend;
}

function matchedModel(review, backend, model) {
  const source = review.sources.find((entry) => entry.key === review.pairs.get(backend.key));
  if (!source) return { source: null, model: null, issue: 'Confirm an old backend before comparing models.' };
  if (backend.issue || source.issue) return { source, model: null, issue: backend.issue || source.issue };
  if (model.issue) return { source, model: null, issue: model.issue };
  const matches = source.models.filter((entry) => entry.value?.name === model.value.name);
  if (!matches.length) return { source, model: null, issue: 'No exact model identity in the matched old backend. The new model stays unchanged.' };
  if (matches.length !== 1 || matches[0].issue) {
    return { source, model: null, issue: 'The old model identity is ambiguous or unsupported.' };
  }
  if (backend.type.requiresModelPath && matches[0].value.modelPath !== model.value.modelPath) {
    return { source, model: null, issue: 'Provider routing identity (modelPath) differs. No model values are imported.' };
  }
  return { source, model: matches[0], issue: null };
}

function fieldKey(backend, model, field) {
  return `${backend.key}/${model.key}/${field}`;
}

function comparableFields(review, backend, model, match) {
  if (!match.model) return [];
  return review.policy.modelFields
    .filter((field) => !identityFields.has(field.key) &&
      (!field.appliesTo || field.appliesTo.includes(backend.value.backendType)) &&
      (Object.hasOwn(model.value, field.key) || Object.hasOwn(match.model.value, field.key)))
    .map((field) => {
      const present = Object.hasOwn(match.model.value, field.key);
      const problems = present ? review.policy.validateField(field.key, match.model.value[field.key], backend.value.backendType) : [];
      const eligible = present && !sensitiveValue(match.model.value[field.key], field.key) && !problems.length;
      return { field, present, problems, eligible };
    });
}

export function decideLlmValue(review, decision) {
  if (!review.available || !decision || typeof decision !== 'object') fail();
  const backend = targetBackend(review, decision.backendKey);
  if (decision.kind === 'pair') {
    const source = review.sources.find((entry) => entry.key === decision.sourceKey);
    if (decision.confirmed !== true || !source || backend.issue || source.issue ||
        backend.value.backendType !== source.value.backendType) fail();
    if (review.pairs.get(backend.key) === source.key) return;
    review.pairs.set(backend.key, source.key);
    for (const key of review.choices.keys()) if (key.startsWith(`${backend.key}/`)) review.choices.delete(key);
    review.keepRest = false;
    return;
  }
  if (decision.kind === 'clear-pair') {
    review.pairs.delete(backend.key);
    for (const key of review.choices.keys()) if (key.startsWith(`${backend.key}/`)) review.choices.delete(key);
    review.keepRest = false;
    return;
  }
  const model = backend.models.find((entry) => entry.key === decision.modelKey);
  if (!model) fail();
  if (!review.policy.modelFields.some((field) => field.key === decision.field && !identityFields.has(field.key) &&
      (!field.appliesTo || field.appliesTo.includes(backend.value.backendType)))) fail();
  const key = fieldKey(backend, model, decision.field);
  if (decision.kind === 'keep') {
    review.choices.delete(key);
    return;
  }
  const match = matchedModel(review, backend, model);
  const field = comparableFields(review, backend, model, match).find((entry) => entry.field.key === decision.field);
  if (decision.kind !== 'source' || decision.reviewed !== true || !field?.eligible) fail();
  review.choices.set(key, {
    backendKey: backend.key, modelKey: model.key, field: field.field.key,
    sourceKey: match.source.key, sourceModelKey: match.model.key,
  });
}

export function keepLlmValues(review, clear = false) {
  review.keepRest = true;
  if (clear) review.choices.clear();
}

export function evaluateLlmValues(review, parameter) {
  if (!review.available) return { value: null, operations: [], changes: [], selected: 0, alreadyCurrent: 0 };
  const value = structuredClone(review.current);
  const operations = [];
  const changes = [];
  let alreadyCurrent = 0;
  for (const choice of review.choices.values()) {
    const backend = targetBackend(review, choice.backendKey);
    const model = backend.models.find((entry) => entry.key === choice.modelKey);
    if (!model) fail();
    const match = matchedModel(review, backend, model);
    const field = comparableFields(review, backend, model, match).find((entry) => entry.field.key === choice.field);
    if (!field?.eligible || match.source.key !== choice.sourceKey || match.model.key !== choice.sourceModelKey) fail();
    const next = match.model.value[choice.field];
    const present = Object.hasOwn(model.value, choice.field);
    value[backend.index].supportedModels[model.index][choice.field] = structuredClone(next);
    if (present && same(model.value[choice.field], next)) { alreadyCurrent += 1; continue; }
    const path = [parameter, backend.index, 'supportedModels', model.index];
    operations.push(present
      ? { op: 'set', path: [...path, choice.field], value: next }
      : { op: 'addProperty', path, key: choice.field, value: next });
    changes.push({
      path: [...path, choice.field],
      backendKey: backend.key, modelKey: model.key,
      backendId: safeLabel(backend.value.backendId), model: safeLabel(model.value.name), field: choice.field, label: field.field.label,
      before: present ? JSON.stringify(model.value[choice.field]) : '[not supplied]',
      after: JSON.stringify(next),
      source: { file: safeLabel(match.source.source.file), backendId: safeLabel(match.source.value.backendId), model: safeLabel(match.model.value.name) },
    });
  }
  return { value, operations, changes, selected: review.choices.size, alreadyCurrent };
}

export function llmValueReviewView(review) {
  if (!review.available) return { kind: 'llm-models', available: false, issue: review.issue, backends: [], sourceIssues: [] };
  const evaluated = evaluateLlmValues(review, 'llmBackendConfig');
  const usedSources = new Set(review.pairs.values());
  const backendsView = review.targets.map((backend) => {
    const options = review.sources.map((source) => ({
      key: source.key, backendId: safeLabel(source.value?.backendId || '(missing ID)'),
      backendType: safeLabel(source.value?.backendType || '(unknown provider)'),
      endpoint: safeLabel(source.value?.endpoint || '(not supplied)'),
      file: safeLabel(source.source.file), occurrence: source.source.occurrence,
      eligible: !backend.issue && !source.issue && source.value.backendType === backend.value.backendType,
      issue: source.issue || (source.value?.backendType !== backend.value?.backendType ? 'Provider differs from the new backend.' : null),
      sameId: source.value?.backendId === backend.value?.backendId,
    }));
    const suggestions = options.filter((option) => option.eligible && option.sameId);
    const confirmed = review.sources.find((entry) => entry.key === review.pairs.get(backend.key));
    const matched = new Set();
    const models = backend.models.map((model) => {
      const match = matchedModel(review, backend, model);
      if (match.model) matched.add(match.model.key);
      return {
        key: model.key, name: safeLabel(model.value?.name || '(missing model identity)'),
        modelPath: typeof model.value?.modelPath === 'string' ? safeLabel(model.value.modelPath) : null,
        issue: match.issue,
        sourceName: match.model ? safeLabel(match.model.value.name) : null,
        fields: comparableFields(review, backend, model, match).map(({ field, present, eligible, problems }) => ({
          key: field.key, label: field.label,
          current: Object.hasOwn(model.value, field.key) ? JSON.stringify(model.value[field.key]) : '[not supplied]',
          source: present ? JSON.stringify(match.model.value[field.key]) : '[not supplied]',
          eligible, problems, selected: review.choices.has(fieldKey(backend, model, field.key)),
          differs: present && (!Object.hasOwn(model.value, field.key) || !same(model.value[field.key], match.model.value[field.key])),
          comparison: !present ? 'target-only' : !eligible ? 'incompatible'
            : !Object.hasOwn(model.value, field.key) ? 'source-only'
              : same(model.value[field.key], match.model.value[field.key]) ? 'same' : 'different',
          needsReview: ['modelVersion', 'modelFormat', 'apiVersion', 'inferenceApiVersion'].includes(field.key),
        })),
      };
    });
    return {
      key: backend.key, backendId: safeLabel(backend.value?.backendId || '(missing ID)'),
      backendType: safeLabel(backend.value?.backendType || '(unknown provider)'),
      endpoint: safeLabel(backend.value?.endpoint || '(not supplied)'), issue: backend.issue,
      suggestion: suggestions.length === 1 ? suggestions[0].key : null,
      options, confirmedSource: confirmed?.key || null, models,
      unmatchedSourceModels: confirmed ? confirmed.models.filter((model) => !matched.has(model.key)).map((model) => ({
        name: safeLabel(model.value?.name || '(missing model identity)'),
        issue: model.issue || 'No matching model in this new backend.',
        status: review.keepRest ? 'excluded' : 'unresolved',
      })) : [],
    };
  });
  return {
    kind: 'llm-models', available: true, keepRest: review.keepRest, backends: backendsView,
    sourceIssues: review.sourceIssues,
    unpairedSources: review.sources.filter((source) => !usedSources.has(source.key)).map((source) => ({
      backendId: safeLabel(source.value?.backendId || '(missing ID)'), file: safeLabel(source.source.file),
      issue: source.issue || 'No confirmed new backend pairing.',
      status: review.keepRest ? 'excluded' : 'unresolved',
    })),
    summary: {
      backends: review.targets.length, models: review.targets.reduce((sum, backend) => sum + backend.models.length, 0),
      confirmedBackends: review.pairs.size, selectedFields: evaluated.selected,
      changedFields: evaluated.operations.length, alreadyCurrent: evaluated.alreadyCurrent,
      changedModels: new Set(evaluated.changes.map((change) => change.modelKey)).size,
      comparisons: Object.fromEntries(['same', 'different', 'target-only', 'source-only', 'incompatible'].map((category) => [
        category, backendsView.reduce((sum, backend) => sum + backend.models.reduce((count, model) =>
          count + model.fields.filter((field) => field.comparison === category).length, 0), 0),
      ])),
    },
    changes: evaluated.changes,
  };
}
