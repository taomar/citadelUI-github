/**
 * Managed-identity token acquisition.
 *
 * Zero-dependency by construction: this talks directly to the managed-identity
 * endpoint exposed by the current Azure host over plain `fetch`, rather than
 * pulling in an Azure SDK package. Container Apps injects a local endpoint and
 * request header; local/VM contexts fall back to the fixed Azure Instance
 * Metadata Service endpoint. The playground has no runtime dependencies and
 * this must not be the exception.
 *
 * Used for two distinct hops, each with its own `resource` (AAD audience):
 *   - the local proxy authenticating itself TO the relay
 *   - the relay authenticating itself TO Key Vault, to resolve a secret
 *
 * Never logs a token. Callers must treat the returned string as a bearer
 * credential: put it straight into an `Authorization` header and nowhere
 * else (no evidence, no `console.log`, no error message).
 *
 * Bounded and cancellable, on two independent axes:
 *   - the identity request itself always carries its OWN internal timeout
 *     (`requestTimeoutMs`), regardless of whether any caller ever passes a
 *     signal — an unreachable/hanging metadata endpoint must not be able to
 *     hang a caller (or this whole process) forever.
 *   - a caller may additionally pass its own `signal` (typically the
 *     relay's own per-run deadline) to `getToken({ signal })`. Concurrent
 *     callers collapse onto a single shared, in-flight identity request (see
 *     `inFlight` below); one caller's own signal firing must only make
 *     THAT caller stop waiting — it must never abort the shared underlying
 *     fetch out from under every OTHER concurrent caller, and must never
 *     poison the token cache for the next call. `raceAbortSignal` below
 *     achieves this by racing the caller's own abort against the shared
 *     promise without ever touching the promise itself.
 *
 * The request's own internal `requestTimeoutMs` bound spans the ENTIRE
 * request — the network fetch AND the response body being parsed as JSON
 * — not just until the response headers arrive. Both phases are raced
 * against the same internal controller independently of the fetch/response
 * implementation's own cooperation: a `fetchImpl` (real, or a test double)
 * that ignores its `signal` argument entirely, or a response whose
 * `.json()` hangs indefinitely, must still not be able to hold this request
 * open past `requestTimeoutMs`.
 */

import { isIP } from 'node:net';
import { raceAbortSignal } from './deadline.mjs';

const DEFAULT_IMDS_ENDPOINT = 'http://169.254.169.254/metadata/identity/oauth2/token';
const DEFAULT_API_VERSION = '2019-08-01';
const DEFAULT_CLOCK_SKEW_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const CONTAINER_APPS_ENDPOINT_ENV = 'IDENTITY_ENDPOINT';
const CONTAINER_APPS_HEADER_ENV = 'IDENTITY_HEADER';

function hasOwn(environment, name) {
  return Object.prototype.hasOwnProperty.call(environment, name);
}

function isDefaultContainerAppsEndpoint(url) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = isIP(hostname);
  const loopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    (ipVersion === 4 && hostname.startsWith('127.'));
  const tokenPath = url.pathname.toLowerCase();
  return (
    url.protocol === 'http:' &&
    loopback &&
    (tokenPath === '/msi/token' || tokenPath === '/msi/token/') &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
  );
}

function containerAppsIdentity(environment, identityEndpointValidator) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('createManagedIdentityTokenProvider requires an environment object.');
  }
  const hasEndpoint = hasOwn(environment, CONTAINER_APPS_ENDPOINT_ENV);
  const hasHeader = hasOwn(environment, CONTAINER_APPS_HEADER_ENV);
  if (!hasEndpoint && !hasHeader) return null;
  if (!hasEndpoint || !hasHeader) {
    throw new TypeError('IDENTITY_ENDPOINT and IDENTITY_HEADER must be configured together.');
  }

  const endpoint = environment[CONTAINER_APPS_ENDPOINT_ENV];
  const header = environment[CONTAINER_APPS_HEADER_ENV];
  if (typeof endpoint !== 'string' || endpoint.trim() === '' || endpoint.trim() !== endpoint) {
    throw new TypeError('IDENTITY_ENDPOINT must be a non-empty absolute URL without surrounding whitespace.');
  }
  if (
    typeof header !== 'string' ||
    header.trim() === '' ||
    header.trim() !== header ||
    /[\u0000-\u001f\u007f]/.test(header)
  ) {
    throw new TypeError('IDENTITY_HEADER must be a non-empty HTTP header value.');
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError('IDENTITY_ENDPOINT must be a valid absolute URL.');
  }
  if (!identityEndpointValidator(url)) {
    throw new TypeError(
      'IDENTITY_ENDPOINT must be an unadorned HTTP loopback /msi/token URL supplied by Container Apps.',
    );
  }
  return Object.freeze({ endpoint: url.toString(), header });
}

/**
 * @param {object} options
 * @param {string} options.resource        AAD resource/audience the token is for
 * @param {string} [options.clientId]       user-assigned managed identity client id
 * @param {object} [options.environment]    server-owned environment; Container
 *        Apps injects IDENTITY_ENDPOINT and IDENTITY_HEADER into this object
 * @param {Function} [options.identityEndpointValidator] code-level override for
 *        a future platform-local endpoint shape; the secure default accepts
 *        localhost, IPv4 127/8, or ::1 with /msi/token
 * @param {string} [options.apiVersion]
 * @param {Function} [options.fetchImpl]    injected for tests
 * @param {Function} [options.now]          injected for tests
 * @param {number} [options.clockSkewMs]
 * @param {number} [options.requestTimeoutMs]  bounds the identity request itself
 *        (default 10s), independent of any caller-supplied `getToken`
 *        signal — a hanging metadata endpoint must be bounded even for the
 *        very first caller, who has nothing else to race against.
 */
export function createManagedIdentityTokenProvider({
  resource,
  clientId,
  environment = process.env,
  identityEndpointValidator = isDefaultContainerAppsEndpoint,
  apiVersion = DEFAULT_API_VERSION,
  fetchImpl,
  now = () => Date.now(),
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof resource !== 'string' || resource.trim() === '') {
    throw new TypeError('createManagedIdentityTokenProvider requires a `resource` (the AAD audience).');
  }
  if (clientId !== undefined && (typeof clientId !== 'string' || clientId.trim() === '')) {
    throw new TypeError('createManagedIdentityTokenProvider requires `clientId` to be a non-empty string when configured.');
  }
  if (typeof identityEndpointValidator !== 'function') {
    throw new TypeError('createManagedIdentityTokenProvider requires `identityEndpointValidator` to be a function.');
  }
  const doFetch = fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch) {
    throw new TypeError('createManagedIdentityTokenProvider requires a fetch implementation.');
  }
  const containerApps = containerAppsIdentity(environment, identityEndpointValidator);
  const endpoint = containerApps?.endpoint ?? DEFAULT_IMDS_ENDPOINT;
  const mode = containerApps ? 'container-apps' : 'imds';
  let cached = null; // { token, expiresAtMs }
  let inFlight = null;

  async function requestToken() {
    const url = new URL(endpoint);
    url.searchParams.set('api-version', apiVersion);
    url.searchParams.set('resource', resource);
    if (clientId) url.searchParams.set('client_id', clientId);
    // This bound is intentionally NOT tied to any individual caller's own
    // signal: this request is shared (via `inFlight` below) across every
    // concurrent `getToken` call, so it must run to its own completion (or
    // its own timeout) regardless of whether the caller who happened to
    // start it is still waiting. It stays armed across BOTH the fetch and
    // the body parse below — `clearTimeout` only runs once both are done.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let payload;
    try {
      let response;
      try {
        response = await raceAbortSignal(
          doFetch(url.toString(), {
            method: 'GET',
            headers: containerApps
              ? { 'X-IDENTITY-HEADER': containerApps.header }
              : { Metadata: 'true' },
            redirect: 'error',
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (error) {
        throw error?.name === 'AbortError'
          ? new Error(`Managed identity token request timed out after ${Math.round(requestTimeoutMs / 1000)}s.`)
          : error;
      }
      if (!response.ok) {
        throw new Error(`Managed identity token request failed with HTTP ${response.status}.`);
      }
      try {
        // Raced independently of whether `response.json()` itself honors
        // `controller.signal` — a body-reading implementation (real, or in
        // tests a fake) that ignores the signal entirely must still not be
        // able to hold this request open past `requestTimeoutMs`.
        payload = await raceAbortSignal(response.json(), controller.signal);
      } catch (error) {
        throw error?.name === 'AbortError'
          ? new Error(`Managed identity token request timed out after ${Math.round(requestTimeoutMs / 1000)}s.`)
          : error;
      }
    } finally {
      clearTimeout(timer);
    }
    if (typeof payload.access_token !== 'string' || payload.access_token === '') {
      throw new Error('The managed identity endpoint returned no access token.');
    }
    const expiresOnSeconds = Number(payload.expires_on);
    const expiresAtMs = expiresOnSeconds * 1000;
    if (!Number.isFinite(expiresOnSeconds) || expiresAtMs - clockSkewMs <= now()) {
      throw new Error('The managed identity endpoint returned an invalid or expired token expiration.');
    }
    return { token: payload.access_token, expiresAtMs };
  }

  return Object.freeze({
    mode,
    resource,
    /**
     * @param {object} [options]
     * @param {AbortSignal} [options.signal]  optional caller deadline (e.g.
     *        the relay's own per-run budget). Firing this signal only makes
     *        THIS call stop waiting and reject — it never aborts a shared
     *        in-flight identity request out from under another concurrent
     *        caller, and never marks the eventual (successful or failed)
     *        result as anything other than what the identity endpoint returned.
     */
    async getToken({ signal } = {}) {
      if (cached && cached.expiresAtMs - clockSkewMs > now()) return cached.token;
      // Collapse concurrent callers onto one in-flight token request rather
      // than hammering the identity endpoint once per parallel step.
      if (!inFlight) {
        inFlight = requestToken()
          .then((result) => {
            cached = result;
            return result.token;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return raceAbortSignal(inFlight, signal);
    },
    /** For tests/observability only: never the token itself. */
    get cachedExpiryMs() {
      return cached?.expiresAtMs ?? null;
    },
  });
}
