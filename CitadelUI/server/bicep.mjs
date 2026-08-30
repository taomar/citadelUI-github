/**
 * Read the parameter contract directly from the repository's Bicep source.
 *
 * Citadel UI is a local file editor, not a Bicep execution surface. Schema
 * extraction therefore never shells out to Azure CLI or the Bicep compiler.
 * The decorators used by the editor are deliberately small and static:
 * @allowed, @description, @secure and numeric/string bounds.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './config.mjs';

const cache = new Map();

function stringLiterals(text) {
  const values = [];
  const re = /'((?:\\'|[^'])*)'/g;
  let match;
  while ((match = re.exec(text))) values.push(match[1].replace(/\\'/g, "'"));
  return values;
}

function decoratorBody(block, name) {
  const start = block.lastIndexOf(`@${name}(`);
  if (start < 0) return null;
  let depth = 0;
  let quote = false;
  for (let i = start + name.length + 2; i < block.length; i += 1) {
    const ch = block[i];
    if (ch === "'" && block[i - 1] !== '\\') quote = !quote;
    if (quote) continue;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return block.slice(start + name.length + 2, i);
      depth -= 1;
    }
  }
  return null;
}

function numberDecorator(block, name) {
  const body = decoratorBody(block, name);
  if (body === null) return undefined;
  const value = Number(body.trim());
  return Number.isFinite(value) ? value : undefined;
}

function allowedValues(block) {
  const body = decoratorBody(block, 'allowed');
  if (body === null) return null;
  const strings = stringLiterals(body);
  if (strings.length) return strings;
  return body
    .replace(/^\s*\[/, '')
    .replace(/\]\s*$/, '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((value) => value === 'true' ? true : value === 'false' ? false : Number(value));
}

export function extractSchema(source) {
  const parameters = {};
  const re = /((?:^[ \t]*@[\s\S]*?\r?\n)*)^[ \t]*param[ \t]+([A-Za-z_]\w*)[ \t]+([A-Za-z_]\w*)/gm;
  let match;
  while ((match = re.exec(source))) {
    const [, decorators, name, type] = match;
    const descriptionBody = decoratorBody(decorators, 'description');
    const descriptions = descriptionBody === null ? [] : stringLiterals(descriptionBody);
    parameters[name] = {
      name,
      type,
      secure: /@secure\s*\(/.test(decorators),
      description: descriptions[0] || null,
      allowedValues: allowedValues(decorators),
      minLength: numberDecorator(decorators, 'minLength'),
      maxLength: numberDecorator(decorators, 'maxLength'),
      minValue: numberDecorator(decorators, 'minValue'),
      maxValue: numberDecorator(decorators, 'maxValue'),
      metadata: {},
    };
  }
  return parameters;
}

export async function hasBicep() {
  return false;
}

export async function getSchema(templateRelPath) {
  if (!templateRelPath) return { available: false, parameters: {}, error: 'No template resolved' };
  const file = join(repoRoot, templateRelPath);
  if (!existsSync(file)) {
    return { available: false, parameters: {}, error: `Template not found: ${templateRelPath}` };
  }

  const mtimeMs = statSync(file).mtimeMs;
  const prior = cache.get(templateRelPath);
  if (prior && prior.mtimeMs === mtimeMs) return prior.schema;

  const parameters = extractSchema(readFileSync(file, 'utf8'));
  const schema = {
    available: Object.keys(parameters).length > 0,
    parameters,
    error: Object.keys(parameters).length ? null : 'No Bicep parameter declarations found',
    source: 'repository',
  };
  cache.set(templateRelPath, { mtimeMs, schema });
  return schema;
}

export function clearSchemaCache() {
  cache.clear();
}
