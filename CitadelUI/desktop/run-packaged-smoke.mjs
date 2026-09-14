import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { verifyPackagedSources } from './source-integrity.mjs';

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const options = new Map();
for (const argument of process.argv.slice(2)) {
  const [key, value] = argument.replace(/^--/, '').split('=', 2);
  options.set(key, value);
}
const platform = options.get('platform') || process.platform;
const arch = options.get('arch') || process.arch;
const packageRoot = options.has('package-root')
  ? resolve(options.get('package-root'))
  : resolve(desktopRoot, 'out', `Citadel UI-${platform}-${arch}`);

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
const resources = platform === 'darwin'
  ? resolve(packageRoot, 'Citadel UI.app', 'Contents', 'Resources')
  : resolve(packageRoot, 'resources');
const build = await verifyPackagedSources(resources);
const source = JSON.parse(await readFile(resolve(desktopRoot, 'application-source.json'), 'utf8'));
if (build.applicationRevision !== source.revision) {
  throw new Error('The package contains a different application revision than the reviewed source.');
}
const userData = await mkdtemp(join(tmpdir(), 'citadel-packaged-smoke-'));
let child;
let timedOut = false;
let output = '';
let timer;
try {
  child = spawn(executable, [], {
    env: {
      ...process.env,
      CITADEL_DESKTOP_SMOKE_TEST: 'true',
      CITADEL_DESKTOP_USER_DATA_ROOT: userData,
      CITADEL_DESKTOP_SMOKE_SCREENSHOT: resolve(desktopRoot, '.generated', `source-step-${platform}-${arch}.png`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 120_000);
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
  });
  clearTimeout(timer);
  if (timedOut) throw new Error('The packaged Electron smoke test timed out.');
  if (code !== 0) throw new Error(`The packaged Electron smoke test exited ${code}.`);
  const summary = output.split(/\r?\n/).find((line) => line.startsWith('{"event":"citadel_desktop_smoke",'));
  const result = summary && JSON.parse(summary);
  if (!result?.passed || result.applicationRevision !== source.revision ||
      result.version !== build.version || !result.interface?.currentSourceChoices ||
      !result.interface?.nativeParser || !result.interface?.diagnostics ||
      !result.interface?.versionBadge?.text?.startsWith(`v${build.version} | ${source.revision.slice(0, 7)}`)) {
    throw new Error('The packaged process did not prove the current application UI and source revision.');
  }
  console.log(
    JSON.stringify({
      event: 'citadel_desktop_packaged_smoke',
      platform,
      arch,
      status: 'passed',
      applicationRevision: result.applicationRevision,
    })
  );
} finally {
  clearTimeout(timer);
  await rm(userData, { recursive: true, force: true });
}
