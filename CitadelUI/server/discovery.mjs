/**
 * Deployment discovery.
 *
 * Scans the whole repository root (not just bicep/infra) for .bicepparam files,
 * groups them into deployment units, and classifies each one:
 *
 *   env-driven   values come from .azure/<env>/.env via readEnvironmentVariable()
 *                -> the meaningful edit target is the environment variable
 *   declarative  values are literals in the file itself
 *                -> the meaningful edit target is the file
 *
 * Access and publish contracts are additionally grouped folder-per-contract,
 * matching the layout actually used in the repo (contracts/<name>/<env>/).
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename, sep } from 'node:path';

import { repoRoot, ignoredDirs } from './config.mjs';
import { parseBicepParam } from './bicepparam/parser.mjs';

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.bicepparam')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

/** Count readEnvironmentVariable() calls anywhere in the value tree. */
function countEnvCalls(node, acc = { count: 0, vars: [] }) {
  if (!node || typeof node !== 'object') return acc;
  if (node.kind === 'call') {
    if (node.callee === 'readEnvironmentVariable') {
      acc.count += 1;
      const nameArg = node.args[0];
      const defArg = node.args[1];
      if (nameArg && nameArg.kind === 'string') {
        acc.vars.push({
          name: nameArg.value,
          default: defArg && defArg.kind !== 'call' ? defArg.value : null,
          defaultKind: defArg ? defArg.kind : null,
        });
      }
    }
    for (const a of node.args) countEnvCalls(a, acc);
  } else if (node.kind === 'array') {
    for (const item of node.items) countEnvCalls(item, acc);
  } else if (node.kind === 'object') {
    for (const p of node.properties) countEnvCalls(p.value, acc);
  }
  return acc;
}

/**
 * Contract classification.
 * `contracts/<name>/<env>/main.bicepparam` is the layout in real use; the
 * READMEs also document a deeper `<bu>/<use-case>/<env>` form, so both depths
 * are tolerated and the contract name is taken as the segment directly after
 * `contracts/`.
 */
function classifyContract(relPosix) {
  const parts = relPosix.split('/');
  const idx = parts.lastIndexOf('contracts');
  if (idx === -1) return null;

  const after = parts.slice(idx + 1, -1); // drop the filename
  if (after.length === 0) return null;

  const kind = relPosix.includes('citadel-publish-contracts')
    ? 'publish'
    : relPosix.includes('citadel-access-contracts')
      ? 'access'
      : 'contract';

  return {
    kind,
    contract: after[0],
    environment: after.length > 1 ? after[after.length - 1] : null,
    segments: after,
    // The root that owns this contract tree, e.g. bicep/infra/citadel-access-contracts
    treeRoot: parts.slice(0, idx).join('/'),
  };
}

/** Deployment unit = the folder containing the main.bicep a param file points at. */
function unitFor(relPosix, contract) {
  if (contract) return contract.treeRoot;
  const dir = dirname(relPosix);
  return dir === '.' ? '(root)' : dir;
}

export function discoverDeployments() {
  const files = walk(repoRoot);
  const items = [];

  for (const file of files) {
    const rel = relative(repoRoot, file);
    const relPosix = toPosix(rel);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      items.push({ id: relPosix, path: relPosix, error: `Unreadable: ${err.message}` });
      continue;
    }

    let doc = null;
    let parseError = null;
    try {
      doc = parseBicepParam(text);
    } catch (err) {
      parseError = err.message;
    }

    const contract = classifyContract(relPosix);
    const env = doc ? countEnvCalls({ kind: 'array', items: doc.params.map((p) => p.value) }) : { count: 0, vars: [] };
    const paramCount = doc ? doc.params.length : 0;
    const archetype =
      env.count === 0
        ? 'declarative'
        : env.count >= paramCount / 2
          ? 'env-driven'
          : 'hybrid';

    // Resolve the template this file targets so the schema layer can build it.
    let templatePath = null;
    if (doc && doc.using && doc.using.path) {
      const abs = join(dirname(file), doc.using.path);
      templatePath = existsSync(abs) ? toPosix(relative(repoRoot, abs)) : null;
    }

    items.push({
      id: relPosix,
      path: relPosix,
      name: basename(rel),
      unit: unitFor(relPosix, contract),
      archetype,
      paramCount,
      envVarCount: env.count,
      envVars: env.vars,
      template: templatePath,
      usingRaw: doc && doc.using ? doc.using.path : null,
      contract,
      bytes: Buffer.byteLength(text, 'utf8'),
      parseError,
    });
  }

  items.sort((a, b) => a.path.localeCompare(b.path));

  // Group into units for the sidebar.
  const unitMap = new Map();
  for (const item of items) {
    if (!unitMap.has(item.unit)) {
      unitMap.set(item.unit, { unit: item.unit, files: [], contracts: new Map() });
    }
    const group = unitMap.get(item.unit);
    group.files.push(item);
    if (item.contract) {
      const key = item.contract.contract;
      if (!group.contracts.has(key)) group.contracts.set(key, []);
      group.contracts.get(key).push(item);
    }
  }

  const units = [...unitMap.values()].map((g) => ({
    unit: g.unit,
    files: g.files.filter((f) => !f.contract),
    contracts: [...g.contracts.entries()].map(([name, files]) => ({
      name,
      environments: files.map((f) => ({
        environment: f.contract.environment,
        path: f.path,
        id: f.id,
      })),
    })),
  }));

  return { repoRoot: toPosix(repoRoot), units, files: items };
}

/** Locate contract tree roots so the scaffolder knows where to create folders. */
export function discoverContractTrees() {
  const trees = [];
  for (const kind of ['citadel-access-contracts', 'citadel-publish-contracts']) {
    const stack = [repoRoot];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || ignoredDirs.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.name === kind) {
          trees.push({
            kind: kind.includes('publish') ? 'publish' : 'access',
            root: toPosix(relative(repoRoot, full)),
            contractsDir: toPosix(relative(repoRoot, join(full, 'contracts'))),
            hasTemplate: existsSync(join(full, 'main.bicep')),
          });
        } else {
          stack.push(full);
        }
      }
    }
  }
  return trees;
}

export function readDeployment(relPath) {
  const full = join(repoRoot, relPath);
  const st = statSync(full);
  const text = readFileSync(full, 'utf8');
  const doc = parseBicepParam(text);
  return { path: toPosix(relPath), text, doc, mtimeMs: st.mtimeMs, size: st.size };
}
