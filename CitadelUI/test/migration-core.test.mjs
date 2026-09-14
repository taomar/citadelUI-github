import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildMigrationPlan, decideMigration, evaluateMigration, migrationNameReports, migrationRows } from '../shared/parameter-migration.mjs';
import { inspectArmParameterJson, MigrationError, MIGRATION_LIMITS, readArmParameters, readBicepParameters } from '../shared/migration-input.mjs';
import { readMigrationSchema } from '../shared/migration-schema.mjs';
import { validateMigrationFeatures } from '../web/js/migration-validation.mjs';

function plan({ target = "using './current.bicep'\nparam Count = 2\nparam fresh = true\n", schema = 'param Count int\nparam fresh bool = true\n', sources = [{ text: 'param count = 4\nparam retired = false\n' }] } = {}) {
  return buildMigrationPlan({
    target: { alias: 'current.bicepparam', text: target, schemaText: schema },
    donors: sources.map((source, index) => ({ id: `source-${index}`, alias: `old-${index}.bicepparam`, format: 'bicepparam', ...source })),
  });
}

function row(model, name) { return model.rows.find((entry) => entry.name.toLowerCase() === name.toLowerCase()); }
function accept(model, name, index = 0) {
  const entry = row(model, name);
  decideMigration(model, entry.id, { kind: 'accept', candidateId: entry.candidates[index].id, semanticReviewed: true });
}
function keepRest(model) {
  for (const entry of model.rows) if (!entry.removed && !model.decisions.has(entry.id)) decideMigration(model, entry.id, { kind: 'keep' });
}
function arm(parameters) {
  return `{"$schema":"https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#","contentVersion":"1.0.0.0","parameters":{${parameters}}}`;
}

test('migration exact names preserve current casing, using, comments, CRLF, and new defaults', () => {
  const target = "using './current.bicep'\r\n// current documentation\r\nparam Count = 2 // retain inline\r\nparam fresh = true\r\n";
  const model = plan({ target });
  const rows = migrationRows(model);
  assert(rows.find((entry) => entry.name === 'Count').categories.includes('exact-match'));
  assert(rows.find((entry) => entry.name === 'Count').categories.includes('semantic-review'));
  assert.deepEqual(rows.find((entry) => entry.name === 'fresh').categories, ['no-donor']);
  assert(rows.find((entry) => entry.name === 'retired').categories.includes('removed-donor'));
  assert.equal(evaluateMigration(model).after, target, 'unreviewed proposals never replace defaults');
  accept(model, 'Count');
  const result = evaluateMigration(model);
  assert.equal(result.after, target.replace('Count = 2', 'Count = 4'));
  assert.equal(result.canApply, true);
  assert.equal(result.summary.removed, 1);
});

test('safe independent patches retain unresolved deployment values without certifying or evaluating them', () => {
  const model = plan({
    target: "param environmentName = 'new'\nparam aiFoundryInstances = readEnvironmentVariable('UNRESOLVED_INSTANCES')\nparam aiFoundryModelsConfig = [{ aiserviceIndex: 0 }]\n",
    schema: 'param environmentName string\nparam aiFoundryInstances array\nparam aiFoundryModelsConfig array\n',
    sources: [{ text: "param environmentName = 'reviewed'\n" }],
  });
  accept(model, 'environmentName');
  keepRest(model);
  const result = evaluateMigration(model, validateMigrationFeatures);
  assert.equal(result.canApply, true);
  assert.deepEqual(result.operations.map((operation) => operation.path), [['environmentName']]);
  assert.equal(result.after, model.target.text.replace("'new'", "'reviewed'"));
  assert(result.unverified.some((finding) => finding.code === 'feature-unresolved'));
  assert.doesNotMatch(result.draft, /UNRESOLVED_INSTANCES/);
});

test('changing a dependency blocks even when the affected field is retained and its baseline was valid', () => {
  const model = plan({
    target: "param aiFoundryInstances = [{ name: 'first' }, { name: 'second' }]\nparam aiFoundryModelsConfig = [{ aiserviceIndex: 1 }]\n",
    schema: 'param aiFoundryInstances array\nparam aiFoundryModelsConfig array\n',
    sources: [{ text: "param aiFoundryInstances = [{ name: 'only' }]\n" }],
  });
  accept(model, 'aiFoundryInstances');
  keepRest(model);
  const result = evaluateMigration(model, validateMigrationFeatures);
  assert.equal(result.canApply, false);
  const finding = result.blockers.find((finding) => finding.name === 'aiFoundryModelsConfig');
  assert.equal(finding.scope, 'selected-dependency');
  assert.equal(finding.rowId, migrationRows(model).find((row) => row.name === 'aiFoundryInstances').id);
});

test('selected changes cannot bypass unknown validation of dependencies or the selected configuration', () => {
  const model = plan({
    target: "param useTargetFoundry = false\nparam foundry = readEnvironmentVariable('UNAVAILABLE_COORDINATES')\n",
    schema: 'param useTargetFoundry bool\nparam foundry object\n',
    sources: [{ text: 'param useTargetFoundry = true\n' }],
  });
  accept(model, 'useTargetFoundry');
  keepRest(model);
  const result = evaluateMigration(model, validateMigrationFeatures);
  assert.equal(result.canApply, false);
  assert(result.blockers.some((finding) => finding.dependencies?.includes('foundry') && finding.rowId));
  const unknown = plan();
  accept(unknown, 'Count');
  assert.equal(evaluateMigration(unknown, () => [{
    name: null, code: 'feature-constraint', severity: 'error', message: 'Synthetic validator cannot establish safety.',
  }]).canApply, false);
});

test('an unchanged unrelated existing validator finding is reported but a newly selected invalid value still blocks', () => {
  const model = plan({
    target: "param environmentName = 'new'\nparam apimSku = 'Developer'\nparam apimSkuUnits = 8\n",
    schema: 'param environmentName string\nparam apimSku string\nparam apimSkuUnits int\n',
    sources: [{ text: "param environmentName = 'old'\nparam apimSkuUnits = 9\n" }],
  });
  accept(model, 'environmentName');
  keepRest(model);
  let result = evaluateMigration(model, validateMigrationFeatures);
  assert.equal(result.canApply, true);
  assert(result.unverified.some((finding) => finding.name === 'apimSkuUnits'));
  accept(model, 'apimSkuUnits');
  result = evaluateMigration(model, validateMigrationFeatures);
  assert.equal(result.canApply, false);
  assert(result.blockers.some((finding) => finding.name === 'apimSkuUnits'));
});

test('migration never copies by position, fuzzy rename, or from an unpaired donor', () => {
  const model = plan({ sources: [{ text: 'param countOld = 7\nparam COUNT_TWO = 9\n' }] });
  assert.equal(row(model, 'Count').candidates.length, 0);
  assert.equal(evaluateMigration(model).after, model.target.text);
  assert.equal(evaluateMigration(model).summary.removed, 2);
});

test('migration replacements require an explicit per-candidate semantic review decision', () => {
  const model = plan();
  const entry = row(model, 'Count');
  assert.throws(() => decideMigration(model, entry.id, { kind: 'accept', candidateId: entry.candidates[0].id }), MigrationError);
  assert.equal(evaluateMigration(model).canApply, false);
  decideMigration(model, entry.id, { kind: 'keep' });
  assert.equal(evaluateMigration(model).summary.unreviewed, 0);
  assert.equal(evaluateMigration(model).after, model.target.text);
});

test('migration scoped same-name collisions are explicit candidates, never last-wins', () => {
  const model = plan({ sources: [
    { text: 'param count = 3\nparam Count = 5\n' },
    { text: 'param count = 7\n' },
  ] });
  const entry = row(model, 'Count');
  assert.equal(entry.candidates.length, 3);
  assert(entry.categories.includes('ambiguous'));
  assert(evaluateMigration(model).blockers.some((item) => item.code === 'decision'));
  accept(model, 'Count', 1);
  assert.match(evaluateMigration(model).after, /param Count = 5/);
  assert.equal(evaluateMigration(model).summary.copied, 1);
  assert.equal(evaluateMigration(model).summary.unresolved, 0, 'choosing one candidate resolves its ambiguity');
});

test('migration per-file name reports separate paired sources and distinguish inherited defaults from schema additions', () => {
  const model = plan({
    target: 'param Count = 2\nparam fresh = true\n',
    schema: 'param Count int\nparam fresh bool = true\nparam inherited int = 1\nparam omitted int = 3\n',
    sources: [
      { text: 'param count = 4\nparam retired = false\n', schemaText: 'param count int\nparam retired bool\nparam inherited int = 1\n' },
      { format: 'json', text: arm('"omitted":{"value":5},"Legacy.Feature.Flag":{"value":true}') },
    ],
  });
  const reports = migrationNameReports(model);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0].matchedNames, ['Count']);
  assert.deepEqual(reports[0].oldOnlyNames, ['retired']);
  assert.deepEqual(reports[0].currentAssignmentsWithoutDonor, ['fresh']);
  assert.deepEqual(reports[0].inheritedDefaultsWithoutDonor, []);
  assert.deepEqual(reports[0].currentSchemaOnlyNames, ['fresh', 'omitted']);
  assert.deepEqual(reports[1].matchedNames, []);
  assert.deepEqual(reports[1].oldOnlyNames, ['omitted', 'Legacy.Feature.Flag']);
  assert.deepEqual(reports[1].donorSuppliedSchemaFieldsNotAssigned, []);
  assert.equal(reports[1].currentSchemaOnlyNames, null, 'missing old schema cannot establish a version addition');
  assert.equal(evaluateMigration(model).after, model.target.text, 'a name report never accepts schema-only proposals');
  assert.doesNotMatch(JSON.stringify(reports), /"value":/);
});

test('migration name report empty old-only lists and duplicate identifiers remain explicit', () => {
  const model = plan({ sources: [{ text: 'param count = 4\nparam Count = 6\n' }] });
  const [report] = migrationNameReports(model);
  assert.deepEqual(report.oldOnlyNames, []);
  assert.deepEqual(report.duplicateDonorNames, ['count', 'Count']);
  assert.deepEqual(report.matchedNames, ['Count']);
});

test('migration old-only values are withheld even when their innocuous names and values do not look sensitive', () => {
  const marker = 'UNUSED_PRIVATE_CONFIGURATION_MARKER';
  const model = plan({ sources: [{ text: `param count = 4\nparam obsoleteSetting = '${marker}'\n` }] });
  accept(model, 'Count');
  const result = evaluateMigration(model);
  const removed = result.rows.find((row) => row.removed);
  assert.equal(removed.name, 'obsoleteSetting');
  assert.equal(removed.candidates[0].type, 'string');
  assert.match(removed.candidates[0].value, /withheld: old-only/);
  assert.equal(model.rows.find((row) => row.removed).candidates[0].value, undefined);
  for (const output of [result.rows, result.beforeProjection, result.afterProjection, result.draft, migrationNameReports(model)]) {
    assert(!JSON.stringify(output).includes(marker));
  }
  assert.equal(result.canApply, true);
  assert.match(result.after, /param Count = 4/);
  assert.doesNotMatch(result.after, /obsoleteSetting/);
});

test('migration duplicates in the destination or schema cannot be resolved by last-wins', () => {
  for (const input of [
    { target: 'param Count = 2\nparam count = 3\n' },
    { schema: 'param Count int\nparam count int\n' },
  ]) {
    const model = plan(input);
    assert(row(model, 'Count').categories.includes('ambiguous'));
    assert.equal(row(model, 'Count').candidates[0].eligible, false);
    keepRest(model);
    assert(evaluateMigration(model).blockers.some((entry) => entry.code === 'ambiguous'));
  }
});

for (const expression of [
  "readEnvironmentVariable('IGNORED', 'fallback')",
  "int(readEnvironmentVariable('IGNORED', '4'))",
  'anotherParameter',
  "'${anotherParameter}'",
  "[ { nested: readEnvironmentVariable('IGNORED', 'fallback') } ]",
  "[ { nested: '${anotherParameter}' } ]",
  "{ nested: [ anotherParameter ] }",
  "2 + 3",
  "'safe' == 'unsafe'",
  "{ endpoint: '${format('hidden', anotherParameter)}' }",
]) {
  test(`migration treats ${expression.split('(')[0].slice(0, 32)} as opaque, including nested dynamic expressions`, () => {
    const model = plan({ sources: [{ text: `param count = ${expression}\n` }] });
    assert.equal(row(model, 'Count').candidates[0].category, 'dynamic');
    assert.equal(row(model, 'Count').candidates[0].eligible, false);
    const output = JSON.stringify(migrationRows(model));
    assert.doesNotMatch(output, /IGNORED|fallback|anotherParameter/);
  });
}

test('migration handles escaped interpolation and literal multiline strings without evaluating them', () => {
  const input = readBicepParameters("param escaped = '\\${literal}'\nparam block = '''${alsoLiteral}'''\n");
  assert.equal(input.parameters[0].status, 'literal');
  assert.equal(input.parameters[0].value, '${literal}');
  assert.equal(input.parameters[1].status, 'literal');
});

test('migration rejects scripts, inherited declarations, partial target expressions and malformed text with sanitized errors', () => {
  for (const source of [
    "var hidden = 'SYNTHETIC_PRIVATE_MARKER'\nparam count = 3\n",
    "extends 'older.bicepparam'\nparam count = 3\n",
    "param count = 'SYNTHETIC_PRIVATE_MARKER\n",
    '/* unclosed SYNTHETIC_PRIVATE_MARKER',
    "param count = '''SYNTHETIC_PRIVATE_MARKER",
    'Write-Host SYNTHETIC_PRIVATE_MARKER',
  ]) {
    assert.throws(() => readBicepParameters(source), (error) =>
      error instanceof MigrationError && !error.message.includes('SYNTHETIC_PRIVATE_MARKER'));
  }
  assert.throws(() => readBicepParameters('param count = 2 + 3\n', { target: true }), MigrationError);
});

for (const [type, value, decorators] of [
  ['int', "'4'", ''],
  ['bool', "'true'", ''],
  ['string', 'true', ''],
  ['array', '{}', ''],
  ['object', '[]', ''],
  ['string', "'Classic'", "@allowed(['Current', 'Modern'])\n"],
  ['int', '0', '@minValue(1)\n'],
  ['int', '9', '@maxValue(8)\n'],
  ['string', "'a'", '@minLength(2)\n'],
  ['string', "'abcd'", '@maxLength(3)\n'],
  ['array', '[1]', '@minLength(2)\n'],
  ['array', '[1,2,3]', '@maxLength(2)\n'],
]) {
  test(`migration rejects ${type} type/current constraint mismatch ${decorators.trim() || value}`, () => {
    const model = plan({ schema: `${decorators}param Count ${type}\n`, sources: [{ text: `param count = ${value}\n` }] });
    assert.equal(row(model, 'Count').candidates[0].category, 'mismatch');
    assert.throws(() => accept(model, 'Count'), MigrationError);
  });
}

for (const schema of [
  'param Count string[]\n',
  'param Count string?\n',
  'param Count string | int\n',
  'type Coordinate = { name: string }\nparam Count Coordinate\n',
  'param Count { child: { name: string } }\n',
  '@allowed(availableValues)\nparam Count int\n',
  '@minValue(minimum)\nparam Count int\n',
  '@customValidation()\nparam Count int\n',
  '@allowed([1,2])\nparam Count array\n',
]) {
  test(`migration does not certify unsupported schema ${schema.split('\n').filter(Boolean).at(-1)}`, () => {
    const model = plan({ schema });
    assert.equal(row(model, 'Count').candidates[0].category, 'unknown-schema');
    assert.equal(row(model, 'Count').candidates[0].eligible, false);
    keepRest(model);
    const result = evaluateMigration(model);
    assert(result.unverified.length > 0);
    assert.equal(result.canApply, false, 'no change is authorized through an unsupported schema');
    assert.throws(() => accept(model, 'Count'), { code: 'decision' });
  });
}

test('migration bare collection types remain explicit semantic review, not nested compatibility proof', () => {
  const model = plan({
    target: 'param data = []\n', schema: "@description('Current array contract')\nparam data array\n",
    sources: [{ text: "param data = [{ region: 'west' size: 2 }]\n" }],
  });
  const entry = migrationRows(model)[0];
  assert.equal(entry.candidates[0].eligible, true);
  assert.match(entry.guidance.validation, /nested semantics/);
  assert(entry.categories.includes('semantic-review'));
  assert(!entry.categories.includes('exact-match'), 'untyped nested collections are not certified compatible');
});

test('migration collection replacements retain destination comment templates and do not reformat equal values', () => {
  const target = "using './current.bicep'\r\nparam data = [\r\n  // Keep this current template\r\n  /* and this\r\n     explanation */\r\n]\r\n";
  const model = plan({
    target, schema: 'param data array\n',
    sources: [{ text: "param data = [{ label: 'synthetic' }]\n" }],
  });
  accept(model, 'data');
  const result = evaluateMigration(model);
  assert.match(result.after, /\/\/ Keep this current template\r\n/);
  assert.match(result.after, /\/\* and this\r\n     explanation \*\//);
  assert.match(result.after, /label: 'synthetic'/);
  assert.equal(readBicepParameters(result.after).parameters[0].value[0].label, 'synthetic');
  const unchanged = plan({ target, schema: 'param data array\n', sources: [{ text: 'param data = []\n' }] });
  accept(unchanged, 'data');
  assert.equal(evaluateMigration(unchanged).after, target);
});

test('migration does not add schema-only parameters to a new file without assignments', () => {
  const model = plan({
    target: "using './current.bicep'\n// original file\n",
    schema: 'param first int\nparam second bool\n',
    sources: [{ text: 'param first = 3\nparam second = true\n' }],
  });
  assert.throws(() => accept(model, 'first'), { code: 'decision' });
  assert.throws(() => accept(model, 'second'), { code: 'decision' });
  const result = evaluateMigration(model);
  assert.equal(result.after, model.target.text);
  assert.equal(result.operations.length, 0);
  assert(result.blockers.every((entry) => entry.scope === 'retained-destination'));
});

test('migration unknown typed schemas with potentially inherited secure annotations do not disclose values', () => {
  const marker = 'SYNTHETIC_PRIVATE_MARKER';
  const schema = '@secure()\ntype PrivateValue = string\nparam ordinary PrivateValue\n';
  const targetUnknown = plan({
    target: `param ordinary = '${marker}'\n`, schema,
    sources: [{ text: "param ordinary = 'ignored'\n" }],
  });
  assert(!JSON.stringify(migrationRows(targetUnknown)).includes(marker));
  const donorUnknown = plan({
    target: "param ordinary = 'current'\n", schema: 'param ordinary string\n',
    sources: [{ text: `param ordinary = '${marker}'\n`, schemaText: schema }],
  });
  assert.equal(row(donorUnknown, 'ordinary').candidates[0].eligible, false);
  assert.equal(row(donorUnknown, 'ordinary').candidates[0].value, undefined);
  assert(!JSON.stringify(migrationRows(donorUnknown)).includes(marker));
});

test('migration malformed supplied donor schemas cannot silently drop unknown secure metadata', () => {
  const model = plan({
    target: "param ordinary = 'current'\n", schema: 'param ordinary string\n',
    sources: [{
      text: "param ordinary = 'SYNTHETIC_PRIVATE_MARKER'\n",
      schemaText: "@secure()\nparam ordinary string = 'malformed\n",
    }],
  });
  const candidate = row(model, 'ordinary').candidates[0];
  assert.equal(candidate.eligible, false);
  assert.equal(candidate.category, 'unknown-schema');
  assert.equal(candidate.donorSchema, 'unsupported');
  assert.equal(candidate.value, undefined);
  assert.doesNotMatch(JSON.stringify(migrationRows(model)), /SYNTHETIC_PRIVATE_MARKER/);
});

test('migration reports omitted required fields without adding them or blocking an unrelated literal patch', () => {
  const model = plan({
    target: "using './current.bicep'\nparam label = '<your-resource-name>'\n",
    schema: "param label string\nparam requiredCount int\nparam newFlag bool = true\nparam reference string = resourceGroup().location\n",
    sources: [{ text: "param label = 'current-resource'\nparam requiredCount = 3\n" }],
  });
  const before = evaluateMigration(model);
  assert(before.unverified.some((entry) => entry.name === 'requiredCount'));
  accept(model, 'label');
  assert.throws(() => accept(model, 'requiredCount'), { code: 'decision' });
  const result = evaluateMigration(model);
  assert.equal(result.canApply, true);
  assert.doesNotMatch(result.after, /param requiredCount/);
  assert.doesNotMatch(result.after, /param newFlag|param reference/);
  assert(result.unverified.some((entry) => entry.name === 'requiredCount' && entry.scope === 'retained-destination'));
  assert.deepEqual(result.operations.map((operation) => operation.path), [['label']]);
});

test('migration preserves dynamic current expressions when kept, but does not certify required fallback values', () => {
  const target = "param Count = int(readEnvironmentVariable('COUNT', '3'))\n";
  const model = plan({ target });
  keepRest(model);
  assert.equal(evaluateMigration(model).after, target);
  assert(evaluateMigration(model).unverified.some((entry) => entry.code === 'required'));
  accept(model, 'Count');
  assert.equal(evaluateMigration(model).canApply, true);
});

test('migration explicitly allowed empty required strings do not block an unrelated reviewed change', () => {
  const target = "param prefix = ''\nparam count = 1\n";
  const model = plan({
    target,
    schema: "@allowed([''])\nparam prefix string\nparam count int\n",
    sources: [{ text: 'param count = 2\n' }],
  });
  accept(model, 'count');
  const result = evaluateMigration(model);
  assert.equal(result.canApply, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.after, target.replace('count = 1', 'count = 2'));
});

test('retained invalid strings remain unverified; selecting an invalid value is still a hard blocker', () => {
  for (const decorators of ['', "@allowed(['configured'])\n", "@allowed([''])\n@minLength(1)\n"]) {
    const model = plan({
      target: "param prefix = ''\nparam count = 1\n",
      schema: `${decorators}param prefix string\nparam count int\n`,
      sources: [{ text: 'param count = 2\n' }],
    });
    accept(model, 'count');
    const result = evaluateMigration(model);
    assert.equal(result.canApply, true);
    assert(result.unverified.some((entry) => entry.name === 'prefix'));
    assert.equal(result.after, model.target.text.replace('count = 1', 'count = 2'));
  }
  const selected = plan({ target: "param prefix = 'configured'\n", schema: 'param prefix string\n', sources: [{ text: "param prefix = ''\n" }] });
  accept(selected, 'prefix');
  assert.equal(evaluateMigration(selected).canApply, false);
  assert(evaluateMigration(selected).blockers.some((entry) => entry.name === 'prefix'));
});

test('migration secure fields, donor-only @secure, nested credentials, and unsafe URLs are redacted and never copyable', () => {
  const marker = 'SYNTHETIC_PRIVATE_MARKER';
  for (const [name, value, targetSchema, donorSchema] of [
    ['password', `'${marker}'`, 'param password string', null],
    ['ordinary', `'${marker}'`, '@secure()\nparam ordinary string', null],
    ['ordinary', `'${marker}'`, 'param ordinary string\n@secure()\nparam ordinary string', null],
    ['ordinary', `'${marker}'`, 'param ordinary string', '@secure()\nparam ordinary string'],
    ['config', `{ authConfig: { secretValue: '${marker}' } }`, 'param config object', null],
    ['config', `[{ accountKey: '${marker}' }]`, 'param config array', null],
    ['config', `[{ headers: { Authorization: '${marker}' } }]`, 'param config array', null],
    ['config', `{ auth: { key: '${marker}' } }`, 'param config object', null],
    ['endpoint', `'https://example.invalid/?token=${marker}'`, 'param endpoint string', null],
  ]) {
    const model = plan({
      target: `// ${marker} must never appear in a projected diff/export\nparam ${name} = ${name === 'config' ? value.startsWith('[') ? '[]' : '{}' : "'unchanged'"}\n`,
      schema: `${targetSchema}\n`,
      sources: [{ text: `param ${name} = ${value}\n`, schemaText: donorSchema }],
    });
    assert.equal(row(model, name).candidates[0].category, 'sensitive');
    assert.throws(() => accept(model, name), MigrationError);
    keepRest(model);
    const result = evaluateMigration(model);
    for (const data of [migrationRows(model), result.draft, result.beforeProjection, result.afterProjection]) {
      assert(!JSON.stringify(data).includes(marker));
    }
    assert.equal(row(model, name).candidates[0].value, undefined);
    assert.equal(result.after, model.target.text);
  }
});

test('migration opaque high-entropy credentials and reserved serializer marker objects cannot become source code', () => {
  const opaque = 'Abc123'.repeat(10);
  const model = plan({ sources: [{ text: `param count = '${opaque}'\n` }] });
  assert.equal(row(model, 'Count').candidates[0].category, 'sensitive');
  for (const value of ["{ __expr: 'call' raw: 'untrustedCode()' }", "{ a: 1 A: 2 }"]) {
    const parsed = readBicepParameters(`param data = ${value}\n`);
    assert.equal(parsed.parameters[0].status, 'ambiguous');
  }
});

test('migration strict ARM deploymentParameters adapter preserves duplicates as candidates', () => {
  const model = plan({ sources: [{ format: 'json', alias: 'old.parameters.json', text: arm('"count":{"value":3},"co\\u0075nt":{"value":6}') }] });
  assert.equal(row(model, 'Count').candidates.length, 2);
  assert(row(model, 'Count').categories.includes('ambiguous'));
  accept(model, 'Count', 0);
  assert.match(evaluateMigration(model).after, /param Count = 3/);
});

test('migration ARM dotted legacy names are reported without rejecting matching current settings or inventing aliases', () => {
  const model = plan({
    sources: [{
      format: 'json', alias: 'old.parameters.json',
      text: arm('"count":{"value":3},"Legacy.Feature.Flag":{"value":true},"Count.Old":{"value":7}'),
    }],
  });
  assert.deepEqual(migrationRows(model).filter((entry) => entry.removed).map((entry) => entry.name),
    ['Legacy.Feature.Flag', 'Count.Old']);
  assert.equal(row(model, 'Count').candidates.length, 1);
  accept(model, 'Count');
  const result = evaluateMigration(model);
  assert.equal(result.canApply, true);
  assert.equal(result.summary.removed, 2);
  assert.match(result.after, /param Count = 3/);
  assert.doesNotMatch(result.after, /Legacy|Count\.Old/);
  assert.doesNotMatch(result.draft, /Legacy|Count\.Old/);
  assert.throws(() => readBicepParameters('param Legacy.Feature.Flag = true\n', { target: true }), MigrationError);
});

test('migration ARM donor labels are bounded and cannot disclose unsafe names', () => {
  for (const name of ['', 'x'.repeat(129), '__proto__', 'constructor', 'bad\u0000name', 'password=SYNTHETIC_PRIVATE_MARKER']) {
    assert.throws(() => readArmParameters(arm(`${JSON.stringify(name)}:{"value":true}`)), (error) =>
      error instanceof MigrationError && !error.message.includes('SYNTHETIC_PRIVATE_MARKER'));
  }
});

test('migration non-Bicep ARM labels cannot become current-name aliases through Unicode case folding', () => {
  const label = `${String.fromCodePoint(0x212a)}ount`;
  const model = plan({
    target: 'param kount = 1\nparam Count = 2\n', schema: 'param kount int\nparam Count int\n',
    sources: [{ format: 'json', text: arm(`${JSON.stringify(label)}:{"value":7},"count":{"value":4}`) }],
  });
  assert.equal(row(model, 'kount').candidates.length, 0);
  assert.deepEqual(migrationNameReports(model)[0].oldOnlyNames, [label]);
  assert.deepEqual(migrationNameReports(model)[0].matchedNames, ['Count']);
  accept(model, 'Count');
  assert.equal(evaluateMigration(model).after, 'param kount = 1\nparam Count = 4\n');
});

test('migration JSON duplicate envelopes, duplicate values/nested keys, references and ARM expressions remain unresolved', () => {
  assert.throws(() => readArmParameters(arm('"count":{"value":2}').replace('"parameters":', '"parameters":{},"parameters":')), { code: 'json-duplicate' });
  assert.equal(readArmParameters(arm('"count":{"value":2,"value":3}')).parameters[0].status, 'ambiguous');
  assert.equal(readArmParameters(arm('"config":{"value":{"nested":{"a":1,"a":2}}}')).parameters[0].status, 'ambiguous');
  assert.equal(readArmParameters(arm('"config":{"value":[{"nested":"[parameters(\'x\')]"}]}')).parameters[0].status, 'dynamic');
  assert.equal(readArmParameters(arm('"count":{"reference":{"keyVault":{"id":"not-a-real-vault"},"secretName":"synthetic"}}')).parameters[0].sensitive, true);
  for (const text of ['{"count":3}', '{"parameters":{"count":{"value":3}}}', arm('"count":{"value":3,"extra":false}'), arm('"count":{"value":NaN}')]) {
    assert.throws(() => readArmParameters(text), MigrationError);
  }
});

test('automatic JSON inspection distinguishes repository data without relaxing explicit ARM parsing', () => {
  for (const text of [
    '{}', '{"appService":"app","keyVault":"kv"}', '{"version":"1.0","release":"preview"}',
    '{"openapi":"3.0.0","paths":{},"parameters":[]}',
    '{"version":"2.0","extensions":{}}',
    '{"$schema":"https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#","contentVersion":"1.0.0.0","parameters":{},"triggers":{},"actions":{}}',
  ]) {
    assert.deepEqual(inspectArmParameterJson(text), { kind: 'unrelated' });
    assert.throws(() => readArmParameters(text), MigrationError);
  }
  const valid = arm('"count":{"value":4},"secretValue":{"value":"SYNTHETIC_PRIVATE_MARKER"}');
  assert.deepEqual(inspectArmParameterJson(valid), { kind: 'parameters' });
  assert.doesNotMatch(JSON.stringify(inspectArmParameterJson(valid)), /SYNTHETIC_PRIVATE_MARKER/);
  assert.deepEqual(inspectArmParameterJson(valid.replace('"parameters":', '"parameters":{},"parameters":')),
    { kind: 'invalid', code: 'json-duplicate' });
  const missingVersion = JSON.parse(valid);
  delete missingVersion.contentVersion;
  assert.deepEqual(inspectArmParameterJson(JSON.stringify(missingVersion)), { kind: 'invalid', code: 'envelope' });
  assert.deepEqual(inspectArmParameterJson('{"parameters":'), { kind: 'invalid', code: 'format' });
  const ambiguous = arm('"count":{"value":2,"value":3}');
  assert.equal(inspectArmParameterJson(ambiguous).kind, 'parameters');
  assert.equal(readArmParameters(ambiguous).parameters[0].status, 'ambiguous');
});

test('migration validates format, size, depth, numeric fidelity, and parser-suffix boundaries', () => {
  assert.throws(() => readBicepParameters(' '.repeat(MIGRATION_LIMITS.bytes + 1)), { code: 'limit' });
  assert.throws(() => readBicepParameters(`param count = ${'['.repeat(50)}0${']'.repeat(50)}\n`), { code: 'limit' });
  assert.equal(readBicepParameters('param count = 9007199254740993\n').parameters[0].status, 'unsupported');
  assert.equal(readArmParameters(arm('"count":{"value":1.5}')).parameters[0].status, 'unsupported');
  assert.equal(readBicepParameters('param count = 2\nunrecognizedSuffix\n').parameters[0].status, 'dynamic');
  assert.equal(readArmParameters(arm('"name":{"value":"\\ud800"}')).parameters[0].status, 'unsupported');
  assert.equal(readArmParameters(arm('"name":{"value":"\\u0000"}')).parameters[0].status, 'unsupported');
});

test('migration rejects unsupported object keys at any nesting depth without altering Unicode during apply', () => {
  for (const code of [0xd800, 0, 0x7f]) {
    const key = String.fromCharCode(code);
    const json = arm(`"settings":{"value":${JSON.stringify({ nested: [{ [key]: 1 }] })}}`);
    const bicep = `param settings = { nested: [{ '\\u{${code.toString(16)}}': 1 }] }\n`;
    assert.equal(readArmParameters(json).parameters[0].status, 'unsupported');
    assert.equal(readBicepParameters(bicep).parameters[0].status, 'unsupported');
    for (const source of [{ format: 'json', text: json }, { text: bicep }]) {
      const model = plan({ target: 'param settings = {}\n', schema: 'param settings object\n', sources: [source] });
      assert.equal(row(model, 'settings').candidates[0].eligible, false);
      keepRest(model);
      assert.equal(evaluateMigration(model).after, model.target.text);
    }
  }
});

test('migration preserves supported Unicode and escaped object keys exactly', () => {
  const keys = [String.fromCodePoint(0xe9), String.fromCodePoint(0x1f642), 'line\nlabel', 'tab\tlabel', "quote'label"];
  const value = Object.fromEntries(keys.map((key) => [key, 1]));
  const model = plan({
    target: 'param settings = {}\n', schema: 'param settings object\n',
    sources: [{ format: 'json', text: arm(`"settings":{"value":${JSON.stringify(value)}}`) }],
  });
  accept(model, 'settings');
  const result = evaluateMigration(model);
  assert.equal(result.canApply, true);
  const roundTrip = new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(result.after));
  assert.deepEqual(Object.keys(readBicepParameters(roundTrip).parameters[0].value), keys);
});

test('migration reuses current feature checks without evaluating donor expressions or leaking validator messages', () => {
  const findings = validateMigrationFeatures([
    { name: 'apimSku', value: 'Developer' }, { name: 'apimSkuUnits', value: 9 },
    { name: 'llmBackendConfig', value: [{ backendId: 'synthetic', backendType: 'unknown-synthetic-provider', endpoint: 'https://example.invalid', supportedModels: [] }] },
  ]);
  assert(findings.some((entry) => entry.name === 'apimSkuUnits' && entry.severity === 'error'));
  assert(findings.some((entry) => entry.name === 'llmBackendConfig' && entry.severity === 'error'));
  assert.doesNotMatch(JSON.stringify(findings), /unknown-synthetic-provider/);
  const cased = validateMigrationFeatures([
    { name: 'APIMSKU', value: 'Developer' }, { name: 'ApimSkuUnits', value: 9 },
  ]);
  assert(cased.some((entry) => entry.name === 'ApimSkuUnits' && entry.severity === 'error'));
});

test('migration reuses Access coordinate and multi-Foundry validation with sanitized errors', () => {
  const coordinates = {
    subscriptionId: 'synthetic-subscription', resourceGroupName: 'synthetic-group',
    accountName: 'synthetic-account', projectName: 'synthetic-project',
  };
  const findings = validateMigrationFeatures([
    { name: 'apim', value: { name: 'synthetic-incomplete' } },
    { name: 'useTargetFoundry', value: true },
    { name: 'foundry', value: coordinates },
    { name: 'additionalFoundries', value: [{ ...coordinates, endpointSource: 'SYNTHETIC_PRIVATE_MARKER' }] },
  ]);
  assert(findings.some((entry) => entry.name === 'apim' && entry.severity === 'error'));
  assert(findings.some((entry) => entry.name === 'additionalFoundries' && entry.severity === 'error'));
  assert.doesNotMatch(JSON.stringify(findings), /SYNTHETIC_PRIVATE_MARKER|synthetic-incomplete/);
});

test('migration enabled Access features cannot silently treat dynamic or withheld coordinates as configured', () => {
  for (const name of ['useTargetFoundry', 'useTargetAzureKeyVault']) {
    const findings = validateMigrationFeatures([{ name, value: true }]);
    assert(findings.some((entry) => entry.name === name && entry.code === 'feature-unresolved' && entry.severity === 'error'));
  }
});

test('migration actual upgrade schemas can be populated synthetically while preserving all other product bytes', async () => {
  for (const [name, donorText, requiredNames] of [
    ['main', "param apimServiceName = 'synthetic-apim'\nparam managedIdentityName = 'synthetic-identity'\n", ['apimServiceName', 'managedIdentityName']],
    ['supporting-services', "param apimManagedIdentityName = 'synthetic-identity'\n", ['apimManagedIdentityName']],
  ]) {
    const base = new URL(`../../bicep/infra/apim-gateway-upgrade/${name}`, import.meta.url);
    const target = await readFile(new URL(`${base}.bicepparam`), 'utf8');
    const schema = await readFile(new URL(`${base}.bicep`), 'utf8');
    const model = plan({ target, schema, sources: [{ text: donorText }] });
    assert(readMigrationSchema(schema).definitions.length > 30);
    for (const field of requiredNames) accept(model, field);
    keepRest(model);
    const result = evaluateMigration(model, validateMigrationFeatures);
    assert.equal(result.canApply, true, JSON.stringify(result.blockers));
    let expected = target;
    for (const field of requiredNames) {
      const value = field === 'apimServiceName' ? 'synthetic-apim' : 'synthetic-identity';
      expected = expected.replace(new RegExp(`(param ${field} = )'[^']*'`), `$1'${value}'`);
    }
    assert.equal(result.after, expected);
  }
});
test('identical full object values ignore property order and never rewrite the target just for formatting', () => {
  const text = 'param Settings = { alpha: 1, beta: 2 }\n';
  const plan = buildMigrationPlan({
    target: { text, schemaText: 'param Settings object\n' },
    donors: [{ id: 'old', alias: 'old.bicepparam', format: 'bicepparam', text: 'param settings = { beta: 2, alpha: 1 }\n' }],
  });
  const row = migrationRows(plan)[0];
  assert.equal(row.candidates[0].matchesCurrent, true);
  decideMigration(plan, row.id, { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true });
  const result = evaluateMigration(plan);
  assert.equal(result.after, text);
  assert.equal(result.operations.length, 0);
});

test('truncated display text and unresolved placeholders never establish value equality', () => {
  const prefix = 'ordinary description '.repeat(120);
  const plan = buildMigrationPlan({
    target: { text: `param Value = '${prefix}current'\n`, schemaText: 'param Value string\n' },
    donors: [{ id: 'old', alias: 'old.bicepparam', format: 'bicepparam', text: `param value = '${prefix}previous'\n` }],
  });
  const row = migrationRows(plan)[0];
  assert.equal(row.current, row.candidates[0].value, 'the displayed prefixes are intentionally identical');
  assert.equal(row.candidates[0].matchesCurrent, false);
  const dynamic = buildMigrationPlan({
    target: { text: "param Value = readEnvironmentVariable('VALUE')\n", schemaText: 'param Value string\n' },
    donors: [{ id: 'old', alias: 'old.bicepparam', format: 'bicepparam', text: "param value = readEnvironmentVariable('VALUE')\n" }],
  });
  assert.equal(migrationRows(dynamic)[0].candidates[0].matchesCurrent, false);
});
