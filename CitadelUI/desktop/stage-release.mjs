import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackagedSources } from './source-integrity.mjs';

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'));
const outputRoot = resolve(desktopRoot, 'out');
const releaseRoot = resolve(outputRoot, 'release');
const options = new Map();
for (const argument of process.argv.slice(2)) {
  const [key, value] = argument.replace(/^--/, '').split('=', 2);
  options.set(key, value);
}
const platform = options.get('platform') || process.platform;
const arch = options.get('arch') || process.arch;
const checksumName = options.get('checksum-name') || `SHA256SUMS-${platform}-${arch}.txt`;
if (!['win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error(`Unsupported release target: ${platform}/${arch}.`);
}
const packageRoot = resolve(outputRoot, `Citadel UI-${platform}-${arch}`);
const resources = platform === 'darwin'
  ? resolve(packageRoot, 'Citadel UI.app', 'Contents', 'Resources')
  : resolve(packageRoot, 'resources');
const build = await verifyPackagedSources(resources);
const source = JSON.parse(await readFile(resolve(desktopRoot, 'application-source.json'), 'utf8'));
if (build.dirty || build.version !== manifest.version || build.applicationRevision !== source.revision) {
  throw new Error('Only a clean package of the pinned application revision can be staged for release.');
}

async function filesBelow(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function oneDmg() {
  const files = (await filesBelow(resolve(outputRoot, 'make'))).filter((path) =>
    basename(path).toLowerCase().endsWith(`-${arch}.dmg`)
  );
  if (files.length !== 1) {
    throw new Error(`Expected one macOS DMG, found ${files.length}.`);
  }
  return files[0];
}

const sources =
  platform === 'win32'
    ? [
        {
          source: resolve(outputRoot, 'make', 'squirrel.windows', arch, 'CitadelUISetup.exe'),
          name: 'CitadelUISetup.exe',
        },
        {
          source: resolve(
            outputRoot,
            'make',
            'zip',
            platform,
            arch,
            `${manifest.productName}-${platform}-${arch}-${manifest.version}.zip`
          ),
          name: 'CitadelUIPortable.zip',
        },
      ]
    : [
        {
          source: await oneDmg(),
          name: `CitadelUI-macOS-${arch}.dmg`,
        },
        {
          source: resolve(
            outputRoot,
            'make',
            'zip',
            platform,
            arch,
            `${manifest.productName}-${platform}-${arch}-${manifest.version}.zip`
          ),
          name: `CitadelUI-macOS-${arch}.zip`,
        },
      ];
sources.push({
  source: resolve(resources, 'desktop-build.json'),
  name: `CitadelUI-build-${platform}-${arch}.json`,
});

function sha256(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', rejectHash);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolveHash(hash.digest('hex').toUpperCase()));
  });
}

await mkdir(releaseRoot, { recursive: true });
const assets = [];
for (const asset of sources) {
  const destination = resolve(releaseRoot, asset.name);
  await copyFile(asset.source, destination);
  assets.push({
    name: asset.name,
    path: destination,
    sha256: await sha256(destination),
  });
}
await writeFile(
  resolve(releaseRoot, checksumName),
  `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n')}\n`,
  'utf8'
);

console.log(
  JSON.stringify({
    event: 'citadel_desktop_release_staged',
    version: manifest.version,
    platform,
    arch,
    directory: releaseRoot,
    checksum: checksumName,
    assets,
  })
);
