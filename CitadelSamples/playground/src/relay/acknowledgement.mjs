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
 * The only clock-drift tolerance `verifyAcknowledgement` extends to a
 * caller-claimed `issuedAt`: bounded, and small relative to
 * `ACKNOWLEDGEMENT_TTL_MS`, so it absorbs genuine wall-clock disagreement
 * between whichever process minted the acknowledgement and whichever
 * process later verifies it, without ever opening a window wide enough to
 * matter for replay purposes.
 */
export const ACKNOWLEDGEMENT_CLOCK_SKEW_MS = 60_000;

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
 * Timing checks (`issuedAt`, `expiresAt`) are validated against THIS
 * function's own `now`, never merely against each other in isolation: an
 * `issuedAt` claimed more than `ACKNOWLEDGEMENT_CLOCK_SKEW_MS` ahead of `now`
 * is refused with `acknowledgement-not-yet-valid` (a bounded tolerance for
 * genuine wall-clock disagreement between the minting and verifying
 * process, not a window for a caller to pre-date an acknowledgement for
 * later use); and the accepted `expiresAt` can never exceed
 * `ACKNOWLEDGEMENT_TTL_MS + ACKNOWLEDGEMENT_CLOCK_SKEW_MS` from `now`,
 * independent of what `issuedAt` claims — this is what guarantees a
 * downstream consumer keying a fixed retention window off this
 * acknowledgement's `expiresAt` (the managed-run store's nonce retention —
 * see `MAX_NONCE_RETENTION_MS` in managedRun.mjs) can always safely cover
 * the full window this function will still call "valid".
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
  // The acknowledgement's own claimed lifetime (expiresAt - issuedAt) must be
  // bounded by ACKNOWLEDGEMENT_TTL_MS, AND (independently, below) the
  // absolute expiry measured from THIS verifier's own clock must never
  // exceed that same bound plus a small clock-skew tolerance. Without both
  // checks a forged, or merely future-dated, acknowledgement could still
  // pass every other structural check here, and callers downstream (the
  // managed-run store's nonce retention, in particular — see
  // MAX_NONCE_RETENTION_MS in managedRun.mjs) that key a replay-prevention
  // window off this exact field would then retain that window far longer
  // than this function's own notion of "still valid" actually holds, which
  // is exactly the gap a same-nonce, different-Idempotency-Key replay could
  // otherwise slip through once the store had reaped it "too early" for a
  // still-valid-looking acknowledgement.
  if (typeof acknowledgement.issuedAt !== 'number' || !Number.isFinite(acknowledgement.issuedAt)) {
    return { ok: false, code: 'acknowledgement-malformed', message: 'The acknowledgement carries no issue time.' };
  }
  const nowMs = now();
  // A caller-claimed issuedAt in the future — beyond a small, bounded
  // clock-skew tolerance — is refused outright. Left unchecked, a
  // future-dated issuedAt would let an otherwise self-consistent
  // acknowledgement (its claimed lifetime and expiry both check out against
  // ITS OWN issuedAt) describe a validity window that, measured from real
  // wall-clock time, extends further into the future than this relay ever
  // intended to accept.
  if (acknowledgement.issuedAt > nowMs + ACKNOWLEDGEMENT_CLOCK_SKEW_MS) {
    return { ok: false, code: 'acknowledgement-not-yet-valid', message: 'The acknowledgement was issued in the future.' };
  }
  // An issuedAt that is merely OLD, rather than future-dated, needs no
  // separate bound here: paired with the claimed-lifetime check immediately
  // below and the expiry check that follows it, an unreasonably old
  // issuedAt can only ever produce an expiresAt that is either already
  // expired (caught below) or that claims a lifetime exceeding
  // ACKNOWLEDGEMENT_TTL_MS (also caught below) — there is no old issuedAt
  // value that satisfies both those checks while still saying anything
  // meaningfully different from "this acknowledgement is stale".
  const claimedLifetimeMs = acknowledgement.expiresAt - acknowledgement.issuedAt;
  if (!(claimedLifetimeMs > 0) || claimedLifetimeMs > ACKNOWLEDGEMENT_TTL_MS) {
    return {
      ok: false,
      code: 'acknowledgement-malformed',
      message: 'The acknowledgement claims a lifetime outside the relay\'s accepted acknowledgement TTL.',
    };
  }
  if (acknowledgement.expiresAt <= nowMs) {
    return { ok: false, code: 'acknowledgement-expired', message: 'The acknowledgement has expired.' };
  }
  // Critical, and independent of the (bounded, but still caller-influenced)
  // issuedAt above: measured from THIS verifier's own clock, the accepted
  // expiry can never exceed TTL + skew from right now. This guarantees the
  // durable managed-run store's fixed nonce-retention cap
  // (MAX_NONCE_RETENTION_MS, currently 30 minutes — comfortably larger than
  // ACKNOWLEDGEMENT_TTL_MS + ACKNOWLEDGEMENT_CLOCK_SKEW_MS — see
  // managedRun.mjs) always outlasts the full accepted validity window of
  // any acknowledgement this function lets through, so a nonce this
  // acknowledgement authorises can never be forgotten by the store while
  // this function would still consider the acknowledgement valid.
  if (acknowledgement.expiresAt > nowMs + ACKNOWLEDGEMENT_TTL_MS + ACKNOWLEDGEMENT_CLOCK_SKEW_MS) {
    return {
      ok: false,
      code: 'acknowledgement-malformed',
      message: 'The acknowledgement expiry exceeds the relay\'s accepted validity window.',
    };
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
