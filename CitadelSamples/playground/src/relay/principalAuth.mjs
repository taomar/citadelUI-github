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
import {
  HostedAuthorizationConfigurationError,
  validateHostedAuthorizationPolicy,
} from './operatorAuthorization.mjs';

const CLIENT_PRINCIPAL_HEADER = 'x-ms-client-principal';
const DEFAULT_CLIENT_PRINCIPAL_LIMIT_BYTES = 16 * 1024;
const MAX_CLIENT_PRINCIPAL_CLAIMS = 256;
const TENANT_CLAIM_TYPES = Object.freeze([
  'tid',
  'http://schemas.microsoft.com/identity/claims/tenantid',
]);
const PRINCIPAL_CLAIM_TYPES = Object.freeze([
  'oid',
  'http://schemas.microsoft.com/identity/claims/objectidentifier',
]);
const AUDIENCE_CLAIM_TYPES = Object.freeze([
  'aud',
  'http://schemas.microsoft.com/identity/claims/audience',
]);
const ROLE_CLAIM_TYPES = new Set([
  'roles',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
]);
const GROUP_CLAIM_TYPES = new Set([
  'groups',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
]);
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configuredGuid(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value !== value.toLowerCase() || !GUID_PATTERN.test(value)) {
    throw new HostedAuthorizationConfigurationError(`${label} must be a canonical lowercase Microsoft Entra GUID.`);
  }
  return value;
}

function rawClientPrincipalHeader(request) {
  const rawHeaders = Array.isArray(request.rawHeaders) ? request.rawHeaders : [];
  let occurrences = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === CLIENT_PRINCIPAL_HEADER) occurrences += 1;
  }
  if (occurrences > 1) return { ok: false, reason: 'duplicate-container-apps-principal-header' };
  const encoded = request.headers?.[CLIENT_PRINCIPAL_HEADER];
  if (Array.isArray(encoded) || (typeof encoded === 'string' && encoded.includes(','))) {
    return { ok: false, reason: 'duplicate-container-apps-principal-header' };
  }
  if (typeof encoded !== 'string' || encoded === '') {
    return { ok: false, reason: 'missing-container-apps-principal' };
  }
  return { ok: true, encoded };
}

function decodeClientPrincipal(encoded, maxHeaderBytes) {
  if (Buffer.byteLength(encoded, 'ascii') > maxHeaderBytes) {
    return { ok: false, status: 431, reason: 'container-apps-principal-header-too-large' };
  }
  if (
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded) ||
    encoded.length % 4 === 1 ||
    (/[+/]/.test(encoded) && /[-_]/.test(encoded))
  ) {
    return { ok: false, reason: 'malformed-container-apps-principal' };
  }
  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64');
    const canonical = decoded.toString('base64url');
    const presented = encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (canonical !== presented) return { ok: false, reason: 'malformed-container-apps-principal' };
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(decoded) };
  } catch {
    return { ok: false, reason: 'malformed-container-apps-principal' };
  }
}

function safeClaimString(value, maxLength) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function parseClientPrincipal(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed-container-apps-principal' };
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !['aad', 'azureactivedirectory'].includes(payload.auth_typ) ||
    !safeClaimString(payload.role_typ, 256) ||
    !ROLE_CLAIM_TYPES.has(payload.role_typ) ||
    !Array.isArray(payload.claims) ||
    payload.claims.length === 0 ||
    payload.claims.length > MAX_CLIENT_PRINCIPAL_CLAIMS
  ) {
    return { ok: false, reason: 'malformed-container-apps-principal' };
  }
  const claims = new Map();
  for (const claim of payload.claims) {
    if (
      !claim ||
      typeof claim !== 'object' ||
      Array.isArray(claim) ||
      !safeClaimString(claim.typ, 256) ||
      !safeClaimString(claim.val, 2048)
    ) {
      return { ok: false, reason: 'malformed-container-apps-principal' };
    }
    const values = claims.get(claim.typ) ?? [];
    values.push(claim.val);
    claims.set(claim.typ, values);
  }
  return { ok: true, payload, claims };
}

function exactlyOneClaim(claims, types) {
  const values = types.flatMap((type) => claims.get(type) ?? []);
  return values.length === 1 ? values[0] : null;
}

function repeatedValues(claims, types) {
  const values = types.flatMap((type) => claims.get(type) ?? []);
  return values.length !== new Set(values).size;
}

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
export function createContainerAppsEntraAuthenticator({
  tenantId,
  clientId,
  requiredRole = '',
  allowedPrincipalIds = [],
  allowedGroupIds = [],
  maxHeaderBytes = DEFAULT_CLIENT_PRINCIPAL_LIMIT_BYTES,
} = {}) {
  const expectedTenantId = configuredGuid(tenantId, 'tenantId');
  const expectedClientId = configuredGuid(clientId, 'clientId');
  const policy = validateHostedAuthorizationPolicy({ requiredRole, allowedPrincipalIds, allowedGroupIds });
  if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 1024 || maxHeaderBytes > 64 * 1024) {
    throw new HostedAuthorizationConfigurationError('maxHeaderBytes must be an integer between 1024 and 65536.');
  }
  const allowedPrincipals = new Set(policy.allowedPrincipalIds);
  const allowedGroups = new Set(policy.allowedGroupIds);
  return Object.freeze({
    mode: 'container-apps-entra',
    policy,
    async authenticate(request) {
      const header = rawClientPrincipalHeader(request);
      if (!header.ok) return { ...header, status: 401, authenticated: false };
      const decoded = decodeClientPrincipal(header.encoded, maxHeaderBytes);
      if (!decoded.ok) return { ...decoded, status: decoded.status ?? 401, authenticated: false };
      const parsed = parseClientPrincipal(decoded.text);
      if (!parsed.ok) return { ...parsed, status: 401, authenticated: false };

      const tenant = exactlyOneClaim(parsed.claims, TENANT_CLAIM_TYPES);
      const audience = exactlyOneClaim(parsed.claims, AUDIENCE_CLAIM_TYPES);
      const principal = exactlyOneClaim(parsed.claims, PRINCIPAL_CLAIM_TYPES);
      if (!tenant || !audience || !principal || !GUID_PATTERN.test(tenant) || !GUID_PATTERN.test(principal)) {
        return { ok: false, status: 401, authenticated: false, reason: 'malformed-container-apps-principal' };
      }
      const canonicalTenant = tenant.toLowerCase();
      const canonicalPrincipal = principal.toLowerCase();
      if (canonicalTenant !== expectedTenantId || audience !== expectedClientId) {
        return { ok: false, status: 403, authenticated: true, reason: 'container-apps-principal-not-authorized' };
      }

      const roleTypes = [...new Set([parsed.payload.role_typ, ...ROLE_CLAIM_TYPES])];
      const roles = roleTypes.flatMap((type) => parsed.claims.get(type) ?? []);
      const groups = [...GROUP_CLAIM_TYPES].flatMap((type) => parsed.claims.get(type) ?? []);
      if (repeatedValues(parsed.claims, roleTypes) || repeatedValues(parsed.claims, [...GROUP_CLAIM_TYPES])) {
        return { ok: false, status: 401, authenticated: false, reason: 'malformed-container-apps-principal' };
      }
      if (groups.some((group) => !GUID_PATTERN.test(group))) {
        return { ok: false, status: 401, authenticated: false, reason: 'malformed-container-apps-principal' };
      }

      const roleAuthorized = policy.requiredRole !== '' && roles.includes(policy.requiredRole);
      const principalAuthorized = allowedPrincipals.has(canonicalPrincipal);
      const groupAuthorized = groups.some((group) => allowedGroups.has(group.toLowerCase()));
      if (!roleAuthorized && !principalAuthorized && !groupAuthorized) {
        return { ok: false, status: 403, authenticated: true, reason: 'hosted-operator-entitlement-required' };
      }
      return {
        ok: true,
        principal: canonicalPrincipal,
        tenant: canonicalTenant,
        roles: roleAuthorized ? [policy.requiredRole] : [],
        authorization: Object.freeze({
          role: roleAuthorized,
          principal: principalAuthorized,
          group: groupAuthorized,
        }),
      };
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
  return {
    ok: true,
    principal: result.principal,
    tenant: result.tenant,
    roles: Array.isArray(result.roles) ? result.roles : [],
    ...(result.authorization ? { authorization: result.authorization } : {}),
  };
}
