import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const mappingText = await readFile(new URL('../infra/main.parameters.json', import.meta.url), 'utf8');
const mapping = JSON.parse(mappingText).parameters;
const command = process.env.CITADEL_TEST_PWSH || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const available = spawnSync(command, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 10_000 });
const mock = String.raw`
  $ErrorActionPreference = 'Stop'
  function az {
    if (($args[0..1] -join ' ') -ne 'bicep build-params') { throw 'Unexpected Azure command.' }
    Write-Output $env:PARAM_COMPILED
    $global:LASTEXITCODE = [int]$env:PARAM_COMPILE_EXIT
  }
  function azd {
    if (($args[0..1] -join ' ') -ne 'env set' -or $args[4] -ne '--environment' -or $args[5] -ne 'parameter-test') {
      throw 'Unexpected azd command.'
    }
    [IO.File]::AppendAllText($env:PARAM_LOG, ((@{ name = $args[2]; value = $args[3] } | ConvertTo-Json -Compress) + [Environment]::NewLine))
    $global:LASTEXITCODE = [int]$env:PARAM_WRITE_EXIT
  }
  & $env:PARAM_SCRIPT
`;

async function run(t, { change, compileExit = 0, writeExit = 0, envelope = true } = {}) {
  if (available.error?.code === 'ENOENT') {
    t.skip('PowerShell is not installed.');
    return null;
  }
  assert.equal(available.status, 0, available.error?.message || available.stderr);
  const root = await mkdtemp(join(tmpdir(), 'citadel parameter env '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'infra'));
  const script = join(root, 'scripts', 'sync-deployment-parameters.ps1');
  await copyFile(new URL('../scripts/sync-deployment-parameters.ps1', import.meta.url), script);
  await copyFile(new URL('../infra/main.bicepparam', import.meta.url), join(root, 'infra', 'main.bicepparam'));
  await writeFile(join(root, 'infra', 'main.parameters.json'), mappingText);
  const parameters = Object.fromEntries(Object.entries(mapping).map(([name, descriptor]) => [
    name, { value: descriptor.value.match(/=([^}]*)}/)?.[1] || '' },
  ]));
  parameters.environmentName.value = 'parameter-test';
  parameters.location.value = 'westeurope';
  parameters.privateDeployment.value = true;
  parameters.allowPublicIngressWithoutAuth.value = false;
  parameters.existingContainerRegistryName.value = 'literal-registry';
  parameters.keyVaultName.value = '';
  parameters.entraAuthClientSecret.value = 'sensitive-fixture-not-for-env';
  change?.(parameters);
  const log = join(root, 'writes.jsonl');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AZURE_|CITADEL_|SERVICE_CITADELUI_|ALLOW_PUBLIC_INGRESS_)/.test(key)) delete env[key];
  }
  const result = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', mock], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...env,
      AZURE_ENV_NAME: 'parameter-test',
      AZURE_LOCATION: 'westeurope',
      AZURE_KEY_VAULT_NAME: 'previous-vault',
      CITADEL_PRIVATE_DEPLOYMENT: 'false',
      PARAM_SCRIPT: script,
      PARAM_LOG: log,
      PARAM_COMPILE_EXIT: String(compileExit),
      PARAM_WRITE_EXIT: String(writeExit),
      PARAM_COMPILED: JSON.stringify(envelope
        ? { parametersJson: JSON.stringify({ parameters }) }
        : { parameters }),
    },
  });
  assert.ifError(result.error);
  let writes = [];
  try {
    writes = (await readFile(log, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...result, writes };
}

for (const envelope of [true, false]) {
  test(`parameter environment: literal values and explicit blanks override saved inputs (${envelope ? 'compiler envelope' : 'parameter JSON'})`, async (t) => {
    const result = await run(t, { envelope });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    const values = Object.fromEntries(result.writes.map(({ name, value }) => [name, value]));
    assert.equal(values.CITADEL_PRIVATE_DEPLOYMENT, 'true');
    assert.equal(values.AZURE_EXISTING_CONTAINER_REGISTRY_NAME, 'literal-registry');
    assert.equal(values.AZURE_KEY_VAULT_NAME, '');
    assert.ok(!Object.keys(values).some((name) => /AUTH_|PRINCIPAL_ID|IMAGE_NAME|SUBSCRIPTION|LOCATION|ENV_NAME/.test(name)));
    assert.doesNotMatch(JSON.stringify(result.writes) + result.stdout + result.stderr, /sensitive-fixture-not-for-env/);
  });
}

for (const [label, options] of [
  ['compiler failure', { compileExit: 23 }],
  ['wrong environment', { change: (p) => { p.environmentName.value = 'another-environment'; } }],
  ['wrong region', { change: (p) => { p.location.value = 'another-region'; } }],
  ['unsupported value type', { change: (p) => { p.existingContainerRegistryName.value = {}; } }],
  ['missing mapped input', { change: (p) => { delete p.keyVaultName; } }],
]) {
  test(`parameter environment: ${label} makes no environment writes`, async (t) => {
    const result = await run(t, options);
    if (!result) return;
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.writes, []);
  });
}

test('parameter environment: failed environment persistence is surfaced', async (t) => {
  const result = await run(t, { writeExit: 17 });
  if (!result) return;
  assert.notEqual(result.status, 0);
  assert.equal(result.writes.length, 1);
  assert.match(result.stderr.replace(/\s+/g, ' '), /Could not record/);
});
