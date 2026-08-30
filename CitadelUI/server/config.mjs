/**
 * Runtime configuration for the local Citadel UI server.
 *
 * The UI lives entirely under CitadelUI/ but operates on the repository root, so
 * every path here is derived from the location of this file rather than the
 * process working directory.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** CitadelUI/ */
export const uiRoot = resolve(here, '..');

/** Repository root — the tree that gets scanned for deployments. */
export const repoRoot = resolve(uiRoot, '..');

/** Static assets served to the browser. */
export const webRoot = join(uiRoot, 'web');

/**
 * Archive location for superseded parameter files.
 * The user's rule is "rename the old, and add the new": the previous revision is
 * moved here with a UTC timestamp, then the new content is written at the
 * original path. Keeping archives inside CitadelUI honours the constraint that
 * all changes stay within this folder.
 */
export const backupRoot = join(uiRoot, '.backups');

export const port = Number(process.env.CITADEL_UI_PORT || 4173);
export const host = process.env.CITADEL_UI_HOST || '127.0.0.1';

/** Directories that are never scanned for deployments. */
export const ignoredDirs = new Set([
  '.git',
  '.github',
  '.vscode',
  'node_modules',
  '.venv',
  '__pycache__',
  'CitadelUI',
  '.backups',
]);

/** Guard against path traversal: every write must stay inside the repo. */
export function assertInsideRepo(candidate) {
  const full = resolve(candidate);
  if (full !== repoRoot && !full.startsWith(repoRoot + '\\') && !full.startsWith(repoRoot + '/')) {
    throw new Error(`Refusing to operate outside the repository: ${candidate}`);
  }
  return full;
}
