/**
 * Browser side of the workspace activity log.
 *
 * Recording is fire-and-forget by construction: `note()` never rejects and never
 * returns a value a caller could branch on. Governance is a record of what
 * happened, and a record that can fail the thing it describes is worse than no
 * record — a user must not lose a workspace because a log write failed.
 *
 * The payload is a closed shape. There is no free-text field on this side
 * either, so nothing a caller happens to be holding — a path, a parameter, an
 * error string — has anywhere to travel.
 */
import { localRequest } from './local-api.mjs';

export const ACTIVITY_LABELS = Object.freeze({
  'connection.create': 'Connection created',
  'connection.rename': 'Connection renamed',
  'connection.reconnect': 'Connection reconnected',
  'connection.restore': 'Connection restored',
  'connection.disconnect': 'Connection disconnected',
  'connection.persistence-enabled': 'Encrypted persistence enabled',
  'connection.persistence-disabled': 'Encrypted persistence disabled',
  'connection.remove': 'Connection removed',
  'repository.validate': 'Repository validated',
  'repository.attach': 'Repository attached',
  'repository.detach': 'Workspace detached',
  'environment.open': 'Workspace opened',
  'validation.failure': 'Validation failed',
});

export const ACTIVITY_REASON_LABELS = Object.freeze({
  'account-mismatch': 'the token belonged to a different account',
  'already-attached': 'it was already attached',
  'compatibility-failed': 'the branch failed validation',
  'credential-expired': 'the saved credential was rejected',
  'credential-unavailable': 'the saved credential could not be opened',
  'duplicate-name': 'that name is already used',
  'not-a-citadel-repository': 'it is not a Citadel repository',
  'permission-denied': 'permission was denied',
  'persistence-unavailable': 'encrypted storage is unavailable',
  'rate-limited': 'GitHub rate-limited the request',
  'repository-renamed': 'the repository was renamed',
  unreachable: 'GitHub could not be reached',
});

export function activityLabel(action) {
  return ACTIVITY_LABELS[action] || action;
}

export function activityReason(reason) {
  return reason ? ACTIVITY_REASON_LABELS[reason] || null : null;
}

export async function listActivity(limit = 25) {
  const result = await localRequest(`/api/activity?limit=${encodeURIComponent(limit)}`);
  return Array.isArray(result?.events) ? result.events : [];
}

/** Append one event. Deliberately swallows every failure. */
export function note({ action, outcome = 'ok', reason = null, target = null, account = null }) {
  const body = { action, outcome };
  if (reason) body.reason = reason;
  if (target) body.target = target;
  if (account) body.account = account;
  localRequest('/api/activity', { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
}
