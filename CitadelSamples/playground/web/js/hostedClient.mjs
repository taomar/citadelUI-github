let capabilities = null;

export function setHostedCapabilities(value) { capabilities = value?.auth?.mode === 'bff' ? value : null; }
export function hostedAuth() { return capabilities?.auth ?? null; }
export function sessionFetch(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.method === 'POST' && capabilities?.auth?.csrf) headers.set('X-Citadel-CSRF', capabilities.auth.csrf);
  return fetch(path, { ...options, headers, credentials: 'same-origin' });
}
export async function hostedPost(path, payload) {
  const response = await sessionFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.summary || `Request failed (${response.status}).`), { status: response.status, code: data.code });
  return data;
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
