import { randomUUID, createHash } from 'node:crypto';
import { randomToken, sameToken } from './sessions.mjs';
import { CATALOGUE, buildSamplePlan, requirementsFor } from '../catalogue/index.mjs';
import { validateRunRequest, rebuildPlan, RequestRefused } from '../server/runRequest.mjs';
import { createRelayHttpExecutor } from '../relay/httpExecutor.mjs';
import { createOriginAllowlist } from '../relay/originAllowlist.mjs';
import { createSampleRequestPolicy } from '../relay/requestPolicy.mjs';
import { ARM_RECIPES, GATEWAY_RECIPES, HOSTED_RECIPES, GUID } from './config.mjs';
import { hostedManagementPlan } from '../core/hostedPlan.mjs';
import { createHttpsTransport } from './httpsTransport.mjs';
import { parseHttpResponse, extractToolCallText, parseWeatherPayload } from '../core/parsing.mjs';
import { createRedactor } from '../server/redaction.mjs';

const refuse = (message, code = 'hosted-request-refused', status = 409) => { throw new RequestRefused(message, { code, status }); };
const text = (value, limit = 256) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f]/.test(value) ? value : '';

export function createHostedRuntime(config, sessions, auth, { fetchImpl = createHttpsTransport(), staged = null } = {}) {
  const gatewayPolicy = config.gatewayPolicy ? createSampleRequestPolicy(config.gatewayPolicy.samples) : null;
  const gatewayOptions = gatewayPolicy ? {
    requestPolicy: gatewayPolicy, allowlist: createOriginAllowlist(config.gatewayPolicy.origins),
  } : null;
  let activeRuns = 0;
  const digest = ({ runNonce, ...payload }) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const allowed = [
    ...(config.subscriptionIds.length ? ARM_RECIPES : []),
    ...GATEWAY_RECIPES.filter((id) => config.gatewayPolicy?.samples[id]),
  ];

  function requireOperator(session) {
    if (!sessions.authorized(session) || session.authPending) refuse('Sign in with an authorized operator account.', 'operator-required', 403);
  }
  async function arm(session, path, { signal, fetchRequest = fetchImpl } = {}) {
    requireOperator(session);
    const version = session.contextVersion;
    const token = await auth.token(session, 'azure', { signal });
    requireOperator(session);
    if (session.contextVersion !== version) refuse('Context changed; review again.', 'context-changed');
    const url = new URL(path, config.cloud.resourceManager);
    if (url.origin !== new URL(config.cloud.resourceManager).origin || !url.pathname.startsWith('/subscriptions')) refuse('Invalid ARM operation.');
    const response = await fetchRequest(url.href, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.any([session.controller.signal, ...(signal ? [signal] : [])]),
    });
    if (!response.ok) refuse(`Azure returned HTTP ${response.status}. Confirm this account's RBAC and target.`, 'azure-request-failed', 502);
    return response.json();
  }
  async function subscriptions(session) {
    const result = [];
    let path = '/subscriptions?api-version=2022-12-01';
    const seen = new Set();
    for (let page = 0; path && page < 10; page++) {
      const url = new URL(path, config.cloud.resourceManager);
      if (url.pathname !== '/subscriptions' || seen.has(url.href)) refuse('Invalid Azure subscription pagination.');
      seen.add(url.href);
      const data = await arm(session, url.href);
      if (!Array.isArray(data.value)) refuse('Azure returned an invalid subscription list.');
      for (const item of data.value) {
        if (config.subscriptionIds.includes(item.subscriptionId) && item.state === 'Enabled'
          && item.tenantId === config.tenantId) {
          result.push({ id: item.subscriptionId, name: text(item.displayName), tenantId: item.tenantId,
            state: item.state, isDefault: session.subscription?.id === item.subscriptionId });
        }
      }
      path = data.nextLink ?? null;
    }
    if (path) refuse('Azure subscription pagination exceeds the limit.');
    return result;
  }
  async function select(session, id) {
    if (!GUID.test(id ?? '') || !config.subscriptionIds.includes(id)) refuse('Subscription is not permitted.', 'subscription-not-permitted', 403);
    const candidates = await subscriptions(session);
    const target = candidates.find((candidate) => candidate.id === id);
    if (!target) refuse('Subscription is not enabled for this account.', 'subscription-unavailable', 403);
    sessions.invalidateContext(session);
    session.subscription = target;
    return target;
  }
  function context(session, request) {
    requireOperator(session);
    if (!CATALOGUE.byId.has(request.sampleId)) refuse('Unknown recipe.');
    const management = ARM_RECIPES.includes(request.sampleId);
    const supported = HOSTED_RECIPES.includes(request.sampleId);
    const enabled = allowed.includes(request.sampleId);
    const matches = GUID.test(session.subscription?.id ?? '') && GUID.test(request.configuredSubscriptionId ?? '')
      && session.subscription.id === request.configuredSubscriptionId;
    const ready = enabled && (management ? session.azure === true && matches : request.gateway?.keyPresent === true);
    const reason = !supported ? 'This recipe is not enabled in this Docker phase. A protected execution adapter is still required.'
      : !enabled ? 'The deployment owner must configure the permitted targets for this Docker adapter.'
      : management && !session.azure ? 'Connect Azure in this application. No CLI login is used.'
      : management && !session.subscription ? 'Select an authorized subscription in this application.'
      : management && !matches ? 'The selected subscription must match the intended recipe target.'
      : !management && !request.gateway?.keyPresent ? 'Enter the access-contract gateway key. Azure permissions are not required.'
      : 'Ready to attempt the reviewed HTTPS operation. The target still enforces authorization.';
    return {
      kind: !supported ? 'hosted-unavailable' : management ? 'hosted-delegated-user' : 'gateway-key',
      label: !supported ? 'Protected Docker adapter required' : management ? 'Application-owned Azure user session' : 'Gateway access-contract key',
      state: ready ? 'ready-to-attempt' : 'unavailable', summary: reason, canExecute: ready,
      code: ready ? null : 'hosted-context-unavailable',
      applicationOperator: { name: text(session.claims.preferred_username) || session.claims.oid, tenantId: session.claims.tid },
      signedInAccount: management ? { state: 'signed-in', principalName: text(session.claims.preferred_username) || session.claims.oid,
        principalType: 'user', tenantId: session.claims.tid, objectId: session.claims.oid } : null,
      executionCredential: { type: !supported ? 'none' : management ? 'delegated-user' : 'apim-subscription-key', source: !supported ? 'none' : management ? 'server-owned-msal-cache' : 'transient-entered-key' },
      selectedSubscription: management ? session.subscription : null,
      activeCliSubscription: null,
      intendedTarget: management ? { subscriptionId: request.configuredSubscriptionId, matchesActive: matches } : null,
      authorization: { state: 'not-checked', label: 'Target authorization is not proven until the request succeeds.' },
      gateway: management ? null : { keyPresent: Boolean(request.gateway?.keyPresent), headerName: text(request.gateway?.headerName) },
      hostedRelay: null, contextVersion: session.contextVersion,
      guarantees: { tokensExposed: false, credentialsPersistedInApplicationState: false, privateAzureCliCache: 'none' },
    };
  }
  function prepare(session, payload) {
    requireOperator(session);
    const keys = ['protocolVersion', 'sampleId', 'inputs', 'secrets', 'acknowledgement', 'contextVersion', 'runNonce'];
    if (!payload || Object.keys(payload).some((key) => !keys.includes(key))) refuse('Invalid hosted request shape.', 'invalid-request', 400);
    if (!allowed.includes(payload.sampleId)) refuse('This recipe has no enabled Docker adapter.', 'hosted-recipe-unavailable', 403);
    if (payload.contextVersion !== session.contextVersion) refuse('Account or target changed. Refresh and review again.', 'context-changed');
    const request = validateRunRequest(payload, CATALOGUE);
    const rebuilt = rebuildPlan(request, CATALOGUE, { buildSamplePlan, requirementsFor });
    const management = ARM_RECIPES.includes(request.sample.id);
    if (management) {
      if (!session.azure || !session.subscription || session.subscription.id !== rebuilt.resolvedInputs['hub.subscriptionId']) {
        refuse('Connect Azure and explicitly select the intended subscription.', 'context-changed');
      }
      rebuilt.plan = hostedManagementPlan(request.sample, (path) => rebuilt.resolvedInputs[path], config.cloud);
    } else {
      const policy = gatewayPolicy.authorizeStaticPlan(request.sample.id, rebuilt.plan);
      if (!policy.ok) refuse('The gateway route or key header is outside the deployment policy.', 'gateway-policy-refused', 403);
    }
    return { ...rebuilt, request, management };
  }
  async function runManagement(session, prepared, signal, fetchRequest) {
    const { request, resolvedInputs, plan } = prepared;
    const subscriptionId = session.subscription.id;
    const steps = [];
    const record = (id, evidence) => {
      const item = plan.steps.find((step) => step.id === id);
      steps.push({ id, kind: item.type, title: item.title, state: 'completed', durationMs: 0, evidence });
    };
    let configurationUpdates = {};
    if (request.sample.id === 'azure-context-check') {
      const data = await arm(session, plan.steps[0].request.url, { signal, fetchRequest });
      if (data.subscriptionId !== subscriptionId || data.tenantId !== session.claims.tid || data.state !== 'Enabled') refuse('Azure context did not match the reviewed enabled subscription.');
      record('read-subscription', { subscriptionId, subscriptionName: text(data.displayName),
        tenantId: session.claims.tid, objectId: session.claims.oid });
      record('assert-context', { matches: true });
    } else {
      const listUrl = new URL(plan.steps[0].request.url);
      const services = [];
      let next = listUrl.href;
      for (let page = 0; next && page < 10; page++) {
        const nextUrl = new URL(next);
        if (nextUrl.origin !== listUrl.origin || nextUrl.pathname !== listUrl.pathname) refuse('Invalid APIM pagination target.');
        const data = await arm(session, next, { signal, fetchRequest });
        if (!Array.isArray(data.value)) refuse('Azure returned an invalid APIM list.');
        services.push(...data.value);
        next = data.nextLink ?? null;
      }
      if (next) refuse('APIM pagination exceeds the limit.');
      record('list-services', { serviceCount: services.length });
      const explicit = resolvedInputs['samples.apim-discovery.apimNameOverride'];
      const chosen = explicit ? services.filter((item) => item.name === explicit) : services;
      if (chosen.length !== 1 || !/^[A-Za-z0-9-]{1,100}$/.test(chosen[0].name ?? '')) {
        refuse('Select exactly one APIM service by its explicit name; the first candidate is never chosen automatically.');
      }
      const name = chosen[0].name;
      record('select-service', { apimName: name });
      const url = `${listUrl.origin}${listUrl.pathname}/${encodeURIComponent(name)}?api-version=2022-08-01`;
      const service = await arm(session, url, { signal, fetchRequest });
      const expectedId = `${listUrl.pathname}/${name}`;
      if (service.name !== name || service.id?.toLowerCase() !== expectedId.toLowerCase()
        || typeof service.properties?.gatewayUrl !== 'string') refuse('Azure returned an invalid APIM service.');
      const gatewayUrl = new URL(service.properties.gatewayUrl);
      if (gatewayUrl.protocol !== 'https:' || gatewayUrl.username || gatewayUrl.password || gatewayUrl.hash || gatewayUrl.search
        || gatewayUrl.pathname !== '/') refuse('Azure returned an invalid HTTPS gateway origin.');
      configurationUpdates = { 'hub.apimName': name, 'hub.gatewayUrl': gatewayUrl.origin };
      record('show-service', { apimName: name, gatewayUrl: gatewayUrl.origin, sku: text(service.sku?.name), location: text(service.location) });
      record('assert-gateway', { https: true });
    }
    return { sampleId: request.sample.id, state: 'completed', summary: 'Azure HTTPS checks completed using the signed-in user.',
      steps, assertions: steps.filter((step) => step.kind === 'assertion').map((step) => ({
        id: step.id, status: 'passed', detail: step.title, evidence: step.evidence,
      })), configurationUpdates, secretUpdates: {}, meta: {} };
  }
  return Object.freeze({
    allowed, subscriptions, select, context, prepare, staged,
    review(session, payload) {
      prepare(session, payload);
      session.review = { nonce: randomToken(), digest: digest(payload), expires: sessions.now() + 60000 };
      return { runNonce: session.review.nonce };
    },
    async run(session, payload, { signal } = {}) {
      const prepared = prepare(session, payload);
      const review = session.review;
      session.review = null;
      if (!review || review.expires <= sessions.now() || !sameToken(review.nonce, payload.runNonce)
        || review.digest !== digest(payload)) refuse('Review expired or already used. Review again.', 'review-required');
      if (session.run) refuse('Another run is active in this session.');
      if (activeRuns >= (config.maxConcurrentRuns ?? 8)) refuse('The hosted runner is busy. Review and retry later.', 'runner-busy', 429);
      const controller = new AbortController();
      const operation = { id: randomUUID(), controller, version: session.contextVersion };
      session.run = operation;
      activeRuns++;
      const runSignal = AbortSignal.any([controller.signal, session.controller.signal, AbortSignal.timeout(75000), ...(signal ? [signal] : [])]);
      let responses = 0, attempted = false, uncertain = false, weather = null;
      const fetchRequest = async (url, options) => {
        requireOperator(session);
        if (runSignal.aborted || operation.version !== session.contextVersion) refuse('Execution context changed.', 'context-changed');
        attempted = true;
        let response;
        try { response = await fetchImpl(url, options); }
        catch (error) { uncertain = true; throw error; }
        responses++;
        if (payload.sampleId === 'weather-tools-call' && options.body) {
          const request = JSON.parse(options.body);
          if (request.method === 'tools/call' && response.ok) {
            const parsed = parseHttpResponse({ headers: response.headers, text: await response.clone().text() }, { jsonRpcId: request.id });
            const value = parseWeatherPayload(extractToolCallText(parsed.data?.result));
            if (value && ['temperature', 'humidity', 'wind_speed'].every((field) => Number.isFinite(value[field]))) {
              weather = createRedactor(Object.values(prepared.request.secrets)).value({
                city: text(value.city, 128), temperature: value.temperature, temperature_format: text(value.temperature_format, 32),
                description: text(value.description, 512), humidity: value.humidity, wind_speed: value.wind_speed,
              });
            }
          }
        }
        return response;
      };
      const meta = () => ({ executor: 'hosted-bff', executionLocation: 'hosted',
        azureContacted: prepared.management && responses > 0, liveEvidence: responses > 0,
        evidenceSource: responses > 0 ? 'live-target' : 'no-target-response',
        credentialType: prepared.management ? 'delegated-user' : 'apim-subscription-key' });
      try {
        const result = prepared.management
          ? await runManagement(session, prepared, runSignal, fetchRequest)
          : await createRelayHttpExecutor({ ...gatewayOptions, fetchImpl: fetchRequest })
            .execute(prepared.plan, { secrets: prepared.request.secrets, signal: runSignal });
        requireOperator(session);
        if (runSignal.aborted || operation.version !== session.contextVersion) refuse('Run was cancelled or its context changed. Already-sent requests may have completed.', 'run-cancelled');
        if (weather) result.steps = result.steps.map((step) => step.id === 'tools-call' ? { ...step, evidence: { ...step.evidence, weather } } : step);
        if (payload.sampleId === 'weather-tools-call' && result.state === 'completed') {
          const expectedCity = prepared.resolvedInputs['samples.weather-tools-call.city'];
          const expectedUnit = prepared.plan.steps.find((step) => step.id === 'assert-weather').assertion.expectedUnit;
          const matches = weather && weather.city === expectedCity && weather.temperature_format === expectedUnit && weather.description;
          if (!matches) {
            result.state = 'failed';
            result.summary = 'The Weather response did not match the reviewed city and typed payload contract.';
          }
          result.assertions = prepared.request.sample.expectedResults.map((expected) => ({
            id: expected.id, status: matches ? 'passed' : 'failed',
            detail: matches ? 'Verified against the returned typed Weather payload.' : 'The returned Weather payload did not satisfy the reviewed contract.',
          }));
        }
        if (uncertain) {
          result.state = 'inconclusive';
          result.summary = 'A request has no confirmed outcome. Already-sent operations may have completed; no automatic retry was made.';
        }
        return { ...result, runId: operation.id, meta: { ...result.meta, ...meta() } };
      } catch (error) {
        return { sampleId: payload.sampleId, runId: operation.id, state: attempted ? 'inconclusive' : 'blocked',
          summary: attempted ? 'The run stopped. Already-sent requests may have completed; no automatic retry was made.'
            : error instanceof RequestRefused || ['azure-consent-required', 'azure-token-unavailable'].includes(error.code)
              ? error.message : 'The hosted request could not start. Refresh authorization and review again.',
          steps: [], assertions: [], configurationUpdates: {}, secretUpdates: {}, meta: meta() };
      } finally { activeRuns--; if (session.run === operation) session.run = null; }
    },
    cancel(session) { requireOperator(session); session.run?.controller.abort(); return { cancelled: Boolean(session.run) }; },
  });
}
