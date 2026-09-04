/**
 * Server-side authorization: maps an AUTHENTICATED (tenant, principal,
 * roles) context — never anything from the request body — to the exact,
 * pre-provisioned set of resources that context may touch.
 *
 * This is the other half of the boundary `requestSchema.mjs` and
 * `secretProvider.mjs` already establish. Those modules make sure a caller
 * cannot select its own plan, URL, header set, vault or secret name. This
 * module makes sure an AUTHENTICATED caller cannot reach resources
 * provisioned for a DIFFERENT tenant, either — an authenticated caller from
 * tenant A must never be able to run tenant B's samples, contact tenant B's
 * destinations, or resolve tenant B's secrets, even though both tenants
 * might be served by the very same relay process.
 *
 * A resolved bundle is exactly:
 *
 *   {
 *     allowedSampleIds: string[],      // this tenant's relay-eligible samples
 *     originAllowlist:  object,        // from createOriginAllowlist — this
 *                                      // tenant's approved destinations
 *     httpExecutor:     object,        // from createRelayHttpExecutor, BUILT
 *                                      // FROM that same originAllowlist AND
 *                                      // requestPolicy, so all three can
 *                                      // never drift apart
 *     requestPolicy:    object,        // from createSampleRequestPolicy /
 *                                      // deriveDefaultSampleRequestPolicy —
 *                                      // this tenant's exact per-sample,
 *                                      // per-step URL/header authorization,
 *                                      // closing the gap origin-only checks
 *                                      // leave open on a shared origin (see
 *                                      // requestPolicy.mjs)
 *     secretProvider:   object,        // this tenant's logical secret provider
 *   }
 *
 * The `httpExecutor`/`requestPolicy` pairing above is not just documentation:
 * `assertBundle` enforces it with `bundle.httpExecutor.requestPolicy ===
 * bundle.requestPolicy`. `createRelayHttpExecutor` re-checks its
 * `requestPolicy` immediately before every runtime-bound fetch — the one
 * check `requestSchema.mjs`'s static, pre-execution authorization structurally
 * cannot perform, because a runtime-discovered ("secondary") URL is not yet
 * literal until an earlier step's response has been captured. If a bundle's
 * `httpExecutor` were ever built from a *different* requestPolicy object than
 * the one this module validated — or, before `requestPolicy` became a
 * required constructor argument, from none at all — that runtime re-check
 * would silently run against the wrong policy, or not run at all, while every
 * other gate in the pipeline still reported success. Use
 * `createRelayTenantBundle` below to build a bundle whose `httpExecutor` and
 * `requestPolicy` are constructed from one shared value, so this can never
 * happen by construction rather than merely being checked for afterwards.
 *
 * `handleExecuteRequest` (`server.mjs`) resolves a bundle once per request,
 * immediately after authentication and before any schema, acknowledgement,
 * secret, or network access — an unresolved tenant, or a request naming a
 * sample or destination outside that tenant's bundle, is refused before any
 * of those happen.
 */

import { createRelayHttpExecutor } from './httpExecutor.mjs';


function assertBundle(tenantId, bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new TypeError(`Tenant "${tenantId}"'s policy bundle must be an object.`);
  }
  if (!Array.isArray(bundle.allowedSampleIds)) {
    throw new TypeError(`Tenant "${tenantId}"'s policy bundle must carry allowedSampleIds (string[]).`);
  }
  if (!bundle.originAllowlist || typeof bundle.originAllowlist.assertAllowed !== 'function') {
    throw new TypeError(`Tenant "${tenantId}"'s policy bundle must carry an originAllowlist (see createOriginAllowlist).`);
  }
  if (!bundle.httpExecutor || typeof bundle.httpExecutor.execute !== 'function') {
    throw new TypeError(`Tenant "${tenantId}"'s policy bundle must carry an httpExecutor (see createRelayHttpExecutor).`);
  }
  if (
    !bundle.requestPolicy ||
    typeof bundle.requestPolicy.authorizeStaticPlan !== 'function' ||
    typeof bundle.requestPolicy.authorizeRequestUrl !== 'function' ||
    typeof bundle.requestPolicy.authorizeHeaderNames !== 'function'
  ) {
    throw new TypeError(
      `Tenant "${tenantId}"'s policy bundle must carry a requestPolicy (see createSampleRequestPolicy / deriveDefaultSampleRequestPolicy).`,
    );
  }
  // The pairing that matters, not just each half's own shape: this tenant's
  // httpExecutor must have been BUILT FROM this exact requestPolicy object —
  // `createRelayHttpExecutor` exposes it by reference precisely so this can
  // be checked with `===` — never a different (or, previously, no)
  // requestPolicy. Two independently constructed policy objects can each be
  // individually well-formed and still not be the SAME one the executor
  // re-checks a runtime-bound URL against; only reference equality proves
  // there is no drift. Use `createRelayTenantBundle` to make this the only
  // possible outcome rather than something that has to be checked for here.
  if (bundle.httpExecutor.requestPolicy !== bundle.requestPolicy) {
    throw new TypeError(
      `Tenant "${tenantId}"'s httpExecutor must be built from this exact same requestPolicy object (see createRelayTenantBundle) — ` +
        'a mismatched or missing pairing would let the runtime re-check for a discovered/secondary URL silently run against the wrong policy, or none at all.',
    );
  }
  if (!bundle.secretProvider || typeof bundle.secretProvider.resolve !== 'function') {
    throw new TypeError(`Tenant "${tenantId}"'s policy bundle must carry a secretProvider.`);
  }
  if (bundle.allowedRoles !== undefined && !Array.isArray(bundle.allowedRoles)) {
    throw new TypeError(`Tenant "${tenantId}"'s policy bundle's allowedRoles, when present, must be a string[].`);
  }
}

/**
 * A resolver built from a fixed, operator-provided tenant -> bundle map.
 * Every bundle is validated eagerly, at construction time, so a
 * misconfiguration (a tenant with no secret provider, say) fails the moment
 * the relay starts rather than the first time an authenticated caller
 * reaches it.
 *
 * @param {Map<string, object> | Record<string, object>} tenants
 * @param {object} [options]
 * @param {string[]} [options.structuralAllowedSampleIds]   when provided, every
 *        tenant's `allowedSampleIds` must be a subset of this catalogue-wide
 *        structurally-relay-eligible set (see `computeRelayAllowedSampleIds`)
 *        — a defence against an operator accidentally allow-listing a
 *        sample id the relay could never safely run for ANY tenant.
 */
export function createStaticTenantPolicy(tenants, { structuralAllowedSampleIds } = {}) {
  const byTenant = tenants instanceof Map ? new Map(tenants) : new Map(Object.entries(tenants ?? {}));
  if (byTenant.size === 0) {
    throw new TypeError('createStaticTenantPolicy requires at least one tenant.');
  }
  const structural = Array.isArray(structuralAllowedSampleIds) ? new Set(structuralAllowedSampleIds) : null;
  for (const [tenantId, bundle] of byTenant) {
    if (typeof tenantId !== 'string' || tenantId === '') {
      throw new TypeError('Every tenant key must be a non-empty string.');
    }
    assertBundle(tenantId, bundle);
    if (structural) {
      const outOfBounds = bundle.allowedSampleIds.filter((id) => !structural.has(id));
      if (outOfBounds.length > 0) {
        throw new TypeError(
          `Tenant "${tenantId}" allow-lists ${outOfBounds.join(', ')}, which the relay cannot structurally run for any tenant.`,
        );
      }
    }
  }

  return Object.freeze({
    /**
     * @param {object} context
     * @param {string} context.tenant
     * @param {string} [context.principal]
     * @param {string[]} [context.roles]
     * @returns {Promise<object|null>} the resolved bundle, or `null` when this
     *          tenant is unknown, or known but this principal's roles do not
     *          satisfy the bundle's `allowedRoles` gate
     */
    async resolve({ tenant, principal, roles = [] } = {}) {
      void principal;
      if (typeof tenant !== 'string' || tenant === '') return null;
      const bundle = byTenant.get(tenant);
      if (!bundle) return null;
      if (Array.isArray(bundle.allowedRoles) && bundle.allowedRoles.length > 0) {
        const grantedRoles = Array.isArray(roles) ? roles : [];
        const authorized = bundle.allowedRoles.some((role) => grantedRoles.includes(role));
        if (!authorized) return null;
      }
      return bundle;
    },
  });
}

/**
 * Build a single tenant's resolved bundle from one shared `requestPolicy`,
 * so its `httpExecutor` and its own `requestPolicy` field are structurally
 * guaranteed to be the pairing `assertBundle` requires — there is no
 * intermediate step in which a caller could pass a different (or no)
 * requestPolicy to `createRelayHttpExecutor` than the one recorded on the
 * bundle. This is the recommended way to build a bundle; hand-assembling one
 * (as the object literal in this module's own doc comment shows the shape
 * of) remains possible for callers with an unusual reason to, but
 * `assertBundle` will refuse it at `createStaticTenantPolicy` construction
 * time if the two ever do not match by reference.
 *
 * @param {object} options
 * @param {string[]} options.allowedSampleIds
 * @param {object} options.originAllowlist   from `createOriginAllowlist`
 * @param {object} options.requestPolicy     from `createSampleRequestPolicy` / `deriveDefaultSampleRequestPolicy`
 * @param {object} options.secretProvider
 * @param {Function} [options.fetchImpl]     forwarded to `createRelayHttpExecutor`
 * @param {object} [options.limits]          forwarded to `createRelayHttpExecutor`
 * @param {string[]} [options.allowedRoles]
 */
export function createRelayTenantBundle({
  allowedSampleIds,
  originAllowlist,
  requestPolicy,
  secretProvider,
  fetchImpl,
  limits,
  allowedRoles,
} = {}) {
  const httpExecutor = createRelayHttpExecutor({ fetchImpl, allowlist: originAllowlist, requestPolicy, limits });
  return {
    allowedSampleIds,
    originAllowlist,
    httpExecutor,
    requestPolicy,
    secretProvider,
    ...(allowedRoles !== undefined ? { allowedRoles } : {}),
  };
}
