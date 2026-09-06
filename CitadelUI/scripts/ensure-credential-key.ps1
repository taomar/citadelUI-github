<#
.SYNOPSIS
  Keeps the selected Key Vault credential key, or creates it once when absent.
  Run after azd provision and before deploying the Citadel UI image.
#>
$ErrorActionPreference = 'Stop'

function Get-DeploymentValue([string]$Name) {
  $value = azd env get-value $Name
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($value | Out-String))) {
    throw "Could not read $Name. Select the UI azd environment and provision it first."
  }
  return ($value | Out-String).Trim()
}

$subscriptionId = Get-DeploymentValue 'AZURE_SUBSCRIPTION_ID'
$vaultName = Get-DeploymentValue 'AZURE_KEY_VAULT_NAME'
$secretName = Get-DeploymentValue 'CITADEL_CREDENTIAL_SECRET_NAME'
if ($secretName -notmatch '^[0-9a-zA-Z-]{1,127}$') {
  throw 'The credential secret name must contain 1-127 letters, digits or hyphens.'
}

# Read metadata only. An existing key must never be rotated by a deployment.
$metadata = az keyvault secret list --subscription $subscriptionId --vault-name $vaultName --query "[?name=='$secretName'].{enabled:attributes.enabled,expires:attributes.expires,notBefore:attributes.notBefore}" --output json --only-show-errors
if ($LASTEXITCODE -ne 0) {
  throw 'Cannot read Key Vault secret metadata. Check vault access and networking; no key was created or replaced.'
}
$metadataText = ($metadata | Out-String).Trim()
if (-not $metadataText.StartsWith('[')) {
  throw 'Key Vault did not return a secret metadata list. No key was changed.'
}
$secrets = @(ConvertFrom-Json -InputObject $metadataText | ForEach-Object { $_ })
if ($secrets.Count -eq 0 -and $metadataText -notmatch '^\[\s*\]$') {
  throw 'Key Vault returned invalid credential-key metadata. No key was changed.'
}
if ($secrets.Count -gt 1) {
  throw 'Key Vault returned ambiguous credential-key metadata. No key was changed.'
}
if ($secrets.Count -eq 1) {
  $secret = $secrets[0]
  if ($secret.enabled -isnot [bool]) {
    throw 'Key Vault returned an invalid credential-key enabled flag. No key was changed.'
  }
  if (-not $secret.enabled) {
    throw 'The existing credential key is disabled. Have its owner enable it; do not replace it.'
  }
  $now = [DateTimeOffset]::UtcNow
  if ($secret.expires -and [DateTimeOffset]::Parse($secret.expires) -le $now) {
    throw 'The existing credential key is expired. Have its owner review its expiry; do not replace its value.'
  }
  if ($secret.notBefore -and [DateTimeOffset]::Parse($secret.notBefore) -gt $now) {
    throw 'The existing credential key is not yet active. Have its owner review its activation time.'
  }
  Write-Host 'Preserving the existing Key Vault credential key.'
  return
}

$bytes = New-Object byte[] 32
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
$credentialKey = [Convert]::ToBase64String($bytes)
try {
  az keyvault secret set --subscription $subscriptionId --vault-name $vaultName --name $secretName --value $credentialKey --output none --only-show-errors
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not create the credential key. Check secret-write permission and soft-deleted secrets before retrying.'
  }
} finally {
  [Array]::Clear($bytes, 0, $bytes.Length)
  Remove-Variable credentialKey
}
Write-Host 'Created the Key Vault credential key. Future deployments will preserve it.'
