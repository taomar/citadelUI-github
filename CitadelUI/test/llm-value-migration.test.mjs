import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMigrationPlan, decideMigration, decideMigrationModel, evaluateMigration,
  keepMigrationRemaining, migrationRows,
} from '../shared/parameter-migration.mjs';
import { readBicepParameters } from '../shared/migration-input.mjs';
import { serializeValue } from '../shared/bicepparam/serialize.mjs';
import { llmMigrationPolicy, validateMigrationCandidate, validateMigrationFeatures } from '../web/js/migration-validation.mjs';
import { migrationHarness } from './_migration-fixture.mjs';

const PATH = 'bicep/infra/llm-backend-onboarding/main.bicepparam';
const model = (name = 'chat', extra = {}) => ({ name, modelVersion: 'new', modelFormat: 'OpenAI', capacity: 50, ...extra });
const backend = (id, models = [model()], extra = {}) => ({
  backendId: id, backendType: 'ai-foundry', endpoint: `https://${id}.example.invalid/`,
  authType: 'managed-identity', priority: 2, weight: 80, supportedModels: models, ...extra,
});
const text = (value, name = 'llmBackendConfig') => `using './main.bicep'\n// preserve new configuration\nparam ${name} = ${serializeValue(value)}\nparam keepNew = true\n`;
const schema = 'param llmBackendConfig array\nparam keepNew bool\nparam schemaOnly string = \'not a target\'\n';
const data = (value) => JSON.parse(JSON.stringify(value));

function planFor(current, old, options = {}) {
  return buildMigrationPlan({
    target: { alias: PATH, text: text(current, options.name), schemaText: schema },
    donors: [{ id: 'old-file', alias: 'older/llm.bicepparam', format: 'bicepparam',
      text: options.sourceText || text(old), schemaText: null }],
    validateCandidate: validateMigrationCandidate, llmPolicy: llmMigrationPolicy,
  });
}
const root = (plan) => migrationRows(plan).find((row) => row.name.toLowerCase() === 'llmbackendconfig');
function pair(plan, newId, oldId) {
  const row = root(plan);
  const target = row.structured.backends.find((entry) => entry.backendId === newId);
  const source = target.options.find((entry) => entry.backendId === oldId);
  decideMigrationModel(plan, row.id, { kind: 'pair', backendKey: target.key, sourceKey: source.key, confirmed: true });
}
function choose(plan, newId, name, field, kind = 'source') {
  const row = root(plan);
  const target = row.structured.backends.find((entry) => entry.backendId === newId);
  const item = target.models.find((entry) => entry.name === name);
  decideMigrationModel(plan, row.id, { kind, backendKey: target.key, modelKey: item.key, field, reviewed: true });
}

test('new-file assignments alone are editable targets; old/schema-only parameters cannot be added', () => {
  const plan = buildMigrationPlan({
    target: { text: 'param NewName = 2\n', schemaText: 'param NewName int\nparam schemaOnly int = 3\n' },
    donors: [{ id: 'old', alias: 'old.bicepparam', format: 'bicepparam', text: 'param newname = 4\nparam schemaOnly = 5\nparam oldOnly = true\n' }],
  });
  const rows = migrationRows(plan);
  assert.deepEqual(rows.filter((row) => !row.removed).map((row) => row.name), ['NewName']);
  for (const row of rows.filter((row) => row.removed)) {
    assert.throws(() => decideMigration(plan, row.id, { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true }), { code: 'decision' });
  }
  const target = rows[0];
  decideMigration(plan, target.id, { kind: 'accept', candidateId: target.candidates[0].id, semanticReviewed: true });
  const result = evaluateMigration(plan);
  assert.deepEqual(result.operations, [{ op: 'set', path: ['NewName'], value: 4, preserveComments: true }]);
  assert.doesNotMatch(result.after, /schemaOnly|oldOnly/);
});

test('backend confirmation is explicit; different aif/aaif prefixes are never normalized into a match', () => {
  const plan = planFor([backend('aaif-new')], [backend('aif-old', [model('chat', { capacity: 90 })])]);
  const row = root(plan);
  const target = row.structured.backends[0];
  assert.equal(target.suggestion, null);
  assert.equal(target.confirmedSource, null);
  assert.equal(target.models[0].fields.length, 0);
  assert.throws(() => choose(plan, 'aaif-new', 'chat', 'capacity'), { code: 'decision' });
  assert.throws(() => decideMigrationModel(plan, row.id, {
    kind: 'pair', backendKey: target.key, sourceKey: target.options[0].key, confirmed: false,
  }), { code: 'decision' });
  pair(plan, 'aaif-new', 'aif-old');
  assert.ok(root(plan).structured.backends[0].confirmedSource);
});

test('reviewed model fields stay inside the paired backend and preserve new-only data and ordering', () => {
  const current = [
    backend('new-a', [model('new-only'), model('chat', { extraNewField: 'keep' })], { extraBackendField: 'keep' }),
    backend('new-b', [model('chat', { capacity: 7 })]),
  ];
  const old = [
    backend('old-b', [model('chat', { capacity: 999 })]),
    backend('old-a', [model('old-only'), model('chat', { capacity: 90, modelVersion: 'old-version', timeout: 60 })]),
  ];
  const plan = planFor(current, old);
  pair(plan, 'new-a', 'old-a');
  choose(plan, 'new-a', 'chat', 'capacity');
  choose(plan, 'new-a', 'chat', 'timeout');
  keepMigrationRemaining(plan);
  const result = evaluateMigration(plan, validateMigrationFeatures);
  const final = readBicepParameters(result.after).parameters.find((entry) => entry.name === 'llmBackendConfig').value;
  const expected = structuredClone(current);
  expected[0].supportedModels[1].capacity = 90;
  expected[0].supportedModels[1].timeout = 60;
  assert.deepEqual(data(final), expected);
  assert(result.operations.every((operation) => operation.path[0] === 'llmBackendConfig' && operation.path[1] === 0 && operation.path[3] === 1));
  assert(result.operations.every((operation) => ['set', 'addProperty'].includes(operation.op) && operation.path.length > 1));
  assert.match(result.after, /preserve new configuration/);
  assert.match(result.draft, /capacity: 90/);
  assert.match(result.afterProjection, /new-a \/ chat \/ capacity = 90/);
  assert.equal(result.canApply, true);
  assert.equal(root(plan).structured.backends[0].unmatchedSourceModels[0].status, 'excluded');
});

test('reordered new and old arrays still resolve by the explicitly selected backend and model identities', () => {
  const plan = planFor(
    [backend('new-b'), backend('new-a', [model('other'), model('chat')])],
    [backend('old-a', [model('chat', { capacity: 91 }), model('other')]), backend('old-b')],
  );
  pair(plan, 'new-a', 'old-a');
  choose(plan, 'new-a', 'chat', 'capacity');
  keepMigrationRemaining(plan);
  assert.deepEqual(evaluateMigration(plan, validateMigrationFeatures).operations[0].path,
    ['llmBackendConfig', 1, 'supportedModels', 1, 'capacity']);
});

test('a same-name model in another old backend cannot supply a candidate', () => {
  const plan = planFor([backend('new-a')], [backend('old-a', [model('different')]), backend('old-b')]);
  pair(plan, 'new-a', 'old-a');
  const item = root(plan).structured.backends[0].models[0];
  assert.match(item.issue, /No exact model identity/);
  assert.equal(item.fields.length, 0);
  assert.throws(() => choose(plan, 'new-a', 'chat', 'capacity'), { code: 'decision' });
});

test('unknown providers and duplicate backend/model identities remain visible and cannot be guessed', () => {
  for (const old of [
    [backend('old', undefined, { backendType: 'unknown-provider' })],
    [backend('old'), backend('old')],
    [backend('old', undefined, { backendType: 'azure-openai' })],
  ]) {
    const plan = planFor([backend('new')], old);
    assert(root(plan).structured.backends[0].options.every((option) => !option.eligible));
    assert.throws(() => pair(plan, 'new', 'old'), { code: 'decision' });
  }
  const duplicateModels = planFor([backend('new')], [backend('old', [model(), model('chat', { modelVersion: 'another' })])]);
  pair(duplicateModels, 'new', 'old');
  assert.match(root(duplicateModels).structured.backends[0].models[0].issue, /ambiguous/);
  assert.throws(() => choose(duplicateModels, 'new', 'chat', 'capacity'), { code: 'decision' });
});

test('FLUX routing identity and version/format/API differences are explicit, with no default selection', () => {
  const flux = planFor(
    [backend('new', [model('image', { modelPath: 'flux-one' })], { backendType: 'azure-flux' })],
    [backend('old', [model('image', { modelPath: 'flux-other' })], { backendType: 'azure-flux' })],
  );
  pair(flux, 'new', 'old');
  assert.match(root(flux).structured.backends[0].models[0].issue, /routing identity/);
  const plan = planFor([backend('new', [model('custom-deployment', { apiVersion: 'new-api' })])],
    [backend('old', [model('custom-deployment', { modelVersion: 'old', modelFormat: 'Microsoft', apiVersion: 'old-api' })])]);
  pair(plan, 'new', 'old');
  const fields = root(plan).structured.backends[0].models[0].fields;
  for (const key of ['modelVersion', 'modelFormat', 'apiVersion']) {
    const field = fields.find((entry) => entry.key === key);
    assert(field.differs && field.needsReview && !field.selected);
  }
});

test('whole-array accept is refused in both decision and evaluation paths', () => {
  const plan = planFor([backend('new')], [backend('old')]);
  const row = root(plan);
  const bypass = { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true };
  assert.throws(() => decideMigration(plan, row.id, bypass), { code: 'decision' });
  plan.decisions.set(row.id, bypass);
  assert.throws(() => evaluateMigration(plan), { code: 'decision' });
});

test('model comparison counts distinguish absent old fields, equal fields, and optional source-only fields', () => {
  const plan = planFor(
    [backend('new', [model('chat', { timeout: 30 })])],
    [backend('old', [model('chat', { capacity: 90, apiVersion: '2026-01-01' })])],
  );
  pair(plan, 'new', 'old');
  const review = root(plan).structured;
  const fields = review.backends[0].models[0].fields;
  assert.equal(fields.find((field) => field.key === 'timeout').comparison, 'target-only');
  assert.equal(fields.find((field) => field.key === 'modelVersion').comparison, 'same');
  assert.equal(fields.find((field) => field.key === 'capacity').comparison, 'different');
  assert.equal(fields.find((field) => field.key === 'apiVersion').comparison, 'source-only');
  assert.equal(review.summary.comparisons['target-only'], 1);
  assert.equal(review.summary.comparisons.same, fields.filter((field) => field.comparison === 'same').length);
  choose(plan, 'new', 'chat', 'capacity');
  pair(plan, 'new', 'old');
  assert.equal(root(plan).structured.summary.selectedFields, 1, 'confirming the already confirmed pair is not a destructive re-pair');
});

test('unchecking a selected model field or keeping the parameter restores the unchanged new values', () => {
  const plan = planFor([backend('new')], [backend('old', [model('chat', { capacity: 90 })])]);
  pair(plan, 'new', 'old');
  choose(plan, 'new', 'chat', 'capacity');
  choose(plan, 'new', 'chat', 'capacity', 'keep');
  keepMigrationRemaining(plan);
  let result = evaluateMigration(plan, validateMigrationFeatures);
  assert.equal(result.after, plan.target.text);
  assert.equal(result.changed, false);
  choose(plan, 'new', 'chat', 'capacity');
  decideMigration(plan, root(plan).id, { kind: 'keep' });
  result = evaluateMigration(plan, validateMigrationFeatures);
  assert.equal(result.operations.length, 0);
});

test('sensitive and unresolved structures never become giant editable array fallbacks', () => {
  const dynamic = planFor([backend('new')], [], { sourceText: "param llmBackendConfig = readEnvironmentVariable('SYNTHETIC_EXPRESSION')\n" });
  assert.equal(root(dynamic).structured.backends[0].options.length, 0);
  assert.equal(root(dynamic).structured.sourceIssues.length, 1);
  const sensitive = planFor([backend('new')], [backend('old', undefined, { authConfig: { secretValue: 'SYNTHETIC_PRIVATE_MARKER' } })]);
  assert.doesNotMatch(JSON.stringify(migrationRows(sensitive)), /SYNTHETIC_PRIVATE_MARKER/);
  assert.equal(root(sensitive).structured.backends[0].options.length, 0);
});

test('structured choices feed the real local preview/draft/transaction path, not only a report', async () => {
  const current = [backend('new')];
  const old = [backend('old', [model('chat', { capacity: 90 })])];
  const h = migrationHarness({
    targetFiles: { [PATH]: text(current), [PATH.replace(/\.bicepparam$/, '.bicep')]: schema },
    donorText: text(old),
  });
  let view = await h.plan({ targetAlias: PATH });
  const row = view.rows.find((entry) => entry.structured);
  const target = row.structured.backends[0];
  h.session.decideModel(row.id, { kind: 'pair', backendKey: target.key, sourceKey: target.options[0].key, confirmed: true });
  view = h.session.view();
  const item = view.rows.find((entry) => entry.structured).structured.backends[0].models[0];
  h.session.decideModel(row.id, { kind: 'source', backendKey: target.key, modelKey: item.key, field: 'capacity', reviewed: true });
  const preview = await h.session.previewSelected();
  assert.equal(preview.canApply, true);
  assert.match(preview.after, /new \/ chat \/ capacity = 90/);
  assert.match((await h.session.export(preview.id, 'draft')).text, /capacity: 90/);
  await h.session.apply(preview.id, { reviewed: true });
  assert.match((await h.provider.read(PATH)).text, /capacity: 90/);
  assert.equal(h.api.trace.filter((entry) => entry === 'prepare').length, 1);
  assert(!h.donorTrace.some((entry) => /^(?:write|writable):/.test(entry)));
});
