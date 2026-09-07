/**
 * File-scoped, literal-only migration proposals. This is deliberately not a
 * release/version translator. A matching name is evidence for a proposal, not
 * evidence that two versions of a feature mean the same thing.
 *
 * Raw destination bytes remain private to the short-lived session for surgical
 * editing. Public views are projections; donor raw text is never part of them.
 */
import { previewDocumentText } from './citadel-core.mjs';
import { quote, serializeValue } from './bicepparam/serialize.mjs';
import {
  MigrationError, migrationParameterKey, readArmParameters, readBicepParameters, safeLabel,
  sensitiveName, sensitiveValue,
} from './migration-input.mjs';
import { checkMigrationValue, placeholderValue, readMigrationSchema, schemaGuidance, typeMatches } from './migration-schema.mjs';

export const MIGRATION_CATEGORIES = Object.freeze({
  'exact-match': 'Compatible exact-name proposal',
  'no-donor': 'Current field / no paired donor assignment',
  'removed-donor': 'Removed / unrecognized donor field',
  mismatch: 'Type / current-constraint mismatch',
  ambiguous: 'Ambiguous candidates / duplicate declaration',
  dynamic: 'Nonliteral expression / dynamic reference',
  'semantic-review': 'Feature / semantic change — manual review',
  'unknown-schema': 'Unknown / unsupported current schema',
  sensitive: 'Sensitive value — not copied',
});

function group(items, name = (item) => item.name) {
  const groups = new Map();
  for (const item of items) {
    const key = migrationParameterKey(name(item));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function candidateCategory(candidate, definition) {
  if (candidate.sensitive || definition?.secure) return 'sensitive';
  if (candidate.schemaUnknown) return 'unknown-schema';
  if (candidate.status === 'ambiguous') return 'ambiguous';
  if (candidate.status === 'dynamic') return 'dynamic';
  if (!definition?.known) return 'unknown-schema';
  if (candidate.status !== 'literal' || checkMigrationValue(candidate.value, definition).length) return 'mismatch';
  return ['array', 'object'].includes(definition.type) ? 'semantic-review' : 'exact-match';
}

function currentFor(row) {
  if (row.current.length > 1) return { status: 'ambiguous' };
  if (row.current.length === 1) return { ...row.current[0], origin: 'destination-file' };
  if (row.definition?.hasDefault) return { ...row.definition.default, origin: 'template-default' };
  return { status: 'absent', origin: 'not-supplied' };
}

function withheld(candidate, definition, name) {
  return candidate?.sensitive || definition?.secure || sensitiveValue(candidate?.value, name) ||
    (candidate?.origin && !definition?.known);
}

function display(candidate, definition, name) {
  if (!candidate || candidate.status === 'absent') return '[not supplied]';
  if ((definition && !definition.known) || (candidate?.origin && !definition?.known)) return '[withheld: unknown current schema]';
  if (withheld(candidate, definition, name)) return '[withheld: sensitive field or nested credential material]';
  if (candidate.status !== 'literal') return `[withheld: ${candidate.status === 'dynamic' ? 'expression / reference' : 'ambiguous or unsupported value'}]`;
  const value = JSON.stringify(candidate.value);
  return value.length > 1600 ? `${value.slice(0, 1600)}… [display truncated; review the selected source locally]` : value;
}

export function buildMigrationPlan({ target, donors, validateCandidate = () => [] }) {
  const current = readBicepParameters(target.text, { target: true });
  const schema = readMigrationSchema(target.schemaText);
  const definitions = group(schema.definitions);
  const assignments = group(current.parameters);
  const candidates = [];
  const sourcesMetadata = [];
  for (const donor of donors) {
    const parsed = donor.format === 'json' ? readArmParameters(donor.text) : readBicepParameters(donor.text);
    const parsedSchema = readMigrationSchema(donor.schemaText);
    const donorSchema = group(parsedSchema.definitions);
    sourcesMetadata.push({
      id: donor.id, file: safeLabel(donor.alias), format: donor.format,
      names: parsed.parameters.map((parameter) => parameter.name),
      schemaNames: parsedSchema.complete ? parsedSchema.definitions.map((definition) => definition.name) : null,
    });
    parsed.parameters.forEach((parameter, index) => {
      const metadata = donorSchema.get(migrationParameterKey(parameter.name)) || [];
      const sensitive = parameter.sensitive || sensitiveName(parameter.name) ||
        metadata.some((definition) => definition.secure) || sensitiveValue(parameter.value, parameter.name);
      const unknownDonorType = (donor.schemaText !== null && donor.schemaText !== undefined && !parsedSchema.complete) ||
        metadata.some((definition) => !definition.known);
      candidates.push({
        id: `${donor.id}:${index}`,
        name: parameter.name,
        status: unknownDonorType ? 'unsupported' : parameter.status,
        type: parameter.status === 'literal'
          ? ['string', 'int', 'bool', 'array', 'object'].find((type) => typeMatches(parameter.value, type)) || 'null'
          : parameter.status,
        // Secret values are not retained even in candidate objects.
        value: sensitive || unknownDonorType ? undefined : parameter.value,
        sensitive,
        schemaUnknown: unknownDonorType,
        source: { fileId: donor.id, file: safeLabel(donor.alias), occurrence: index + 1, format: donor.format },
        donorSchema: donor.schemaText === null || donor.schemaText === undefined ? 'not-available'
          : parsedSchema.complete ? 'present' : 'unsupported',
      });
    });
  }
  const sources = group(candidates);
  const names = new Set([...assignments.keys(), ...definitions.keys()]);
  const rows = [];
  for (const key of names) {
    const declared = assignments.get(key) || [];
    const matchedDefinitions = definitions.get(key) || [];
    const definition = matchedDefinitions.length ? {
      ...matchedDefinitions[0],
      // Duplicate declarations never select a metadata winner, especially not
      // one that could hide a later @secure annotation.
      secure: matchedDefinitions.some((entry) => entry.secure),
      known: matchedDefinitions.length === 1 && matchedDefinitions[0].known,
    } : null;
    const name = declared[0]?.name || definition.name;
    const duplicate = declared.length > 1 || (definitions.get(key)?.length || 0) > 1;
    const choices = (sources.get(key) || []).map((candidate) => {
      const baseCategory = candidateCategory(candidate, definition);
      const checkable = ['exact-match', 'semantic-review'].includes(baseCategory);
      const featureProblems = checkable ? validateCandidate(name, candidate.value) : [];
      const category = featureProblems.length ? 'mismatch' : baseCategory;
      return {
        ...candidate, category,
        sensitive: candidate.sensitive || Boolean(definition?.secure),
        value: definition?.secure ? undefined : candidate.value,
        eligible: ['exact-match', 'semantic-review'].includes(category) && !duplicate,
        problems: category === 'mismatch'
          ? [...checkMigrationValue(candidate.value, definition), ...featureProblems]
          : [],
      };
    });
    const categories = new Set(choices.length ? choices.map((choice) => choice.category) : ['no-donor']);
    // Orthogonal facts must not disappear behind the primary safety category.
    // A sensitive environment reference is both withheld AND dynamic.
    if (choices.some((choice) => choice.status === 'dynamic')) categories.add('dynamic');
    if (duplicate || choices.length > 1) categories.add('ambiguous');
    if (!definition?.known) categories.add('unknown-schema');
    if (choices.length) categories.add('semantic-review');
    rows.push({
      id: `target-${rows.length + 1}`, name, current: declared, definition, duplicate,
      candidates: choices, categories: [...categories], removed: false,
    });
  }
  for (const candidate of candidates.filter((entry) => !names.has(migrationParameterKey(entry.name)))) {
    rows.push({
      id: `removed-${rows.length + 1}`, name: candidate.name, current: [], definition: null,
      duplicate: false, candidates: [{ ...candidate, value: undefined, eligible: false, category: 'removed-donor' }],
      categories: ['removed-donor', ...(candidate.sensitive ? ['sensitive'] : []), ...(candidate.status === 'dynamic' ? ['dynamic'] : [])],
      removed: true,
    });
  }
  return { target, using: current.using, schema, rows, sources: sourcesMetadata, decisions: new Map() };
}

/** Each source is compared only with its explicitly paired current target. */
export function migrationNameReports(plan) {
  const currentRows = plan.rows.filter((row) => !row.removed);
  const currentNames = new Set(currentRows.map((row) => migrationParameterKey(row.name)));
  const labels = (names) => [...new Set(names)].map((name) => safeLabel(name));
  return plan.sources.map((source) => {
    const supplied = new Set(source.names.map(migrationParameterKey));
    const oldSchema = source.schemaNames && new Set(source.schemaNames.map(migrationParameterKey));
    const matching = currentRows.filter((row) => supplied.has(migrationParameterKey(row.name)));
    return {
      source: { fileId: source.id, file: source.file, format: source.format },
      matching: 'Exact Bicep identifiers (case-insensitive); current casing retained. A match is not an approved copy.',
      matchedNames: labels(matching.map((row) => row.name)),
      oldOnlyNames: labels(source.names.filter((name) => !currentNames.has(migrationParameterKey(name)))),
      currentAssignmentsWithoutDonor: labels(currentRows.filter((row) =>
        row.current.length && !supplied.has(migrationParameterKey(row.name))).map((row) => row.name)),
      inheritedDefaultsWithoutDonor: labels(currentRows.filter((row) =>
        !row.current.length && row.definition?.hasDefault && !supplied.has(migrationParameterKey(row.name))).map((row) => row.name)),
      donorSuppliedSchemaFieldsNotAssigned: labels(matching.filter((row) => !row.current.length).map((row) => row.name)),
      currentSchemaOnlyNames: oldSchema === null ? null : labels(plan.schema.definitions
        .filter((definition) => !oldSchema.has(migrationParameterKey(definition.name))).map((definition) => definition.name)),
      duplicateDonorNames: labels([...group(source.names, (name) => name).values()]
        .filter((names) => names.length > 1).flat()),
      ambiguousCurrentNames: labels(currentRows.filter((row) => row.duplicate).map((row) => row.name)),
    };
  });
}

export function decideMigration(plan, rowId, decision) {
  const row = plan.rows.find((entry) => entry.id === rowId);
  if (!row || row.removed) throw new MigrationError('decision');
  if (!decision || decision.kind === 'pending') {
    plan.decisions.delete(rowId);
    return;
  }
  if (decision.kind === 'keep') {
    plan.decisions.set(rowId, { kind: 'keep' });
    return;
  }
  const candidate = row.candidates.find((entry) => entry.id === decision.candidateId);
  if (decision.kind !== 'accept' || !candidate?.eligible || decision.semanticReviewed !== true) {
    throw new MigrationError('decision');
  }
  plan.decisions.set(rowId, { kind: 'accept', candidateId: candidate.id, semanticReviewed: true });
}

function effective(row, decision) {
  if (decision?.kind === 'accept') return { ...row.candidates.find((entry) => entry.id === decision.candidateId), origin: 'donor' };
  return currentFor(row);
}

function replacementNeeded(row, decision) {
  if (decision?.kind !== 'accept') return false;
  const candidate = row.candidates.find((entry) => entry.id === decision.candidateId);
  return !row.current.length || row.current[0].status !== 'literal' ||
    JSON.stringify(row.current[0].value) !== JSON.stringify(candidate.value);
}

/** Value-free, overlapping category counts for reports and sample evidence. */
export function migrationClassification(plan) {
  const targets = plan.rows.filter((row) => !row.removed);
  const matched = targets.filter((row) => row.candidates.length);
  const mismatches = matched.filter((row) => row.candidates.some((candidate) => candidate.category === 'mismatch'));
  const typeMismatch = mismatches.filter((row) => row.candidates.some((candidate) =>
    candidate.category === 'mismatch' && !typeMatches(candidate.value, row.definition?.type))).length;
  return {
    targetFields: targets.length,
    matched: matched.length,
    compatibleScalar: matched.filter((row) => row.candidates.some((candidate) => candidate.category === 'exact-match')).length,
    withoutDonor: targets.filter((row) => !row.candidates.length).length,
    removed: plan.rows.filter((row) => row.removed).length,
    typeMismatch,
    constraintMismatch: mismatches.length - typeMismatch,
    ambiguous: targets.filter((row) => row.categories.includes('ambiguous')).length,
    dynamic: plan.rows.filter((row) => row.categories.includes('dynamic')).length,
    semantic: targets.filter((row) => row.categories.includes('semantic-review')).length,
    unknownSchema: targets.filter((row) => row.categories.includes('unknown-schema')).length,
    sensitive: plan.rows.filter((row) => row.categories.includes('sensitive')).length,
    eligibleUnique: matched.filter((row) => row.candidates.length === 1 && row.candidates[0].eligible).length,
  };
}

export function migrationRows(plan) {
  return plan.rows.map((row) => {
    const decision = plan.decisions.get(row.id);
    const current = currentFor(row);
    const final = effective(row, decision);
    const status = row.removed ? 'not-copied'
      : decision?.kind === 'accept' ? replacementNeeded(row, decision) ? 'copy' : 'accepted-unchanged'
        : decision?.kind === 'keep' ? 'keep'
          : row.candidates.length ? 'unreviewed-retain' : 'retain-current';
    return {
      id: row.id, name: row.name, removed: row.removed,
      categories: [...row.categories],
      current: display(current, row.definition, row.name),
      currentOrigin: current.origin,
      final: display(final, row.definition, row.name),
      status, decision: decision ? { ...decision } : { kind: 'pending' },
      guidance: schemaGuidance(row.definition),
      candidates: row.candidates.map((candidate) => ({
        id: candidate.id, name: candidate.name, source: { ...candidate.source },
        category: candidate.category, eligible: candidate.eligible,
        type: candidate.type,
        value: row.removed ? '[withheld: old-only field; name reported only]' : display(candidate, row.definition, row.name),
        donorSchema: candidate.donorSchema,
        problems: candidate.problems || [],
      })),
    };
  });
}

/**
 * A sanitized, value-only local draft. Raw comments/expressions are deliberately
 * absent: comments can themselves contain credentials. This is NOT the byte
 * stream used for apply. Apply edits the original destination surgically.
 */
function projectedDraft(plan, after) {
  const lines = [
    '// Sanitized migration draft — NOT deployment-ready.',
    '// Destination comments are omitted. Withheld values/references require manual configuration.',
    '// Local apply instead preserves the original comments, expressions, and unrelated bytes.',
    plan.using && safeLabel(plan.using) === plan.using ? `using ${quote(plan.using)}` : 'using none',
    '',
  ];
  for (const row of plan.rows.filter((entry) => !entry.removed)) {
    const chosen = after ? plan.decisions.get(row.id) : null;
    // Keep schema-only defaults inherited; do not turn them into overrides.
    if (!row.current.length && chosen?.kind !== 'accept') {
      lines.push(`// ${row.name}: ${row.definition?.hasDefault ? 'retained template default' : 'not supplied — manual configuration required'}`);
      continue;
    }
    const value = effective(row, chosen);
    if (withheld(value, row.definition, row.name) || value.status !== 'literal') {
      lines.push(`// ${row.name}: value withheld; retain/configure a safe destination reference manually.`);
      // A commented declaration must not turn a hidden value into a literal or
      // override a safe environment/Key Vault expression on import elsewhere.
      continue;
    }
    lines.push(`param ${row.name} = ${serializeValue(value.value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function diffProjection(plan, after) {
  return plan.rows.filter((row) => !row.removed).map((row) => {
    const decision = after ? plan.decisions.get(row.id) : null;
    const candidate = effective(row, replacementNeeded(row, decision) ? decision : null);
    return `${row.name} = ${display(candidate, row.definition, row.name).replaceAll('\n', ' ').slice(0, 1600)} (${candidate.origin})`;
  }).join('\n');
}

export function evaluateMigration(plan, validateFeatures = () => []) {
  const operations = [];
  const blockers = [];
  const unresolved = [];
  const literals = [];
  if (!plan.schema.complete) blockers.push({ name: null, code: 'unknown-schema', message: 'The current Bicep template is missing or could not be understood.' });
  for (const row of plan.rows.filter((entry) => !entry.removed)) {
    const decision = plan.decisions.get(row.id);
    const value = effective(row, decision);
    const add = (code, message) => blockers.push({ name: row.name, code, message });
    if (row.duplicate) add('ambiguous', 'Duplicate destination/schema declarations must be resolved outside migration.');
    if (row.candidates.length && !decision) {
      add('decision', 'Choose a donor replacement or deliberately keep the destination.');
    }
    if (decision?.kind === 'accept') {
      const candidate = row.candidates.find((entry) => entry.id === decision.candidateId);
      if (!candidate?.eligible || !decision.semanticReviewed) throw new MigrationError('decision');
      if (replacementNeeded(row, decision)) {
        operations.push(row.current.length
          ? { op: 'set', path: [row.name], value: candidate.value, preserveComments: true }
          : { op: 'addParam', name: row.name, value: candidate.value });
      }
    }
    if (value.status === 'literal' && row.definition?.known) {
      const problems = checkMigrationValue(value.value, row.definition);
      if (problems.length) add('mismatch', problems.join(' '));
      const explicitlyAllowed = !problems.length &&
        row.definition.allowedValues?.some((allowed) => Object.is(allowed, value.value));
      if (row.definition.required && placeholderValue(value.value) && !explicitlyAllowed) {
        add('required', 'A required field still has an empty or placeholder value.');
      }
      if (!withheld(value, row.definition, row.name) && !problems.length) {
        literals.push({ name: row.name, value: value.value });
      }
    } else {
      if (row.definition?.required) add('required', 'A required field has no verifiably valid literal/current/default value. Configure it outside migration or accept a valid literal.');
      unresolved.push({ name: row.name, code: value.status === 'dynamic' ? 'dynamic' : 'unknown-schema' });
    }
    if (withheld(value, row.definition, row.name) && row.definition?.known) {
      unresolved.push({ name: row.name, code: 'sensitive-retained' });
    }
    // Candidate problems remain visible in the report, but deliberately keeping
    // a valid destination or choosing one valid candidate resolves that choice.
    if (!decision) {
      const issues = row.categories.filter((category) =>
        ['sensitive', 'dynamic', 'mismatch', 'ambiguous', 'unknown-schema'].includes(category));
      if (issues.length) unresolved.push({ name: row.name, code: issues.join(', ') });
    }
  }
  const featureFindings = validateFeatures(literals, plan);
  for (const finding of featureFindings) {
    if (finding.severity === 'error') blockers.push(finding);
    else unresolved.push(finding);
  }
  unresolved.push(...blockers.map(({ name, code }) => ({ name, code })));
  let after;
  try { after = previewDocumentText(plan.target.text, operations); }
  catch { throw new MigrationError('format'); }
  const rows = migrationRows(plan);
  const summary = {
    accepted: rows.filter((row) => row.decision.kind === 'accept').length,
    unchanged: rows.filter((row) => row.status === 'accepted-unchanged').length,
    copied: rows.filter((row) => row.status === 'copy').length,
    retained: rows.filter((row) => !row.removed && row.status !== 'copy').length,
    removed: rows.filter((row) => row.removed).length,
    unresolved: new Set(unresolved.map((entry) => entry.name)).size,
    unreviewed: rows.filter((row) => row.status === 'unreviewed-retain').length,
    blockers: blockers.length,
  };
  return {
    operations, after, rows, blockers, unresolved, summary, classification: migrationClassification(plan),
    changed: after !== plan.target.text,
    canApply: !blockers.length && after !== plan.target.text,
    beforeProjection: diffProjection(plan, false),
    afterProjection: diffProjection(plan, true),
    draft: projectedDraft(plan, true),
  };
}
