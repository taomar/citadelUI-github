import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './config.mjs';
import { parseEnvFile } from './envlayer.mjs';
import { parseBicepParam, nodeToValue } from './bicepparam/parser.mjs';

const MAIN = 'bicep/infra/main.bicepparam';
const ONBOARDING = 'bicep/infra/llm-backend-onboarding/main.bicepparam';

function readParams(root, relativePath) {
  const text = readFileSync(join(root, relativePath), 'utf8');
  const doc = parseBicepParam(text);
  return new Map(doc.params.map((param) => [param.name, nodeToValue(param.value)]));
}

function envMap(root, environment) {
  if (!environment) return new Map();
  const file = join(root, '.azure', environment, '.env');
  if (!existsSync(file)) return new Map();
  return new Map(parseEnvFile(readFileSync(file, 'utf8')).map((entry) => [entry.key, entry.value]));
}

function resolve(value, env) {
  if (Array.isArray(value)) return value.map((entry) => resolve(entry, env));
  if (!value || typeof value !== 'object') return value;
  if (value.__expr === 'call') {
    if (value.callee === 'readEnvironmentVariable') {
      const name = String(value.args[0] || '');
      return env.has(name) ? env.get(name) : resolve(value.args[1] ?? '', env);
    }
    if (['string', 'int', 'bool'].includes(value.callee)) {
      const raw = resolve(value.args[0], env);
      if (value.callee === 'int') return Number(raw);
      if (value.callee === 'bool') return raw === true || raw === 'true';
      return String(raw ?? '');
    }
    return '';
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry, env)]));
}

function valueFrom(params, env, name, envName = null) {
  if (envName && env.has(envName)) return env.get(envName);
  return resolve(params.get(name), env) || '';
}

function completeness(value, required) {
  const missing = required.filter((field) => !String(value[field] || '').trim());
  return { ready: missing.length === 0, missing };
}

export function aggregateAccessContractTargets(options = {}) {
  const root = options.repoRoot || repoRoot;
  const environment = options.environment || null;
  const env = envMap(root, environment);
  const main = readParams(root, MAIN);
  const onboarding = readParams(root, ONBOARDING);

  const subscriptionId = env.get('AZURE_SUBSCRIPTION_ID') || '';
  const resourceGroupName = valueFrom(main, env, 'resourceGroupName', 'AZURE_RESOURCE_GROUP');
  const apim = {
    subscriptionId,
    resourceGroupName,
    name: valueFrom(main, env, 'apimServiceName', 'APIM_SERVICE_NAME'),
  };
  Object.assign(apim, completeness(apim, ['subscriptionId', 'resourceGroupName', 'name']));
  apim.missingLocal = [
    !apim.subscriptionId ? 'AZURE_SUBSCRIPTION_ID' : null,
    !apim.resourceGroupName ? 'resourceGroupName or AZURE_RESOURCE_GROUP' : null,
    !apim.name ? 'apimServiceName or APIM_SERVICE_NAME' : null,
  ].filter(Boolean);

  const keyVault = {
    subscriptionId,
    resourceGroupName,
    name: valueFrom(main, env, 'keyVaultName', 'KEY_VAULT_NAME'),
  };
  Object.assign(keyVault, completeness(keyVault, ['subscriptionId', 'resourceGroupName', 'name']));
  keyVault.missingLocal = [
    !keyVault.subscriptionId ? 'AZURE_SUBSCRIPTION_ID' : null,
    !keyVault.resourceGroupName ? 'resourceGroupName or AZURE_RESOURCE_GROUP' : null,
    !keyVault.name ? 'keyVaultName or KEY_VAULT_NAME' : null,
  ].filter(Boolean);

  const backends = (resolve(onboarding.get('llmBackendConfig'), env) || [])
    .filter((entry) => entry && entry.backendType === 'ai-foundry')
    .map((entry) => ({
      backendId: entry.backendId || '',
      endpoint: entry.endpoint || '',
      models: (entry.supportedModels || []).map((model) => model && model.name).filter(Boolean),
    }));

  const configured = resolve(main.get('aiFoundryInstances'), env);
  const rawFoundries = (Array.isArray(configured) ? configured : []).map((instance, index) => {
    const accountName = String(instance && instance.name || env.get('AI_FOUNDRY_RESOURCE_NAME') || '');
    const matchedBackends = backends.filter((backend) =>
      accountName && backend.endpoint.toLowerCase().includes(accountName.toLowerCase())
    );
    const target = {
      index,
      subscriptionId,
      resourceGroupName,
      accountName,
      projectName: String(instance && instance.defaultProjectName || ''),
      location: String(instance && instance.location || ''),
      provenance: matchedBackends,
    };
    return {
      ...target,
      ...completeness(target, ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName']),
      missingLocal: [
        !subscriptionId ? 'AZURE_SUBSCRIPTION_ID' : null,
        !resourceGroupName ? 'resourceGroupName or AZURE_RESOURCE_GROUP' : null,
        !accountName ? `aiFoundryInstances[${index}].name or AI_FOUNDRY_RESOURCE_NAME` : null,
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
      const merged = new Map([...prior.provenance, ...target.provenance].map((backend) => [backend.backendId, backend]));
      prior.provenance = [...merged.values()];
    }
  }
  const foundries = [...foundryMap.values()];

  const matched = new Set(foundries.flatMap((target) => target.provenance.map((backend) => backend.backendId)));
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
    environment,
    environmentFile: environment ? `.azure/${environment}/.env` : null,
    apim,
    keyVault,
    foundries,
    partialFoundries,
    sources: { main: MAIN, onboarding: ONBOARDING },
  };
}
