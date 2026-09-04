/**
 * Principal authentication for a non-loopback caller.
 *
 * Loopback callers of `/api/execute` remain implicitly trusted, exactly like
 * `/api/run` — the same machine, the same user, the same trust boundary the
 * rest of this server already relies on. The moment the server is bound to a
 * non-loopback host, that assumption is gone, so every `/api/execute` call
 * from there must present a verified principal. Nothing here fails open: a
 * non-loopback server with nothing configured refuses every call.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * The server-owned identity a loopback bind is implicitly given. Loopback
 * trust is a LOCAL DEVELOPMENT convenience — the same machine, the same
 * user — never a hosted/public posture; but even so, everything downstream
 * (the tenant policy resolver, acknowledgement binding) now requires a real,
 * non-empty `principal` and `tenant`, so a loopback bind is given fixed,
 * well-known, non-null values rather than `null`/`undefined` placeholders
 * that would otherwise have to be special-cased everywhere else.
 */
export const LOOPBACK_DEV_TENANT = 'local-development';
export const LOOPBACK_DEV_PRINCIPAL = 'loopback-operator';
export const LOOPBACK_DEV_ROLES = Object.freeze(['loopback-operator']);

/** Fixed shared-secret credential. Development, or a relay not yet wired to a real identity provider. */
export function createSharedSecretAuthenticator({
  token,
  headerName = 'authorization',
  tenant = 'default-tenant',
  principal = 'configured-caller',
  roles = [],
} = {}) {
  if (typeof token !== 'string' || token === '') {
    throw new TypeError('createSharedSecretAuthenticator requires a non-empty token.');
  }
  if (typeof tenant !== 'string' || tenant === '') {
    throw new TypeError('createSharedSecretAuthenticator requires a non-empty tenant.');
  }
  if (typeof principal !== 'string' || principal === '') {
    throw new TypeError('createSharedSecretAuthenticator requires a non-empty principal.');
  }
  const expected = Buffer.from(token, 'utf-8');
  return Object.freeze({
    mode: 'shared-secret',
    async authenticate(request) {
      const header = String(request.headers?.[headerName] ?? '');
      const match = header.match(/^Bearer\s+(.+)$/i);
      if (!match) return { ok: false, reason: 'missing-or-malformed-authorization-header' };
      const presented = Buffer.from(match[1], 'utf-8');
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return { ok: false, reason: 'invalid-credential' };
      }
      return { ok: true, principal, tenant, roles: [...roles] };
    },
  });
}

/**
 * Wraps an operator-supplied verifier for a bearer token minted by a real
 * identity provider (e.g. one that checks an AAD access token's signature
 * against the tenant's JWKS and reads its tenant/roles claims). There is no
 * bundled JWT/JWKS implementation here: the playground ships no
 * dependencies, and a hand-rolled signature check would be a worse trap than
 * an explicit gap. A deployment that wants managed-identity-authenticated
 * callers on this hop must inject a real `verify` function; without one this
 * constructor refuses to build, rather than quietly accepting unverified
 * tokens.
 *
 * `verify` MUST resolve `tenant` (and should resolve `roles`, when the
 * identity provider carries them) from the token's own verified claims —
 * never from anything the caller can otherwise influence. `authenticatePrincipal`
 * refuses any `{ ok: true, ... }` result that omits a non-empty `principal`
 * or `tenant`, so a `verify` that forgets to resolve one fails closed rather
 * than silently authorizing a caller with no tenant binding.
 *
 * @param {(token: string) => Promise<{ok:boolean, principal?:string, tenant?:string, roles?:string[], reason?:string}>} verify
 */
export function createTokenAuthenticator({ verify, headerName = 'authorization' } = {}) {
  if (typeof verify !== 'function') {
    throw new TypeError(
      'createTokenAuthenticator requires a `verify(token)` function that checks the token against a real identity provider.',
    );
  }
  return Object.freeze({
    mode: 'verified-token',
    async authenticate(request) {
      const header = String(request.headers?.[headerName] ?? '');
      const match = header.match(/^Bearer\s+(.+)$/i);
      if (!match) return { ok: false, reason: 'missing-or-malformed-authorization-header' };
      return verify(match[1]);
    },
  });
}

/** The default posture for a non-loopback bind with nothing configured: refuse, never fail open. */
export function createDenyAllAuthenticator(reason = 'No authenticator is configured for this non-loopback server.') {
  return Object.freeze({
    mode: 'deny-all',
    async authenticate() {
      return { ok: false, reason };
    },
  });
}

/**
 * Trust the identity header emitted by Container Apps' Entra authentication
 * middleware. This is deliberately opt-in: callers must place the app behind
 * that middleware, which is enforced by the accompanying deployment Bicep.
 * It is not a replacement for validating a bearer token at an arbitrary HTTP
 * listener.
 */
export function createContainerAppsEntraAuthenticator({ tenantId } = {}) {
  if (typeof tenantId !== 'string' || tenantId === '') {
    throw new TypeError('createContainerAppsEntraAuthenticator requires a non-empty tenantId.');
  }
  return Object.freeze({
    mode: 'container-apps-entra',
    async authenticate(request) {
      const encoded = request.headers?.['x-ms-client-principal'];
      if (typeof encoded !== 'string' || encoded === '') {
        return { ok: false, reason: 'missing-container-apps-principal' };
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
      } catch {
        return { ok: false, reason: 'malformed-container-apps-principal' };
      }
      const claims = new Map(
        Array.isArray(payload.claims)
          ? payload.claims
              .filter((claim) => claim && typeof claim.typ === 'string' && typeof claim.val === 'string')
              .map((claim) => [claim.typ, claim.val])
          : [],
      );
      const tenant = claims.get('tid') ?? claims.get('http://schemas.microsoft.com/identity/claims/tenantid');
      const principal =
        claims.get('oid') ??
        claims.get('http://schemas.microsoft.com/identity/claims/objectidentifier') ??
        claims.get(payload.name_typ);
      if (tenant !== tenantId || typeof principal !== 'string' || principal === '') {
        return { ok: false, reason: 'container-apps-principal-not-authorized' };
      }
      const roles = Array.isArray(payload.claims)
        ? payload.claims.filter((claim) => claim?.typ === payload.role_typ && typeof claim.val === 'string').map((claim) => claim.val)
        : [];
      return { ok: true, principal, tenant, roles };
    },
  });
}

/**
 * The composed guard `handleExecute` calls: loopback is trusted as-is, with
 * the fixed dev principal/tenant above; anything else must pass
 * `authenticator.authenticate(request)` AND resolve a non-empty `principal`
 * and `tenant` — an authenticator that returns `{ ok: true }` without both is
 * treated as a configuration error and refused, never passed through with a
 * blank or `null` identity a downstream tenant-policy check might
 * accidentally treat as "no restriction".
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {object} options
 * @param {(host:string) => boolean} options.isLoopbackHost
 * @param {string} options.host        the host this server is bound to
 * @param {object} options.authenticator
 * @returns {Promise<{ok:true, principal:string, tenant:string, roles:string[]} | {ok:false, reason:string}>}
 */
export async function authenticatePrincipal(request, { isLoopbackHost, host, authenticator }) {
  if (isLoopbackHost(host)) {
    return { ok: true, principal: LOOPBACK_DEV_PRINCIPAL, tenant: LOOPBACK_DEV_TENANT, roles: [...LOOPBACK_DEV_ROLES] };
  }
  const result = await authenticator.authenticate(request);
  if (!result.ok) return result;
  if (typeof result.principal !== 'string' || result.principal === '') {
    return { ok: false, reason: 'authenticator-did-not-resolve-a-principal' };
  }
  if (typeof result.tenant !== 'string' || result.tenant === '') {
    return { ok: false, reason: 'authenticator-did-not-resolve-a-tenant' };
  }
  return { ok: true, principal: result.principal, tenant: result.tenant, roles: Array.isArray(result.roles) ? result.roles : [] };
}
