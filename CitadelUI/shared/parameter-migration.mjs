/**
 * File-scoped, literal-only migration proposals. This is deliberately not a
 * release/version translator. A matching name is evidence for a proposal, not
 * evidence that two versions of a feature mean the same thing.
 *
 * Raw destination bytes remain private to the short-lived session for surgical
 * editing. Public views are projections; donor raw text is never part of them.
 */
import { previewDocumentText, documentFromText } from './citadel-core.mjs';
import { quote, serializeValue } from './bicepparam/serialize.mjs';
import {
  MigrationError, migrationParameterKey, readArmParameters, readBicepParameters, safeLabel,
  sensitiveName, sensitiveValue, sameLiteralValue,
} from './migration-input.mjs';
import { checkMigrationValue, placeholderValue, readMigrationSchema, schemaGuidance, typeMatches } from './migration-schema.mjs';
import { buildLlmValueReview, decideLlmValue, evaluateLlmValues, keepLlmValues, llmValueReviewView } from './llm-value-migration.mjs';

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

function valueStatus(candidate, definition, name) {
  if (!candidate || candidate.status === 'absent') return 'missing';
  if ((definition && !definition.known) || (candidate.origin && !definition?.known)) return 'unknown-schema';
  if (withheld(candidate, definition, name)) return 'sensitive';
  return candidate.status === 'literal' ? 'readable'
    : candidate.status === 'dynamic' ? 'not-evaluated' : 'unresolved';
}

export function buildMigrationPlan({ target, donors, validateCandidate = () => [], llmPolicy = null }) {
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
  const names = new Set(assignments.keys());
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
    const row = {
      id: `target-${rows.length + 1}`, name, current: declared, definition, duplicate,
      candidates: choices, categories: [...categories], removed: false,
    };
    if (key === 'llmbackendconfig') {
      row.llm = buildLlmValueReview({ current: currentFor(row), candidates: choices, definition, policy: llmPolicy });
    }
    rows.push(row);
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
    if (row.llm) { keepLlmValues(row.llm, true); row.llm.keepRest = false; }
    return;
  }
  if (decision.kind === 'keep') {
    plan.decisions.set(rowId, { kind: 'keep' });
    if (row.llm) keepLlmValues(row.llm, true);
    return;
  }
  const candidate = row.candidates.find((entry) => entry.id === decision.candidateId);
  if (migrationParameterKey(row.name) === 'llmbackendconfig' || row.current.length !== 1 ||
      decision.kind !== 'accept' || !candidate?.eligible || decision.semanticReviewed !== true) {
    throw new MigrationError('decision');
  }
  plan.decisions.set(rowId, { kind: 'accept', candidateId: candidate.id, semanticReviewed: true });
}

export function decideMigrationModel(plan, rowId, decision) {
  const row = plan.rows.find((entry) => entry.id === rowId);
  if (!row?.llm || row.current.length !== 1 || row.duplicate) throw new MigrationError('decision');
  decideLlmValue(row.llm, decision);
  plan.decisions.set(rowId, { kind: 'models' });
}

export function keepMigrationRemaining(plan) {
  for (const row of plan.rows) {
    if (row.removed) continue;
    if (row.llm && plan.decisions.get(row.id)?.kind === 'models') keepLlmValues(row.llm);
    else if (!plan.decisions.has(row.id)) decideMigration(plan, row.id, { kind: 'keep' });
  }
}

function effective(row, decision) {
  if (decision?.kind === 'models') {
    if (!row.llm?.available) throw new MigrationError('decision');
    return { status: 'literal', value: evaluateLlmValues(row.llm, row.name).value, origin: 'reviewed-models' };
  }
  if (decision?.kind === 'accept') return { ...row.candidates.find((entry) => entry.id === decision.candidateId), origin: 'donor' };
  return currentFor(row);
}

function replacementNeeded(row, decision) {
  if (decision?.kind === 'models') return evaluateLlmValues(row.llm, row.name).operations.length > 0;
  if (decision?.kind !== 'accept') return false;
  const candidate = row.candidates.find((entry) => entry.id === decision.candidateId);
  return !row.current.length || row.current[0].status !== 'literal' ||
    !sameLiteralValue(row.current[0].value, candidate.value);
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
    const structured = row.llm ? llmValueReviewView(row.llm) : null;
    const modelSelection = decision?.kind === 'models' && structured?.summary?.selectedFields > 0;
    const status = row.removed ? 'not-copied'
      : modelSelection ? replacementNeeded(row, decision) ? 'copy' : 'accepted-unchanged'
        : decision?.kind === 'models' && row.llm.keepRest ? 'keep'
      : decision?.kind === 'accept' ? replacementNeeded(row, decision) ? 'copy' : 'accepted-unchanged'
        : decision?.kind === 'keep' ? 'keep'
          : row.candidates.length ? 'unreviewed-retain' : 'retain-current';
    return {
      id: row.id, name: row.name, removed: row.removed,
      categories: [...row.categories],
      current: structured?.available ? `${structured.summary.backends} new backends, ${structured.summary.models} models` : display(current, row.definition, row.name),
      currentFull: fullDisplay(current, row.definition, row.name),
      currentOrigin: current.origin,
      currentValueStatus: valueStatus(current, row.definition, row.name),
      final: structured?.available ? `${structured.summary.changedFields} model fields selected to change` : display(final, row.definition, row.name),
      status, decision: decision ? { ...decision } : { kind: 'pending' },
      structured,
      guidance: schemaGuidance(row.definition),
      comparison: row.removed ? 'source-only' : !row.candidates.length ? 'target-only' : 'matched',
      candidates: row.candidates.map((candidate) => ({
        id: candidate.id, name: candidate.name, source: { ...candidate.source },
        category: candidate.category, eligible: !row.llm && candidate.eligible,
        type: candidate.type,
        value: row.removed ? '[withheld: old-only field; name reported only]' : display(candidate, row.definition, row.name),
        fullValue: row.removed ? '[withheld: old-only field; name reported only]' : fullDisplay(candidate, row.definition, row.name),
        valueStatus: row.removed ? 'unresolved' : valueStatus(candidate, row.definition, row.name),
        matchesCurrent: !row.removed && candidate.eligible && current.status === 'literal' &&
          !withheld(current, row.definition, row.name) &&
          !withheld(candidate, row.definition, row.name) && sameLiteralValue(current.value, candidate.value),
        comparison: row.removed ? 'source-only'
          : valueStatus(candidate, row.definition, row.name) !== 'readable' || valueStatus(current, row.definition, row.name) !== 'readable' ? 'unresolved'
            : !candidate.eligible ? 'incompatible'
              : sameLiteralValue(current.value, candidate.value) ? 'same' : 'different',
        donorSchema: candidate.donorSchema,
        problems: candidate.problems || [],
      })),
    };
  });
}

function fullDisplay(value, definition, name) {
  return value?.status === 'literal' && definition?.known && !withheld(value, definition, name)
    ? JSON.stringify(value.value, null, 2) : display(value, definition, name);
}

/** A bounded presentation projection, not a source document or editor draft. */
export function migrationTargetProjection(plan) {
  const outline = documentFromText(plan.target.alias, plan.target.text).outline;
  const params = [];
  const changes = [];
  const schemas = {};
  for (const row of plan.rows.filter((row) => !row.removed)) {
    const decision = plan.decisions.get(row.id);
    const current = currentFor(row);
    const value = effective(row, decision);
    const readable = value.status === 'literal' && row.definition?.known &&
      !checkMigrationValue(value.value, row.definition).length && !withheld(value, row.definition, row.name);
    params.push({
      name: row.name, kind: row.definition?.type || 'unknown',
      value: readable ? structuredClone(value.value) : undefined,
      previewStatus: readable ? 'literal' : valueStatus(value, row.definition, row.name) === 'readable'
        ? 'unresolved' : valueStatus(value, row.definition, row.name),
    });
    schemas[row.name] = {
      name: row.name, type: row.definition?.type || 'unknown', secure: Boolean(row.definition?.secure),
      ...(row.definition?.allowedValues && !sensitiveValue(row.definition.allowedValues)
        ? { allowedValues: structuredClone(row.definition.allowedValues) } : {}),
    };
    if (!replacementNeeded(row, decision)) continue;
    if (decision?.kind === 'models') {
      changes.push(...evaluateLlmValues(row.llm, row.name).changes.map((change) => ({ ...change, rowId: row.id, kind: 'model' })));
    } else {
      const candidate = row.candidates.find((candidate) => candidate.id === decision.candidateId);
      changes.push({
        rowId: row.id, kind: 'parameter', path: [row.name], label: row.name,
        before: fullDisplay(current, row.definition, row.name), after: fullDisplay(value, row.definition, row.name),
        source: { file: candidate.source.file, parameter: candidate.name },
      });
    }
  }
  return {
    document: {
      path: plan.target.alias, params, schema: { available: plan.schema.complete, parameters: schemas },
      // Raw comments, descriptions and expression/default arguments do not
      // cross into the normal editor renderer. Keep only its section layout.
      outline: { intro: null, sections: (outline?.sections || []).map((section) => ({
        id: section.id,
        // This exact editor heading is not an HTTP Basic credential.
        title: /^basic parameters$/i.test(section.title.trim()) ? 'Basic Parameters' : safeLabel(section.title),
        blocks: [], params: [...section.params],
        groups: (section.groups || []).map((group) => ({
          label: group.label ? safeLabel(group.label) : null, blocks: [], params: [...group.params],
        })),
      })) },
    },
    changes,
    draft: projectedDraft(plan, true),
  };
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
  return plan.rows.filter((row) => !row.removed).flatMap((row) => {
    const decision = after ? plan.decisions.get(row.id) : null;
    if (row.llm) {
      const chosen = plan.decisions.get(row.id);
      const result = chosen?.kind === 'models' ? evaluateLlmValues(row.llm, row.name) : null;
      return result?.changes.length
        ? result.changes.map((change) => `${row.name} / ${change.backendId} / ${change.model} / ${change.field} = ${after ? change.after : change.before}`)
        : [`${row.name}: new backend/model values retained`];
    }
    const candidate = effective(row, replacementNeeded(row, decision) ? decision : null);
    return `${row.name} = ${fullDisplay(candidate, row.definition, row.name).replaceAll('\n', ' ')} (${candidate.origin})`;
  }).join('\n');
}

export function evaluateMigration(plan, validateFeatures = () => []) {
  const operations = [];
  const blockers = [];
  const unresolved = [];
  const literals = [];
  const baselineLiterals = [];
  const unverified = [];
  const retainFinding = (finding) => {
    const retained = { ...finding, scope: 'retained-destination', severity: 'warning', readiness: 'unverified' };
    unverified.push(retained);
    unresolved.push(retained);
  };
  if (!plan.schema.complete) retainFinding({ name: null, code: 'unknown-schema', message: 'The current Bicep template is missing or could not be understood. Unknown selected values cannot be applied.' });
  const assigned = new Set(plan.rows.filter((row) => !row.removed).map((row) => migrationParameterKey(row.name)));
  for (const definition of plan.schema.definitions) {
    if (definition.required && !assigned.has(migrationParameterKey(definition.name))) {
      retainFinding({
        name: definition.name, rowId: null, code: 'required', scope: 'retained-destination',
        message: 'The new file omits a required current-template parameter. Configure it outside value import; migration will not add it.',
      });
    }
  }
  for (const row of plan.rows.filter((entry) => !entry.removed)) {
    const decision = plan.decisions.get(row.id);
    const value = effective(row, decision);
    const changed = replacementNeeded(row, decision);
    const current = currentFor(row);
    if (current.status === 'literal' && row.definition?.known && !withheld(current, row.definition, row.name) &&
        !checkMigrationValue(current.value, row.definition).length) baselineLiterals.push({ name: row.name, value: current.value });
    const add = (code, message, hard = changed || decision?.kind === 'accept') => {
      const finding = { name: row.name, rowId: row.id, code, message, scope: hard ? 'selected-value' : 'retained-destination' };
      if (hard) blockers.push(finding);
      else retainFinding(finding);
    };
    if (row.duplicate) add('ambiguous', 'Duplicate destination/schema declarations must be resolved outside migration.', true);
    if (row.llm?.targets.some((backend) => /Duplicate/.test(backend.issue || '') ||
        backend.models.some((model) => /Duplicate/.test(model.issue || '')))) {
      add('ambiguous', 'Duplicate target backend/model identities must be resolved in the current editor before a patch can be authorized.', true);
    }
    if (row.candidates.length && !decision) {
      add('decision', 'Choose a donor replacement or deliberately keep the destination.', true);
    }
    if (decision?.kind === 'accept') {
      const candidate = row.candidates.find((entry) => entry.id === decision.candidateId);
      if (migrationParameterKey(row.name) === 'llmbackendconfig' || row.current.length !== 1 || !candidate?.eligible || !decision.semanticReviewed) throw new MigrationError('decision');
      if (replacementNeeded(row, decision)) {
        operations.push({ op: 'set', path: [row.name], value: candidate.value, preserveComments: true });
      }
    }
    if (decision?.kind === 'models') {
      if (!row.llm?.available) throw new MigrationError('decision');
      operations.push(...evaluateLlmValues(row.llm, row.name).operations);
      if (!row.llm.keepRest) add('decision', 'Preview selected values to confirm that all remaining new model values are kept.', true);
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
      if (row.definition?.required) add('required', 'This retained required field is not a verified literal. Its expression is preserved, not evaluated or certified for deployment.');
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
  for (const definition of plan.schema.definitions) {
    if (!assigned.has(migrationParameterKey(definition.name)) && definition.known &&
        definition.default?.status === 'literal' && !withheld(definition.default, definition, definition.name) &&
        !checkMigrationValue(definition.default.value, definition).length) {
      const inherited = { name: definition.name, value: definition.default.value };
      literals.push(inherited);
      baselineLiterals.push(inherited);
    }
  }
  const selectedNames = new Set(operations.map((operation) => migrationParameterKey(operation.path[0])));
  const findingKey = (finding) => JSON.stringify([finding.name, finding.code, finding.rule || null, finding.message]);
  const baselineFindings = new Set(validateFeatures(baselineLiterals, plan).map(findingKey));
  const featureFindings = validateFeatures(literals, plan);
  for (const finding of featureFindings) {
    const affected = (finding.dependencies || [finding.name]).filter(Boolean)
      .find((name) => selectedNames.has(migrationParameterKey(name)));
    if (finding.severity === 'error' && (affected || operations.length &&
        (!finding.name || !baselineFindings.has(findingKey(finding))))) {
      const row = plan.rows.find((row) => migrationParameterKey(row.name) === migrationParameterKey(affected || finding.name || ''));
      blockers.push({ ...finding, rowId: row?.id || null, scope: affected ? 'selected-dependency' : 'configuration' });
    } else retainFinding(finding);
  }
  unresolved.push(...blockers.map(({ name, code }) => ({ name, code })));
  let after;
  try { after = previewDocumentText(plan.target.text, operations); }
  catch { throw new MigrationError('format'); }
  const rows = migrationRows(plan);
  const summary = {
    accepted: rows.filter((row) => row.decision.kind === 'accept' ||
      row.decision.kind === 'models' && row.structured?.summary?.selectedFields > 0).length,
    unchanged: rows.filter((row) => row.status === 'accepted-unchanged').length,
    copied: rows.filter((row) => row.status === 'copy').length,
    retained: rows.filter((row) => !row.removed && row.status !== 'copy').length,
    removed: rows.filter((row) => row.removed).length,
    unresolved: new Set(unresolved.map((entry) => entry.name)).size,
    unreviewed: rows.filter((row) => row.status === 'unreviewed-retain' ||
      row.decision.kind === 'models' && !row.structured?.keepRest).length,
    blockers: blockers.length,
    changeCount: operations.length,
    modelFieldChanges: rows.reduce((sum, row) => sum + (row.structured?.summary?.changedFields || 0), 0),
    alreadyCurrentValues: rows.reduce((sum, row) => sum + (row.structured
      ? row.structured.summary?.alreadyCurrent || 0 : Number(row.status === 'accepted-unchanged')), 0),
  };
  return {
    operations, after, rows, blockers, unresolved, unverified, summary, classification: migrationClassification(plan),
    changed: after !== plan.target.text,
    canApply: !blockers.length && after !== plan.target.text,
    beforeProjection: diffProjection(plan, false),
    afterProjection: diffProjection(plan, true),
    draft: projectedDraft(plan, true),
  };
}
