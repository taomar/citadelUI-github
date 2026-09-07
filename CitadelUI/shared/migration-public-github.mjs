import { refNameProblem } from './git-refs.mjs';
import { isSkippedDirectory, normalizeDirectoryAlias, sourceExtension } from './source-scope.mjs';
import { MigrationError, safeLabel, sensitiveText } from './migration-input.mjs';

export const PUBLIC_DONOR_LIMITS = Object.freeze({
  files: 2000,
  snapshots: 8,
  lifetimeMs: 30 * 60 * 1000,
  treeBytes: 24 * 1024 * 1024,
});

/** GitHub root URLs only; refs are separate, explicit inputs, never guessed. */
export function publicRepositoryName(input) {
  const value = String(input || '').trim();
  if (!value || value.length > 512 || sensitiveText(value)) throw new MigrationError('public-input');
  let name = value;
  if (/^https:/i.test(value)) {
    const url = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/?$/i.exec(value);
    if (!url) throw new MigrationError('public-input');
    name = `${url[1]}/${url[2].replace(/\.git$/i, '')}`;
  }
  const parts = name.split('/');
  if (parts.length !== 2 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(parts[0]) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) || ['.', '..'].includes(parts[1])) {
    throw new MigrationError('public-input');
  }
  return name;
}

export function publicDonorRef(type, input) {
  const name = String(input || '').trim();
  if (!['branch', 'tag', 'commit'].includes(type)) throw new MigrationError('public-input');
  if (type === 'commit') {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(name)) throw new MigrationError('public-input');
  } else if (refNameProblem(name) || sensitiveText(name)) throw new MigrationError('public-input');
  return { type, name };
}

/** Donor-only JSON support. The normal editable source extension set is unchanged. */
export function publicDonorAlias(input) {
  const alias = String(input || '');
  try {
    if (safeLabel(alias) !== alias || normalizeDirectoryAlias(alias) !== alias ||
        alias.split('/').some((part) => isSkippedDirectory(part)) ||
        !['.bicepparam', '.bicep', '.json'].includes(sourceExtension(alias))) {
      throw new MigrationError('public-scope');
    }
    return alias;
  } catch { throw new MigrationError('public-scope'); }
}

export function publicDonorFailure(error) {
  if (error instanceof MigrationError) return error;
  if (typeof error?.code === 'string' && error.code.startsWith('public-')) return new MigrationError(error.code);
  if (error?.status === 429) return new MigrationError('public-rate');
  if (error?.status === 404) return new MigrationError('public-not-found');
  if (error?.code === 'GITHUB_REDIRECT') return new MigrationError('public-redirect');
  if (['SOURCE_TOO_LARGE', 'UNSUPPORTED_BLOB', 'LFS_POINTER'].includes(error?.code)) return new MigrationError('public-scope');
  return new MigrationError('public-read');
}
