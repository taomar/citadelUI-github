/**
 * Source scope policy shared by every Citadel source implementation.
 *
 * The local folder provider and the GitHub repository provider must agree on
 * exactly which repository paths Citadel UI is allowed to enumerate, read, and
 * write. Keeping the policy in one module means a GitHub tree cannot widen the
 * boundary that the local editor already enforces, and lets the server validate
 * the same aliases the browser sends.
 */

export const SOURCE_EXTENSIONS = Object.freeze(['.bicepparam', '.bicep', '.xml']);
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_ENV_BYTES = 1024 * 1024;
export const SUBSCRIPTION_ENVIRONMENT_KEY = 'AZURE_SUBSCRIPTION_ID';

const EXTENSIONS = new Set(SOURCE_EXTENSIONS);

export const SKIP_DIRECTORIES = Object.freeze([
  '.azure',
  '.git',
  '.github',
  '.vscode',
  'node_modules',
  '.venv',
  '__pycache__',
  'CitadelUI',
  '.backups',
  '.baseline',
  '.qa',
  '.shots',
  '.snapshots',
].map((name) => name.toLowerCase()));

const SKIPPED = new Set(SKIP_DIRECTORIES);

export function sourceExtension(name) {
  const leaf = String(name || '').toLowerCase();
  const dot = leaf.lastIndexOf('.');
  return dot < 0 ? '' : leaf.slice(dot);
}

export function isSourceExtension(name) {
  return EXTENSIONS.has(sourceExtension(name));
}

export function isEnvironmentFile(name) {
  const leaf = String(name || '').toLowerCase();
  return leaf === '.env' || leaf.startsWith('.env.');
}

export function isSkippedDirectory(name) {
  const value = String(name || '');
  return value.startsWith('.') || SKIPPED.has(value.toLowerCase());
}

export const MAX_ALIAS_LENGTH = 1024;

export function normalizeAlias(alias) {
  const value = String(alias || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = value.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`Unsafe workspace alias: ${alias}`);
  }
  // Enumeration rejects control characters and over-long paths, so writes must
  // too. A path that survives a commit but fails enumeration can never be
  // listed, read, edited, or deleted through Citadel again; and a newline in a
  // leaf reaches the commit message ahead of the trailer block, where an
  // injected `Citadel-Environment:` line would be parsed in preference to the
  // real one and hide the commit from History and Undo.
  if (parts.some((part) => /[\u0000-\u001f\u007f]/.test(part))) {
    throw new Error(`Unsafe workspace alias: ${alias}`);
  }

  if (parts.some((part) => part.toLowerCase() === '.azure')) {
    throw new Error('Citadel UI never accesses .azure directories.');
  }
  const leaf = parts.at(-1);
  if (isEnvironmentFile(leaf)) {
    throw new Error('Citadel UI never accesses environment files.');
  }
  if (!isSourceExtension(leaf)) {
    throw new Error(`Unsupported source type: ${leaf}`);
  }
  const normalized = parts.join('/');
  if (normalized.length > MAX_ALIAS_LENGTH) {
    throw new Error(`Unsafe workspace alias: ${alias}`);
  }
  return normalized;
}

export function normalizeDirectoryAlias(alias) {
  const value = String(alias || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = value.split('/').filter(Boolean);
  if (
    !parts.length ||
    parts.some((part) => part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part))
  ) {
    throw new Error(`Unsafe workspace directory alias: ${alias}`);
  }
  if (parts.some((part) => part.toLowerCase() === '.azure')) {
    throw new Error('Citadel UI never accesses .azure directories.');
  }
  const normalized = parts.join('/');
  if (normalized.length > MAX_ALIAS_LENGTH) {
    throw new Error(`Unsafe workspace directory alias: ${alias}`);
  }
  return normalized;
}

/**
 * `.azure/<environment>/.env` is the single deliberate exception to the alias
 * policy. It is never enumerated, never read as a source document, and only the
 * subscription bridge may address it, so it gets its own validator.
 */
export function subscriptionEnvironmentAlias(environmentName) {
  const name = String(environmentName || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid azd environment name.');
  }
  return `.azure/${name}/.env`;
}

export async function sha256(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export const sourceScope = Object.freeze({
  extensions: [...SOURCE_EXTENSIONS],
  skippedDirectories: [...SKIP_DIRECTORIES],
  normalizeAlias,
  maxSourceBytes: MAX_SOURCE_BYTES,
  subscriptionEnvironmentKey: SUBSCRIPTION_ENVIRONMENT_KEY,
});
