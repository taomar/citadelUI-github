/**
 * Git reference naming rules, owned in one place.
 *
 * ## Why this is shared and not server-only
 *
 * The rules used to live inside `server/github/repositories.mjs`, expressed as a
 * throw. That was correct while Citadel derived every branch name itself: the
 * only caller was the server, and the only possible answer was "the name Citadel
 * generated is fine".
 *
 * Letting a user type the name changes the question. A browser has to say *why*
 * a name is wrong, next to the field, before anything is submitted — and it
 * cannot import server code to find out. Duplicating the rules in the browser
 * would be worse: two copies of a policy drift, and the copy the user sees would
 * eventually disagree with the copy that decides.
 *
 * So the rule has one owner and two readers. The server keeps its own error
 * contract by wrapping the verdict; the browser reads the reason directly.
 *
 * The rules themselves are `git check-ref-format` for a branch, plus the
 * additional characters GitHub rejects in a ref path segment.
 */

export const MAX_REF_LENGTH = 255;

/**
 * Why this name is not a usable branch name, or null when it is.
 *
 * Each reason names the specific rule broken, because "invalid branch name" in
 * a form field tells the user to guess.
 */
export function refNameProblem(value) {
  const name = String(value ?? '').trim();
  if (!name) return 'Enter a branch name.';
  if (name.length > MAX_REF_LENGTH) {
    return `A branch name can be at most ${MAX_REF_LENGTH} characters.`;
  }
  if (/\s/.test(name)) return 'A branch name cannot contain spaces.';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A branch name cannot contain control characters.';
  if (name.includes('..')) return 'A branch name cannot contain "..".';
  if (name.includes('~')) return 'A branch name cannot contain "~".';
  if (name.includes('^')) return 'A branch name cannot contain "^".';
  if (name.includes(':')) return 'A branch name cannot contain ":".';
  if (name.includes('?')) return 'A branch name cannot contain "?".';
  if (name.includes('*')) return 'A branch name cannot contain "*".';
  if (name.includes('[')) return 'A branch name cannot contain "[".';
  if (name.includes('\\')) return 'A branch name cannot contain a backslash.';
  if (name.includes('@{')) return 'A branch name cannot contain "@{".';
  if (name === '@') return 'A branch name cannot be "@".';
  if (name.startsWith('/')) return 'A branch name cannot start with "/".';
  if (name.endsWith('/')) return 'A branch name cannot end with "/".';
  if (name.includes('//')) return 'A branch name cannot contain an empty path segment.';
  if (name.startsWith('-')) return 'A branch name cannot start with "-".';
  if (name.endsWith('.')) return 'A branch name cannot end with ".".';
  if (name.endsWith('.lock')) return 'A branch name cannot end with ".lock".';
  for (const part of name.split('/')) {
    if (!part) return 'A branch name cannot contain an empty path segment.';
    if (part.startsWith('.')) return 'No part of a branch name may start with ".".';
    if (part.endsWith('.lock')) return 'No part of a branch name may end with ".lock".';
  }
  return null;
}

/** Whether `value` is a usable branch name. */
export function isValidRefName(value) {
  return refNameProblem(value) === null;
}
