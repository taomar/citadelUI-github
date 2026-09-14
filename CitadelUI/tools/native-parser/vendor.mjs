import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const output = new URL('../../shared/terraform/vendor/', import.meta.url);
const packages = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8')).devDependencies;
const lock = JSON.parse(await readFile(new URL('package-lock.json', import.meta.url), 'utf8'));
const packageProvenance = Object.fromEntries(Object.entries(packages).map(([name, version]) => {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry || entry.version !== version || !entry.integrity) throw new Error(`Missing pinned package provenance: ${name}`);
  return [name, { version, resolved: entry.resolved, integrity: entry.integrity }];
}));
const assets = [
  ['web-tree-sitter/tree-sitter.js', 'tree-sitter.mjs'],
  ['web-tree-sitter/tree-sitter.wasm', 'tree-sitter.wasm'],
  ['web-tree-sitter/LICENSE', 'tree-sitter-LICENSE.txt'],
  ['@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-hcl.wasm', 'hcl.wasm'],
  ['@tree-sitter-grammars/tree-sitter-hcl/LICENSE', 'hcl-LICENSE.txt'],
  ['tree-sitter-json/tree-sitter-json.wasm', 'json.wasm'],
  ['tree-sitter-json/LICENSE', 'json-LICENSE.txt'],
];
await mkdir(output, { recursive: true });
const hashes = {};
const assetProvenance = {};
for (const [source, target] of assets) {
  const packageName = Object.keys(packages).find((name) => source.startsWith(`${name}/`));
  if (!packageName) throw new Error(`Unknown asset package: ${source}`);
  const bytes = await readFile(new URL(`node_modules/${source}`, import.meta.url));
  await writeFile(new URL(target, output), bytes);
  hashes[target] = createHash('sha256').update(bytes).digest('hex');
  assetProvenance[target] = { package: packageName, path: source.slice(packageName.length + 1),
    processing: 'Copied byte-for-byte from the locked published npm archive; WASM is upstream prebuilt, not locally compiled.' };
}
await writeFile(new URL('manifest.json', output), `${JSON.stringify({
  version: 1,
  packages,
  build: 'npm ci --ignore-scripts; npm run build (CitadelUI/tools/native-parser)',
  licenses: { 'web-tree-sitter': 'MIT', '@tree-sitter-grammars/tree-sitter-hcl': 'Apache-2.0', 'tree-sitter-json': 'MIT' },
  packageProvenance,
  assetProvenance,
  sha256: hashes,
}, null, 2)}\n`);
console.log(`Packaged ${assets.length} pinned parser assets.`);
