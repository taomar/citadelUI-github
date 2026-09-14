import { sensitiveName, sensitiveText } from './migration-input.mjs';

export const EXPORT_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 24 * 1024 * 1024,
  files: 3,
  dependencies: 64,
  depth: 32,
  nodes: 50000,
  pathBytes: 240,
});

export class TerraformExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TerraformExportError';
    this.code = code;
  }
}

export function exportFail(code, message) {
  throw new TerraformExportError(code, message);
}

const REFERENCE_NAMES = new Set([
  'namedValueKey', 'named_value_key', 'keyVaultSecretUri', 'key_vault_secret_uri',
  'apiKeySecretName', 'api_key_secret_name', 'endpointSecretName', 'endpoint_secret_name',
  'entra_client_secret_name', 'usePrimaryKey',
  'rbac_authorization_enabled', 'entra_client_secret_rotation_days',
  'create_apim_gateway_key_secret',
]);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor', '__expr']);

export function validUnicode(value) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return false;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}

/** Credential references are data; credentials themselves never enter an export. */
export function exportSecret(value, name = '', depth = 0) {
  if (depth > EXPORT_LIMITS.depth) return true;
  if (value === '' || value === null || value === undefined) return false;
  const namedReference = typeof value === 'string' && /^(?:(?:Bearer|Basic)\s+)?\{\{[A-Za-z0-9_.-]+\}\}$/i.test(value);
  if (name && sensitiveName(name) && !REFERENCE_NAMES.has(name) && !namedReference &&
      !['authConfig', 'auth_config', 'customHeaders', 'custom_headers'].includes(name)) return true;
  if (typeof value === 'string') {
    if (/^\/subscriptions\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/resourceGroups\/[A-Za-z0-9_.-]+\/providers\/[A-Za-z0-9.]+(?:\/[A-Za-z0-9_.-]+){2,}$/i.test(value)) return false;
    if (['keyVaultSecretUri', 'key_vault_secret_uri'].includes(name) &&
        /^https:\/\/[a-z0-9-]+\.vault\.(?:azure\.net|azure\.cn|usgovcloudapi\.net)\/secrets\/[a-z0-9-]+(?:\/[a-f0-9]{32})?$/i.test(value)) return false;
    // Keep APIM named-value placeholders literal, without treating a placeholder
    // named "api-key" as secret material. Scan all remaining text.
    const withoutReferences = value
      .replace(/(?:(?:Bearer|Basic)\s+)?\{\{[A-Za-z0-9_.-]+\}\}/gi, '')
      .replace(/(["'])(?:Bearer|Basic)\s+\1\s*\+\s*(?:\([A-Za-z][\w.<>?]*\)\s*)?context\./gi, 'context.');
    return sensitiveText(withoutReferences);
  }
  if (Array.isArray(value)) return value.some((entry) => exportSecret(entry, '', depth + 1));
  return value && typeof value === 'object' &&
    Object.entries(value).some(([key, entry]) => exportSecret(entry, key, depth + 1));
}

export function assertExportValue(value) {
  let nodes = 0;
  let totalBytes = 0;
  const string = (entry) => {
    if (entry.length > EXPORT_LIMITS.fileBytes) exportFail('limit', 'An export string exceeds 8 MiB.');
    if (!validUnicode(entry)) exportFail('literal', 'A value contains unsupported control characters or invalid Unicode.');
    const size = new TextEncoder().encode(entry).length;
    if (size > EXPORT_LIMITS.fileBytes) exportFail('limit', 'An export string exceeds 8 MiB.');
    totalBytes += size;
    if (totalBytes > EXPORT_LIMITS.totalBytes) exportFail('limit', 'Combined export values exceed 24 MiB.');
  };
  const visit = (entry, depth) => {
    if (++nodes > EXPORT_LIMITS.nodes || depth > EXPORT_LIMITS.depth) {
      exportFail('limit', 'Export values exceed the bounded nesting or item limit.');
    }
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'string') {
      string(entry);
      return;
    }
    // Bicep integers must remain exact. Fractional/unsafe JS numbers are refused,
    // not rounded into success-shaped HCL.
    if (typeof entry === 'number') {
      if (!Number.isSafeInteger(entry) || Object.is(entry, -0)) exportFail('number', 'Export numbers must be exact safe integers.');
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (!entry || typeof entry !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) {
      exportFail('literal', 'Only literal strings, integers, booleans, nulls, arrays and objects can be exported.');
    }
    for (const [key, item] of Object.entries(entry)) {
      if (RESERVED.has(key) || !validUnicode(key)) exportFail('literal', 'An object contains an unsupported property name.');
      string(key);
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return value;
}

function quote(value) {
  return JSON.stringify(value).replaceAll('${', () => '$${').replaceAll('%{', () => '%%{');
}

export function hclLiteral(value) {
  assertExportValue(value);
  const encode = (entry, depth) => {
    if (typeof entry === 'string') return quote(entry);
    if (entry === null || typeof entry !== 'object') return String(entry);
    const pad = '  '.repeat(depth);
    if (Array.isArray(entry)) {
      return entry.length ? `[\n${entry.map((item) => `${pad}  ${encode(item, depth + 1)},`).join('\n')}\n${pad}]` : '[]';
    }
    const keys = Object.keys(entry).sort();
    return keys.length
      ? `{\n${keys.map((key) => `${pad}  ${quote(key)} = ${encode(entry[key], depth + 1)}`).join('\n')}\n${pad}}`
      : '{}';
  };
  return encode(value, 0);
}

export function terraformVariables(values) {
  assertExportValue(values);
  if (exportSecret(values)) exportFail('secret', 'Secret material is not permitted in Terraform ZIP exports.');
  if (!values || Array.isArray(values) || typeof values !== 'object' || !Object.keys(values).length) {
    exportFail('empty', 'An export must contain actual mapped variables.');
  }
  const text = Object.keys(values).sort().map((name) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) exportFail('variable', 'Invalid Terraform variable name.');
    return `${name} = ${hclLiteral(values[name])}\n`;
  }).join('\n');
  if (new TextEncoder().encode(text).length > EXPORT_LIMITS.fileBytes) exportFail('limit', 'The generated variable file exceeds 8 MiB.');
  return text;
}

export function exportEnvironmentName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{3,24}$/.test(value) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)) {
    exportFail('environment', 'Use an unchanged, portable environment identity: 3-24 lowercase letters, numbers or hyphens; no reserved device names.');
  }
  return value;
}

export function exportEntryPath(value) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') ||
      !validUnicode(value) || new TextEncoder().encode(value).length > EXPORT_LIMITS.pathBytes ||
      /[\\:<>"|?*\u0000-\u001f\u007f]/.test(value)) {
    exportFail('path', 'ZIP paths must be portable, relative UTF-8 paths of at most 240 bytes.');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.startsWith('.'))) {
    exportFail('path', 'ZIP paths cannot contain traversal, hidden directories, empty components or reserved names.');
  }
  return value;
}
