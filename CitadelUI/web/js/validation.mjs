import { API_CENTER_REGIONS, APIM_SKUS, LOGIC_APPS_TEMPLATE } from './azuremeta.mjs';

const PLACEHOLDER = /^(?:0{8}-0{4}-0{4}-0{4}-0{12}|(?:rg|apim|kv|foundry)-.*(?:name|group)|.*instance-name|.*account-name|.*project-name)$/i;

export function editableValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.__expr !== 'call') return value;
  if (value.callee === 'readEnvironmentVariable') return value.args.length > 1 ? value.args[1] : '';
  if (['int', 'bool', 'string'].includes(value.callee) && value.args.length === 1) {
    const raw = editableValue(value.args[0]);
    if (value.callee === 'int') return Number(raw);
    if (value.callee === 'bool') return raw === true || raw === 'true';
    return raw;
  }
  return value;
}

export function parameterMap(doc) {
  return new Map((doc && doc.params || []).map((param) => [param.name, editableValue(param.value)]));
}

function finding(param, message, path = [param]) {
  return { severity: 'error', param, path, message };
}

function missingFields(value, fields) {
  const object = value && typeof value === 'object' ? value : {};
  return fields.filter((field) => {
    const entry = object[field];
    return typeof entry !== 'string' || !entry.trim() || PLACEHOLDER.test(entry.trim());
  });
}

function validateCoordinates(findings, param, value, fields, label) {
  const missing = missingFields(value, fields);
  if (missing.length) {
    findings.push(finding(param, `${label} is incomplete. Missing: ${missing.join(', ')}.`));
  }
}

export function validateDocument(doc) {
  const findings = [];
  const values = parameterMap(doc);
  const schema = doc && doc.schema && doc.schema.parameters || {};

  for (const [name, definition] of Object.entries(schema)) {
    if (!Array.isArray(definition.allowedValues) || !values.has(name)) continue;
    const value = values.get(name);
    if (!definition.allowedValues.some((allowed) => Object.is(allowed, value))) {
      findings.push(finding(name, `${JSON.stringify(value)} is not allowed by ${name}'s Bicep @allowed decorator.`));
    }
  }

  const apimSku = values.get('apimSku');
  const apimUnits = Number(values.get('apimSkuUnits'));
  if (APIM_SKUS[apimSku] && (!Number.isInteger(apimUnits) || apimUnits < APIM_SKUS[apimSku].min || apimUnits > APIM_SKUS[apimSku].max)) {
    const { min, max } = APIM_SKUS[apimSku];
    findings.push(finding('apimSkuUnits', `${apimSku} capacity must be ${min === max ? `exactly ${min}` : `${min} to ${max}`}.`));
  }

  if (values.has('logicAppsSkuCapacityUnits')) {
    const units = Number(values.get('logicAppsSkuCapacityUnits'));
    if (!Number.isInteger(units) || units < LOGIC_APPS_TEMPLATE.min || units > LOGIC_APPS_TEMPLATE.max) {
      findings.push(finding('logicAppsSkuCapacityUnits', 'Assigned plan instances must be an integer from 1 to 20 for this template.'));
    }
  }

  if (values.get('enableAPICenter') === true && values.get('apicLocation') === '' && !API_CENTER_REGIONS.includes(values.get('location'))) {
    findings.push(finding('location', 'API Center is enabled and inherits this location, which is outside the eight API Center regions. Choose an API Center location explicitly.'));
  }

  const instances = Array.isArray(values.get('aiFoundryInstances')) ? values.get('aiFoundryInstances') : [];
  const models = Array.isArray(values.get('aiFoundryModelsConfig')) ? values.get('aiFoundryModelsConfig') : [];
  models.forEach((model, index) => {
    if (!model || !Object.prototype.hasOwnProperty.call(model, 'aiserviceIndex')) return;
    if (!Number.isInteger(model.aiserviceIndex) || model.aiserviceIndex < 0 || model.aiserviceIndex >= instances.length) {
      findings.push(finding('aiFoundryModelsConfig', `Model row ${index + 1} references AI service index ${model.aiserviceIndex}, but valid indices are 0 to ${Math.max(0, instances.length - 1)}.`, ['aiFoundryModelsConfig', index, 'aiserviceIndex']));
    }
  });

  if (values.has('apim')) {
    validateCoordinates(findings, 'apim', values.get('apim'), ['subscriptionId', 'resourceGroupName', 'name'], 'Primary APIM');
  }
  if (values.get('useTargetFoundry') === true) {
    validateCoordinates(findings, 'foundry', values.get('foundry'), ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName'], 'Primary Foundry');
  }
  if (values.get('useTargetAzureKeyVault') === true) {
    validateCoordinates(findings, 'keyVault', values.get('keyVault'), ['subscriptionId', 'resourceGroupName', 'name'], 'Target Key Vault');
  }

  const additional = Array.isArray(values.get('additionalFoundries')) ? values.get('additionalFoundries') : [];
  const seen = new Map();
  const primaryFoundry = values.get('foundry');
  if (primaryFoundry && typeof primaryFoundry === 'object') {
    const primaryKey = ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName']
      .map((field) => String(primaryFoundry[field] || '').trim().toLowerCase())
      .join('|');
    if (primaryKey !== '|||') seen.set(primaryKey, -1);
  }
  const secondaryCount = Array.isArray(values.get('additionalApimGateways'))
    ? values.get('additionalApimGateways').length
    : 0;
  const endpointSources = new Set(['', 'global', 'primary', ...Array.from({ length: secondaryCount }, (_, index) => `secondary:${index}`)]);
  additional.forEach((candidate, index) => {
    validateCoordinates(findings, 'additionalFoundries', candidate, ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName'], `Additional Foundry row ${index + 1}`);
    const key = ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName']
      .map((field) => String(candidate && candidate[field] || '').trim().toLowerCase())
      .join('|');
    if (key !== '|||' && seen.has(key)) {
      const prior = seen.get(key);
      findings.push(finding(
        'additionalFoundries',
        prior === -1
          ? `Additional Foundry row ${index + 1} duplicates the primary Foundry.`
          : `Additional Foundry row ${index + 1} duplicates row ${prior + 1}.`,
        ['additionalFoundries', index]
      ));
    } else if (key !== '|||') {
      seen.set(key, index);
    }
    if (!endpointSources.has(String(candidate && candidate.endpointSource || ''))) {
      findings.push(finding('additionalFoundries', `Additional Foundry row ${index + 1} has an invalid endpointSource.`, ['additionalFoundries', index, 'endpointSource']));
    }
  });

  return findings;
}
