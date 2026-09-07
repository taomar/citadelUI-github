/**
 * Bounded, data-only migration inputs. Nothing in this module evaluates Bicep,
 * ARM, environment variables, scripts, imports, or Key Vault references.
 *
 * The normal editor's value helpers deliberately evaluate some fallbacks.
 * Migration must NOT use those helpers on an untrusted donor.
 */
import { parseBicepParam } from './bicepparam/parser.mjs';
import { MAX_SOURCE_BYTES } from './source-scope.mjs';

export const MIGRATION_LIMITS = Object.freeze({
  bytes: MAX_SOURCE_BYTES,
  totalBytes: 16 * 1024 * 1024,
  files: 16,
  parameters: 1000,
  tokens: 100000,
  depth: 48,
});

const MESSAGES = Object.freeze({
  format: 'This file is malformed or uses unsupported parameter syntax. Source contents were withheld.',
  envelope: 'Select a standard ARM deploymentParameters JSON file, not arbitrary JSON.',
  'json-duplicate': 'The JSON envelope has duplicate keys. Resolve them in a separate donor copy before importing.',
  'donor-template': 'More than one selected file could be the donor template. Reselect one unambiguous matching template before importing.',
  missing: 'The selected source or template was not found. Reselect it before continuing.',
  limit: 'The migration input exceeds a safety limit (8 MiB per file, 16 MiB selected, 1,000 parameters, or bounded nesting).',
  scope: 'The selection is outside the permitted parameter/template scope.',
  permission: 'Read permission is required for the selected donor. No write permission is requested.',
  identity: 'Source and destination must be demonstrably separate. This selection overlaps, repeats a file, or cannot prove file identity.',
  stale: 'The workspace, donor, target, template, or branch changed. Replan and review again; nothing newer will be overwritten.',
  pending: 'Save or discard existing editor changes and the selected target’s saved draft before migrating. Migration does not overwrite drafts.',
  decision: 'Choose a valid, reviewed candidate or deliberately keep the destination value.',
  review: 'Create a fresh preview and explicitly review it before applying.',
  blocked: 'Resolve the blocking destination fields and outstanding decisions before applying.',
  remote: 'Remote destinations are preview/export-only. Migration never commits or writes to GitHub.',
  closed: 'This migration session has ended. Open Migrate Citadel Configuration again.',
  'apply-failed': 'The local transaction did not complete normally. Open Settings > History to check rollback or recovery before retrying.',
  'public-input': 'Use a github.com repository root URL or owner/repo, and select an explicit branch, tag, or full commit SHA.',
  'public-rate': 'Anonymous GitHub rate limit reached. Wait for the public quota to reset, then reconnect and replan. A PAT is not required.',
  'public-not-found': 'The public GitHub repository, ref, or selected file is unavailable anonymously. It may be missing or no longer public. Reconnect and replan.',
  'public-read': 'Public GitHub could not be read or returned an invalid response. Retry by reconnecting the donor. No GitHub credentials were used.',
  'public-redirect': 'GitHub redirected this public read. Redirects are refused; enter the repository’s current canonical URL and reconnect.',
  'public-scope': 'This public donor entry is outside the allowed scope, oversized, a symlink/submodule, or a Git LFS pointer. It cannot supply migration values.',
  'public-tree': 'The public repository tree is incomplete or exceeds the public-donor limits. No partial tree is used as proof that fields or templates are missing.',
  'public-stale': 'The public donor repository, ref, commit, tree, or file identity changed. Reconnect the public donor and replan before export or apply.',
  'public-expired': 'The public donor snapshot expired or was evicted. Reconnect the public donor and review a new plan.',
  'public-format': 'The selected public JSON file is not a supported, unambiguous ARM deployment-parameters envelope. No values were imported.',
  'public-read-only': 'Public GitHub donor access is read-only. Writes, credentials, arbitrary hosts, and arbitrary API paths are not accepted.',
  'private-input': 'Choose one source PAT or saved connection, then enter a GitHub repository root and an explicit branch, tag, or full commit SHA.',
  'private-auth-required': 'Connect a source PAT or saved GitHub connection before reading this donor.',
  'private-auth-invalid': 'GitHub rejected the source credential. Enter a valid fine-grained PAT for the selected repositories.',
  'private-auth-expired': 'The source credential session expired or was revoked. Reconnect the donor and review a new plan.',
  'private-auth-classic': 'Use a fine-grained source PAT limited to the intended repositories. The existing classic-token policy is unchanged.',
  'private-account': 'The source credential does not belong to the selected saved connection. No connection or destination credential was replaced.',
  'private-profile': 'The selected saved source connection is unavailable. Reconnect it in Settings or enter a separate session-only source PAT.',
  'private-access': 'The source credential cannot read this repository or file. Check the repository selection, Contents Read permission, and any organization approval or SSO requirements.',
  'private-rate': 'GitHub rate-limited this source connection. Wait before reconnecting and replanning; no anonymous fallback is used.',
  'private-stale': 'The source connection, saved profile, repository, ref, or pinned snapshot changed. Select the donor again and review a new plan.',
  'private-expired': 'The authenticated donor snapshot expired. Read the donor again and review a new plan.',
  'private-read': 'The authenticated GitHub donor could not be read safely. Reconnect or retry the explicit source; upstream details were withheld.',
  'private-scope': 'This authenticated donor input is outside the bounded parameter/template scope or uses unsupported data. No values were imported.',
  'private-disconnect': 'The source session could not be confirmed erased. Retry disconnecting it; no new source connection will replace it silently.',
  'private-read-only': 'Authenticated donor access is read-only. GitHub writes and arbitrary API paths are not accepted.',
  unavailable: 'The selected source or template could not be read. Reconnect or reselect it; source details were withheld.',
});

export class MigrationError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.unavailable);
    this.name = 'MigrationError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'unavailable';
  }
}

export function migrationMessage(error) {
  return error instanceof MigrationError ? error.message : MESSAGES.unavailable;
}

export function assertInputSize(text) {
  if (typeof text !== 'string') throw new MigrationError('format');
  if (new TextEncoder().encode(text).byteLength > MIGRATION_LIMITS.bytes) {
    throw new MigrationError('limit');
  }
}

// Deliberately conservative. Credentials can occur inside otherwise innocuous
// arrays/objects and donors frequently have no usable @secure schema at all.
const SENSITIVE_NAME = /password|passwd|passphrase|secret|credential|connectionstring|privatekey|accesskey|apikey|accountkey|clientassertion|authorization|authconfig|certificate|sastoken|sharedaccess|(^|_)token($|_)|tokenvalue|bearertoken|refreshtoken|accesstoken/i;
export function sensitiveName(name) {
  const compact = String(name).replace(/[^a-z0-9]/gi, '');
  return SENSITIVE_NAME.test(String(name).replace(/[-.\s]/g, '').replace(/([a-z])([A-Z])/g, '$1_$2')) ||
    SENSITIVE_NAME.test(compact) || /key$/i.test(compact);
}

export function sensitiveText(value) {
  if (typeof value !== 'string') return false;
  if (/-----BEGIN .*PRIVATE KEY-----|(?:bearer|basic)\s+\S+|(?:AccountKey|SharedAccessSignature|Password|pwd|secret|api[_-]?key|token)\s*[=:]\s*\S+/i.test(value) ||
      /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value)) return true;
  if (value.includes('://') && (value.length > 2048 ||
      /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/]+@|\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s]*[?#]/i.test(value))) return true;
  // Scan each token once, rather than using repeated lookaheads over untrusted
  // multi-megabyte strings. UUID coordinates and hyphenated names stay readable.
  for (const match of value.matchAll(/[A-Za-z0-9+/=]{32,}/g)) {
    if (/[A-Za-z]/.test(match[0]) && /\d/.test(match[0])) return true;
  }
  return false;
}

export function sensitiveValue(value, name = '', depth = 0) {
  if (sensitiveName(name) || depth > MIGRATION_LIMITS.depth) return true;
  if (typeof value === 'string') return sensitiveText(value);
  if (Array.isArray(value)) return value.some((item) => sensitiveValue(item, '', depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => sensitiveValue(item, key, depth + 1));
  }
  return false;
}

/** Only for labels/guidance, never as a way to make a secret value copyable. */
export function safeLabel(value, fallback = '[withheld]') {
  const text = String(value ?? '');
  if (sensitiveText(text) || /[\u0000-\u001f\u007f]/.test(text)) return fallback;
  return text.slice(0, 1024);
}

const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor', '__expr']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export function parameterName(name) {
  if (!NAME.test(name) || RESERVED_KEYS.has(name.toLowerCase()) || safeLabel(name) !== name) throw new MigrationError('format');
  return name;
}

export function migrationParameterKey(name) {
  // Non-Bicep ARM labels can be reported, but Unicode case folding must not
  // turn them into aliases for an existing ASCII Bicep identifier.
  return NAME.test(name) ? name.toLowerCase() : `invalid:${name.toLowerCase()}`;
}

function donorParameterLabel(name) {
  // ARM labels can contain periods and need not be writable Bicep identifiers.
  // Only names from the current Bicep target/schema can become declarations.
  if (!name || name.length > 128 || name.trim() !== name ||
      RESERVED_KEYS.has(name.toLowerCase()) || !supportedString(name) || safeLabel(name) !== name) {
    throw new MigrationError('format');
  }
  return name;
}

/**
 * A lexical boundary scanner, NOT a Bicep evaluator/compiler. It understands
 * comments, balanced delimiters, and interpolated strings so unsupported
 * expressions cannot be mistaken for a truncated literal by the editor parser.
 */
export function scanBicep(text) {
  assertInputSize(text);
  const tokens = [];
  const stack = [];
  let index = 0;
  let line = 1;
  let first = true;
  const fail = () => { throw new MigrationError('format'); };
  const quoted = (level = 0) => {
    if (level > MIGRATION_LIMITS.depth) throw new MigrationError('limit');
    const start = index;
    if (text.startsWith("'''", index)) {
      index += 3;
      const end = text.indexOf("'''", index);
      if (end < 0) fail();
      line += (text.slice(index, end).match(/\n/g) || []).length;
      index = end + 3;
      return;
    }
    index += 1;
    while (index < text.length) {
      if (text[index] === "'") { index += 1; return; }
      if (text[index] === '\n' || text[index] === '\r') fail();
      if (text[index] === '\\') {
        if (!/['\\nrt$u]/.test(text[index + 1] || '')) fail();
        if (text[index + 1] === 'u') {
          const unicode = /^\\u\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(index));
          if (!unicode || parseInt(unicode[1], 16) > 0x10ffff) fail();
          index += unicode[0].length;
        } else index += 2;
        continue;
      }
      if (text.startsWith('${', index)) {
        index += 2;
        let depth = 1;
        while (index < text.length && depth) {
          if (text[index] === "'") quoted(level + 1);
          else {
            if (text[index] === '{') depth += 1;
            if (text[index] === '}') depth -= 1;
            if (text[index] === '\n') line += 1;
            if (depth + level > MIGRATION_LIMITS.depth) throw new MigrationError('limit');
            index += 1;
          }
        }
        if (depth) fail();
        continue;
      }
      index += 1;
    }
    if (index > start) fail();
  };
  while (index < text.length) {
    const character = text[index];
    if (/\s|\uFEFF/.test(character)) {
      if (character === '\n') { line += 1; first = true; }
      index += 1;
      continue;
    }
    if (text.startsWith('//', index)) {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) fail();
      const newlines = (text.slice(index, end).match(/\n/g) || []).length;
      line += newlines;
      if (newlines) first = true;
      index = end + 2;
      continue;
    }
    const start = index;
    const tokenLine = line;
    const depth = stack.length;
    let kind = 'symbol';
    if (character === "'") {
      kind = 'string';
      quoted();
    } else if (/[A-Za-z_]/.test(character)) {
      kind = 'word';
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) index += 1;
    } else if (/[0-9]/.test(character) || (character === '-' && /[0-9]/.test(text[index + 1] || ''))) {
      kind = 'number';
      index += 1;
      while (index < text.length && /[0-9]/.test(text[index])) index += 1;
    } else {
      index += 1;
      if ('[{('.includes(character)) stack.push(character);
      if (']})'.includes(character) && stack.pop() !== { ']': '[', '}': '{', ')': '(' }[character]) fail();
      if (stack.length > MIGRATION_LIMITS.depth) throw new MigrationError('limit');
    }
    tokens.push({ kind, text: text.slice(start, index), start, end: index, depth, first, line: tokenLine });
    first = false;
    if (tokens.length > MIGRATION_LIMITS.tokens) throw new MigrationError('limit');
  }
  if (stack.length) fail();
  return tokens;
}

function interpolated(raw) {
  // Triple quoted Bicep strings do not interpolate.
  if (raw.startsWith("'''")) return false;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '\\') { index += 1; continue; }
    if (raw.startsWith('${', index)) return true;
  }
  return false;
}

function literalNode(node, source) {
  if (node.kind === 'string') {
    if (interpolated(source.slice(node.start, node.end))) return { status: 'dynamic' };
    if (!supportedString(node.value)) return { status: 'unsupported' };
    return { status: 'literal', value: node.value };
  }
  if (['number', 'bool', 'null'].includes(node.kind)) {
    if (node.kind === 'number' && !Number.isSafeInteger(node.value)) return { status: 'unsupported' };
    return { status: 'literal', value: node.value };
  }
  if (node.kind === 'array') {
    const values = node.items.map((item) => literalNode(item, source));
    const problem = values.find((item) => item.status !== 'literal');
    return problem || { status: 'literal', value: values.map((item) => item.value) };
  }
  if (node.kind === 'object') {
    const keys = new Set();
    const value = Object.create(null);
    for (const property of node.properties) {
      if (!supportedString(property.key)) return { status: 'unsupported' };
      const key = property.key.toLowerCase();
      if (keys.has(key) || RESERVED_KEYS.has(key)) return { status: 'ambiguous' };
      if (property.quoted && interpolated(source.slice(property.keyStart, property.keyEnd))) {
        return { status: 'dynamic' };
      }
      keys.add(key);
      const entry = literalNode(property.value, source);
      if (entry.status !== 'literal') return entry;
      value[property.key] = entry.value;
    }
    return { status: 'literal', value };
  }
  return { status: 'dynamic' };
}

function supportedString(value) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return false;
  // Encoding an unpaired surrogate replaces it with U+FFFD. That would be a
  // silent value conversion, not a faithful literal migration.
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}

export function literalBicep(text) {
  try {
    const source = `param value = ${text}`;
    const tokens = scanBicep(source);
    const parsed = parseBicepParam(source);
    if (parsed.params.length !== 1 || parsed.using) return { status: 'dynamic' };
    const value = parsed.params[0].value;
    if (tokens.some((token) => token.start >= value.end)) return { status: 'dynamic' };
    return literalNode(value, source);
  } catch (error) {
    if (error instanceof MigrationError && error.code === 'limit') throw error;
    return { status: 'dynamic' };
  }
}

const DECLARATIONS = new Set(['using', 'param', 'var', 'extends', 'type', 'import']);

export function readBicepParameters(text, { target = false } = {}) {
  const tokens = scanBicep(text);
  const starts = tokens.filter((token) => token.depth === 0 && token.first && DECLARATIONS.has(token.text));
  if (tokens.length && tokens[0] !== starts[0]) throw new MigrationError('format');
  const parameters = [];
  let using = null;
  let usingSeen = false;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1]?.start ?? text.length;
    const body = tokens.filter((token) => token.start >= start.start && token.start < end);
    if (start.text === 'using') {
      if (usingSeen || body.length !== 2) throw new MigrationError('format');
      usingSeen = true;
      const result = body[1].text === 'none' ? { status: 'literal', value: null } : literalBicep(body[1].text);
      if (result.status !== 'literal' || (result.value !== null && typeof result.value !== 'string')) {
        throw new MigrationError('format');
      }
      using = result.value;
      continue;
    }
    if (start.text !== 'param' || body[1]?.kind !== 'word' || body[2]?.text !== '=' || !body[3]) {
      throw new MigrationError('format');
    }
    const name = parameterName(body[1].text);
    const expressionEnd = body.at(-1).end;
    const raw = text.slice(body[3].start, expressionEnd);
    const literal = literalBicep(raw);
    parameters.push({
      name, ...literal, start: start.start, end: expressionEnd,
      valueStart: body[3].start, valueEnd: expressionEnd,
    });
    if (parameters.length > MIGRATION_LIMITS.parameters) throw new MigrationError('limit');
  }
  if (target) {
    // Only use surgical editor operations when that parser sees exactly these
    // complete declarations. In particular, it must not silently skip a suffix.
    try {
      const parsed = parseBicepParam(text);
      if (parsed.params.length !== parameters.length || parsed.params.some((param, index) =>
        param.name !== parameters[index].name || param.value.end !== parameters[index].valueEnd
      )) throw new MigrationError('format');
    } catch { throw new MigrationError('format'); }
  }
  return { using, parameters };
}

/** JSON parser retaining property occurrences instead of JSON.parse last-wins. */
function jsonTree(text) {
  assertInputSize(text);
  text = text.replace(/^\uFEFF/, '');
  let index = 0;
  let nodes = 0;
  const bad = () => { throw new MigrationError('format'); };
  const space = () => { while (/[ \t\r\n]/.test(text[index] || '\0')) index += 1; };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index++] === '"') {
        try { return JSON.parse(text.slice(start, index)); } catch { bad(); }
      }
    }
    bad();
  };
  const read = (depth = 0) => {
    if (++nodes > MIGRATION_LIMITS.tokens || depth > MIGRATION_LIMITS.depth) throw new MigrationError('limit');
    space();
    const start = text[index];
    if (start === '"') return { kind: 'scalar', value: string() };
    if (start === '{' || start === '[') {
      index += 1;
      const object = start === '{';
      const close = object ? '}' : ']';
      const items = [];
      space();
      if (text[index] === close) { index += 1; return { kind: object ? 'object' : 'array', items }; }
      while (index < text.length) {
        space();
        let key;
        if (object) {
          if (text[index] !== '"') bad();
          key = string();
          space();
          if (text[index++] !== ':') bad();
        }
        const value = read(depth + 1);
        items.push(object ? { key, value } : value);
        space();
        if (text[index] === close) { index += 1; return { kind: object ? 'object' : 'array', items }; }
        if (text[index++] !== ',') bad();
      }
      bad();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
    if (!token) bad();
    index += token[0].length;
    const value = JSON.parse(token[0]);
    if (typeof value === 'number' && !Number.isFinite(value)) bad();
    return { kind: 'scalar', value };
  };
  const tree = read();
  space();
  if (index !== text.length) bad();
  return tree;
}

function jsonLiteral(tree) {
  if (tree.kind === 'scalar') {
    if (typeof tree.value === 'string' && (/^\s*\[/.test(tree.value) || tree.value.includes('${'))) {
      return { status: 'dynamic' };
    }
    if (typeof tree.value === 'number' && !Number.isSafeInteger(tree.value)) return { status: 'unsupported' };
    if (typeof tree.value === 'string' && !supportedString(tree.value)) return { status: 'unsupported' };
    return { status: 'literal', value: tree.value };
  }
  if (tree.kind === 'array') {
    const entries = tree.items.map(jsonLiteral);
    return entries.find((entry) => entry.status !== 'literal') ||
      { status: 'literal', value: entries.map((entry) => entry.value) };
  }
  const value = Object.create(null);
  const seen = new Set();
  for (const entry of tree.items) {
    if (!supportedString(entry.key)) return { status: 'unsupported' };
    const key = entry.key.toLowerCase();
    if (seen.has(key) || RESERVED_KEYS.has(key)) return { status: 'ambiguous' };
    seen.add(key);
    const result = jsonLiteral(entry.value);
    if (result.status !== 'literal') return result;
    value[entry.key] = result.value;
  }
  return { status: 'literal', value };
}

export function readArmParameters(text) {
  const root = jsonTree(text);
  if (root.kind !== 'object') throw new MigrationError('envelope');
  const keys = root.items.map((item) => item.key);
  if (new Set(keys).size !== keys.length) throw new MigrationError('json-duplicate');
  if (keys.some((key) => !['$schema', 'contentVersion', 'parameters'].includes(key))) throw new MigrationError('envelope');
  const get = (key) => root.items.find((item) => item.key === key)?.value;
  if (!/^https?:\/\/schema\.management\.azure\.com\/schemas\/\d{4}-\d{2}-\d{2}\/deploymentParameters\.json#?$/.test(get('$schema')?.value || '') ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(get('contentVersion')?.value || '') || get('parameters')?.kind !== 'object') {
    throw new MigrationError('envelope');
  }
  const parameters = get('parameters').items.map(({ key, value }) => {
    const name = donorParameterLabel(key);
    if (value.kind !== 'object') throw new MigrationError('envelope');
    const members = value.items.map((item) => item.key);
    if (new Set(members).size !== members.length) return { name, status: 'ambiguous' };
    if (members.length === 1 && members[0] === 'reference') return { name, status: 'dynamic', sensitive: true };
    if (members.length !== 1 || members[0] !== 'value') throw new MigrationError('envelope');
    return { name, ...jsonLiteral(value.items[0].value) };
  });
  if (parameters.length > MIGRATION_LIMITS.parameters) throw new MigrationError('limit');
  return { using: null, parameters };
}
