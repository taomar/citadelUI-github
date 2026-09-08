/**
 * Browser side of saved GitHub connections.
 *
 * These calls manage credentials rather than use one, so none of them carries
 * the opaque GitHub session header: a browser that has lost its session id must
 * still be able to list its connections and ask the server to resume one.
 *
 * What crosses this boundary in each direction:
 *
 *   out — a friendly name, a token the user just typed (once, on create or
 *         reconnect), and a boolean for the persistence checkbox.
 *   in  — profile metadata, a status word, and, only for calls that establish a
 *         session, an opaque session id.
 *
 * A token is never returned, never stored here, and never held by any caller
 * after the request that carried it.
 */
import { localRequest } from './local-api.mjs';

/** The status words the server issues, and the words the catalogue shows. */
export const CONNECTION_STATUS_LABELS = Object.freeze({
  persistent: 'Persistent · encrypted',
  'persistent-idle': 'Saved · encrypted',
  session: 'Session only',
  reconnect: 'Reconnect',
  unavailable: 'Unavailable',
});

export function connectionStatusLabel(status) {
  return CONNECTION_STATUS_LABELS[status] || 'Reconnect';
}

export const CONNECTION_PERSISTENCE_LABEL = 'Save this connection on the Citadel server (encrypted)';

export function connectionStorageDescription({ available, persist = false, saved = false } = {}) {
  if (persist) return saved
    ? 'The credential is saved encrypted on this Citadel server and can be restored after a restart.'
    : 'The credential will be saved encrypted on this Citadel server so the connection can be restored after a restart.';
  const session = 'Session only: the credential stays in server memory and is cleared on restart or disconnect.';
  if (available == null) return `${session} Encrypted persistence is disabled until storage availability is confirmed.`;
  return available ? session
    : `${session} Encrypted persistence is unavailable because no usable credential key is configured on this server.`;
}

/** A connection whose credential the server can use right now. */
export function isConnectionLive(profile) {
  return profile?.status === 'persistent' || profile?.status === 'session';
}

/** A connection the server can bring back with no user interaction. */
export function isConnectionResumable(profile) {
  return profile?.status === 'persistent-idle';
}

export async function listConnections() {
  return localRequest('/api/github/connections');
}

/**
 * Create a named connection.
 *
 * The name is required and is sent with the token in one request, because the
 * server refuses to mint a profile it cannot name — a nameless connection would
 * be indistinguishable from every other one in the catalogue.
 */
export async function createConnection({ name, token, persist = false }) {
  return localRequest('/api/github/connections', {
    method: 'POST',
    body: JSON.stringify({ name, token, persist: Boolean(persist) }),
  });
}

export async function reconnectConnection(profileId, { token, persist }) {
  return localRequest(`/api/github/connections/${encodeURIComponent(profileId)}/reconnect`, {
    method: 'POST',
    body: JSON.stringify(persist === undefined ? { token } : { token, persist: Boolean(persist) }),
  });
}

/**
 * Ask the server to restore a saved connection from its encrypted envelope.
 *
 * This is the whole payoff of the checkbox: no token, no dialog, no user step.
 * The browser receives an opaque session id and never learns the credential.
 */
export async function resumeConnection(profileId) {
  return localRequest(`/api/github/connections/${encodeURIComponent(profileId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Erase one specific credential session by its opaque id.
 *
 * Used to revoke a credential the browser has stopped tracking — a superseded
 * attempt, or one displaced by a switch to another connection. Addressing the
 * session rather than the profile matters: the profile may legitimately have a
 * newer live session that must survive.
 */
export async function revokeGitHubSession(sessionId) {
  return localRequest(`/api/github/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

export async function renameConnection(profileId, name) {
  return localRequest(`/api/github/connections/${encodeURIComponent(profileId)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function setConnectionPersistence(profileId, persist) {
  return localRequest(`/api/github/connections/${encodeURIComponent(profileId)}/persistence`, {
    method: 'POST',
    body: JSON.stringify({ persist: Boolean(persist) }),
  });
}

export async function disconnectConnection(profileId) {
  return localRequest(`/api/github/connections/${encodeURIComponent(profileId)}/disconnect`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function removeConnection(profileId) {
  return localRequest(`/api/github/connections/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  });
}
