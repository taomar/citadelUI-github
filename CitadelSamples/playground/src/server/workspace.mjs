/**
 * Per-run workspaces.
 *
 * Every file a run reads or writes lives under
 * `CitadelSamples/playground/.runs/<run-id>/`. Two rules make that true:
 *
 *   1. A path that names the vendored accelerator bundle is executed against a
 *      staged copy of that bundle inside the run workspace, at the SAME
 *      relative location. That is what keeps the templates' own relative
 *      references working — `using '../../../main.bicep'`,
 *      `loadTextContent('../policies/baseline-mcp-policy.xml')` and
 *      `loadTextContent('../../modules/apim/policies/frag-mcp-usage.xml')`
 *      all resolve without a single character of the generated file being
 *      rewritten.
 *   2. Any other relative path lands under `<workspace>/artifacts/`.
 *
 * Anything absolute, anything that escapes after normalisation, and anything
 * carrying a NUL is refused outright rather than sanitised.
 */

import { mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { ACCELERATOR_ROOT, RUN_WORKSPACE_ROOT } from '../core/types.mjs';

const ACCELERATOR_PREFIX = `${ACCELERATOR_ROOT}/`;

/** Normalise to forward slashes so one rule covers both platforms. */
export function toPosix(path) {
  return String(path ?? '').replace(/\\/g, '/');
}

export class PathRefused extends Error {
  constructor(path, reason) {
    super(`Refused path "${path}": ${reason}`);
    this.name = 'PathRefused';
    this.path = path;
    this.reason = reason;
  }
}

/**
 * Map a plan-declared path onto its location inside a run workspace.
 * Pure, so it can be tested without touching a disk.
 *
 * @returns {{ relative: string, staged: boolean }}
 */
export function mapPlanPath(declared) {
  const posix = toPosix(declared).trim();
  if (posix === '') throw new PathRefused(declared, 'it is empty');
  if (posix.includes('\0')) throw new PathRefused(declared, 'it contains a NUL byte');
  if (isAbsolute(declared) || /^[a-zA-Z]:\//.test(posix) || posix.startsWith('/')) {
    throw new PathRefused(declared, 'absolute paths are never executed');
  }
  const staged = posix === ACCELERATOR_ROOT || posix.startsWith(ACCELERATOR_PREFIX);
  const tail = staged ? posix.slice(ACCELERATOR_PREFIX.length) : posix;
  const normalised = toPosix(normalize(tail));
  if (normalised === '..' || normalised.startsWith('../') || normalised.includes('/../')) {
    throw new PathRefused(declared, 'it escapes the run workspace');
  }
  if (normalised === '' || normalised === '.') throw new PathRefused(declared, 'it names no file');
  return { relative: staged ? normalised : `artifacts/${normalised}`, staged };
}

/**
 * A run workspace bound to one directory. `resolve()` is the only way in, and
 * it re-checks containment after resolution rather than trusting the mapping.
 */
export function createRunWorkspace({ playgroundRoot, runId, fs = { mkdir, readdir, copyFile, stat } }) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(runId))) {
    throw new PathRefused(runId, 'a run id must be short kebab-case');
  }
  const root = resolve(playgroundRoot, RUN_WORKSPACE_ROOT, runId);
  const acceleratorSource = resolve(playgroundRoot, ACCELERATOR_ROOT);
  let staged = false;

  function resolveInside(relativePath) {
    const candidate = resolve(root, relativePath);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new PathRefused(relativePath, 'it resolves outside the run workspace');
    }
    return candidate;
  }

  return {
    runId,
    root,
    /** Workspace-relative path, always with forward slashes, for reporting. */
    describe(absolutePath) {
      return toPosix(relative(root, absolutePath));
    },
    /** Map a plan-declared path and return `{ absolute, relative, staged }`. */
    resolve(declared) {
      const mapped = mapPlanPath(declared);
      return { ...mapped, absolute: resolveInside(mapped.relative) };
    },
    async ensureDirFor(absolutePath) {
      await fs.mkdir(dirname(absolutePath), { recursive: true });
    },
    async ensureRoot() {
      await fs.mkdir(root, { recursive: true });
    },
    /**
     * Copy the vendored accelerator bundle into the workspace, once per run and
     * only when a step actually names it.
     */
    async stageAccelerator() {
      if (staged) return { staged: true, alreadyStaged: true, files: 0 };
      await fs.mkdir(root, { recursive: true });
      const copied = await copyTree(acceleratorSource, root, fs);
      staged = true;
      return { staged: true, alreadyStaged: false, files: copied };
    },
    get acceleratorStaged() {
      return staged;
    },
  };
}

async function copyTree(from, to, fs) {
  let count = 0;
  let entries;
  try {
    entries = await fs.readdir(from, { withFileTypes: true });
  } catch {
    throw new Error(
      `The vendored accelerator bundle is missing at ${from}. This playground never reads templates from outside CitadelSamples, so the sample cannot run.`,
    );
  }
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      count += await copyTree(source, target, fs);
    } else if (entry.isFile()) {
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      count += 1;
    }
  }
  return count;
}

/** Deterministic, filesystem-safe run id. */
export function makeRunId(sampleId, sequence) {
  const safe = String(sampleId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${safe || 'run'}-${String(sequence).padStart(4, '0')}`;
}
