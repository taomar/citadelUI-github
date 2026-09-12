import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as presentation from '../web/js/deployment-presentation.mjs';
import * as facade from '../web/js/paramview.mjs';
import {
  deploymentPresentation, parameterVisible, sectionNavTitle,
} from '../web/js/deployment-presentation.mjs';
import { renderParamDocument, renderOutlineNav } from '../web/js/paramview.mjs';
import { documentFromText } from '../shared/citadel-core.mjs';
import { installDom, readText } from './_dom-stub.mjs';
import { migrationHarness } from './_migration-fixture.mjs';

const MAIN = 'bicep/infra/main.bicepparam';
const group = (label, params) => ({ label, blocks: [], params });
const section = (id, title, params, groups = [group(null, params)]) => ({
  id, title, params, groups, blocks: [], requirement: null,
});
const context = (values = {}, pending = []) => ({
  paramValue: (name) => values[name],
  pendingFor: (name) => pending.includes(name),
});
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('L2 presentation: facade re-exports the same functions and frozen visibility tables', () => {
  for (const name of [
    'deploymentPresentation', 'parameterVisible', 'sectionNavTitle', 'FEATURE_GROUPS', 'PARAMETER_VISIBILITY',
  ]) assert.equal(facade[name], presentation[name], name);
  assert(Object.isFrozen(presentation.FEATURE_GROUPS));
  assert(Object.isFrozen(presentation.PARAMETER_VISIBILITY));
  for (const group of presentation.FEATURE_GROUPS) {
    assert(Object.isFrozen(group));
    assert(Object.isFrozen(group.params));
  }
  for (const rules of Object.values(presentation.PARAMETER_VISIBILITY)) {
    assert(Object.isFrozen(rules));
    for (const rule of rules) {
      assert(Object.isFrozen(rule));
      if (rule.oneOf) assert(Object.isFrozen(rule.oneOf));
    }
  }
});

test('L2 presentation: real ESM graph has a dependency-free leaf and migration bypasses the renderer', () => {
  const output = execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { SourceTextModule, createContext } from 'node:vm';
    const leafUrl = new URL('deployment-presentation.mjs', ${JSON.stringify(new URL('../web/js/', import.meta.url).href)});
    const context = createContext({});
    const leaf = new SourceTextModule(readFileSync(leafUrl, 'utf8'), {
      context,
      importModuleDynamically: () => { throw new Error('Presentation must not load dynamic dependencies'); },
    });
    assert.deepEqual(leaf.dependencySpecifiers, []);
    await leaf.link(() => { throw new Error('Presentation must not load dependencies'); });
    await leaf.evaluate();
    const ctx = { pendingFor: () => false, paramValue: () => false };
    assert.equal(leaf.namespace.parameterVisible('redisCacheName', ctx), false);
    assert.equal(leaf.namespace.sectionNavTitle('FEATURE FLAGS - Capabilities'), 'Features');
    const sections = [{ title: 'RESOURCE NAMES', params: ['redisCacheName'] }];
    assert.equal(leaf.namespace.deploymentPresentation({ path: 'bicep/infra/main.bicepparam', outline: { sections } }, ctx).length, 0);
    const migration = new SourceTextModule(readFileSync(new URL('migration-session.mjs', leafUrl), 'utf8'));
    assert(migration.dependencySpecifiers.includes('./deployment-presentation.mjs'));
    assert(!migration.dependencySpecifiers.includes('./paramview.mjs'));
    console.log(JSON.stringify({ leafDependencies: leaf.dependencySpecifiers, migrationPresentation: './deployment-presentation.mjs' }));
  `], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(JSON.parse(output), { leafDependencies: [], migrationPresentation: './deployment-presentation.mjs' });
});

const sourceSections = freeze([
  section('basic', 'BASIC PARAMETERS', ['environmentName', 'location', 'apicLocation']),
  section('resources', 'RESOURCE NAMES - Assign custom names', ['resourceGroupName', 'redisCacheName']),
  section('monitoring', 'MONITORING', ['useExistingLogAnalytics', 'logAnalyticsName', 'existingLogAnalyticsName']),
  section('network', 'NETWORKING PARAMETERS', [
    'useExistingVnet', 'vnetAddressPrefix', 'existingVnetRG', 'apimNetworkType',
    'apimV2UsePrivateEndpoint', 'apimV2PublicNetworkAccess', 'apimV2PrivateEndpointName',
  ]),
  section('flags', 'FEATURE FLAGS - Deploy specific capabilities', [
    'enableAPICenter', 'enableManagedRedis', 'enableAzureAISearch', 'entraAuth', 'enableOpenAIRealtime',
  ]),
  section('compute', 'COMPUTE SKU & SIZE', ['apimSku']),
  section('accelerator', 'ACCELERATOR SPECIFIC PARAMETERS', ['aiSearchInstances', 'aiFoundryInstances']),
  section('entra', 'ENTRA ID AUTHENTICATION', ['entraTenantId']),
  section('notes', 'DEPLOYMENT NOTES', []),
]);
const savedValues = freeze({
  enableAPICenter: false, enableManagedRedis: false, enableAzureAISearch: false,
  entraAuth: false, enableOpenAIRealtime: true, useExistingLogAnalytics: true,
  useExistingVnet: false, apimSku: 'StandardV2', apimV2UsePrivateEndpoint: true,
});

test('L2 presentation: deployment preserves exact sections, groups, order and note metadata', () => {
  const doc = freeze({ path: MAIN, outline: { sections: sourceSections } });
  const before = JSON.stringify(doc);
  const featureGroups = [
    group('Gateway APIs', ['enableOpenAIRealtime']),
    group('Data, safety & governance', ['enableAzureAISearch', 'enableManagedRedis', 'enableAPICenter']),
    group('Identity & observability', ['entraAuth', 'useExistingLogAnalytics']),
    group('Network topology', ['useExistingVnet', 'apimV2UsePrivateEndpoint', 'apimV2PublicNetworkAccess']),
  ];
  assert.deepEqual(deploymentPresentation(doc, context(savedValues)), [
    { ...section('basic', 'BASIC PARAMETERS', ['environmentName', 'location']), sourceParameterCount: 3 },
    {
      ...section('flags', 'FEATURE FLAGS - Deploy specific capabilities', [
        'enableOpenAIRealtime', 'enableAzureAISearch', 'enableManagedRedis', 'enableAPICenter',
        'entraAuth', 'useExistingLogAnalytics', 'useExistingVnet', 'apimV2UsePrivateEndpoint', 'apimV2PublicNetworkAccess',
      ], featureGroups),
      sourceParameterCount: 5,
    },
    { ...section('resources', 'RESOURCE NAMES - Assign custom names', ['resourceGroupName']), sourceParameterCount: 2 },
    { ...section('monitoring', 'MONITORING', ['existingLogAnalyticsName']), sourceParameterCount: 3 },
    { ...section('network', 'NETWORKING PARAMETERS', ['vnetAddressPrefix', 'apimV2PrivateEndpointName']), sourceParameterCount: 7 },
    { ...section('compute', 'COMPUTE SKU & SIZE', ['apimSku']), sourceParameterCount: 1 },
    { ...section('accelerator', 'ACCELERATOR SPECIFIC PARAMETERS', ['aiFoundryInstances']), sourceParameterCount: 2 },
    { ...section('notes', 'DEPLOYMENT NOTES', [], []), sourceParameterCount: 0 },
  ]);
  assert.equal(JSON.stringify(doc), before);
});

test('L2 presentation: subscription insertion preserves first-group placement and absent-location fallback', () => {
  for (const names of [['environmentName', 'location'], ['environmentName']]) {
    const doc = freeze({
      path: MAIN, subscription: { value: 'synthetic-subscription' },
      outline: { sections: [section('basic', 'BASIC PARAMETERS', [...names, 'tags'], [
        group('Identity', names), group('Metadata', ['tags']),
      ])] },
    });
    const [result] = deploymentPresentation(doc, context());
    assert.deepEqual(result.params, names.includes('location')
      ? ['environmentName', 'location', 'subscriptionId', 'tags']
      : ['environmentName', 'tags', 'subscriptionId']);
    assert.deepEqual(result.groups, [
      group('Identity', [...names, 'subscriptionId']), group('Metadata', ['tags']),
    ]);
    assert.equal(result.groups[1].blocks, doc.outline.sections[0].groups[1].blocks);
  }
  assert.deepEqual(deploymentPresentation({ path: MAIN, subscription: {} }, context()), []);
});

test('L2 presentation: contract, native and noncanonical paths return the original outline without gating', () => {
  const unused = () => assert.fail('Non-deployment presentation must not consult visibility');
  for (const path of [
    'bicep/infra/citadel-access-contracts/finance/main.bicepparam',
    'bicep/infra/llm-backend-onboarding/main.bicepparam',
    'environments/dev.tfvars', 'environments/dev.tfvars.json',
    'other/main.bicepparam', 'BICEP/infra/main.bicepparam',
  ]) {
    assert.equal(deploymentPresentation({ path, outline: { sections: sourceSections } }, {
      paramValue: unused, pendingFor: unused, native: true, allParameters: true,
    }), sourceSections);
  }
  assert.deepEqual(deploymentPresentation({ path: MAIN }, context()), []);
});

test('L2 presentation: complete Terraform projections without a feature banner retain their own order and flags', () => {
  const sections = freeze([
    section('identity', 'Identity', ['entraAuth', 'entraTenantId']),
    section('apic', 'API Center', ['enableAPICenter', 'apicLocation']),
  ]);
  const unused = () => assert.fail('Complete projection must keep its supplied presentation');
  assert.equal(deploymentPresentation({
    path: MAIN, subscription: { value: 'not-in-this-projection' }, outline: { sections },
  }, { completeProjection: true, allParameters: true, pendingFor: unused, paramValue: unused }), sections);
});

test('L2 presentation: migration and all-parameter projections retain disabled choices, not editor filtering', () => {
  const doc = { path: MAIN, outline: { sections: sourceSections } };
  const expected = [
    ['basic', ['environmentName', 'location', 'apicLocation']],
    ['flags', [
      'enableOpenAIRealtime', 'enableAzureAISearch', 'enableManagedRedis', 'enableAPICenter',
      'entraAuth', 'useExistingLogAnalytics', 'useExistingVnet', 'apimV2UsePrivateEndpoint', 'apimV2PublicNetworkAccess',
    ]],
    ['resources', ['resourceGroupName', 'redisCacheName']],
    ['monitoring', ['logAnalyticsName', 'existingLogAnalyticsName']],
    ['network', ['vnetAddressPrefix', 'existingVnetRG', 'apimNetworkType', 'apimV2PrivateEndpointName']],
    ['compute', ['apimSku']],
    ['accelerator', ['aiSearchInstances', 'aiFoundryInstances']],
    ['entra', ['entraTenantId']],
    ['notes', []],
  ];
  for (const ctx of [
    context(),
    { ...context(savedValues), allParameters: true },
    { ...context(savedValues), allParameters: true, completeProjection: true },
  ]) {
    assert.deepEqual(deploymentPresentation(doc, ctx).map(({ id, params }) => [id, params]), expected);
  }
});

test('L2 presentation: feature predicates preserve exact coercion, conjunction, missing and pending semantics', () => {
  for (const [value, expected] of [
    [true, true], ['true', true], [false, false], ['false', false],
    [undefined, true], [null, true], [0, false], [1, false], ['TRUE', false], ['', false], [{ __expr: 'flag' }, false],
  ]) {
    assert.equal(parameterVisible('redisCacheName', context({ enableManagedRedis: value })), expected);
  }
  for (const [sku, enabled, expected] of [
    ['StandardV2', true, true], ['PremiumV2', 'true', true], ['StandardV2', false, false],
    ['Developer', true, false], ['Premium', true, false], ['standardv2', true, false],
    [undefined, true, true], ['StandardV2', undefined, true], [null, false, false],
  ]) {
    const ctx = context({ apimSku: sku, apimV2UsePrivateEndpoint: enabled });
    assert.equal(parameterVisible('apimV2PrivateEndpointName', ctx), expected);
  }
  assert.equal(parameterVisible('logAnalyticsName', context({ useExistingLogAnalytics: 'false' })), true);
  assert.equal(parameterVisible('logAnalyticsName', context({ useExistingLogAnalytics: 'true' })), false);
  assert.equal(parameterVisible('aiFoundryInstances', context({ enableAzureAISearch: false })), true);
  const unused = () => assert.fail('Short-circuit must not read the controller');
  assert.equal(parameterVisible('redisCacheName', { allParameters: true, pendingFor: unused, paramValue: unused }), true);
  assert.equal(parameterVisible('redisCacheName', { pendingFor: () => true, paramValue: unused }), true);
  const values = { enableManagedRedis: false };
  const ctx = context(values);
  assert.equal(parameterVisible('redisCacheName', ctx), false);
  values.enableManagedRedis = true;
  assert.equal(parameterVisible('redisCacheName', ctx), true, 'No cached visibility between calls');
});

test('L2 presentation: heading normalization keeps acronyms, delimiters and fallback length behavior', () => {
  for (const [raw, expected] of [
    ['DEPLOYMENT NOTES - Reference', 'Notes'],
    ['FEATURE FLAGS - Deploy', 'Features'],
    ['API Management (APIM) Configuration', 'APIM'],
    ['CUSTOM API SETTINGS - Retained description', 'Custom API Settings'],
    ['CUSTOM DNS SETTINGS \u2013 Retained description', 'Custom DNS Settings'],
    ['CUSTOM TLS SETTINGS \u2014 Retained description', 'Custom TLS Settings'],
    ['CUSTOM SKU SETTINGS : Retained description', 'Custom SKU Settings'],
    ['Short custom section', 'Short custom section'],
    ['Extremely long custom section name without a delimiter', 'Extremely long custom'],
    ['LONGUNBROKENHEADINGWITHOUTSPACES', 'Longunbrokenheadingwithoutspaces'],
    [null, ''], [undefined, ''], [0, ''],
  ]) assert.equal(sectionNavTitle(raw), expected);
});

const targetText = [
  "using './main.bicep'",
  '// ============================================================================',
  '// BASIC PARAMETERS',
  '// ============================================================================',
  "param environmentName = 'new'",
  "param location = 'west'",
  '// ============================================================================',
  '// RESOURCE NAMES',
  '// ============================================================================',
  "param apimServiceName = 'new-service'",
  "param apicServiceName = 'disabled-but-migratable'",
  'param useExistingVnet = false',
  '// ============================================================================',
  '// FEATURE FLAGS',
  '// ============================================================================',
  'param enableAPICenter = false',
  '',
].join('\n');

test('L2 presentation: actual migration session preserves grouped row order and disabled destination choices', async () => {
  const harness = migrationHarness({
    targetText,
    schemaText: 'param environmentName string\nparam location string\nparam apimServiceName string\nparam apicServiceName string\nparam useExistingVnet bool\nparam enableAPICenter bool\n',
    donorText: "param environmentName = 'old'\nparam location = 'east'\nparam apimServiceName = 'old-service'\nparam apicServiceName = 'old-apic'\nparam useExistingVnet = true\nparam enableAPICenter = true\n",
  });
  const view = await harness.plan();
  const byId = new Map(view.rows.map((row) => [row.id, row.name]));
  assert.deepEqual(view.sections.map(({ id, title, label, groups }) => ({
    id, title, label, groups: groups.map(({ label, rowIds }) => ({ label, names: rowIds.map((id) => byId.get(id)) })),
  })), [
    { id: 'target-section-0', title: 'Basics', label: 'Basics', groups: [{ label: null, names: ['environmentName', 'location'] }] },
    { id: 'target-section-1', title: 'Features', label: 'Features', groups: [
      { label: 'Data, safety & governance', names: ['enableAPICenter'] },
      { label: 'Network topology', names: ['useExistingVnet'] },
    ] },
    { id: 'target-section-2', title: 'Resources', label: 'Resources', groups: [
      { label: null, names: ['apimServiceName', 'apicServiceName'] },
    ] },
  ]);
  assert.deepEqual(harness.api.trace, [], 'Presentation never prepares or applies a transaction');
});

test('L2 presentation: renderer facade preserves section headings, supplied control nodes and navigation handlers', () => {
  const dom = installDom();
  const doc = documentFromText(MAIN, targetText);
  const opened = [];
  const navigated = [];
  const controls = new Map(doc.params.map((param) => [param.name, dom.node('input')]));
  const ctx = {
    ...context(Object.fromEntries(doc.params.map((param) => [param.name, param.value]))),
    schemaFor: () => null, findingsFor: () => [], isOpen: () => false,
    setOpen: (...args) => opened.push(args),
    renderParameterValue: (param) => controls.get(param.name),
  };
  const form = renderParamDocument(doc, ctx);
  dom.root.append(form);
  assert.deepEqual(form.querySelectorAll('.sec-title').map(readText), ['Basic Parameters', 'Feature Flags', 'Resource Names']);
  assert.deepEqual(form.querySelectorAll('.grp-label').map(readText), ['Data, safety & governance', 'Network topology']);
  assert.deepEqual(form.querySelectorAll('.prow-name').map(readText),
    ['environmentName', 'location', 'enableAPICenter', 'useExistingVnet', 'apimServiceName']);
  assert.equal(controls.get('apicServiceName').isConnected, false);
  const input = controls.get('environmentName');
  assert(form.contains(input));
  input.value = 'unblurred synthetic draft';
  input.focus();
  const nav = renderOutlineNav(doc, ctx, (id) => navigated.push(id), 'tabs');
  dom.root.append(nav);
  assert.deepEqual(nav.querySelectorAll('.outline-label').map(readText), ['Basics', 'Features', 'Resources']);
  const links = nav.querySelectorAll('button');
  assert.deepEqual(links.map((link) => link.getAttribute('title')), ['BASIC PARAMETERS', 'FEATURE FLAGS', 'RESOURCE NAMES']);
  const feature = form.querySelectorAll('.sec').find((node) => node.classList.contains('sec-features'));
  const scrolls = [];
  feature.scrollIntoView = (options) => scrolls.push(options);
  links[1].click();
  assert.equal(feature.open, true);
  assert.deepEqual(opened, [[links[1].dataset.section, true]]);
  assert.deepEqual(navigated, [links[1].dataset.section]);
  assert.deepEqual(scrolls, [{ block: 'start', behavior: 'auto' }]);
  assert.equal(document.activeElement, input);
  assert.equal(input.value, 'unblurred synthetic draft');
  feature.dispatch('toggle');
  assert.deepEqual(opened.at(-1), [links[1].dataset.section, true]);
});
