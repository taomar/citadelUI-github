// Enterprise Managed Users include an underscore suffix in GitHub.com logins.
export function isGitHubLogin(value) {
  return typeof value === 'string' && value.length <= 39 &&
    /^[A-Za-z0-9][A-Za-z0-9-]*(?:_[A-Za-z0-9]+)?$/.test(value);
}
