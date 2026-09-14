import electron from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userData = await mkdtemp(join(tmpdir(), 'citadel-electron-smoke-'));
try {
  const child = spawn(electron, ['.'], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      CITADEL_DESKTOP_SMOKE_TEST: 'true',
      CITADEL_DESKTOP_USER_DATA_ROOT: userData,
    },
    stdio: 'inherit',
  });

  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
} finally {
  await rm(userData, { recursive: true, force: true });
}
