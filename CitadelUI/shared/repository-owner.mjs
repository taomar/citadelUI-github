import { isGitHubLogin } from './github-login.mjs';

export function repositoryOwner(value) {
  if (!value || !['User', 'Organization'].includes(value.type) ||
      !Number.isSafeInteger(value.id) || value.id <= 0 || !isGitHubLogin(value.login)) {
    throw new Error('Choose a valid Personal or Organization repository owner.');
  }
  return { type: value.type, id: value.id, login: value.login };
}

export function repositoryOwnerKey(owner) {
  const value = repositoryOwner(owner);
  return `${value.type}:${value.id}`;
}

export function repositoryOwnerLabel(owner) {
  const value = repositoryOwner(owner);
  return `${value.type === 'Organization' ? 'Organization' : 'Personal'} @${value.login}`;
}

export function sameRepositoryOwner(left, right) {
  return left.type === right.type && left.id === right.id &&
    left.login.toLowerCase() === right.login.toLowerCase();
}
