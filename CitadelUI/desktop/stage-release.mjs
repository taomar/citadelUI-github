import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'));
const outputRoot = resolve(desktopRoot, 'out');
const releaseRoot = resolve(outputRoot, 'release');
const sources = [
  {
    source: resolve(outputRoot, 'make', 'squirrel.windows', 'x64', 'CitadelUISetup.exe'),
    name: 'CitadelUISetup.exe',
  },
  {
    source: resolve(
      outputRoot,
      'make',
      'zip',
      'win32',
      'x64',
      `${manifest.productName}-win32-x64-${manifest.version}.zip`
    ),
    name: 'CitadelUIPortable.zip',
  },
];

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
  resolve(releaseRoot, 'SHA256SUMS.txt'),
  `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n')}\n`,
  'utf8'
);

console.log(
  JSON.stringify({
    event: 'citadel_desktop_release_staged',
    version: manifest.version,
    directory: releaseRoot,
    assets,
  })
);
