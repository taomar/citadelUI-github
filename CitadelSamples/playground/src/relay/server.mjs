/**
 * The standalone relay: a deployable HTTP surface with no local execution
 * capability.
 *
 * This is the thing the local proxy forwards to. It never imports
 * `transports.mjs`, `workspace.mjs`, `registry.mjs` or
 * `localExecutor.mjs`, so it cannot spawn a process, write an artifact, run
 * the Python library adapter, or shell out to the Azure CLI even by mistake —
 * those modules simply are not reachable from here. What it CAN do is make an
 * allow-listed `https` request and evaluate an assertion over the response.
 *
 * Every request goes through, in order:
 *   1. global process admission — direct `/execute` is refused with 429 when
 *      the configured concurrent-request cap is already occupied
 *   2. principal authentication (the caller must present a credential the
 *      relay's authenticator accepts — see `principalAuth.mjs`) resolving a
 *      full `{ principal, tenant, roles }` context, never discarded — a
 *      non-loopback caller with no non-empty principal AND tenant is refused
 *      here, before anything else runs
 *   3. a body-size limit
 *   4. tenant-policy resolution (`tenantPolicy.mjs`) — the authenticated
 *      `{ tenant, principal, roles }` is mapped, server-side, to the exact
 *      bundle of resources THIS tenant may use: its own allowed sample ids,
 *      its own destination-origin allowlist/http executor pair, and its own
 *      logical secret provider. An unknown tenant, or one whose roles do not
 *      satisfy the bundle's gate, is refused here — before schema
 *      validation, before secret access, before any network call
 *   5. exact-schema validation against THIS tenant's own allow-list
 *      (`requestSchema.mjs`)
 *   6. plan reconstruction from the relay's OWN catalogue copy
 *   7. a proactive destination check: every literal destination origin the
 *      rebuilt plan would contact must already be in THIS tenant's own
 *      origin allowlist — checked here, before any secret is resolved,
 *      so a request for an out-of-tenant destination never reaches the
 *      secret provider or the network at all
 *   8. a per-sample/per-step request-policy check (`requestPolicy.mjs`) —
 *      origin-only authorization cannot tell a tenant-approved route from a
 *      caller-controlled path/header on the SAME allowed origin, so every
 *      literal request URL and every secret-bearing header NAME the rebuilt
 *      plan carries must also match THIS tenant's own, server-selected
 *      per-sample/per-step policy — checked here, still before any secret
 *      is resolved
 *   9. acknowledgement binding verification — the acknowledgement must name
 *      THIS sample, THIS exact request URL set (the same one the request
 *      policy above just approved), THIS authenticated caller and tenant,
 *      and a canonical digest of THESE inputs, and must not have expired
 *      (`acknowledgement.mjs`) — checked against the relay's own rebuilt
 *      view and its own resolved authentication, never against anything the
 *      caller merely asserts
 *  10. single-use nonce consumption (replay/freshness — `nonceStore.mjs`),
 *      only once the binding above has already passed, so a malformed or
 *      mismatched request never spends a nonce it was not entitled to use
 *  11. secret resolution through the tenant's own injected provider (never
 *      the caller's choice of vault/secret name)
 *  12. execution through the tenant's own http/assertion-only core
 *      (`httpExecutor.mjs`), which re-checks every URL AND every
 *      secret-bearing header name — including ones discovered via
 *      `{{steps.x.y}}` bindings — against that same destination allowlist
 *      and request policy
 *
 * Every external boundary this handler crosses (the tenant policy resolver,
 * the secret provider — which itself bounds the managed-identity token
 * request and the Key Vault fetch it makes — the http executor, and — one
 * level up, in the `node:http` listener below — the authenticator) is
 * wrapped so an unexpected exception from any of them (a managed-identity
 * token fetch failing, a Key Vault outage, a misbehaving injected
 * dependency) always produces a controlled, redacted JSON response instead
 * of an unhandled promise rejection or a socket left open with nothing ever
 * written to it. A single run-level deadline, started immediately after
 * global admission — before authentication or the request body — bounds the
 * ENTIRE request, and its `AbortSignal` is used across authentication, the
 * bounded body read, tenant-policy resolution, acknowledgement, secret
 * resolution, execution, and the response so none of those phases can hold
 * an admission slot past that budget.
 *
 * Passing `signal` down is not, by itself, sufficient: an injected
 * dependency that ignores its `signal` argument entirely (never listens for
 * `'abort'`, never checks `.aborted`) would otherwise hang this handler
 * forever even after the deadline fires, since nothing forces its own
 * promise to settle. Each of the three boundary calls above is therefore
 * additionally RACED against the same `signal` with `raceDeadline` (see
 * `deadline.mjs`) — if the dependency's own promise has not settled by the
 * time the signal fires, this handler moves on immediately to the fixed
 * `runTimeoutResponse()` regardless, and the abandoned promise's eventual
 * settlement (however late) is still observed so it can never surface as an
 * unhandled rejection.
 */

import { createServer } from 'node:http';

import { CATALOGUE, buildSamplePlan, requirementsFor } from '../catalogue/index.mjs';
import { EXECUTION_STATES } from '../core/types.mjs';
import { RequestRefused } from '../server/runRequest.mjs';
import { rebuildRelayPlan, validateExecuteRequest } from './requestSchema.mjs';
import { authenticatePrincipal } from './principalAuth.mjs';
import { createNonceStore } from './nonceStore.mjs';
import { canonicalInputDigest, planDestinationOrigins, planRequestUrls, verifyAcknowledgement } from './acknowledgement.mjs';
import { abortError, raceDeadline, DEADLINE_EXCEEDED } from './deadline.mjs';
import { DEFAULT_RELAY_SERVER_LIMITS, validateRelayServerLimits } from './limits.mjs';

/** Acknowledgement-binding failure codes that are a client-fixable request problem, not a policy refusal. */
const ACKNOWLEDGEMENT_BAD_REQUEST_CODES = new Set(['acknowledgement-required', 'nonce-required', 'acknowledgement-malformed', 'acknowledgement-not-yet-valid']);

const DEFAULT_BODY_LIMIT_BYTES = DEFAULT_RELAY_SERVER_LIMITS.bodyLimitBytes;
const DEFAULT_RUN_TIMEOUT_MS = DEFAULT_RELAY_SERVER_LIMITS.runTimeoutMs;

function securityHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

function managedRunIdFromPath(requestPath, runsPath) {
  const match = requestPath.match(new RegExp(`^${runsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(run_[A-Za-z0-9_-]{24,128})(?:/cancel)?$`));
  return match?.[1] ?? null;
}

function durableAcknowledgement(acknowledgement) {
  if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) return acknowledgement;
  // `verifyAcknowledgement` validates these values again immediately before
  // execution. Copying only its fixed vocabulary prevents arbitrary extra
  // caller data from becoming durable run-state.
  const fields = ['accepted', 'sampleId', 'caller', 'tenant', 'target', 'inputDigest', 'riskText', 'issuedAt', 'expiresAt', 'nonce'];
  return Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(acknowledgement, field)).map((field) => [field, acknowledgement[field]]));
}

async function canonicalizeManagedRunRequest(payload, { catalogue, tenantPolicy, auth, runTimeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runTimeoutMs);
  try {
    const bundle = await raceDeadline(
      tenantPolicy.resolve({ tenant: auth.tenant, principal: auth.principal, roles: auth.roles, signal: controller.signal }),
      controller.signal,
    );
    if (bundle === DEADLINE_EXCEEDED) {
      throw new RequestRefused('The tenant policy could not be resolved within the run-time budget.', {
        status: 504,
        code: 'run-timeout',
      });
    }
    if (!bundle) {
      throw new RequestRefused('This tenant is not authorized to use the relay.', { status: 403, code: 'tenant-not-authorized' });
    }
    const { sample, inputs, secretRefs, acknowledgement } = validateExecuteRequest(payload, catalogue, {
      relayAllowedSampleIds: bundle.allowedSampleIds,
    });
    return {
      requestDigest: canonicalInputDigest({ sampleId: sample.id, inputs, secretRefs }),
      bundle,
      sample,
      inputs,
      secretRefs,
      auth,
      // Keep only this canonical, exact-schema request in the job closure. It
      // is never stored and is independently validated again when it runs.
      payload: {
        protocolVersion: payload.protocolVersion,
        sampleId: sample.id,
        inputs,
        secretRefs,
        acknowledgement: durableAcknowledgement(acknowledgement),
      },
    };
  } catch (error) {
    if (error instanceof RequestRefused) throw error;
    if (controller.signal.aborted) {
      throw new RequestRefused('The tenant policy could not be resolved within the run-time budget.', { status: 504, code: 'run-timeout' });
    }
    throw new RequestRefused('The tenant policy could not be resolved.', { status: 502, code: 'tenant-policy-unavailable' });
  } finally {
    clearTimeout(timer);
  }
}

function blockedResult(sampleId, summary, detail = '') {
  return { state: 'blocked', sampleId, summary, detail, steps: [], assertions: [], configurationUpdates: {}, secretUpdates: {}, meta: {} };
}

function readBody(request, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        request.pause();
        settle(
          reject,
          new RequestRefused(`The request body is larger than the ${limitBytes}-byte limit.`, { status: 413 }),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(resolve, Buffer.concat(chunks).toString('utf-8'));
    const onAborted = () => settle(reject, abortError('The request body upload was aborted.'));
    const onError = (error) => settle(reject, error);

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
    if (request.aborted || request.destroyed) onAborted();
  });
}

function writeBodyReadError(request, response, error) {
  if (response.destroyed || response.writableEnded) return;
  const status = error instanceof RequestRefused ? error.status : 400;
  const headers = error instanceof RequestRefused
    ? { ...securityHeaders(), Connection: 'close' }
    : securityHeaders();
  if (error instanceof RequestRefused) response.once('finish', () => request.destroy());
  response.writeHead(status, headers);
  response.end(JSON.stringify({ state: 'blocked', summary: error?.message ?? 'Malformed request body.' }));
}

function monitorClientDisconnect(request, response, { timeoutMs } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => {
    if (!response.writableEnded) controller.abort();
  };
  const timer = timeoutMs == null
    ? null
    : setTimeout(() => {
        timedOut = true;
        abort();
      }, timeoutMs);
  request.once('aborted', abort);
  response.once('close', abort);
  request.socket?.once('close', abort);
  if (request.aborted || response.destroyed || request.socket?.destroyed) controller.abort();
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      request.off('aborted', abort);
      response.off('close', abort);
      request.socket?.off('close', abort);
    },
  };
}

function finishStoppedExecuteRequest(request, response, lifetime) {
  if (!lifetime.signal.aborted) return false;
  if (lifetime.timedOut && !response.destroyed && !response.writableEnded) {
    if (response.headersSent) {
      response.destroy();
    } else {
      const timeout = runTimeoutResponse();
      response.once('finish', () => request.destroy());
      response.writeHead(timeout.status, { ...securityHeaders(), Connection: 'close' });
      response.end(JSON.stringify(timeout.body));
    }
  }
  return true;
}

/**
 * The pure request handler, independent of `node:http`, so tests can drive it
 * directly with a plain object instead of a socket.
 *
 * @param {object} payload             parsed JSON body
 * @param {object} deps
 * @param {object} deps.catalogue
 * @param {object} deps.tenantPolicy      `{ resolve({tenant, principal, roles, signal}) -> Promise<bundle|null> }`
 *        A custom, directory-backed implementation should honor `signal` —
 *        see the run-deadline note below.
 * @param {{principal:string, tenant:string, roles?:string[]}} deps.auth
 *        the ALREADY-authenticated caller context (see `principalAuth.mjs`).
 *        `principal` and `tenant` must be non-empty strings — this function
 *        refuses closed, before any tenant-policy lookup, if either is
 *        missing, rather than resolving a policy for an empty/`null` tenant.
 * @param {object} deps.nonceStore        from `createNonceStore`
 * @param {number} [deps.runTimeoutMs]
 * @param {() => number} [deps.now]     injectable for tests (acknowledgement expiry)
 * @param {AbortSignal} [deps.deadlineSignal] optional already-armed full-request deadline
 *        supplied by `createRelayServer` immediately after admission. When
 *        present, this function does not start a second run timer.
 * @param {AbortSignal} [deps.externalSignal]  optional caller-disconnect signal
 *        for callers that do not already own `deadlineSignal` — firing it
 *        ends the run exactly like the deadline below firing.
 *
 * When the HTTP listener has already armed `deadlineSignal`, this function
 * continues that exact budget instead of starting another timer. Other
 * callers get one run-level deadline here, before tenant policy or secrets.
 * The resulting signal is threaded through every external boundary this
 * function crosses: `tenantPolicy.resolve`, `secretProvider.resolve` (which
 * bounds its own managed-identity and Key Vault calls — see
 * `managedIdentity.mjs` / `secretProvider.mjs`), and
 * `httpExecutor.execute`.
 *
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handleExecuteRequest(payload, deps) {
  const {
    catalogue,
    tenantPolicy,
    auth,
    nonceStore,
    runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    now = () => Date.now(),
    deadlineSignal,
    externalSignal,
    admitted = false,
  } = deps;

  if (!auth || typeof auth.principal !== 'string' || auth.principal === '' || typeof auth.tenant !== 'string' || auth.tenant === '') {
    return {
      status: 401,
      body: { state: 'blocked', summary: 'Not run — the caller could not be authenticated.', code: 'unauthenticated' },
    };
  }

  // The HTTP listener supplies an already-armed deadline immediately after
  // admission. Pure/managed callers that do not supply one get exactly one
  // timer here. Additional cancellation signals join the same controller
  // without creating another deadline.
  const controller = new AbortController();
  const timer = deadlineSignal ? null : setTimeout(() => controller.abort(), runTimeoutMs);
  const onAbort = () => controller.abort();
  const abortSources = [...new Set([deadlineSignal, externalSignal].filter(Boolean))];
  for (const source of abortSources) {
    if (source.aborted) controller.abort();
    else source.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await handleAuthenticatedExecuteRequest(payload, {
      catalogue,
      tenantPolicy,
      auth,
      nonceStore,
      now,
      signal: controller.signal,
      admitted,
    });
  } finally {
    if (timer) clearTimeout(timer);
    for (const source of abortSources) source.removeEventListener('abort', onAbort);
  }
}

/** Fixed, non-parameterised timeout body — never the boundary's own error text. */
function runTimeoutResponse() {
  return {
    status: 504,
    body: { state: 'blocked', summary: 'Not run — the request exceeded its run-time budget.', code: 'run-timeout' },
  };
}

async function handleAuthenticatedExecuteRequest(payload, deps) {
  const { catalogue, tenantPolicy, auth, nonceStore, now, signal, admitted } = deps;

  // Cheap, defensive early exit: a caller that is already gone (the run
  // deadline already fired, or `externalSignal` was already aborted before
  // this function was even entered) gets the same controlled response
  // WITHOUT spending any work at all — not even a fast, synchronous
  // tenant-policy lookup. This is a courtesy, not a correctness
  // requirement: a well-behaved dependency call below is bounded by the
  // same `signal` regardless of whether we also check it here.
  if (signal.aborted) return runTimeoutResponse();

  // The tenant policy is resolved from the AUTHENTICATED context alone —
  // nothing in `payload` can influence which bundle is looked up. A caller
  // authenticated for tenant A can never reach tenant B's samples,
  // destinations, or secrets, no matter what it puts in the request body.
  // A real tenant-policy implementation may itself call out to an external
  // directory/identity store; that call is caught here so an outage there
  // becomes a controlled, redacted 502 rather than an unhandled rejection
  // reaching the HTTP listener with no response ever sent. `raceDeadline`
  // bounds this even if the implementation ignores `signal` entirely and
  // never settles its own promise — the run's own deadline still wins the
  // race, and the abandoned promise's eventual settlement is still
  // observed so it can never surface as an unhandled rejection later.
  let bundle;
  try {
    const outcome = await raceDeadline(
      tenantPolicy.resolve({ tenant: auth.tenant, principal: auth.principal, roles: auth.roles ?? [], signal }),
      signal,
    );
    if (outcome === DEADLINE_EXCEEDED) return runTimeoutResponse();
    bundle = outcome;
  } catch {
    if (signal.aborted) return runTimeoutResponse();
    return {
      status: 502,
      body: { state: 'blocked', summary: 'Not run — the tenant policy could not be resolved.', code: 'tenant-policy-unavailable' },
    };
  }
  if (!bundle) {
    return {
      status: 403,
      body: {
        state: 'blocked',
        summary: 'Not run — this tenant is not authorized to use the relay.',
        code: 'tenant-not-authorized',
      },
    };
  }

  let sample;
  let inputs;
  let secretRefs;
  let acknowledgement;
  try {
    ({ sample, inputs, secretRefs, acknowledgement } = validateExecuteRequest(payload, catalogue, {
      relayAllowedSampleIds: bundle.allowedSampleIds,
    }));
  } catch (error) {
    if (error instanceof RequestRefused) {
      return { status: error.status, body: { state: 'blocked', summary: error.message, code: error.code } };
    }
    throw error;
  }

  let plan;
  try {
    ({ plan } = rebuildRelayPlan({ sample, inputs }, catalogue, { buildSamplePlan, requirementsFor }));
  } catch (error) {
    if (error instanceof RequestRefused) {
      return { status: error.status, body: { state: 'blocked', summary: error.message, code: error.code } };
    }
    throw error;
  }

  // Every literal destination the rebuilt plan would contact must already be
  // in THIS tenant's own allowlist — checked here, before secretRefs are
  // resolved and before any network call, so an out-of-tenant destination
  // never reaches the secret provider or the http executor at all. (A
  // templated/non-literal URL is not extractable here; `httpExecutor`'s own
  // per-step check against the same allowlist is the backstop for those.)
  const destinationOrigins = [...planDestinationOrigins(plan)];
  const disallowedOrigins = destinationOrigins.filter((origin) => !bundle.originAllowlist.origins.includes(origin));
  if (disallowedOrigins.length > 0) {
    return {
      status: 403,
      body: {
        state: 'blocked',
        summary: `Not run — "${sample.id}" would contact ${disallowedOrigins.join(', ')}, which is outside this tenant's destination allowlist.`,
        code: 'destination-not-allowed',
      },
    };
  }

  // Origin-only authorization is not enough on a shared destination: a
  // caller-selected `deployedEndpoint` path, or a caller-renamed
  // `gatewayAccess.subscriptionKeyHeader`, can still land on an ALLOWED
  // origin while pointing at an attacker-controlled route, or carrying the
  // resolved secret in a header the tenant never approved for this
  // sample/step. This is checked BEFORE any secretRef is resolved and before
  // any network call — a caller-selected variation outside this tenant's
  // per-sample/per-step policy is refused here, not merely logged.
  const requestPolicyCheck = bundle.requestPolicy.authorizeStaticPlan(sample.id, plan);
  if (!requestPolicyCheck.ok) {
    return {
      status: 403,
      body: { state: 'blocked', summary: requestPolicyCheck.message, code: requestPolicyCheck.code },
    };
  }

  // The acknowledgement is verified against the relay's OWN, just-resolved
  // view of this exact request — the authenticated caller and tenant, the
  // sample it looked up, the inputs it validated, and the EXACT literal
  // request URL(s) the rebuilt plan will actually contact (already checked,
  // above, against this tenant's request policy) — never against anything
  // the caller merely asserts about them. A mismatch here means the
  // acknowledgement, however genuine, was not granted for this specific
  // caller, tenant, or run.
  if (signal.aborted) return runTimeoutResponse();
  if (!admitted) {
    const verification = verifyAcknowledgement(
    acknowledgement,
    {
      sampleId: sample.id,
      inputs,
      secretRefs,
      target: [...planRequestUrls(plan)],
      riskText: sample.risk?.effect,
      caller: auth.principal,
      tenant: auth.tenant,
    },
    { now },
  );
    if (!verification.ok) {
      const status = ACKNOWLEDGEMENT_BAD_REQUEST_CODES.has(verification.code)
        ? 400
        : verification.code === 'acknowledgement-expired'
          ? 409
          : 403;
      return { status, body: { state: 'blocked', summary: verification.message, code: verification.code } };
    }

    if (signal.aborted) return runTimeoutResponse();

    // Only once every structural/binding check above has passed do we spend
    // the nonce: a second delivery of the same nonce — even of an otherwise
    // valid request — is either a retry or a captured replay. The nonce is
    // retained through at least this acknowledgement's OWN verified expiry
    // (not merely the store's fixed default TTL) — a bounded clock-skew
    // tolerance in `verifyAcknowledgement` can make an accepted
    // acknowledgement's real validity window longer than that default, and
    // this store must never forget the nonce before the acknowledgement it
    // protects is itself considered expired.
    if (!nonceStore.consume(acknowledgement.nonce, acknowledgement.expiresAt)) {
      return { status: 409, body: { state: 'blocked', summary: 'This request has already been served, or its nonce has expired.', code: 'nonce-replayed' } };
    }
  }

  const secrets = {};
  for (const ref of secretRefs) {
    if (signal.aborted) return runTimeoutResponse();
    // The injected secret provider is the managed-identity/Key Vault
    // boundary. A network failure, a throttled request, an authentication
    // failure, or the run's own deadline firing mid-resolution must all
    // produce a controlled, redacted result — never an uncaught exception
    // (which would either crash the process or leave this request
    // unanswered) and never the provider's own raw error text (which can
    // carry a vault URI, a request id, or other provider-internal detail).
    // `secretProvider.resolve` is passed this same run-deadline `signal` and
    // is documented (see `secretProvider.mjs`) to bound both the managed-
    // identity token request and the Key Vault fetch it makes with it.
    // `raceDeadline` additionally bounds this call from OUR side even if a
    // misbehaving injected provider ignores `signal` and never settles.
    let value;
    try {
      const outcome = await raceDeadline(bundle.secretProvider.resolve(ref, { signal }), signal);
      if (outcome === DEADLINE_EXCEEDED) return runTimeoutResponse();
      value = outcome;
    } catch {
      if (signal.aborted) return runTimeoutResponse();
      return {
        status: 502,
        body: blockedResult(sample.id, `Not run — the secret provider could not resolve "${ref}".`),
      };
    }
    if (typeof value !== 'string' || value.length === 0) {
      return {
        status: 200,
        body: blockedResult(sample.id, `Not run — the secret for "${ref}" is not available to the relay.`),
      };
    }
    secrets[ref] = value;
  }

  if (signal.aborted) return runTimeoutResponse();
  try {
    const outcome = await raceDeadline(bundle.httpExecutor.execute(plan, { secrets, signal }), signal);
    if (outcome === DEADLINE_EXCEEDED) return runTimeoutResponse();
    if (signal.aborted) return runTimeoutResponse();
    const result = outcome;
    if (!EXECUTION_STATES.includes(result.state)) {
      return { status: 502, body: blockedResult(sample.id, 'The relay produced an unrecognised result state.') };
    }
    return { status: 200, body: result };
  } catch {
    // The http executor is documented to resolve a failed/blocked/cancelled
    // step result rather than throw for an ordinary execution failure; this
    // catches only a genuinely unexpected exception (a bug, or a
    // misbehaving injected executor) so it still produces a controlled
    // response instead of propagating past this function.
    if (signal.aborted) return runTimeoutResponse();
    return { status: 502, body: blockedResult(sample.id, 'Not run — the relay executor failed unexpectedly.') };
  }
}

function admitManagedRun(canonical, { catalogue, now }) {
  const { bundle, sample, inputs, secretRefs, payload } = canonical;
  let plan;
  try {
    ({ plan } = rebuildRelayPlan({ sample, inputs }, catalogue, { buildSamplePlan, requirementsFor }));
  } catch (error) {
    if (error instanceof RequestRefused) throw error;
    throw new RequestRefused('Could not reconstruct this sample’s execution plan.', { status: 502, code: 'plan-rebuild-failed' });
  }
  const disallowedOrigins = [...planDestinationOrigins(plan)].filter((origin) => !bundle.originAllowlist.origins.includes(origin));
  if (disallowedOrigins.length > 0) {
    throw new RequestRefused(`"${sample.id}" would contact a destination outside this tenant's allowlist.`, {
      status: 403,
      code: 'destination-not-allowed',
    });
  }
  const requestPolicyCheck = bundle.requestPolicy.authorizeStaticPlan(sample.id, plan);
  if (!requestPolicyCheck.ok) {
    throw new RequestRefused(requestPolicyCheck.message, { status: 403, code: requestPolicyCheck.code });
  }
  const verification = verifyAcknowledgement(
    payload.acknowledgement,
    {
      sampleId: sample.id,
      inputs,
      secretRefs,
      target: [...planRequestUrls(plan)],
      riskText: sample.risk?.effect,
      caller: canonical.auth.principal,
      tenant: canonical.auth.tenant,
    },
    { now },
  );
  if (!verification.ok) {
    const status = ACKNOWLEDGEMENT_BAD_REQUEST_CODES.has(verification.code)
      ? 400
      : verification.code === 'acknowledgement-expired'
        ? 409
        : 403;
    throw new RequestRefused(verification.message, { status, code: verification.code });
  }
  // Deliberately does NOT consume the acknowledgement's nonce: nonce
  // single-use tracking for managed-run creation lives in the durable run
  // store's atomic `claim` operation (see `managedRun.mjs`), invoked below
  // by `runOrchestrator.create`, so consumption is part of the SAME atomic
  // step as the idempotency check and the concurrency reservation — never a
  // separate call a concurrent equivalent request could race between.
}

async function authenticateRunRequest(request, { authenticator, isLoopbackHost, host }) {
  const auth = await authenticatePrincipal(request, { isLoopbackHost, host, authenticator });
  if (!auth.ok) return null;
  return { principal: auth.principal, tenant: auth.tenant, roles: auth.roles ?? [] };
}

// Validates and admits a managed-run request, then performs the ONE atomic
// admission operation — idempotency lookup/digest-conflict, single-use nonce
// consumption, concurrency reservation, and run creation — as a single call
// into the durable store via `runOrchestrator.create`. Returns a plain
// result descriptor instead of writing to the response directly.
//
// The `idempotency()` lookup below runs first as a cheap, side-effect-free
// shortcut: it lets an already-created run be returned WITHOUT ever
// re-validating this request's acknowledgement (which may not even match the
// original request that created that run, if the caller retried with a
// stale or divergent body under the same key). It is a read-only
// optimization only — correctness never depends on what it observes. Every
// path, including this one, is re-verified atomically inside
// `runOrchestrator.create` -> `store.claim`, which is what actually
// guarantees that two concurrent equivalent requests — whether handled by
// this process or another one sharing the same durable store — can never
// both create a run, never both consume the same nonce, and never leave a
// losing request's nonce consumed merely because it lost a race to an
// equivalent winner.
async function resolveManagedRunRequest(canonical, key, auth, deps) {
  try {
    const prior = await deps.runOrchestrator.idempotency({
      owner: auth.principal,
      tenant: auth.tenant,
      idempotencyKey: key,
      requestDigest: canonical.requestDigest,
    });
    if (prior.outcome === 'existing') {
      if (!prior.run || typeof prior.run !== 'object') return { kind: 'lookup-failed' };
      return { kind: 'existing', run: prior.run };
    }
    if (prior.outcome === 'conflict') return { kind: 'conflict' };
    admitManagedRun(canonical, { ...deps, now: deps.now });
  } catch (error) {
    const status = error instanceof RequestRefused ? error.status : 500;
    return { kind: 'refused', status, code: error?.code, message: error?.message ?? 'The managed run could not be admitted.' };
  }

  try {
    const created = await deps.runOrchestrator.create({
      owner: auth.principal,
      tenant: auth.tenant,
      sampleId: canonical.payload.sampleId,
      requestDigest: canonical.requestDigest,
      idempotencyKey: key,
      // The single-use nonce this exact acknowledgement carries. Consumed
      // atomically, inside the store's `claim`, together with the
      // idempotency check and the concurrency reservation — never as a
      // separate step a concurrent equivalent request could race between.
      nonce: canonical.payload.acknowledgement.nonce,
      // This exact acknowledgement's own validated expiry — already checked
      // finite, bounded, and still-future by `verifyAcknowledgement` inside
      // `admitManagedRun` above. The store retains this nonce until at
      // least this real expiry (bounded by its own absolute ceiling), not
      // merely a fixed default window, so a longer-lived acknowledgement's
      // nonce cannot be replayed once a shorter default alone would have
      // lapsed — see `claim`'s `nonceExpiresAt` in managedRun.mjs.
      acknowledgementExpiresAt: canonical.payload.acknowledgement.expiresAt,
      // The descriptor has already passed the exact-schema gate, contains no
      // secret values, and is omitted from every public run projection. A
      // hosted worker reloads it by run ID and calls executeManagedRunWork.
      work: {
        payload: canonical.payload,
        auth,
        admitted: true,
      },
    });
    if (created.outcome === 'conflict') return { kind: 'conflict' };
    if (created.outcome === 'limit') return { kind: 'limit', scope: created.scope };
    if (created.outcome === 'nonce-replayed') {
      return {
        kind: 'refused',
        status: 409,
        code: 'nonce-replayed',
        message: 'This request has already been served, or its nonce has expired.',
      };
    }
    return { kind: created.outcome === 'created' ? 'created' : 'existing', run: created.run };
  } catch {
    return { kind: 'create-error' };
  }
}


function writeManagedRunOutcome(response, outcome) {
  switch (outcome.kind) {
    case 'lookup-failed':
      response.writeHead(500, securityHeaders());
      response.end(JSON.stringify({ state: 'failed', summary: 'The managed run could not be retrieved.', code: 'run-lookup-failed' }));
      return;
    case 'existing':
      response.writeHead(200, securityHeaders());
      response.end(JSON.stringify(outcome.run));
      return;
    case 'conflict':
      response.writeHead(409, securityHeaders());
      response.end(JSON.stringify({ state: 'blocked', summary: 'This Idempotency-Key was already used for a different request.', code: 'idempotency-conflict' }));
      return;
    case 'refused':
      response.writeHead(outcome.status, securityHeaders());
      response.end(JSON.stringify({ state: 'blocked', summary: outcome.message, code: outcome.code }));
      return;
    case 'limit':
      response.writeHead(429, securityHeaders());
      response.end(
        JSON.stringify({
          state: 'blocked',
          summary: outcome.scope === 'principal' ? 'This principal already has the maximum number of active runs.' : 'The relay already has the maximum number of active runs.',
          code: 'run-concurrency-limit',
        }),
      );
      return;
    case 'created':
      response.writeHead(202, securityHeaders());
      response.end(JSON.stringify(outcome.run));
      return;
    case 'create-error':
    default:
      response.writeHead(500, securityHeaders());
      response.end(JSON.stringify({ state: 'failed', summary: 'The managed run could not be created.', code: 'run-create-failed' }));
      return;
  }
}

async function handleManagedRunCreate(request, response, deps) {
  const auth = await authenticateRunRequest(request, deps);
  if (!auth) {
    response.writeHead(401, securityHeaders());
    response.end(JSON.stringify({ state: 'blocked', summary: 'Not run — the caller could not be authenticated.', code: 'unauthenticated' }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(request, deps.bodyLimitBytes));
  } catch (error) {
    writeBodyReadError(request, response, error);
    return;
  }

  let canonical;
  try {
    canonical = await canonicalizeManagedRunRequest(payload, { ...deps, auth });
  } catch (error) {
    const status = error instanceof RequestRefused ? error.status : 502;
    response.writeHead(status, securityHeaders());
    response.end(JSON.stringify({ state: 'blocked', summary: error?.message ?? 'Malformed request body.', code: error?.code }));
    return;
  }

  const idempotencyKey = request.headers['idempotency-key'];
  const key = Array.isArray(idempotencyKey) ? '' : idempotencyKey;
  const outcome = await resolveManagedRunRequest(canonical, key, auth, deps);
  writeManagedRunOutcome(response, outcome);
}

async function handleManagedRunStatus(request, response, deps, runId) {
  const auth = await authenticateRunRequest(request, deps);
  if (!auth) {
    response.writeHead(401, securityHeaders());
    response.end(JSON.stringify({ state: 'blocked', summary: 'Not run — the caller could not be authenticated.', code: 'unauthenticated' }));
    return;
  }
  const run = await deps.runOrchestrator.status({ owner: auth.principal, tenant: auth.tenant, runId });
  if (!run) {
    response.writeHead(404, securityHeaders());
    response.end(JSON.stringify({ state: 'blocked', summary: 'Run not found.' }));
    return;
  }
  response.writeHead(200, securityHeaders());
  response.end(JSON.stringify(run));
}

async function handleManagedRunCancel(request, response, deps, runId) {
  const auth = await authenticateRunRequest(request, deps);
  if (!auth) {
    response.writeHead(401, securityHeaders());
    response.end(JSON.stringify({ state: 'blocked', summary: 'Not run — the caller could not be authenticated.', code: 'unauthenticated' }));
    return;
  }
  const run = await deps.runOrchestrator.cancel({ owner: auth.principal, tenant: auth.tenant, runId });
  if (!run) {
    response.writeHead(404, securityHeaders());
    response.end(JSON.stringify({ state: 'blocked', summary: 'Run not found.' }));
    return;
  }
  response.writeHead(200, securityHeaders());
  response.end(JSON.stringify(run));
}

/**
 * Execute the durable, non-secret descriptor a hosted job receives for a run.
 * A job worker can obtain `work` from its durable run-store record by run ID
 * after a relay restart; this function deliberately has no browser request or
 * in-process closure dependency.
 */
export async function executeManagedRunWork(work, {
  catalogue = CATALOGUE,
  tenantPolicy,
  nonceStore,
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  now = () => Date.now(),
  signal,
  reportPartial = () => {},
} = {}) {
  if (!work || typeof work !== 'object' || !work.payload || !work.auth) {
    throw new TypeError('Managed run work must include its validated payload and authenticated owner context.');
  }
  if (work.admitted !== true) throw new TypeError('Managed run work must be admitted before execution.');
  const outcome = await handleExecuteRequest(work.payload, {
    catalogue,
    tenantPolicy,
    auth: work.auth,
    nonceStore,
    runTimeoutMs,
    now,
    externalSignal: signal,
    admitted: true,
  });
  await reportPartial(outcome.body?.steps);
  return outcome.body;
}

/**
 * @param {object} options
 * @param {object} [options.catalogue]              defaults to the bundled CATALOGUE
 * @param {object} options.tenantPolicy              REQUIRED: `{ resolve({tenant, principal, roles}) -> Promise<bundle|null> }`
 *        — see `tenantPolicy.mjs`. Maps the AUTHENTICATED caller alone to
 *        its allowed sample ids, its origin allowlist/http executor, and its
 *        secret provider. Never anything the caller selects in the request.
 * @param {object} options.authenticator             REQUIRED: `{ authenticate(request) }`
 * @param {object} [options.nonceStore]               defaults to a fresh in-memory store
 * @param {string} [options.path]                     default `/execute`
 * @param {string} [options.runsPath]                 default `/runs`; authenticated POST creates a run, GET polls it, POST `/cancel` cancels it
 * @param {object} [options.runOrchestrator]          REQUIRED to enable `/runs`: a hosted, shared durable state/job adapter
 * @param {number} [options.bodyLimitBytes]
 * @param {number} [options.runTimeoutMs]
 * @param {number} [options.maxConcurrentRequests]     global direct `/execute` admission cap
 * @param {(host:string)=>boolean} [options.isLoopbackHost]  loopback bypass for local dev/testing
 * @param {string} [options.host]                     the host this server is told it is bound to
 * @param {() => number} [options.now]                 injectable for tests (acknowledgement expiry)
 */
export function createRelayServer({
  catalogue = CATALOGUE,
  tenantPolicy,
  authenticator,
  nonceStore,
  path = '/execute',
  runsPath = '/runs',
  runOrchestrator,
  bodyLimitBytes = DEFAULT_BODY_LIMIT_BYTES,
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  maxConcurrentRequests = DEFAULT_RELAY_SERVER_LIMITS.maxConcurrentRequests,
  isLoopbackHost = () => false,
  host = '0.0.0.0',
  now = () => Date.now(),
} = {}) {
  if (!tenantPolicy || typeof tenantPolicy.resolve !== 'function') {
    throw new TypeError('createRelayServer requires a tenantPolicy (see createStaticTenantPolicy).');
  }
  if (!authenticator || typeof authenticator.authenticate !== 'function') {
    throw new TypeError('createRelayServer requires an authenticator.');
  }
  if (typeof runsPath !== 'string' || !/^\/[A-Za-z0-9._-]+$/.test(runsPath)) {
    throw new TypeError('runsPath must be one URL path segment beginning with "/".');
  }
  const serverLimits = validateRelayServerLimits({ bodyLimitBytes, runTimeoutMs, maxConcurrentRequests });
  const nonces = nonceStore ?? createNonceStore();
  const managedRuns = runOrchestrator ?? null;
  let activeExecuteRequests = 0;

  function admitExecuteRequest() {
    if (activeExecuteRequests >= serverLimits.maxConcurrentRequests) return null;
    activeExecuteRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeExecuteRequests -= 1;
    };
  }
  if (
    managedRuns &&
    (
    typeof managedRuns.idempotency !== 'function' ||
    typeof managedRuns.create !== 'function' ||
    typeof managedRuns.status !== 'function' ||
    typeof managedRuns.cancel !== 'function' ||
    typeof managedRuns.recover !== 'function' ||
    typeof managedRuns.startRecovery !== 'function' ||
    typeof managedRuns.stopRecovery !== 'function'
    )
  ) {
    throw new TypeError('runOrchestrator must provide create, status, cancel, and recovery lifecycle methods.');
  }

  const server = createServer(async (request, response) => {
    try {
      const requestPath = (request.url ?? '/').split('?')[0];
      if (requestPath === '/livez') {
        if (request.method !== 'GET') {
          response.writeHead(405, securityHeaders());
          response.end(JSON.stringify({ status: 'error', detail: 'Use GET.' }));
          return;
        }
        response.writeHead(200, securityHeaders());
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (requestPath === '/healthz' || requestPath === '/readyz') {
        if (request.method !== 'GET') {
          response.writeHead(405, securityHeaders());
          response.end(JSON.stringify({ status: 'error', detail: 'Use GET.' }));
          return;
        }
        response.writeHead(200, securityHeaders());
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      const runId = managedRunIdFromPath(requestPath, runsPath);
      if (managedRuns && requestPath === runsPath) {
        if (request.method !== 'POST') {
          response.writeHead(405, securityHeaders());
          response.end(JSON.stringify({ state: 'blocked', summary: 'Use POST.' }));
          return;
        }
        await handleManagedRunCreate(request, response, {
          catalogue,
          tenantPolicy,
          authenticator,
          runOrchestrator: managedRuns,
          bodyLimitBytes: serverLimits.bodyLimitBytes,
          runTimeoutMs: serverLimits.runTimeoutMs,
          isLoopbackHost,
          host,
          now,
        });
        return;
      }
      if (managedRuns && runId && requestPath === `${runsPath}/${runId}`) {
        if (request.method !== 'GET') {
          response.writeHead(405, securityHeaders());
          response.end(JSON.stringify({ state: 'blocked', summary: 'Use GET.' }));
          return;
        }
        await handleManagedRunStatus(request, response, { authenticator, runOrchestrator: managedRuns, isLoopbackHost, host }, runId);
        return;
      }
      if (managedRuns && runId && requestPath === `${runsPath}/${runId}/cancel`) {
        if (request.method !== 'POST') {
          response.writeHead(405, securityHeaders());
          response.end(JSON.stringify({ state: 'blocked', summary: 'Use POST.' }));
          return;
        }
        await handleManagedRunCancel(request, response, { authenticator, runOrchestrator: managedRuns, isLoopbackHost, host }, runId);
        return;
      }
      if (requestPath !== path) {
        response.writeHead(404, securityHeaders());
        response.end(JSON.stringify({ state: 'blocked', summary: 'Not found.' }));
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, securityHeaders());
        response.end(JSON.stringify({ state: 'blocked', summary: 'Use POST.' }));
        return;
      }

      const releaseAdmission = admitExecuteRequest();
      if (!releaseAdmission) {
        response.writeHead(429, securityHeaders());
        response.end(
          JSON.stringify({
            state: 'blocked',
            summary: 'Not run — the relay is already serving the maximum number of concurrent requests.',
            code: 'relay-concurrency-limit',
          }),
        );
        return;
      }

      let client;
      try {
        client = monitorClientDisconnect(request, response, { timeoutMs: serverLimits.runTimeoutMs });
        if (finishStoppedExecuteRequest(request, response, client)) return;

        const authOutcome = await raceDeadline(
          authenticatePrincipal(request, { isLoopbackHost, host, authenticator }),
          client.signal,
        );
        if (authOutcome === DEADLINE_EXCEEDED) {
          finishStoppedExecuteRequest(request, response, client);
          return;
        }
        if (finishStoppedExecuteRequest(request, response, client)) return;
        const auth = authOutcome;
        if (!auth.ok) {
          response.writeHead(401, securityHeaders());
          response.end(JSON.stringify({ state: 'blocked', summary: 'Not run — the caller could not be authenticated.', code: 'unauthenticated' }));
          return;
        }

        let payload;
        try {
          const bodyOutcome = await raceDeadline(readBody(request, serverLimits.bodyLimitBytes), client.signal);
          if (bodyOutcome === DEADLINE_EXCEEDED) {
            finishStoppedExecuteRequest(request, response, client);
            return;
          }
          if (finishStoppedExecuteRequest(request, response, client)) return;
          payload = JSON.parse(bodyOutcome);
        } catch (error) {
          if (finishStoppedExecuteRequest(request, response, client)) return;
          writeBodyReadError(request, response, error);
          return;
        }
        if (finishStoppedExecuteRequest(request, response, client)) return;

        // Continue the exact deadline armed immediately after admission. The
        // pure handler must not start a second run timer for this HTTP request.
        const { status, body } = await handleExecuteRequest(payload, {
          catalogue,
          tenantPolicy,
          auth: { principal: auth.principal, tenant: auth.tenant, roles: auth.roles ?? [] },
          nonceStore: nonces,
          runTimeoutMs: serverLimits.runTimeoutMs,
          now,
          deadlineSignal: client.signal,
        });
        if (finishStoppedExecuteRequest(request, response, client)) return;
        response.writeHead(status, securityHeaders());
        response.end(JSON.stringify(body));
      } finally {
        client?.dispose();
        releaseAdmission();
      }
    } catch (error) {
      // The final backstop. `handleExecuteRequest` already catches the
      // specific managed-identity/Key-Vault-shaped boundary calls it makes
      // (tenant policy, secret provider, http executor); this catches
      // everything else that can still throw on this path — notably a
      // custom `authenticator.authenticate()` that itself calls out to a
      // real identity provider (Entra/OIDC token verification) and fails.
      // Without this, an exception here would either crash the process via
      // an unhandled rejection or leave the socket open with no response
      // ever sent. The client never sees `error.message`.
      void error;
      try {
        if (!response.headersSent) {
          response.writeHead(500, securityHeaders());
          response.end(JSON.stringify({ state: 'failed', summary: 'Not run — an unexpected error occurred.', code: 'internal-error' }));
        } else {
          response.end();
        }
      } catch {
        response.destroy?.();
      }
    }
  });

  server.tenantPolicy = tenantPolicy;
  server.nonceStore = nonces;
  server.runOrchestrator = managedRuns;
  server.limits = serverLimits;
  // Recovery belongs to the listening server's lifecycle: construction alone
  // does not start background work, and close always clears the scheduler.
  if (managedRuns) {
    let recoveryStarted = false;
    const stopManagedRecovery = () => {
      if (!recoveryStarted) return;
      recoveryStarted = false;
      managedRuns.stopRecovery();
    };
    server.on('listening', () => {
      recoveryStarted = true;
      void managedRuns.startRecovery().catch(() => console.error('Managed run recovery failed.'));
    });
    server.on('close', stopManagedRecovery);
    const close = server.close.bind(server);
    server.close = (callback) => {
      stopManagedRecovery();
      return close(callback);
    };
  }
  return server;
}
