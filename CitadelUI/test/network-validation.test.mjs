import assert from 'node:assert/strict';

import {
  classifyValidation,
  validateDocument,
} from '../web/js/validation.mjs';

const valid = {
  useExistingVnet: false,
  vnetAddressPrefix: '10.170.0.0/24',
  apimSubnetPrefix: '10.170.0.0/26',
  privateEndpointSubnetPrefix: '10.170.0.64/26',
  functionAppSubnetPrefix: '10.170.0.128/26',
  agentSubnetPrefix: '10.170.0.192/26',
  apimSku: 'StandardV2',
  apimSkuUnits: 1,
  apimV2UsePrivateEndpoint: true,
  apimNetworkType: 'External',
  logicAppsSkuCapacityUnits: 1,
  enableManagedRedis: false,
  useAzureMonitorPrivateLinkScope: false,
  aiFoundryInstances: [{ name: 'primary' }, { name: 'secondary' }],
};

function doc(overrides = {}) {
  const values = { ...valid, ...overrides };
  return {
    params: Object.entries(values).map(([name, value]) => ({ name, value })),
    schema: { available: true, parameters: {} },
  };
}

function findings(overrides = {}, param = null) {
  const result = validateDocument(doc(overrides));
  return param ? result.filter((item) => item.param === param) : result;
}

function messages(overrides, param) {
  return findings(overrides, param).map((item) => item.message);
}

assert.deepEqual(findings(), []);

assert.match(
  messages({ apimSubnetPrefix: '10.170.0/26' }, 'apimSubnetPrefix').join(' '),
  /IPv4 CIDR/
);
assert.match(
  messages({ apimSubnetPrefix: '10.170.0.1/26' }, 'apimSubnetPrefix').join(' '),
  /network boundary.*10\.170\.0\.0\/26/
);
assert.match(
  messages({ functionAppSubnetPrefix: '10.171.0.0/26' }, 'functionAppSubnetPrefix').join(' '),
  /outside VNet/
);

const overlap = {
  privateEndpointSubnetPrefix: '10.170.0.0/25',
};
assert.match(messages(overlap, 'apimSubnetPrefix').join(' '), /cannot overlap/);
assert.match(messages(overlap, 'privateEndpointSubnetPrefix').join(' '), /cannot overlap/);

assert.match(
  messages(
    {
      vnetAddressPrefix: '127.0.0.0/8',
      apimSubnetPrefix: '127.0.0.0/26',
      privateEndpointSubnetPrefix: '127.0.0.64/26',
      functionAppSubnetPrefix: '127.0.0.128/26',
      agentSubnetPrefix: '127.0.0.192/26',
    },
    'vnetAddressPrefix'
  ).join(' '),
  /Azure-prohibited range 127\.0\.0\.0\/8/
);

const publicSpace = findings({
  vnetAddressPrefix: '203.0.113.0/24',
  apimSubnetPrefix: '203.0.113.0/26',
  privateEndpointSubnetPrefix: '203.0.113.64/26',
  functionAppSubnetPrefix: '203.0.113.128/26',
  agentSubnetPrefix: '203.0.113.192/26',
});
assert.equal(
  publicSpace.some(
    (item) => item.param === 'vnetAddressPrefix' &&
      item.severity === 'warning' &&
      /RFC 1918 or RFC 6598/.test(item.message)
  ),
  true
);

assert.match(
  messages({ privateEndpointSubnetPrefix: '10.170.0.64/30' }, 'privateEndpointSubnetPrefix')
    .join(' '),
  /\/2 through \/29/
);
assert.match(
  messages({ apimSubnetPrefix: '10.170.0.0/28' }, 'apimSubnetPrefix').join(' '),
  /StandardV2.*\/27 or larger/
);
assert.equal(
  findings(
    {
      apimSku: 'Developer',
      apimSubnetPrefix: '10.170.0.0/29',
      privateEndpointSubnetPrefix: '10.170.0.16/28',
    },
    'apimSubnetPrefix'
  ).length,
  0
);
assert.equal(
  findings(
    {
      apimSku: 'Premium',
      apimSkuUnits: 1,
      apimNetworkType: 'External',
      apimSubnetPrefix: '10.170.0.0/29',
      privateEndpointSubnetPrefix: '10.170.0.16/28',
    },
    'apimSubnetPrefix'
  ).length,
  0
);
assert.match(
  messages(
    {
      apimSku: 'Premium',
      apimSkuUnits: 6,
      apimNetworkType: 'Internal',
      apimSubnetPrefix: '10.170.0.0/28',
    },
    'apimSubnetPrefix'
  ).join(' '),
  /needs at least 13 usable/
);

assert.match(
  messages({ functionAppSubnetPrefix: '10.170.0.128/29' }, 'functionAppSubnetPrefix')
    .join(' '),
  /must be \/28 or larger/
);
assert.equal(
  findings({ functionAppSubnetPrefix: '10.170.0.128/27' }, 'functionAppSubnetPrefix')
    .some((item) => item.severity === 'warning' && /\/26 or larger/.test(item.message)),
  true
);

assert.match(
  messages({ privateEndpointSubnetPrefix: '10.170.0.64/29' }, 'privateEndpointSubnetPrefix')
    .join(' '),
  /at least 10 private endpoints.*only 3 usable/
);

const inactiveAgent = findings({ agentSubnetPrefix: '10.170.0.128/28' }, 'agentSubnetPrefix');
assert.equal(inactiveAgent.some((item) => item.severity === 'warning'), true);
assert.equal(inactiveAgent.some((item) => /currently not deployed/.test(item.message)), true);

const activeAgent = findings(
  {
    foundryNetworkInjectionEnabled: true,
    agentSubnetPrefix: '10.170.0.192/28',
  },
  'agentSubnetPrefix'
);
assert.equal(activeAgent.some((item) => item.severity === 'error' && /\/27 or larger/.test(item.message)), true);

const reservedAgent = findings(
  {
    vnetAddressPrefix: '172.16.0.0/12',
    apimSubnetPrefix: '172.16.0.0/24',
    privateEndpointSubnetPrefix: '172.17.0.0/24',
    functionAppSubnetPrefix: '172.18.0.0/24',
    agentSubnetPrefix: '172.30.2.0/24',
  },
  'agentSubnetPrefix'
);
assert.equal(
  reservedAgent.some((item) => item.severity === 'warning' && /172\.30\.0\.0\/16/.test(item.message)),
  true
);

assert.deepEqual(
  findings({
    useExistingVnet: true,
    vnetAddressPrefix: 'not-cidr',
    apimSubnetPrefix: 'also-wrong',
  }).filter((item) => /(?:VNet|subnet|CIDR|network)/i.test(item.message)),
  []
);

const invalid = validateDocument(doc(overlap));
const baseline = classifyValidation(invalid, invalid, new Set());
assert.equal(
  baseline.filter((item) => item.param === 'privateEndpointSubnetPrefix')
    .every((item) => item.severity === 'warning'),
  true
);
const afterBlur = classifyValidation(invalid, invalid, new Set(['privateEndpointSubnetPrefix']));
assert.equal(
  afterBlur.some(
    (item) => item.param === 'privateEndpointSubnetPrefix' && item.severity === 'error'
  ),
  true
);

console.log('Azure VNet/subnet validation and dirty-field alert checks passed.');
