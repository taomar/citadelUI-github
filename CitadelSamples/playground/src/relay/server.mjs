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
 *   1. principal authentication (the caller must present a credential the
 *      relay's authenticator accepts — see `principalAuth.mjs`) resolving a
 *      full `{ principal, tenant, roles }` context, never discarded — a
 *      non-loopback caller with no non-empty principal AND tenant is refused
 *      here, before anything else runs
 *   2. a body-size limit
 *   3. tenant-policy resolution (`tenantPolicy.mjs`) — the authenticated
 *      `{ tenant, principal, roles }` is mapped, server-side, to the exact
 *      bundle of resources THIS tenant may use: its own allowed sample ids,
 *      its own destination-origin allowlist/http executor pair, and its own
 *      logical secret provider. An unknown tenant, or one whose roles do not
 *      satisfy the bundle's gate, is refused here — before schema
 *      validation, before secret access, before any network call
 *   4. exact-schema validation against THIS tenant's own allow-list
 *      (`requestSchema.mjs`)
 *   5. plan reconstruction from the relay's OWN catalogue copy
 *   6. a proactive destination check: every literal destination origin the
 *      rebuilt plan would contact must already be in THIS tenant's own
 *      origin allowlist — checked here, before any secret is resolved,
 *      so a request for an out-of-tenant destination never reaches the
 *      secret provider or the network at all
 *   7. a per-sample/per-step request-policy check (`requestPolicy.mjs`) —
 *      origin-only authorization cannot tell a tenant-approved route from a
 *      caller-controlled path/header on the SAME allowed origin, so every
 *      literal request URL and every secret-bearing header NAME the rebuilt
 *      plan carries must also match THIS tenant's own, server-selected
 *      per-sample/per-step policy — checked here, still before any secret
 *      is resolved
 *   8. acknowledgement binding verification — the acknowledgement must name
 *      THIS sample, THIS exact request URL set (the same one the request
 *      policy above just approved), THIS authenticated caller and tenant,
 *      and a canonical digest of THESE inputs, and must not have expired
 *      (`acknowledgement.mjs`) — checked against the relay's own rebuilt
 *      view and its own resolved authentication, never against anything the
 *      caller merely asserts
 *   9. single-use nonce consumption (replay/freshness — `nonceStore.mjs`),
 *      only once the binding above has already passed, so a malformed or
 *      mismatched request never spends a nonce it was not entitled to use
 *  10. secret resolution through the tenant's own injected provider (never
 *      the caller's choice of vault/secret name)
 *  11. execution through the tenant's own http/assertion-only core
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
 * written to it. A single run-level deadline, started right after
 * authentication — before tenant-policy resolution, not only around the
 * http executor — bounds the ENTIRE request, and its `AbortSignal` is
 * threaded through every one of those boundaries so none of them, even one
 * reached before the http executor ever starts, can hang past that budget.
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
import { raceDeadline, DEADLINE_EXCEEDED } from './deadline.mjs';

/** Acknowledgement-binding failure codes that are a client-fixable request problem, not a policy refusal. */
const ACKNOWLEDGEMENT_BAD_REQUEST_CODES = new Set(['acknowledgement-required', 'nonce-required', 'acknowledgement-malformed']);

const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 60_000;

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

async function readBody(request, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new RequestRefused(`The request body is larger than the ${limitBytes}-byte limit.`, { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
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
 * @param {AbortSignal} [deps.externalSignal]  optional caller-disconnect signal
 *        (see `createRelayServer`, which wires this to the underlying
 *        `node:http` request's own `close` event) — firing it ends the run
 *        exactly like the deadline below firing.
 *
 * The one run-level deadline (`runTimeoutMs`) starts here, BEFORE tenant
 * policy resolution or any secret is resolved — not only around the http
 * executor — and its `signal` is threaded through every external boundary
 * this function crosses that can itself hang: `tenantPolicy.resolve`,
 * `secretProvider.resolve` (which bounds its own managed-identity and Key
 * Vault calls — see `managedIdentity.mjs` / `secretProvider.mjs`), and
 * `httpExecutor.execute`. A directory outage or an unreachable Key
 * Vault/IMDS endpoint before the http executor even starts must not be able
 * to hang this request past its budget any more than a slow destination
 * fetch can.
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
    externalSignal,
    admitted = false,
  } = deps;

  if (!auth || typeof auth.principal !== 'string' || auth.principal === '' || typeof auth.tenant !== 'string' || auth.tenant === '') {
    return {
      status: 401,
      body: { state: 'blocked', summary: 'Not run — the caller could not be authenticated.', code: 'unauthenticated' },
    };
  }

  // The one run-level deadline for this whole request, started here —
  // before tenant policy resolution, before any secret is resolved, not
  // only around the http executor at the very end. `signal` is threaded
  // through every external boundary below that can itself hang: tenant
  // policy resolution, secret resolution (which bounds its own
  // managed-identity/Key Vault calls internally too — see
  // `secretProvider.mjs`), and the http executor. `externalSignal`, when
  // supplied (see `createRelayServer`, wired to the underlying request's
  // own disconnect), ends the run exactly the same way.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runTimeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
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
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
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

    // Only once every structural/binding check above has passed do we spend
    // the nonce: a second delivery of the same nonce — even of an otherwise
    // valid request — is either a retry or a captured replay.
    if (!nonceStore.consume(acknowledgement.nonce)) {
      return { status: 409, body: { state: 'blocked', summary: 'This request has already been served, or its nonce has expired.', code: 'nonce-replayed' } };
    }
  }

  const secrets = {};
  for (const ref of secretRefs) {
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

  try {
    const outcome = await raceDeadline(bundle.httpExecutor.execute(plan, { secrets, signal }), signal);
    if (outcome === DEADLINE_EXCEEDED) return runTimeoutResponse();
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

function admitManagedRun(canonical, { catalogue, nonceStore, now }) {
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
  if (!nonceStore.consume(payload.acknowledgement.nonce)) {
    throw new RequestRefused('This request has already been served, or its nonce has expired.', { status: 409, code: 'nonce-replayed' });
  }
}

async function authenticateRunRequest(request, { authenticator, isLoopbackHost, host }) {
  const auth = await authenticatePrincipal(request, { isLoopbackHost, host, authenticator });
  if (!auth.ok) return null;
  return { principal: auth.principal, tenant: auth.tenant, roles: auth.roles ?? [] };
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
    const status = error instanceof RequestRefused ? error.status : 400;
    response.writeHead(status, securityHeaders());
    response.end(JSON.stringify({ state: 'blocked', summary: error?.message ?? 'Malformed request body.' }));
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
  try {
    const prior = await deps.runOrchestrator.idempotency({
      owner: auth.principal,
      tenant: auth.tenant,
      idempotencyKey: key,
      requestDigest: canonical.requestDigest,
    });
    if (prior.outcome === 'existing') {
      if (!prior.run || typeof prior.run !== 'object') {
        response.writeHead(500, securityHeaders());
        response.end(JSON.stringify({ state: 'failed', summary: 'The managed run could not be retrieved.', code: 'run-lookup-failed' }));
        return;
      }
      response.writeHead(200, securityHeaders());
      response.end(JSON.stringify(prior.run));
      return;
    }
    if (prior.outcome === 'conflict') {
      response.writeHead(409, securityHeaders());
      response.end(JSON.stringify({ state: 'blocked', summary: 'This Idempotency-Key was already used for a different request.', code: 'idempotency-conflict' }));
      return;
    }
    admitManagedRun(canonical, { ...deps, now: deps.now });
  } catch (error) {
    const status = error instanceof RequestRefused ? error.status : 500;
    response.writeHead(status, securityHeaders());
    response.end(JSON.stringify({ state: 'blocked', summary: error?.message ?? 'The managed run could not be admitted.', code: error?.code }));
    return;
  }
  try {
    const created = await deps.runOrchestrator.create({
      owner: auth.principal,
      tenant: auth.tenant,
      sampleId: canonical.payload.sampleId,
      requestDigest: canonical.requestDigest,
      idempotencyKey: key,
      // The descriptor has already passed the exact-schema gate, contains no
      // secret values, and is omitted from every public run projection. A
      // hosted worker reloads it by run ID and calls executeManagedRunWork.
      work: {
        payload: canonical.payload,
        auth,
        admitted: true,
      },
    });
    if (created.outcome === 'conflict') {
      response.writeHead(409, securityHeaders());
      response.end(JSON.stringify({ state: 'blocked', summary: 'This Idempotency-Key was already used for a different request.', code: 'idempotency-conflict' }));
      return;
    }
    if (created.outcome === 'limit') {
      response.writeHead(429, securityHeaders());
      response.end(
        JSON.stringify({
          state: 'blocked',
          summary: created.scope === 'principal' ? 'This principal already has the maximum number of active runs.' : 'The relay already has the maximum number of active runs.',
          code: 'run-concurrency-limit',
        }),
      );
      return;
    }
    response.writeHead(created.outcome === 'created' ? 202 : 200, securityHeaders());
    response.end(JSON.stringify(created.run));
  } catch {
    response.writeHead(500, securityHeaders());
    response.end(JSON.stringify({ state: 'failed', summary: 'The managed run could not be created.', code: 'run-create-failed' }));
  }
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
  const nonces = nonceStore ?? createNonceStore();
  const managedRuns = runOrchestrator ?? null;
  if (
    managedRuns &&
    (
    typeof managedRuns.idempotency !== 'function' ||
    typeof managedRuns.create !== 'function' ||
    typeof managedRuns.status !== 'function' ||
    typeof managedRuns.cancel !== 'function' ||
    typeof managedRuns.recover !== 'function'
    )
  ) {
    throw new TypeError('runOrchestrator must provide create, status, and cancel methods.');
  }

  const server = createServer(async (request, response) => {
    try {
      const requestPath = (request.url ?? '/').split('?')[0];
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
          nonceStore: nonces,
          runOrchestrator: managedRuns,
          bodyLimitBytes,
          runTimeoutMs,
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

      const auth = await authenticatePrincipal(request, { isLoopbackHost, host, authenticator });
      if (!auth.ok) {
        response.writeHead(401, securityHeaders());
        response.end(JSON.stringify({ state: 'blocked', summary: 'Not run — the caller could not be authenticated.', code: 'unauthenticated' }));
        return;
      }

      let payload;
      try {
        payload = JSON.parse(await readBody(request, bodyLimitBytes));
      } catch (error) {
        const status = error instanceof RequestRefused ? error.status : 400;
        response.writeHead(status, securityHeaders());
        response.end(JSON.stringify({ state: 'blocked', summary: error?.message ?? 'Malformed request body.' }));
        return;
      }

      // A caller that disconnects mid-run should end the run the same way
      // the deadline does, not leave it running to completion against a
      // socket nobody is reading the response from. `handleExecuteRequest`
      // itself, not this listener, decides what "ended" produces.
      const clientAbort = new AbortController();
      const onClose = () => {
        if (!response.writableEnded) clientAbort.abort();
      };
      request.on('close', onClose);
      let status;
      let body;
      try {
        ({ status, body } = await handleExecuteRequest(payload, {
          catalogue,
          tenantPolicy,
          auth: { principal: auth.principal, tenant: auth.tenant, roles: auth.roles ?? [] },
          nonceStore: nonces,
          runTimeoutMs,
          now,
          externalSignal: clientAbort.signal,
        }));
      } finally {
        request.off('close', onClose);
      }
      response.writeHead(status, securityHeaders());
      response.end(JSON.stringify(body));
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
  // A durable orchestrator re-enqueues records that were accepted before a
  // prior relay process exited. Its own store/job adapter reports any recovery
  // failure to the hosting environment without exposing internal details.
  if (managedRuns) {
    void managedRuns.recover().catch(() => console.error('Managed run recovery failed.'));
  }
  return server;
}
