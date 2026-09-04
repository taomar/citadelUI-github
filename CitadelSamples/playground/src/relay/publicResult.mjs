/**
 * Public-evidence projection for the relay's execution result.
 *
 * `src/server/assertions.mjs` exists to describe, to a TRUSTED, same-origin,
 * browser-driven LOCAL run, exactly what an assertion observed — so its
 * evidence/detail freely embed upstream-derived strings verbatim: a tool
 * name, a JSON-RPC error message, an A2A card field, a captured payload
 * value. That is correct for the local executor, which never crosses a
 * trust boundary the operator does not already control end to end.
 *
 * The relay is different. A request-policy-approved, allow-listed
 * destination is still, ultimately, whatever the deployed gateway/backend
 * chooses to answer with — and a malicious or compromised backend can
 * encode a resolved secret into that answer in far more shapes than an
 * earlier version of this module accounted for. It is not only strings: a
 * boolean can carry one bit; a bounded number's exact value is itself a
 * channel (an HTTP status code, a byte count, a status-histogram bucket); an
 * array's LENGTH or ORDER is a channel independent of its contents; an
 * object's KEY NAMES are a channel independent of its values (the backend
 * chooses what to call a field, not just what to put in it). A recursive
 * sanitizer that decides, field by field, purely by TYPE, which values are
 * "safe" — keeping every boolean/bounded-number/array/object it has no
 * specific reason to distrust — still hands a compromised backend a rich,
 * arbitrarily-shaped channel: it can choose which of several
 * legitimate-looking status codes to answer with, whether to set a header
 * the relay turns into a boolean, how many bytes/entries something
 * contains, or which of several field names to use, and repeat that choice
 * across many steps to exfiltrate secret bits a handful at a time — none of
 * which requires placing a raw or transformed secret STRING anywhere. The
 * earlier type-based recursive design here only ever protected against that
 * one shape.
 *
 * This module is the relay's only path from an internal, richly-detailed
 * execution result to the one actually placed on the wire, and it no longer
 * tries to sanitize upstream-controlled content by inspecting its shape.
 * Public evidence is not derived from upstream content AT ALL: it is a
 * FIXED, explicit projection assembled entirely from values already known
 * to be trusted — the assertion's own `status` (this module's own fixed
 * classification), and, for an `http` step's own evidence (built directly
 * in `httpExecutor.mjs`; see `publicHttpEvidence` there), catalogue/plan-
 * declared request metadata such as the HTTP method — never anything read
 * out of a response body, header, or status line. Any future field a
 * particular assertion kind or step wants to expose requires a dedicated,
 * explicitly reviewed, hard-coded addition here or at the call site — never
 * a generic "keep it if it type-checks" rule, and never a value copied or
 * derived from response content, no matter how small, bounded, or
 * innocuous-looking it appears.
 */

const ASSERTION_STATUS_DETAIL = Object.freeze({
  passed: 'The assertion passed.',
  failed: 'The assertion failed.',
  inconclusive: 'The assertion result was inconclusive.',
});

/**
 * Public evidence for an assertion step: always empty.
 *
 * No assertion kind's evidence is trusted here, regardless of shape — an
 * evaluator's `evidence` object is built from response content (a captured
 * payload, a JSON-RPC body, a card field, a tool list, a status code), and
 * every one of those values, including a boolean or a bounded number, is a
 * channel a compromised backend fully controls. The caller already gets the
 * one fact that matters — the assertion's pass/failed/inconclusive verdict,
 * via `assertion.status` — from this module's own fixed classification,
 * never from anything upstream. Nothing else is exposed.
 *
 * @param {unknown} _evidence ignored — accepted only so call sites read
 *   naturally; no evaluator's evidence is ever inspected, let alone copied.
 */
export function sanitizeAssertionEvidence(_evidence) {
  return {};
}

/**
 * The public `detail` for an assertion result: a fixed, non-parameterised
 * sentence chosen only by `status` — never a template filled in with
 * anything the assertion observed. This is unconditional: even a FAILED
 * assertion's detail is never shown verbatim, because a backend can
 * deliberately fail an assertion (e.g. by omitting an expected field) while
 * still placing an encoded secret in the very `detail`/`evidence` a naive
 * relay would otherwise consider "just an explanation of the failure".
 */
export function publicAssertionDetail(status) {
  return ASSERTION_STATUS_DETAIL[status] ?? ASSERTION_STATUS_DETAIL.inconclusive;
}

/**
 * The public, wire-safe form of a single step record's `detail`/`evidence`.
 *
 * `http` steps pass through unchanged here — their evidence is already
 * built from trusted, catalogue/plan-declared request metadata only (see
 * `publicHttpEvidence` in `httpExecutor.mjs`, which actually constructs a
 * live `http` step's evidence at the source), never a value read out of the
 * response, so there is nothing left for this function to remove. Assertion
 * steps are rebuilt from nothing but their `status`.
 */
export function publicizeStepRecord(record) {
  if (record.kind !== 'assertion') return record;
  const detail = publicAssertionDetail(record.assertion?.status ?? 'inconclusive');
  const evidence = sanitizeAssertionEvidence(record.evidence);
  return {
    ...record,
    detail,
    evidence,
    ...(record.assertion
      ? { assertion: { ...record.assertion, detail, evidence: sanitizeAssertionEvidence(record.assertion.evidence) } }
      : {}),
  };
}

/**
 * The public, wire-safe form of the run-level `summary` string. The
 * existing `failed` branch already only ever names step TITLES — which
 * come from the server-rebuilt plan (the catalogue's own declaration), never
 * from a response — so it is safe as-is and reused unchanged. The
 * `inconclusive` branch previously joined each inconclusive assertion's
 * `detail`, which is exactly the upstream-derived text this module exists
 * to keep off the wire; it is replaced with a bounded count only.
 */
export function publicRunSummary({ state, ran, expected, failedTitles, blockedDetail, inconclusiveCount }) {
  switch (state) {
    case 'cancelled':
      return `Cancelled after ${ran} of ${expected} step(s).`;
    case 'blocked':
      return blockedDetail || 'A required capability is missing, so the sample was not run.';
    case 'failed':
      return `${failedTitles.length} step(s) failed: ${failedTitles.join('; ')}.`;
    case 'inconclusive':
      return ran < expected
        ? `Only ${ran} of ${expected} step(s) ran.`
        : `${inconclusiveCount} assertion(s) could not be decided.`;
    default:
      return `All ${ran} step(s) ran and every assertion passed.`;
  }
}
