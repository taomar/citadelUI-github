#requires -Version 7.4
<#
.SYNOPSIS
  Package exact allowlisted UI source; privately transfer/install only with -Execute.
.DESCRIPTION
  Needs contract.json from protected-stage.ps1. Default is LOCAL PREPARATION ONLY.
  -Execute sends sequential CSE v2 protectedSettings.script payloads via @JSON
  files, verifies/reassembles source on the VM, and installs its toolchain.
  -Deploy additionally runs azd provision + automatic KV hook + local Docker
  build/push + azd deploy --from-package on that VM. Each CSE step has Azure's
  90-minute limit; no public Blob, SAS URL, Git push or inbound SSH is involved.

  Encoded scripts are checked against 256 KiB. 160-KiB source chunks, SHA-256,
  fixed path allowlists and root-only content-addressed VM directories make
  retries safe. Source/payload artifacts are sensitive: local ACLs and VM modes
  restrict them, but the operator/VM root and Azure agent can still access them.
  Retain only as long as needed; never commit/upload the artifact directory.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ContractPath,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [string]$SourceRoot = (Join-Path $PSScriptRoot '..'),
  [switch]$Execute,
  [switch]$Deploy
)
. (Join-Path $PSScriptRoot 'protected-common.ps1')
$contract = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $ContractPath)) | ConvertFrom-Json
Assert-ProtectedContract $contract
$source = (Get-Item -LiteralPath $SourceRoot).FullName
$files = @(Get-ProtectedSourceFiles $source)
if ($files.Count -gt 500) { throw 'The bounded UI source transfer supports at most 500 files.' }
$artifacts = New-ProtectedArtifactDirectory $OutputDirectory
$archivePath = Join-Path $artifacts 'citadelui-source.zip'
$records = [Collections.Generic.List[object]]::new()
$stream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew)
$zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
$total = 0L
try {
  foreach ($relative in $files) {
    $bytes = [IO.File]::ReadAllBytes((Join-Path $source $relative))
    if ($relative.EndsWith('.sh', [StringComparison]::Ordinal) -and [Array]::IndexOf($bytes, [byte]13) -ge 0) {
      throw "Shell source $relative must use LF line endings before private transfer. No Azure calls were made."
    }
    $total += $bytes.Length
    if ($total -gt 64 * 1024 * 1024) { throw 'Allowlisted source exceeds the 64-MiB uncompressed bound.' }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    $entry = $zip.CreateEntry("CitadelUI/$relative", [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    $entryStream = $entry.Open()
    try { $entryStream.Write($bytes, 0, $bytes.Length) } finally { $entryStream.Dispose() }
    $records.Add([ordered]@{ path = "CitadelUI/$relative"; sha256 = $hash; bytes = $bytes.Length })
  }
} finally { $zip.Dispose(); $stream.Dispose() }
# Fail on concurrent edits instead of transferring a mixed snapshot.
if (@(Compare-Object $files @(Get-ProtectedSourceFiles $source)).Count) { throw 'Source file set changed during packaging; retry after edits finish.' }
foreach ($record in $records) {
  $path = Join-Path $source $record.path.Substring('CitadelUI/'.Length)
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256) {
    throw 'Source changed during packaging; retry after edits finish.'
  }
}
$archive = [IO.File]::ReadAllBytes($archivePath)
if ($archive.Length -gt 32 * 1024 * 1024) { throw 'Compressed source exceeds the 32-MiB transfer bound.' }
$sourceHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{ version = 1; sourceSha256 = $sourceHash; files = @($records.ToArray()) }
Write-ProtectedJson (Join-Path $artifacts 'source-manifest.json') $manifest

$steps = [Collections.Generic.List[object]]::new()
function Add-TransferStep([string]$Name, [string]$Script) {
  $protectedPath = Join-Path $artifacts "$Name.protected.json"
  $settingsPath = Join-Path $artifacts "$Name.settings.json"
  Write-ProtectedJson $protectedPath @{ script = (ConvertTo-ProtectedInlineScript $Script) }
  Write-ProtectedJson $settingsPath @{
    skipDos2Unix = $true
    timestamp = [Security.Cryptography.RandomNumberGenerator]::GetInt32(1, [int]::MaxValue)
  }
  $steps.Add(@{ name = $Name; protectedPath = $protectedPath; settingsPath = $settingsPath })
}
function New-PythonStep([string]$Code) {
  if ($Code -match '(?m)^CITADEL_PROTECTED_PY\r?$') { throw 'Unexpected receiver script delimiter.' }
  # Use stdin: encoded chunks can exceed Linux's per-argument size limit.
  return "#!/bin/sh`nset -eu`numask 077`npython3 - <<'CITADEL_PROTECTED_PY'`n$Code`nCITADEL_PROTECTED_PY`n"
}

$chunkBytes = 160 * 1024
$chunkCount = [int][Math]::Ceiling($archive.Length / [double]$chunkBytes)
for ($index = 0; $index -lt $chunkCount; $index++) {
  $length = [Math]::Min($chunkBytes, $archive.Length - $index * $chunkBytes)
  $chunk = [Convert]::ToBase64String($archive, $index * $chunkBytes, $length)
  $code = @'
import base64,os,uuid
from pathlib import Path
if os.geteuid()!=0: raise SystemExit("Protected transfer requires root.")
root=Path("/var/lib/citadel-protected")
for p in [root,root/"transfers",root/"transfers"/"@HASH@"]:
    if p.is_symlink(): raise SystemExit("Refusing a symlink in the transfer path.")
    p.mkdir(mode=0o700,exist_ok=True)
    p.chmod(0o700)
target=root/"transfers"/"@HASH@"/"@INDEX@.part"
temp=target.with_name(target.name+"."+uuid.uuid4().hex)
with temp.open("xb") as f: f.write(base64.b64decode("@CHUNK@",validate=True))
os.replace(temp,target)
print("Protected source chunk received.")
'@
  $code = $code.Replace('@HASH@', $sourceHash).Replace('@INDEX@', $index.ToString('D5')).Replace('@CHUNK@', $chunk)
  Add-TransferStep ("chunk-" + $index.ToString('D5')) (New-PythonStep $code)
}

$manifestBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Depth 10 -Compress)))
$contractBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($contract | ConvertTo-Json -Depth 10 -Compress)))
$assemble = @'
import base64,hashlib,io,json,os,stat,uuid,zipfile
from pathlib import Path,PurePosixPath
if os.geteuid()!=0: raise SystemExit("Protected assembly requires root.")
root=Path("/var/lib/citadel-protected")
transfer=root/"transfers"/"@HASH@"
archive=b"".join((transfer/("%05d.part"%i)).read_bytes() for i in range(@COUNT@))
if hashlib.sha256(archive).hexdigest()!="@HASH@": raise SystemExit("Source archive SHA-256 mismatch.")
manifest=json.loads(base64.b64decode("@MANIFEST@",validate=True))
expected={f["path"]:f for f in manifest["files"]}
fixed={"Dockerfile",".dockerignore","README.md","azure.yaml"}
folders={"server","shared","web","infra","scripts"}
blocked={"node_modules","test","tests","keys","secrets","artifacts","coverage","tools"}
sources=root/"sources"
if sources.is_symlink(): raise SystemExit("Refusing source path symlink.")
sources.mkdir(mode=0o700,exist_ok=True)
destination=sources/"@HASH@"
if destination.is_symlink(): raise SystemExit("Refusing source release symlink.")
incoming=sources/("@HASH@.incoming-"+uuid.uuid4().hex)
new=not destination.exists()
if new: incoming.mkdir(mode=0o700)
with zipfile.ZipFile(io.BytesIO(archive)) as z:
    if len(z.infolist())!=len(expected): raise SystemExit("Unexpected source file count.")
    seen=set()
    for entry in z.infolist():
        path=PurePosixPath(entry.filename)
        parts=path.parts
        mode=entry.external_attr>>16
        if (path.is_absolute() or "\\" in entry.filename or ":" in entry.filename or
            ".." in parts or len(parts)<2 or parts[0]!="CitadelUI" or
            entry.is_dir() or stat.S_ISLNK(mode) or
            entry.filename in seen or entry.filename not in expected):
            raise SystemExit("Unsafe or unexpected archive member.")
        if len(parts)==2:
            if parts[1] not in fixed: raise SystemExit("Non-allowlisted source file.")
        elif parts[1] not in folders or any(p.startswith(".") or p in blocked for p in parts[2:]):
            raise SystemExit("Non-allowlisted source directory.")
        seen.add(entry.filename)
        data=z.read(entry)
        record=expected[entry.filename]
        if len(data)!=record["bytes"] or hashlib.sha256(data).hexdigest()!=record["sha256"]:
            raise SystemExit("Source member checksum mismatch.")
        if new:
            target=incoming.joinpath(*parts)
            target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            with target.open("xb") as f: f.write(data)
            target.chmod(0o600)
        else:
            target=destination.joinpath(*parts)
            if target.is_symlink() or hashlib.sha256(target.read_bytes()).hexdigest()!=record["sha256"]:
                raise SystemExit("Existing source release has changed; refusing to overwrite.")
if new: os.rename(incoming,destination)
for name,data in [
    ("contract.json",base64.b64decode("@CONTRACT@",validate=True)),
    ("source-manifest.json",base64.b64decode("@MANIFEST@",validate=True))]:
    target=transfer/name
    temp=target.with_name(name+"."+uuid.uuid4().hex)
    with temp.open("xb") as f: f.write(data)
    os.replace(temp,target)
print("Protected source reassembled and SHA-256 verified.")
'@
$assemble = $assemble.Replace('@HASH@', $sourceHash).Replace('@COUNT@', [string]$chunkCount).
  Replace('@MANIFEST@', $manifestBase64).Replace('@CONTRACT@', $contractBase64)
Add-TransferStep 'assemble' (New-PythonStep $assemble)
$remoteSource = "/var/lib/citadel-protected/sources/$sourceHash/CitadelUI"
$remoteContract = "/var/lib/citadel-protected/transfers/$sourceHash/contract.json"
Add-TransferStep 'toolchain' "#!/bin/sh`nset -eu`numask 077`nbash '$remoteSource/scripts/protected-bootstrap.sh'`n"
if ($Deploy) {
  Add-TransferStep 'deploy' ("#!/bin/sh`nset -eu`numask 077`npwsh -NoLogo -NoProfile -NonInteractive -File " +
    "'$remoteSource/scripts/protected-runner.ps1' -SourceDirectory '$remoteSource' " +
    "-ContractPath '$remoteContract' -SourceSha256 '$sourceHash'`n")
}
Write-ProtectedJson (Join-Path $artifacts 'transfer.json') @{
  sourceSha256 = $sourceHash
  files = $files.Count
  chunkCount = $chunkCount
  remoteSource = $remoteSource
  remoteContract = $remoteContract
  steps = @($steps.ToArray())
}
if (-not $Execute) {
  Write-Host "Prepared $($files.Count) allowlisted files, $chunkCount bounded chunks. SHA-256: $sourceHash"
  Write-Host "No Azure calls. Sensitive local payloads: $artifacts"
  return
}

$s = $contract.selectors
$vm = (Invoke-ProtectedNative az @(
  'vm', 'show', '--resource-group', $contract.platformResourceGroup, '--name', $contract.runnerName,
  '--subscription', $s.AZURE_SUBSCRIPTION_ID, '--output', 'json', '--only-show-errors'
) 'Verify staged private runner') | ConvertFrom-Json
if ($vm.location -cne $s.AZURE_LOCATION -or
    $contract.runnerIdentityId -notin @($vm.identity.userAssignedIdentities.PSObject.Properties.Name)) {
  throw 'The selected VM does not match the staged runner identity/location.'
}
foreach ($nic in $vm.networkProfile.networkInterfaces) {
  $network = (Invoke-ProtectedNative az @('network', 'nic', 'show', '--ids', $nic.id, '--output', 'json', '--only-show-errors') 'Verify private runner NIC') | ConvertFrom-Json -AsHashtable
  if (@($network.ipConfigurations | Where-Object { $_['publicIPAddress'] }).Count) {
    throw 'The runner NIC has a public IP; refusing transfer.'
  }
}
foreach ($step in $steps) {
  Write-Host "Protected runner operation: $($step.name)"
  $null = Invoke-ProtectedNative az @(
    'vm', 'extension', 'set', '--resource-group', $contract.platformResourceGroup, '--vm-name', $contract.runnerName,
    '--subscription', $s.AZURE_SUBSCRIPTION_ID, '--publisher', 'Microsoft.Azure.Extensions',
    '--name', 'CustomScript', '--extension-instance-name', 'citadel-protected', '--version', '2.1',
    '--settings', "@$($step.settingsPath)", '--protected-settings', "@$($step.protectedPath)",
    '--force-update', '--output', 'none', '--only-show-errors'
  ) "Private runner $($step.name)"
}
Write-Host "Protected source verified on runner: $sourceHash"
Write-Host $(if ($Deploy) { 'Private UI deployment completed. Acceptance checks remain the operator responsibility.' } else { 'Private toolchain ready. No UI provisioning or image deployment was requested.' })
