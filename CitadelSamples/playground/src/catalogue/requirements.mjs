/**
 * Per-sample configuration contracts.
 *
 * Each recipe declares, by hand, the exact fields it needs — nothing is
 * inferred from UI copy and nothing reads `Function#toString`. A declaration is
 * one entry per field:
 *
 *   { path: 'hub.gatewayUrl', requirement: 'mandatory', reason: '…' }
 *   { path: 'self:assetPath', requirement: 'optional', fallback: '…' }
 *   { path: 'foundry.accountName', requirement: 'conditional',
 *     condition: 'Publish the A2A asset is on', requiredWhen: {…} }
 *
 * `self:` resolves against the sample's own field namespace.
 *
 * The completeness of these declarations is enforced behaviourally by
 * `test/requirements.test.mjs`: perturbing any catalogue field must change the
 * generated plan only when the sample declares it. A field a recipe does not
 * declare is therefore provably irrelevant to that recipe, which is what lets
 * the Configure view refuse to render it.
 */

import { CLASSIFICATION_REQUIREMENT, REQUIREMENT_GROUPS, REQUIREMENT_LEVELS } from '../core/types.mjs';
import { coerceValue, evaluateCondition, isBlank } from '../core/validation.mjs';

/**
 * Expand a declaration's sample prefix into a full dotted field path.
 *
 *   'hub.gatewayUrl'                  -> 'hub.gatewayUrl'          (profile)
 *   'self:assetPath'                  -> 'samples.<this>.assetPath'
 *   'publish-assets:weatherToolName'  -> 'samples.publish-assets.weatherToolName'
 *
 * The cross-sample form is deliberate rather than accidental: the access
 * contract and cleanup legitimately read the publish contract's asset names,
 * and the Configure view shows them as belonging to that other recipe.
 */
export function resolveDeclaredPath(sampleId, path) {
  const separator = path.indexOf(':');
  if (separator < 0) return path;
  const owner = path.slice(0, separator);
  const name = path.slice(separator + 1);
  return `samples.${owner === 'self' ? sampleId : owner}.${name}`;
}

/**
 * Normalise one sample's declarations into frozen entries.
 * Throws at module load if a declaration names an unknown field, so a typo is
 * a startup failure rather than a silently missing form row.
 */
export function normaliseConfiguration(sample, lookupField) {
  const declarations = sample.configuration ?? [];
  const seen = new Set();
  const entries = declarations.map((declaration) => {
    const path = resolveDeclaredPath(sample.id, declaration.path);
    const field = lookupField(path);
    if (!field) {
      throw new Error(`Sample ${sample.id} declares configuration for unknown field "${path}"`);
    }
    if (seen.has(path)) {
      throw new Error(`Sample ${sample.id} declares "${path}" twice`);
    }
    seen.add(path);

    const requirement = declaration.requirement ?? CLASSIFICATION_REQUIREMENT[field.classification] ?? 'optional';
    if (!REQUIREMENT_LEVELS.includes(requirement)) {
      throw new Error(`Sample ${sample.id} declares unknown requirement "${requirement}" for ${path}`);
    }
    if (requirement === 'conditional' && !declaration.condition) {
      throw new Error(`Sample ${sample.id} declares ${path} as conditional without naming the condition`);
    }
    if ((requirement === 'optional' || requirement === 'generated') && !declaration.fallback) {
      throw new Error(`Sample ${sample.id} declares ${path} as ${requirement} without naming the fallback`);
    }
    if (!declaration.reason) {
      throw new Error(`Sample ${sample.id} declares ${path} without a reason`);
    }
    return Object.freeze({
      path,
      name: field.name,
      label: field.label,
      type: field.type,
      classification: field.classification,
      // Where the field lives: a shared profile id, this sample, or another
      // recipe whose configuration this one legitimately reads.
      owner: describeOwner(sample.id, path),
      requirement,
      reason: declaration.reason,
      condition: declaration.condition ?? '',
      // The machine-readable form of `condition`, used to decide whether a
      // conditional entry is currently blocking.
      requiredWhen: declaration.requiredWhen ?? field.requiredWhen ?? null,
      fallback: declaration.fallback ?? '',
      // A secret entry says separately whether THIS sample needs it at all.
      secret: field.classification === 'secret',
      // A blank blocks unless the entry declares a working fallback. Optional
      // and generated entries have one by construction; mandatory, conditional
      // and needed secrets do not. A conditional entry is additionally gated on
      // its condition still holding.
      blockingWhenBlank:
        declaration.blockingWhenBlank ?? (requirement !== 'optional' && requirement !== 'generated'),
      // Guards are inputs the executor checks rather than values it interpolates.
      guard: Boolean(declaration.guard),
      producedBy: declaration.producedBy ?? field.derivedFrom ?? '',
    });
  });
  return Object.freeze(entries);
}

/**
 * Live requirement view for one sample against the current configuration.
 *
 * @param {object} sample     decorated catalogue sample
 * @param {(path: string) => unknown} read
 * @param {{hasSecret?: (path: string) => boolean}} [options]
 */
export function buildRequirementManifest(sample, read, { hasSecret } = {}) {
  const lookup = new Map();
  const entries = sample.configurationEntries.map((entry) => {
    const raw = read(entry.path);
    const value = entry.type ? coerceValue({ type: entry.type }, raw) : raw;
    const supplied = entry.secret
      ? Boolean(hasSecret ? hasSecret(entry.path) : !isBlank(value))
      : !isBlank(value);
    // A conditional entry only blocks while its condition holds. Everything
    // else follows its declared `blockingWhenBlank`.
    const conditionActive =
      entry.requirement === 'conditional' ? Boolean(evaluateCondition(entry.requiredWhen, read)) : true;
    const blocking = !supplied && conditionActive && entry.blockingWhenBlank;
    const record = Object.freeze({
      ...entry,
      supplied,
      conditionActive,
      blocking,
      // Never the value itself for a secret, and never a live credential here.
      preview: entry.secret ? (supplied ? '(set — memory only)' : '') : previewValue(value),
    });
    lookup.set(entry.path, record);
    return record;
  });

  const groups = REQUIREMENT_GROUPS.map((group) => {
    const members = entries.filter((entry) => entry.requirement === group.id);
    return Object.freeze({
      ...group,
      entries: Object.freeze(members),
      count: members.length,
      suppliedCount: members.filter((entry) => entry.supplied).length,
      blockingCount: members.filter((entry) => entry.blocking).length,
    });
  }).filter((group) => group.count > 0);

  const blocking = entries.filter((entry) => entry.blocking);
  return Object.freeze({
    sampleId: sample.id,
    groups: Object.freeze(groups),
    entries: Object.freeze(entries),
    byPath: lookup,
    counts: Object.freeze(
      Object.fromEntries(REQUIREMENT_GROUPS.map((group) => [group.id, entries.filter((e) => e.requirement === group.id).length])),
    ),
    blocking: Object.freeze(blocking),
    blockingPaths: Object.freeze(blocking.map((entry) => entry.path)),
    satisfied: blocking.length === 0,
  });
}

function previewValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** `{ kind, id }` describing which namespace a resolved path belongs to. */
function describeOwner(sampleId, path) {
  if (!path.startsWith('samples.')) {
    return Object.freeze({ kind: 'profile', id: path.split('.')[0] });
  }
  const owner = path.split('.')[1];
  return Object.freeze({ kind: owner === sampleId ? 'self' : 'sample', id: owner });
}

/** Every distinct path any sample declares. Used by the manifest tests. */
export function declaredPaths(samples) {
  const paths = new Set();
  for (const sample of samples) {
    for (const entry of sample.configurationEntries) paths.add(entry.path);
  }
  return [...paths];
}

/* ------------------------------------------------------------------------ */
/* Declaration helpers.                                                      */
/*                                                                           */
/* These keep 19 hand-written contracts readable without hiding anything: a  */
/* declaration is still one explicit line naming one field and one reason.   */
/* ------------------------------------------------------------------------ */

/** A blank value stops this sample from executing. */
export const mandatory = (path, reason) => ({ path, requirement: 'mandatory', reason });

/** Mandatory only while `condition` holds. `requiredWhen` is its machine form. */
export const conditional = (path, reason, condition, requiredWhen) => ({
  path,
  requirement: 'conditional',
  reason,
  condition,
  requiredWhen,
});

/** Pre-filled by the notebook; a blank falls back to `fallback` and never blocks. */
export const optional = (path, reason, fallback) => ({ path, requirement: 'optional', reason, fallback });

/** Produced by another recipe or by this run; typeable purely as an override. */
export const generated = (path, reason, fallback, producedBy = '') => ({
  path,
  requirement: 'generated',
  reason,
  fallback,
  producedBy,
});

/** A credential. `blocking` says whether THIS sample cannot run without it. */
export const secret = (path, reason, { blocking = true, fallback = '' } = {}) => ({
  path,
  requirement: 'secret',
  reason,
  blockingWhenBlank: blocking,
  fallback: blocking ? '' : fallback || 'Not needed by this sample.',
});

/** A precondition the executor checks rather than a value it interpolates. */
export const guard = (path, reason) => ({ path, requirement: 'mandatory', reason, guard: true });

