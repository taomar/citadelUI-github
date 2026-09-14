import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const runtimeDirectories = ['server', 'shared', 'web'];
const sourcePaths = runtimeDirectories.map((name) => `CitadelUI/${name}`);

export async function runtimeFiles(root) {
  const files = [];
  async function visit(alias) {
    for (const entry of await readdir(join(root, ...alias.split('/')), { withFileTypes: true })) {
      const child = `${alias}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        const bytes = await readFile(join(root, ...child.split('/')));
        files.push([child, {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        }]);
      } else {
        throw new Error(`Desktop runtime must contain regular files only: ${child}`);
      }
    }
  }
  for (const directory of runtimeDirectories) await visit(directory);
  return Object.fromEntries(files.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export async function createBuildInfo(repositoryRoot, { source, version, requireClean = process.env.CI === 'true' }) {
  if (!/^[a-f0-9]{40}$/.test(source?.revision || '')) {
    throw new Error('Desktop application source must pin a full Git commit.');
  }
  const git = async (...args) => (await run('git', args, {
    cwd: repositoryRoot,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })).stdout.trimEnd();
  await git('cat-file', '-e', `${source.revision}^{commit}`);
  try {
    await git('diff', '--quiet', '--no-ext-diff', source.revision, '--', ...sourcePaths);
  } catch (error) {
    if (error.code !== 1) throw error;
    throw new Error(`Refusing to package stale or modified application sources: expected ${source.revision}.`);
  }
  const files = await runtimeFiles(join(repositoryRoot, 'CitadelUI'));
  const expectedPaths = (await git('ls-tree', '-r', '-z', '--name-only', source.revision, '--', ...sourcePaths))
    .split('\0').filter(Boolean).map((path) => path.slice('CitadelUI/'.length)).sort();
  if (JSON.stringify(Object.keys(files)) !== JSON.stringify(expectedPaths)) {
    throw new Error('Desktop runtime files differ from the pinned application tree, including untracked or ignored files.');
  }
  const dirty = Boolean(await git('status', '--porcelain', '--untracked-files=no'));
  if (requireClean && dirty) throw new Error('Release packages require a clean committed checkout.');
  return {
    schemaVersion: 1,
    version,
    applicationRevision: source.revision,
    applicationRef: source.ref,
    releaseRevision: await git('rev-parse', 'HEAD'),
    dirty,
    files,
  };
}

export async function verifyPackagedSources(resourcesPath) {
  const info = JSON.parse(await readFile(join(resourcesPath, 'desktop-build.json'), 'utf8'));
  if (info.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(info.applicationRevision || '') ||
      !/^[a-f0-9]{40}$/.test(info.releaseRevision || '') || !info.files) {
    throw new Error('Desktop build identity is missing or invalid.');
  }
  const actual = await runtimeFiles(resourcesPath);
  const aliases = new Set([...Object.keys(info.files), ...Object.keys(actual)]);
  for (const alias of aliases) {
    if (actual[alias]?.sha256 !== info.files[alias]?.sha256 ||
        actual[alias]?.size !== info.files[alias]?.size) {
      throw new Error(`Packaged application does not match its build identity: ${alias}`);
    }
  }
  return info;
}
