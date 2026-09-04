/**
 * The ExecutionPlan model.
 *
 * A plan is a frozen, deterministic description of what a recipe *would* do.
 * It never runs anything, never contains a secret value, and never contains a
 * timestamp or a random id — the same inputs always compile to the same plan,
 * which is what makes the golden plan tests meaningful.
 *
 * Steps bind to each other by name: a step `produces` outputs, and a later
 * step `consumes` them through a `{{steps.<id>.<output>}}` token.
 */

import { STEP_TYPES } from './types.mjs';
import { collectSecretRefs } from './secrets.mjs';

const BINDING_PATTERN = /\{\{steps\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\}\}/g;

function findBindings(value, found = []) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(BINDING_PATTERN)) {
      found.push({ stepId: match[1], output: match[2], token: match[0] });
    }
  } else if (Array.isArray(value)) {
    for (const item of value) findBindings(item, found);
  } else if (value && typeof value === 'object' && value.kind !== '@secretRef') {
    for (const item of Object.values(value)) findBindings(item, found);
  }
  return found;
}

/**
 * @typedef {object} PlanStep
 * @property {string} id
 * @property {'artifact'|'azure-cli'|'http'|'library'|'assertion'} type
 * @property {string} title
 * @property {string} detail       why this step exists, in one sentence
 * @property {string[]} produces   named outputs later steps may consume
 * @property {object} [request]    for `http`
 * @property {object} [command]    for `azure-cli`
 * @property {object} [artifact]   for `artifact`
 * @property {object} [library]    for `library`
 * @property {object} [assertion]  for `assertion`
 */

export function planStep(step) {
  if (!step || typeof step.id !== 'string' || step.id === '') {
    throw new TypeError('planStep requires an id');
  }
  if (!STEP_TYPES.includes(step.type)) {
    throw new TypeError(`planStep "${step.id}" has unknown type ${String(step.type)}`);
  }
  const consumes = [
    ...new Set(
      findBindings({
        request: step.request,
        command: step.command,
        artifact: step.artifact,
        library: step.library,
        assertion: step.assertion,
      }).map((binding) => `${binding.stepId}.${binding.output}`),
    ),
  ];
  return deepFreeze({
    produces: [],
    ...step,
    consumes,
  });
}

/**
 * Build a plan. Fields are ordered deliberately so a serialized plan diffs
 * cleanly in the golden tests.
 */
export function createExecutionPlan({
  sampleId,
  title,
  summary,
  risk,
  sourceCells,
  steps,
  expectedResults = [],
  notes = [],
  deviations = [],
}) {
  const planSteps = steps.map((step) => (Object.isFrozen(step) && step.consumes ? step : planStep(step)));
  const ids = new Set();
  for (const step of planSteps) {
    if (ids.has(step.id)) throw new Error(`Duplicate step id "${step.id}" in plan for ${sampleId}`);
    ids.add(step.id);
  }
  for (const step of planSteps) {
    for (const consumed of step.consumes) {
      const [producerId, output] = consumed.split('.');
      const producer = planSteps.find((candidate) => candidate.id === producerId);
      if (!producer) {
        throw new Error(`Step "${step.id}" consumes unknown step "${producerId}" in plan for ${sampleId}`);
      }
      if (!producer.produces.includes(output)) {
        throw new Error(
          `Step "${step.id}" consumes ${consumed}, but "${producerId}" does not declare that output in plan for ${sampleId}`,
        );
      }
      if (planSteps.indexOf(producer) >= planSteps.indexOf(step)) {
        throw new Error(`Step "${step.id}" consumes ${consumed} before it is produced in plan for ${sampleId}`);
      }
    }
  }

  const requiredStepTypes = [...new Set(planSteps.map((step) => step.type))];
  const secretRefs = collectSecretRefs(planSteps).map((ref) => ref.ref);

  return deepFreeze({
    planVersion: 1,
    sampleId,
    title,
    summary,
    risk,
    sourceCells: [...sourceCells],
    requiredStepTypes,
    secretRefs,
    steps: planSteps,
    expectedResults,
    notes,
    deviations,
  });
}

/** Stable JSON for golden tests and for the Request tab. */
export function serializePlan(plan) {
  return JSON.stringify(plan, replaceSecretRefs, 2);
}

function replaceSecretRefs(_key, value) {
  if (value && typeof value === 'object' && value.kind === '@secretRef') {
    return { secret: value.ref, placeholder: `\${${value.envVar}}` };
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

/** Convenience constructors keeping builder code short and uniform. */
export const step = {
  artifact: (config) => planStep({ ...config, type: 'artifact' }),
  cli: (config) => planStep({ ...config, type: 'azure-cli' }),
  http: (config) => planStep({ ...config, type: 'http' }),
  library: (config) => planStep({ ...config, type: 'library' }),
  assertion: (config) => planStep({ ...config, type: 'assertion' }),
};
