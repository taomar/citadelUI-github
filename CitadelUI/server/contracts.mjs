/**
 * Legacy repository-backed access-contract helpers.
 *
 * Production server/index.mjs does not import this module. Browser policy
 * processing and production content APIs use ../shared/policy.mjs directly.
 * The policy exports below remain for isolated legacy tests and callers.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';

import { assertInsideRepo, repoRoot } from './config.mjs';
import { parseBicepParam } from './bicepparam/parser.mjs';
import { buildOutline } from './doclayer.mjs';
import { readPolicyControls } from '../shared/policy.mjs';

export {
  applyPolicyChanges,
  CONTENT_SAFETY_CATEGORIES,
  CONTENT_SAFETY_OUTPUT_TYPES,
  POLICY_VARIABLES,
  readPolicyControls,
  SEMANTIC_CACHE_SPEC,
  THROTTLE_SPECS,
} from '../shared/policy.mjs';

export const CONTRACT_ROOT = 'bicep/infra/citadel-access-contracts';

const EXCLUDED = new Set(['modules', 'policies', 'base-contracts', '.backups']);

export const TEMPLATE = {
  id: '__template',
  paramFile: `${CONTRACT_ROOT}/main.bicepparam`,
  policyFile: `${CONTRACT_ROOT}/policies/default-ai-product-policy.xml`,
};

const CONTRACT_POLICY_NAME = 'ai-product-policy.xml';
const CONTRACT_PARENT = 'contracts';
const SNAPSHOT_ROOT = 'CitadelUI/.snapshots';
const NAME_RULE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

function toPosix(path) {
  return path.split('\\').join('/');
}

function abs(relativePath) {
  return assertInsideRepo(join(repoRoot, relativePath));
}

function walk(dirRel, out) {
  let entries;
  try {
    entries = readdirSync(abs(dirRel), { withFileTypes: true });
  } catch {
    return;
  }

  const paramFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.bicepparam'));
  if (paramFiles.length) {
    const primary = paramFiles.find((entry) => entry.name === 'main.bicepparam') || paramFiles[0];
    out.push({ dirRel, fileName: primary.name });
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED.has(entry.name)) continue;
    walk(toPosix(join(dirRel, entry.name)), out);
  }
}

function resolvePolicy(doc, dirRel) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'call') {
      if (node.callee === 'loadTextContent' && node.args?.[0]?.kind === 'string') {
        found.push(node.args[0].value);
        return;
      }
      node.args?.forEach(visit);
      return;
    }
    if (node.kind === 'array') node.items.forEach(visit);
    else if (node.kind === 'object') node.properties.forEach((property) => visit(property.value));
  };
  for (const parameter of doc.params) visit(parameter.value);

  for (const path of found) {
    const candidate = toPosix(join(dirRel, path));
    if (existsSync(join(repoRoot, candidate))) return candidate;
  }
  return found.length ? toPosix(join(dirRel, found[0])) : null;
}

function contractId(dirRel) {
  const rel = toPosix(relative(CONTRACT_ROOT, dirRel));
  return rel && rel !== '.' ? rel : '';
}

function humanise(path) {
  const last = path.split('/').filter(Boolean).pop() || path;
  return last
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function describe(dirRel, fileName, extra = {}) {
  const paramRel = toPosix(join(dirRel, fileName));
  const id = extra.id ?? contractId(dirRel);
  let policy = null;
  let paramCount = 0;
  let error = null;
  try {
    const doc = parseBicepParam(readFileSync(abs(paramRel), 'utf8'));
    paramCount = doc.params.length;
    policy = resolvePolicy(doc, dirRel);
  } catch (caught) {
    error = caught.message;
  }
  if (extra.policyFile) policy = extra.policyFile;

  return {
    id,
    name: extra.name ?? humanise(id),
    dir: toPosix(dirRel),
    paramFile: paramRel,
    policyFile: policy,
    hasPolicy: Boolean(policy && existsSync(join(repoRoot, policy))),
    paramCount,
    isTemplate: Boolean(extra.isTemplate),
    modifiedMs: statSync(abs(paramRel)).mtimeMs,
    error,
  };
}

export function listContracts() {
  const found = [];
  walk(CONTRACT_ROOT, found);
  const contracts = found
    .filter(({ dirRel }) => contractId(dirRel) !== '')
    .map(({ dirRel, fileName }) => describe(dirRel, fileName))
    .sort((left, right) => left.id.localeCompare(right.id));
  const template = describe(CONTRACT_ROOT, 'main.bicepparam', {
    id: TEMPLATE.id,
    name: 'Template',
    policyFile: TEMPLATE.policyFile,
    isTemplate: true,
  });
  return {
    root: CONTRACT_ROOT,
    parent: CONTRACT_PARENT,
    template,
    contracts: [template, ...contracts],
  };
}

export function readContract(id) {
  const { contracts } = listContracts();
  const entry = contracts.find((candidate) => candidate.id === id);
  if (!entry) throw Object.assign(new Error(`Unknown access contract: ${id}`), { status: 404 });

  const paramText = readFileSync(abs(entry.paramFile), 'utf8');
  const doc = parseBicepParam(paramText);
  const paramStat = statSync(abs(entry.paramFile));
  let policy = null;
  if (entry.policyFile && existsSync(join(repoRoot, entry.policyFile))) {
    const text = readFileSync(abs(entry.policyFile), 'utf8');
    policy = {
      path: entry.policyFile,
      name: basename(entry.policyFile),
      text,
      mtimeMs: statSync(abs(entry.policyFile)).mtimeMs,
      controls: readPolicyControls(text),
    };
  }

  return {
    ...entry,
    param: {
      path: entry.paramFile,
      text: paramText,
      mtimeMs: paramStat.mtimeMs,
      size: paramStat.size,
      using: doc.using ? doc.using.path : null,
      params: doc.params.map((parameter) => ({
        name: parameter.name,
        kind: parameter.value.kind,
        span: { start: parameter.value.start, end: parameter.value.end },
        raw: paramText.slice(parameter.value.start, parameter.value.end),
      })),
      outline: buildOutline(paramText, doc.params),
    },
    policy,
  };
}

function wirePolicyReference(text, doc, policyName) {
  const splices = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'array') {
      node.items.forEach(visit);
    } else if (node.kind === 'object') {
      for (const property of node.properties) {
        if (
          property.key === 'policyXml' &&
          property.value.kind === 'string' &&
          property.value.value === ''
        ) {
          const pad = /^[ \t]+(?=\/\/)/.exec(text.slice(property.value.end));
          splices.push({
            start: property.value.start,
            end: property.value.end + (pad ? pad[0].length : 0),
            text: `loadTextContent('./${policyName}')${pad ? ' ' : ''}`,
          });
        } else {
          visit(property.value);
        }
      }
    }
  };
  for (const parameter of doc.params) visit(parameter.value);
  return splices;
}

export function createContract({ name, parent = CONTRACT_PARENT }) {
  const clean = String(name || '').trim().toLowerCase();
  if (!NAME_RULE.test(clean)) {
    throw Object.assign(
      new Error('Use lowercase letters, numbers and hyphens (slashes allowed for nesting).'),
      { status: 400 }
    );
  }

  const dirRel = toPosix(join(CONTRACT_ROOT, parent || '', clean));
  const targetDir = abs(dirRel);
  if (existsSync(targetDir)) {
    throw Object.assign(new Error(`Contract folder already exists: ${contractId(dirRel)}`), {
      status: 409,
    });
  }

  const templateParam = readFileSync(abs(TEMPLATE.paramFile), 'utf8');
  const templatePolicy = readFileSync(abs(TEMPLATE.policyFile), 'utf8');
  const doc = parseBicepParam(templateParam);
  const usingPath = toPosix(relative(targetDir, join(repoRoot, CONTRACT_ROOT, 'main.bicep')));
  const splices = wirePolicyReference(templateParam, doc, CONTRACT_POLICY_NAME);
  if (doc.using) {
    splices.push({ start: doc.using.start, end: doc.using.end, text: `'${usingPath}'` });
  }

  let paramText = templateParam;
  for (const splice of splices.sort((left, right) => right.start - left.start)) {
    paramText = paramText.slice(0, splice.start) + splice.text + paramText.slice(splice.end);
  }

  mkdirSync(targetDir, { recursive: true });
  const paramRel = toPosix(join(dirRel, 'main.bicepparam'));
  const policyRel = toPosix(join(dirRel, CONTRACT_POLICY_NAME));
  writeFileSync(abs(paramRel), paramText, 'utf8');
  writeFileSync(abs(policyRel), templatePolicy, 'utf8');
  snapshotContract(dirRel);

  return {
    id: contractId(dirRel),
    dir: dirRel,
    from: { param: TEMPLATE.paramFile, policy: TEMPLATE.policyFile },
    using: usingPath,
    created: [paramRel, policyRel],
  };
}

function isScratchId(id) {
  return String(id)
    .split('/')
    .some((segment) => segment.startsWith('.'));
}

export function snapshotContract(dirRel) {
  const source = abs(dirRel);
  if (!existsSync(source)) return null;
  const id = contractId(dirRel);
  if (isScratchId(id)) return null;
  const target = join(repoRoot, SNAPSHOT_ROOT, id);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile()) copyFileSync(join(source, entry.name), join(target, entry.name));
  }
  return target;
}

export function orphanedSnapshots() {
  const root = join(repoRoot, SNAPSHOT_ROOT);
  if (!existsSync(root)) return [];
  const out = [];
  const scan = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const id = prefix ? `${prefix}/${entry.name}` : entry.name;
      const here = join(dir, entry.name);
      const files = readdirSync(here, { withFileTypes: true }).filter((file) => file.isFile());
      if (files.some((file) => file.name === 'main.bicepparam')) {
        if (!existsSync(abs(join(CONTRACT_ROOT, id)))) {
          out.push({
            id,
            files: files.map((file) => file.name),
            savedAt: statSync(here).mtimeMs,
          });
        }
      } else {
        scan(here, id);
      }
    }
  };
  scan(root, '');
  return out.sort((left, right) => right.savedAt - left.savedAt);
}

export function restoreContract(id) {
  if (isScratchId(id)) {
    throw Object.assign(new Error(`${id} is an internal scratch path, not a contract.`), {
      status: 400,
    });
  }
  const source = join(repoRoot, SNAPSHOT_ROOT, id);
  if (!existsSync(source)) {
    throw Object.assign(new Error(`No snapshot for ${id}`), { status: 404 });
  }
  const dirRel = toPosix(join(CONTRACT_ROOT, id));
  const target = abs(dirRel);
  if (existsSync(target)) {
    throw Object.assign(new Error(`${id} already exists; nothing was overwritten.`), {
      status: 409,
    });
  }
  mkdirSync(target, { recursive: true });
  const restored = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copyFileSync(join(source, entry.name), join(target, entry.name));
    restored.push(toPosix(join(dirRel, entry.name)));
  }
  return { id, dir: dirRel, restored };
}
