/**
 * Pure access-target aggregation retained for isolated compatibility tests.
 *
 * Callers provide source text. readEnvironmentVariable() is evaluated only as
 * syntax: its literal fallback is used and no environment or host file is read.
 * Production server/index.mjs does not import or route this legacy helper.
 */
import { nodeToValue, parseBicepParam } from './bicepparam/parser.mjs';

const MAIN_ALIAS = 'bicep/infra/main.bicepparam';
const ONBOARDING_ALIAS = 'bicep/infra/llm-backend-onboarding/main.bicepparam';

function readParams(text, name) {
  if (typeof text !== 'string') throw new TypeError(`${name} source text is required.`);
  const doc = parseBicepParam(text);
  return new Map(doc.params.map((param) => [param.name, nodeToValue(param.value)]));
}

function evaluate(value) {
  if (Array.isArray(value)) return value.map(evaluate);
  if (!value || typeof value !== 'object') return value;
  if (value.__expr === 'call') {
    if (value.callee === 'readEnvironmentVariable') {
      return evaluate(value.args?.[1] ?? '');
    }
    if (value.callee === 'string') return String(evaluate(value.args?.[0]) ?? '');
    if (value.callee === 'int') return Number(evaluate(value.args?.[0]));
    if (value.callee === 'bool') {
      const raw = evaluate(value.args?.[0]);
      return raw === true || raw === 'true';
    }
    return '';
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, evaluate(entry)]));
}

function valueFrom(params, name) {
  return evaluate(params.get(name)) || '';
}

function completeness(value, required) {
  const missing = required.filter((field) => !String(value[field] || '').trim());
  return { ready: missing.length === 0, missing };
}

export function aggregateAccessContractTargets(options = {}) {
  const main = readParams(options.mainText, 'Main parameter');
  const onboarding = readParams(options.onboardingText, 'Onboarding parameter');

  const subscriptionId = String(valueFrom(main, 'subscriptionId'));
  const resourceGroupName = String(valueFrom(main, 'resourceGroupName'));
  const apim = {
    subscriptionId,
    resourceGroupName,
    name: String(valueFrom(main, 'apimServiceName')),
  };
  Object.assign(apim, completeness(apim, ['subscriptionId', 'resourceGroupName', 'name']));
  apim.missingLocal = [
    !apim.subscriptionId ? 'subscriptionId fallback' : null,
    !apim.resourceGroupName ? 'resourceGroupName fallback' : null,
    !apim.name ? 'apimServiceName fallback' : null,
  ].filter(Boolean);

  const keyVault = {
    subscriptionId,
    resourceGroupName,
    name: String(valueFrom(main, 'keyVaultName')),
  };
  Object.assign(keyVault, completeness(keyVault, ['subscriptionId', 'resourceGroupName', 'name']));
  keyVault.missingLocal = [
    !keyVault.subscriptionId ? 'subscriptionId fallback' : null,
    !keyVault.resourceGroupName ? 'resourceGroupName fallback' : null,
    !keyVault.name ? 'keyVaultName fallback' : null,
  ].filter(Boolean);

  const backends = (evaluate(onboarding.get('llmBackendConfig')) || [])
    .filter((entry) => entry && entry.backendType === 'ai-foundry')
    .map((entry) => ({
      backendId: entry.backendId || '',
      endpoint: entry.endpoint || '',
      models: (entry.supportedModels || []).map((model) => model && model.name).filter(Boolean),
    }));

  const configured = evaluate(main.get('aiFoundryInstances'));
  const rawFoundries = (Array.isArray(configured) ? configured : []).map((instance, index) => {
    const accountName = String(instance?.name || '');
    const matchedBackends = backends.filter(
      (backend) =>
        accountName && backend.endpoint.toLowerCase().includes(accountName.toLowerCase())
    );
    const target = {
      index,
      subscriptionId,
      resourceGroupName,
      accountName,
      projectName: String(instance?.defaultProjectName || ''),
      location: String(instance?.location || ''),
      provenance: matchedBackends,
    };
    return {
      ...target,
      ...completeness(target, [
        'subscriptionId',
        'resourceGroupName',
        'accountName',
        'projectName',
      ]),
      missingLocal: [
        !subscriptionId ? 'subscriptionId fallback' : null,
        !resourceGroupName ? 'resourceGroupName fallback' : null,
        !accountName ? `aiFoundryInstances[${index}].name fallback` : null,
        !target.projectName ? `aiFoundryInstances[${index}].defaultProjectName` : null,
      ].filter(Boolean),
    };
  });

  const foundryMap = new Map();
  for (const target of rawFoundries) {
    const key = target.ready
      ? [target.subscriptionId, target.resourceGroupName, target.accountName, target.projectName]
          .map((value) => value.toLowerCase())
          .join('|')
      : `incomplete:${target.index}`;
    const prior = foundryMap.get(key);
    if (!prior) {
      foundryMap.set(key, { ...target, indices: [target.index] });
    } else {
      prior.indices.push(target.index);
      const merged = new Map(
        [...prior.provenance, ...target.provenance].map((backend) => [
          backend.backendId,
          backend,
        ])
      );
      prior.provenance = [...merged.values()];
    }
  }
  const foundries = [...foundryMap.values()];

  const matched = new Set(
    foundries.flatMap((target) => target.provenance.map((backend) => backend.backendId))
  );
  const partialFoundries = backends
    .filter((backend) => !matched.has(backend.backendId))
    .map((backend) => ({
      backendId: backend.backendId,
      endpoint: backend.endpoint,
      models: backend.models,
      ready: false,
      missing: ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName'],
    }));

  return {
    environment: null,
    environmentFile: null,
    apim,
    keyVault,
    foundries,
    partialFoundries,
    sources: { main: MAIN_ALIAS, onboarding: ONBOARDING_ALIAS },
  };
}
