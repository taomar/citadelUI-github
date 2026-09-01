import { API_CENTER_REGIONS, APIM_SKUS, LOGIC_APPS_TEMPLATE } from './azuremeta.mjs';
import {
  azureProhibitedOverlap,
  Ipv4Cidr,
  isRecommendedPrivateSpace,
  microsoftAppProhibitedOverlap,
} from './cidr.mjs';

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

function finding(param, message, path = [param], severity = 'error') {
  return { severity, param, path, message };
}

function incompleteFields(value, fields) {
  const object = value && typeof value === 'object' ? value : {};
  return fields.reduce((result, field) => {
    const entry = object[field];
    if (typeof entry !== 'string' || !entry.trim()) result.missing.push(field);
    else if (PLACEHOLDER.test(entry.trim())) result.placeholders.push(field);
    return result;
  }, { missing: [], placeholders: [] });
}

function validateCoordinates(findings, param, value, fields, label) {
  const { missing, placeholders } = incompleteFields(value, fields);
  if (missing.length) {
    findings.push(finding(param, `${label} is incomplete. Missing: ${missing.join(', ')}.`));
  }
  if (placeholders.length) {
    findings.push(
      finding(
        param,
        `${label} still uses placeholder values for: ${placeholders.join(', ')}.`,
        [param],
        'warning'
      )
    );
  }
}

const SUBNETS = Object.freeze([
  Object.freeze({ param: 'apimSubnetPrefix', label: 'API Management subnet', active: () => true }),
  Object.freeze({
    param: 'privateEndpointSubnetPrefix',
    label: 'Private endpoint subnet',
    active: () => true,
  }),
  Object.freeze({
    param: 'functionAppSubnetPrefix',
    label: 'Logic App integration subnet',
    active: () => true,
  }),
  Object.freeze({
    param: 'agentSubnetPrefix',
    label: 'Microsoft.App agent subnet',
    active: (values) => values.get('foundryNetworkInjectionEnabled') === true,
  }),
]);

const APIM_V2_SKUS = new Set(['StandardV2', 'PremiumV2']);

function parseNetworkField(findings, values, param, label, severity = 'error') {
  if (!values.has(param)) return null;
  const input = String(values.get(param) || '').trim();
  let cidr;
  try {
    cidr = new Ipv4Cidr(input);
  } catch (error) {
    findings.push(finding(param, `${label}: ${error.message}`, [param], severity));
    return null;
  }
  if (!cidr.isCanonical) {
    findings.push(
      finding(
        param,
        `${label} must start on its network boundary. Use ${cidr.canonical}.`,
        [param],
        severity
      )
    );
  }
  if (cidr.prefix < 2 || cidr.prefix > 29) {
    findings.push(
      finding(
        param,
        `${label} must use an Azure-supported IPv4 prefix from /2 through /29.`,
        [param],
        severity
      )
    );
  }
  const prohibited = azureProhibitedOverlap(cidr);
  if (prohibited) {
    findings.push(
      finding(
        param,
        `${label} overlaps Azure-prohibited range ${prohibited.canonical}.`,
        [param],
        severity
      )
    );
  }
  return cidr;
}

function expectedPrivateEndpoints(values) {
  const foundry = Array.isArray(values.get('aiFoundryInstances'))
    ? values.get('aiFoundryInstances').length
    : 0;
  const v2Apim =
    APIM_V2_SKUS.has(values.get('apimSku')) &&
    values.get('apimV2UsePrivateEndpoint') === true;
  return (
    7 +
    foundry +
    (values.get('enableManagedRedis') === true ? 1 : 0) +
    (values.get('useAzureMonitorPrivateLinkScope') === true ? 1 : 0) +
    (v2Apim ? 1 : 0)
  );
}

function validateNetworkConfiguration(findings, values) {
  if (!values.has('vnetAddressPrefix') || values.get('useExistingVnet') === true) return;

  const vnet = parseNetworkField(
    findings,
    values,
    'vnetAddressPrefix',
    'Virtual network address space'
  );
  if (vnet && !isRecommendedPrivateSpace(vnet)) {
    findings.push(
      finding(
        'vnetAddressPrefix',
        'Azure permits public address space in a VNet, but recommends RFC 1918 or RFC 6598 private space to avoid routing side effects.',
        ['vnetAddressPrefix'],
        'warning'
      )
    );
  }

  const parsed = [];
  for (const spec of SUBNETS) {
    const active = spec.active(values);
    const severity = active ? 'error' : 'warning';
    const cidr = parseNetworkField(findings, values, spec.param, spec.label, severity);
    if (!cidr) continue;
    parsed.push({ ...spec, active, cidr });
    if (vnet && !vnet.contains(cidr)) {
      findings.push(
        finding(
          spec.param,
          `${spec.label} ${cidr.canonical} is outside VNet ${vnet.canonical}.`,
          [spec.param],
          severity
        )
      );
    }
  }

  for (let left = 0; left < parsed.length; left += 1) {
    for (let right = left + 1; right < parsed.length; right += 1) {
      const a = parsed[left];
      const b = parsed[right];
      if (!a.cidr.overlaps(b.cidr)) continue;
      if (a.active && b.active) {
        const message =
          `${a.label} ${a.cidr.canonical} overlaps ${b.label} ${b.cidr.canonical}. ` +
          'Azure subnets in one VNet cannot overlap.';
        findings.push(finding(a.param, message));
        findings.push(finding(b.param, message));
      } else {
        const inactive = a.active ? b : a;
        const other = inactive === a ? b : a;
        findings.push(
          finding(
            inactive.param,
            `${inactive.label} ${inactive.cidr.canonical} overlaps ${other.label} ` +
              `${other.cidr.canonical}. It is currently not deployed, but must be changed before enabling it.`,
            [inactive.param],
            'warning'
          )
        );
      }
    }
  }

  const apim = parsed.find((entry) => entry.param === 'apimSubnetPrefix')?.cidr;
  if (apim) {
    const sku = values.get('apimSku');
    if (APIM_V2_SKUS.has(sku) && apim.prefix > 27) {
      findings.push(
        finding(
          'apimSubnetPrefix',
          `${sku} VNet integration requires an API Management subnet of /27 or larger.`
        )
      );
    } else if (sku === 'Developer' || sku === 'Premium') {
      const units = Math.max(1, Number(values.get('apimSkuUnits')) || 1);
      const required =
        (sku === 'Developer' ? 1 : units * 2) +
        (values.get('apimNetworkType') === 'Internal' ? 1 : 0);
      if (apim.usableAddresses < required) {
        findings.push(
          finding(
            'apimSubnetPrefix',
            `${sku} with ${units} unit${units === 1 ? '' : 's'} needs at least ${required} ` +
              `usable subnet addresses; ${apim.canonical} provides ${apim.usableAddresses} after Azure reservations.`
          )
        );
      }
    }
  }

  const privateEndpoints =
    parsed.find((entry) => entry.param === 'privateEndpointSubnetPrefix')?.cidr;
  if (privateEndpoints) {
    const required = expectedPrivateEndpoints(values);
    if (privateEndpoints.usableAddresses < required) {
      findings.push(
        finding(
          'privateEndpointSubnetPrefix',
          `The current configuration can create at least ${required} private endpoints, but ` +
            `${privateEndpoints.canonical} provides only ${privateEndpoints.usableAddresses} usable addresses after Azure reservations.`
        )
      );
    }
  }

  const functionSubnet =
    parsed.find((entry) => entry.param === 'functionAppSubnetPrefix')?.cidr;
  if (functionSubnet?.prefix > 28) {
    findings.push(
      finding(
        'functionAppSubnetPrefix',
        'The Microsoft.Web/serverFarms integration subnet must be /28 or larger.'
      )
    );
  } else if (functionSubnet?.prefix > 26) {
    findings.push(
      finding(
        'functionAppSubnetPrefix',
        'A /26 or larger Logic App integration subnet is recommended for scaling headroom.',
        ['functionAppSubnetPrefix'],
        'warning'
      )
    );
  }

  const agent = parsed.find((entry) => entry.param === 'agentSubnetPrefix');
  if (agent) {
    if (agent.cidr.prefix > 27) {
      findings.push(
        finding(
          agent.param,
          'A Microsoft.App/environments workload-profile subnet must be /27 or larger.',
          [agent.param],
          agent.active ? 'error' : 'warning'
        )
      );
    }
    const prohibited = microsoftAppProhibitedOverlap(agent.cidr);
    if (prohibited) {
      findings.push(
        finding(
          agent.param,
          `Microsoft.App/environments cannot use a subnet overlapping ${prohibited.canonical}.`,
          [agent.param],
          agent.active ? 'error' : 'warning'
        )
      );
    }
  }
}

export function classifyValidation(findings, baseline = [], dirty = new Set()) {
  const baselineKeys = new Set(
    baseline.map((item) => JSON.stringify([item.param, item.path, item.message]))
  );
  return findings.map((item) => {
    const key = JSON.stringify([item.param, item.path, item.message]);
    const edited = dirty.has(item.param);
    if (edited) return { ...item, severity: 'error' };
    if (item.severity === 'warning' || baselineKeys.has(key)) {
      return { ...item, severity: 'warning' };
    }
    return item;
  });
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

  validateNetworkConfiguration(findings, values);

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
