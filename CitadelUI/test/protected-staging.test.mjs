import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

const ui = fileURLToPath(new URL('../', import.meta.url));
const script = (name) => join(ui, 'scripts', `protected-${name}.ps1`);
const read = (path) => readFile(join(ui, path), 'utf8');
const pwsh = process.env.CITADEL_TEST_PWSH || 'pwsh';
const python = process.platform === 'win32' ? 'python' : 'python3';
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function ps(t, command, extra = {}) {
  const result = spawnSync(pwsh, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 60_000, ...extra });
  if (result.error?.code === 'ENOENT') {
    t.skip('PowerShell 7.4+ is required; set CITADEL_TEST_PWSH to its executable.');
    return null;
  }
  assert.ifError(result.error);
  return result;
}

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'citadel-protected-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function contract() {
  const subscription = '11111111-1111-4111-8111-111111111111';
  const principal = '22222222-2222-4222-8222-222222222222';
  const group = 'rg-citadel-protected-platform-test';
  const prefix = `/subscriptions/${subscription}/resourceGroups/${group}/providers/`;
  return {
    version: 1,
    platformResourceGroup: group,
    runnerName: 'vm-protected-abcdefghijklm',
    runnerIdentityId: `${prefix}Microsoft.ManagedIdentity/userAssignedIdentities/id-runner`,
    runnerClientId: '33333333-3333-4333-8333-333333333333',
    runnerPrincipalId: principal,
    workspaceResourceId: `${prefix}Microsoft.OperationalInsights/workspaces/log-protected`,
    workspaceCustomerId: '44444444-4444-4444-8444-444444444444',
    virtualNetworkId: `${prefix}Microsoft.Network/virtualNetworks/vnet-protected`,
    environmentDomain: 'synthetic.westeurope.azurecontainerapps.io',
    registryLoginServer: 'crprotectedtest.azurecr.io',
    evidenceContainerName: '',
    selectors: {
      AZURE_SUBSCRIPTION_ID: subscription,
      AZURE_LOCATION: 'westeurope',
      AZURE_ENV_NAME: 'protected-test',
      AZURE_RESOURCE_GROUP: 'rg-citadel-protected-ui-test',
      AZURE_PRINCIPAL_ID: principal,
      AZURE_PRINCIPAL_TYPE: 'ServicePrincipal',
      AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: 'cae-protected-test',
      AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP: group,
      AZURE_EXISTING_CONTAINER_REGISTRY_NAME: 'crprotectedtest',
      AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP: group,
      AZURE_KEY_VAULT_NAME: 'kv-protected-test',
      AZURE_KEY_VAULT_RESOURCE_GROUP: group,
      AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'stprotectedtest',
      AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP: group,
      AZURE_EXISTING_FILE_SHARE_NAME: 'citadel-data',
      AZURE_EXISTING_MANAGED_IDENTITY_NAME: 'id-protected-test',
      AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP: group,
      CITADEL_CREDENTIAL_SECRET_NAME: 'citadel-credential-key',
      CITADEL_PRIVATE_DEPLOYMENT: 'true',
      ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH: 'false',
    },
  };
}

test('protected staging: service firewalls, internal Consumption, private diagnostics and DNS are explicit', async () => {
  const source = await read('infra/protected/platform.bicep');
  assert.match(source, /name: 'Premium'/);
  assert.match(source, /roleAssignmentMode: 'LegacyRegistryPermissions'/);
  assert.match(source, /adminUserEnabled: false/);
  assert.match(source, /dataEndpointEnabled: true/);
  assert.match(source, /enablePurgeProtection: true/);
  assert.match(source, /azureADAuthenticationAsArmPolicy:\s*\{\s*status: 'enabled'/);
  assert.equal((source.match(/publicNetworkAccess: 'Disabled'/g) || []).length, 4);
  assert.equal((source.match(/defaultAction: 'Deny'/g) || []).length, 3);
  assert.equal((source.match(/bypass: 'None'/g) || []).length, 2);
  assert.match(source, /networkRuleBypassOptions: 'None'/);
  assert.match(source, /allowSharedKeyAccess: true/);
  assert.match(source, /enabledProtocols: 'SMB'/);
  assert.match(source, /internal: true/);
  assert.match(source, /workloadProfileType: 'Consumption'/);
  assert.match(source, /destination: 'azure-monitor'/);
  for (const flag of ['publicNetworkAccessForIngestion', 'publicNetworkAccessForQuery']) {
    assert.match(source, new RegExp(`${flag}: 'Disabled'`));
  }
  for (const mode of ['ingestionAccessMode', 'queryAccessMode']) {
    assert.match(source, new RegExp(`${mode}: 'PrivateOnly'`));
  }
  for (const category of ['ContainerAppConsoleLogs', 'ContainerAppSystemLogs']) assert.ok(source.includes(category));
  for (const zone of ['azurecr.io', 'vaultcore.azure.net', 'monitor.azure.com', 'oms.opinsights.azure.com', 'ods.opinsights.azure.com', 'agentsvc.azure-automation.net']) {
    assert.ok(source.includes(`privatelink.${zone}`));
  }
  assert.match(source, /group: 'azuremonitor', zoneIndexes: \[3, 4, 5, 6, 7\]/);
  assert.match(source, /defaultDomain/);
  const outputs = source.slice(source.indexOf('output contract object'));
  assert.doesNotMatch(outputs, /listKeys|sharedKey|password|AZURE_INFRASTRUCTURE_SUBNET_ID|AZURE_EXISTING_LOG_ANALYTICS/);
});

test('protected staging: explicit NAT is outbound only and the runner cannot receive SSH/RDP', async () => {
  const network = await read('infra/protected/network.bicep');
  const platform = await read('infra/protected/platform.bicep');
  assert.match(network, /Microsoft\.Network\/natGateways/);
  assert.match(network, /name: 'deny-all-inbound'[\s\S]*?direction: 'Inbound'[\s\S]*?access: 'Deny'/);
  assert.match(network, /name: 'explicit-https-egress'[\s\S]*?destinationPortRange: '443'/);
  assert.match(network, /name: 'deny-other-egress'/);
  assert.match(network, /defaultOutboundAccess: false/);
  assert.match(platform, /disablePasswordAuthentication: true/);
  const nic = platform.slice(platform.indexOf('resource runnerNic'), platform.indexOf('resource runner \''));
  assert.doesNotMatch(nic.replace(/\/\/[^\n]*/g, ''), /publicIPAddress/);
  assert.match(platform, /param acaSubnetPrefix string = '10\.84\.0\.0\/23'/);
  assert.doesNotMatch(platform + network, /Microsoft\.Network\/azureFirewalls/);
  assert.doesNotMatch(network, /destinationAddressPrefix: 'AzurePlatform(?:DNS|IMDS)'/);
});

test('protected staging: permissions are selected-resource scoped, conditioned and nonrotating', async () => {
  const roles = await read('infra/protected/runner-access.bicep');
  const target = await read('infra/protected/ui-access.bicep');
  assert.match(roles, /Microsoft\.Resources\/deployments\/\*/);
  assert.match(roles, /Microsoft\.App\/managedEnvironments\/storages\/write/);
  assert.match(roles, /Microsoft\.App\/managedEnvironments\/join\/action/);
  assert.match(roles, /Microsoft\.Storage\/storageAccounts\/listKeys\/action/);
  assert.doesNotMatch(roles, /'Microsoft\.Storage\/storageAccounts\/(?:write|regenerateKey\/action)'/);
  assert.doesNotMatch(roles, /'Microsoft\.App\/managedEnvironments\/write'/);
  assert.doesNotMatch(roles, /'Microsoft\.Authorization\/roleAssignments\/delete'/);
  assert.equal((roles.match(/conditionVersion: '2.0'/g) || []).length, 2);
  assert.match(roles, /PrincipalId\] GuidEquals \$\{appPrincipalId\}/);
  assert.match(roles, /PrincipalId\] GuidEquals \$\{runnerPrincipalId\}/);
  assert.match(roles, /name: guid\(registry\.id, runnerPrincipalId, role\)/);
  assert.ok(target.includes('b24988ac-6180-42a0-ab88-20f7382dd24c'));
  assert.doesNotMatch(roles + target, /8e3af657-a8ff-443c-a75c-2fe8c4bcb635/); // Owner
});

test('protected staging: omitted public IP fields are valid private NICs under strict mode', async (t) => {
  const source = await read('scripts/protected-transfer.ps1');
  assert.match(source, /Where-Object \{ \$_\['publicIPAddress'\] \}/);
  const result = ps(t, `
Set-StrictMode -Version Latest
$network = '{"ipConfigurations":[{"name":"private"}]}' | ConvertFrom-Json -AsHashtable
if (@($network.ipConfigurations | Where-Object { $_['publicIPAddress'] }).Count) { throw 'Unexpected public IP.' }
$network = '{"ipConfigurations":[{"publicIPAddress":{"id":"public-ip"}}]}' | ConvertFrom-Json -AsHashtable
if (@($network.ipConfigurations | Where-Object { $_['publicIPAddress'] }).Count -ne 1) { throw 'Public IP was not detected.' }
'private NIC guard passed'
`);
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
});

test('protected staging: custom script operations establish HOME before running azd', async () => {
  const bootstrap = await read('scripts/protected-bootstrap.sh');
  const runner = await read('scripts/protected-runner.ps1');
  assert.match(bootstrap, /export HOME=\/var\/lib\/citadel-protected\/home/);
  assert.ok(bootstrap.indexOf('export HOME=') < bootstrap.indexOf('if [[ -f "$marker" ]]'));
  assert.match(runner, /\$env:HOME = "\$root\/home"/);
  assert.ok(runner.indexOf('$env:HOME =') < runner.indexOf("'login', '--identity'"));
});

test('protected staging: compiled ARM preserves runtime conditions and safe outputs', async (t) => {
  if (!process.env.CITADEL_PROTECTED_ARM_PATH) {
    t.skip('Set CITADEL_PROTECTED_ARM_PATH to a locally compiled protected platform ARM file.');
    return;
  }
  const arm = JSON.parse(await readFile(process.env.CITADEL_PROTECTED_ARM_PATH, 'utf8'));
  assert.equal(arm.parameters.runnerVmSize.defaultValue, 'Standard_D2as_v6');
  assert.ok(arm.variables.approvedLivePair.includes('rg-citadel-live-private-20260906'));
  assert.ok(arm.variables.approvedLivePair.includes('rg-citadel-live-reuse-20260906'));
  const resources = arm.resources;
  const type = (suffix) => resources.filter((r) => r.type.endsWith(suffix));
  assert.equal(type('/virtualMachines')[0].properties.hardwareProfile.vmSize, "[parameters('runnerVmSize')]");
  assert.equal(type('/registries')[0].sku.name, 'Premium');
  assert.equal(type('/managedEnvironments')[0].properties.appLogsConfiguration.destination, 'azure-monitor');
  assert.equal(type('/workspaces')[0].properties.publicNetworkAccessForQuery, 'Disabled');
  const accessDeployment = resources.find((r) => r.name === 'protected-runner-access');
  assert.ok(accessDeployment.dependsOn.some((id) => id.includes('blobServices/containers')));
  const access = accessDeployment.properties.template;
  assert.ok(access.variables.appPullCondition.includes("parameters('appPrincipalId')"));
  assert.ok(access.variables.runnerPushCondition.includes("parameters('runnerPrincipalId')"));
  const delegation = access.resources.filter((r) => r.properties?.conditionVersion);
  assert.equal(delegation.length, 2);
  assert.ok(delegation.every((r) => r.scope.includes('registries') || r.scope.includes('vaults')));
  assert.doesNotMatch(JSON.stringify(access.variables), /\$\{(?:acrPull|runnerPrincipalId|appPrincipalId)\}/);
  const selectors = arm.outputs.contract.value.selectors;
  assert.equal(selectors.AZURE_EXISTING_FILE_SHARE_NAME, "[parameters('fileShareName')]");
  assert.ok(!Object.hasOwn(selectors, 'AZURE_INFRASTRUCTURE_SUBNET_ID'));
  assert.ok(!Object.hasOwn(selectors, 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME'));
});

test('protected staging: source allowlist excludes runtime/keys/tests but retains credential source code', async (t) => {
  const root = await temporary(t);
  const allowed = ['Dockerfile', '.dockerignore', 'README.md', 'azure.yaml', 'server/credentials.mjs',
    'shared/module.mjs', 'web/index.html', 'infra/main.bicep', 'infra/main.bicepparam', 'scripts/ensure-credential-key.ps1'];
  const excluded = ['.azure/.env', '.data/owner.json', 'server/.env', 'server/credentials.json',
    'server/keys/private.key', 'server/test/fixture.mjs', 'web/.shots/a.png', 'sample/code.mjs',
    'infra/main.json.secret', 'infra/.env', 'infra/generated.bicepparam', 'scripts/private.pem', 'scripts/id_rsa'];
  for (const path of [...allowed, ...excluded]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), 'synthetic-test-data');
  }
  const result = ps(t, `. ${quote(script('common'))}; @(Get-ProtectedSourceFiles ${quote(root)}) | ConvertTo-Json`);
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).sort(), allowed.sort());
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, 'server', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = ps(t, `. ${quote(script('common'))}; Get-ProtectedSourceFiles ${quote(root)}`);
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /symlinks\/junctions are forbidden/);
});

test('protected staging: the staging preview uses the selected SKU default and forwards overrides without Azure calls', async (t) => {
  const root = await temporary(t);
  const key = join(root, 'test.pub');
  await writeFile(key, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA test');
  const mockAz = `
function az {
  $global:LASTEXITCODE = 0
  if (($args[0..1] -join ' ') -eq 'bicep build') {
    [IO.File]::WriteAllText($args[[Array]::IndexOf($args, '--outfile')+1], '{}')
  } elseif (($args[0..1] -join ' ') -ne 'bicep lint') { throw 'Unexpected Azure call' }
}
`;
  const invocation = `& ${quote(script('stage'))} -EnvironmentName protected-test -SubscriptionId ${quote(contract().selectors.AZURE_SUBSCRIPTION_ID)} -PlatformResourceGroup rg-citadel-protected-platform-test -UiResourceGroup rg-citadel-protected-ui-test -SshPublicKeyPath ${quote(key)} -OutputDirectory ${quote(root)}`;
  const result = ps(t, `${mockAz}\n${invocation} -RunnerVmSize Standard_UnitTestOnly`);
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No Azure calls or resource writes/);
  const artifact = (await readdir(root)).find((n) => n.startsWith('protected-'));
  const parameters = JSON.parse(await readFile(join(root, artifact, 'platform.parameters.json'), 'utf8')).parameters;
  assert.equal(parameters.uiResourceGroupName.value, 'rg-citadel-protected-ui-test');
  assert.equal(parameters.acaSubnetPrefix.value, '10.84.0.0/23');
  assert.equal(parameters.runnerVmSize.value, 'Standard_UnitTestOnly');
  const defaults = ps(t, `${mockAz}\n${invocation}`);
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.match(defaults.stdout, /No Azure calls or resource writes/);
  const defaultArtifact = (await readdir(root)).find((n) => n.startsWith('protected-') && n !== artifact);
  const defaultParameters = JSON.parse(await readFile(join(root, defaultArtifact, 'platform.parameters.json'), 'utf8')).parameters;
  assert.equal(defaultParameters.runnerVmSize.value, 'Standard_D2as_v6');
});

test('protected staging: the contract rejects environment-owned overrides and production groups', async (t) => {
  const root = await temporary(t);
  for (const mutate of [
    (c) => { c.selectors.AZURE_INFRASTRUCTURE_SUBNET_ID = 'forbidden'; },
    (c) => { c.selectors.AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME = 'forbidden'; },
    (c) => { c.selectors.AZURE_AUTH_CLIENT_ID = 'forbidden'; },
    (c) => { c.selectors.AZURE_RESOURCE_GROUP = 'rg-citadel-clean'; },
    (c) => { c.selectors.AZURE_PRINCIPAL_TYPE = 'User'; },
    (c) => { c.credential = 'synthetic-invalid-extra-field'; },
  ]) {
    const value = contract();
    mutate(value);
    const path = join(root, 'contract.json');
    await writeFile(path, JSON.stringify(value));
    const result = ps(t, `. ${quote(script('common'))}; Assert-ProtectedContract (Get-Content -Raw ${quote(path)} | ConvertFrom-Json)`);
    if (!result) return;
    assert.notEqual(result.status, 0);
  }
});

test('protected staging: group guard accepts the exact live pair without admitting other live groups', async (t) => {
  const root = await temporary(t);
  const platform = 'rg-citadel-live-private-20260906';
  const target = 'rg-citadel-live-reuse-20260906';
  const cases = [
    { platform, target, allowed: true },
    { platform: 'rg-citadel-protected-platform-test', target: 'rg-citadel-protected-ui-test', allowed: true },
    { platform: target, target: platform, allowed: false },
    { platform, target: 'rg-citadel-live-reuse-20260907', allowed: false },
    { platform, target: 'rg-citadel-protected-ui-test', allowed: false },
    { platform: 'rg-citadel-clean', target, allowed: false },
    { platform: 'rg-citadel-live-fresh-20260906', target, allowed: false },
    { platform: 'rg-citadel-protected-same', target: 'rg-citadel-protected-same', allowed: false },
  ];
  const casesPath = join(root, 'groups.json');
  await writeFile(casesPath, JSON.stringify(cases));
  const contractPath = join(root, 'contract.json');
  await writeFile(contractPath, JSON.stringify(contract())
    .replaceAll('rg-citadel-protected-platform-test', platform)
    .replaceAll('rg-citadel-protected-ui-test', target));
  const result = ps(t, `
function az { throw 'Unexpected Azure call' }
. ${quote(script('common'))}
foreach ($case in (Get-Content -Raw ${quote(casesPath)} | ConvertFrom-Json)) {
  $accepted = $true
  try { Assert-ProtectedGroupNames $case.platform $case.target } catch { $accepted = $false }
  if ($accepted -ne $case.allowed) { throw 'Group approval guard mismatch.' }
}
Assert-ProtectedContract (Get-Content -Raw ${quote(contractPath)} | ConvertFrom-Json)
Write-Output 'Approved live pair and existing selector contract validated without Azure calls.'
`);
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Approved live pair and existing selector contract validated without Azure calls/);
});

test('protected staging: CRLF shell sources fail locally before any transfer', async (t) => {
  const root = await temporary(t);
  const source = join(root, 'source');
  await mkdir(source);
  for (const name of ['Dockerfile', '.dockerignore', 'README.md', 'azure.yaml']) {
    await writeFile(join(source, name), 'test source\n');
  }
  for (const name of ['server', 'shared', 'web', 'infra', 'scripts']) {
    await mkdir(join(source, name));
  }
  await writeFile(join(source, 'scripts', 'test.sh'), '#!/bin/sh\r\nexit 0\r\n');
  const contractPath = join(root, 'contract.json');
  await writeFile(contractPath, JSON.stringify(contract()));
  const result = ps(t, `function az { throw 'Unexpected Azure call.' }; & ${quote(script('transfer'))} -ContractPath ${quote(contractPath)} -OutputDirectory ${quote(root)} -SourceRoot ${quote(source)} -Execute`);
  if (!result) return;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.replace(/\s+/g, ' '), /must use LF line endings before private transfer/);
  assert.doesNotMatch(result.stderr, /Unexpected Azure call/);
});

test('protected staging: bounded CSE payloads reconstruct exact source and retries never overwrite a changed release', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'contract.json');
  await writeFile(path, JSON.stringify(contract()));
  const result = ps(t, `function az { throw 'No Azure calls are allowed in preparation mode.' }; & ${quote(script('transfer'))} -ContractPath ${quote(path)} -OutputDirectory ${quote(root)} -SourceRoot ${quote(ui)} -Deploy`);
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No Azure calls/);
  assert.doesNotMatch(result.stdout, /import assert|FROM \$\{NODE_IMAGE\}|base64\.b64decode/);
  const artifacts = join(root, (await readdir(root)).find((n) => n.startsWith('protected-')));
  const transfer = JSON.parse(await readFile(join(artifacts, 'transfer.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(artifacts, 'source-manifest.json'), 'utf8'));
  const archive = await readFile(join(artifacts, 'citadelui-source.zip'));
  assert.equal(sha256(archive), transfer.sourceSha256);
  assert.ok(manifest.files.some((f) => f.path === 'CitadelUI/server/credentials.mjs'));
  for (const required of [
    'infra/main.bicepparam',
    'infra/main.parameters.json',
    'scripts/prepare-deployment.ps1',
    'scripts/sync-deployment-parameters.ps1',
    'scripts/validate-deployment.ps1',
    'scripts/ensure-resource-group.ps1',
    'scripts/ensure-credential-key.ps1',
    'scripts/deploy-image.ps1',
  ]) {
    assert.ok(manifest.files.some((f) => f.path === `CitadelUI/${required}`), `Missing parameter/deployment transport source: ${required}`);
  }
  assert.deepEqual(manifest.files.filter((f) => f.path.endsWith('.bicepparam')).map((f) => f.path),
    ['CitadelUI/infra/main.bicepparam']);
  assert.ok(manifest.files.every((f) => !/\/(?:\.azure|\.data|test|keys)\//.test(f.path)));
  assert.equal(transfer.steps.length, transfer.chunkCount + 3);
  const chunks = [];
  const pythonCodes = [];
  for (const step of transfer.steps) {
    const protectedSettings = JSON.parse(await readFile(step.protectedPath, 'utf8'));
    const settings = JSON.parse(await readFile(step.settingsPath, 'utf8'));
    assert.deepEqual(Object.keys(protectedSettings), ['script']);
    assert.ok(protectedSettings.script.length <= 256 * 1024);
    assert.ok(!Object.hasOwn(settings, 'script'));
    const shell = gunzipSync(Buffer.from(protectedSettings.script, 'base64')).toString('utf8');
    const bash = spawnSync('bash', ['-n'], { input: shell, encoding: 'utf8', timeout: 10_000 });
    if (bash.error?.code !== 'ENOENT') assert.equal(bash.status, 0, bash.stderr);
    const pythonMatch = shell.match(/python3 - <<'CITADEL_PROTECTED_PY'\n([\s\S]*)\nCITADEL_PROTECTED_PY\n$/);
    if (!pythonMatch) continue;
    assert.doesNotMatch(shell, /python3 -c /);
    const code = pythonMatch[1];
    const parsed = spawnSync(python, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: code, encoding: 'utf8', timeout: 10_000 });
    assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
    pythonCodes.push(code);
    if (step.name.startsWith('chunk-')) {
      chunks.push(Buffer.from(code.match(/base64\.b64decode\("([A-Za-z0-9+/=]+)",validate=True\)/)[1], 'base64'));
    }
  }
  assert.deepEqual(Buffer.concat(chunks), archive);
  // Execute ONLY the Python receiver, sandboxed to a temporary local root.
  // No bootstrap/deployment scripts or Azure operations are executed.
  const receiverRoot = resolve(root, 'receiver').replaceAll('\\', '/');
  const execute = (code) => spawnSync(python, ['-c',
    'import sys; exec(compile(sys.stdin.read(), "<sandboxed-receiver>", "exec"))',
  ], {
    input: code.replace('if os.geteuid()!=0:', 'if False:').replaceAll('/var/lib/citadel-protected', receiverRoot),
    encoding: 'utf8', timeout: 15_000,
  });
  for (const code of pythonCodes) {
    const received = execute(code);
    assert.equal(received.status, 0, received.stderr);
  }
  const assembly = pythonCodes.at(-1);
  assert.equal(execute(pythonCodes[0]).status, 0); // retry a chunk
  assert.equal(execute(assembly).status, 0); // idempotent complete release
  const sourceRoot = join(receiverRoot, 'sources', transfer.sourceSha256);
  for (const file of manifest.files) {
    assert.equal(sha256(await readFile(join(sourceRoot, file.path))), file.sha256);
  }
  await writeFile(join(sourceRoot, 'CitadelUI', 'Dockerfile'), 'changed synthetic release');
  const changed = execute(assembly);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /refusing to overwrite/);
  await writeFile(join(receiverRoot, 'transfers', transfer.sourceSha256, '00000.part'), 'corrupt synthetic chunk');
  const corrupt = execute(assembly);
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /Source archive SHA-256 mismatch/);
});

test('protected staging: native failures stop operations without echoing captured output', (t) => {
  const result = ps(t, `. ${quote(script('common'))}; Invoke-ProtectedNative ${quote(pwsh)} @('-NoProfile','-Command','Write-Output PRIVATE_TEST_SENTINEL; exit 17') 'Synthetic native step'`);
  if (!result) return;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Synthetic native step failed \(native exit 17\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_TEST_SENTINEL/);
});

test('protected staging: provision and immutable local-image deployment preserve the existing key and network', async () => {
  const runner = await read('scripts/protected-runner.ps1');
  const transfer = await read('scripts/protected-transfer.ps1');
  const bootstrap = await read('scripts/protected-bootstrap.sh');
  assert.match(runner, /'login', '--identity', '--client-id'/);
  assert.match(runner, /'auth\.useAzCliAuth', 'true'/);
  assert.match(runner, /'provision', '--environment'/);
  assert.match(runner, /'build', '--platform', 'linux\/amd64', '--pull'/);
  assert.match(runner, /--password-stdin/);
  assert.match(runner, /'SERVICE_CITADELUI_IMAGE_NAME', \$immutableImage/);
  assert.match(runner, /'deploy', 'citadelui', '--from-package', \$immutableImage/);
  const provision = runner.indexOf("@('provision'");
  const build = runner.indexOf("'build', '--platform'");
  const record = runner.indexOf("'SERVICE_CITADELUI_IMAGE_NAME', $immutableImage");
  const deploy = runner.indexOf("'deploy', 'citadelui', '--from-package'");
  assert.ok(provision < build && build < record && record < deploy);
  assert.doesNotMatch(runner, /'acr', 'build'|'secret', 'set'|'secret', 'delete'|--admin-enabled|--public-network-enabled/);
  assert.match(transfer, /'--protected-settings', "@\$\(\$step\.protectedPath\)"/);
  assert.match(transfer, /'--force-update'/);
  assert.doesNotMatch(transfer, /--file-uris|fileUris\s*=|--sas-token|git push/);
  assert.match(bootstrap, /check_sha "\$work\/azd\.deb" [0-9a-f]{64}/);
  assert.match(bootstrap, /check_sha "\$work\/powershell\.deb" [0-9a-f]{64}/);
  assert.match(bootstrap, /check_sha "\$work\/bicep" [0-9a-f]{64}/);
  assert.doesNotMatch(bootstrap + runner, /-v[^\n]*docker\.sock|--mount[^\n]*docker\.sock/);
});
