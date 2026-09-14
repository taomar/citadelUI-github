import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  initializeNativeParser, parseNativeValues, applyNativeEdits, exactNumber, NATIVE_LIMITS,
} from '../shared/terraform/parser.mjs';
import { parseNativeSchema, validateNativeValues, assertNonsecretValues, assertNonsecretConfiguration, configurationReferences, nativeSchemaAt } from '../shared/terraform/schema.mjs';
import { createConfiguration, configurationOf, workspaceScope, assertUnchangedConfiguration, assertNoWritableOverlap } from '../shared/workspace-configuration.mjs';

await initializeNativeParser();
const number = (value) => ({ __tfNumber: value });

test('native CST splices preserve exact Unicode, CRLF, key order, comments and untouched numbers', () => {
  const source = '# Caf\u00e9 \u{1f680}\r\nvalue = 0.123456789012345678901 # keep\r\n' +
    'config = { "quoted-label" = "old", enabled = true, count = -999999999999999999999 }\r\n';
  const next = applyNativeEdits(source, [
    { op: 'set', path: ['config', 'quoted-label'], value: 'new ${literal} %{directive} \u{1f680}' },
    { op: 'set', path: ['config', 'enabled'], value: false },
  ]);
  assert.equal(next, source.replace('"old"', () => '"new $${literal} %%{directive} \u{1f680}"').replace('enabled = true', 'enabled = false'));
  assert.deepEqual(parseNativeValues(next).value.value, number('0.123456789012345678901'));
  assert.equal(parseNativeValues(next).value.config['quoted-label'], 'new ${literal} %{directive} \u{1f680}');
});

test('native exact numbers never pass through JS rounding; grammar gaps are unsavable', () => {
  for (const value of ['0', '-0', '1234567890123456789012345', '0.00000000000000000001', '2.0e30', '-2.1E-17']) {
    assert.deepEqual(parseNativeValues(`n = ${value}\n`).value.n, number(value));
  }
  for (const value of ['2e30', '-2e+30', '2E-17']) {
    const source = `# Caf\u00e9 \u{1f680}\r\nn = ${value}\r\nkeep = "unchanged"\r\n`;
    const bytes = new TextEncoder().encode(source);
    for (const operations of [[], [{ op: 'set', path: ['keep'], value: 'edited' }]]) {
      assert.throws(() => applyNativeEdits(source, operations), { code: 'NATIVE_NUMBER_GRAMMAR' });
      assert.deepEqual(new TextEncoder().encode(source), bytes);
    }
  }
  assert.throws(() => exactNumber('2e30'), /valid Terraform/);
  assert.equal(applyNativeEdits('n = 2.0e30\nkeep = "same"\n', []), 'n = 2.0e30\nkeep = "same"\n');
  assert.throws(() => applyNativeEdits('n = 1\n', [{ op: 'set', path: ['n'], value: 0.1 }]), /rounding/);
  assert.equal(applyNativeEdits('n = 1\n', [{ op: 'set', path: ['n'], value: exactNumber('1.125') }]), 'n = 1.125\n');
  for (const lexeme of ['01', '-00.125']) {
    const source = `# Unicode \u{1f680}\r\nn = ${lexeme}\r\nkeep = true\r\n`;
    assert.throws(() => applyNativeEdits(source, [{ op: 'set', path: ['keep'], value: false }]), { code: 'NATIVE_NUMBER_SYNTAX' });
    assert.equal(source, `# Unicode \u{1f680}\r\nn = ${lexeme}\r\nkeep = true\r\n`);
  }
  assert.throws(() => exactNumber('1'.repeat(1025)), { code: 'NATIVE_LIMIT' });
});

test('heredoc boundaries, literal escapes, indentation and unrelated bytes survive', () => {
  const source = 'policy = <<-XML\r\n  <policies>$${literal} %%{directive}</policies>\r\n  XML\r\nkeep = "same"\r\n';
  const parsed = parseNativeValues(source);
  assert.equal(parsed.value.policy, '<policies>${literal} %{directive}</policies>\n');
  const next = applyNativeEdits(source, [{ op: 'set', path: ['policy'], value: '<policies>\n  <inbound />\n</policies>\n' }]);
  assert.equal(next, 'policy = <<-XML\r\n  <policies>\r\n    <inbound />\r\n  </policies>\r\n  XML\r\nkeep = "same"\r\n');
  assert.throws(() => applyNativeEdits(source, [{ op: 'set', path: ['policy'], value: 'XML\n' }]), /closing marker/);
  assert.throws(() => applyNativeEdits(source, [{ op: 'set', path: ['policy'], value: 'not newline' }]), /ending with a newline/);
  assert.equal(applyNativeEdits(source, []), source);
});

test('literal operations add/remove properties and array items without materializing defaults', () => {
  const source = 'n = null # explicit\r\nitems = [{id = "a"}, {id = "b"}]\r\nobj = { old = true }\r\n';
  const next = applyNativeEdits(source, [
    { op: 'set', path: ['absent'], value: false },
    { op: 'remove', path: ['items', 0] },
    { op: 'set', path: ['items', 1, 'id'], value: 'kept' },
    { op: 'addProperty', path: ['obj'], key: 'next', value: number('0.125') },
  ]);
  assert.deepEqual(parseNativeValues(next).value, { n: null, items: [{ id: 'kept' }], obj: { old: true, next: number('0.125') }, absent: false });
  assert(next.includes('n = null # explicit\r\n'));
  assert.equal(applyNativeEdits('', [{ op: 'set', path: ['new'], value: 'yes' }]), 'new = "yes"\n');
});

test('strict JSON CST retains spelling, layout and large numeric values; rejects duplicate keys', () => {
  const source = '{\r\n "text": "caf\\u00e9", "large": 9999999999999999999999, "n": 2e30,\r\n "bool": true\r\n}\r\n';
  const next = applyNativeEdits(source, [{ op: 'set', path: ['bool'], value: false }], 'json-tfvars');
  assert.equal(next, source.replace('true', 'false'));
  assert.deepEqual(parseNativeValues(next, 'json-tfvars').value.n, number('2e30'));
  for (const input of ['{"a": 1, "a": 2}', '{"a": {"x":1,"x":2}}', '{"a":1,}', '[]', '{"a":/*x*/1}']) {
    assert.throws(() => parseNativeValues(input, 'json-tfvars'));
  }
});

test('multiple original-address insertions retain order and valid separators in HCL and JSON', () => {
  for (const syntax of ['hcl-tfvars', 'json-tfvars']) {
    const source = syntax === 'hcl-tfvars' ? 'items = [0]\nobject = {}\n' : '{"items":[0], "object":{}}\r\n';
    const after = applyNativeEdits(source, [
      { op: 'append', path: ['items'], value: number('1.125') },
      { op: 'append', path: ['items'], value: null },
      { op: 'addProperty', path: ['object'], key: 'quoted key', value: '${text}' },
      { op: 'addProperty', path: ['object'], key: 'next', value: false },
      { op: 'set', path: ['first'], value: true },
      { op: 'set', path: ['second'], value: null },
    ], syntax);
    assert.deepEqual(parseNativeValues(after, syntax).value, {
      items: [number('0'), number('1.125'), null], object: { 'quoted key': '${text}', next: false }, first: true, second: null,
    });
  }
  assert.throws(() => applyNativeEdits('x = { y = 1 }\n', [
    { op: 'set', path: ['x'], value: {} }, { op: 'set', path: ['x', 'y'], value: number('2') },
  ]), { code: 'NATIVE_EDIT_OVERLAP' });
  assert.throws(() => parseNativeValues('p = <<XML\n<policies />\nOTHER\n'), /syntax/);
});

test('bad or ambiguous HCL is refused without source snippets in diagnostics', () => {
  const bad = [
    'a = 1\na = 2', 'a = { x = 1, x = 2 }', 'a = file("secret.xml")', 'a = var.other',
    'a = "${var.secret}"', 'a = "%{if true}bad%{endif}"', 'a = 0xff', 'a = "bad\\q"',
    'a = "value".', 'a = [1,,2]', 'a = 1 b = 2', 'variable "a" { type = string }',
  ];
  for (const source of bad) assert.throws(() => parseNativeValues(source), (error) => {
    assert(!error.message.includes('secret.xml')); assert(!error.message.includes('var.secret')); return true;
  });
  assert.throws(() => parseNativeValues(`a = ${'['.repeat(70)}0${']'.repeat(70)}`), /nesting/);
  assert.throws(() => parseNativeValues('#'.repeat(NATIVE_LIMITS.bytes + 1)), /512 KiB/);
});

test('adjacent original-address removals and escaped template keys preserve surrounding HCL/JSON bytes', () => {
  for (const syntax of ['hcl-tfvars', 'json-tfvars']) {
    const source = syntax === 'hcl-tfvars' ? '# preserved \u{1f680}\r\nitems = [1, 2, 3]\r\nkeep = true\r\n'
      : '{\r\n "items": [1, 2, 3], "keep": true\r\n}\r\n';
    for (const indexes of [[0, 1], [1, 2], [0, 1, 2]]) {
      const after = applyNativeEdits(source, indexes.map((index) => ({ op: 'remove', path: ['items', index] })), syntax);
      assert.deepEqual(parseNativeValues(after, syntax).value.items, ['1', '2', '3'].filter((_, index) => !indexes.includes(index)).map(number));
      assert.equal(after.slice(0, after.indexOf('[')), source.slice(0, source.indexOf('[')));
      assert.equal(after.slice(after.indexOf(']') + 1), source.slice(source.indexOf(']') + 1));
      const appended = applyNativeEdits(source, [
        ...indexes.map((index) => ({ op: 'remove', path: ['items', index] })),
        { op: 'append', path: ['items'], value: number('4.125') },
      ], syntax);
      assert.deepEqual(parseNativeValues(appended, syntax).value.items,
        [...['1', '2', '3'].filter((_, index) => !indexes.includes(index)), '4.125'].map(number));
    }
  }
  const source = 'config = { "$${literal}" = true, "caf\u00e9" = 2.0e30 }\r\n';
  const after = applyNativeEdits(source, [{ op: 'set', path: ['config', '${literal}'], value: false }]);
  assert.equal(after, source.replace('true', 'false'));
  const commented = 'items = [1 # comma in comment: ,\r\n, 2, 3]\r\nkeep = true\r\n';
  const removed = applyNativeEdits(commented, [{ op: 'remove', path: ['items', 1] }, { op: 'remove', path: ['items', 2] }]);
  assert.deepEqual(parseNativeValues(removed).value.items, [number('1')]);
  assert.ok(removed.includes('# comma in comment: ,\r\n'));
});

test('native schema binds optional/nested types, required/default/null and contains validation independently', () => {
  const schema = parseNativeSchema(`
variable "n" {
  type = number
  default = 0.125
  nullable = false
}
variable "config" {
  type = object({ mode = optional(string, "a"), list = list(object({enabled = bool, value = optional(number)})) })
  validation {
    condition = contains(["a", "b"], var.config.mode)
    error_message = "not used as executable data"
  }
}
variable "set" { type = set(string) }
variable "tuple" { type = tuple([string, number]) }
variable "map" { type = map(list(string)) }
variable "secret" {
  type = string
  default = ""
  sensitive = true
}
`);
  assert.equal(schema.n.nullable, false);
  assert.deepEqual(schema.n.defaultValue, number('0.125'));
  assert.equal(schema.config.properties.mode.optional, true);
  assert.deepEqual(schema.config.properties.mode.allowedValues, ['a', 'b']);
  assert.equal(schema.set.collection, 'set');
  assert.equal(schema.tuple.items[1].type, 'number');
  assert.equal(schema.map.item.item.type, 'string');
  assert(validateNativeValues({ n: null, config: { mode: 'x', list: [] } }, schema).some((finding) => finding.message.includes('nullable')));
  assert.throws(() => parseNativeSchema('variable "x" {type=string}\nvariable "x" {type=bool}'), /Duplicate/);
  assertNonsecretValues({ secret: '', config: { secret_value: null } }, schema);
  assert.throws(() => assertNonsecretValues({ secret: 'synthetic-value' }, schema), { code: 'NATIVE_SENSITIVE_FILE' });
  assert.throws(() => assertNonsecretValues({ config: { secret_value: 'synthetic-value' } }, schema), { code: 'NATIVE_SENSITIVE_FILE' });
  assert.deepEqual(configurationReferences('locals { name = var.environment_name }\n'), ['environment_name']);
});

test('registered native identities remain immutable, scoped and separate from transport', () => {
  const config = createConfiguration('terraform', [{ area: 'llm', rootAlias: 'llm-backend-onboarding',
    valueAlias: 'llm-backend-onboarding/operator.tfvars', syntax: 'hcl-tfvars', allowCreate: false, nonsecret: true }]);
  assert.equal(configurationOf({}).format, 'bicep');
  assert.throws(() => configurationOf({ configuration: { ...config, version: 2 } }), { code: 'CONFIGURATION_VERSION' });
  const scope = workspaceScope(config);
  assert.equal(scope.read('llm-backend-onboarding/variables.tf'), 'llm-backend-onboarding/variables.tf');
  assert.equal(scope.write('llm-backend-onboarding/operator.tfvars'), 'llm-backend-onboarding/operator.tfvars');
  for (const path of ['variables.tf', 'llm-backend-onboarding/main.tf', 'llm-backend-onboarding/other.tfvars',
    'llm-backend-onboarding/terraform.tfstate.tfvars', '.terraform/private.tfvars', 'llm-backend-onboarding/../bad.tfvars']) {
    assert.throws(() => scope.write(path));
  }
  assert.throws(() => assertUnchangedConfiguration(config, { ...config, profileId: 'different' }), { code: 'CONFIGURATION_RETARGET' });
  const source = { kind: 'github', repositoryId: 1, workingBranch: 'main' };
  assert.throws(() => assertNoWritableOverlap([{ id: 'one', source, configuration: config }, { id: 'two', source, configuration: config }]), { code: 'NATIVE_OWNERSHIP_OVERLAP' });
});

test('pinned upstream roots and all examples: lossless edits, with Access stray dot rejected', {
  skip: !process.env.CITADEL_TF_REFERENCE_ROOT,
}, async () => {
  const root = process.env.CITADEL_TF_REFERENCE_ROOT;
  for (const [file, field] of [
    ['environments/dev.tfvars.example', 'environment_name'],
    ['environments/prod.tfvars.example', 'environment_name'],
    ['llm-backend-onboarding/terraform.tfvars.example', 'apim_name'],
  ]) {
    const source = await readFile(join(root, ...file.split('/')), 'utf8');
    const parsed = parseNativeValues(source);
    const node = parsed.properties.find((property) => property.key === field).node;
    const after = applyNativeEdits(source, [{ op: 'set', path: [field], value: 'synthetic-roundtrip' }]);
    assert.equal(after, source.slice(0, node.start) + '"synthetic-roundtrip"' + source.slice(node.end));
    assert.equal(applyNativeEdits(source, []), source);
  }
  for (const [folder, count] of [['', 113], ['llm-backend-onboarding', 11], ['citadel-access-contracts', 10]]) {
    const source = await readFile(join(root, folder, 'variables.tf'), 'utf8');
    assert.equal(Object.keys(parseNativeSchema(source)).length, count);
  }
  const access = await readFile(join(root, 'citadel-access-contracts', 'terraform.tfvars.example'), 'utf8');
  assert.throws(() => parseNativeValues(access), /line 20/);
  // A corrected synthetic derivative proves the valid journey without editing
  // or relabeling the malformed upstream source.
  const synthetic = access.replace('"REPLACE_WITH_APIM_NAME".', '"synthetic-apim" ');
  assert.equal(parseNativeValues(applyNativeEdits(synthetic, [{ op: 'set', path: ['product_terms'], value: 'Synthetic only' }])).value.product_terms, 'Synthetic only');
});

test('unevaluated validation and prototype-like schema names remain explicit without inherited authority', () => {
  const schema = parseNativeSchema('variable "enabled" {\n type = bool\n validation {\n condition = var.enabled\n error_message = "Enabled is required"\n }\n}\nvariable "constructor" { type = string }\n');
  assert.equal(schema.enabled.validations[0].evaluated, false);
  assert.ok(validateNativeValues({ enabled: false }, schema).some((finding) => finding.code === 'native-validation-unevaluated'));
  assert.ok(validateNativeValues({ enabled: false }, schema).some((finding) => finding.param === 'constructor' && /Required/.test(finding.message)));
  assert.equal(nativeSchemaAt({}, ['constructor']), null);
  assert.equal(nativeSchemaAt({}, ['__proto__']), null);
  assert.equal(nativeSchemaAt(schema, ['constructor']).type, 'string');
  assert.doesNotThrow(() => assertNonsecretValues({ password: null, secret_value: { empty: null, list: [] } }));
  for (const name of ['secretValue', 'apiKey', 'client-secret', 'Access Token']) {
    assert.throws(() => assertNonsecretValues({ [name]: 'synthetic-sensitive' }), { code: 'NATIVE_SENSITIVE_FILE' });
  }
  assert.throws(() => assertNonsecretConfiguration('locals { password = trimspace("synthetic-sensitive") }\n'), { code: 'NATIVE_SENSITIVE_FILE' });
  assert.doesNotThrow(() => assertNonsecretConfiguration('locals { password = var.external_secret }\n'));
  assert.doesNotThrow(() => assertNonsecretConfiguration('locals { mapping = { (var.key) = var.value } }\n'));
  assert.doesNotThrow(() => assertNonsecretConfiguration('locals { enabled = !var.disabled }\n'));
  assert.doesNotThrow(() => assertNonsecretConfiguration('locals { storage = "AccountKey=${local.storage_key};EndpointSuffix=example.invalid" }\n'));
  assert.throws(() => assertNonsecretValues({}, {}, '# github_pat_synthetic_nonfunctional_marker_0000000000\n'), { code: 'NATIVE_SENSITIVE_FILE' });
  const placeholder = 'replace-with-language-service-key-if-needed';
  assert.doesNotThrow(() => assertNonsecretConfiguration(`variable "pii_service_key" {\n type = string\n sensitive = true\n default = "${placeholder}"\n}\n`));
  assert.throws(() => assertNonsecretValues({ pii_service_key: placeholder }), { code: 'NATIVE_SENSITIVE_FILE' });
  assert.throws(() => assertNonsecretConfiguration('variable "pii_service_key" {\n type = string\n sensitive = true\n default = "a-different-sensitive-default"\n}\n'), { code: 'NATIVE_SENSITIVE_FILE' });
});

test('all admitted pinned configuration dependencies pass the real bounded native source reader', {
  skip: !process.env.CITADEL_TF_REFERENCE_ROOT,
}, async () => {
  const { nativeDirectory, nativeConfiguration } = await import('./_native-fixture.mjs');
  const { BrowserDirectoryProvider } = await import('../web/js/directory-provider.mjs');
  const { nativeDependencyProof } = await import('../shared/terraform/workspace.mjs');
  const configuration = nativeConfiguration(), scope = workspaceScope(configuration), files = {};
  const root = process.env.CITADEL_TF_REFERENCE_ROOT;
  for (const name of await readdir(root, { recursive: true })) {
    const alias = name.replaceAll('\\', '/');
    if (!/\.(?:tf|xml)$/.test(alias)) continue;
    try { scope.read(alias); }
    catch (error) { if (error.code === 'NATIVE_SOURCE_SCOPE') continue; throw error; }
    files[alias] = await readFile(join(root, ...alias.split('/')), 'utf8');
  }
  const directory = nativeDirectory(files), provider = new BrowserDirectoryProvider(directory, { configuration });
  for (const unit of configuration.units) {
    const proof = await nativeDependencyProof(provider, configuration, unit);
    assert.ok(proof.dependencies.length >= 2 && proof.dependencies.length <= 150);
  }
  assert.equal(directory.owner.trace.some((entry) => ['write', 'createFile', 'removeEntry'].includes(entry.operation)), false);
});
