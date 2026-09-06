# Shared by the protected staging scripts; dot-sourcing performs no Azure calls.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-ProtectedNative {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(Mandatory)][string[]]$ArgumentList,
    [Parameter(Mandatory)][string]$Step
  )
  # Capture both streams. In particular, never echo CSE payloads, azd environment
  # contents, registry tokens or native arguments in a failure message.
  $result = @(& $FilePath @ArgumentList 2>&1)
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "$Step failed (native exit $code). No network/security fallback was attempted." }
  return ($result -join "`n").Trim()
}

function Assert-ProtectedGroupNames {
  param([string]$PlatformGroup, [string]$UiGroup)
  # Exact, directional live approval; do not allow arbitrary rg-citadel-live-*.
  if ($PlatformGroup -ceq 'rg-citadel-live-private-20260906' -and
      $UiGroup -ceq 'rg-citadel-live-reuse-20260906') { return }
  foreach ($name in @($PlatformGroup, $UiGroup)) {
    if ($name -cnotmatch '^rg-citadel-protected-[a-z0-9][a-z0-9-]{1,65}$') {
      throw 'Use dedicated rg-citadel-protected- groups or the exact approved live platform/UI pair.'
    }
  }
  if ($PlatformGroup -eq $UiGroup) { throw 'The protected platform and UI resource groups must be different.' }
}

function Assert-ProtectedContract {
  param([Parameter(Mandatory)]$Contract)
  $contractKeys = @(
    'version', 'platformResourceGroup', 'runnerName', 'runnerIdentityId', 'runnerClientId',
    'runnerPrincipalId', 'workspaceResourceId', 'workspaceCustomerId', 'virtualNetworkId',
    'environmentDomain', 'registryLoginServer', 'evidenceContainerName', 'selectors'
  )
  if (@(Compare-Object ($contractKeys | Sort-Object) (@($Contract.PSObject.Properties.Name) | Sort-Object)).Count) {
    throw 'The staging contract must contain only the known nonsensitive selectors and resource IDs.'
  }
  if ($Contract.version -ne 1) { throw 'Unsupported protected staging contract version.' }
  $s = $Contract.selectors
  $keys = @(
    'AZURE_SUBSCRIPTION_ID', 'AZURE_LOCATION', 'AZURE_ENV_NAME', 'AZURE_RESOURCE_GROUP',
    'AZURE_PRINCIPAL_ID', 'AZURE_PRINCIPAL_TYPE',
    'AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME', 'AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP',
    'AZURE_EXISTING_CONTAINER_REGISTRY_NAME', 'AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP',
    'AZURE_KEY_VAULT_NAME', 'AZURE_KEY_VAULT_RESOURCE_GROUP',
    'AZURE_EXISTING_STORAGE_ACCOUNT_NAME', 'AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP',
    'AZURE_EXISTING_FILE_SHARE_NAME', 'AZURE_EXISTING_MANAGED_IDENTITY_NAME',
    'AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP', 'CITADEL_CREDENTIAL_SECRET_NAME',
    'CITADEL_PRIVATE_DEPLOYMENT', 'ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH'
  )
  $actual = @($s.PSObject.Properties.Name)
  if (@(Compare-Object ($keys | Sort-Object) ($actual | Sort-Object)).Count) {
    throw 'The contract must contain exactly the protected existing-resource selectors; no subnet, LA or auth overrides.'
  }
  foreach ($key in $keys) {
    if ($s.$key -isnot [string] -or $s.$key -cnotmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,126}$') {
      throw "Invalid or empty selector $key."
    }
  }
  Assert-ProtectedGroupNames $Contract.platformResourceGroup $s.AZURE_RESOURCE_GROUP
  if ($s.AZURE_ENV_NAME -cnotmatch '^[a-z][a-z0-9-]{2,39}$') { throw 'Invalid protected azd environment name.' }
  foreach ($key in @('AZURE_SUBSCRIPTION_ID', 'AZURE_PRINCIPAL_ID')) {
    if ($s.$key -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw "Invalid GUID in $key." }
  }
  foreach ($id in @($Contract.runnerClientId, $Contract.runnerPrincipalId, $Contract.workspaceCustomerId)) {
    if ($id -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'Invalid runner identity GUID.' }
  }
  foreach ($key in $keys | Where-Object { $_ -like '*_RESOURCE_GROUP' -and $_ -ne 'AZURE_RESOURCE_GROUP' }) {
    if ($s.$key -cne $Contract.platformResourceGroup) { throw 'Every shared-resource selector must target the staged platform group.' }
  }
  if ($s.AZURE_PRINCIPAL_ID -ne $Contract.runnerPrincipalId -or
      $s.AZURE_PRINCIPAL_TYPE -cne 'ServicePrincipal' -or
      $s.CITADEL_PRIVATE_DEPLOYMENT -cne 'true' -or
      $s.ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH -cne 'false') { throw 'The protected identity/ingress contract has changed.' }
  if ($Contract.runnerName -cnotmatch '^vm-protected-[a-z0-9]{13}$' -or
      $Contract.registryLoginServer -cne "$($s.AZURE_EXISTING_CONTAINER_REGISTRY_NAME).azurecr.io" -or
      $Contract.environmentDomain -cnotmatch '^[a-z0-9][a-z0-9.-]+\.azurecontainerapps\.io$' -or
      $Contract.evidenceContainerName -cnotin @('', 'private-evidence')) {
    throw 'Invalid runner or registry endpoint. Only AzureCloud is supported.'
  }
  $prefix = "/subscriptions/$($s.AZURE_SUBSCRIPTION_ID)/resourceGroups/$($Contract.platformResourceGroup)/providers/"
  if (-not $Contract.runnerIdentityId.StartsWith("${prefix}Microsoft.ManagedIdentity/userAssignedIdentities/", [StringComparison]::OrdinalIgnoreCase) -or
      -not $Contract.workspaceResourceId.StartsWith("${prefix}Microsoft.OperationalInsights/workspaces/", [StringComparison]::OrdinalIgnoreCase) -or
      -not $Contract.virtualNetworkId.StartsWith("${prefix}Microsoft.Network/virtualNetworks/", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Runner/workspace resource IDs must belong to the staged platform.'
  }
}

function New-ProtectedArtifactDirectory {
  param([Parameter(Mandatory)][string]$OutputDirectory)
  $root = [IO.Path]::GetFullPath($OutputDirectory)
  # Never package credentials/build artifacts back into this UI or its parent.
  $uiRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  $repoRoot = [IO.Directory]::GetParent($uiRoot).FullName
  if ($root.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $root.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be outside the source worktree.'
  }
  $directory = Join-Path $root ('protected-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($directory)
  if ($IsWindows) {
    $acl = Get-Acl -LiteralPath $directory
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $directory -AclObject $acl
  } else {
    $null = Invoke-ProtectedNative chmod @('700', $directory) 'Restrict artifact directory'
  }
  return $directory
}

function Write-ProtectedJson {
  param([string]$Path, [Parameter(Mandatory)]$Value)
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
}

function Get-ProtectedSourceFiles {
  param([Parameter(Mandatory)][string]$SourceRoot)
  $root = (Get-Item -LiteralPath $SourceRoot -Force).FullName
  if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'A source root symlink/junction is not allowed.'
  }
  # Nothing from the gateway, samples, .azure, owner state or test artifacts.
  $fixed = @('Dockerfile', '.dockerignore', 'README.md', 'azure.yaml')
  $directories = @('server', 'shared', 'web', 'infra', 'scripts')
  $skipDirectories = @('node_modules', 'test', 'tests', 'keys', 'secrets', 'artifacts', 'coverage', 'tools')
  $extensions = @('.mjs', '.js', '.json', '.html', '.css', '.svg', '.png', '.ico', '.woff2', '.bicep', '.ps1', '.sh')
  $result = [Collections.Generic.List[string]]::new()
  foreach ($name in $fixed) {
    $file = Get-Item -LiteralPath (Join-Path $root $name) -Force
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Required source file $name is not a regular file."
    }
    $result.Add($name)
  }
  $pending = [Collections.Generic.Stack[string]]::new()
  foreach ($name in $directories) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $name) -PathType Container)) { throw "Missing source directory $name." }
    $pending.Push($name)
  }
  while ($pending.Count) {
    $relative = $pending.Pop()
    $dir = Get-Item -LiteralPath (Join-Path $root $relative) -Force
    if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source directory symlinks/junctions are forbidden.' }
    foreach ($item in Get-ChildItem -LiteralPath $dir.FullName -Force) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source symlinks/junctions are forbidden.' }
      if ($item.Name.StartsWith('.') -or $item.Name -in $skipDirectories) { continue }
      $path = "$relative/$($item.Name)"
      if ($item.PSIsContainer) { $pending.Push($path); continue }
      # The editable, source-controlled azd input file is required by the
      # preprovision hook. Do NOT include arbitrary/generated .bicepparam files.
      if ($item.Extension -notin $extensions -and $path -cne 'infra/main.bicepparam') { continue }
      # credentials.mjs is application CODE; credentials.json is runtime data.
      if ($item.Extension -eq '.json' -and
          $item.Name -match '(?i)(^|[._-])(secret|secrets|credentials|privatekey|id_rsa)([._-]|$)') { continue }
      $result.Add($path)
    }
  }
  return @($result | Sort-Object -CaseSensitive)
}

function ConvertTo-ProtectedInlineScript {
  param([Parameter(Mandatory)][string]$Script)
  $buffer = [IO.MemoryStream]::new()
  $gzip = [IO.Compression.GZipStream]::new($buffer, [IO.Compression.CompressionLevel]::Optimal, $true)
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Script.Replace("`r`n", "`n"))
    $gzip.Write($bytes, 0, $bytes.Length)
  } finally { $gzip.Dispose() }
  try { $encoded = [Convert]::ToBase64String($buffer.ToArray()) } finally { $buffer.Dispose() }
  # CSE v2's 256-KiB limit is on the ENCODED script, not original source.
  if ($encoded.Length -gt 256 * 1024) { throw 'Inline script exceeds the CSE 256-KiB encoded limit.' }
  return $encoded
}

function ConvertTo-ProtectedShellLiteral {
  param([Parameter(Mandatory)][string]$Value)
  return "'" + $Value.Replace("'", "'\''") + "'"
}
