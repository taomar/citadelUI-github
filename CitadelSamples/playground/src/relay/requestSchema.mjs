/**
 * Exact-schema request handling for the relay wire protocol.
 *
 * The relay speaks a strict SUBSET of the local `/api/run` contract: the same
 * `{ protocolVersion, sampleId, inputs, acknowledgement }` shape, reused
 * verbatim via `validateRunRequest`/`rebuildPlan`, plus two relay-only
 * additions layered on top —
 *
 *   - `secretRefs`   caller may name which refs it expects to be resolved;
 *                    the server never trusts the caller's list wholesale, it
 *                    only checks membership against the sample's OWN declared
 *                    secrets and otherwise recomputes the canonical set itself
 *   - `acknowledgement.nonce`   minted by the local proxy, consumed exactly
 *                    once by the relay's nonce store (see `nonceStore.mjs`)
 *
 * `secrets` is refused outright: this endpoint resolves secret values itself,
 * server-side, via an injected secret provider. A caller that sends one is
 * rejected, not silently ignored.
 *
 * Nothing here is reachable unless the sample is both structurally
 * http/assertion-only AND explicitly allow-listed — see
 * `computeRelayAllowedSampleIds`. Anything else is a default-deny: risky
 * samples (load-generating, destructive) are never relay-eligible even when
 * every one of their steps happens to be http/assertion, because eligibility
 * requires `risk.level === 'read-only'` too.
 */

import { RequestRefused, rebuildPlan, validateRunRequest } from '../server/runRequest.mjs';
import { isBlank } from '../core/validation.mjs';

export const RELAY_SUPPORTED_STEP_TYPES = Object.freeze(['http', 'assertion']);

/**
 * A fixed, non-caller-derived stand-in for "a secret is present", used only to
 * satisfy `buildSamplePlan`'s field-presence validator while rebuilding a
 * relay plan. Never a real value, never influenced by request input, and
 * never the value actually used at execution time (the relay's http executor
 * resolves the live value from the injected secret provider instead).
 */
const RELAY_SECRET_PLACEHOLDER = 'relay-secret-provider-placeholder';

/** Top-level members this endpoint accepts. Anything else is a rejection. */
const ALLOWED_MEMBERS = Object.freeze(['protocolVersion', 'sampleId', 'inputs', 'secretRefs', 'acknowledgement']);

/**
 * A neutral, syntactically valid placeholder per field type. Used only to
 * determine STRUCTURAL eligibility (which step types a sample's plan would
 * require) below — never seen by a real request. Several catalogue fields
 * (notably `hub.gatewayUrl`) have deliberately no catalogue-wide default,
 * because they are genuinely per-operator values; that must not stop the
 * eligibility computation from reasoning about the sample's shape.
 */
function syntheticValueFor(entry) {
  if (entry.type === 'enum' && Array.isArray(entry.options) && entry.options.length > 0) {
    return entry.options[0];
  }
  switch (entry.type) {
    case 'url':
      return 'https://relay-eligibility-check.example.net';
    case 'boolean':
      return false;
    case 'integer':
      return 0;
    case 'string-list':
      return ['placeholder'];
    default:
      return 'placeholder';
  }
}

/** A reader for `computeRelayAllowedSampleIds`: catalogue default, or a synthetic placeholder when there is none. */
function structuralReader(sample, catalogue) {
  const declared = new Map(sample.configurationEntries.map((entry) => [entry.path, entry]));
  return (path) => {
    const existing = catalogue.defaultValues[path];
    if (!isBlank(existing)) return existing;
    const entry = declared.get(path);
    if (!entry) return existing;
    // Secret-marked fields never carry their read() value into a plan — sample
    // builders always record `secretRef(path, ...)` instead of interpolating the
    // literal — so a placeholder here only satisfies "is something present?"
    // checks and never reaches a request, a log, or the built plan itself.
    return syntheticValueFor(entry);
  };
}

/**
 * Compute the default relay allow-list from the catalogue itself, rather than
 * hand-maintaining a list that can drift from it.
 *
 * Eligible: `risk.level === 'read-only'` (never a load-generating or
 * destructive sample, however narrow its step types) AND every step the
 * sample's plan requires is `http` or `assertion`.
 *
 * @param {object} catalogue        the `CATALOGUE` export
 * @param {object} deps
 * @param {Function} deps.buildSamplePlan
 * @param {Function} deps.requirementsFor
 */
export function computeRelayAllowedSampleIds(catalogue, { buildSamplePlan, requirementsFor }) {
  const allowed = [];
  for (const sample of catalogue.samples) {
    if (sample.risk.level !== 'read-only') continue;
    try {
      const read = structuralReader(sample, catalogue);
      const manifest = requirementsFor(sample, read, { hasSecret: () => true });
      if (!manifest.satisfied) continue;
      const { plan } = buildSamplePlan(sample, read);
      if (!plan) continue;
      const unsupported = plan.requiredStepTypes.filter((type) => !RELAY_SUPPORTED_STEP_TYPES.includes(type));
      if (unsupported.length === 0) allowed.push(sample.id);
    } catch {
      continue;
    }
  }
  return Object.freeze(allowed);
}

/**
 * Parse the deployment-owned relay allow-list shared by the playground proxy
 * and relay. Missing configuration never widens to every structurally eligible
 * sample; an empty array explicitly disables all relay execution.
 */
export function parseRelayAllowedSampleIds(
  rawValue,
  catalogue,
  { buildSamplePlan, requirementsFor },
  { name = 'CITADEL_RELAY_ALLOWED_SAMPLE_IDS' } = {},
) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    throw new TypeError(`${name} must be configured as a JSON array of catalogue sample IDs.`);
  }
  let configured;
  try {
    configured = JSON.parse(rawValue);
  } catch {
    throw new TypeError(`${name} must be valid JSON.`);
  }
  if (!Array.isArray(configured)) {
    throw new TypeError(`${name} must be a JSON array of catalogue sample IDs.`);
  }

  const structurallyAllowed = new Set(computeRelayAllowedSampleIds(catalogue, { buildSamplePlan, requirementsFor }));
  const seen = new Set();
  const allowed = [];
  for (const [index, sampleId] of configured.entries()) {
    if (typeof sampleId !== 'string' || sampleId === '' || sampleId.trim() !== sampleId) {
      throw new TypeError(`${name}[${index}] must be a non-empty, unpadded sample ID.`);
    }
    if (!catalogue.byId.has(sampleId)) {
      throw new TypeError(`${name} contains unknown catalogue sample ID "${sampleId}".`);
    }
    if (!structurallyAllowed.has(sampleId)) {
      throw new TypeError(`${name} contains sample "${sampleId}", which is not read-only HTTP/assertion relay work.`);
    }
    if (seen.has(sampleId)) {
      throw new TypeError(`${name} contains duplicate sample ID "${sampleId}".`);
    }
    seen.add(sampleId);
    allowed.push(sampleId);
  }
  return Object.freeze(allowed);
}

/**
 * Validate an inbound `/execute` request against the catalogue and the
 * relay's own allow-list. Throws `RequestRefused` on any violation.
 *
 * @param {unknown} payload
 * @param {object} catalogue
 * @param {object} options
 * @param {string[]} options.relayAllowedSampleIds
 * @returns {{ sample, inputs, secretRefs, acknowledgement }}
 */
export function validateExecuteRequest(payload, catalogue, { relayAllowedSampleIds } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestRefused('The request body must be a JSON object.');
  }
  // Checked ahead of the generic member loop below so a caller sending
  // `secrets` gets the specific, actionable `secrets-not-accepted` code
  // instead of being lumped in with an arbitrary unrecognised member.
  if (Object.prototype.hasOwnProperty.call(payload, 'secrets')) {
    throw new RequestRefused(
      'This endpoint never accepts secret values; secrets are resolved server-side by the relay.',
      { code: 'secrets-not-accepted' },
    );
  }
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_MEMBERS.includes(key)) {
      throw new RequestRefused(
        `"${key}" is not a member this endpoint accepts. Only ${ALLOWED_MEMBERS.join(', ')} are recognised.`,
        { code: 'forbidden-member' },
      );
    }
  }

  // Reuse the exact-schema gate `/api/run` uses, with `secrets` forced empty:
  // no catalogue sample builder ever reads a secret's live value into a plan
  // (each declares `secretRef('gatewayAccess.apiKey', ...)` as a literal), so
  // an empty `secrets` map cannot cause a value to go missing from the plan.
  const { sample, inputs, acknowledgement } = validateRunRequest({ ...payload, secrets: {} }, catalogue);

  if (!Array.isArray(relayAllowedSampleIds) || !relayAllowedSampleIds.includes(sample.id)) {
    throw new RequestRefused(
      `"${sample.id}" is not enabled for relay execution. Only explicitly allow-listed, read-only samples run through the relay.`,
      { code: 'relay-sample-not-allowed', status: 403 },
    );
  }

  const rawSecretRefs = payload.secretRefs;
  if (rawSecretRefs !== undefined && !Array.isArray(rawSecretRefs)) {
    throw new RequestRefused('`secretRefs`, when present, must be an array of strings.', { code: 'invalid-secret-refs' });
  }
  // The canonical set is always recomputed from the sample's own declaration;
  // the caller's list (if any) is checked against it, never trusted outright.
  const canonicalSecretRefs = sample.configurationEntries.filter((entry) => entry.secret).map((entry) => entry.path);
  if (Array.isArray(rawSecretRefs)) {
    for (const ref of rawSecretRefs) {
      if (!canonicalSecretRefs.includes(ref)) {
        throw new RequestRefused(`"${ref}" is not a secret reference sample "${sample.id}" declares.`, {
          code: 'unknown-secret-ref',
        });
      }
    }
  }

  return { sample, inputs, secretRefs: canonicalSecretRefs, acknowledgement };
}

/**
 * Rebuild the plan for a validated relay request. Secret satisfaction is
 * deferred to the relay's own secret provider — never to a live value passed
 * through this call. `buildSamplePlan`'s own field validator (independent of
 * `hasSecret`) still requires *some* non-blank value for a required secret
 * field to consider it present; every catalogue sample builder embeds a
 * `secretRef(path, ...)` marker for secret-marked fields rather than
 * interpolating `read(path)`'s return value into a step, so a fixed,
 * non-caller-derived placeholder here can never reach an HTTP request, a log
 * line, or the built plan itself — see `src/catalogue/samples/*.mjs`.
 *
 * @param {{sample, inputs}} request
 * @param {object} catalogue
 * @param {object} deps
 * @param {Function} deps.buildSamplePlan
 * @param {Function} deps.requirementsFor
 */
export function rebuildRelayPlan({ sample, inputs }, catalogue, { buildSamplePlan, requirementsFor }) {
  const secretPlaceholders = Object.fromEntries(
    sample.configurationEntries.filter((entry) => entry.secret).map((entry) => [entry.path, RELAY_SECRET_PLACEHOLDER]),
  );
  const { plan, resolvedInputs } = rebuildPlan(
    { sample, inputs, secrets: secretPlaceholders },
    catalogue,
    { buildSamplePlan, requirementsFor, hasSecret: () => true },
  );
  const unsupported = plan.requiredStepTypes.filter((type) => !RELAY_SUPPORTED_STEP_TYPES.includes(type));
  if (unsupported.length > 0) {
    throw new RequestRefused(
      `"${sample.id}" requires step type(s) the relay does not run: ${unsupported.join(', ')}.`,
      { code: 'unsupported-step-type' },
    );
  }
  return { plan, resolvedInputs };
}
