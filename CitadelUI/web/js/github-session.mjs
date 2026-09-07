import { localRequest } from './local-api.mjs';

/**
 * Browser side of the GitHub credential session.
 *
 * The browser holds one thing: an opaque, server-issued session id. The token
 * itself is sent once over the existing protected loopback session and is never
 * written to `sessionStorage`, `localStorage`, IndexedDB, a cookie, or a URL.
 *
 * `sessionStorage` is used deliberately so the id dies with the tab and cannot
 * outlive the browsing session.
 */
const STORAGE_KEY = 'citadel-ui.github-session';
const SESSION_HEADER = 'X-Citadel-GitHub-Session';

function storage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

export function githubSessionId() {
  return storage()?.getItem(STORAGE_KEY) || null;
}

/**
 * Forget the browser's opaque id without contacting the server.
 *
 * Exported so a caller that has just revoked a specific session can drop the id
 * that pointed at it. Forgetting without revoking would leave a live credential
 * on the server that nothing can address.
 */
export function forgetGitHubSession() {
  forgetSessionId();
}

function assertUsableSessionId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) {
    throw new Error('GitHub returned an unusable session identifier.');
  }
  return id;
}

function retainSessionId(id) {
  storage()?.setItem(STORAGE_KEY, assertUsableSessionId(id));
}

function forgetSessionId() {
  storage()?.removeItem(STORAGE_KEY);
}

/** Same-origin request carrying the opaque GitHub session id. */
export async function githubRequest(path, options = {}) {
  const id = githubSessionId();
  return localRequest(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(id ? { [SESSION_HEADER]: id } : {}),
    },
  });
}

/**
 * Exchange a fine-grained personal access token for an opaque session id.
 *
 * The token is passed straight to the server and is not retained by any caller
 * on this side of the boundary.
 *
 * The returned account carries the id it was issued, so a caller can bind its
 * later requests to *that* session rather than to whatever is current. Two
 * panels connecting at once would otherwise both write here and each read back
 * the other's credential.
 */
export async function connectGitHub(token) {
  const result = await localRequest('/api/github/sessions', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  const { id, ...account } = result;
  assertUsableSessionId(id);
  account.sessionId = id;
  // A superseded connection can revoke its own session, so a credential the
  // browser has stopped tracking never stays live on the server.
  account.revoke = async () => {
    if (githubSessionId() === id) forgetSessionId();
    await localRequest(`/api/github/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  };
  return account;
}

/** Adopt a session as the browser's active credential. */
export function adoptGitHubSession(id) {
  retainSessionId(id);
}

/**
 * Disconnect and erase the credential.
 *
 * The opaque id is retained until the server confirms the credential is gone or
 * was already absent. Forgetting it first would leave a live server session that
 * the browser can no longer address or erase, and would let the UI claim the
 * token was erased when it was not.
 */
export async function disconnectGitHub() {
  const id = githubSessionId();
  if (!id) return { disconnected: false, erased: true };
  let result;
  try {
    result = await localRequest(`/api/github/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch (error) {
    if (error?.status === 401 || error?.code === 'GITHUB_SESSION_EXPIRED') {
      // Already gone server-side; dropping the id is correct and honest.
      forgetSessionId();
      return { disconnected: false, erased: true, alreadyAbsent: true };
    }
    throw Object.assign(
      new Error(
        `GitHub was not disconnected: ${error.message} The credential may still be active; retry Disconnect.`
      ),
      { code: error?.code || 'GITHUB_DISCONNECT_FAILED', status: error?.status, retryable: true }
    );
  }
  forgetSessionId();
  return { ...result, erased: true };
}

export async function githubStatus() {
  if (!githubSessionId()) return { connected: false };
  const status = await githubRequest('/api/github/sessions');
  if (!status.connected) forgetSessionId();
  return status;
}

export async function listGitHubRepositories() {
  return githubRequest('/api/github/repos');
}

export async function getGitHubRepository(repositoryId) {
  return githubRequest(`/api/github/repos/${encodeURIComponent(repositoryId)}`);
}

export async function prepareGitHubRepository(payload) {
  return githubRequest('/api/github/repository-creations', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function listGitHubRepositoryCreations() {
  return githubRequest('/api/github/repository-creations');
}

export async function gitHubRepositoryCreationStatus(id) {
  return githubRequest(`/api/github/repository-creations/${encodeURIComponent(id)}`);
}

function repositoryCreationAction(id, action) {
  return githubRequest(`/api/github/repository-creations/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export const startGitHubRepositoryCreation = (id) => repositoryCreationAction(id, 'start');
export const resumeGitHubRepositoryCreation = (id) => repositoryCreationAction(id, 'resume');
export const pauseGitHubRepositoryCreation = (id) => repositoryCreationAction(id, 'pause');

export async function listGitHubBranches(repositoryId) {
  return githubRequest(`/api/github/repos/${encodeURIComponent(repositoryId)}/branches`);
}

/**
 * Read-only Citadel structure check for one repository and branch.
 *
 * Advisory only: it decides whether Attach may be offered. Attachment re-runs
 * the same check server-side against the head it is about to branch from, so a
 * stale or skipped result cannot create anything.
 */
export async function checkGitHubCompatibility(repositoryId, branch) {
  return githubRequest(
    `/api/github/repos/${encodeURIComponent(repositoryId)}/compatibility?branch=${encodeURIComponent(branch)}`
  );
}

export async function attachGitHubRepository(payload) {
  return githubRequest('/api/github/attachments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function attachGitHubStatus(payload) {
  return githubRequest('/api/github/attachments/status', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function abandonGitHubAttachment(payload) {
  return githubRequest('/api/github/attachments/abandon', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
export function isSessionError(error) {
  return error?.code === 'GITHUB_SESSION_REQUIRED' || error?.code === 'GITHUB_SESSION_EXPIRED';
}
