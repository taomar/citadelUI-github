/**
 * Static proof that the relay core never imports the loopback local
 * executor's transports, or any process/filesystem/CLI-adjacent primitive.
 *
 * This is deliberately a text-level check, not a runtime one: the whole
 * point is that a future edit adding one of these imports should fail a test
 * immediately, rather than rely on nobody noticing that `src/relay/*` grew a
 * reachable path to `node:child_process` or the loopback executor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const RELAY_DIR = fileURLToPath(new URL('../../src/relay/', import.meta.url));

const FORBIDDEN_SPECIFIERS = [
  'node:child_process',
  'child_process',
  'node:fs',
  "'fs'",
  '"fs"',
  '../server/transports.mjs',
  '../server/workspace.mjs',
  '../server/registry.mjs',
  '../server/localExecutor.mjs',
];

async function relaySourceFiles() {
  const entries = await readdir(RELAY_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.mjs')).map((entry) => join(RELAY_DIR, entry.name));
}

test('no file under src/relay imports a process, filesystem, or loopback-executor module', async () => {
  const files = await relaySourceFiles();
  assert.ok(files.length > 0, 'sanity: the relay directory must not be empty');
  for (const file of files) {
    const text = await readFile(file, 'utf-8');
    const importLines = text.split('\n').filter((line) => /^\s*import\b/.test(line));
    for (const specifier of FORBIDDEN_SPECIFIERS) {
      const offending = importLines.filter((line) => line.includes(specifier));
      assert.equal(
        offending.length,
        0,
        `${relative(dirname(RELAY_DIR), file)} must not import ${specifier}, found: ${offending.join(' | ')}`,
      );
    }
  }
});

test('no file under src/relay spawns a process or shells out, by any of the common Node APIs', async () => {
  const forbiddenCalls = [/\bexecFile\s*\(/, /\bexecSync\s*\(/, /\bspawn\s*\(/, /\bspawnSync\s*\(/, /\bfork\s*\(/];
  const files = await relaySourceFiles();
  for (const file of files) {
    const text = await readFile(file, 'utf-8');
    for (const pattern of forbiddenCalls) {
      assert.ok(!pattern.test(text), `${relative(dirname(RELAY_DIR), file)} appears to invoke ${pattern}`);
    }
  }
});

test('no file under src/relay reads or writes the local filesystem', async () => {
  const forbiddenCalls = [/\breadFileSync\s*\(/, /\bwriteFileSync\s*\(/, /\bcreateReadStream\s*\(/, /\bcreateWriteStream\s*\(/];
  const files = await relaySourceFiles();
  for (const file of files) {
    const text = await readFile(file, 'utf-8');
    for (const pattern of forbiddenCalls) {
      assert.ok(!pattern.test(text), `${relative(dirname(RELAY_DIR), file)} appears to touch the filesystem via ${pattern}`);
    }
  }
});
