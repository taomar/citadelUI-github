let capabilities = null;
const authMutations = new Set(['/api/auth/start', '/api/auth/cancel', '/api/auth/logout',
  '/api/auth/device/start', '/api/auth/device/cancel', '/api/auth/device/complete']);

export function createCapabilityFreshness() {
  let sequence = 0, epoch = 0, mutations = 0;
  return Object.freeze({
    beginRead: () => ({ sequence: ++sequence, epoch, duringMutation: mutations > 0 }),
    isCurrent: (ticket) => ticket.sequence === sequence && ticket.epoch === epoch
      && !ticket.duringMutation && mutations === 0,
    beginMutation() {
      epoch++; mutations++;
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        // Even the newest GET may have read the pre-commit session during this mutation.
        mutations--; epoch++;
      };
    },
  });
}
const capabilityFreshness = createCapabilityFreshness();
export const beginHostedCapabilityRead = () => capabilityFreshness.beginRead();
export const isHostedCapabilityReadCurrent = (ticket) => capabilityFreshness.isCurrent(ticket);
export function setHostedCapabilities(value, ticket) {
  if (ticket && !isHostedCapabilityReadCurrent(ticket)) return false;
  capabilities = value?.auth?.mode === 'bff' ? value : null;
  return true;
}
export function hostedAuth() { return capabilities?.auth ?? null; }
export function sessionFetch(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.method === 'POST' && capabilities?.auth?.csrf) headers.set('X-Citadel-CSRF', capabilities.auth.csrf);
  return fetch(path, { ...options, headers, credentials: 'same-origin' });
}
export async function hostedPost(path, payload, { signal } = {}) {
  const settled = authMutations.has(path) ? capabilityFreshness.beginMutation() : () => {};
  try {
    const response = await sessionFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.summary || `Request failed (${response.status}).`), { status: response.status, code: data.code });
    return data;
  } finally { settled(); }
}
export async function hostedDevicePost(action, payload) {
  const result = await hostedPost(`/api/auth/device/${action}`, { protocolVersion: 2, deviceFlowVersion: 1, ...payload },
    { signal: AbortSignal.timeout(10000) });
  if (result.csrf && capabilities?.auth) capabilities.auth.csrf = result.csrf;
  return result;
}
export async function startStagedConsent(intent) {
  const ticket = beginHostedCapabilityRead();
  const response = await sessionFetch('/api/capabilities');
  if (!response.ok) throw new Error('Sign-in readiness could not be refreshed. Retry from this application.');
  const current = await response.json();
  if (!isHostedCapabilityReadCurrent(ticket)) throw new Error('Sign-in readiness was superseded. Retry explicitly from this application.');
  if (current.auth?.mode !== 'bff' || !current.auth.authorized || current.auth.contextVersion !== intent.contextVersion) {
    throw new Error('The account or target changed. Resolve this recipe again.');
  }
  setHostedCapabilities(current, ticket);
  const { purpose, resolutionId, contextVersion, consentIntentId, targetDigest } = intent;
  return hostedPost('/api/auth/start', { purpose, protocolVersion: 2, hostedFlowVersion: 1,
    resolutionId, contextVersion, consentIntentId, targetDigest });
}
export function createHostedExecutorClient({ capability, contextVersion }) {
  return Object.freeze({
    id: 'hosted-bff',
    describeCapability: () => capability,
    supports: (plan) => ({ supported: capability.allowedSampleIds.includes(plan.sampleId)
      && plan.requiredStepTypes.every((type) => ['http', 'assertion'].includes(type)),
    unsupportedStepTypes: plan.requiredStepTypes.filter((type) => !['http', 'assertion'].includes(type)) }),
    async execute(plan, { inputs, secrets, acknowledgement } = {}) {
      const request = { protocolVersion: 2, sampleId: plan.sampleId,
        inputs, secrets, acknowledgement, contextVersion: contextVersion() };
      const { runNonce } = await hostedPost('/api/hosted/review', request);
      return hostedPost('/api/hosted/run', { ...request, runNonce });
    },
    cancel: () => hostedPost('/api/hosted/cancel', {}),
  });
}
