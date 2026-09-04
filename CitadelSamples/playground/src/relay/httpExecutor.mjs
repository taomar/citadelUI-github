/**
 * The relay's execution core: `http` and `assertion` steps only.
 *
 * Deliberately independent of `src/server/localExecutor.mjs`. That module is
 * the loopback local executor and its imports (`transports.mjs`,
 * `registry.mjs`) pull in process-spawn, Azure CLI and filesystem-adjacent
 * code the relay must never expose. Rather than share a module and risk a
 * future edit to one silently affecting the other's security boundary, the
 * small amount of shared logic (URL/secret/binding resolution, response
 * capture, redaction) is reimplemented here, independently, against the same
 * pure `src/core/*` and `src/server/assertions.mjs` / `redaction.mjs` /
 * `parsing.mjs` modules the local executor also builds on.
 *
 * What it will NOT do, structurally: there is no `artifact`, `azure-cli` or
 * `library` case. An unsupported step type blocks the whole run before
 * anything is fetched.
 */

import { isSecretRef } from '../core/secrets.mjs';
import { parseHttpResponse, readHeader } from '../core/parsing.mjs';
import { evaluateAssertion } from '../server/assertions.mjs';
import { clip, createRedactor } from '../server/redaction.mjs';
import { RELAY_SUPPORTED_STEP_TYPES } from './requestSchema.mjs';
import { publicAssertionDetail, publicRunSummary, sanitizeAssertionEvidence } from './publicResult.mjs';

export const DEFAULT_RELAY_LIMITS = Object.freeze({
  stepTimeoutMs: 30_000,
  runTimeoutMs: 60_000,
  maxOutputBytes: 256 * 1024,
  maxResponseBytes: 512 * 1024,
  maxBurstRequests: 20,
  maxConcurrency: 4,
});

const BINDING = /\{\{steps\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\}\}/g;

/** Resolve `{{steps.x.y}}` tokens and `SecretRef`s into live values. */
function resolveValue(value, outputs, secrets) {
  if (isSecretRef(value)) {
    const resolved = secrets[value.ref];
    if (typeof resolved !== 'string' || resolved === '') {
      throw new Error(`Missing secret value for ${value.ref}.`);
    }
    return resolved;
  }
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{steps\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\}\}$/);
    if (whole) {
      const bound = outputs.get(`${whole[1]}.${whole[2]}`);
      return bound === undefined ? '' : bound;
    }
    return value.replace(BINDING, (_match, stepId, output) => {
      const bound = outputs.get(`${stepId}.${output}`);
      return bound === undefined ? '' : String(bound);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, outputs, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, outputs, secrets);
    return out;
  }
  return value;
}

function captureFrom(source, { response, parsed, jsonRpcBody }) {
  const spec = String(source);
  if (spec === 'response.status') return response.status;
  if (spec === 'response.body') return clip(parsed.text, 4000).text;
  if (spec === 'response.json') return parsed.data;
  if (spec === 'response.jsonrpc.result') return jsonRpcBody?.result ?? undefined;
  if (spec === 'response.jsonrpc.error') return jsonRpcBody?.error ?? undefined;
  const header = spec.match(/^response\.headers\['(.+)'\]$/);
  if (header) return readHeader(response.headers, header[1]) ?? '';
  return undefined;
}

function publicStep(record) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    state: record.state,
    durationMs: record.durationMs ?? 0,
    detail: record.detail ?? '',
    evidence: record.evidence ?? {},
    ...(record.assertion ? { assertion: record.assertion } : {}),
  };
}

/**
 * Fixed-schema public evidence for an `http` step.
 *
 * See `publicResult.mjs` for the full rationale behind treating EVERY
 * upstream-derived value as an exfiltration channel, not merely a raw or
 * transformed secret string: an HTTP status code, a byte/entry count, or a
 * boolean derived from a response header are each still entirely the
 * backend's own choice, and a compromised backend can use that choice
 * itself — which of several plausible status codes to answer with, whether
 * to set a given header, how many bytes/entries to return — to smuggle
 * information regardless of type. This function therefore never reads
 * `response`/`parsed` at all; it is built only from `request`, which is the
 * caller's OWN already-validated, server-rebuilt plan content (the HTTP
 * method the catalogue sample's `build()` chose, and — for a burst step
 * only — the repeat count/concurrency the caller's own validated request
 * configuration asked for, clamped to this executor's fixed bounds). Both
 * are already known to the caller before the step ever runs; neither is
 * observed from a response.
 *
 * @param {object} request the plan step's own (server-rebuilt) request spec
 * @param {{requested: number, concurrency: number}} [burst] present only
 *   for a burst step's own repeat configuration
 */
function publicHttpEvidence(request, burst) {
  const evidence = { method: request.method ?? (burst ? 'POST' : 'GET') };
  if (burst) {
    evidence.requested = burst.requested;
    evidence.concurrency = burst.concurrency;
  }
  return evidence;
}

/**
 * @param {object} options
 * @param {Function} [options.fetchImpl]      injected for tests; defaults to global fetch
 * @param {object} options.allowlist          from `createOriginAllowlist`
 * @param {object} options.requestPolicy      REQUIRED — from `createSampleRequestPolicy` / `deriveDefaultSampleRequestPolicy`. `server.mjs` already runs the same policy's `authorizeStaticPlan` against the whole rebuilt plan BEFORE any secret is resolved or this executor is ever called, so every LITERAL request URL and every plan-declared secret-bearing header name has already been authorized by the time `execute` runs. This module re-checks anyway, immediately before every actual fetch — covering the one thing the static check cannot: a URL that is still a `{{steps.x.y}}` binding at plan-rebuild time and only becomes a literal, fetchable URL once an earlier step's output is captured (a runtime-discovered/"secondary" URL). This parameter used to be optional, which meant that re-check could silently no-op if a caller ever assembled a tenant bundle whose `httpExecutor` was built without the tenant's `requestPolicy` — a structural drift `tenantPolicy.mjs`'s `assertBundle` did not catch either, since it only checked `bundle.requestPolicy` and `bundle.httpExecutor` independently, never that they were THE SAME object. It is required now precisely so that gap cannot exist: there is no code path left in which this check runs against nothing. Use `createRelayTenantBundle` (`tenantPolicy.mjs`) to build a bundle's `httpExecutor` and `requestPolicy` from one shared value, so they can never drift apart in the first place.
 * @param {object} [options.limits]
 */
export function createRelayHttpExecutor({ fetchImpl, allowlist, requestPolicy, limits = {} } = {}) {
  if (!allowlist || typeof allowlist.assertAllowed !== 'function') {
    throw new TypeError('createRelayHttpExecutor requires an origin allowlist (see originAllowlist.mjs).');
  }
  if (
    !requestPolicy ||
    typeof requestPolicy.authorizeRequestUrl !== 'function' ||
    typeof requestPolicy.authorizeHeaderNames !== 'function'
  ) {
    throw new TypeError(
      'createRelayHttpExecutor requires a requestPolicy (see createSampleRequestPolicy / deriveDefaultSampleRequestPolicy) carrying authorizeRequestUrl/authorizeHeaderNames — every runtime-bound request is re-checked against it immediately before it is sent, and that check must never be able to silently no-op.',
    );
  }
  const bounds = { ...DEFAULT_RELAY_LIMITS, ...limits };
  const doFetch = fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch) {
    throw new TypeError('createRelayHttpExecutor requires a fetch implementation.');
  }

  async function fetchOnce({ url, method, headers, body, timeoutMs, signal }) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
        // A destination must not be able to bounce this request anywhere
        // else — including to a host outside the allowlist.
        redirect: 'error',
      });
      const text = await readBounded(response, bounds.maxResponseBytes);
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      const aborted = signal?.aborted;
      return {
        error: aborted
          ? 'Cancelled.'
          : error?.name === 'AbortError'
            ? `Timed out after ${Math.round(timeoutMs / 1000)}s.`
            : String(error?.message ?? error),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Re-check the request policy immediately before a fetch. Throws — the
   * per-step try/catch in `execute` turns this into a clean `failed` step
   * record, exactly like the existing "Missing secret value" failure mode.
   * `requestPolicy` is guaranteed present (constructor-enforced above), so,
   * unlike before, this can never silently no-op.
   */
  function enforceRequestPolicy(sampleId, stepId, url, secretHeaderNames) {
    const urlCheck = requestPolicy.authorizeRequestUrl(sampleId, stepId, url.toString());
    if (!urlCheck.ok) {
      // Deliberately a FIXED message, never `urlCheck.message` (which embeds
      // the actual resolved URL): this check runs for every step, including
      // one whose URL is a runtime `{{steps.x.y}}` binding resolved from an
      // EARLIER step's own captured response — content a policy-approved
      // but malicious/compromised backend fully controls. Reflecting that
      // resolved URL back to the caller here, even only inside a rejection
      // message and never assertion evidence, would be exactly the kind of
      // upstream-derived leak `publicResult.mjs` exists to prevent
      // elsewhere; this is the one place that sanitizer does not already
      // cover, since it is a thrown Error's message on the http-step path,
      // not assertion evidence. A STATIC, caller-supplied URL refused by the
      // very same check is already surfaced to the caller with its literal
      // value by `requestSchema.mjs`'s pre-execution `authorizeStaticPlan`
      // call in `server.mjs` — that value is safe to name because the
      // caller already supplied it, so this generic message here does not
      // regress that diagnostic; it only removes the runtime/upstream case.
      throw new Error(`Refused by this tenant's request policy: step "${stepId}"'s request is not one of its authorized URLs.`);
    }
    const headerCheck = requestPolicy.authorizeHeaderNames(sampleId, stepId, secretHeaderNames);
    // Header NAMES, unlike the URL above, are always chosen at plan-BUILD
    // time (a catalogue sample builder never binds a header name to a
    // runtime capture) — see requestPolicy.mjs's own doc comment — so this
    // one is always exactly what the caller's own request already named,
    // never upstream response content, and safe to include verbatim.
    if (!headerCheck.ok) throw new Error(headerCheck.message);
  }

  /**
   * `originAllowlist.mjs`'s `assertAllowed` throws messages that
   * intentionally embed the raw/parsed URL text and, for a malformed one,
   * the ENTIRE raw string it was given verbatim (see its own doc comment) —
   * genuinely useful when checking a STATIC, caller-supplied URL, which is
   * exactly what `server.mjs`'s pre-execution destination-origin check
   * already does before any secret is resolved or this executor ever runs.
   * But `rawUrl` here can just as easily be a runtime-bound
   * (`{{steps.x.y}}`) URL resolved from an EARLIER step's own captured
   * response — content a policy-approved but compromised backend fully
   * controls. Reflecting that raw text back in a thrown message here would
   * be exactly the upstream-derived leak `publicResult.mjs` and
   * `enforceRequestPolicy`'s own discarded message already exist to
   * prevent elsewhere; this is simply the one call site that predates
   * those. Discard whatever `assertAllowed` says and report one fixed,
   * non-parameterised refusal instead — the specific diagnostic for a
   * STATIC URL remains available at plan-rebuild time, unaffected.
   */
  function assertUrlAllowed(step, rawUrl) {
    try {
      return allowlist.assertAllowed(rawUrl);
    } catch {
      throw new Error(`Refused: step "${step.id}"'s request URL is malformed or is not one of the configured allowed destinations.`);
    }
  }

  async function runHttp(step, { sampleId, outputs, secrets, redactor, signal }) {
    const request = step.request ?? {};
    const rawUrl = resolveValue(request.url, outputs, secrets);
    const url = assertUrlAllowed(step, rawUrl);
    // Secret-bearing header NAMES must be read off the UNRESOLVED headers —
    // `resolveValue` below replaces each `SecretRef` marker with its live
    // string value, which would make `isSecretRef` return false for exactly
    // the header this check most needs to see.
    const secretHeaderNames = Object.entries(request.headers ?? {})
      .filter(([, value]) => isSecretRef(value))
      .map(([name]) => name);
    enforceRequestPolicy(sampleId, step.id, url, secretHeaderNames);
    const headers = resolveValue(request.headers ?? {}, outputs, secrets);
    const body =
      request.body === undefined || request.body === null
        ? undefined
        : typeof request.body === 'string'
          ? resolveValue(request.body, outputs, secrets)
          : JSON.stringify(resolveValue(request.body, outputs, secrets));
    const timeoutMs = Math.min((request.timeoutSeconds ?? 30) * 1000, bounds.stepTimeoutMs);

    if (request.repeat) {
      return runBurst(step, { url, headers, body, request, outputs, redactor, signal, sampleId, secretHeaderNames });
    }

    const response = await fetchOnce({ url, method: request.method ?? 'GET', headers, body, timeoutMs, signal });
    if (response.error) {
      return {
        id: step.id,
        kind: 'http',
        title: step.title,
        state: signal?.aborted ? 'cancelled' : 'failed',
        detail: redactor.text(response.error),
        evidence: publicHttpEvidence(request),
      };
    }
    const parsed = parseHttpResponse({ status: response.status, headers: response.headers, text: response.text });
    const jsonRpcBody = parsed.format === 'sse' ? parsed.data : parsed.format === 'json' ? parsed.data : null;

    for (const [name, source] of Object.entries(request.capture ?? {})) {
      outputs.set(`${step.id}.${name}`, captureFrom(source, { response, parsed, jsonRpcBody }));
    }
    for (const produced of step.produces ?? []) {
      const key = `${step.id}.${produced}`;
      if (!outputs.has(key)) outputs.set(key, undefined);
    }
    const ok = response.status >= 200 && response.status < 300;
    return {
      id: step.id,
      kind: 'http',
      title: step.title,
      state: ok ? 'completed' : 'failed',
      // Fixed, non-parameterised text — never the raw status code or the
      // transport-chosen format classification, both entirely the backend's
      // own choice and, like `evidence` below, each an independent channel
      // a compromised backend can use to encode information regardless of
      // whether it ever places a raw/transformed secret STRING anywhere.
      // `state` above already carries the one classification this step
      // needs to report, exactly as an assertion's `status` does.
      detail: ok ? 'The request completed.' : 'The request did not complete successfully.',
      jsonRpcBody,
      evidence: publicHttpEvidence(request),
    };
  }

  async function runBurst(step, { url, headers, body, request, outputs, redactor, signal, sampleId, secretHeaderNames }) {
    const count = Math.min(Number(request.repeat.count) || 1, bounds.maxBurstRequests);
    const concurrency = Math.max(1, Math.min(Number(request.repeat.concurrency) || 1, bounds.maxConcurrency));
    const timeoutMs = Math.min((request.repeat.timeoutSeconds ?? 30) * 1000, bounds.stepTimeoutMs);
    const statusCodes = new Array(count).fill(0);
    const errors = [];
    let next = 0;

    async function worker() {
      while (next < count) {
        if (signal?.aborted) return;
        const index = next++;
        try {
          enforceRequestPolicy(sampleId, step.id, url, secretHeaderNames);
        } catch (error) {
          statusCodes[index] = 0;
          if (errors.length < 20) errors.push(redactor.text(error?.message ?? String(error)));
          continue;
        }
        const response = await fetchOnce({ url, method: request.method ?? 'POST', headers, body, timeoutMs, signal });
        if (response.error) {
          statusCodes[index] = 0;
          if (errors.length < 20) errors.push(redactor.text(response.error));
        } else {
          statusCodes[index] = response.status;
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    outputs.set(`${step.id}.statusCodes`, statusCodes);
    outputs.set(`${step.id}.errors`, errors);
    return {
      id: step.id,
      kind: 'http',
      title: step.title,
      state: signal?.aborted ? 'cancelled' : 'completed',
      detail: `${count} request(s) at concurrency ${concurrency}.`,
      evidence: publicHttpEvidence(request, { requested: count, concurrency }),
    };
  }

  async function runAssertion(step, context) {
    const result = evaluateAssertion(step, context);
    for (const [name, value] of Object.entries(result.outputs ?? {})) {
      if (!step.produces.includes(name)) {
        throw new Error(`Assertion "${step.id}" produced undeclared output "${name}".`);
      }
      context.outputs.set(`${step.id}.${name}`, value);
    }
    // The relay crosses a trust boundary the local/browser executor never
    // does: a request-policy-approved destination is still whatever the
    // deployed backend chooses to answer with, and a malicious or
    // compromised one can transform a resolved secret (base64, reversal,
    // wrapping in other text) before echoing it back inside an evaluator's
    // own `evidence`/`detail` — defeating `redaction.mjs`'s exact-value and
    // fixed-shape matching, which can only ever catch the literal secret or
    // a handful of known credential shapes. `publicAssertionDetail` and
    // `sanitizeAssertionEvidence` (see publicResult.mjs) are the relay-only,
    // fail-closed gate: they replace `detail` with a fixed sentence chosen
    // solely by `status`, and keep only booleans/bounded numbers out of
    // `evidence`, dropping every string/array/object that could carry
    // upstream response content — regardless of which assertion kind ran or
    // whether it passed or failed.
    const detail = publicAssertionDetail(result.status);
    const evidence = sanitizeAssertionEvidence(result.evidence);
    return {
      id: step.id,
      kind: 'assertion',
      title: step.title,
      state: result.status === 'passed' ? 'completed' : result.status === 'failed' ? 'failed' : 'inconclusive',
      assertion: {
        id: step.id,
        status: result.status,
        detail,
        evidence,
      },
      detail,
      evidence,
      configurationUpdates: result.configurationUpdates ?? {},
    };
  }

  /**
   * @param {object} plan          server-rebuilt plan; only http/assertion steps
   * @param {object} context       { secrets: {ref: value}, signal }
   */
  async function execute(plan, context) {
    const { secrets = {}, signal } = context;
    const unsupported = (plan.requiredStepTypes ?? []).filter((type) => !RELAY_SUPPORTED_STEP_TYPES.includes(type));
    const redactor = createRedactor(Object.values(secrets).filter((value) => typeof value === 'string'));
    if (unsupported.length > 0) {
      return {
        state: 'blocked',
        sampleId: plan.sampleId,
        summary: 'Not run — this sample requires a step type the relay does not execute.',
        detail: `Unsupported step types: ${unsupported.join(', ')}.`,
        steps: [],
        assertions: [],
        configurationUpdates: {},
        secretUpdates: {},
        meta: { executor: 'relay-core', unsupportedStepTypes: unsupported },
      };
    }

    const outputs = new Map();
    const stepResults = [];
    const configurationUpdates = {};
    const secretUpdates = {};
    const startedAt = Date.now();

    for (const step of plan.steps) {
      if (signal?.aborted) {
        stepResults.push({ id: step.id, kind: step.type, title: step.title, state: 'cancelled', durationMs: 0, evidence: {} });
        break;
      }
      if (Date.now() - startedAt > bounds.runTimeoutMs) {
        stepResults.push({
          id: step.id,
          kind: step.type,
          title: step.title,
          state: 'failed',
          durationMs: 0,
          detail: `The run exceeded its ${Math.round(bounds.runTimeoutMs / 1000)}s budget before this step started.`,
          evidence: {},
        });
        break;
      }
      const began = Date.now();
      let record;
      try {
        if (step.type === 'http') {
          record = await runHttp(step, { sampleId: plan.sampleId, outputs, secrets, redactor, signal });
        } else if (step.type === 'assertion') {
          record = await runAssertion(step, { assertion: step.assertion, step, outputs, stepResults, redactor });
        } else {
          throw new Error(`Step type "${step.type}" is not executable by the relay.`);
        }
      } catch (error) {
        record = {
          id: step.id,
          kind: step.type,
          title: step.title,
          state: signal?.aborted ? 'cancelled' : 'failed',
          detail: redactor.text(error?.message ?? String(error)),
          evidence: {},
        };
      }
      record.durationMs = Date.now() - began;
      Object.assign(configurationUpdates, record.configurationUpdates ?? {});
      Object.assign(secretUpdates, record.secretUpdates ?? {});
      for (const value of Object.values(record.secretUpdates ?? {})) redactor.add(value);
      stepResults.push(record);
      if (record.state !== 'completed' && record.state !== 'skipped') break;
    }

    return summarise({ plan, stepResults, configurationUpdates, secretUpdates, redactor, signal, startedAt });
  }

  // `requestPolicy` is exposed by reference (not copied/re-wrapped) so a
  // caller — specifically `tenantPolicy.mjs`'s `assertBundle` — can prove,
  // with a plain `===`, that this executor's runtime re-check and a bundle's
  // own `requestPolicy` are the exact same object, never two independently
  // constructed ones that merely happen to look similar.
  return Object.freeze({ execute, limits: bounds, requestPolicy });
}

async function readBounded(response, limitBytes) {
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
      total += chunk.byteLength;
      if (total > limitBytes) {
        await reader.cancel('response limit exceeded').catch(() => {});
        throw new Error(`The response exceeded the ${limitBytes}-byte limit.`);
      }
      text += decoder.decode(chunk, { stream: true });
    }
    return `${text}${decoder.decode()}`;
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf-8') > limitBytes) {
      throw new Error(`The response exceeded the ${limitBytes}-byte limit.`);
    }
    return text;
  }
  return '';
}

function summarise({ plan, stepResults, configurationUpdates, secretUpdates, redactor, signal, startedAt }) {
  const steps = stepResults.map(publicStep);
  const assertions = stepResults.filter((step) => step.assertion).map((step) => step.assertion);
  const failed = stepResults.filter((step) => step.state === 'failed');
  const blocked = stepResults.filter((step) => step.state === 'blocked');
  const cancelled = signal?.aborted || stepResults.some((step) => step.state === 'cancelled');
  const inconclusive = assertions.filter((assertion) => assertion.status === 'inconclusive');
  const ran = stepResults.length;
  const expected = plan.steps.length;

  // `publicRunSummary` is the same fail-closed, relay-only sanitizer used for
  // per-step assertion evidence (see publicResult.mjs). The `failed`/`blocked`
  // branches only ever name step TITLES or a fixed internal message — both
  // come from the server-rebuilt plan/catalogue, never from a response — so
  // they were already safe. The `inconclusive` branch previously joined each
  // inconclusive assertion's (potentially upstream-tainted) `detail` text
  // straight into this always-serialized field; it is now a bounded count.
  let state = 'completed';
  if (cancelled) state = 'cancelled';
  else if (blocked.length > 0) state = 'blocked';
  else if (failed.length > 0) state = 'failed';
  else if (ran < expected) state = 'inconclusive';
  else if (inconclusive.length > 0) state = 'inconclusive';

  const summary = publicRunSummary({
    state,
    ran,
    expected,
    failedTitles: failed.map((step) => step.title),
    blockedDetail: blocked[0]?.detail,
    inconclusiveCount: inconclusive.length,
  });

  return {
    state,
    sampleId: plan.sampleId,
    summary: redactor.text(summary),
    detail: '',
    steps,
    assertions,
    configurationUpdates,
    secretUpdates,
    meta: {
      executor: 'relay-core',
      durationMs: Date.now() - startedAt,
      stepsRun: ran,
      stepsPlanned: expected,
    },
  };
}
