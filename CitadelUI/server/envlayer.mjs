/**
 * Environment layer for env-driven parameter files.
 *
 * bicep/infra/main.bicepparam and resources.bicepparam resolve ~107 values each
 * through readEnvironmentVariable(NAME, default). Editing the literal default in
 * the .bicepparam is almost never what the user means — the real value lives in
 * .azure/<env>/.env (the azd convention, seeded from .env.template).
 *
 * So for those files the UI edits the environment variable, and this module owns
 * that file format. Writes are line-preserving for the same reason the parameter
 * editor is span-preserving: .env.template is heavily commented.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './config.mjs';

const azureDir = join(repoRoot, '.azure');

export function listEnvironments() {
  if (!existsSync(azureDir)) return [];
  return readdirSync(azureDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      envFile: join('.azure', e.name, '.env').split('\\').join('/'),
      exists: existsSync(join(azureDir, e.name, '.env')),
    }));
}

/** Parse KEY=VALUE lines, tolerating quotes, comments and blank lines. */
export function parseEnvFile(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq === -1) return;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    let raw = line.slice(eq + 1).trim();
    let quote = null;
    if ((raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
        (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)) {
      quote = raw[0];
      raw = raw.slice(1, -1);
    }
    entries.push({ key, value: raw, quote, line: index });
  });
  return entries;
}

export function readEnvironment(name) {
  const file = join(azureDir, name, '.env');
  if (!existsSync(file)) return { name, exists: false, text: '', entries: [] };
  const text = readFileSync(file, 'utf8');
  return { name, exists: true, text, entries: parseEnvFile(text) };
}

/**
 * Update variables in place. Existing lines are rewritten on their original line
 * so surrounding comments keep their meaning; new variables are appended under a
 * clearly labelled section.
 */
export function writeEnvironment(name, updates) {
  const dir = join(azureDir, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '.env');

  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!text && existsSync(join(repoRoot, '.env.template'))) {
    text = readFileSync(join(repoRoot, '.env.template'), 'utf8');
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const existing = new Map(parseEnvFile(text).map((e) => [e.key, e]));
  const appended = [];

  for (const [key, value] of Object.entries(updates)) {
    const str = value === null || value === undefined ? '' : String(value);
    const found = existing.get(key);
    if (found) {
      const q = found.quote || '"';
      lines[found.line] = `${key}=${q}${str}${q}`;
    } else {
      appended.push(`${key}="${str}"`);
    }
  }

  let out = lines.join(eol);
  if (appended.length) {
    const header = `${eol}${eol}# Added by Citadel UI${eol}`;
    out = out.replace(/\s*$/, '') + header + appended.join(eol) + eol;
  }
  writeFileSync(file, out, 'utf8');
  return { name, file: join('.azure', name, '.env').split('\\').join('/'), updated: Object.keys(updates) };
}

/** Resolve what an env-driven parameter would evaluate to for a given environment. */
export function resolveEnvValue(envEntries, varName, fallback) {
  const hit = envEntries.find((e) => e.key === varName);
  return {
    variable: varName,
    value: hit ? hit.value : fallback,
    source: hit ? 'environment' : 'default',
    fallback,
  };
}
