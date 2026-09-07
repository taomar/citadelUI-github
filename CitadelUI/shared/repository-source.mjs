import { refNameProblem } from './git-refs.mjs';

export const DEFAULT_REPOSITORY_SOURCE =
  'https://github.com/mohamedsaif/ai-hub-gateway-solution-accelerator/blob/citadel-v1/';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;

export function validateNewRepositoryName(value) {
  if (typeof value !== 'string') throw new Error('Enter a repository name.');
  const name = value.trim();
  if (!REPOSITORY.test(name) || /^\.+$/.test(name) || /\.git$/i.test(name)) {
    throw new Error('Use 1-100 letters, numbers, dots, hyphens or underscores for the repository name, without a .git suffix.');
  }
  return name;
}

/**
 * Parse the literal URL, before URL normalization can hide traversal. A tree
 * suffix is ONE ref, including slashes: never guess a branch/subdirectory split.
 * The unusual blob/<ref>/ form is accepted only with a trailing slash, as a
 * repository-root selector (the accelerator's published link uses this form).
 * Percent encoding is deliberately unsupported rather than decoded ambiguously.
 */
export function parseRepositorySource(value) {
  if (typeof value !== 'string') throw new Error('Enter a GitHub repository URL.');
  const raw = value.trim();
  if (raw.length > 1400 || /[%\\?#\s\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error('Use an unencoded GitHub repository URL without query, fragment or unsafe path characters.');
  }
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(\/.*)?$/.exec(raw);
  if (!match || !OWNER.test(match[1]) || !REPOSITORY.test(match[2]) ||
      /^\.+$/.test(match[2]) || /\.git$/i.test(match[2])) {
    throw new Error('Use https://github.com/owner/repository, optionally followed by /tree/ref.');
  }
  const fullName = `${match[1]}/${match[2]}`;
  const suffix = match[3] || '';
  if (!suffix || suffix === '/') return { fullName, ref: null, url: `https://github.com/${fullName}` };
  const selector = /^\/(tree|blob)\/(.+?)(\/?)$/.exec(suffix);
  if (!selector || (selector[1] === 'blob' && selector[3] !== '/')) {
    throw new Error('Select a repository root or a complete /tree/ref, not a file or subdirectory.');
  }
  const ref = selector[2];
  if (refNameProblem(ref) || /[<>"`{}]/.test(ref)) {
    throw new Error('The source URL contains an invalid Git ref.');
  }
  return { fullName, ref, url: `https://github.com/${fullName}/tree/${ref}` };
}
