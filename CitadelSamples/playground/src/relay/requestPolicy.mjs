/**
 * Per-tenant, per-sample, per-step request policy.
 *
 * `originAllowlist.mjs` authorizes a destination ORIGIN, and deliberately
 * never looks at path, query, or header names — see its own doc comment.
 * That leaves a gap on a shared origin (a shared APIM gateway serving many
 * backend routes behind one hostname, say): a caller-supplied
 * `deployedEndpoint` can carry an arbitrary PATH on an otherwise-allowed
 * origin, and a caller-supplied `gatewayAccess.subscriptionKeyHeader` can
 * rename which HEADER a resolved secret value is placed into — neither trips
 * the origin check at all, because both are still "the same allowed origin",
 * just a different route or a different header on it.
 *
 * This module closes that gap with a second, independent authorization layer,
 * selected entirely by the tenant policy the relay already resolves from the
 * AUTHENTICATED caller (`tenantPolicy.mjs`) — never by anything the request
 * itself asks for. For every sample/step a tenant may run, the policy names
 * the EXACT literal request URL(s) that step may contact and the EXACT
 * header name(s) that may carry a secret-bearing value for that step. A
 * caller-selected path or header outside that list is refused before the
 * secret provider or the network is ever touched — see `server.mjs`'s
 * pre-secret-resolution static check and `httpExecutor.mjs`'s per-request
 * check (covering runtime-bound/discovered URLs too).
 *
 * `deriveDefaultSampleRequestPolicy` is the convenience an operator normally
 * uses: it never hand-enumerates a URL. Instead, for each of the tenant's
 * allowed samples, it rebuilds that sample's plan with the tenant's OWN
 * approved `hub.gatewayUrl` and every other field left at its catalogue
 * default — in particular `deployedEndpoint` blank and
 * `gatewayAccess.subscriptionKeyHeader` at its fixed default name — and
 * records whatever literal URL(s)/header name(s) that canonical rebuild
 * actually produces. A request that instead supplies a different
 * `deployedEndpoint` or header name produces a DIFFERENT request than this
 * canonical one, and is refused, precisely because the policy was never
 * derived from — and is never influenced by — the request under check.
 */

import { isSecretRef } from '../core/secrets.mjs';

function normaliseHeaderName(name) {
  return String(name ?? '').trim().toLowerCase();
}

function canonicalUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  try {
    return new URL(rawUrl).href;
  } catch {
    return null;
  }
}

function secretBearingHeaderNames(headers) {
  return Object.entries(headers ?? {})
    .filter(([, value]) => isSecretRef(value))
    .map(([name]) => name);
}

/**
 * A fixed, non-caller-derived stand-in for "a value is present", used only
 * to satisfy `buildSamplePlan`'s field-presence validator for a field the
 * catalogue declares no default for at all (in practice: a secret field,
 * which a sample builder never interpolates literally — it records
 * `secretRef(path, ...)` instead — so this placeholder never reaches a
 * literal URL or header value).
 */
const CANONICAL_PLACEHOLDER = 'relay-request-policy-placeholder';

/**
 * Reader for deriving a sample's CANONICAL request shape: the catalogue's
 * own default when the catalogue declares one — including a deliberately
 * BLANK one such as `deployedEndpoint: ''`, which means "no override" and
 * must be read back as blank, not replaced by a placeholder — or the fixed
 * placeholder above when the catalogue has no default whatsoever for that
 * path. `hub.gatewayUrl` is the one path every relay-eligible sample uses
 * but the catalogue deliberately never defaults (it is a genuine
 * per-operator value), so the caller of this reader must override it.
 */
function canonicalDefaultRead(catalogue) {
  return (path) => {
    if (Object.prototype.hasOwnProperty.call(catalogue.defaultValues, path)) {
      return catalogue.defaultValues[path];
    }
    return CANONICAL_PLACEHOLDER;
  };
}

function assertStepPolicy(sampleId, stepId, stepPolicy) {
  if (!stepPolicy || typeof stepPolicy !== 'object') {
    throw new TypeError(`Request policy for sample "${sampleId}" step "${stepId}" must be an object.`);
  }
  const urls = stepPolicy.urls;
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((url) => typeof url === 'string' && url.length > 0)) {
    throw new TypeError(`Request policy for sample "${sampleId}" step "${stepId}" must carry a non-empty urls: string[].`);
  }
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError(`Request policy URL "${url}" (sample "${sampleId}", step "${stepId}") is not a valid absolute URL.`);
    }
    if (parsed.protocol !== 'https:') {
      throw new TypeError(`Request policy URL "${url}" (sample "${sampleId}", step "${stepId}") must be https.`);
    }
  }
  const headerNames = stepPolicy.headerNames ?? [];
  if (!Array.isArray(headerNames) || !headerNames.every((name) => typeof name === 'string' && name.length > 0)) {
    throw new TypeError(`Request policy for sample "${sampleId}" step "${stepId}"'s headerNames, when present, must be a string[].`);
  }
}

/**
 * Build a request policy from an explicit `{ [sampleId]: { [stepId]:
 * {urls, headerNames?} } }` map. Every URL is validated to be a well-formed,
 * https, absolute URL at construction time, so a misconfiguration fails the
 * moment the relay starts rather than the first time a request reaches it.
 *
 * @param {Record<string, Record<string, {urls: string[], headerNames?: string[]}>>} bySampleId
 */
export function createSampleRequestPolicy(bySampleId) {
  if (!bySampleId || typeof bySampleId !== 'object') {
    throw new TypeError('createSampleRequestPolicy requires a { [sampleId]: { [stepId]: {...} } } map.');
  }
  const samples = new Map();
  for (const [sampleId, steps] of Object.entries(bySampleId)) {
    if (!steps || typeof steps !== 'object') {
      throw new TypeError(`Request policy for sample "${sampleId}" must be a { [stepId]: {...} } map.`);
    }
    const stepMap = new Map();
    for (const [stepId, stepPolicy] of Object.entries(steps)) {
      assertStepPolicy(sampleId, stepId, stepPolicy);
      stepMap.set(stepId, {
        urls: Object.freeze([...new Set(stepPolicy.urls.map((url) => new URL(url).href))]),
        headerNames: Object.freeze([...new Set((stepPolicy.headerNames ?? []).map(normaliseHeaderName))]),
      });
    }
    samples.set(sampleId, stepMap);
  }

  function stepPolicyFor(sampleId, stepId) {
    return samples.get(sampleId)?.get(stepId) ?? null;
  }

  function authorizeHeaderNames(sampleId, stepId, headerNames) {
    const policy = stepPolicyFor(sampleId, stepId);
    if (!policy) {
      return {
        ok: false,
        code: 'request-policy-unknown-step',
        message: `No request policy is configured for "${sampleId}" step "${stepId}".`,
      };
    }
    const disallowed = (headerNames ?? []).filter((name) => !policy.headerNames.includes(normaliseHeaderName(name)));
    if (disallowed.length > 0) {
      return {
        ok: false,
        code: 'request-policy-header-not-allowed',
        message: `"${sampleId}" step "${stepId}" would send a secret-bearing value in header(s) ${disallowed.join(', ')}, which this tenant's request policy does not allow.`,
      };
    }
    return { ok: true };
  }

  function authorizeRequestUrl(sampleId, stepId, resolvedUrl) {
    const policy = stepPolicyFor(sampleId, stepId);
    if (!policy) {
      return {
        ok: false,
        code: 'request-policy-unknown-step',
        message: `No request policy is configured for "${sampleId}" step "${stepId}".`,
      };
    }
    const literal = canonicalUrl(resolvedUrl);
    if (literal === null || !policy.urls.includes(literal)) {
      return {
        ok: false,
        code: 'request-policy-url-not-allowed',
        message: `Refused a request to "${resolvedUrl}": it is not in this tenant's per-step request policy for "${sampleId}" step "${stepId}".`,
      };
    }
    return { ok: true };
  }

  return Object.freeze({
    sampleIds: Object.freeze([...samples.keys()]),

    /**
     * Static, pre-execution authorization over a server-rebuilt plan, called
     * BEFORE any secret is resolved or any network call is made. Every
     * `http` step whose request URL is already literal (not a
     * `{{steps.x.y}}` binding awaiting execution) must be one this sample's
     * step policy names, and every header name that carries a `SecretRef`
     * in the plan — known at rebuild time, since a catalogue sample builder
     * always chooses its credential header name at BUILD time, never at
     * execution time — must be one this policy authorizes for that step. A
     * step whose URL cannot yet be checked here (a runtime-bound one) is
     * re-checked by `authorizeRequestUrl` the moment it is actually about
     * to be requested, in `httpExecutor.mjs`.
     */
    authorizeStaticPlan(sampleId, plan) {
      const stepMap = samples.get(sampleId);
      if (!stepMap) {
        return {
          ok: false,
          code: 'request-policy-unknown-sample',
          message: `No request policy is configured for "${sampleId}".`,
        };
      }
      for (const step of plan?.steps ?? []) {
        if (step.type !== 'http') continue;
        if (!stepMap.has(step.id)) {
          return {
            ok: false,
            code: 'request-policy-unknown-step',
            message: `No request policy is configured for "${sampleId}" step "${step.id}".`,
          };
        }
        const literal = canonicalUrl(step.request?.url);
        if (literal !== null) {
          const urlCheck = authorizeRequestUrl(sampleId, step.id, literal);
          if (!urlCheck.ok) return urlCheck;
        }
        const headerCheck = authorizeHeaderNames(sampleId, step.id, secretBearingHeaderNames(step.request?.headers));
        if (!headerCheck.ok) return headerCheck;
      }
      return { ok: true };
    },

    /** Per-request re-check: called immediately before every fetch (initial, burst, and any runtime-bound URL). */
    authorizeRequestUrl,

    /** Per-request header-name re-check: called alongside `authorizeRequestUrl`, before every fetch. */
    authorizeHeaderNames,
  });
}

/**
 * Derive a request policy automatically for every one of a tenant's allowed
 * samples, from the catalogue itself, rather than hand-maintaining one that
 * can drift from it.
 *
 * For each sample, this rebuilds its plan with `hub.gatewayUrl` forced to
 * this tenant's OWN approved origin and every other field left at its
 * catalogue default — never a value the request supplies — and records the
 * literal URL(s) and secret-bearing header name(s) that canonical rebuild
 * actually produces. A sample that cannot be structurally built this way
 * (its requirements are never satisfied by catalogue defaults alone) is
 * simply omitted — default-deny, not a crash — since `authorizeStaticPlan`
 * refuses any sample this policy carries no entry for.
 *
 * @param {object} catalogue
 * @param {object} deps
 * @param {Function} deps.buildSamplePlan
 * @param {Function} deps.requirementsFor
 * @param {object} options
 * @param {string[]} options.allowedSampleIds  this tenant's own allow-list
 * @param {string} options.gatewayUrl          this tenant's own approved `hub.gatewayUrl`
 */
export function deriveDefaultSampleRequestPolicy(
  catalogue,
  { buildSamplePlan, requirementsFor },
  { allowedSampleIds, gatewayUrl },
) {
  if (typeof gatewayUrl !== 'string' || gatewayUrl === '') {
    throw new TypeError('deriveDefaultSampleRequestPolicy requires a non-empty gatewayUrl.');
  }
  const bySampleId = {};
  for (const sampleId of allowedSampleIds ?? []) {
    const sample = catalogue.byId.get(sampleId);
    if (!sample) continue;
    const defaultRead = canonicalDefaultRead(catalogue);
    const read = (path) => (path === 'hub.gatewayUrl' ? gatewayUrl : defaultRead(path));
    let manifest;
    let plan;
    try {
      manifest = requirementsFor(sample, read, { hasSecret: () => true });
      if (!manifest.satisfied) continue;
      ({ plan } = buildSamplePlan(sample, read));
    } catch {
      continue;
    }
    if (!plan) continue;
    const steps = {};
    for (const step of plan.steps ?? []) {
      if (step.type !== 'http') continue;
      const literal = canonicalUrl(step.request?.url);
      if (literal === null) continue;
      steps[step.id] = { urls: [literal], headerNames: secretBearingHeaderNames(step.request?.headers) };
    }
    if (Object.keys(steps).length > 0) bySampleId[sampleId] = steps;
  }
  return createSampleRequestPolicy(bySampleId);
}
