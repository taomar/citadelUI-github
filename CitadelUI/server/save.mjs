/**
 * Save path: "rename the old, and add the new".
 *
 * The previous revision is archived under CitadelUI/.backups with a UTC
 * timestamp, then the new content is written at the original path. Archiving
 * inside CitadelUI keeps every artefact this tool produces within its own
 * folder, as required.
 *
 * A save is rejected unless the resulting text still parses, so a bad edit can
 * never leave an unusable deployment file on disk.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { repoRoot, backupRoot, assertInsideRepo } from './config.mjs';
import { parseBicepParam } from './bicepparam/parser.mjs';
import { applyEdits } from './bicepparam/edit.mjs';

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
}

function toPosix(p) {
  return p.split('\\').join('/');
}

export function archivePath(relPath) {
  return join(backupRoot, dirname(relPath), `${relPath.split(/[\\/]/).pop()}.${stamp()}.bak`);
}

/**
 * Compute the result of a set of edits without writing anything.
 * Used to render a diff before the user commits.
 */
export function previewEdits(relPath, operations) {
  const full = assertInsideRepo(join(repoRoot, relPath));
  const before = readFileSync(full, 'utf8');
  const after = applyEdits(before, operations);
  parseBicepParam(after); // fail fast on malformed output
  return { path: toPosix(relPath), before, after, changed: before !== after };
}

export function saveEdits(relPath, operations, options = {}) {
  const full = assertInsideRepo(join(repoRoot, relPath));
  const before = readFileSync(full, 'utf8');

  // Optimistic concurrency: refuse to clobber a file changed underneath us.
  if (options.expectedMtimeMs !== undefined) {
    const current = statSync(full).mtimeMs;
    if (Math.abs(current - Number(options.expectedMtimeMs)) > 1) {
      throw new Error('This file changed on disk since it was loaded. Reload before saving.');
    }
  }

  const after = applyEdits(before, operations);
  if (after === before) {
    return { path: toPosix(relPath), changed: false, archived: null };
  }

  parseBicepParam(after);

  const archive = archivePath(relPath);
  mkdirSync(dirname(archive), { recursive: true });
  copyFileSync(full, archive);

  writeFileSync(full, after, 'utf8');

  return {
    path: toPosix(relPath),
    changed: true,
    archived: toPosix(archive.slice(repoRoot.length + 1)),
    mtimeMs: statSync(full).mtimeMs,
    bytes: Buffer.byteLength(after, 'utf8'),
  };
}

/**
 * Sanity-check XML before it is written.
 *
 * This is deliberately a balance check, not a parser. Structured policy edits
 * are span splices and safe by construction; the risk comes from the raw XML
 * editor, where the realistic failure is a truncated or mismatched tag. Since
 * this tool never deploys, an invalid policy would otherwise sit undetected on
 * disk until Azure rejected it, so it is worth catching the obvious breakage
 * here. Anything subtler is left to APIM.
 */
function assertBalancedXml(text) {
  const stripped = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');

  const stack = [];
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(stripped))) {
    const [, closing, name, , selfClose] = m;
    if (selfClose) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        throw new Error(
          open
            ? `Malformed XML: </${name}> closes <${open}>.`
            : `Malformed XML: </${name}> has no opening tag.`
        );
      }
    } else {
      stack.push(name);
    }
  }
  if (stack.length) throw new Error(`Malformed XML: <${stack[stack.length - 1]}> is never closed.`);
}

/**
 * Save a plain text artefact (currently APIM policy XML) using the same
 * archive-then-write rule as parameter files.
 *
 * Kept separate from `saveEdits` because a policy is not a Bicep document:
 * running it through the parameter parser would reject every valid policy.
 */
export function saveText(relPath, content, options = {}) {
  const full = assertInsideRepo(join(repoRoot, relPath));
  const before = readFileSync(full, 'utf8');

  if (options.expectedMtimeMs !== undefined) {
    const current = statSync(full).mtimeMs;
    if (Math.abs(current - Number(options.expectedMtimeMs)) > 1) {
      throw new Error('This file changed on disk since it was loaded. Reload before saving.');
    }
  }

  if (content === before) {
    return { path: toPosix(relPath), changed: false, archived: null };
  }

  if (/\.xml$/i.test(relPath)) assertBalancedXml(content);

  const archive = archivePath(relPath);
  mkdirSync(dirname(archive), { recursive: true });
  copyFileSync(full, archive);

  writeFileSync(full, content, 'utf8');

  // The caller may want a recoverable copy of the whole folder, not just the
  // previous revision of this one file.
  if (typeof options.onSaved === 'function') {
    try {
      options.onSaved();
    } catch {
      /* a snapshot failure must not fail the save the user asked for */
    }
  }

  return {
    path: toPosix(relPath),
    changed: true,
    archived: toPosix(archive.slice(repoRoot.length + 1)),
    mtimeMs: statSync(full).mtimeMs,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

/** Write a brand new file (scaffolding). Never overwrites silently. */
export function createFile(relPath, content) {
  const full = assertInsideRepo(join(repoRoot, relPath));
  if (existsSync(full)) throw new Error(`Already exists: ${toPosix(relPath)}`);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return { path: toPosix(relPath), bytes: Buffer.byteLength(content, 'utf8') };
}
