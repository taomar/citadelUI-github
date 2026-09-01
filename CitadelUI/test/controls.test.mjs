import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSchema } from '../server/bicep.mjs';
import { regionOptionsFor } from '../web/js/fields.mjs';
import { filterPickerItems } from '../web/js/picker.mjs';
import {
  APIC_LOCATION_VALUES,
  APIM_SKUS,
  LOGIC_APPS_TEMPLATE,
  PRIMARY_REGIONS,
} from '../web/js/azuremeta.mjs';
import { foundryServiceOptions, logicAppsWorkerGuidance } from '../web/js/paramview.mjs';
import { classifyValidation, validateDocument } from '../web/js/validation.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(join(here, '..', '..', 'bicep', 'infra', 'main.bicep'), 'utf8');
const schema = extractSchema(source);

assert.deepEqual(schema.location.allowedValues, PRIMARY_REGIONS);
assert.deepEqual(schema.apicLocation.allowedValues, APIC_LOCATION_VALUES);
assert.equal(schema.location.name, 'location');
assert.deepEqual(
  regionOptionsFor(null, ['aiFoundryInstances', 0, 'location', '__args', 1]),
  PRIMARY_REGIONS
);
assert.deepEqual(regionOptionsFor(null, ['apicLocation']), APIC_LOCATION_VALUES);
assert.equal(regionOptionsFor(null, ['resourceGroupName']), null);
assert.deepEqual(schema.logicAppsSkuName.allowedValues, ['WS1', 'WS2', 'WS3']);
assert.equal(schema.logicAppsSkuCapacityUnits.minValue, 1);
assert.equal(schema.logicAppsSkuCapacityUnits.maxValue, 20);
assert.deepEqual(LOGIC_APPS_TEMPLATE.workerSizes, {
  WS1: { vCpu: 1, memoryGb: 3.5 },
  WS2: { vCpu: 2, memoryGb: 7 },
  WS3: { vCpu: 4, memoryGb: 14 },
});
assert.match(logicAppsWorkerGuidance('WS2'), /WS2 provides 2 vCPU and 7 GB memory/);

const regions = schema.location.allowedValues.map((value) => ({ value, meta: value }));
assert.equal(filterPickerItems(regions, '').length, 14);
assert.deepEqual(filterPickerItems(regions, 'sweden').map((item) => item.value), ['swedencentral']);

const instances = [
  { name: 'one', location: 'eastus' },
  { name: 'two', location: 'swedencentral' },
];
assert.deepEqual(foundryServiceOptions(instances).map((option) => option.value), ['', '0', '1']);
assert.deepEqual(foundryServiceOptions([...instances, { name: 'three', location: 'westeurope' }]).map((option) => option.value), ['', '0', '1', '2']);
assert.equal(
  foundryServiceOptions([{
    name: { __expr: 'call', callee: 'readEnvironmentVariable', args: ['AI_FOUNDRY_RESOURCE_NAME', 'foundry-env'] },
    location: { __expr: 'call', callee: 'readEnvironmentVariable', args: ['AZURE_LOCATION', 'eastus'] },
  }])[1].label,
  '0 — foundry-env · eastus'
);

function doc(values, definitions = {}) {
  return {
    params: Object.entries(values).map(([name, value]) => ({ name, value })),
    schema: { available: true, parameters: definitions },
  };
}

for (const [sku, bounds] of Object.entries(APIM_SKUS)) {
  assert.equal(validateDocument(doc({ apimSku: sku, apimSkuUnits: bounds.min })).length, 0);
  assert.match(validateDocument(doc({ apimSku: sku, apimSkuUnits: bounds.max + 1 }))[0].message, /capacity/);
}

assert.match(
  validateDocument(doc({ logicAppsSkuCapacityUnits: 21 }))[0].message,
  /1 to 20/
);
for (const skuName of ['WS1', 'WS2', 'WS3']) {
  assert.equal(validateDocument(doc(
    { logicAppsSkuName: skuName, logicAppsSkuCapacityUnits: 7 },
    { logicAppsSkuName: schema.logicAppsSkuName, logicAppsSkuCapacityUnits: schema.logicAppsSkuCapacityUnits }
  )).length, 0);
}
assert.match(
  validateDocument(doc(
    { logicAppsSkuName: 'WS4', logicAppsSkuCapacityUnits: 7 },
    { logicAppsSkuName: schema.logicAppsSkuName, logicAppsSkuCapacityUnits: schema.logicAppsSkuCapacityUnits }
  ))[0].message,
  /not allowed/
);
assert.match(
  validateDocument(doc({
    location: 'uaenorth',
    apicLocation: '',
    enableAPICenter: true,
  }))[0].message,
  /API Center/
);
assert.match(
  validateDocument(doc({
    aiFoundryInstances: instances,
    aiFoundryModelsConfig: [{ name: 'gpt', aiserviceIndex: 2 }],
  }))[0].message,
  /valid indices/
);

const baselineAccess = doc({
  apim: {
    subscriptionId: '00000000-0000-0000-0000-000000000000',
    resourceGroupName: 'rg-live',
    name: 'apim-live',
  },
  unrelatedBackend: 'before',
});
const baselineFindings = validateDocument(baselineAccess);
assert.equal(baselineFindings[0].severity, 'warning');
const unrelatedEdit = doc({
  apim: {
    subscriptionId: '00000000-0000-0000-0000-000000000000',
    resourceGroupName: 'rg-live',
    name: 'apim-live',
  },
  unrelatedBackend: 'after',
});
assert.deepEqual(
  classifyValidation(validateDocument(unrelatedEdit), baselineFindings, new Set(['unrelatedBackend']))
    .map((finding) => finding.severity),
  ['warning']
);
assert.deepEqual(
  classifyValidation(validateDocument(unrelatedEdit), baselineFindings, new Set(['apim']))
    .map((finding) => finding.severity),
  ['error']
);

console.log('Control metadata and validation checks passed.');
