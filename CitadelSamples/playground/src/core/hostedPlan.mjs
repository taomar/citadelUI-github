import { createExecutionPlan, step } from './plan.mjs';

export const HOSTED_ARM_SAMPLES = Object.freeze(['azure-context-check', 'apim-discovery']);
const GATEWAY_SAMPLES = ['weather-mcp-discovery', 'learn-mcp-discovery', 'a2a-agent-card', 'a2a-message-send', 'weather-tools-call'];
export const isHostedSampleSupported = (id) => HOSTED_ARM_SAMPLES.includes(id) || GATEWAY_SAMPLES.includes(id);

export function hostedPresentation(sample, plan) {
  if (HOSTED_ARM_SAMPLES.includes(sample.id)) return hostedManagementPresentation(sample, plan);
  if (GATEWAY_SAMPLES.includes(sample.id)) return sample;
  return { ...sample, hostedUnsupported: true, summary: 'No executable Docker adapter is available for this recipe. Application sign-in does not supply an execution credential.',
    purpose: 'Inspect the protected reference and declared inputs; execution requires a separately approved Docker adapter.',
    explanation: ['The signed-in application operator is distinct from the unavailable execution identity.'],
    prerequisites: [{ id: 'adapter', title: 'Protected Docker adapter required', detail: 'This recipe cannot run in this Docker phase.' }],
    flow: [], runtime: { dependencies: [], note: 'No execution credential or process is available.' },
    expectedResults: [], notes: ['The original notebook source is nonexecuted provenance, not a Docker operation.'] };
}

export function hostedManagementPresentation(sample, plan) {
  const summary = plan?.summary ?? 'Read Azure through this application session\'s delegated user credential.';
  return { ...sample, summary, purpose: summary,
    explanation: ['This Docker adapter uses fixed HTTPS ARM requests as the signed-in user. The protected notebook remains the original CLI-based reference, not code executed by this backend.'],
    flow: (plan?.steps ?? []).map((item) => item.title),
    prerequisites: [{ id: 'hosted-user', title: 'Authorized operator and delegated Azure access',
      detail: 'Sign in, connect Azure, and explicitly select a permitted subscription in this application.',
      howTo: 'Use the account controls above the target inputs. The same account needs Azure RBAC for the selected resources.' }],
    risk: plan?.risk ?? { ...sample.risk, effect: 'Read the selected Azure target through HTTPS; no resource changes.' },
    runtime: { dependencies: [], note: 'Server-owned delegated ARM token. No CLI, Python or terminal context.' },
    expectedResults: (plan?.steps ?? []).filter((item) => item.type === 'assertion').map((item) => ({
      id: item.id, title: item.title, assertion: item.title, evidence: 'The delegated ARM response.',
      whenNotRun: 'Not run; target authorization and returned values remain unknown.',
    })),
    notes: plan?.notes ?? [], deviations: plan?.deviations ?? [],
  };
}

export function hostedManagementPlan(sample, read, { resourceManager }) {
  const subscription = String(read('hub.subscriptionId') ?? '');
  const root = resourceManager.replace(/\/$/, '');
  const subscriptionUrl = `${root}/subscriptions/${encodeURIComponent(subscription)}?api-version=2022-12-01`;
  const resourceGroup = String(read('hub.resourceGroupName') ?? '');
  const name = String(read('samples.apim-discovery.apimNameOverride') ?? '');
  const base = `${root}/subscriptions/${encodeURIComponent(subscription)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ApiManagement/service`;
  const steps = sample.id === 'azure-context-check' ? [
    step.http({ id: 'read-subscription', title: 'Read the selected Azure subscription as the signed-in user',
      request: { method: 'GET', url: subscriptionUrl, headers: { Authorization: '(server-owned delegated ARM token)' } } }),
    step.assertion({ id: 'assert-context', title: 'Verify enabled subscription and tenant binding', assertion: { kind: 'equals', expected: subscription } }),
  ] : [
    step.http({ id: 'list-services', title: 'List API Management services in the selected resource group',
      request: { method: 'GET', url: `${base}?api-version=2022-08-01`, headers: { Authorization: '(server-owned delegated ARM token)' } } }),
    step.assertion({ id: 'select-service', title: 'Require one candidate or the explicitly selected service', produces: ['apimName'], assertion: { kind: 'selection', selected: name || '(the single candidate)' } }),
    step.http({ id: 'show-service', title: 'Read the selected API Management service',
      request: { method: 'GET', url: `${base}/${name ? encodeURIComponent(name) : '{{steps.select-service.apimName}}'}?api-version=2022-08-01`,
        headers: { Authorization: '(server-owned delegated ARM token)' } } }),
    step.assertion({ id: 'assert-gateway', title: 'Verify the HTTPS gateway URL', assertion: { kind: 'shape' } }),
  ];
  return createExecutionPlan({
    sampleId: sample.id, title: sample.title, summary: 'Read Azure through HTTPS using this application session\'s delegated user credential.',
    risk: { ...sample.risk, effect: 'Read the selected Azure resources over HTTPS. No resource is changed.' },
    sourceCells: sample.sourceCells, steps,
    notes: ['Docker adapter: protected notebook source is unchanged; this operation uses ARM HTTP, not Azure CLI or Python.'],
    deviations: ['Uses delegated-user ARM requests instead of the notebook\'s CLI account cache.'],
  });
}
