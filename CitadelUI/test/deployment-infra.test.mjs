import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const main = await readFile(new URL('../infra/main.bicep', import.meta.url), 'utf8');
const binding = await readFile(new URL('../infra/modules/container-apps-storage.bicep', import.meta.url), 'utf8');
const registryRoleModule = await readFile(new URL('../infra/modules/registry-role-assignment.bicep', import.meta.url), 'utf8');
const parameters = JSON.parse(await readFile(new URL('../infra/main.parameters.json', import.meta.url), 'utf8')).parameters;
const selectors = {
  existingContainerAppsEnvironmentName: 'AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME',
  existingContainerAppsEnvironmentResourceGroup: 'AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP',
  existingLogAnalyticsWorkspaceName: 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME',
  existingLogAnalyticsWorkspaceResourceGroup: 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP',
  existingContainerRegistryName: 'AZURE_EXISTING_CONTAINER_REGISTRY_NAME',
  existingContainerRegistryResourceGroup: 'AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP',
  existingStorageAccountName: 'AZURE_EXISTING_STORAGE_ACCOUNT_NAME',
  existingStorageAccountResourceGroup: 'AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP',
  existingFileShareName: 'AZURE_EXISTING_FILE_SHARE_NAME',
  existingManagedIdentityName: 'AZURE_EXISTING_MANAGED_IDENTITY_NAME',
  existingManagedIdentityResourceGroup: 'AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP',
};

test('deployment infra: reuse inputs are optional, azd-wired and distinct from outputs', () => {
  for (const [parameter, variable] of Object.entries(selectors)) {
    assert.ok(main.includes(`param ${parameter} string = ''`));
    assert.equal(parameters[parameter].value, '${' + variable + '}');
    assert.ok(!main.includes(`output ${variable} `), `${variable} must not select reuse after a default deployment`);
  }
  assert.equal(parameters.keyVaultName.value, '${AZURE_KEY_VAULT_NAME}');
  assert.equal(parameters.keyVaultResourceGroup.value, '${AZURE_KEY_VAULT_RESOURCE_GROUP}');
  assert.equal(parameters.credentialSecretName.value, '${CITADEL_CREDENTIAL_SECRET_NAME=citadel-credential-key}');
  assert.equal(parameters.principalType.value, '${AZURE_PRINCIPAL_TYPE=User}');
  assert.equal(parameters.privateDeployment.value, '${CITADEL_PRIVATE_DEPLOYMENT=false}');
  assert.match(main, /param persistData bool = true/);
  assert.match(main, /param allowPublicIngressWithoutAuth bool = false/);
  assert.match(main, /var containerAppName = 'ca-citadelui-\$\{resourceToken\}'/);
  assert.doesNotMatch(main, /param existingContainerAppName /);
});

test('deployment infra: shared resources are existing references and scoped child writes only', () => {
  assert.match(main, /resource existingContainerAppsEnvironment 'Microsoft\.App\/managedEnvironments@2025-07-01' existing = if \(!createContainerAppsEnvironment\)/);
  assert.match(main, /scope: resourceGroup\(effectiveContainerAppsEnvironmentResourceGroup\)/);
  assert.match(main, /resource existingLogAnalyticsWorkspace '[^']+' existing = if \(createContainerAppsEnvironment && !createLogAnalytics\)/);
  assert.match(main, /scope: resourceGroup\(effectiveLogAnalyticsWorkspaceResourceGroup\)/);
  assert.match(main, /module logAnalytics '[^']+:0\.16\.1' = if \(createLogAnalytics\)/);
  assert.match(main, /module dataStorage 'modules\/container-apps-storage\.bicep' = if \(persistData\)/);
  assert.match(binding, /@secure\(\)[\s\S]*param accountKey string/);
  assert.match(binding, /resource managedEnvironment '[^']+' existing = /);
  assert.match(binding, /resource storage 'Microsoft\.App\/managedEnvironments\/storages@/);
  assert.doesNotMatch(binding, /\boutput\b[^.\n]* (string|object|array)|\btags:|\bappLogsConfiguration:|\bvnetConfiguration:/);
  assert.match(main, /resource existingRegistry 'Microsoft\.ContainerRegistry\/registries@2025-11-01' existing = if \(!createRegistry\)/);
  assert.match(main, /module registry '[^']+:0\.13\.0' = if \(createRegistry\)/);
  assert.match(registryRoleModule, /targetScope = 'resourceGroup'/);
  assert.match(registryRoleModule, /resource registry '[^']+' existing = /);
  assert.doesNotMatch(registryRoleModule, /\badminUserEnabled:|\bnetworkRuleSet:|\bsku:|\btags:/);
});

test('deployment infra: stable state and exact host/origin/probe wiring are preserved', () => {
  assert.match(main, /var resourceToken = empty\(reuseInputError\)\s+\? toLower\(uniqueString\(subscription\(\)\.id, environmentName, location\)\)/);
  assert.match(main, /var environmentStorageName = createContainerAppsEnvironment\s+\? dataVolumeName\s+: 'citadel-data-\$\{uniqueString\(resourceGroup\(\)\.id, containerAppName\)\}'/);
  assert.match(main, /var fileShareName = 'citadel-data'/);
  assert.match(main, /var dataMountPath = '\/data'/);
  assert.match(main, /storageName: environmentStorageName/g);
  assert.match(main, /volumeName: dataVolumeName/);
  assert.match(main, /maxReplicas: 1/);
  assert.match(main, /name: 'Host'\s+value: appFqdn/);
  assert.match(main, /name: 'CITADEL_ALLOWED_HOST'\s+value: appFqdn/);
  assert.match(main, /name: 'CITADEL_ALLOWED_ORIGIN'\s+value: 'https:\/\/\$\{appFqdn\}'/);
  assert.match(main, /existingContainerAppsEnvironment!\.properties\.\?vnetConfiguration\.\?internal/);
  assert.match(main, /existingContainerAppsEnvironment!\.properties\.\?publicNetworkAccess/);
  assert.match(main, /var publicIngress = !environmentIsInternal && environmentAllowsPublicNetwork && \(authConfigured \|\| allowPublicIngressWithoutAuth\)/);
  assert.match(main, /var reachableBeyondEnvironment = environmentIsInternal \|\| publicIngress/);
  assert.match(main, /var createPrivateNetwork = createContainerAppsEnvironment && privateDeployment && empty\(infrastructureSubnetId\)/);
  assert.doesNotMatch(main, /output AZURE_INFRASTRUCTURE_SUBNET_ID /);
});

test('deployment infra: ARM IDs are protected from Git Bash path conversion', async () => {
  const script = await readFile(new URL('../scripts/validate-deployment.sh', import.meta.url), 'utf8');
  assert.match(script, /MSYS_NO_PATHCONV=1 az resource show --ids/);
});

const environmentResource = {
  location: 'westeurope',
  properties: {
    provisioningState: 'Succeeded',
    defaultDomain: 'shared.example.azurecontainerapps.io',
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }],
  },
};
const workspaceResource = { properties: { customerId: 'workspace-customer-id', features: { disableLocalAuth: false } } };
const vaultResource = { properties: { enableRbacAuthorization: true } };
const registryResource = {
  name: 'sharedregistry',
  location: 'eastus', // Unlike the environment, the registry need not match the UI region.
  properties: {
    provisioningState: 'Succeeded',
    loginServer: 'sharedregistry.azurecr.io',
    roleAssignmentMode: 'LegacyRegistryPermissions',
    policies: { azureADAuthenticationAsArmPolicy: { status: 'enabled' } },
    publicNetworkAccess: 'Enabled',
  },
};
const storageResource = {
  kind: 'StorageV2',
  sku: { name: 'Standard_LRS', tier: 'Standard' },
  properties: {
    provisioningState: 'Succeeded',
    primaryEndpoints: { file: 'https://sharedstorage.file.core.windows.net/' },
    allowSharedKeyAccess: true,
    publicNetworkAccess: 'Enabled',
  },
};
const shareResource = { properties: { enabledProtocols: 'SMB', shareQuota: 128, metadata: { application: 'citadel-ui' } } };
const identityResource = { properties: { clientId: 'existing-client-id', principalId: 'existing-principal-id' } };
const networkResource = { location: 'westeurope' };
const subnetResource = {
  properties: {
    provisioningState: 'Succeeded',
    addressPrefix: '10.25.0.0/23',
    delegations: [{ properties: { serviceName: 'Microsoft.App/environments' } }],
  },
};
const inputDefaults = {
  AZURE_ENV_NAME: 'infra-test',
  AZURE_LOCATION: 'westeurope',
  AZURE_RESOURCE_GROUP: 'rg-ui-test',
  AZURE_SUBSCRIPTION_ID: '00000000-0000-0000-0000-000000000000',
};
const subnetResourceId = `/subscriptions/${inputDefaults.AZURE_SUBSCRIPTION_ID}/resourceGroups/rg-network/providers/Microsoft.Network/virtualNetworks/shared-vnet/subnets/container-apps`;
const psMock = String.raw`
  function az {
    [Console]::Error.WriteLine("INFRA_CALL" + [char]9 + "az" + [char]9 + ($args -join [char]9))
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'resource' -and $args[1] -eq 'show') {
      if ($args -contains '--ids') {
        $id = $args[[Array]::IndexOf($args, '--ids') + 1]
        if ($id -match '/virtualNetworks/[^/]+$') { Write-Output $env:INFRA_NETWORK_JSON }
        elseif ($id -match '/subnets/[^/]+$') { Write-Output $env:INFRA_SUBNET_JSON }
        elseif ($id -match '/fileServices/default/shares/[^/]+$') { Write-Output $env:INFRA_SHARE_JSON }
        else { throw "Unexpected resource ID: $id" }
      } else {
        $type = $args[[Array]::IndexOf($args, '--resource-type') + 1]
        switch ($type) {
          'Microsoft.App/managedEnvironments' { Write-Output $env:INFRA_ENV_JSON }
          'Microsoft.OperationalInsights/workspaces' { Write-Output $env:INFRA_WORKSPACE_JSON }
          'Microsoft.ContainerRegistry/registries' { Write-Output $env:INFRA_REGISTRY_JSON }
          'Microsoft.Storage/storageAccounts' { Write-Output $env:INFRA_STORAGE_JSON }
          'Microsoft.ManagedIdentity/userAssignedIdentities' { Write-Output $env:INFRA_IDENTITY_JSON }
          'Microsoft.KeyVault/vaults' { Write-Output $env:INFRA_VAULT_JSON }
          default { throw "Unexpected resource type: $type" }
        }
      }
      # Deliberately emit output even on failure: exit status must not be lost.
      $global:LASTEXITCODE = [int]$env:INFRA_READ_EXIT
      if ($env:INFRA_FAIL_RESOURCE -and ($args -join ' ').Contains($env:INFRA_FAIL_RESOURCE)) {
        $global:LASTEXITCODE = 37
      }
    } elseif ($args[0] -eq 'account' -and $args[1] -eq 'show') {
      Write-Output $env:INFRA_SUBSCRIPTION_ID
    } elseif ($args[0] -eq 'group' -and $args[1] -eq 'show') {
      Write-Output $env:INFRA_TAG
      $global:LASTEXITCODE = [int]$env:INFRA_TAG_READ_EXIT
    } elseif (-not ($args[0] -eq 'group' -and $args[1] -eq 'create')) {
      throw 'Unexpected Azure CLI command in offline test.'
    }
  }
  function azd {
    [Console]::Error.WriteLine("INFRA_CALL" + [char]9 + "azd" + [char]9 + ($args -join [char]9))
    if ($args[0] -ne 'env' -or $args[1] -ne 'set') { throw 'Unexpected azd command.' }
    $global:LASTEXITCODE = 0
  }
  & $env:INFRA_SCRIPT
  exit $LASTEXITCODE
`;
const shMock = String.raw`#!/bin/sh
set -eu
tool_name=$(basename "$0")
printf 'INFRA_CALL\t%s' "$tool_name" >&2
printf '\t%s' "$@" >&2
printf '\n' >&2
read_exit=$INFRA_READ_EXIT
if [ -n "$INFRA_FAIL_RESOURCE" ]; then
  case "$*" in *"$INFRA_FAIL_RESOURCE"*) read_exit=37 ;; esac
fi
if [ "$tool_name" = azd ]; then
  [ "$1 $2" = 'env set' ] || exit 90
  exit 0
fi
case "$1 $2" in
  'resource show')
    if [ "$3" = --ids ]; then
      case "$4" in
        */subnets/*) printf '%s\n' "$INFRA_SUBNET_TSV" ;;
        */virtualNetworks/*) printf '%s\n' "$INFRA_NETWORK_TSV" ;;
        */fileServices/default/shares/*) printf '%s\n' "$INFRA_SHARE_TSV" ;;
        *) exit 93 ;;
      esac
      exit "$read_exit"
    fi
    while [ "$1" != --resource-type ]; do shift; done
    case "$2" in
      Microsoft.App/managedEnvironments) printf '%s\n' "$INFRA_ENV_TSV" ;;
      Microsoft.OperationalInsights/workspaces) printf '%s\n' "$INFRA_WORKSPACE_TSV" ;;
      Microsoft.ContainerRegistry/registries) printf '%s\n' "$INFRA_REGISTRY_TSV" ;;
      Microsoft.Storage/storageAccounts) printf '%s\n' "$INFRA_STORAGE_TSV" ;;
      Microsoft.ManagedIdentity/userAssignedIdentities) printf '%s\n' "$INFRA_IDENTITY_TSV" ;;
      Microsoft.KeyVault/vaults) printf '%s\n' "$INFRA_VAULT_TSV" ;;
      *) exit 91 ;;
    esac
    exit "$read_exit"
    ;;
  'account show') printf '%s\n' "$INFRA_SUBSCRIPTION_ID" ;;
  'group create') exit 0 ;;
  'group show') printf '%s\n' "$INFRA_TAG"; exit "$INFRA_TAG_READ_EXIT" ;;
  *) exit 92 ;;
esac
`;
const shRunner = String.raw`
  mock_path=$INFRA_MOCK_DIR
  if command -v cygpath >/dev/null 2>&1; then mock_path=$(cygpath -u "$mock_path"); fi
  PATH="$mock_path:$PATH"
  export PATH
  sh "$INFRA_SCRIPT"
`;
const shells = [
  {
    name: 'PowerShell',
    extension: 'ps1',
    command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    probe: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psMock],
  },
  {
    name: 'POSIX',
    extension: 'sh',
    command: process.platform === 'win32' ? 'bash' : 'sh',
    probe: ['-c', 'printf available'],
    args: ['-c', shRunner],
  },
];
for (const shell of shells) {
  shell.available = spawnSync(shell.command, shell.probe, { encoding: 'utf8', timeout: 10_000 });
}

async function runPreflight(t, shell, {
  inputs = {}, environment = environmentResource, workspace = workspaceResource,
  vault = vaultResource, registry = registryResource, hook = false, readExit = 0, tag = 'Ignore', tagReadExit = 0,
  storage = storageResource, share = shareResource, identity = identityResource,
  network = networkResource, subnet = subnetResource,
  readFailure = '',
} = {}) {
  if (shell.available.error?.code === 'ENOENT') {
    t.skip(`${shell.name} is not installed.`);
    return null;
  }
  assert.equal(shell.available.status, 0, shell.available.error?.message || shell.available.stderr);
  const temporary = await mkdtemp(join(tmpdir(), 'citadel infra '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const mockDirectory = join(temporary, 'mock cli');
  await mkdir(mockDirectory);
  for (const name of ['az', 'azd']) {
    await writeFile(join(mockDirectory, name), shMock, { mode: 0o700 });
  }
  const cleanEnvironment = { ...process.env };
  for (const key of Object.keys(cleanEnvironment)) {
    if (/^(AZURE_|ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH$|CITADEL_PRIVATE_DEPLOYMENT$)/.test(key)) delete cleanEnvironment[key];
  }
  const profiles = environment.properties?.workloadProfiles || [];
  const toTsv = (values) => values.map((value) => value ?? 'None').join('\r\n');
  const script = `${hook ? 'ensure-resource-group' : 'validate-deployment'}.${shell.extension}`;
  const result = spawnSync(shell.command, shell.args, {
    cwd: temporary, // Helpers must resolve relative to the hook, not caller CWD.
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...cleanEnvironment, ...inputDefaults, ...inputs,
      INFRA_SCRIPT: fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)).replaceAll('\\', '/'),
      INFRA_MOCK_DIR: mockDirectory.replaceAll('\\', '/'),
      INFRA_READ_EXIT: String(readExit),
      INFRA_FAIL_RESOURCE: readFailure,
      INFRA_SUBSCRIPTION_ID: inputDefaults.AZURE_SUBSCRIPTION_ID,
      INFRA_TAG: tag,
      INFRA_TAG_READ_EXIT: String(tagReadExit),
      INFRA_ENV_JSON: JSON.stringify(environment),
      INFRA_WORKSPACE_JSON: JSON.stringify(workspace),
      INFRA_VAULT_JSON: JSON.stringify(vault),
      INFRA_REGISTRY_JSON: JSON.stringify(registry),
      INFRA_STORAGE_JSON: JSON.stringify(storage),
      INFRA_IDENTITY_JSON: JSON.stringify(identity),
      INFRA_SHARE_JSON: JSON.stringify(share),
      INFRA_NETWORK_JSON: JSON.stringify(network),
      INFRA_SUBNET_JSON: JSON.stringify(subnet),
      INFRA_ENV_TSV: toTsv([
        environment.location, environment.properties?.provisioningState, environment.properties?.defaultDomain,
        profiles.length, profiles.filter((profile) => profile.name === 'Consumption' && profile.workloadProfileType === 'Consumption').length,
        String(environment.properties?.vnetConfiguration?.internal ?? null),
      ]),
      INFRA_WORKSPACE_TSV: toTsv([workspace.properties?.customerId, String(workspace.properties?.features?.disableLocalAuth ?? null)]),
      INFRA_VAULT_TSV: String(vault.properties?.enableRbacAuthorization ?? null),
      INFRA_REGISTRY_TSV: toTsv([
        registry.properties?.provisioningState, registry.properties?.loginServer,
        String(registry.properties?.roleAssignmentMode ?? null),
        String(registry.properties?.policies?.azureADAuthenticationAsArmPolicy?.status ?? null),
        String(registry.properties?.publicNetworkAccess ?? null),
        String(registry.properties?.networkRuleSet?.defaultAction ?? null),
      ]),
      INFRA_STORAGE_TSV: toTsv([
        storage.properties?.provisioningState, storage.kind, storage.properties?.primaryEndpoints?.file,
        String(storage.properties?.allowSharedKeyAccess ?? null), String(storage.properties?.publicNetworkAccess ?? null),
        String(storage.properties?.networkAcls?.defaultAction ?? null),
      ]),
      INFRA_IDENTITY_TSV: toTsv([identity.properties?.clientId, identity.properties?.principalId]),
      INFRA_SHARE_TSV: String(share.properties?.enabledProtocols ?? null),
      INFRA_NETWORK_TSV: network.location ?? 'None',
      INFRA_SUBNET_TSV: toTsv([
        subnet.properties?.provisioningState,
        subnet.properties?.addressPrefix ?? subnet.properties?.addressPrefixes?.[0],
        subnet.properties?.addressPrefixes?.length ?? 0,
        (subnet.properties?.delegations || []).filter((item) =>
          (item.properties?.serviceName ?? item.serviceName) === 'Microsoft.App/environments').length,
        subnet.properties?.delegations?.length ?? 0,
        subnet.properties?.serviceAssociationLinks?.length ?? 0,
        subnet.properties?.ipConfigurations?.length ?? 0,
        subnet.properties?.privateEndpoints?.length ?? 0,
      ]),
    },
  });
  assert.ifError(result.error);
  result.calls = result.stderr.split(/\r?\n/).filter((line) => line.startsWith('INFRA_CALL\t'))
    .map((line) => line.split('\t').slice(1));
  return result;
}

const valueAfter = (args, option) => args[args.indexOf(option) + 1];
function assertReadOnlyFailure(result, message) {
  assert.notEqual(result.status, 0, result.stdout);
  // Windows PowerShell wraps Write-Error text at the console width.
  assert.match(result.stderr.replace(/\s+/g, ' '), message);
  assert.ok(result.calls.every((call) => ['az resource show', 'az account show'].includes(call.slice(0, 3).join(' '))), JSON.stringify(result.calls));
}

for (const shell of shells) {
  test(`deployment infra: ${shell.name} defaults preflight without any CLI call`, async (t) => {
    const result = await runPreflight(t, shell);
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
  });

  test(`deployment infra: ${shell.name} rejects failed tag verification even when it prints Ignore`, async (t) => {
    const result = await runPreflight(t, shell, { hook: true, tagReadExit: 37 });
    if (!result) return;
    assert.equal(result.status, 37, result.stderr);
    assert.doesNotMatch(result.stdout, /Resource group ready/);
    assert.deepEqual(result.calls.map((call) => call.slice(0, 3).join(' ')),
      ['az group create', 'az group show']);
  });

  test(`deployment infra: ${shell.name} preserves legacy Key Vault group-only create semantics`, async (t) => {
    const result = await runPreflight(t, shell, { inputs: { AZURE_KEY_VAULT_RESOURCE_GROUP: 'ignored-on-create' } });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
  });

  for (const [label, inputs, error] of [
    ['environment RG without name', { AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP: 'rg-shared' }, /requires AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME/],
    ['workspace RG without name', { AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP: 'rg-logs' }, /requires AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME/],
    ['registry RG without name', { AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP: 'rg-images' }, /requires AZURE_EXISTING_CONTAINER_REGISTRY_NAME/],
    ['storage RG without name', { AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP: 'rg-data' }, /requires AZURE_EXISTING_STORAGE_ACCOUNT_NAME/],
    ['share without an existing account', { AZURE_EXISTING_FILE_SHARE_NAME: 'state' }, /requires AZURE_EXISTING_STORAGE_ACCOUNT_NAME/],
    ['identity RG without name', { AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP: 'rg-identity' }, /requires AZURE_EXISTING_MANAGED_IDENTITY_NAME/],
    ['invalid private deployment flag', { CITADEL_PRIVATE_DEPLOYMENT: 'yes' }, /CITADEL_PRIVATE_DEPLOYMENT must be true or false/],
    ['invalid deployer principal type', { AZURE_PRINCIPAL_TYPE: 'application' }, /AZURE_PRINCIPAL_TYPE must be/],
    ['blank location', { AZURE_LOCATION: '' }, /AZURE_LOCATION is not set/],
    ['whitespace selector', { AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: ' shared' }, /leading or trailing whitespace/],
  ]) {
    test(`deployment infra: ${shell.name} rejects ${label} before any hook write`, async (t) => {
      const result = await runPreflight(t, shell, { inputs, hook: true });
      if (!result) return;
      assertReadOnlyFailure(result, error);
      assert.deepEqual(result.calls, [], 'Input errors must precede even azd env set.');
    });
  }

  test(`deployment infra: ${shell.name} reads cross-RG environment and vault before tagging only UI RG`, async (t) => {
    const result = await runPreflight(t, shell, {
      hook: true,
      inputs: {
        AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: 'shared-environment',
        AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP: 'rg-shared-environment',
        AZURE_KEY_VAULT_NAME: 'shared-vault',
        AZURE_KEY_VAULT_RESOURCE_GROUP: 'rg-shared-vault',
      },
    });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map((call) => call.slice(0, 3).join(' ')),
      ['az resource show', 'az resource show', 'az group create', 'az group show']);
    assert.equal(valueAfter(result.calls[0], '--resource-group'), 'rg-shared-environment');
    assert.equal(valueAfter(result.calls[1], '--resource-group'), 'rg-shared-vault');
    assert.equal(valueAfter(result.calls[2], '--name'), 'rg-ui-test');
    for (const call of result.calls) assert.equal(valueAfter(call, '--subscription'), inputDefaults.AZURE_SUBSCRIPTION_ID);
    assert.ok(!result.calls.some((call) => call.some((arg) => /list-keys|listKeys|workspaces|secret/.test(arg))));
  });

  test(`deployment infra: ${shell.name} reuses a workspace in another RG without reading its keys`, async (t) => {
    const result = await runPreflight(t, shell, { inputs: {
      AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME: 'shared-logs',
      AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP: 'rg-shared-logs',
    } });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.equal(valueAfter(result.calls[0], '--resource-type'), 'Microsoft.OperationalInsights/workspaces');
    assert.equal(valueAfter(result.calls[0], '--resource-group'), 'rg-shared-logs');
    assert.equal(result.calls[0][2], 'show');
  });

  test(`deployment infra: ${shell.name} resolves default RG before persisting it, and supports legacy environments`, async (t) => {
    const result = await runPreflight(t, shell, {
      hook: true,
      inputs: { AZURE_RESOURCE_GROUP: '', AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: 'legacy-environment' },
      environment: { ...environmentResource, properties: { ...environmentResource.properties, workloadProfiles: null } },
    });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(valueAfter(result.calls[0], '--resource-group'), 'rg-infra-test');
    assert.deepEqual(result.calls[1], ['azd', 'env', 'set', 'AZURE_RESOURCE_GROUP', 'rg-infra-test']);
    assert.equal(valueAfter(result.calls[2], '--name'), 'rg-infra-test');
  });

  for (const mode of ['LegacyRegistryPermissions', 'AbacRepositoryPermissions', null]) {
    test(`deployment infra: ${shell.name} reads cross-RG ACR mode ${mode ?? 'legacy default'} without configuring it`, async (t) => {
      const result = await runPreflight(t, shell, {
        hook: true,
        inputs: {
          AZURE_EXISTING_CONTAINER_REGISTRY_NAME: 'sharedregistry',
          AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP: 'rg-images',
          AZURE_PRINCIPAL_TYPE: 'ServicePrincipal',
        },
        registry: { ...registryResource, properties: { ...registryResource.properties, roleAssignmentMode: mode } },
      });
      if (!result) return;
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.calls.map((call) => call.slice(0, 3).join(' ')),
        ['az resource show', 'az group create', 'az group show']);
      assert.equal(valueAfter(result.calls[0], '--resource-type'), 'Microsoft.ContainerRegistry/registries');
      assert.equal(valueAfter(result.calls[0], '--resource-group'), 'rg-images');
      assert.equal(valueAfter(result.calls[0], '--api-version'), '2025-11-01');
      assert.equal(valueAfter(result.calls[0], '--subscription'), inputDefaults.AZURE_SUBSCRIPTION_ID);
      assert.equal(valueAfter(result.calls[1], '--name'), 'rg-ui-test');
      if (mode === 'AbacRepositoryPermissions') {
        assert.match(`${result.stdout} ${result.stderr}`.replace(/\s+/g, ' '), /--source-acr-auth-id "\[caller\]"/);
      }
    });
  }

  test(`deployment infra: ${shell.name} preserves private ACR policies and defaults its RG without bypasses`, async (t) => {
    const result = await runPreflight(t, shell, {
      inputs: { AZURE_EXISTING_CONTAINER_REGISTRY_NAME: 'sharedregistry' },
      registry: {
        ...registryResource,
        tags: { owner: 'shared-platform' },
        sku: { name: 'Premium' },
        properties: {
          ...registryResource.properties, adminUserEnabled: true,
          publicNetworkAccess: 'Disabled', networkRuleSet: { defaultAction: 'Deny' },
        },
      },
    });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.equal(valueAfter(result.calls[0], '--resource-group'), 'rg-ui-test');
    assert.match(`${result.stdout} ${result.stderr}`.replace(/\s+/g, ' '), /Registry network restrictions are preserved/);
    assert.ok(!result.calls[0].some((arg) => /credential|login|update|listKeys/i.test(arg) && !arg.includes('properties.')));
  });

  for (const [label, properties, readExit, error] of [
    ['unready registry', { provisioningState: 'Failed' }, 0, /registry must be Succeeded/],
    ['missing registry endpoint', { loginServer: null }, 0, /have a loginServer/],
    ['unknown registry permission mode', { roleAssignmentMode: 'FuturePermissions' }, 0, /Unsupported registry roleAssignmentMode/],
    ['empty registry permission mode', { roleAssignmentMode: '' }, 0, /Unsupported registry roleAssignmentMode/],
    ['disabled ARM audience authentication', { policies: { azureADAuthenticationAsArmPolicy: { status: 'disabled' } } }, 0, /must allow ARM audience tokens/],
    ['missing ARM audience authentication policy', { policies: {} }, 0, /must allow ARM audience tokens/],
    ['failed registry read with output', {}, 37, /Cannot read existing/],
  ]) {
    test(`deployment infra: ${shell.name} rejects ${label} before any RG write`, async (t) => {
      const result = await runPreflight(t, shell, {
        hook: true, readExit,
        inputs: { AZURE_EXISTING_CONTAINER_REGISTRY_NAME: 'sharedregistry' },
        registry: { ...registryResource, properties: { ...registryResource.properties, ...properties } },
      });
      if (!result) return;
      assertReadOnlyFailure(result, error);
    });
  }

  for (const [label, options, error] of [
    ['region mismatch', { environment: { ...environmentResource, location: 'eastus' } }, /AZURE_LOCATION must match/],
    ['unready environment', { environment: { ...environmentResource, properties: { ...environmentResource.properties, provisioningState: 'Failed' } } }, /must be Succeeded/],
    ['missing default domain', { environment: { ...environmentResource, properties: { ...environmentResource.properties, defaultDomain: null } } }, /have a defaultDomain/],
    ['unsupported workload profiles', { environment: { ...environmentResource, properties: { ...environmentResource.properties, workloadProfiles: [{ name: 'Dedicated', workloadProfileType: 'D4' }] } } }, /Consumption workload profile/],
    ['failed environment read with output', { readExit: 37 }, /Cannot read existing/],
  ]) {
    test(`deployment infra: ${shell.name} rejects ${label} before resource-group mutation`, async (t) => {
      const result = await runPreflight(t, shell, {
        hook: true, inputs: { AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: 'shared' }, ...options,
      });
      if (!result) return;
      assertReadOnlyFailure(result, error);
    });
  }

  test(`deployment infra: ${shell.name} fresh private selection needs no existing-resource reads`, async (t) => {
    const result = await runPreflight(t, shell, { inputs: { CITADEL_PRIVATE_DEPLOYMENT: 'true' } });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
  });

  for (const internal of [true, false]) {
    test(`deployment infra: ${shell.name} private existing-environment selection validates internal=${internal}`, async (t) => {
      const result = await runPreflight(t, shell, {
        hook: true,
        inputs: { CITADEL_PRIVATE_DEPLOYMENT: 'true', AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: 'shared' },
        environment: { ...environmentResource, properties: { ...environmentResource.properties, vnetConfiguration: { internal } } },
      });
      if (!result) return;
      if (internal) assert.equal(result.status, 0, result.stderr);
      else assertReadOnlyFailure(result, /requires an internal existing Container Apps environment/);
    });
  }

  test(`deployment infra: ${shell.name} reads an existing subnet/VNet without modifying either`, async (t) => {
    const result = await runPreflight(t, shell, { inputs: { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId } });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 2);
    assert.equal(valueAfter(result.calls[0], '--ids'), subnetResourceId.replace(/\/subnets\/[^/]+$/, ''));
    assert.equal(valueAfter(result.calls[1], '--ids'), subnetResourceId);
    assert.ok(result.calls.every((call) => call.slice(0, 3).join(' ') === 'az resource show'));
  });

  test(`deployment infra: ${shell.name} strictly rejects env-owned selectors even when they match`, async (t) => {
    const result = await runPreflight(t, shell, {
      hook: true,
      inputs: {
        CITADEL_PRIVATE_DEPLOYMENT: 'true',
        AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: 'shared',
        AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP: 'rg-environments',
        AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId,
        AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME: 'shared-logs',
        AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP: 'rg-logs',
        AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage',
        AZURE_EXISTING_MANAGED_IDENTITY_NAME: 'sharedidentity',
      },
      environment: {
        ...environmentResource,
        properties: {
          ...environmentResource.properties,
          workloadProfiles: null, // Legacy environments need no new delegation/profile.
          vnetConfiguration: { internal: true, infrastructureSubnetId: subnetResourceId.toUpperCase() },
          appLogsConfiguration: {
            destination: 'log-analytics',
            logAnalyticsConfiguration: { customerId: workspaceResource.properties.customerId.toUpperCase() },
          },
        },
      },
      subnet: { properties: {
        ...subnetResource.properties,
        delegations: [],
        serviceAssociationLinks: [{ id: 'already-owned-by-environment' }],
      } },
      workspace: { properties: { ...workspaceResource.properties, features: { disableLocalAuth: true } } },
    });
    if (!result) return;
    assertReadOnlyFailure(result, /validate its subnet separately and omit this input/);
    assert.deepEqual(result.calls, [], 'Even matching selectors must be omitted before the hook runs.');
  });

  test(`deployment infra: ${shell.name} reuses a prevalidated environment when env-owned selectors are omitted`, async (t) => {
    const result = await runPreflight(t, shell, {
      inputs: {
        AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: 'shared',
        AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP: 'rg-environments',
        CITADEL_PRIVATE_DEPLOYMENT: 'true',
      },
      environment: { ...environmentResource, properties: {
        ...environmentResource.properties,
        vnetConfiguration: { internal: true, infrastructureSubnetId: subnetResourceId },
        appLogsConfiguration: { destination: 'log-analytics', logAnalyticsConfiguration: { customerId: workspaceResource.properties.customerId } },
      } },
    });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(valueAfter(result.calls[0], '--resource-group'), 'rg-environments');
    assert.equal(result.calls.length, 1, 'No subnet/workspace read or mutation belongs in this omitted-selector path.');
  });

  for (const [label, inputs] of [
    ['subnet selector', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId }],
    ['workspace selector', { AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME: 'logs' }],
    ['subnet and workspace selectors', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId, AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME: 'logs' }],
  ]) {
    test(`deployment infra: ${shell.name} rejects existing environment plus ${label} before any CLI call`, async (t) => {
      const result = await runPreflight(t, shell, {
        hook: true,
        inputs: { AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: 'shared', ...inputs },
      });
      if (!result) return;
      assertReadOnlyFailure(result, /cannot be combined with an existing Container Apps environment/);
      assert.deepEqual(result.calls, []);
    });
  }

  for (const [label, inputs, readFailure] of [
    ['missing environment', { AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: 'shared' }, 'Microsoft.App/managedEnvironments'],
    ['missing named subnet', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId }, '/subnets/'],
    ['missing named workspace', { AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME: 'logs' }, 'Microsoft.OperationalInsights/workspaces'],
    ['missing named storage account', { AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage' }, 'Microsoft.Storage/storageAccounts'],
    ['missing named share', { AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage', AZURE_EXISTING_FILE_SHARE_NAME: 'state' }, '/fileServices/default/shares/'],
    ['missing named identity', { AZURE_EXISTING_MANAGED_IDENTITY_NAME: 'sharedidentity' }, 'Microsoft.ManagedIdentity/userAssignedIdentities'],
  ]) {
    test(`deployment infra: ${shell.name} fails ${label} rather than creating a fallback`, async (t) => {
      const result = await runPreflight(t, shell, {
        hook: true, readFailure,
        inputs,
        environment: { ...environmentResource, properties: {
          ...environmentResource.properties,
          vnetConfiguration: { infrastructureSubnetId: subnetResourceId },
          appLogsConfiguration: { destination: 'log-analytics', logAnalyticsConfiguration: { customerId: workspaceResource.properties.customerId } },
        } },
      });
      if (!result) return;
      assertReadOnlyFailure(result, /Cannot read existing/);
    });
  }

  for (const [label, inputs, options, error] of [
    ['malformed subnet ID', { AZURE_INFRASTRUCTURE_SUBNET_ID: 'subnet-id' }, {}, /complete subnet resource ID/],
    ['cross-subscription subnet', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId.replace(inputDefaults.AZURE_SUBSCRIPTION_ID, '11111111-1111-1111-1111-111111111111') }, {}, /deployment subscription/],
    ['subnet region mismatch', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId }, { network: { location: 'eastus' } }, /match the existing subnet VNet region/],
    ['unready subnet', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId }, { subnet: { properties: { ...subnetResource.properties, provisioningState: 'Failed' } } }, /subnet must be Succeeded/],
    ['undersized subnet', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId }, { subnet: { properties: { ...subnetResource.properties, addressPrefix: '10.25.0.0/28' } } }, /IPv4 prefix of \/27 or larger/],
    ['IPv6 subnet', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId }, { subnet: { properties: { ...subnetResource.properties, addressPrefix: '2001:db8::/64' } } }, /IPv4 prefix of \/27 or larger/],
    ['undelegated subnet', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId }, { subnet: { properties: { ...subnetResource.properties, delegations: [] } } }, /delegated only to Microsoft.App\/environments/],
    ['another environment subnet', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId }, { subnet: { properties: { ...subnetResource.properties, serviceAssociationLinks: [{ id: 'other-environment' }] } } }, /dedicated and unused/],
    ['subnet with an IP configuration', { AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId }, { subnet: { properties: { ...subnetResource.properties, ipConfigurations: [{ id: 'other-workload' }] } } }, /dedicated and unused/],
  ]) {
    test(`deployment infra: ${shell.name} rejects ${label} before any RG mutation`, async (t) => {
      const result = await runPreflight(t, shell, { hook: true, inputs, ...options });
      if (!result) return;
      assertReadOnlyFailure(result, error);
    });
  }

  test(`deployment infra: ${shell.name} mixes existing subnet, account/share, identity, registry, workspace and vault scopes`, async (t) => {
    const result = await runPreflight(t, shell, { hook: true, inputs: {
      CITADEL_PRIVATE_DEPLOYMENT: 'true',
      AZURE_INFRASTRUCTURE_SUBNET_ID: subnetResourceId,
      AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage',
      AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP: 'rg-data',
      AZURE_EXISTING_FILE_SHARE_NAME: 'existing-ui-state',
      AZURE_EXISTING_MANAGED_IDENTITY_NAME: 'sharedidentity',
      AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP: 'rg-identities',
      AZURE_EXISTING_CONTAINER_REGISTRY_NAME: 'sharedregistry',
      AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP: 'rg-images',
      AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME: 'shared-logs',
      AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP: 'rg-logs',
      AZURE_KEY_VAULT_NAME: 'shared-vault',
      AZURE_KEY_VAULT_RESOURCE_GROUP: 'rg-security',
    } });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    const reads = result.calls.filter((call) => call[1] === 'resource');
    assert.equal(reads.length, 8);
    const account = reads.find((call) => valueAfter(call, '--resource-type') === 'Microsoft.Storage/storageAccounts');
    assert.equal(valueAfter(account, '--resource-group'), 'rg-data');
    const share = reads.find((call) => call.includes('--ids') && valueAfter(call, '--ids').includes('/shares/'));
    assert.equal(valueAfter(share, '--ids'), `/subscriptions/${inputDefaults.AZURE_SUBSCRIPTION_ID}/resourceGroups/rg-data/providers/Microsoft.Storage/storageAccounts/sharedstorage/fileServices/default/shares/existing-ui-state`);
    const identity = reads.find((call) => valueAfter(call, '--resource-type') === 'Microsoft.ManagedIdentity/userAssignedIdentities');
    assert.equal(valueAfter(identity, '--resource-group'), 'rg-identities');
    assert.equal(valueAfter(result.calls.at(-2), '--name'), 'rg-ui-test');
    assert.ok(reads.every((call) => call[2] === 'show'), 'No key retrieval, write, tag, identity assignment or data-plane call belongs in preflight.');
  });

  test(`deployment infra: ${shell.name} existing account with no share explicitly warns about new state`, async (t) => {
    const result = await runPreflight(t, shell, { inputs: { AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage' } });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.equal(valueAfter(result.calls[0], '--resource-group'), 'rg-ui-test');
    assert.match(`${result.stdout} ${result.stderr}`.replace(/\s+/g, ' '), /new deterministic UI-specific share/);
  });

  test(`deployment infra: ${shell.name} preserves storage network policy and supports default shared-key access`, async (t) => {
    const result = await runPreflight(t, shell, {
      inputs: { AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage' },
      storage: { ...storageResource, properties: { ...storageResource.properties, allowSharedKeyAccess: null, publicNetworkAccess: 'Disabled' } },
    });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.match(`${result.stdout} ${result.stderr}`.replace(/\s+/g, ' '), /storage network restrictions are preserved/);
  });

  test(`deployment infra: ${shell.name} defaults identity RG and resolves subscription only for an absolute share ID`, async (t) => {
    const result = await runPreflight(t, shell, { inputs: {
      AZURE_SUBSCRIPTION_ID: '',
      AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage',
      AZURE_EXISTING_FILE_SHARE_NAME: 'state',
      AZURE_EXISTING_MANAGED_IDENTITY_NAME: 'sharedidentity',
    } });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls[0].slice(0, 3), ['az', 'account', 'show']);
    const share = result.calls.find((call) => call.includes('--ids'));
    assert.ok(valueAfter(share, '--ids').startsWith(`/subscriptions/${inputDefaults.AZURE_SUBSCRIPTION_ID}/resourceGroups/rg-ui-test/`));
    assert.equal(valueAfter(result.calls.at(-1), '--resource-group'), 'rg-ui-test');
  });

  for (const [label, inputs, options, error] of [
    ['storage with shared-key disabled', { AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage' }, { storage: { ...storageResource, properties: { ...storageResource.properties, allowSharedKeyAccess: false } } }, /disables shared-key access required/],
    ['blob-only storage', { AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage' }, { storage: { ...storageResource, kind: 'BlobStorage' } }, /support Azure Files SMB/],
    ['storage without a file endpoint', { AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage' }, { storage: { ...storageResource, properties: { ...storageResource.properties, primaryEndpoints: {} } } }, /support Azure Files SMB/],
    ['NFS share', { AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage', AZURE_EXISTING_FILE_SHARE_NAME: 'state' }, { share: { properties: { enabledProtocols: 'NFS' } } }, /share must use SMB/],
    ['identity without client ID', { AZURE_EXISTING_MANAGED_IDENTITY_NAME: 'sharedidentity' }, { identity: { properties: { principalId: 'existing-principal' } } }, /must have clientId and principalId/],
    ['identity without principal ID', { AZURE_EXISTING_MANAGED_IDENTITY_NAME: 'sharedidentity' }, { identity: { properties: { clientId: 'existing-client' } } }, /must have clientId and principalId/],
    ['failed storage read', { AZURE_EXISTING_STORAGE_ACCOUNT_NAME: 'sharedstorage' }, { readExit: 37 }, /Cannot read existing/],
    ['failed identity read', { AZURE_EXISTING_MANAGED_IDENTITY_NAME: 'sharedidentity' }, { readExit: 37 }, /Cannot read existing/],
  ]) {
    test(`deployment infra: ${shell.name} rejects ${label} without a write`, async (t) => {
      const result = await runPreflight(t, shell, { hook: true, inputs, ...options });
      if (!result) return;
      assertReadOnlyFailure(result, error);
    });
  }

  for (const [label, inputs, options, error] of [
    ['workspace local authentication disabled', { AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME: 'shared-logs' }, { workspace: { properties: { customerId: 'customer-id', features: { disableLocalAuth: true } } } }, /disables shared-key authentication/],
    ['workspace missing customer ID', { AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME: 'shared-logs' }, { workspace: { properties: {} } }, /must have a customerId/],
    ['access-policy Key Vault', { AZURE_KEY_VAULT_NAME: 'shared-vault' }, { vault: { properties: { enableRbacAuthorization: false } } }, /must use Azure RBAC/],
    ['failed Key Vault read with output', { AZURE_KEY_VAULT_NAME: 'shared-vault' }, { readExit: 37 }, /Cannot read existing/],
  ]) {
    test(`deployment infra: ${shell.name} rejects ${label} without changing shared configuration`, async (t) => {
      const result = await runPreflight(t, shell, { hook: true, inputs, ...options });
      if (!result) return;
      assertReadOnlyFailure(result, error);
    });
  }
}

// Optional checks of the ACTUAL compiled expressions. Normal Node-only test
// runs need no Azure CLI/Bicep. For offline infrastructure validation, compile to
// session artifacts and set CITADEL_INFRA_TEMPLATE to that JSON before running
// `node --test "test/*.test.mjs"` FROM CitadelUI (see AGENTS.md).
const template = process.env.CITADEL_INFRA_TEMPLATE
  ? JSON.parse(await readFile(process.env.CITADEL_INFRA_TEMPLATE, 'utf8'))
  : null;
const compiledTest = (name, callback) => test(`deployment infra: compiled ${name}`, {
  skip: !template && 'Set CITADEL_INFRA_TEMPLATE to offline az bicep build output.',
}, callback);

// A deliberately small ARM expression reader, not a deployment emulator.
// Unknown syntax/functions fail closed. `if` is lazy so fixtures can reject
// every reference/list operation on an absent conditional resource.
function parseArm(expression) {
  const text = expression.slice(1, -1);
  let offset = 0;
  function token(pattern) {
    while (/\s/.test(text[offset] || '') && offset < text.length) offset++;
    const match = pattern.exec(text.slice(offset));
    assert.ok(match, `Unexpected ARM syntax at ${text.slice(offset)}`);
    offset += match[0].length;
    return match[0];
  }
  function read() {
    while (/\s/.test(text[offset] || '') && offset < text.length) offset++;
    if (text[offset] === "'") return { literal: token(/^'(?:[^']|'')*'/).slice(1, -1).replaceAll("''", "'") };
    if (/[-0-9]/.test(text[offset] || '')) return { literal: Number(token(/^-?\d+(?:\.\d+)?/)) };
    const name = token(/^[a-zA-Z_][a-zA-Z_0-9]*/);
    token(/^\(/);
    const args = [];
    if (!/^\s*\)/.test(text.slice(offset))) {
      do {
        args.push(read());
        if (!/^\s*,/.test(text.slice(offset))) break;
        token(/^,/);
      } while (true);
    }
    token(/^\)/);
    let node = { name, args };
    while (/^\s*(?:\.|\[)/.test(text.slice(offset))) {
      if (/^\s*\./.test(text.slice(offset))) {
        token(/^\./);
        node = { object: node, property: token(/^[a-zA-Z_][a-zA-Z_0-9]*/) };
      } else {
        token(/^\[/);
        node = { object: node, index: read() };
        token(/^\]/);
      }
    }
    return node;
  }
  const node = read();
  assert.equal(text.slice(offset).trim(), '', 'Expression reader must consume all input.');
  return node;
}

function armContext(overrides = {}, {
  properties = {}, registryProperties = {}, identityProperties = {}, storageTier = 'Standard', group = 'rg-ui-test',
} = {}) {
  const parameterValues = Object.fromEntries(Object.entries(template.parameters).map(([key, value]) => [key, value.defaultValue]));
  Object.assign(parameterValues, { environmentName: 'infra-test', location: 'westeurope' }, overrides);
  const subscriptionId = inputDefaults.AZURE_SUBSCRIPTION_ID;
  const groupId = `/subscriptions/${subscriptionId}/resourceGroups/${group}`;
  const calls = [];
  const resources = template.resources;
  const references = {
    containerAppsEnvironment: { defaultDomain: 'created.example.azurecontainerapps.io', staticIp: '10.240.0.10' },
    existingContainerAppsEnvironment: { ...environmentResource.properties, ...properties },
    logAnalytics: { outputs: { logAnalyticsWorkspaceId: { value: 'created-workspace-customer' } } },
    existingLogAnalyticsWorkspace: { customerId: 'existing-workspace-customer' },
    registry: { outputs: { loginServer: { value: 'createdregistry.azurecr.io' } } },
    existingRegistry: { ...registryResource.properties, ...registryProperties },
    identity: { clientId: 'created-client-id', principalId: 'created-principal-id' },
    existingIdentity: { ...identityResource.properties, ...identityProperties },
    existingStorageAccount: { ...storageResource.properties, sku: { tier: storageTier } },
  };
  function access(operation, name) {
    calls.push([operation, name]);
    assert.ok(resources[name], `Unknown resource ${name}`);
    assert.notEqual(value(resources[name].condition ?? true), false, `Accessed absent conditional resource ${name}`);
    if (operation === 'reference') {
      assert.ok(references[name], `No fixture for ${name}`);
      return references[name];
    }
    if (name === 'storage' && operation === 'listOutputsWithSecureValues') return { primaryAccessKey: 'created-storage-test-key' };
    if (name === 'existingStorageAccount' && operation === 'listKeys') return { keys: [{ value: 'existing-storage-test-key' }] };
    assert.ok(['logAnalytics', 'existingLogAnalyticsWorkspace'].includes(name), `Unexpected key lookup for ${name}`);
    return { primarySharedKey: `${name}-test-key` };
  }
  function evaluate(node) {
    if (Object.hasOwn(node, 'literal')) return node.literal;
    if (node.object) {
      const result = evaluate(node.object);
      const key = Object.hasOwn(node, 'property') ? node.property : evaluate(node.index);
      assert.ok(result && Object.hasOwn(result, key), `Missing property ${key}`);
      return result[key];
    }
    if (node.name === 'if') return evaluate(node.args[0]) ? evaluate(node.args[1]) : evaluate(node.args[2]);
    const args = node.args.map(evaluate);
    switch (node.name) {
      case 'parameters': assert.ok(Object.hasOwn(parameterValues, args[0])); return parameterValues[args[0]];
      case 'variables': assert.ok(Object.hasOwn(template.variables, args[0])); return value(template.variables[args[0]]);
      case 'empty': return args[0] == null || (typeof args[0] === 'object' ? Object.keys(args[0]).length === 0 : args[0].length === 0);
      case 'not': return !args[0];
      case 'and': return args.every(Boolean);
      case 'or': return args.some(Boolean);
      case 'equals': return args[0] === args[1];
      case 'true': return true;
      case 'false': return false;
      case 'null': return null;
      case 'toLower': return args[0].toLowerCase();
      case 'startsWith': return args[0].startsWith(args[1]);
      case 'split': return args[0].split(args[1]);
      case 'coalesce': return args.find((arg) => arg != null) ?? null;
      case 'tryGet': return args[0]?.[args[1]] ?? null;
      case 'format': return args[0].replace(/\{(\d+)\}/g, (_, i) => args[Number(i) + 1]);
      case 'createArray': return args;
      case 'createObject': return Object.fromEntries(args.flatMap((arg, i) => i % 2 ? [] : [[arg, args[i + 1]]]));
      case 'union': return Object.assign({}, ...args);
      // Only stability/uniqueness is asserted, not Azure's implementation of the hash.
      case 'uniqueString': return createHash('sha256').update(args.join('\0')).digest('hex').slice(0, 13);
      case 'subscription': return { id: `/subscriptions/${subscriptionId}`, subscriptionId };
      case 'resourceGroup': return { id: groupId, name: group, location: parameterValues.location };
      case 'environment': return { suffixes: { keyvaultDns: '.vault.azure.net' } };
      case 'resourceId': {
        const [resourceGroup, type, ...names] = args[0].startsWith('Microsoft.') ? [group, ...args] : args;
        return resourceId(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`, type, names);
      }
      case 'extensionResourceId': return resourceId(args[0], args[1], args.slice(2));
      case 'reference':
      case 'listKeys':
      case 'listOutputsWithSecureValues': return access(node.name, args[0]);
      case 'fail': throw new Error(args[0]);
      default: assert.fail(`Unsupported ARM function ${node.name}`);
    }
    function resourceId(scope, type, names) {
      const [namespace, ...types] = type.split('/');
      const segments = names.flatMap((name) => name.split('/'));
      assert.equal(segments.length, types.length, 'Resource name segments must match the type.');
      return `${scope}/providers/${namespace}/${types.map((part, i) => `${part}/${segments[i]}`).join('/')}`;
    }
  }
  function value(input) {
    if (typeof input === 'string' && input.startsWith('[')) return evaluate(parseArm(input));
    if (Array.isArray(input)) return input.map(value);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, val]) => [value(key), value(val)]));
    return input;
  }
  return { value, calls, variable: (name) => value(template.variables[name]), output: (name) => value(template.outputs[name].value) };
}

compiledTest('defaults retain new resources, state names and least-privilege Key Vault behavior', () => {
  const context = armContext({ keyVaultResourceGroup: 'ignored-on-create' });
  assert.equal(context.value(template.resources.containerAppsEnvironment.condition), true);
  assert.equal(context.value(template.resources.logAnalytics.condition), true);
  assert.equal(context.value(template.resources.keyVault.condition), true);
  assert.equal(context.output('AZURE_KEY_VAULT_RESOURCE_GROUP'), 'rg-ui-test');
  assert.equal(context.value(template.resources.keyVaultSecretsUser.resourceGroup), 'rg-ui-test');
  assert.equal(context.variable('environmentStorageName'), 'citadel-data');
  assert.equal(context.output('AZURE_CONTAINER_APP_ENVIRONMENT_REUSED'), false);
  assert.equal(context.output('AZURE_CONTAINER_APP_ENVIRONMENT_RESOURCE_GROUP'), 'rg-ui-test');
  assert.equal(context.output('SERVICE_CITADELUI_NETWORK'), 'environment');
  assert.equal(context.value(template.resources.registry.condition), true);
  assert.equal(context.output('AZURE_CONTAINER_REGISTRY_REUSED'), false);
  assert.equal(context.output('AZURE_CONTAINER_REGISTRY_RESOURCE_GROUP'), 'rg-ui-test');
  assert.equal(context.output('AZURE_CONTAINER_REGISTRY_ENDPOINT'), 'createdregistry.azurecr.io');
  assert.equal(template.resources.registry.properties.parameters.roleAssignmentMode.value, 'LegacyRegistryPermissions');
  assert.equal(template.resources.registry.properties.parameters.azureADAuthenticationAsArmPolicyStatus.value, 'enabled');
  assert.equal(template.resources.registry.properties.parameters.acrAdminUserEnabled.value, false);
  assert.equal(context.value(template.resources.privateNetwork.condition), false);
  assert.equal(context.value(template.resources.privateDns.condition), false);
  assert.equal(context.value(template.resources.storage.condition), true);
  assert.equal(context.value(template.resources.identity.condition), true);
  assert.equal(context.output('AZURE_FILE_SHARE_NAME'), 'citadel-data');
  assert.equal(context.output('AZURE_CLIENT_ID'), 'created-client-id');
});

compiledTest('fresh private networking creates only its own VNet, delegated subnet and private DNS', () => {
  const context = armContext({ privateDeployment: true, allowPublicIngressWithoutAuth: true });
  assert.equal(context.value(template.resources.privateNetwork.condition), true);
  assert.equal(context.value(template.resources.privateDns.condition), true);
  assert.equal(context.output('SERVICE_CITADELUI_NETWORK'), 'vnet');
  assert.equal(context.output('SERVICE_CITADELUI_PUBLIC'), false);
  assert.equal(context.value(template.resources.authConfig.condition), false, 'Private deployment must not enable Entra auth.');
  const environment = context.value(template.resources.containerAppsEnvironment.properties);
  assert.equal(environment.vnetConfiguration.internal, true);
  assert.match(environment.vnetConfiguration.infrastructureSubnetId, /\/virtualNetworks\/vnet-citadelui-[^/]+\/subnets\/snet-containerapps$/);
  assert.equal(context.output('AZURE_CONTAINER_APP_ENVIRONMENT_SUBNET_ID'), environment.vnetConfiguration.infrastructureSubnetId);
  const network = Object.values(template.resources.privateNetwork.properties.template.resources)
    .find((resource) => resource.type === 'Microsoft.Network/virtualNetworks');
  assert.deepEqual(network.properties.addressSpace.addressPrefixes, ['10.240.0.0/16']);
  assert.equal(network.properties.subnets[0].properties.addressPrefix, '10.240.0.0/23');
  assert.equal(network.properties.subnets[0].properties.delegations[0].properties.serviceName, 'Microsoft.App/environments');
  const dnsParams = template.resources.privateDns.properties.parameters;
  assert.equal(context.value(dnsParams.domainName).value, 'created.example.azurecontainerapps.io');
  assert.equal(context.value(dnsParams.staticIp).value, '10.240.0.10');
  const dns = Object.values(template.resources.privateDns.properties.template.resources);
  assert.deepEqual(dns.map((resource) => resource.type).sort(), [
    'Microsoft.Network/privateDnsZones', 'Microsoft.Network/privateDnsZones/A',
    'Microsoft.Network/privateDnsZones/virtualNetworkLinks',
  ]);
  assert.equal(dns.find((resource) => resource.type.endsWith('/virtualNetworkLinks')).properties.registrationEnabled, false);
});

compiledTest('existing subnet can mix named resources without redeploying any of them or their network', () => {
  const context = armContext({
    privateDeployment: true,
    infrastructureSubnetId: subnetResourceId,
    existingStorageAccountName: 'sharedstorage',
    existingStorageAccountResourceGroup: 'rg-data',
    existingFileShareName: 'kept-state',
    existingManagedIdentityName: 'sharedidentity',
    existingManagedIdentityResourceGroup: 'rg-identities',
    existingContainerRegistryName: 'sharedregistry',
    existingContainerRegistryResourceGroup: 'rg-images',
    existingLogAnalyticsWorkspaceName: 'shared-logs',
    existingLogAnalyticsWorkspaceResourceGroup: 'rg-logs',
    keyVaultName: 'shared-vault',
    keyVaultResourceGroup: 'rg-security',
  });
  for (const name of ['privateNetwork', 'privateDns', 'storage', 'newDataShare', 'identity', 'registry', 'logAnalytics', 'keyVault']) {
    assert.equal(context.value(template.resources[name].condition), false, `Unexpected create path for ${name}`);
  }
  assert.equal(context.value(template.resources.containerAppsEnvironment.condition), true);
  assert.equal(context.value(template.resources.containerAppsEnvironment.properties).vnetConfiguration.infrastructureSubnetId, subnetResourceId);
  assert.equal(context.output('AZURE_STORAGE_ACCOUNT_NAME'), 'sharedstorage');
  assert.equal(context.output('AZURE_STORAGE_ACCOUNT_RESOURCE_GROUP'), 'rg-data');
  assert.equal(context.output('AZURE_FILE_SHARE_NAME'), 'kept-state');
  assert.match(context.output('AZURE_FILE_SHARE_RESOURCE_ID'), /\/resourceGroups\/rg-data\/providers\/Microsoft.Storage\/storageAccounts\/sharedstorage\/fileServices\/default\/shares\/kept-state$/);
  assert.equal(context.value(template.resources.dataStorage.properties.parameters.shareName).value, 'kept-state');
  assert.equal(context.value(template.resources.dataStorage.properties.parameters.accountName).value, 'sharedstorage');
  const identityId = context.output('AZURE_MANAGED_IDENTITY_ID');
  assert.match(identityId, /\/resourceGroups\/rg-identities\/providers\/Microsoft.ManagedIdentity\/userAssignedIdentities\/sharedidentity$/);
  assert.deepEqual(context.value(template.resources.containerApp.identity.userAssignedIdentities), { [identityId]: {} });
  assert.equal(context.value(template.resources.containerApp.properties.configuration.registries[0].identity), identityId);
  assert.equal(context.output('AZURE_CLIENT_ID'), 'existing-client-id');
  assert.equal(context.output('AZURE_MANAGED_IDENTITY_PRINCIPAL_ID'), 'existing-principal-id');
  for (const name of ['acrPull', 'keyVaultSecretsUser']) {
    assert.equal(context.value(template.resources[name].properties.parameters.principalId).value, 'existing-principal-id');
    assert.equal(context.value(template.resources[name].properties.parameters.subjectId).value, identityId);
  }
  assert.ok(context.calls.every(([, name]) => !['identity', 'registry', 'storage', 'logAnalytics'].includes(name)));
});

compiledTest('existing environment with all state selected creates neither network, workspace, account, share nor identity', () => {
  const context = armContext({
    privateDeployment: true,
    existingContainerAppsEnvironmentName: 'shared',
    existingContainerAppsEnvironmentResourceGroup: 'rg-environments',
    existingStorageAccountName: 'sharedstorage',
    existingStorageAccountResourceGroup: 'rg-data',
    existingFileShareName: 'kept-state',
    existingManagedIdentityName: 'sharedidentity',
  }, { properties: { vnetConfiguration: { internal: true, infrastructureSubnetId: subnetResourceId } } });
  for (const name of ['containerAppsEnvironment', 'privateNetwork', 'privateDns', 'logAnalytics', 'storage', 'newDataShare', 'identity']) {
    assert.equal(context.value(template.resources[name].condition), false, name);
  }
  assert.equal(context.output('SERVICE_CITADELUI_NETWORK'), 'vnet');
  assert.equal(context.output('AZURE_CONTAINER_APP_ENVIRONMENT_SUBNET_ID'), subnetResourceId);
  assert.equal(context.value(template.resources.dataStorage.resourceGroup), 'rg-environments');
  assert.equal(context.output('AZURE_FILE_SHARE_NAME'), 'kept-state');
});

compiledTest('prevalidated environment reuse omits network/workspace inputs and performs no workspace lookup', () => {
  const context = armContext({
    privateDeployment: true,
    existingContainerAppsEnvironmentName: 'shared',
    existingContainerAppsEnvironmentResourceGroup: 'rg-environments',
  }, { properties: {
    vnetConfiguration: { internal: true, infrastructureSubnetId: subnetResourceId.toUpperCase() },
    appLogsConfiguration: {
      destination: 'log-analytics',
      logAnalyticsConfiguration: { customerId: 'EXISTING-WORKSPACE-CUSTOMER' },
    },
  } });
  for (const name of ['containerAppsEnvironment', 'privateNetwork', 'privateDns', 'logAnalytics']) {
    assert.equal(context.value(template.resources[name].condition), false, name);
  }
  assert.equal(context.value(template.resources.existingLogAnalyticsWorkspace.condition), false);
  assert.match(context.output('AZURE_CONTAINER_APP_ENVIRONMENT_ID'), /\/rg-environments\/providers\/Microsoft.App\/managedEnvironments\/shared$/);
  assert.equal(context.value(template.resources.dataStorage.properties.parameters.environmentName).value, 'shared');
  assert.equal(context.output('AZURE_LOG_ANALYTICS_WORKSPACE_RESOURCE_ID'), '');
  // Even forcing evaluation of the inactive create-resource properties must
  // not read keys from existing logging or an absent AVM module.
  const logging = context.value(template.resources.containerAppsEnvironment.properties).appLogsConfiguration.logAnalyticsConfiguration;
  assert.deepEqual(logging, { customerId: '', sharedKey: '' });
  assert.ok(context.calls.every(([operation, name]) => operation === 'reference' && name === 'existingContainerAppsEnvironment'));
});

compiledTest('Bicep strictly rejects even matching raw environment-owned selectors before deriving deployment names', () => {
  for (const params of [
    { infrastructureSubnetId: subnetResourceId },
    { existingLogAnalyticsWorkspaceName: 'logs' },
    { infrastructureSubnetId: subnetResourceId, existingLogAnalyticsWorkspaceName: 'logs' },
  ]) {
    const context = armContext({ existingContainerAppsEnvironmentName: 'shared', ...params }, { properties: {
      vnetConfiguration: { infrastructureSubnetId: subnetResourceId },
      appLogsConfiguration: { destination: 'log-analytics', logAnalyticsConfiguration: { customerId: 'existing-workspace-customer' } },
    } });
    assert.throws(() => context.variable('resourceToken'), /cannot be combined with an existing Container Apps environment/);
    assert.deepEqual(context.calls, []);
  }
});

compiledTest('private flag cannot silently label an external existing environment private', () => {
  const context = armContext({ privateDeployment: true, existingContainerAppsEnvironmentName: 'shared' });
  assert.throws(() => context.output('SERVICE_CITADELUI_NETWORK'), /requires an internal existing Container Apps environment/);
});

compiledTest('new shares in existing accounts are unique, scoped, and sized without changing the account', () => {
  const params = { existingStorageAccountName: 'sharedstorage', existingStorageAccountResourceGroup: 'rg-data' };
  const context = armContext(params);
  assert.equal(context.value(template.resources.newDataShare.condition), true);
  assert.equal(context.value(template.resources.newDataShare.resourceGroup), 'rg-data');
  assert.equal(context.value(template.resources.storage.condition), false);
  const shareName = context.output('AZURE_FILE_SHARE_NAME');
  assert.notEqual(shareName, 'citadel-data');
  assert.equal(shareName, armContext(params).output('AZURE_FILE_SHARE_NAME'));
  assert.notEqual(shareName, armContext(params, { group: 'another-ui-group' }).output('AZURE_FILE_SHARE_NAME'));
  assert.equal(context.value(template.resources.newDataShare.properties.parameters.shareName).value, shareName);
  assert.equal(context.value(template.resources.newDataShare.properties.parameters.shareQuotaGiB).value, 5);
  const premium = armContext(params, { storageTier: 'Premium' });
  assert.equal(premium.value(template.resources.newDataShare.properties.parameters.shareQuotaGiB).value, 100);
  const child = template.resources.newDataShare.properties.template;
  assert.deepEqual(Object.values(child.resources).filter((resource) => !resource.existing).map((resource) => resource.type),
    ['Microsoft.Storage/storageAccounts/fileServices/shares']);
  const namedShare = armContext({ ...params, existingFileShareName: 'kept-state' });
  assert.equal(namedShare.value(template.resources.newDataShare.condition), false);
});

compiledTest('storage keys stay in the secure binding parameter and never evaluate on an inactive branch', () => {
  for (const [params, expectedKey, expectedCalls] of [
    [{}, 'created-storage-test-key', [['listOutputsWithSecureValues', 'storage']]],
    [{ existingStorageAccountName: 'sharedstorage' }, 'existing-storage-test-key', [['listKeys', 'existingStorageAccount']]],
    [{ persistData: false }, '', []],
    [{ persistData: false, existingStorageAccountName: 'sharedstorage' }, '', []],
  ]) {
    const context = armContext(params);
    assert.equal(context.value(template.resources.dataStorage.properties.parameters.accountKey).value, expectedKey);
    assert.deepEqual(context.calls, expectedCalls);
  }
  assert.equal(template.resources.dataStorage.properties.template.parameters.accountKey.type.toLowerCase(), 'securestring');
  assert.doesNotMatch(JSON.stringify(template.outputs), /listKeys|primaryAccessKey|listOutputsWithSecureValues|accountKey/);
});

compiledTest('credential-secret defaults and a UI-specific shared-vault name reach both app and azd output', () => {
  assert.equal(template.parameters.credentialSecretName.defaultValue, 'citadel-credential-key');
  const setting = template.resources.containerApp.properties.template.containers[0].env
    .find((entry) => entry.name === 'CITADEL_CREDENTIAL_SECRET_NAME');
  assert.ok(setting);
  for (const customName of ['citadel-credential-key', 'citadel-ui-alpha-credential-key']) {
    const context = armContext({
      keyVaultName: 'shared-vault',
      keyVaultResourceGroup: 'rg-security',
      credentialSecretName: customName,
    });
    assert.equal(context.output('CITADEL_CREDENTIAL_SECRET_NAME'), customName);
    assert.equal(context.value(setting.value), customName);
    assert.equal(context.value(template.resources.keyVault.condition), false);
    assert.equal(context.value(template.resources.keyVaultSecretsUser.resourceGroup), 'rg-security');
  }
});

for (const [mode, pull, push] of [
  ['LegacyRegistryPermissions', '7f951dda-4ed3-4680-a7ca-43fe172d538d', '8311e382-0749-4cb8-b61a-304f252e45ec'],
  ['AbacRepositoryPermissions', 'b93aa761-3e63-49ed-ac28-beffa264f7ac', '2a1e307c-b015-4ebd-883e-5b7698a07328'],
  [null, '7f951dda-4ed3-4680-a7ca-43fe172d538d', '8311e382-0749-4cb8-b61a-304f252e45ec'],
]) {
  compiledTest(`ACR ${mode ?? 'legacy default'} uses correct registry-scoped app/push/build grants`, () => {
    const context = armContext({
      existingContainerRegistryName: 'sharedregistry',
      existingContainerRegistryResourceGroup: 'rg-images',
      principalId: 'build-principal',
      principalType: 'ServicePrincipal',
    }, { registryProperties: { roleAssignmentMode: mode, loginServer: 'actual-registry-endpoint.azurecr.io' } });
    assert.equal(context.value(template.resources.registry.condition), false);
    assert.equal(template.resources.existingRegistry.existing, true);
    assert.equal(context.value(template.resources.existingRegistry.resourceGroup), 'rg-images');
    assert.equal(context.output('AZURE_CONTAINER_REGISTRY_NAME'), 'sharedregistry');
    assert.equal(context.output('AZURE_CONTAINER_REGISTRY_RESOURCE_GROUP'), 'rg-images');
    assert.equal(context.output('AZURE_CONTAINER_REGISTRY_REUSED'), true);
    assert.equal(context.output('AZURE_CONTAINER_REGISTRY_ROLE_ASSIGNMENT_MODE'), mode ?? 'LegacyRegistryPermissions');
    assert.equal(context.output('AZURE_CONTAINER_REGISTRY_ENDPOINT'), 'actual-registry-endpoint.azurecr.io');
    assert.equal(context.value(template.resources.containerApp.properties.configuration.registries[0].server),
      'actual-registry-endpoint.azurecr.io');
    for (const [name, roleId] of [
      ['acrPull', pull], ['acrPush', push], ['acrBuild', 'fb382eab-e894-4461-af04-94435c366c3f'],
    ]) {
      const resource = template.resources[name];
      assert.equal(context.value(resource.resourceGroup), 'rg-images');
      assert.equal(context.value(resource.properties.parameters.registryName.value), 'sharedregistry');
      // Bicep may emit a conditional parameter as an expression returning the
      // entire { value: ... } object, rather than as { value: expression }.
      assert.equal(context.value(resource.properties.parameters.roleDefinitionId).value, roleId);
      assert.equal(context.value(resource.properties.parameters.principalType.value), 'ServicePrincipal');
      assert.ok(resource.dependsOn.includes('registry'), 'Create path still waits for the conditional registry module.');
      const moduleResources = Object.values(resource.properties.template.resources).filter((entry) => !entry.existing);
      assert.deepEqual(moduleResources.map((entry) => entry.type), ['Microsoft.Authorization/roleAssignments']);
    }
    assert.ok(context.calls.every(([, name]) => name !== 'registry'), 'Reuse must never evaluate unused AVM registry outputs.');
  });
}

compiledTest('new registry grants build permission separately, while omitted deployer has no automatic grants', () => {
  const context = armContext({ principalId: 'human-deployer' });
  assert.equal(context.value(template.resources.acrPush.properties.parameters.roleDefinitionId).value,
    '8311e382-0749-4cb8-b61a-304f252e45ec');
  assert.equal(context.value(template.resources.acrBuild.properties.parameters.roleDefinitionId).value,
    'fb382eab-e894-4461-af04-94435c366c3f');
  assert.equal(context.value(template.resources.acrPush.properties.parameters.principalType.value), 'User');
  const noDeployer = armContext();
  assert.equal(noDeployer.value(template.resources.acrPush.condition), false);
  assert.equal(noDeployer.value(template.resources.acrBuild.condition), false);
});

compiledTest('unknown registry permission modes fail rather than assigning ineffective legacy roles', () => {
  const context = armContext({ existingContainerRegistryName: 'sharedregistry' }, {
    registryProperties: { roleAssignmentMode: 'FuturePermissions' },
  });
  assert.throws(() => context.value(template.resources.acrPull.properties.parameters.roleDefinitionId).value,
    /Unsupported registry roleAssignmentMode/);
});

compiledTest('workspace keys and conditional module outputs are only evaluated on the selected branch', () => {
  for (const [overrides, expectedReference, expectedKey, expectedCustomer] of [
    [{}, 'logAnalytics', 'listOutputsWithSecureValues', 'created-workspace-customer'],
    [{ existingLogAnalyticsWorkspaceName: 'logs', existingLogAnalyticsWorkspaceResourceGroup: 'rg-logs' },
      'existingLogAnalyticsWorkspace', 'listKeys', 'existing-workspace-customer'],
    [{ existingContainerAppsEnvironmentName: 'shared' }, null, null, ''],
  ]) {
    const context = armContext(overrides);
    // Evaluate even when the environment resource's condition is false. This
    // catches unguarded runtime references in conditional resource properties.
    const config = context.value(template.resources.containerAppsEnvironment.properties).appLogsConfiguration.logAnalyticsConfiguration;
    assert.equal(config.customerId, expectedCustomer);
    if (expectedReference) {
      assert.deepEqual(context.calls, [['reference', expectedReference], [expectedKey, expectedReference]]);
      if (overrides.existingLogAnalyticsWorkspaceName) {
        assert.equal(context.value(template.resources.logAnalytics.condition), false);
        assert.equal(context.value(template.resources.existingLogAnalyticsWorkspace.resourceGroup), 'rg-logs');
        assert.match(context.output('AZURE_LOG_ANALYTICS_WORKSPACE_RESOURCE_ID'), /\/resourceGroups\/rg-logs\/providers\/Microsoft.OperationalInsights\/workspaces\/logs$/);
      }
    } else {
      assert.deepEqual(context.calls, []);
      assert.equal(context.value(template.resources.logAnalytics.condition), false);
      assert.equal(context.output('AZURE_LOG_ANALYTICS_WORKSPACE_RESOURCE_ID'), '');
    }
  }
});

compiledTest('shared environment bindings are cross-RG, unique per deployment and secure', () => {
  const params = {
    existingContainerAppsEnvironmentName: 'shared',
    existingContainerAppsEnvironmentResourceGroup: 'rg-environments',
    keyVaultName: 'shared-vault',
    keyVaultResourceGroup: 'rg-vaults',
    principalId: 'deployer-id',
  };
  const context = armContext(params);
  assert.equal(context.value(template.resources.containerAppsEnvironment.condition), false);
  assert.equal(context.value(template.resources.keyVault.condition), false);
  assert.equal(context.value(template.resources.keyVaultSecretsOfficer.condition), false);
  assert.equal(context.value(template.resources.keyVaultSecretsUser.resourceGroup), 'rg-vaults');
  assert.match(context.output('AZURE_CONTAINER_APP_ENVIRONMENT_ID'), /\/resourceGroups\/rg-environments\/providers\/Microsoft.App\/managedEnvironments\/shared$/);
  assert.equal(context.value(template.resources.dataStorage.resourceGroup), 'rg-environments');
  const storageName = context.variable('environmentStorageName');
  assert.notEqual(storageName, 'citadel-data');
  assert.equal(storageName, armContext(params).variable('environmentStorageName'));
  assert.notEqual(storageName, armContext(params, { group: 'another-ui-group' }).variable('environmentStorageName'));
  const child = template.resources.dataStorage.properties.template;
  assert.equal(child.parameters.accountKey.type.toLowerCase(), 'securestring');
  assert.deepEqual(Object.values(child.resources).filter((resource) => !resource.existing).map((resource) => resource.type),
    ['Microsoft.App/managedEnvironments/storages']);
  assert.doesNotMatch(JSON.stringify(template.outputs), /listKeys|listOutputsWithSecureValues|primarySharedKey|primaryAccessKey|entraAuthClientSecret/);
});

for (const [name, params, properties, expectedNetwork, expectedExternal] of [
  ['new public environment defaults closed', {}, {}, 'environment', false],
  ['new public owner opt-in', { allowPublicIngressWithoutAuth: true }, {}, 'internet', true],
  ['new Entra publication', { entraAuthClientId: 'client-id' }, {}, 'internet', true],
  ['new internal subnet overrides public option', { infrastructureSubnetId: subnetResourceId, allowPublicIngressWithoutAuth: true }, {}, 'vnet', true],
  ['shared public environment defaults closed', { existingContainerAppsEnvironmentName: 'shared' }, {}, 'environment', false],
  ['shared external VNet is not a private ILB', { existingContainerAppsEnvironmentName: 'shared' }, { vnetConfiguration: { infrastructureSubnetId: 'subnet-id', internal: false } }, 'environment', false],
  ['shared external VNet deliberate publication', { existingContainerAppsEnvironmentName: 'shared', allowPublicIngressWithoutAuth: true }, { vnetConfiguration: { infrastructureSubnetId: 'subnet-id', internal: false } }, 'internet', true],
  ['shared external VNet Entra publication', { existingContainerAppsEnvironmentName: 'shared', entraAuthClientId: 'client-id' }, { vnetConfiguration: { infrastructureSubnetId: 'subnet-id', internal: false } }, 'internet', true],
  ['shared internal ILB', { existingContainerAppsEnvironmentName: 'shared' }, { vnetConfiguration: { internal: true }, publicNetworkAccess: 'Disabled' }, 'vnet', true],
  ['shared disabled public network cannot be enabled by owner option', { existingContainerAppsEnvironmentName: 'shared', allowPublicIngressWithoutAuth: true }, { publicNetworkAccess: 'Disabled' }, 'environment', false],
  ['shared disabled public network cannot be enabled by Entra', { existingContainerAppsEnvironmentName: 'shared', entraAuthClientId: 'client-id' }, { publicNetworkAccess: 'Disabled' }, 'environment', false],
]) {
  compiledTest(`networking: ${name}`, () => {
    const context = armContext(params, { properties });
    const app = template.resources.containerApp.properties;
    assert.equal(context.value(app.configuration.ingress.external), expectedExternal);
    assert.equal(context.output('SERVICE_CITADELUI_NETWORK'), expectedNetwork);
    assert.equal(context.output('SERVICE_CITADELUI_PUBLIC'), expectedNetwork === 'internet');
    const domain = params.existingContainerAppsEnvironmentName
      ? environmentResource.properties.defaultDomain : 'created.example.azurecontainerapps.io';
    const host = `${context.variable('containerAppName')}.${expectedExternal ? '' : 'internal.'}${domain}`;
    assert.equal(context.output('CITADEL_ALLOWED_HOST'), host);
    assert.equal(context.output('CITADEL_ALLOWED_ORIGIN'), `https://${host}`);
    const callback = context.output('AZURE_AUTH_REDIRECT_URI');
    if (properties.publicNetworkAccess === 'Disabled' && !properties.vnetConfiguration?.internal) {
      assert.equal(callback, `https://${host}/.auth/login/aad/callback`);
    }
  });
}

compiledTest('legacy consumption-only environment does not receive a workloadProfileName', () => {
  const context = armContext({ existingContainerAppsEnvironmentName: 'legacy' }, { properties: { workloadProfiles: null } });
  assert.equal(context.value(template.resources.containerApp.properties.workloadProfileName), null);
});

compiledTest('durable binding remains conditional without changing the required data mount', () => {
  const context = armContext({ persistData: false });
  assert.equal(context.value(template.resources.dataStorage.condition), false);
  const app = template.resources.containerApp.properties.template;
  assert.deepEqual(context.value(app.volumes), [{ name: 'citadel-data', storageType: 'EmptyDir' }]);
  assert.deepEqual(context.value(app.containers[0].volumeMounts), [{ volumeName: 'citadel-data', mountPath: '/data' }]);
  assert.equal(app.scale.maxReplicas, 1);
});

compiledTest('raw Bicep callers get explicit errors for conflicting reuse parameters too', () => {
  for (const [params, error] of [
    [{ existingContainerAppsEnvironmentResourceGroup: 'rg-env' }, /requires AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME/],
    [{ existingLogAnalyticsWorkspaceResourceGroup: 'rg-logs' }, /requires AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME/],
    [{ existingContainerRegistryResourceGroup: 'rg-images' }, /requires AZURE_EXISTING_CONTAINER_REGISTRY_NAME/],
    [{ existingStorageAccountResourceGroup: 'rg-data' }, /requires AZURE_EXISTING_STORAGE_ACCOUNT_NAME/],
    [{ existingFileShareName: 'kept-state' }, /requires AZURE_EXISTING_STORAGE_ACCOUNT_NAME/],
    [{ existingManagedIdentityResourceGroup: 'rg-identities' }, /requires AZURE_EXISTING_MANAGED_IDENTITY_NAME/],
    [{ infrastructureSubnetId: subnetResourceId.replace(inputDefaults.AZURE_SUBSCRIPTION_ID, '11111111-1111-1111-1111-111111111111') }, /deployment subscription/],
  ]) assert.throws(() => armContext(params).variable('resourceToken'), error);
});
