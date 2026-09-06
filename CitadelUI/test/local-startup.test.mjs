import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const shells = [
  {
    name: 'PowerShell',
    command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    versionArgs: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    script: 'start.ps1',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      String.raw`
        function docker {
          [System.IO.File]::WriteAllLines($env:CITADEL_TEST_DOCKER_LOG, [string[]]$args)
          $global:LASTEXITCODE = [int]$env:CITADEL_TEST_DOCKER_EXIT
        }
        & $env:CITADEL_TEST_SCRIPT
        exit $LASTEXITCODE
      `,
    ],
  },
  {
    name: 'Bash',
    command: 'bash',
    versionArgs: ['--version'],
    script: 'start.sh',
    args: [
      '-c',
      String.raw`
        docker() {
          for argument in "$@"; do
            if [[ "$CITADEL_TEST_WINDOWS" == 1 && "$argument" == /* ]]; then
              cygpath -m "$argument"
            else
              printf '%s\n' "$argument"
            fi
          done > "$CITADEL_TEST_DOCKER_LOG"
          return "$CITADEL_TEST_DOCKER_EXIT"
        }
        export -f docker
        bash "$CITADEL_TEST_SCRIPT"
      `,
    ],
  },
];

async function normalizePath(value) {
  const normalized = (await realpath(value)).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function runStartup(t, shell, { envFile = true, exitCode = 0 } = {}) {
  const available = spawnSync(shell.command, shell.versionArgs, { encoding: 'utf8', timeout: 10_000 });
  if (available.error?.code === 'ENOENT') {
    t.skip(`${shell.name} is not installed.`);
    return null;
  }
  assert.equal(available.status, 0, available.error?.message || available.stderr);

  const temporary = await mkdtemp(join(tmpdir(), 'citadel startup '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = join(temporary, 'UI with spaces');
  const scripts = join(project, 'scripts');
  await mkdir(scripts, { recursive: true });
  const script = join(scripts, shell.script);
  await copyFile(new URL(`../scripts/${shell.script}`, import.meta.url), script);
  await copyFile(new URL('../compose.yaml', import.meta.url), join(project, 'compose.yaml'));
  if (envFile) {
    await writeFile(join(project, 'container.env'), 'CITADEL_DATA_PATH=./custom state\n');
  }
  const log = join(temporary, 'docker arguments.txt');
  const result = spawnSync(shell.command, shell.args, {
    // Deliberately outside the project: both launchers must anchor Compose
    // and container.env to the script, not to the caller's working directory.
    cwd: temporary,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      CITADEL_TEST_SCRIPT: script.replaceAll('\\', '/'),
      CITADEL_TEST_DOCKER_LOG: log.replaceAll('\\', '/'),
      CITADEL_TEST_DOCKER_EXIT: String(exitCode),
      CITADEL_TEST_WINDOWS: process.platform === 'win32' ? '1' : '0',
    },
  });
  assert.ifError(result.error);
  const args = (await readFile(log, 'utf8')).trim().split(/\r?\n/);
  assert.equal(args[0], 'compose');
  assert.equal(await normalizePath(args[args.indexOf('--project-directory') + 1]), await normalizePath(project));
  assert.equal(await normalizePath(args[args.indexOf('--file') + 1]), await normalizePath(join(project, 'compose.yaml')));
  assert.deepEqual(args.slice(-6), ['up', '--detach', '--build', '--wait', '--wait-timeout', '120']);
  if (envFile) {
    assert.equal(await normalizePath(args[args.indexOf('--env-file') + 1]), await normalizePath(join(project, 'container.env')));
  } else {
    assert.ok(!args.includes('--env-file'));
  }
  return result;
}

test('local startup: shell scripts retain LF even in Windows Git checkouts', async () => {
  const attributes = await readFile(new URL('../.gitattributes', import.meta.url), 'utf8');
  const ignore = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(attributes, /^scripts\/\*\.sh text eol=lf\r?$/m);
  assert.match(ignore, /^!CitadelUI\/\.gitattributes\r?$/m);
});

for (const shell of shells) {
  test(`local startup: ${shell.name} resolves the project and env file from another directory`, async (t) => {
    const result = await runStartup(t, shell);
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /available at http:\/\/127\.0\.0\.1:4173/);
  });

  test(`local startup: ${shell.name} supports Compose defaults without an env file`, async (t) => {
    const result = await runStartup(t, shell, { envFile: false });
    if (!result) return;
    assert.equal(result.status, 0, result.stderr);
  });

  test(`local startup: ${shell.name} propagates a failed or unhealthy startup`, async (t) => {
    const result = await runStartup(t, shell, { exitCode: 37 });
    if (!result) return;
    assert.equal(result.status, 37);
    assert.doesNotMatch(result.stdout, /available at/);
    assert.match(result.stderr, /did not\s+become healthy/);
  });
}
