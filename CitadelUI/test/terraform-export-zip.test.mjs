import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createZip } from '../shared/zip.mjs';
import { hclLiteral, terraformVariables, exportSecret, assertExportValue, exportEntryPath, EXPORT_LIMITS } from '../shared/terraform-literals.mjs';

const bytes = (text) => new TextEncoder().encode(text);
const file = (path = 'environments/demo.tfvars', text = 'environment_name = "demo"\n') => ({ path, bytes: bytes(text) });

test('canonical HCL uses only typed literals and escapes both Terraform template openings', () => {
  const value = { mixedCase: ['${var.secret}', '%{ if condition }', 'quote"slash\\newline\n', true, 123, null], 'a.b': 'text' };
  const hcl = hclLiteral(value);
  assert.match(hcl, /"\$\$\{var\.secret\}"/);
  assert.match(hcl, /"%%\{ if condition \}"/);
  assert.match(hcl, /"mixedCase" =/);
  assert.match(hcl, /"a\.b" =/);
  assert.match(hcl, /quote\\"slash\\\\newline\\n/);
  assert.match(hcl, /true,\n\s+123,\n\s+null,/);
  assert.equal(terraformVariables({ z: 'z', a: false }).indexOf('a = false'), 0);
  assert.throws(() => terraformVariables({}), /actual mapped variables/);
});

test('literal bounds reject precision loss, expression markers, unsafe keys and unreasonable requests', () => {
  for (const value of [1.5, -0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, () => {}, new Date(),
    { __expr: 'function', raw: 'file("secret")' }, JSON.parse('{"__proto__":1}'), '\u0000', '\ud800']) {
    assert.throws(() => assertExportValue(value));
  }
  assert.throws(() => assertExportValue('x'.repeat(EXPORT_LIMITS.fileBytes + 1)), /8 MiB/);
  assert.throws(() => assertExportValue(new Array(4).fill('x'.repeat(EXPORT_LIMITS.fileBytes))), /24 MiB/);
  assert.throws(() => assertExportValue(new Array(EXPORT_LIMITS.nodes + 1).fill(1)), /item limit/);
  assert.throws(() => assertExportValue(Array.from({ length: 35 }).reduce((a) => [a], 0)), /nesting/);
});

test('credential references and APIM expressions are literal data, recognizable credentials are rejected', () => {
  assert.equal(exportSecret({ endpoint_secret_name: 'safe-endpoint', api_key_secret_name: 'safe-key', named_value_key: 'model-key' }), false);
  assert.equal(exportSecret({ Authorization: 'Bearer {{model-key}}' }), false);
  assert.equal(exportSecret('<policies><inbound><set-header name="Authorization"><value>@("Bearer " + (string)context.Variables["token"])</value></set-header></inbound></policies>'), false);
  assert.equal(exportSecret({ auth_config: { secret_value: 'unmistakable-secret' } }), true);
  assert.equal(exportSecret('Bearer actual-access-token'), true);
  assert.throws(() => terraformVariables({ auth_config: { secret_value: 'do-not-export' } }), /Secret material/);
});

test('stored UTF-8 ZIP opens and passes CRC/content inspection in independent Python zipfile', () => {
  const entries = [
    file('environments/export-demo.tfvars', 'environment_name = "export-demo"\n'),
    file('llm-backend-onboarding/terraform.tfvars', 'apim_name = "synthetic"\n'),
    file('citadel-access-contracts/terraform.tfvars', 'product_terms = "Café ${literal}"\n'),
  ];
  const archive = createZip(entries);
  const script = `
import sys,io,zipfile,json,base64,binascii
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
assert z.comment == b''
out=[]
for i in z.infolist():
    data=z.read(i.filename)
    assert i.flag_bits & 0x800
    assert i.compress_type == zipfile.ZIP_STORED
    assert i.extra == b'' and i.comment == b'' and not i.is_dir()
    assert i.CRC == binascii.crc32(data) & 0xffffffff
    assert i.date_time == (1980,1,1,0,0,0)
    out.append({'path':i.filename,'bytes':base64.b64encode(data).decode()})
print(json.dumps(out))
`;
  const result = spawnSync('python', ['-c', script], { input: Buffer.from(archive), encoding: 'buffer' });
  assert.equal(result.status, 0, result.stderr?.toString());
  const actual = JSON.parse(result.stdout.toString());
  assert.deepEqual(actual.map((entry) => entry.path).sort(), entries.map((entry) => entry.path).sort());
  for (const entry of actual) assert.deepEqual(Buffer.from(entry.bytes, 'base64'), Buffer.from(entries.find((candidate) => candidate.path === entry.path).bytes));
  assert.deepEqual(createZip([...entries].reverse()), archive, 'Entry ordering is deterministic');
});

test('ZIP path, collision, count and size rules reject unsafe archives without renaming', () => {
  for (const path of ['/root.tfvars', '../escape.tfvars', 'a/../b', 'a\\b', '.git/config', 'c:/file', 'a//b',
    'AUX.tfvars', 'a/CON.txt', 'trailing. /x', 'a/', 'a?b', 'x'.repeat(241), 'cafe\u0301.tfvars']) {
    assert.throws(() => exportEntryPath(path), undefined, path);
  }
  assert.throws(() => createZip([file('a.tfvars'), file('A.tfvars')]), /unique/);
  assert.throws(() => createZip([file('parent'), file('parent/child.tfvars')]), /parent directory/);
  for (const entries of [[], new Array(2), [null], new Array(4).fill(file()), [{ path: 'a', bytes: bytes('') }]]) assert.throws(() => createZip(entries));
  assert.throws(() => createZip([{ path: 'a', bytes: new Uint8Array(EXPORT_LIMITS.fileBytes + 1) }]), /8 MiB/);
});
