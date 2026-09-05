import { createHmac, randomBytes } from 'node:crypto';
import { CATALOGUE, buildSamplePlan, requirementsFor } from '../catalogue/index.mjs';
import { rebuildPlan } from '../server/runRequest.mjs';
import { randomToken } from './sessions.mjs';
import { purposeEnabled, RESOURCE_PURPOSES } from './credentialPurposes.mjs';
import { canonicalTargets, digest, envelope, exact, immutable, refuse, resolveRequest, HASH } from './request.mjs';
import { validateCredentialTarget } from './secretSlots.mjs';
import { createRedactor } from '../server/redaction.mjs';

export function operation(value) {
  exact(value, ['id', 'method', 'url', 'purpose', 'effect', 'body', 'headers', 'keyField'],
    ['id', 'method', 'url', 'purpose', 'effect']);
  const url = new URL(value.url);
  if (!/^[a-z0-9-]{1,80}$/.test(value.id) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method)
    || !['azure', ...RESOURCE_PURPOSES, 'gateway-key'].includes(value.purpose)
    || !['read', 'write', 'paid'].includes(value.effect) || (value.effect === 'read' && value.method !== 'GET')
    || (value.effect === 'write' && value.method === 'GET') || (value.effect === 'paid' && value.method !== 'POST')
    || (value.method === 'GET' && value.body !== undefined)
    || url.protocol !== 'https:' || url.username || url.password || url.hash || /[\s\\]/.test(value.url)
    || [...url.searchParams.keys()].some((key) => key !== 'api-version')
    || (value.body !== undefined && (typeof value.body !== 'string' || Buffer.byteLength(value.body) > 256 * 1024))
    || (value.keyField !== undefined && value.keyField !== 'gatewayAccess.apiKey')) {
    refuse('Adapter operation is outside the fixed staged contract.', 'adapter-contract-invalid');
  }
  if (value.headers) {
    exact(value.headers, ['Accept', 'Content-Type', 'If-Match', 'If-None-Match', 'A2A-Version', 'MCP-Protocol-Version'], []);
    if (Object.values(value.headers).some((item) => typeof item !== 'string' || item.length > 1024 || /[\r\n]/.test(item))) refuse('Invalid fixed request headers.', 'adapter-contract-invalid');
  }
  return immutable(value);
}

export function createResolutions(config, sessions, slots, registry) {
  const salt = randomBytes(32);
  function requireOperator(session, version) {
    if (!sessions.authorized(session) || session.authPending) refuse('Authorized operator required.', 'operator-required', 403);
    if (version !== undefined && version !== session.contextVersion) refuse('Context changed; resolve again.', 'context-changed');
  }
  function current(session, payload) {
    requireOperator(session, payload.contextVersion);
    const value = session.stagedResolution;
    if (!value || value.id !== payload.resolutionId || value.expiresAt <= sessions.now()
      || value.version !== session.contextVersion || value.generation !== session.resolutionGeneration) {
      refuse('The resolution changed or expired. Resolve again.', 'resolution-required');
    }
    for (const [field, binding] of Object.entries(value.secretBindings)) slots.describe(session, field, binding);
    return value;
  }
  return Object.freeze({
    requireOperator, current,
    async resolve(session, payload, read) {
      requireOperator(session, payload.contextVersion);
      const request = resolveRequest(payload, CATALOGUE);
      const adapter = registry.get(request.sample.id);
      const hasSecret = (field) => {
        if (request.secretBindings[field]) { slots.describe(session, field, request.secretBindings[field]); return true; }
        return Boolean(request.secrets[field]);
      };
      const rebuilt = rebuildPlan(request, CATALOGUE, { buildSamplePlan, requirementsFor, hasSecret });
      for (const field of request.sample.fields.filter((field) => ['samples.weather-api-ensure.specPath', 'samples.weather-api-ensure.policyPath'].includes(field.path))) {
        if (rebuilt.resolvedInputs[field.path] !== field.default) refuse('Hosted source and policy overrides are not allowed.', 'source-override-refused', 400);
      }
      if (adapter.resolvePurposes.includes('azure') && (!session.azure || session.subscription?.id !== rebuilt.resolvedInputs['hub.subscriptionId']
        || !config.subscriptionIds.includes(session.subscription?.id))) {
        refuse('Connect Azure and select the intended permitted Hub subscription.', 'context-changed');
      }
      session.stagedResolution?.clearSecrets?.();
      session.stagedResolution = null;
      session.stagedReview = null;
      session.consentIntents.clear();
      const version = session.contextVersion, generation = ++session.resolutionGeneration;
      const resolved = await adapter.resolve({ inputs: immutable(rebuilt.resolvedInputs), read });
      requireOperator(session, version);
      if (generation !== session.resolutionGeneration) refuse('A newer resolution replaced this one.', 'resolution-required');
      exact(resolved, ['targets', 'preconditions', 'operations', 'credentialTargets'], ['targets', 'preconditions', 'operations']);
      let targets = canonicalTargets(resolved.targets, { allowEmpty: !resolved.operations?.length && !resolved.preconditions?.length });
      if (targets.some((target) => target.resourceId && !config.subscriptionIds.includes(target.resourceId.split('/')[2]))) {
        refuse('Resolved subscription is outside deployment policy.', 'target-policy-refused', 403);
      }
      if (!Array.isArray(resolved.operations) || resolved.operations.length > 64
        || !Array.isArray(resolved.preconditions) || resolved.preconditions.length > 32) refuse('Adapter resolution exceeds its budget.', 'adapter-contract-invalid');
      const operations = resolved.operations.map(operation);
      const origins = [...new Set(operations.map((request) => new URL(request.url).origin))];
      targets = canonicalTargets([...targets, ...origins.filter((origin) => !targets.some((target) => target.origin === origin))
        .map((origin) => ({ resourceId: '', origin }))], { allowEmpty: !operations.length && !resolved.preconditions.length });
      if (new Set(operations.map((item) => item.id)).size !== operations.length) refuse('Duplicate effect identities.', 'adapter-contract-invalid');
      const preconditions = resolved.preconditions.map((value) => {
        exact(value, ['request', 'digest']);
        const request = operation(value.request);
        if (request.effect !== 'read' || !HASH.test(value.digest)) refuse('Invalid read precondition.', 'adapter-contract-invalid');
        return { request, digest: value.digest };
      });
      const credentialTargets = resolved.credentialTargets ?? {};
      exact(credentialTargets, [...request.sample.configurationEntries.filter((field) => field.secret).map((field) => field.path),
        ...adapter.generatedFields], []);
      Object.values(credentialTargets).forEach(validateCredentialTarget);
      for (const [field, binding] of Object.entries(request.secretBindings)) slots.resolveBinding(session, field, binding, credentialTargets[field]);
      const id = randomToken(), expiresAt = sessions.now() + 300000;
      const purposes = [...new Set([...operations, ...preconditions.map((item) => item.request)].map((item) => item.purpose).filter((purpose) => purpose !== 'gateway-key'))];
      const sourceDigests = immutable({ notebookExpected: CATALOGUE.sourceNotebook.sha256,
        catalogueMetadata: digest({ notebook: CATALOGUE.sourceNotebook, cells: request.sample.sourceCells }) });
      const targetDigest = digest({ targets, credentialTargets,
        routes: [...operations, ...preconditions.map((item) => item.request)].map(({ purpose, method, url }) => ({ purpose, method, url })) });
      const policyDigest = digest({ adapter: adapter.id, version: adapter.version, policy: adapter.policyId });
      const requiredConsents = [];
      for (const purpose of purposes) {
        if (purpose === 'azure' ? session.azure : session.credentials[purpose]) continue;
        if (!RESOURCE_PURPOSES.includes(purpose) || !purposeEnabled(config, purpose)) continue;
        const intent = immutable({ purpose, consentIntentId: randomToken(), resolutionId: id,
          contextVersion: version, generation, targetDigest, policyDigest, owner: session.claims.oid,
          tenant: session.claims.tid, authGeneration: session.authGeneration, sessionId: session.id,
          expiresAt: Math.min(expiresAt, sessions.now() + config.transactionMs) });
        session.consentIntents.set(intent.consentIntentId, intent);
        requiredConsents.push(Object.fromEntries(['purpose', 'consentIntentId', 'resolutionId', 'contextVersion', 'targetDigest', 'expiresAt'].map((key) => [key, intent[key]])));
      }
      const state = purposes.some((purpose) => !purposeEnabled(config, purpose)) ? 'blocked'
        : purposes.some((purpose) => purpose === 'azure' ? !session.azure : !session.credentials[purpose]) ? 'consent-required' : 'ready';
      const credentialProofs = Object.fromEntries(Object.entries(request.secrets).map(([field, value]) =>
        [field, createHmac('sha256', salt).update(value).digest('hex')]));
      const identityDigest = digest({ sample: request.sample.id, adapter: adapter.version, policyDigest,
        targets, inputs: rebuilt.resolvedInputs, operations, credentialTargets, sourceDigests });
      const reviewDigest = digest({ identityDigest, preconditions, owner: session.claims.oid, tenant: session.claims.tid,
        sessionId: session.id, account: session.account?.homeAccountId ?? session.account?.localAccountId,
        authGeneration: session.authGeneration, grants: Object.fromEntries(Object.entries(session.credentials).map(([purpose, grant]) => [purpose, grant.grantGeneration])),
        version, generation, credentials: credentialProofs, bindings: request.secretBindings, expiresAt });
      let secrets = immutable(request.secrets);
      const resolution = Object.freeze({ id, state, sample: request.sample, inputs: immutable(rebuilt.resolvedInputs),
        get secrets() { return secrets; }, clearSecrets() { secrets = Object.freeze({}); },
        secretBindings: immutable(request.secretBindings), credentialTargets: immutable(credentialTargets),
        targets: immutable(targets), preconditions: immutable(preconditions), operations: immutable(operations), purposes,
        version, generation, expiresAt, targetDigest, policyDigest, identityDigest, reviewDigest, sourceDigests, adapter });
      session.stagedResolution = resolution;
      return { resolutionId: id, state, contextVersion: version, expiresAt, requiredConsents,
        preview: createRedactor(Object.values(request.secrets)).value({ sampleId: request.sample.id, adapterVersion: adapter.version, targets,
          sourceDigests,
          templateManifestDigest: null, reads: preconditions.map((item) => item.request), effects: operations,
          artifacts: [], credentialBindings: request.secretBindings, limits: { deadlineMs: 75000, maxRequests: 128 },
          residuals: [], reviewDigest }),
        issues: state === 'ready' ? [] : ['Resource authorization is missing or its service contract is unverified.'] };
    },
    consentIntent(session, payload) {
      envelope(payload, ['purpose', 'resolutionId', 'contextVersion', 'consentIntentId', 'targetDigest']);
      const fail = () => refuse('Resolve this recipe again before resource consent.', 'consent-intent-stale');
      if (!sessions.authorized(session) || session.authPending) fail();
      const resolution = session.stagedResolution, intent = session.consentIntents.get(payload.consentIntentId);
      if (!RESOURCE_PURPOSES.includes(payload.purpose) || !purposeEnabled(config, payload.purpose) || !intent || !resolution
        || payload.contextVersion !== session.contextVersion || payload.resolutionId !== resolution.id
        || intent.resolutionId !== resolution.id || intent.generation !== session.resolutionGeneration
        || intent.expiresAt <= sessions.now() || resolution.expiresAt <= sessions.now()
        || intent.authGeneration !== session.authGeneration || intent.sessionId !== session.id
        || intent.owner !== session.claims.oid || intent.tenant !== session.claims.tid
        || intent.purpose !== payload.purpose || intent.targetDigest !== payload.targetDigest
        || resolution.targetDigest !== payload.targetDigest || intent.policyDigest !== resolution.policyDigest) fail();
      return intent;
    },
  });
}
