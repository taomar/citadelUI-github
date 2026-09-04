/**
 * Acknowledgement v2: a short-lived, one-use envelope bound to the caller,
 * tenant, destination, sample, canonical input digest, and risk text it was
 * granted for — replacing the relay v1 gate, which was only ever a bare
 * `{ accepted: true, sampleId }` flag with a freshness nonce bolted on
 * separately at the proxy.
 *
 * That v1 shape answered "did *a* user consent to running *some* sample" but
 * bound to nothing else: the same accepted flag could be replayed against a
 * different destination, different inputs, or a stale risk description
 * without detection anywhere in the pipeline. This module makes every one of
 * those bindings explicit and independently re-checkable at the relay,
 * *before* the relay ever trusts the request enough to resolve a secret or
 * make an outbound call.
 *
 * `mintAcknowledgement` is called once, at the moment of forwarding, by
 * whichever component holds the concrete, about-to-be-executed request (the
 * local proxy today). `verifyAcknowledgement` is called by the relay against
 * its OWN independently rebuilt view of that same request — never against
 * anything the caller merely asserts.
 *
 * `caller` and `tenant` are optional, pluggable identity fields. In the
 * current non-hosted deployment there is no Entra/OIDC principal at the
 * browser-facing hop, so both default to `null` and are not compared unless
 * the relay is configured to require a specific value — see
 * `verifyAcknowledgement`'s `expected.caller`/`expected.tenant`. Populating
 * them for real is Container Apps/Entra work (continuation queue item 6),
 * out of scope here; the binding machinery is ready for it.
 */

import { createHash, randomUUID } from 'node:crypto';

export const ACKNOWLEDGEMENT_TTL_MS = 5 * 60_000;

/**
 * Normalise a target — one origin, or every origin a rebuilt plan will
 * actually contact — into a sorted, deduped array, independent of input
 * order or of whether the caller passed a bare string, an array or a `Set`.
 * The empty-string/blank-entry filter means a caller can pass
 * `planDestinationOrigins(plan)` directly even when it happens to be empty.
 */
function normalizeTargetSet(target) {
  const list = typeof target === 'string' ? [target] : Array.from(target ?? []);
  const distinct = new Set(list.filter((value) => typeof value === 'string' && value.length > 0));
  return [...distinct].sort();
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortDeep(value[key])]),
    );
  }
  return value;
}

/**
 * A stable digest of exactly what is about to be forwarded: the sample id,
 * every declared (non-secret) input, and which secret references will be
 * resolved. Key order never matters — the digest is computed over a
 * recursively key-sorted structure — so two functionally identical requests
 * always produce the same digest regardless of client-side serialisation
 * order.
 *
 * Never includes a secret VALUE, only `secretRefs` (names). Secret values
 * never reach this module, or the acknowledgement, at all.
 *
 * @param {object} shape
 * @param {string} shape.sampleId
 * @param {Record<string, unknown>} shape.inputs
 * @param {string[]} [shape.secretRefs]
 * @returns {string} lowercase hex sha-256
 */
export function canonicalInputDigest({ sampleId, inputs, secretRefs = [] }) {
  const canonical = JSON.stringify({
    sampleId,
    inputs: sortDeep(inputs ?? {}),
    secretRefs: [...secretRefs].sort(),
  });
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Mint a fresh acknowledgement. Every field it carries is a claim the relay
 * independently re-derives and checks in `verifyAcknowledgement` — nothing
 * here is trusted by name alone.
 *
 * @param {object} options
 * @param {string} options.sampleId
 * @param {Record<string, unknown>} options.inputs
 * @param {string[]} [options.secretRefs]
 * @param {string|Iterable<string>} options.target   the exact destination(s) this run will actually contact — literal request URL(s) (`planRequestUrls(plan)`) when the relay's request-policy layer is in play, or a bare origin for older callers — NEVER caller-selected; the proxy derives this from its own rebuilt plan, not from anything the browser sent as a URL. A single target is stored as a plain string (unchanged wire shape); two or more distinct targets are stored as a sorted, deduped array so a multi-target plan binds to its FULL, deterministic set rather than to one arbitrarily chosen member of it
 * @param {string} options.riskText        the sample's current `risk.effect` text, so a stale acknowledgement minted against an older risk description is refused
 * @param {string|null} [options.caller]   an authenticated principal identifier, when one exists
 * @param {string|null} [options.tenant]   a tenant identifier, when one exists
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now]     injectable for tests
 * @param {string} [options.nonce]         injectable for tests; defaults to a fresh UUID
 */
export function mintAcknowledgement({
  sampleId,
  inputs,
  secretRefs = [],
  target,
  riskText,
  caller = null,
  tenant = null,
  ttlMs = ACKNOWLEDGEMENT_TTL_MS,
  now = () => Date.now(),
  nonce = randomUUID(),
} = {}) {
  if (typeof sampleId !== 'string' || sampleId === '') {
    throw new TypeError('mintAcknowledgement requires sampleId.');
  }
  const targetSet = normalizeTargetSet(target);
  if (targetSet.length === 0) {
    throw new TypeError('mintAcknowledgement requires target (one destination origin, or every origin the run will contact).');
  }
  if (typeof riskText !== 'string' || riskText === '') {
    throw new TypeError('mintAcknowledgement requires riskText.');
  }
  const issuedAt = now();
  return Object.freeze({
    accepted: true,
    sampleId,
    caller,
    tenant,
    target: targetSet.length === 1 ? targetSet[0] : Object.freeze(targetSet),
    inputDigest: canonicalInputDigest({ sampleId, inputs, secretRefs }),
    riskText,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
    nonce,
  });
}

/**
 * Verify an acknowledgement against the relay's own, independently derived
 * view of the request it is about to run. Never throws: the caller decides
 * the HTTP status and code from the returned `{ ok, code, message }`.
 *
 * Deliberately does NOT consume the nonce — that is a side effect
 * (`nonceStore.consume`) the caller performs separately, only once every
 * structural check here has already passed, so a malformed or mismatched
 * request never spends a nonce it was not entitled to use.
 *
 * @param {unknown} acknowledgement
 * @param {object} expected
 * @param {string} expected.sampleId
 * @param {Record<string, unknown>} expected.inputs
 * @param {string[]} [expected.secretRefs]
 * @param {string|Iterable<string>} expected.target   the exact expected destination(s) — one literal request URL, or every literal request URL the rebuilt plan will actually contact (`planRequestUrls(plan)`). A scalar acknowledgement target (the historic, still-supported shape) is accepted ONLY when this expected set normalises to EXACTLY one entry, and only when it equals that sole entry — never merely a member of a larger set. A plan whose rebuilt view requires two or more distinct targets can only ever be satisfied by an acknowledgement that itself names an ARRAY covering that expected set EXACTLY; a scalar acknowledgement can never authorise a multi-target plan, because it would silently grant consent to whichever OTHER target(s) the caller never actually saw named. A multi-target acknowledgement is likewise checked for exact-set equality against the expected set, never partial coverage.
 * @param {string} [expected.riskText]      omit to skip the risk-text check
 * @param {string|null} [expected.caller]   omit (undefined) to skip the caller check
 * @param {string|null} [expected.tenant]   omit (undefined) to skip the tenant check
 * @param {() => number} [options.now]
 */
export function verifyAcknowledgement(acknowledgement, expected, { now = () => Date.now() } = {}) {
  if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) {
    return { ok: false, code: 'acknowledgement-required', message: 'No acknowledgement was supplied.' };
  }
  if (acknowledgement.accepted !== true) {
    return { ok: false, code: 'acknowledgement-required', message: 'The acknowledgement was not accepted.' };
  }
  if (typeof acknowledgement.nonce !== 'string' || acknowledgement.nonce.length === 0) {
    return { ok: false, code: 'nonce-required', message: 'The acknowledgement carries no nonce.' };
  }
  if (typeof acknowledgement.expiresAt !== 'number' || !Number.isFinite(acknowledgement.expiresAt)) {
    return { ok: false, code: 'acknowledgement-malformed', message: 'The acknowledgement carries no expiry.' };
  }
  if (acknowledgement.expiresAt <= now()) {
    return { ok: false, code: 'acknowledgement-expired', message: 'The acknowledgement has expired.' };
  }
  if (acknowledgement.sampleId !== expected.sampleId) {
    return {
      ok: false,
      code: 'acknowledgement-sample-mismatch',
      message: 'The acknowledgement was granted for a different sample.',
    };
  }
  // A scalar acknowledgement target can only ever cover an expected set that
  // is ITSELF exactly one origin — accepting it merely as a MEMBER of a
  // larger expected set would let a single-origin acknowledgement silently
  // authorise every OTHER origin a multi-origin plan also contacts, none of
  // which the caller ever saw named. A genuinely multi-origin acknowledgement
  // (an array) is always checked for exact-set equality, never partial
  // coverage, regardless of the expected set's size.
  const allowedTargets = normalizeTargetSet(expected.target);
  const ackTargets = Array.isArray(acknowledgement.target) ? normalizeTargetSet(acknowledgement.target) : null;
  const targetMatches =
    allowedTargets.length > 0 &&
    (ackTargets === null
      ? allowedTargets.length === 1 && acknowledgement.target === allowedTargets[0]
      : ackTargets.length === allowedTargets.length && ackTargets.every((origin, index) => origin === allowedTargets[index]));
  if (!targetMatches) {
    return {
      ok: false,
      code: 'acknowledgement-target-mismatch',
      message: 'The acknowledgement was granted for a different destination.',
    };
  }
  const expectedDigest = canonicalInputDigest({
    sampleId: expected.sampleId,
    inputs: expected.inputs,
    secretRefs: expected.secretRefs,
  });
  if (acknowledgement.inputDigest !== expectedDigest) {
    return {
      ok: false,
      code: 'acknowledgement-input-mismatch',
      message: 'The acknowledgement does not match the inputs actually being forwarded.',
    };
  }
  if (expected.riskText !== undefined && acknowledgement.riskText !== expected.riskText) {
    return {
      ok: false,
      code: 'acknowledgement-risk-mismatch',
      message: "The acknowledgement does not match this sample's current risk text.",
    };
  }
  if (expected.caller !== undefined && acknowledgement.caller !== expected.caller) {
    return {
      ok: false,
      code: 'acknowledgement-caller-mismatch',
      message: 'The acknowledgement was granted to a different caller.',
    };
  }
  if (expected.tenant !== undefined && acknowledgement.tenant !== expected.tenant) {
    return {
      ok: false,
      code: 'acknowledgement-tenant-mismatch',
      message: 'The acknowledgement was granted for a different tenant.',
    };
  }
  return { ok: true };
}

/**
 * The set of distinct destination origins a rebuilt plan's `http` steps will
 * actually contact. Every catalogue sample builder interpolates its gateway
 * endpoint into `request.url` at plan-build time (never at execution time),
 * so this is a concrete, literal check against the plan the relay itself
 * just rebuilt from its own catalogue — not against anything the caller
 * asserted.
 *
 * @param {object} plan
 * @returns {Set<string>}
 */
export function planDestinationOrigins(plan) {
  const origins = new Set();
  for (const step of plan?.steps ?? []) {
    if (step.type !== 'http') continue;
    const rawUrl = step.request?.url;
    if (typeof rawUrl !== 'string') continue;
    try {
      origins.add(new URL(rawUrl).origin);
    } catch {
      // Not a literal absolute URL (e.g. still carries an unresolved
      // `{{steps.x.y}}` binding) — it cannot be compared to a target here;
      // the origin allowlist re-checks the real destination at request time
      // regardless.
    }
  }
  return origins;
}

/**
 * The set of distinct, literal request URLs (not merely origins) a rebuilt
 * plan's `http` steps will actually contact. This is the acknowledgement
 * TARGET the relay and the local proxy bind to — a strictly finer-grained
 * commitment than `planDestinationOrigins`, which only names the destination
 * ORIGIN and therefore cannot distinguish a caller-approved path from a
 * caller-controlled one on that same origin (the class of problem
 * `requestPolicy.mjs` closes). By the time this is computed, the relay has
 * already run `requestPolicy.authorizeStaticPlan` against the very same
 * rebuilt plan, so the set returned here IS the policy-approved actual
 * request set — never a broader one the caller merely asserts.
 *
 * @param {object} plan
 * @returns {Set<string>}
 */
export function planRequestUrls(plan) {
  const urls = new Set();
  for (const step of plan?.steps ?? []) {
    if (step.type !== 'http') continue;
    const rawUrl = step.request?.url;
    if (typeof rawUrl !== 'string') continue;
    try {
      urls.add(new URL(rawUrl).href);
    } catch {
      // Not yet a literal absolute URL (e.g. still carries an unresolved
      // `{{steps.x.y}}` binding) — `httpExecutor.mjs` re-checks the real,
      // fully-resolved URL against the request policy immediately before
      // the fetch that uses it, so it need not be named here.
    }
  }
  return urls;
}
