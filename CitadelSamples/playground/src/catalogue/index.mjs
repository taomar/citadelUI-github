/**
 * The catalogue: the single source of truth.
 *
 * Navigation, forms, validation, builders, guides, provenance and the tests all
 * read this module. Nothing else owns sample identity.
 */

import {
  EXPECTED_SAMPLE_COUNT,
  GROUPS,
  NON_RECIPE_CODE_CELLS,
  SOURCE_NOTEBOOK,
  isRiskAcknowledgementRequired,
} from '../core/types.mjs';
import { PROFILES, PROFILE_BY_ID, collectProfileDefaults, collectProfileSecretPaths } from './profiles.mjs';
import { buildRequirementManifest, normaliseConfiguration } from './requirements.mjs';
import { DISCOVER_SAMPLES } from './samples/discover.mjs';
import { PREPARE_SAMPLES } from './samples/prepare.mjs';
import { PUBLISH_SAMPLES } from './samples/publish.mjs';
import { EXERCISE_SAMPLES } from './samples/exercise.mjs';
import { OBSERVE_SAMPLES } from './samples/observe.mjs';
import { POLICY_SAMPLES } from './samples/policy.mjs';
import { CLEANUP_RESIDUE, LIFECYCLE_SAMPLES } from './samples/lifecycle.mjs';
import {
  checkAcknowledgement,
  coerceValue,
  evaluateCondition,
  hasErrors,
  isBlank,
  validateFields,
} from '../core/validation.mjs';

const RAW_SAMPLES = [
  ...DISCOVER_SAMPLES,
  ...PREPARE_SAMPLES,
  ...PUBLISH_SAMPLES,
  ...EXERCISE_SAMPLES,
  ...OBSERVE_SAMPLES,
  ...POLICY_SAMPLES,
  ...LIFECYCLE_SAMPLES,
];

/**
 * Scenarios that are NOT in the source notebook and are therefore not in this
 * catalogue. Stated explicitly so nobody has to infer an absence.
 */
export const EXCLUDED_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'image-generation',
    title: 'Image generation / multimodal',
    reason:
      'The source notebook contains no image or multimodal sample. Nothing in its 19 code cells generates, uploads or interprets an image, so no such recipe exists here. A sibling notebook in the accelerator covers image models; it is a different source and is out of scope.',
  }),
  Object.freeze({
    id: 'llm-inference',
    title: 'LLM inference call',
    reason:
      'The notebook grants LLM APIs through the access contract and writes an `llm-token-limit` into the product policy, but it never sends a completion or chat request. Cell 30 says LLM token limits are "validated best-effort only when a model is reachable", and no cell does so. Inventing an inference recipe would put a passing result behind an assertion the notebook never makes.',
  }),
  Object.freeze({
    id: 'model-rbac',
    title: 'Model RBAC enforcement',
    reason:
      '`validate-model-access` and the allowed-model list appear in the generated product policy but are never exercised, for the same reason as LLM inference.',
  }),
  Object.freeze({
    id: 'api-center',
    title: 'API Center registration',
    reason: 'All three assets set `publishToApiCenter: False`, so no cell registers anything with API Center.',
  }),
]);

function sampleFieldPath(sampleId, fieldName) {
  return `samples.${sampleId}.${fieldName}`;
}

function decorate(sample) {
  const group = GROUPS.find((candidate) => candidate.id === sample.group);
  if (!group) throw new Error(`Sample ${sample.id} declares unknown group ${sample.group}`);
  const risk = Object.freeze({
    ...sample.risk,
    requiresAcknowledgement:
      isRiskAcknowledgementRequired(sample.risk.level)
      || sample.risk.requiresAcknowledgement === true,
  });
  const fields = (sample.fields ?? []).map((field) =>
    Object.freeze({ ...field, path: sampleFieldPath(sample.id, field.name) }),
  );
  // Deliberately not frozen yet: the configuration contract can only be
  // normalised once every sample's fields are in the catalogue-wide index,
  // because a declaration may name another recipe's field.
  return {
    ...sample,
    risk,
    fields: Object.freeze(fields),
    groupTitle: group.title,
    fieldPathPrefix: `samples.${sample.id}`,
  };
}

const DECORATED = RAW_SAMPLES.map(decorate);

/**
 * Field index spanning every profile and every sample.
 *
 * The index is catalogue-wide, not scoped to a recipe's own `usesProfiles`,
 * because three recipes legitimately read another recipe's configuration: the
 * access contract and cleanup both need the publish contract's asset names, and
 * cleanup needs the access contract's discovered LLM API list. Scoping the
 * index silently resolved those to empty strings instead of failing, which is
 * exactly the class of bug this index removes.
 */
const FIELD_BY_PATH = new Map();
for (const profile of PROFILES) {
  for (const field of profile.fields) FIELD_BY_PATH.set(`${profile.id}.${field.name}`, field);
}
for (const sample of DECORATED) {
  for (const field of sample.fields) FIELD_BY_PATH.set(field.path, field);
}

export function fieldByPath(path) {
  return FIELD_BY_PATH.get(path) ?? null;
}

/**
 * Every sample's configuration contract, normalised once at load. A typo in a
 * declaration throws here rather than producing a form row that never appears.
 */
export const SAMPLES = Object.freeze(
  DECORATED.map((sample) =>
    Object.freeze({ ...sample, configurationEntries: normaliseConfiguration(sample, fieldByPath) }),
  ),
);

const byId = new Map(SAMPLES.map((sample) => [sample.id, sample]));

/** The live requirement view for one sample against the current values. */
export function requirementsFor(sample, read, options = {}) {
  return buildRequirementManifest(sample, read, options);
}

/** Sample-field defaults, keyed by dotted path. */
function collectSampleDefaults() {
  const defaults = {};
  for (const sample of SAMPLES) {
    for (const field of sample.fields) {
      if (Object.prototype.hasOwnProperty.call(field, 'default')) defaults[field.path] = field.default;
    }
  }
  return defaults;
}

function collectSampleSecretPaths() {
  const paths = [];
  for (const sample of SAMPLES) {
    for (const field of sample.fields) {
      if (field.classification === 'secret') paths.push(field.path);
    }
  }
  return paths;
}

export const CATALOGUE = Object.freeze({
  version: 1,
  groups: GROUPS,
  profiles: PROFILES,
  profileById: PROFILE_BY_ID,
  samples: SAMPLES,
  byId,
  excludedScenarios: EXCLUDED_SCENARIOS,
  cleanupResidue: CLEANUP_RESIDUE,
  nonRecipeCodeCells: NON_RECIPE_CODE_CELLS,
  sourceNotebook: SOURCE_NOTEBOOK,
  expectedSampleCount: EXPECTED_SAMPLE_COUNT,
  defaultValues: Object.freeze({ ...collectProfileDefaults(), ...collectSampleDefaults() }),
  secretFieldPaths: Object.freeze([...collectProfileSecretPaths(), ...collectSampleSecretPaths()]),
});

export function getSample(sampleId) {
  const sample = byId.get(sampleId);
  if (!sample) throw new Error(`Unknown sample "${sampleId}"`);
  return sample;
}

/** Every profile a sample reads, resolved to profile objects. */
export function profilesFor(sample) {
  return (sample.usesProfiles ?? []).map((profileId) => {
    const profile = PROFILE_BY_ID.get(profileId);
    if (!profile) throw new Error(`Sample ${sample.id} references unknown profile ${profileId}`);
    return profile;
  });
}

/**
 * Validate exactly what a sample declares it needs.
 *
 * Scoping this to the sample's configuration contract rather than to every
 * field of every profile it lists is the whole point of the contract: API
 * Management discovery must not be blocked by a missing subscription id it
 * never reads, and Key Vault verification must not ask for a gateway URL.
 *
 * @param {object} sample
 * @param {(path: string) => unknown} read
 */
export function validateSample(sample, read, { hasSecret } = {}) {
  const issues = [];
  const missing = [];

  for (const entry of sample.configurationEntries) {
    const field = fieldByPath(entry.path);
    if (!field) continue;
    if (entry.secret && isBlank(read(entry.path)) && hasSecret?.(entry.path)) continue;
    const result = validateFields([asRequiredBy(field, entry)], read);
    issues.push(...result.issues);
    missing.push(...result.missing);
  }

  // `mustEqual` guards (the non-production confirmations).
  for (const field of sample.fields) {
    if (!Object.prototype.hasOwnProperty.call(field, 'mustEqual')) continue;
    if (field.mustEqualWhen && !evaluateCondition(field.mustEqualWhen, read)) continue;
    const value = coerceValue(field, read(field.path));
    if (value !== field.mustEqual) {
      issues.push({
        path: field.path,
        field: field.name,
        severity: 'error',
        message: field.mustEqualMessage ?? `${field.label} must be confirmed.`,
      });
      missing.push(field.path);
    }
  }

  return {
    issues,
    missing,
    satisfied: !hasErrors(issues),
  };
}

/**
 * Project a catalogue field through one sample's requirement level.
 *
 * The field says where a value comes from; the entry says whether THIS sample
 * can run without it. Validation follows the entry.
 */
function asRequiredBy(field, entry) {
  const classification =
    entry.requirement === 'mandatory'
      ? 'required'
      : entry.requirement === 'conditional'
        ? 'conditional'
        : entry.requirement === 'secret'
          ? entry.blockingWhenBlank
            ? 'required'
            : 'secret'
          : entry.requirement === 'generated'
            ? 'derived'
            : 'sample-default';
  return {
    ...field,
    path: entry.path,
    classification,
    requiredWhen: entry.requirement === 'conditional' ? entry.requiredWhen : undefined,
  };
}

/**
 * Build the context a sample's `build()` receives.
 *
 * `get` resolves any dotted path with the declared default applied; `self`
 * resolves one of the sample's own fields; `fromSample` resolves another
 * recipe's field, which a few recipes deliberately need.
 */
function makeBuildContext(sample, read) {
  const get = (path) => {
    const field = FIELD_BY_PATH.get(path);
    const value = field ? coerceValue(field, read(path)) : read(path);
    // `false` and `0` are supplied values, so only these three count as unset.
    const unset =
      value === undefined || value === null || value === '' || (field?.preserveWhitespace === true && isBlank(value));
    if (!unset) return value;
    if (field && Object.prototype.hasOwnProperty.call(field, 'default')) return field.default;
    return field?.type === 'string-list' ? [] : '';
  };

  return {
    sample,
    get,
    self: (name) => get(sampleFieldPath(sample.id, name)),
    /** Read another recipe's field. Used where recipes share configuration. */
    fromSample: (sampleId, name) => get(sampleFieldPath(sampleId, name)),
    risk: sample.risk,
    notes: sample.notes ?? [],
    deviations: sample.deviations ?? [],
    expectedResults: sample.expectedResults ?? [],
  };
}

/**
 * Generate a sample's plan.
 *
 * Validation runs first: a plan is never produced for an invalid configuration,
 * because a preview of an incoherent operation is worse than no preview.
 */
export function buildSamplePlan(sample, read, { requireValid = true, hasSecret } = {}) {
  const validation = validateSample(sample, read, { hasSecret });
  if (requireValid && !validation.satisfied) {
    return { plan: null, validation };
  }
  const ctx = makeBuildContext(sample, read);
  return { plan: sample.build(ctx), validation };
}

/** Risk gate, re-exported so the UI and the tests use one implementation. */
export function acknowledgementFor(sample, acknowledged, read) {
  return checkAcknowledgement(sample, { acknowledged, read });
}

/** Every code cell a recipe cites, deduplicated and sorted. */
export function citedCodeCells() {
  const cited = new Set();
  for (const sample of SAMPLES) {
    for (const cell of sample.sourceCells) {
      if (SOURCE_NOTEBOOK.codeCellIndexes.includes(cell)) cited.add(cell);
    }
  }
  return [...cited].sort((a, b) => a - b);
}
