import { MigrationError } from './migration-input.mjs';

export const MIGRATION_SOURCE_HEADER = 'X-Citadel-Migration-Source';
export const MIGRATION_ATTEMPT_HEADER = 'X-Citadel-Migration-Attempt';
export const MIGRATION_SOURCE_ENDPOINT = '/api/github/migration-source';

export function privateDonorFailure(error) {
  if (error instanceof MigrationError && error.code.startsWith('private-')) return error;
  if (typeof error?.code === 'string' && error.code.startsWith('private-')) return new MigrationError(error.code);
  const codes = {
    GITHUB_TOKEN_REQUIRED: 'private-auth-required',
    GITHUB_TOKEN_INVALID: 'private-auth-invalid',
    GITHUB_TOKEN_CLASSIC: 'private-auth-classic',
    GITHUB_SESSION_REQUIRED: 'private-auth-required',
    GITHUB_SESSION_EXPIRED: 'private-auth-expired',
    GITHUB_LOGIN_THROTTLED: 'private-rate',
    GITHUB_SESSION_LIMIT: 'private-rate',
    'public-input': 'private-input',
    'public-stale': 'private-stale',
    'public-expired': 'private-expired',
    'public-rate': 'private-rate',
    'public-not-found': 'private-access',
    'public-scope': 'private-scope',
    'public-tree': 'private-scope',
    'public-format': 'private-scope',
    'public-read-only': 'private-read-only',
  };
  return new MigrationError(codes[error?.code] ||
    (error?.status === 401 ? 'private-auth-invalid'
      : error?.status === 403 || error?.status === 404 ? 'private-access'
        : error?.status === 429 ? 'private-rate' : 'private-read'));
}
