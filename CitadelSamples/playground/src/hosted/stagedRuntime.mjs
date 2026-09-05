import { CATALOGUE } from '../catalogue/index.mjs';
import { validateRunRequest } from '../server/runRequest.mjs';
import { createHttpsTransport } from './httpsTransport.mjs';
import { createAdapterRegistry } from './adapters/index.mjs';
import { createSecretSlots } from './secretSlots.mjs';
import { createResolutions, operation } from './resolution.mjs';
import { requireReview, reviewResolution } from './approval.mjs';
import { createRunStore } from './runStore.mjs';
import { purposeStates, purposeEnabled } from './credentialPurposes.mjs';
import { digest, envelope, bindings, exact, refuse } from './request.mjs';

export function createStagedRuntime(config, sessions, auth, { fetchImpl = createHttpsTransport(), testAdapters } = {}) {
  const registry = createAdapterRegistry({ testAdapters });
  const store = createRunStore({ directory: config.stagedDirectory, now: sessions.now });
  const slots = createSecretSlots(sessions);
  const resolutions = createResolutions(config, sessions, slots, registry);
  const active = new Map(), bindingsByRun = new Map(), resolving = new Set(), resolvingAdapters = new Map(), generatedByRun = new Map();
  const reading = new Set(), stagedSessions = new Set(), lifecycle = new AbortController();
  const unsubscribe = sessions.onInvalidate((session) => {
    stagedSessions.delete(session);
    for (const [id, binding] of bindingsByRun) if (binding.session === session) {
      bindingsByRun.delete(id);
      generatedByRun.delete(id);
    }
  });
  let closing = false;
  let closeTask;
  let failure = false;
  function requireOperator(session, version) {
    if (closing) refuse(failure ? 'Staged storage failed; owner recovery is required.' : 'Staged runner is closing.', 'runner-unavailable', 503);
    resolutions.requireOperator(session, version);
    stagedSessions.add(session);
  }
  function transport(session, adapter, phase, resolution, signal, onSend) {
    let count = 0;
    const version = resolution?.version ?? session.contextVersion;
    return async (raw) => {
      const request = operation(raw);
      requireOperator(session, version);
      signal.throwIfAborted();
      if (++count > 128 || (phase !== 'execute' && request.effect !== 'read')
        || !adapter.authorizeRequest({ phase, request, resolution })) refuse('Request is outside the closed adapter policy.', 'target-policy-refused');
      if (phase === 'resolve' && !adapter.resolvePurposes.includes(request.purpose)) refuse('Unapproved resolution credential.', 'target-policy-refused');
      if (phase === 'precondition' && !resolution.preconditions.some((item) => digest(item.request) === digest(request))) refuse('Unreviewed precondition read.', 'target-policy-refused');
      if (phase === 'execute' && !resolution.operations.some((item) => digest(item) === digest(request))) refuse('Unreviewed effect.', 'target-policy-refused');
      const headers = { Accept: 'application/json', ...request.headers };
      if (request.purpose === 'gateway-key') {
        const field = request.keyField;
        if (!field || !resolution?.credentialTargets[field]) refuse('Gateway credential target is missing.', 'secret-binding-changed');
        const target = resolution.credentialTargets[field], url = new URL(request.url);
        if (url.origin !== target.origin || !target.routes.includes(url.pathname)) refuse('Gateway credential route changed.', 'secret-binding-changed');
        const key = resolution.secretBindings[field]
          ? slots.resolveBinding(session, field, resolution.secretBindings[field], target) : resolution.secrets[field];
        if (!key) refuse('Enter or select the gateway credential.', 'secret-binding-changed');
        headers[target.headerName] = key;
      } else {
        if (!purposeEnabled(config, request.purpose)) refuse('Resource contract unverified.', 'service-contract-unverified', 403);
        headers.Authorization = `Bearer ${await auth.token(session, request.purpose)}`;
      }
      requireOperator(session, version);
      signal.throwIfAborted();
      onSend?.(request);
      const response = await fetchImpl(request.url, { method: request.method, headers, body: request.body,
        signal: AbortSignal.any([signal, session.controller.signal]) });
      requireOperator(session, version);
      signal.throwIfAborted();
      return response;
    };
  }
  function owned(session, runId, { recovery = false } = {}) {
    requireOperator(session);
    const run = store.get(runId);
    if (!run || run.tenant !== session.claims.tid || run.owner !== session.claims.oid) refuse('Run unavailable.', 'run-unavailable', 404);
    const adapter = registry.get(run.sampleId);
    if (run.policyDigest !== digest({ adapter: adapter.id, version: adapter.version, policy: adapter.policyId })) refuse('Target policy changed; owner review is required.', 'target-policy-changed');
    const binding = bindingsByRun.get(runId);
    if (!recovery && (!binding || binding.session !== session || binding.version !== session.contextVersion)) refuse('Reauthenticate and explicitly reconcile this run.', 'reconcile-required');
    return { run, adapter };
  }
  function status(run) {
    const secretBindings = {};
    for (const [field, binding] of Object.entries(generatedByRun.get(run.id) ?? {})) {
      try {
        slots.describe(bindingsByRun.get(run.id)?.session, field, binding);
        secretBindings[field] = binding;
      } catch (error) { if (error.code !== 'secret-binding-changed') throw error; }
    }
    if (Object.keys(secretBindings).length) generatedByRun.set(run.id, secretBindings);
    else generatedByRun.delete(run.id);
    return { runId: run.id, state: run.state, steps: store.effects(run.id).map((effect) => ({
      id: effect.id, state: effect.state, status: effect.observation?.status ?? null,
    })), result: run.result, secretBindings,
    recovery: store.hasReservation(run.id) && !run.active ? 'explicit-readback-required' : null };
  }
  async function execute(session, resolution, run, controller) {
    const signal = AbortSignal.any([controller.signal, lifecycle.signal, session.controller.signal, AbortSignal.timeout(75000)]);
    let state = 'blocked', code = null;
    try {
      const read = transport(session, resolution.adapter, 'precondition', resolution, signal);
      for (const precondition of resolution.preconditions) {
        const response = await read(precondition.request);
        if (!response.ok || digest(await response.json()) !== precondition.digest) refuse('Precondition drift; resolve and review again.', 'review-required');
      }
      const dispatch = transport(session, resolution.adapter, 'execute', resolution, signal,
        (request) => store.beginEffect(run.id, request.id, digest(request)));
      const responses = new Map(), confirmed = new Set();
      const result = await resolution.adapter.execute({
        resolution,
        async send(request) {
          const response = await dispatch(request);
          store.observeEffect(run.id, request.id, { status: response.status, outcome: 'unknown' });
          responses.set(request.id, response.status);
          return response;
        },
        confirmEffect(id) {
          requireOperator(session, resolution.version);
          signal.throwIfAborted();
          const status = responses.get(id);
          if (!status || status >= 500 || status === 429) refuse('The effect outcome cannot be confirmed.', 'outcome-unknown');
          store.observeEffect(run.id, id, { status, outcome: 'confirmed' });
          confirmed.add(id);
        },
        putGenerated({ field = 'gatewayAccess.apiKey', value, target }) {
          requireOperator(session, resolution.version);
          signal.throwIfAborted();
          if (!confirmed.size) refuse('A confirmed effect is required before credential handoff.', 'outcome-unknown');
          if (!resolution.adapter.generatedFields.includes(field)) refuse('This adapter cannot generate credentials.', 'secret-binding-changed');
          if (digest(target) !== digest(resolution.credentialTargets[field])) refuse('Generated credential target was not reviewed.', 'secret-binding-changed');
          const binding = slots.putGenerated(session, { field, value, target });
          generatedByRun.set(run.id, { ...generatedByRun.get(run.id), [field]: binding });
          return binding;
        },
      });
      exact(result, ['state']);
      if (!['completed', 'failed', 'inconclusive'].includes(result.state)) refuse('Invalid adapter result state.', 'adapter-contract-invalid');
      requireOperator(session, resolution.version);
      signal.throwIfAborted();
      state = store.effects(run.id).some((effect) => effect.state !== 'observed') ? 'inconclusive' : result.state;
    } catch (error) {
      code = ['review-required', 'context-changed', 'secret-binding-changed', 'target-policy-refused',
        'operator-required', 'outcome-unknown', 'hosted-storage-unavailable'].includes(error.code)
        ? error.code : signal.aborted ? 'cancelled' : 'adapter-or-transport-failed';
      state = store.effects(run.id).length ? 'inconclusive' : signal.aborted ? 'cancelled' : 'blocked';
    } finally {
      try {
        store.finish(run.id, state, { sampleId: resolution.sample.id, state,
          summary: state === 'completed' ? 'Reviewed fixed requests completed.' : 'Stopped; inspect effect states and reconcile unknown outcomes. No automatic retry was made.',
          steps: [], secretUpdates: {}, configurationUpdates: {}, assertions: [], meta: { executor: 'hosted-staged', liveEvidence: false, code } });
      } finally {
        resolution.clearSecrets();
        active.delete(run.id);
        if (session.run?.id === run.id) session.run = null;
      }
    }
  }
  const api = {
    ids: registry.ids, slots,
    context(session, payload) {
      requireOperator(session);
      envelope(payload, ['sampleId', 'inputs'], ['gateway', 'secretBindings']);
      const request = validateRunRequest(payload, CATALOGUE, { phase: 'resolve' });
      if (payload.gateway) exact(payload.gateway, ['keyPresent', 'headerName']);
      if (payload.gateway && (typeof payload.gateway.keyPresent !== 'boolean'
        || !/^[A-Za-z0-9-]{1,64}$/.test(payload.gateway.headerName))) refuse('Invalid gateway hint.', 'invalid-request', 400);
      const selectedBindings = bindings(payload.secretBindings, request.sample);
      const credentialBindings = Object.fromEntries(Object.entries(selectedBindings).map(([field, value]) => [field, slots.describe(session, field, value)]));
      return { kind: 'hosted-staged', label: 'Staged HTTPS foundation', state: 'unavailable', canExecute: false,
        summary: 'Explicit Resolve and an independently reviewed adapter are required.', contextVersion: session.contextVersion,
        requiredPurposes: [], consentStates: purposeStates(config, session), credentialBindings,
        targetSubscriptions: { hub: request.inputs['hub.subscriptionId'] ?? null, overrides: request.inputs['keyVault.subscriptionId'] ? [request.inputs['keyVault.subscriptionId']] : [] },
        adapterEnabled: registry.ids.includes(request.sample.id) };
    },
    async resolve(session, payload) {
      requireOperator(session, payload.contextVersion);
      const key = `${session.claims.tid}/${session.claims.oid}`;
      if (resolving.size >= 8 || resolving.has(key) || session.run) refuse('A resolution or run is already active.', 'runner-busy', 429);
      const adapter = registry.get(payload.sampleId);
      if ((resolvingAdapters.get(adapter.id) ?? 0) >= 4) refuse('Resolution target capacity reached.', 'runner-busy', 429);
      resolving.add(key);
      resolvingAdapters.set(adapter.id, (resolvingAdapters.get(adapter.id) ?? 0) + 1);
      const signal = AbortSignal.any([lifecycle.signal, session.controller.signal, AbortSignal.timeout(30000)]);
      const task = resolutions.resolve(session, payload, transport(session, adapter, 'resolve', null, signal));
      reading.add(task);
      try { return await task; }
      finally { reading.delete(task); resolving.delete(key); resolvingAdapters.set(adapter.id, resolvingAdapters.get(adapter.id) - 1); }
    },
    consentIntent: resolutions.consentIntent,
    review(session, payload) {
      requireOperator(session, payload.contextVersion);
      return reviewResolution(session, resolutions.current(session, payload), payload, sessions.now);
    },
    run(session, payload, { signal } = {}) {
      requireOperator(session, payload.contextVersion);
      signal?.throwIfAborted();
      const resolution = resolutions.current(session, payload);
      const review = requireReview(session, resolution, payload, sessions.now);
      if (session.run) refuse('Another run is active in this session.', 'runner-busy', 429);
      const claimed = store.claim({ tenant: session.claims.tid, owner: session.claims.oid, sampleId: resolution.sample.id,
        adapterVersion: resolution.adapter.version, policyDigest: resolution.policyDigest, identityDigest: resolution.identityDigest,
        nonceHash: digest(review.runNonce), targets: resolution.targets }, { maxConcurrentRuns: config.maxConcurrentRuns ?? 8 });
      const run = claimed.run;
      session.stagedReview = null;
      session.stagedResolution = null;
      session.consentIntents.clear();
      bindingsByRun.set(run.id, { session, version: session.contextVersion });
      if (claimed.created) {
        const controller = new AbortController();
        signal?.addEventListener('abort', () => controller.abort(), { once: true });
        session.run = { id: run.id, controller, version: session.contextVersion };
        // Yield until durable admission has returned to the HTTP route. No provider I/O in the transaction.
        const task = new Promise((resolve) => setImmediate(resolve)).then(() => execute(session, resolution, run, controller));
        active.set(run.id, { controller, task });
        task.catch(() => {
          failure = true; closing = true; lifecycle.abort();
          for (const entry of active.values()) entry.controller.abort();
          process.stderr.write('Staged durable execution failed closed; owner recovery is required.\n');
        });
      }
      return { runId: run.id, state: claimed.created ? 'accepted' : run.state };
    },
    status(session, payload) {
      envelope(payload, ['runId']);
      return status(owned(session, payload.runId).run);
    },
    recoverable(session, payload) {
      envelope(payload, ['contextVersion']);
      requireOperator(session, payload.contextVersion);
      return { runs: store.listRecoverable(session.claims.tid, session.claims.oid).map((run) => {
        try { owned(session, run.id, { recovery: true }); return { ...run, recovery: 'explicit-readback-required' }; }
        catch (error) {
          if (!['hosted-recipe-unavailable', 'target-policy-changed'].includes(error.code)) throw error;
          return { ...run, recovery: error.code };
        }
      }) };
    },
    cancel(session, payload) {
      envelope(payload, ['runId']);
      const { run } = owned(session, payload.runId);
      active.get(run.id)?.controller.abort();
      return { runId: run.id, cancelRequested: active.has(run.id), state: run.state };
    },
    async reconcile(session, payload) {
      envelope(payload, ['runId', 'contextVersion']);
      requireOperator(session, payload.contextVersion);
      const { run, adapter } = owned(session, payload.runId, { recovery: true });
      if (run.active || active.has(run.id)) refuse('Wait for the exact active run to settle.', 'run-active');
      const key = `${session.claims.tid}/${session.claims.oid}`;
      if (resolving.size >= 8 || resolving.has(key)) refuse('Readback capacity reached.', 'runner-busy', 429);
      resolving.add(key);
      const effects = store.effects(run.id);
      const version = session.contextVersion;
      const signal = AbortSignal.any([lifecycle.signal, session.controller.signal, AbortSignal.timeout(30000)]);
      const task = (async () => {
        const observations = await adapter.reconcile({ run, effects, read: transport(session, adapter, 'reconcile', { ...run, version }, signal) });
        requireOperator(session, version);
        signal.throwIfAborted();
        store.reconcile(run.id, observations);
        bindingsByRun.set(run.id, { session, version });
        return status(store.get(run.id));
      })();
      reading.add(task);
      try { return await task; }
      finally { reading.delete(task); resolving.delete(key); }
    },
    async close() {
      closeTask ??= (async () => {
        closing = true;
        lifecycle.abort();
        for (const entry of active.values()) entry.controller.abort();
        await Promise.allSettled([...active.values()].map((entry) => entry.task).concat([...reading]));
        for (const session of stagedSessions) {
          session.stagedResolution?.clearSecrets?.();
          session.stagedResolution = null;
          session.stagedReview = null;
          session.consentIntents.clear();
        }
        unsubscribe();
        stagedSessions.clear(); generatedByRun.clear(); bindingsByRun.clear();
        slots.close();
        store.close();
      })();
      return closeTask;
    },
  };
  return Object.freeze(api);
}
