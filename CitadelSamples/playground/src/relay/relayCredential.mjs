/**
 * Local-proxy → relay authentication.
 *
 * The credential the local server presents to the relay when forwarding an
 * `/api/execute` request. Two implementations:
 *
 *   - `createStaticTokenCredentialProvider`   a fixed shared secret. Kept for
 *     development and for a relay that has not been wired to managed
 *     identity yet. Never the production default.
 *   - `createManagedIdentityCredentialProvider`   the production path. The
 *     local proxy acquires a short-lived AAD token for the relay's own
 *     resource/audience and presents that instead of a long-lived static
 *     secret.
 *
 * Both expose the same shape, `{ mode, getAuthorizationHeader({ signal }) }`, so
 * `server.mjs` never has to know which one it was given.
 */

import { createManagedIdentityTokenProvider } from './managedIdentity.mjs';

export function createStaticTokenCredentialProvider({ token }) {
  if (typeof token !== 'string' || token === '') {
    throw new TypeError('createStaticTokenCredentialProvider requires a non-empty token.');
  }
  return Object.freeze({
    mode: 'static-token',
    async getAuthorizationHeader() {
      return `Bearer ${token}`;
    },
  });
}

/**
 * @param {object} options
 * @param {string} options.resource   the relay's AAD resource/audience
 * @param {string} [options.clientId]
 * @param {object} [options.environment] server-owned managed-identity environment
 * @param {Function} [options.identityEndpointValidator] code-level endpoint policy override
 * @param {Function} [options.fetchImpl]
 * @param {object} [options.tokenProvider]  injected for tests, bypasses identity acquisition
 */
export function createManagedIdentityCredentialProvider({
  resource,
  clientId,
  environment,
  identityEndpointValidator,
  fetchImpl,
  tokenProvider,
} = {}) {
  const provider =
    tokenProvider ??
    createManagedIdentityTokenProvider({
      resource,
      clientId,
      environment,
      identityEndpointValidator,
      fetchImpl,
    });
  return Object.freeze({
    mode: 'managed-identity',
    async getAuthorizationHeader({ signal } = {}) {
      return `Bearer ${await provider.getToken({ signal })}`;
    },
  });
}
