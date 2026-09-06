import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const script = fileURLToPath(new URL('../scripts/ensure-credential-key.ps1', import.meta.url));
const mockCommands = String.raw`
  function azd {
    $global:LASTEXITCODE = 0
    switch ($args[2]) {
      'AZURE_SUBSCRIPTION_ID' { 'test-subscription' }
      'AZURE_KEY_VAULT_NAME' { 'test-vault' }
      'CITADEL_CREDENTIAL_SECRET_NAME' { 'ui-credential-key' }
      default { throw 'Unexpected azd command.' }
    }
  }
  function az {
    $global:LASTEXITCODE = 0
    if (($args[0..2] -join ' ') -eq 'keyvault secret list') {
      if ($env:CITADEL_TEST_CASE -eq 'denied') {
        $global:LASTEXITCODE = 1
        return
      }
      switch ($env:CITADEL_TEST_CASE) {
        'existing' { '[{"enabled":true,"expires":null,"notBefore":null}]' }
        'disabled' { '[{"enabled":false,"expires":null,"notBefore":null}]' }
        'expired' { '[{"enabled":true,"expires":"2000-01-01T00:00:00+00:00","notBefore":null}]' }
        'future' { '[{"enabled":true,"expires":null,"notBefore":"2999-01-01T00:00:00+00:00"}]' }
        'malformed' { '{"error":"not a metadata list"}' }
        'malformed-null' { 'null' }
        'malformed-array' { '[[]]' }
        'string-enabled' { '[{"enabled":"true","expires":null,"notBefore":null}]' }
        'numeric-enabled' { '[{"enabled":1,"expires":null,"notBefore":null}]' }
        default { '[]' }
      }
      return
    }
    if (($args[0..2] -join ' ') -ne 'keyvault secret set') {
      throw 'Unexpected Azure command.'
    }
    $key = $args[[Array]::IndexOf($args, '--value') + 1]
    $record = @{
      bytes = [Convert]::FromBase64String($key).Length
      vault = $args[[Array]::IndexOf($args, '--vault-name') + 1]
      name = $args[[Array]::IndexOf($args, '--name') + 1]
      subscription = $args[[Array]::IndexOf($args, '--subscription') + 1]
      output = $args[[Array]::IndexOf($args, '--output') + 1]
    }
    [System.IO.File]::WriteAllText($env:CITADEL_TEST_RECORD, ($record | ConvertTo-Json -Compress))
    if ($env:CITADEL_TEST_CASE -eq 'set-denied') { $global:LASTEXITCODE = 1 }
  }
  & $env:CITADEL_TEST_SCRIPT
`;

async function initialize(t, scenario) {
  const probe = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (probe.error?.code === 'ENOENT') {
    t.skip('PowerShell is not installed.');
    return null;
  }
  assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
  const directory = await mkdtemp(join(tmpdir(), 'citadel-key-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recordPath = join(directory, 'operation.json');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', mockCommands], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      CITADEL_TEST_CASE: scenario,
      CITADEL_TEST_SCRIPT: script,
      CITADEL_TEST_RECORD: recordPath,
    },
  });
  assert.ifError(result.error);
  let record = null;
  try {
    record = JSON.parse(await readFile(recordPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...result, record };
}

test('credential key setup: a missing key is created as 32 random bytes without printing it', async (t) => {
  const result = await initialize(t, 'absent');
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.record, {
    bytes: 32,
    vault: 'test-vault',
    name: 'ui-credential-key',
    subscription: 'test-subscription',
    output: 'none',
  });
  assert.match(result.stdout, /Created the Key Vault credential key/);
  assert.doesNotMatch(result.stdout, /[A-Za-z0-9+/]{43}=/);
});

test('credential key setup: an existing key is preserved without a secret write', async (t) => {
  const result = await initialize(t, 'existing');
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.record, null);
  assert.match(result.stdout, /Preserving the existing Key Vault credential key/);
});

for (const scenario of ['denied', 'disabled', 'expired', 'future', 'malformed', 'malformed-null', 'malformed-array', 'string-enabled', 'numeric-enabled']) {
  test(`credential key setup: ${scenario} metadata fails without replacing the key`, async (t) => {
    const result = await initialize(t, scenario);
    if (!result) return;
    assert.notEqual(result.status, 0);
    assert.equal(result.record, null);
    assert.doesNotMatch(result.stdout, /Created|Preserving/);
  });
}

test('credential key setup: a failed secret write does not report successful creation', async (t) => {
  const result = await initialize(t, 'set-denied');
  if (!result) return;
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /Created the Key Vault credential key/);
  assert.match(result.stderr, /Could not create the credential key/);
});
