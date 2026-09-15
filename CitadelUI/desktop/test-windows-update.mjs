import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyPackagedSources } from './source-integrity.mjs';
import { validateWindowsFeed } from './updates.mjs';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('The native installation test runs only on a disposable GitHub-hosted Windows runner.');
}
const run = promisify(execFile);
const desktopRoot = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
const applicationSource = JSON.parse(await readFile(join(desktopRoot, 'application-source.json'), 'utf8'));
const installedRoot = join(process.env.LOCALAPPDATA, 'citadel_ui');
async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
if (await exists(installedRoot)) throw new Error('Refusing to replace an existing Citadel installation.');

const root = await mkdtemp(join(tmpdir(), 'citadel-native-update-'));
const updater = join(installedRoot, 'Update.exe');
const oldProfile = join(root, 'old-profile');
const env = { ...process.env, CITADEL_DESKTOP_SMOKE_TEST: 'true', CITADEL_DESKTOP_USER_DATA_ROOT: oldProfile };
delete env.GH_TOKEN;
delete env.GITHUB_TOKEN;
const execute = (file, args) => run(file, args, { cwd: desktopRoot, env, windowsHide: true, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
let server;
try {
  await run('gh', [
    'release', 'download', 'citadel-ui-desktop-v1.1.5', '--repo', 'taomar/citadelUI-github',
    '--pattern', 'CitadelUISetup.exe', '--dir', root,
  ], { cwd: desktopRoot, env: { ...env, GH_TOKEN: process.env.GH_TOKEN }, windowsHide: true, timeout: 180_000 });
  const installer = join(root, 'CitadelUISetup.exe');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(installer)) hash.update(chunk);
  assert.equal(hash.digest('hex'), '4724783985164df5d5fed32ecfe9d30e126c7e88e243327d294dcd3c10d59a21',
    'The previous released installer must match its reviewed SHA-256.');
  await execute(installer, ['--silent']);
  assert.equal(await exists(updater), true, 'Squirrel Update.exe was not installed.');
  await mkdir(oldProfile, { recursive: true });
  const sentinel = join(oldProfile, 'retained-state.json');
  const retained = '{"ownerAndWorkspaceState":"preserve"}\n';
  await writeFile(sentinel, retained);

  const feedRoot = resolve(desktopRoot, 'out', 'make', 'squirrel.windows', 'x64');
  const feed = await readFile(join(feedRoot, 'RELEASES'), 'utf8');
  const packages = await Promise.all(feed.trim().split(/\r?\n/).map(async (line) => {
    const name = line.split(' ')[1];
    assert.match(name, /^citadel_ui-\d+\.\d+\.\d+-(full|delta)\.nupkg$/);
    return { name, size: (await stat(join(feedRoot, name))).size };
  }));
  validateWindowsFeed(feed, version, packages);
  const allowed = new Map([['/RELEASES', join(feedRoot, 'RELEASES')],
    ...packages.map(({ name }) => [`/${name}`, join(feedRoot, name)])]);
  server = createServer(async (request, response) => {
    const path = allowed.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!path || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    try {
      response.writeHead(200, { 'Content-Length': (await stat(path)).size });
      if (request.method === 'HEAD') response.end();
      else createReadStream(path).on('error', (error) => response.destroy(error)).pipe(response);
    } catch (error) {
      response.destroy(error);
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const feedUrl = `http://127.0.0.1:${server.address().port}/`;
  const check = await execute(updater, ['--checkForUpdate', feedUrl]);
  const result = JSON.parse(check.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.releasesToApply.at(-1).version, version);
  await execute(updater, ['--update', feedUrl]);
  const updatedPackage = join(installedRoot, `app-${version}`);
  const identity = await verifyPackagedSources(join(updatedPackage, 'resources'));
  assert.equal(identity.version, version);
  assert.equal(identity.applicationRevision, applicationSource.revision);
  assert.equal(await readFile(sentinel, 'utf8'), retained);
  const smoke = await execute(process.execPath, [
    join(desktopRoot, 'run-packaged-smoke.mjs'), `--package-root=${updatedPackage}`,
  ]);
  process.stdout.write(smoke.stdout);
  const proof = JSON.parse(smoke.stdout.split(/\r?\n/).find((line) => line.startsWith('{"event":"citadel_desktop_smoke",')));
  assert.equal(proof.interface.updates.inPlaceSupported, true, 'The installed app did not recognize its native updater.');
  console.log(JSON.stringify({
    event: 'citadel_desktop_native_windows_update',
    from: '1.1.5', to: version, retainedState: true, applicationRevision: identity.applicationRevision, passed: true,
  }));
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  try {
    if (await exists(updater)) await execute(updater, ['--uninstall', '--silent']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
