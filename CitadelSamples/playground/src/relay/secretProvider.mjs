/**
 * Logical secret resolution for the relay.
 *
 * The relay never accepts a caller-selected vault or secret name — only a
 * logical ref such as `gatewayAccess.apiKey`, the same name the catalogue
 * already uses for `secretRef(...)`. Each provider implementation maps that
 * ref to a concrete location ENTIRELY on the server side; an unknown ref
 * resolves to `null` rather than guessing.
 *
 * A resolved value is handed directly to the HTTP step that needs it and
 * registered with the run's redactor. It is never placed in a response body,
 * a log line, or an error message.
 *
 * The production (`createKeyVaultSecretProvider`) path bounds and cancels
 * both external calls it makes: the managed-identity token request (see
 * `managedIdentity.mjs`, which carries its own internal timeout regardless
 * of this module) and the Key Vault fetch itself, which this module bounds
 * directly — across BOTH the network request and the response body being
 * parsed as JSON, not just until the response headers arrive. `resolve`
 * accepts an optional `signal` — typically the relay's own per-run deadline
 * — so neither call can hang past that budget; unlike `managedIdentity.mjs`'s
 * shared, cached token request, the Key Vault fetch here is never shared
 * across callers, so it is safe to abort it directly when that signal
 * fires, with no risk of affecting a concurrent resolve() for a different
 * ref.
 */

import { createManagedIdentityTokenProvider } from './managedIdentity.mjs';
import { raceAbortSignal } from './deadline.mjs';

const KEY_VAULT_RESOURCE = 'https://vault.azure.net';
const DEFAULT_API_VERSION = '7.4';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Development/test provider: a fixed in-memory map of ref -> value. */
export function createInMemorySecretProvider(values = {}) {
  return Object.freeze({
    mode: 'in-memory',
    async resolve(ref) {
      const value = values[ref];
      return typeof value === 'string' && value.length > 0 ? value : null;
    },
  });
}

/**
 * Combine an operation's own timeout with an optional externally-supplied
 * deadline `signal` into one `AbortSignal`, for a call that is safe to
 * abort directly (nothing else shares it). Always returns a `dispose()` to
 * release the timer/listener once the operation has settled.
 */
function boundedSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * Production provider: managed identity + Key Vault.
 *
 * @param {object} options
 * @param {Record<string,{vaultUrl:string, secretName:string}>} options.mappings
 *   Logical ref -> vault location. Fixed at construction time by the
 *   operator; never derived from a request.
 * @param {string} [options.resource]     AAD resource for the KV token (default: KV)
 * @param {string} [options.apiVersion]
 * @param {Function} [options.fetchImpl]  injected for tests
 * @param {object} [options.tokenProvider] injected for tests, bypasses IMDS
 * @param {string} [options.clientId] user-assigned managed identity client id
 * @param {number} [options.requestTimeoutMs]  bounds the Key Vault fetch itself
 *        (default 10s), independent of any caller-supplied `resolve` signal.
 */
export function createKeyVaultSecretProvider({
  mappings,
  resource = KEY_VAULT_RESOURCE,
  apiVersion = DEFAULT_API_VERSION,
  fetchImpl,
  tokenProvider,
  clientId,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    throw new TypeError('createKeyVaultSecretProvider requires a `mappings` object.');
  }
  const provider = tokenProvider ?? createManagedIdentityTokenProvider({ resource, clientId, fetchImpl });
  const doFetch = fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch) {
    throw new TypeError('createKeyVaultSecretProvider requires a fetch implementation.');
  }
  return Object.freeze({
    mode: 'managed-identity-key-vault',
    /**
     * @param {string} ref
     * @param {object} [options]
     * @param {AbortSignal} [options.signal]  optional caller deadline (e.g.
     *        the relay's own per-run budget), bounding both the token
     *        request and the Key Vault fetch this call makes.
     */
    async resolve(ref, { signal } = {}) {
      const mapping = mappings[ref];
      // An unknown ref is refused, never guessed at from caller input: the
      // caller supplies only the ref NAME, never a vault URL or secret name.
      if (!mapping || typeof mapping.vaultUrl !== 'string' || typeof mapping.secretName !== 'string') return null;
      const token = await provider.getToken({ signal });
      const url = `${mapping.vaultUrl.replace(/\/+$/, '')}/secrets/${encodeURIComponent(mapping.secretName)}?api-version=${apiVersion}`;
      const bound = boundedSignal(requestTimeoutMs, signal);
      try {
        const response = await raceAbortSignal(
          doFetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: bound.signal }),
          bound.signal,
        );
        if (!response.ok) return null;
        // Raced independently of whether `response.json()` itself honors
        // `bound.signal` — a body-reading implementation (real, or in tests
        // a fake) that ignores the signal entirely must still not be able
        // to hold this call open past its bound.
        const payload = await raceAbortSignal(response.json(), bound.signal);
        return typeof payload.value === 'string' && payload.value.length > 0 ? payload.value : null;
      } finally {
        bound.dispose();
      }
    },
  });
}
