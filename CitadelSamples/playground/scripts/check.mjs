#!/usr/bin/env node
/**
 * `npm run check` — static repository checks that do not need the test runner.
 *
 * Three things it enforces:
 *   1. every relative module import resolves on disk, because a zero-build
 *      application has no bundler to catch a typo;
 *   2. only the pinned, approved server-side authentication dependencies exist;
 *   3. nothing under `playground/` reaches outside `CitadelSamples`.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SAMPLES_ROOT = resolve(ROOT, '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

async function walk(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, found);
    else found.push(full);
  }
  return found;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const files = await walk(ROOT);
const scriptFiles = files.filter((file) => ['.mjs', '.js'].includes(extname(file)));

/* 1. every relative import resolves */
for (const file of scriptFiles) {
  const text = await readFile(file, 'utf-8');
  const specifiers = [
    ...text.matchAll(/(?:^|\s)(?:import|export)[\s\S]*?from\s+['"](\.[^'"]+)['"]/g),
    ...text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g),
  ].map((match) => match[1]);
  for (const specifier of specifiers) {
    const target = resolve(dirname(file), specifier);
    if (!(await exists(target))) {
      fail(`${relative(ROOT, file)} imports "${specifier}", which does not exist`);
    }
    if (!extname(specifier)) {
      fail(`${relative(ROOT, file)} imports "${specifier}" without a file extension`);
    }
  }
}

/* 2. narrowly approved server-side authentication dependencies */
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'));
const approvedDependencies = { '@azure/msal-node': '6.0.0', jose: '6.2.12' };
if (JSON.stringify(pkg.dependencies) !== JSON.stringify(approvedDependencies)) fail('package.json differs from the approved pinned authentication dependencies');
if (Object.keys(pkg.devDependencies ?? {}).length > 0) fail('package.json declares dev dependencies');
if (pkg.type !== 'module') fail('package.json must declare "type": "module"');
for (const script of ['start', 'test', 'check']) {
  if (!pkg.scripts?.[script]) fail(`package.json is missing the "${script}" script`);
}
if (!(await exists(join(ROOT, 'package-lock.json')))) fail('The approved authentication dependencies require a lockfile');

/* 3. nothing reaches outside CitadelSamples */
for (const file of files) {
  if (!['.mjs', '.js', '.html', '.css', '.json', '.md'].includes(extname(file))) continue;
  const text = await readFile(file, 'utf-8');
  for (const match of text.matchAll(/(?:from\s+|import\(\s*|href="|src=")(\.\.[^"')\s]*)/g)) {
    const specifier = match[1];
    // Only resolve real module/asset paths, not prose or notebook-relative
    // strings that appear inside guide text and generated artefacts.
    if (!specifier.startsWith('../') && !specifier.startsWith('..\\')) continue;
    const target = resolve(dirname(file), specifier);
    if (!target.startsWith(SAMPLES_ROOT + sep) && target !== SAMPLES_ROOT) {
      fail(`${relative(ROOT, file)} references "${specifier}", which resolves outside CitadelSamples`);
    }
  }
}

/* 4. the notebook is never written to */
const SELF = fileURLToPath(import.meta.url);
for (const file of scriptFiles) {
  if (file === SELF) continue; // this file names the pattern it looks for
  const text = await readFile(file, 'utf-8');
  if (/writeFile[\s\S]{0,120}\.ipynb/.test(text)) {
    fail(`${relative(ROOT, file)} appears to write to the source notebook`);
  }
}

if (failures.length > 0) {
  process.stdout.write(`check: ${failures.length} problem(s)\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`check: ok — ${scriptFiles.length} modules, 2 approved authentication dependencies, nothing outside CitadelSamples\n`);
