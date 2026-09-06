import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const shell = process.env.CITADEL_TEST_PWSH || 'pwsh';
const available = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 10_000 });
const script = fileURLToPath(new URL('../scripts/deploy-image.ps1', import.meta.url));
const mock = String.raw`
  $ErrorActionPreference = 'Stop'
  function Record($Kind, $Arguments) {
    [IO.File]::AppendAllText($env:IMAGE_LOG, ((@{ kind = $Kind; args = @($Arguments) } | ConvertTo-Json -Compress) + [Environment]::NewLine))
  }
  function azd {
    Record 'azd' $args
    if (($args[0..1] -join ' ') -eq 'env get-value') {
      switch ($args[2]) {
        'AZURE_SUBSCRIPTION_ID' { 'test-subscription' }
        'AZURE_RESOURCE_GROUP' { 'ui-rg' }
        'AZURE_CONTAINER_REGISTRY_NAME' { 'testregistry' }
        'AZURE_CONTAINER_REGISTRY_RESOURCE_GROUP' { 'registry-rg' }
        default { throw 'Unexpected environment lookup.' }
      }
    } elseif (($args[0..2] -join ' ') -ne 'env set SERVICE_CITADELUI_IMAGE_NAME') {
      throw 'Unexpected azd command.'
    }
    $global:LASTEXITCODE = 0
  }
  function az {
    Record 'az' $args
    $global:LASTEXITCODE = 0
    switch (($args[0..1] -join ' ')) {
      'acr show' { $env:IMAGE_REGISTRY }
      'containerapp list' { $env:IMAGE_APPS }
      'acr build' { if ($env:IMAGE_FAIL_BUILD -eq '1') { throw 'Native build failed.' } }
      'containerapp update' { }
      default { throw 'Unexpected Azure operation.' }
    }
  }
  function git { $global:LASTEXITCODE = 0; 'abc1234' }
  if ($env:IMAGE_REFERENCE) { & $env:IMAGE_SCRIPT -ImageReference $env:IMAGE_REFERENCE }
  else { & $env:IMAGE_SCRIPT }
`;

async function run(t, { mode = 'LegacyRegistryPermissions', privateRegistry = false, image = '', appCount = 1, wrongRegistry = false, failBuild = false } = {}) {
  if (available.error?.code === 'ENOENT') {
    t.skip('PowerShell 7 is not installed.');
    return null;
  }
  assert.equal(available.status, 0, available.error?.message || available.stderr);
  assert.ok(Number(available.stdout.trim().split('.')[0]) >= 7, 'PowerShell 7 is required');
  const directory = await mkdtemp(join(tmpdir(), 'citadel-image-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.jsonl');
  const apps = Array.from({ length: appCount }, (_, index) => ({
    name: `citadel-ui-${index}`,
    tags: { 'azd-service-name': 'citadelui' },
    properties: {
      configuration: {
        registries: [{ server: wrongRegistry ? 'unrelated.azurecr.io' : 'testregistry.azurecr.io' }],
        ingress: { fqdn: 'citadel-ui.example.azurecontainerapps.io' },
      },
      template: { containers: [{ name: 'citadelui', env: [{ name: 'CITADEL_DATA_ROOT', value: '/data' }] }] },
    },
  }));
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', mock], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      IMAGE_SCRIPT: script,
      IMAGE_LOG: log,
      IMAGE_REFERENCE: image,
      IMAGE_FAIL_BUILD: failBuild ? '1' : '0',
      IMAGE_APPS: JSON.stringify(apps),
      IMAGE_REGISTRY: JSON.stringify({
        loginServer: 'testregistry.azurecr.io',
        roleAssignmentMode: mode,
        publicNetworkAccess: privateRegistry ? 'Disabled' : 'Enabled',
      }),
    },
  });
  assert.ifError(result.error);
  const calls = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  return { ...result, calls };
}

const commandIs = (call, words) => call.kind === 'az' && call.args.slice(0, 2).join(' ') === words;
const argument = (call, flag) => call.args[call.args.indexOf(flag) + 1];

for (const mode of ['LegacyRegistryPermissions', 'AbacRepositoryPermissions']) {
  test(`deployment image: ${mode} builds and updates only the selected container`, async (t) => {
    const result = await run(t, { mode });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    const build = result.calls.find((call) => commandIs(call, 'acr build'));
    const update = result.calls.find((call) => commandIs(call, 'containerapp update'));
    assert.ok(build && update);
    assert.equal(argument(build, '--subscription'), 'test-subscription');
    assert.equal(argument(build, '--resource-group'), 'registry-rg');
    assert.equal(build.args.includes('--source-acr-auth-id'), mode === 'AbacRepositoryPermissions');
    if (mode === 'AbacRepositoryPermissions') assert.equal(argument(build, '--source-acr-auth-id'), '[caller]');
    assert.equal(argument(update, '--container-name'), 'citadelui');
    assert.equal(argument(update, '--resource-group'), 'ui-rg');
    const stored = result.calls.find((call) => call.kind === 'azd' && call.args[1] === 'set');
    assert.equal(stored.args[3], argument(update, '--image'));
    assert.ok(result.calls.indexOf(build) < result.calls.indexOf(stored));
    assert.ok(result.calls.indexOf(stored) < result.calls.indexOf(update));
  });
}

test('deployment image: private prebuilt images skip remote build without changing firewall settings', async (t) => {
  const image = `testregistry.azurecr.io/citadelui@sha256:${'a'.repeat(64)}`;
  const result = await run(t, { privateRegistry: true, image });
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.calls.some((call) => commandIs(call, 'acr build')));
  assert.equal(argument(result.calls.find((call) => commandIs(call, 'containerapp update')), '--image'), image);
  assert.ok(!result.calls.some((call) => commandIs(call, 'acr update')));
});

for (const [label, options] of [
  ['private registry without a prebuilt image', { privateRegistry: true }],
  ['unknown registry mode', { mode: 'Unknown' }],
  ['ambiguous UI apps', { appCount: 2 }],
  ['missing UI app', { appCount: 0 }],
  ['wrong registry', { wrongRegistry: true }],
  ['failed build', { failBuild: true }],
  ['image in another registry', { image: 'unrelated.azurecr.io/citadelui:tag' }],
]) {
  test(`deployment image: ${label} fails before recording or updating an image`, async (t) => {
    const result = await run(t, options);
    if (!result) return;
    assert.notEqual(result.status, 0);
    assert.ok(!result.calls.some((call) => commandIs(call, 'containerapp update')));
    assert.ok(!result.calls.some((call) => call.kind === 'azd' && call.args[1] === 'set'));
  });
}
