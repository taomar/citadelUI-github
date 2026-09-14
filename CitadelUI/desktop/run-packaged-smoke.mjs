import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const options = new Map();
for (const argument of process.argv.slice(2)) {
  const [key, value] = argument.replace(/^--/, '').split('=', 2);
  options.set(key, value);
}
const platform = options.get('platform') || process.platform;
const arch = options.get('arch') || process.arch;
const packageRoot = resolve(desktopRoot, 'out', `Citadel UI-${platform}-${arch}`);

async function executablePath() {
  if (platform === 'win32') return resolve(packageRoot, 'CitadelUI.exe');
  if (platform !== 'darwin') throw new Error(`Unsupported smoke-test platform: ${platform}.`);
  const macosRoot = resolve(packageRoot, 'Citadel UI.app', 'Contents', 'MacOS');
  const entries = (await readdir(macosRoot, { withFileTypes: true })).filter((entry) =>
    entry.isFile()
  );
  if (entries.length !== 1) throw new Error('The packaged macOS executable is ambiguous.');
  return resolve(macosRoot, entries[0].name);
}

const executable = await executablePath();
await access(executable);
const userData = await mkdtemp(join(tmpdir(), 'citadel-packaged-smoke-'));
let child;
let timedOut = false;
try {
  child = spawn(executable, [], {
    env: {
      ...process.env,
      CITADEL_DESKTOP_SMOKE_TEST: 'true',
      CITADEL_DESKTOP_USER_DATA_ROOT: userData,
    },
    stdio: 'inherit',
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 60_000);
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
  });
  clearTimeout(timer);
  if (timedOut) throw new Error('The packaged Electron smoke test timed out.');
  if (code !== 0) throw new Error(`The packaged Electron smoke test exited ${code}.`);
  console.log(
    JSON.stringify({
      event: 'citadel_desktop_packaged_smoke',
      platform,
      arch,
      status: 'passed',
    })
  );
} finally {
  await rm(userData, { recursive: true, force: true });
}
