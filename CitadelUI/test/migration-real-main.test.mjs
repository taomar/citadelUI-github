import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildMigrationPlan, decideMigration, evaluateMigration, migrationClassification, migrationNameReports,
} from '../shared/parameter-migration.mjs';
import { readMigrationSchema } from '../shared/migration-schema.mjs';
import { validateMigrationFeatures } from '../web/js/migration-validation.mjs';

const evidence = JSON.parse(await readFile(new URL('./migration-real-main-evidence.json', import.meta.url), 'utf8'));

test('migration real-main evidence binds only the user-selected main commit and contains no source values', () => {
  assert.equal(evidence.source.selectedRef, 'refs/heads/main');
  assert.equal(evidence.source.commit, '9ef37ad75a47ca89c179a0db5a4123e60c4c720e');
  assert.equal(evidence.source.tree, '585f6b7fd98a9d09ad9a5215aa2d6f9d0c5c8b66');
  assert.equal(evidence.source.defaultBranchUsed, false);
  assert.equal(evidence.source.otherRefsRead, false);
  assert.equal(evidence.source.rawSourcePersisted, false);
  assert.equal(evidence.inventory.filter((entry) => entry.path.endsWith('.bicepparam')).length, 16);
  assert.equal(evidence.inventory.filter((entry) => entry.path.endsWith('.json')).length, 4);
  for (const entry of evidence.inventory) {
    assert.equal(entry.literal + entry.dynamic, entry.parameters);
    assert.match(entry.blob, /^[a-f0-9]{40}$/);
    assert.equal(Object.hasOwn(entry, 'text'), false);
    assert.equal(Object.hasOwn(entry, 'value'), false);
  }
  assert.equal(evidence.verification.transactionsStarted, 0);
  assert.equal(evidence.verification.realDonorWrites, 0);
  assert.equal(evidence.verification.realDestinationWrites, 0);
});

test('migration real-main evidence distinguishes matched/no-donor counts and accepted-but-unchanged values', () => {
  for (const entry of evidence.focusedCases) {
    assert.equal(entry.counts.length, evidence.countColumns.length);
    const counts = Object.fromEntries(evidence.countColumns.map((name, index) => [name, entry.counts[index]]));
    assert.equal(counts.matched + counts.withoutDonor, counts.targetFields);
    assert.equal(entry.accepted, entry.unchanged + entry.copied);
    assert.equal(entry.changedParameters.length, entry.copied);
    assert.equal(counts.typeMismatch, 0);
    assert.equal(counts.constraintMismatch, 0);
    assert(evidence.destination.targets[entry.target].blockers.length > 0);
  }
  const main = evidence.focusedCases.find((entry) => entry.sources.length === 1 && entry.sources[0] === 'main' && entry.target === 'main');
  assert.equal(main.counts[evidence.countColumns.indexOf('dynamic')], 93);
  assert.equal(main.copied, 0);
  const collision = evidence.focusedCases.find((entry) => entry.sources.includes('resources') && entry.sources.includes('main'));
  assert.equal(collision.counts[evidence.countColumns.indexOf('ambiguous')], 96);
});

test('migration real-main five explicit same-path name reports preserve actual current names and inherited defaults', async () => {
  assert.equal(evidence.samePathPairs.length, 5);
  assert.equal(evidence.samePathPairs.reduce((total, pair) => total + pair.matched, 0), 205);
  for (const pair of evidence.samePathPairs) {
    const text = await readFile(new URL(`../../${pair.path}`, import.meta.url), 'utf8');
    const schemaText = await readFile(new URL(`../../${pair.path.replace(/\.bicepparam$/, '.bicep')}`, import.meta.url), 'utf8');
    // Only names are drawn from the public evidence. Values and declarations
    // below are synthetic, unevaluated inputs, not captured donor settings.
    const plan = buildMigrationPlan({
      target: { alias: pair.path, text, schemaText },
      donors: [{
        id: 'name-evidence', alias: pair.path, format: 'bicepparam',
        text: pair.oldAssignedNames.map((name) => `param ${name} = readEnvironmentVariable('SYNTHETIC_UNEVALUATED')`).join('\n'),
        schemaText: readMigrationSchema(schemaText).definitions
          .filter((definition) => !pair.currentSchemaOnlyNames.includes(definition.name))
          .map((definition) => `param ${definition.name} ${definition.type}`).join('\n'),
      }],
    });
    const [report] = migrationNameReports(plan);
    assert.equal(report.matchedNames.length, pair.matched);
    assert.deepEqual(new Set(report.matchedNames), new Set(pair.oldAssignedNames));
    assert.deepEqual(report.oldOnlyNames, pair.oldOnlyNames);
    assert.deepEqual(report.currentAssignmentsWithoutDonor, pair.currentAssignmentsWithoutDonor);
    assert.deepEqual(report.inheritedDefaultsWithoutDonor, pair.inheritedDefaultsWithoutDonor);
    assert.deepEqual(report.currentSchemaOnlyNames, pair.currentSchemaOnlyNames);
    const evaluation = evaluateMigration(plan);
    assert.equal(evaluation.summary.accepted, 0);
    assert.equal(evaluation.summary.copied, 0);
    assert.equal(evaluation.after === text, true, 'name evidence never changes destination bytes');
    assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_UNEVALUATED|"value":/);
  }
  assert.equal(evidence.samePathPairs.find((pair) => pair.area === 'Deployment').oldExpressionAssignments, 93);
  assert.equal(evidence.samePathPairs.find((pair) => pair.area.includes('Access')).standaloneInstanceCountInSample, 0);
});

// Reduced synthetic shapes grounded in the pinned main input. No real donor
// values or blobs are retained as fixtures, and these tests make no HTTP calls.
function shape({ instances = null, index = 0 } = {}) {
  return [
    ...(instances === null ? [] : [{ name: 'aiFoundryInstances', value: instances }]),
    { name: 'aiFoundryModelsConfig', value: [{ aiserviceIndex: index }] },
  ];
}

test('migration real-main dynamic instance dependency is unresolved, never an invented empty-array mismatch', () => {
  const findings = validateMigrationFeatures(shape());
  assert(findings.some((finding) => finding.code === 'feature-unresolved'));
  assert(!findings.some((finding) => finding.code === 'feature-constraint'));
  assert.match(findings[0].message, /not treated as an empty list/);
});

test('migration real-main dependency fix still rejects known empty instances and intrinsically invalid indices', () => {
  assert(validateMigrationFeatures(shape({ instances: [] })).some((finding) => finding.code === 'feature-constraint'));
  assert(validateMigrationFeatures(shape({ index: -1 })).some((finding) => finding.code === 'feature-constraint'));
  assert(!validateMigrationFeatures(shape({ instances: [{}] })).some((finding) => finding.severity === 'error'));
});

test('migration real-main sensitive dynamic fields remain in both redaction and dynamic counts', () => {
  const plan = buildMigrationPlan({
    target: { text: "param secretValue = ''\n", schemaText: "@secure()\nparam secretValue string = ''\n" },
    donors: [{ id: 'synthetic', alias: 'main.bicepparam', format: 'bicepparam', text: "param secretValue = readEnvironmentVariable('SYNTHETIC_VARIABLE', 'DO_NOT_EVALUATE')\n" }],
  });
  const result = evaluateMigration(plan);
  assert.equal(result.classification.dynamic, 1);
  assert.equal(result.classification.sensitive, 1);
  assert.equal(result.classification.semantic, 1);
  assert(!JSON.stringify(result.rows).includes('SYNTHETIC_VARIABLE'));
  assert(!JSON.stringify(result.rows).includes('DO_NOT_EVALUATE'));
});

test('migration real-main equal accepted values produce no copy count, no artificial diff and no reformatting', () => {
  const text = "using './main.bicep'\n// keep destination documentation\nparam Count = 4\nparam settings = { enabled: true }\n";
  const plan = buildMigrationPlan({
    target: { text, schemaText: 'param Count int\nparam settings object\n' },
    donors: [{ id: 'synthetic', alias: 'main.bicepparam', format: 'bicepparam', text: 'param count = 4\nparam settings = { enabled: true }\n' }],
  });
  for (const row of plan.rows) decideMigration(plan, row.id, { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true });
  const result = evaluateMigration(plan);
  assert.equal(result.summary.accepted, 2);
  assert.equal(result.summary.unchanged, 2);
  assert.equal(result.summary.copied, 0);
  assert.equal(result.summary.retained, 2);
  assert.equal(result.beforeProjection, result.afterProjection);
  assert.equal(result.after, text);
  assert.equal(result.canApply, false);
  assert(result.rows.every((row) => row.status === 'accepted-unchanged'));
});

test('migration real-main reporting counts real edits separately from equal accepted proposals', () => {
  const plan = buildMigrationPlan({
    target: { text: 'param Count = 2\nparam retained = true\n', schemaText: 'param Count int\nparam retained bool\n' },
    donors: [{ id: 'synthetic', alias: 'main.bicepparam', format: 'bicepparam', text: 'param count = 4\nparam retained = true\n' }],
  });
  for (const row of plan.rows) decideMigration(plan, row.id, { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true });
  const result = evaluateMigration(plan);
  assert.equal(result.summary.accepted, 2);
  assert.equal(result.summary.unchanged, 1);
  assert.equal(result.summary.copied, 1);
  assert.equal(result.summary.retained, 1);
  assert.equal(result.operations.length, 1);
});

test('migration real-main classification remains value-free and distinguishes type, constraint and candidate ambiguity', () => {
  const plan = buildMigrationPlan({
    target: {
      text: "param Count = 1\nparam location = 'current'\nparam retained = false\n",
      schemaText: "param Count int\n@allowed(['current'])\nparam location string\nparam retained bool\n",
    },
    donors: [{ id: 'synthetic', alias: 'main.bicepparam', format: 'bicepparam', text: "param count = 'synthetic-type-error'\nparam location = 'synthetic-constraint-error'\nparam location = 'current'\nparam old = true\n" }],
  });
  const counts = migrationClassification(plan);
  assert.equal(counts.typeMismatch, 1);
  assert.equal(counts.constraintMismatch, 1);
  assert.equal(counts.ambiguous, 1);
  assert.equal(counts.withoutDonor, 1);
  assert.equal(counts.removed, 1);
  assert(!JSON.stringify(counts).includes('synthetic-type-error'));
});
