/**
 * Section-based parameter view.
 *
 * Parameters are grouped exactly as their file groups them: each `====` banner
 * becomes a section, the banner prose becomes the section's explanation, and
 * dashed sub-banners become headings within it. The requirement badge comes
 * from the `REQUIRED:` / `OPTIONAL:` prefix the authors already write.
 *
 * The sheet is a datasheet, not a stack of cards. A section is a sticky band
 * with ruled rows running under it; a parameter is one record across five
 * columns -- name, type, value, expression reference, description -- under a
 * sticky column header. Nothing is boxed, so ninety-seven parameters read as
 * one continuous table rather than ninety-seven containers. `llmBackendConfig`
 * is the exception: it takes the full width and renders through the guided
 * provider editor.
 *
 * Two columns exist because the sheet had the room and nothing to say in it.
 * Many values use readEnvironmentVariable expressions, and forty-nine of
 * those hold no value in this file at all -- so a two-column layout printed
 * forty-nine identical empty boxes with no way to tell them apart. The variable
 * name is what distinguishes them and the description is what explains them;
 * both were previously reachable only by hovering. They are columns now.
 *
 * Ink follows data: a value the file actually sets is drawn as a filled control,
 * and a blank one is drawn as a hairline. A run of unset parameters therefore
 * reads as one quiet region rather than as a stack of identical inputs.
 *
 * Sections that carry documentation but no parameters (the trailing DEPLOYMENT
 * NOTES appendix, for example) are rendered as notes rather than as empty forms
 * -- they are reference material, not something to fill in.
 */

import { h } from './dom.mjs';
import { renderValue } from './fields.mjs';
import { picker } from './picker.mjs';
import { renderBlocks, summarise } from './docblocks.mjs';
import { renderLlmBackends } from './llmview.mjs';
import { explains } from './explain.mjs';
import { foundryCatalog } from './llmschema.mjs';
import { APIM_SKUS, API_CENTER_HELP, LOGIC_APPS_TEMPLATE } from './azuremeta.mjs';
import { Ipv4Cidr } from './cidr.mjs';
import { editableValue } from './validation.mjs';
import { validateSubscriptionId } from './subscription-env.mjs';

const ENV_CALL = 'readEnvironmentVariable';
const MAIN_DEPLOYMENT_PATH = 'bicep/infra/main.bicepparam';

const condition = (parameter, rule) => Object.freeze({ parameter, ...rule });
const enabled = (parameter, value = true) => condition(parameter, { equals: value });
const oneOf = (parameter, values) => condition(parameter, { oneOf: Object.freeze(values) });

/**
 * Controls that decide whether a capability or infrastructure mode exists.
 *
 * Several live outside the source file's Feature Flags banner. The presentation
 * moves them here without changing source order or creating a second editor.
 */
export const FEATURE_GROUPS = Object.freeze([
  Object.freeze({
    label: 'Gateway APIs',
    params: Object.freeze([
      'enableAIModelInference',
      'enableDocumentIntelligence',
      'enableOpenAIRealtime',
      'enableUnifiedAiApi',
    ]),
  }),
  Object.freeze({
    label: 'Data, safety & governance',
    params: Object.freeze([
      'enableAzureAISearch',
      'enableManagedRedis',
      'enableAIGatewayPiiRedaction',
      'enableAPICenter',
    ]),
  }),
  Object.freeze({
    label: 'Identity & observability',
    params: Object.freeze([
      'entraAuth',
      'createAppInsightsDashboards',
      'useExistingLogAnalytics',
      'useAzureMonitorPrivateLinkScope',
    ]),
  }),
  Object.freeze({
    label: 'Network topology',
    params: Object.freeze([
      'useExistingVnet',
      'apimV2UsePrivateEndpoint',
      'apimV2PublicNetworkAccess',
    ]),
  }),
]);

const FEATURE_CONTROLS = new Set(FEATURE_GROUPS.flatMap((group) => group.params));
const APIM_V2_SKUS = Object.freeze(['StandardV2', 'PremiumV2']);
const APIM_CLASSIC_NETWORK_SKUS = Object.freeze(['Developer', 'Premium']);

/**
 * Visibility is an AND of explicit repository-proven conditions.
 *
 * A missing controller fails open: older compatible repositories may expose a
 * dependent without carrying the newer flag, and hiding it would make the file
 * impossible to edit. A pending dependent also stays visible so toggling its
 * controller cannot conceal unsaved work.
 */
export const PARAMETER_VISIBILITY = Object.freeze({
  aiSearchInstances: Object.freeze([enabled('enableAzureAISearch')]),

  apicLocation: Object.freeze([enabled('enableAPICenter')]),
  apicServiceName: Object.freeze([enabled('enableAPICenter')]),
  apicSku: Object.freeze([enabled('enableAPICenter')]),

  entraTenantId: Object.freeze([enabled('entraAuth')]),
  entraClientId: Object.freeze([enabled('entraAuth')]),
  entraAudience: Object.freeze([enabled('entraAuth')]),
  entraClientSecret: Object.freeze([enabled('entraAuth')]),

  redisCacheName: Object.freeze([enabled('enableManagedRedis')]),
  redisPrivateEndpointName: Object.freeze([enabled('enableManagedRedis')]),
  redisPublicNetworkAccess: Object.freeze([enabled('enableManagedRedis')]),
  redisSkuName: Object.freeze([enabled('enableManagedRedis')]),
  redisSkuCapacity: Object.freeze([enabled('enableManagedRedis')]),
  redisHighAvailability: Object.freeze([enabled('enableManagedRedis')]),

  apimApplicationInsightsDashboardName: Object.freeze([enabled('createAppInsightsDashboards')]),
  funcApplicationInsightsDashboardName: Object.freeze([enabled('createAppInsightsDashboards')]),
  foundryApplicationInsightsDashboardName: Object.freeze([enabled('createAppInsightsDashboards')]),

  logAnalyticsName: Object.freeze([enabled('useExistingLogAnalytics', false)]),
  existingLogAnalyticsName: Object.freeze([enabled('useExistingLogAnalytics')]),
  existingLogAnalyticsRG: Object.freeze([enabled('useExistingLogAnalytics')]),
  existingLogAnalyticsSubscriptionId: Object.freeze([enabled('useExistingLogAnalytics')]),

  existingVnetRG: Object.freeze([enabled('useExistingVnet')]),
  dnsZoneRG: Object.freeze([enabled('useExistingVnet')]),
  dnsSubscriptionId: Object.freeze([enabled('useExistingVnet')]),
  existingPrivateDnsZones: Object.freeze([enabled('useExistingVnet')]),

  vnetAddressPrefix: Object.freeze([enabled('useExistingVnet', false)]),
  apimSubnetPrefix: Object.freeze([enabled('useExistingVnet', false)]),
  privateEndpointSubnetPrefix: Object.freeze([enabled('useExistingVnet', false)]),
  functionAppSubnetPrefix: Object.freeze([enabled('useExistingVnet', false)]),
  agentSubnetPrefix: Object.freeze([enabled('useExistingVnet', false)]),
  apimNsgName: Object.freeze([enabled('useExistingVnet', false)]),
  privateEndpointNsgName: Object.freeze([enabled('useExistingVnet', false)]),
  functionAppNsgName: Object.freeze([enabled('useExistingVnet', false)]),
  agentSubnetNsgName: Object.freeze([enabled('useExistingVnet', false)]),
  apimRouteTableName: Object.freeze([enabled('useExistingVnet', false)]),

  apimNetworkType: Object.freeze([oneOf('apimSku', APIM_CLASSIC_NETWORK_SKUS)]),
  apimV2UsePrivateEndpoint: Object.freeze([oneOf('apimSku', APIM_V2_SKUS)]),
  apimV2PublicNetworkAccess: Object.freeze([oneOf('apimSku', APIM_V2_SKUS)]),
  apimV2PrivateEndpointName: Object.freeze([
    oneOf('apimSku', APIM_V2_SKUS),
    enabled('apimV2UsePrivateEndpoint'),
  ]),
});

function comparable(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function conditionMatches(rule, ctx) {
  const value = comparable(ctx.paramValue(rule.parameter));
  if (value === undefined || value === null) return true;
  if (Object.prototype.hasOwnProperty.call(rule, 'equals')) {
    return value === rule.equals;
  }
  if (rule.oneOf) return rule.oneOf.includes(value);
  return true;
}

export function parameterVisible(name, ctx) {
  if (ctx.allParameters) return true;
  if (ctx.pendingFor(name)) return true;
  const rules = PARAMETER_VISIBILITY[name];
  return !rules || rules.every((rule) => conditionMatches(rule, ctx));
}

function featureSection(section) {
  return /^feature flags\b/i.test(String(section.title || '').trim());
}

function resourceNamesSection(section) {
  return /^resource names\b/i.test(String(section.title || '').trim());
}

export function deploymentPresentation(doc, ctx) {
  const source = doc.outline?.sections || [];
  if (doc.path !== MAIN_DEPLOYMENT_PATH) return source;
  if (ctx.completeProjection && !source.some(featureSection)) return source;
  const sourceNames = new Set(source.flatMap((section) => section.params));
  const visible = (name) => parameterVisible(name, ctx);
  const sections = source
    .map((section) => {
      if (featureSection(section)) {
        const groups = FEATURE_GROUPS.map((group) => ({
          label: group.label,
          blocks: [],
          params: group.params.filter((name) => sourceNames.has(name) && visible(name)),
        })).filter((group) => group.params.length > 0);
        return {
          ...section,
          params: groups.flatMap((group) => group.params),
          groups,
          sourceParameterCount: section.params.length,
        };
      }
      const include = (name) => !FEATURE_CONTROLS.has(name) && visible(name);
      return {
        ...section,
        params: section.params.filter(include),
        groups: (section.groups || []).map((group) => ({
          ...group,
          params: group.params.filter(include),
        })).filter((group) => group.params.length > 0),
        sourceParameterCount: section.params.length,
      };
    })
    .filter((section) => section.params.length > 0 || section.sourceParameterCount === 0);
  if (doc.subscription && sections.length) {
    const first = sections[0];
    const insertAfter = first.params.indexOf('location');
    const params = [...first.params];
    params.splice(insertAfter < 0 ? params.length : insertAfter + 1, 0, 'subscriptionId');
    const groups = first.groups.map((group, groupIndex) => {
      if (groupIndex !== 0) return group;
      const groupParams = [...group.params];
      const groupInsertAfter = groupParams.indexOf('location');
      groupParams.splice(
        groupInsertAfter < 0 ? groupParams.length : groupInsertAfter + 1,
        0,
        'subscriptionId'
      );
      return { ...group, params: groupParams };
    });
    sections[0] = { ...first, params, groups };
  }
  const featureIndex = sections.findIndex(featureSection);
  const resourceIndex = sections.findIndex(resourceNamesSection);
  if (featureIndex < 0 || resourceIndex < 0 || featureIndex + 1 === resourceIndex) {
    return sections;
  }
  const [flags] = sections.splice(featureIndex, 1);
  const nextResourceIndex = sections.findIndex(resourceNamesSection);
  sections.splice(nextResourceIndex, 0, flags);
  return sections;
}

const FOUNDRY_MODELS = foundryCatalog().map((model) => ({
  value: model.name,
  meta: [model.modelFormat, model.modelVersion, model.sku].filter(Boolean).join(' · '),
  group: model.kind || 'other',
  record: {
    publisher: model.modelFormat,
    version: model.modelVersion,
    sku: model.sku,
    capacity: model.capacity,
  },
}));

export function foundryServiceOptions(instances) {
  const options = Array.isArray(instances) ? instances : [];
  return [
    { value: '', label: 'All instances' },
    ...options.map((instance, index) => ({
      value: String(index),
      label: `${index} — ${editableValue(instance.name) || 'unnamed'} · ${editableValue(instance.location) || 'no location'}`,
    })),
  ];
}

function foundryIndexControl({ value, hasValue, index, path, ctx }) {
  const instances = ctx.paramValue('aiFoundryInstances');
  const options = Array.isArray(instances) ? instances : [];
  const choices = foundryServiceOptions(options);
  const select = h(
    'select',
    {
      class: 'ctl ctl-w-short',
      'aria-label': `AI service for model row ${index + 1}`,
      onchange: (event) => {
        if (event.target.value === '') {
          if (hasValue) ctx.onRemove([...path, index, 'aiserviceIndex']);
        } else if (hasValue) {
          ctx.onChange([...path, index, 'aiserviceIndex'], Number(event.target.value));
        } else {
          ctx.onAddProperty([...path, index], 'aiserviceIndex', Number(event.target.value));
        }
      },
    },
    h('option', { value: '', selected: !hasValue }, choices[0].label),
    hasValue && (!Number.isInteger(value) || value < 0 || value >= options.length)
      ? h('option', { value: String(value), selected: true }, `${value} — invalid index`)
      : null,
    choices.slice(1).map((choice) =>
      h(
        'option',
        { value: choice.value, selected: value === Number(choice.value) },
        choice.label
      )
    )
  );
  return select;
}

function additionalFoundryPicker({ value, path, ctx }) {
  const existing = new Set((value || []).map((entry) =>
    ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName']
      .map((field) => String(entry && entry[field] || '').toLowerCase())
      .join('|')
  ));
  const targets = (ctx.accessTargets && ctx.accessTargets.foundries || []).filter((target) => {
    const key = ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName']
      .map((field) => String(target[field] || '').toLowerCase())
      .join('|');
    return target.ready && !existing.has(key);
  });
  if (!targets.length) {
    const partial = (ctx.accessTargets && ctx.accessTargets.foundries || []).length;
    return h('p', { class: 'target-note' }, partial
      ? 'No ready local Foundry target. Missing coordinates are listed above.'
      : 'No Foundry instances are defined by the main deployment.');
  }

  const choose = picker(
    targets.map((target) => ({
      value: String(target.index),
      meta: `${target.accountName} · ${target.location || 'no location'} · ${target.projectName}`,
    })),
    (selected) => {
      const target = targets.find((entry) => String(entry.index) === selected);
      if (!target) return;
      ctx.onAppend(path, {
        subscriptionId: target.subscriptionId,
        resourceGroupName: target.resourceGroupName,
        accountName: target.accountName,
        projectName: target.projectName,
        endpointSource: '',
      });
    },
    {
      placeholder: 'Add existing Foundry…',
      ariaLabel: 'Add existing Foundry',
      freeText: false,
    }
  );
  return h('div', { class: 'target-action' }, choose.el);
}

function endpointSourceControl({ value, hasValue, index, path, ctx }) {
  const current = hasValue ? String(value || '') : '';
  const secondaryCount = Array.isArray(ctx.paramValue('additionalApimGateways'))
    ? ctx.paramValue('additionalApimGateways').length
    : 0;
  const legal = ['', 'global', 'primary', ...Array.from({ length: secondaryCount }, (_, item) => `secondary:${item}`)];
  return h(
    'select',
    {
      class: 'ctl ctl-w-short',
      'aria-label': `Endpoint source for additional Foundry row ${index + 1}`,
      onchange: (event) => {
        if (hasValue) ctx.onChange([...path, index, 'endpointSource'], event.target.value);
        else ctx.onAddProperty([...path, index], 'endpointSource', event.target.value);
      },
    },
    !legal.includes(current) ? h('option', { value: current, selected: true }, `${current} — invalid`) : null,
    legal.map((entry) => h('option', { value: entry, selected: entry === current }, entry || 'Effective global or primary'))
  );
}

function recordOptions(name, ctx) {
  const options = {
    aiFoundryModelsConfig: {
    record: {
      columns: ['aiserviceIndex'],
      visibleColumns: ['aiserviceIndex', 'name', 'publisher', 'version', 'sku', 'capacity'],
      maxVisible: 6,
      columnTracks: {
        aiserviceIndex: 'minmax(8rem, 0.85fr)',
        name: 'minmax(10rem, 1.8fr)',
        publisher: 'minmax(6.5rem, 0.75fr)',
        version: 'minmax(6rem, 0.9fr)',
        sku: 'minmax(6.5rem, 0.95fr)',
        capacity: 'minmax(4rem, 0.6fr)',
      },
      picker: {
        key: 'name',
        candidates: FOUNDRY_MODELS,
        placeholder: `Search ${FOUNDRY_MODELS.length} Foundry models…`,
        ariaLabel: 'Foundry model or custom deployment name',
        freeTextLabel: 'use custom deployment name',
        groups: [
          ['chat', 'Chat'],
          ['embeddings', 'Embeddings'],
          ['image', 'Image'],
        ],
      },
      controls: { aiserviceIndex: foundryIndexControl },
    },
  },
    additionalFoundries: {
      record: {
        columns: ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName', 'endpointSource'],
        visibleColumns: ['accountName', 'projectName', 'endpointSource'],
        maxVisible: 3,
        before: additionalFoundryPicker,
        controls: { endpointSource: endpointSourceControl },
        newRecord: {
          subscriptionId: '',
          resourceGroupName: '',
          accountName: '',
          projectName: '',
          endpointSource: '',
        },
        addLabel: 'Add manually',
      },
    },
  };
  return options[name] || null;
}

export function logicAppsWorkerGuidance(skuName) {
  const worker = LOGIC_APPS_TEMPLATE.workerSizes[skuName];
  return worker
    ? `${skuName} provides ${worker.vCpu} vCPU and ${worker.memoryGb} GB memory.`
    : 'Choose WS1, WS2, or WS3.';
}

function networkPrefixGuidance(param) {
  const value = editableValue(param.value);
  let cidr;
  try {
    cidr = new Ipv4Cidr(value);
  } catch {
    return null;
  }
  if (param.name === 'vnetAddressPrefix') {
    return h(
      'p',
      { class: 'param-guidance' },
      `${cidr.canonical} covers ${cidr.size.toLocaleString()} IPv4 addresses. ` +
        'Every deployed subnet must fit inside it without overlap.'
    );
  }
  if (!/SubnetPrefix$/.test(param.name)) return null;
  return h(
    'p',
    { class: 'param-guidance' },
    `${cidr.size.toLocaleString()} total addresses · ${cidr.usableAddresses.toLocaleString()} usable ` +
      'after Azure reserves the first four and last address.'
  );
}

function guidanceFor(param, ctx) {
  const network = networkPrefixGuidance(param);
  if (network) return network;
  if (param.name === 'apimSku') {
    return h('p', { class: 'param-guidance' }, 'Template-supported APIM tiers only. Capacity and capabilities vary by tier.');
  }
  if (param.name === 'apimSkuUnits') {
    const sku = ctx.paramValue('apimSku');
    const meta = APIM_SKUS[sku];
    return meta ? h('p', { class: 'param-guidance' }, `${meta.help} Capacity: ${meta.min === meta.max ? meta.min : `${meta.min}–${meta.max}`}.`) : null;
  }
  if (param.name === 'logicAppsSkuName') {
    return h(
      'div',
      { class: 'template-facts' },
      h('strong', {}, 'Worker size (vertical scale)'),
      h('span', {}, logicAppsWorkerGuidance(ctx.paramValue('logicAppsSkuName'))),
      h('span', {}, 'Assigned plan instances are configured independently.')
    );
  }
  if (param.name === 'logicAppsSkuCapacityUnits') {
    return h(
      'div',
      { class: 'template-facts' },
      h('strong', {}, 'Assigned plan instances (horizontal baseline capacity)'),
      h('span', {}, '1–20 under the current template, independent of worker size.'),
      h('span', {}, `Fixed by template: ${LOGIC_APPS_TEMPLATE.fixedFacts.join(' · ')}`)
    );
  }
  if (param.name === 'apicSku') return h('p', { class: 'param-guidance' }, API_CENTER_HELP);
  return null;
}

function targetAction(param, ctx) {
  const targets = ctx.accessTargets;
  if (!targets) return null;
  const definitions = {
    apim: {
      label: 'Use main deployment APIM',
      values: targets.apim ? [targets.apim] : [],
      fields: ['subscriptionId', 'resourceGroupName', 'name'],
      meta: (target) => `${target.name || 'unnamed'} · ${target.resourceGroupName || 'no resource group'}`,
    },
    foundry: {
      label: 'Choose existing Foundry',
      values: targets.foundries || [],
      fields: ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName'],
      meta: (target) => `${target.accountName || 'unnamed'} · ${target.location || 'no location'} · ${target.projectName || 'no project'}`,
    },
    keyVault: {
      label: 'Use main deployment Key Vault',
      values: targets.keyVault ? [targets.keyVault] : [],
      fields: ['subscriptionId', 'resourceGroupName', 'name'],
      meta: (target) => `${target.name || 'unnamed'} · ${target.resourceGroupName || 'no resource group'}`,
    },
  };
  const definition = definitions[param.name];
  if (!definition) return null;
  const ready = definition.values.filter((value) => value.ready);
  const missing = [...new Set(definition.values.flatMap((value) => value.missingLocal || value.missing || []))];
  if (!ready.length) {
    return h('p', { class: 'target-note' }, `${definition.label} autofill unavailable. Missing local fields: ${missing.join(', ') || 'target definition'}. You can still save complete contract values entered directly.`);
  }
  const control = picker(
    ready.map((target, index) => ({ value: String(index), meta: definition.meta(target) })),
    (selected) => ctx.applyObject([param.name], ready[Number(selected)], definition.fields),
    { placeholder: definition.label, ariaLabel: definition.label, freeText: false }
  );
  return h('div', { class: 'target-action' }, control.el);
}

/**
 * `scroll-behavior: auto !important` in a reduced-motion media query does not
 * override a `behavior: 'smooth'` passed to scrollIntoView -- the option wins.
 * The preference has to be read here or it is not honoured at all.
 */
function scrollBehavior() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function requirementChip(requirement) {
  if (!requirement) return null;
  return h('span', { class: `chip chip-${requirement}` }, requirement);
}

/**
 * True when the value is represented by a readEnvironmentVariable expression.
 * Mirrors the shape fields.mjs unwraps: a readEnvironmentVariable call, bare or
 * wrapped in a single int()/bool()/string() cast.
 */
function envCall(value) {
  if (!value || typeof value !== 'object' || !('__expr' in value)) return null;
  if (value.callee === ENV_CALL) return value;
  const inner = Array.isArray(value.args) && value.args.length === 1 ? value.args[0] : null;
  return inner && inner.callee === ENV_CALL ? inner : null;
}

function isEnvSourced(value) {
  return Boolean(envCall(value));
}

/** The variable name encoded in a readEnvironmentVariable expression. */
function envVarName(value) {
  const call = envCall(value);
  const name = call && call.args[0];
  return typeof name === 'string' ? name : null;
}

/**
 * The literal this file supplies, looking through an expression to the
 * fallback that is the only part of it the file actually owns.
 */
function ownValue(value) {
  const call = envCall(value);
  if (!call) return value;
  return call.args.length > 1 ? call.args[1] : undefined;
}

/**
 * Blank means the file states no value here -- the parameter resolves entirely
 * from the expression at deployment time. Many rows are
 * blank, so this is a layout-defining case, not an edge case.
 */
function isBlank(value) {
  const own = ownValue(value);
  return own === undefined || own === null || own === '';
}

/**
 * Content type of the control, so a toggle, a port number, a region name and a
 * sixty-character string are not all given the same width.
 */
function valueKind(param, schema) {
  const value = param.value;
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object' && !('__expr' in value)) return 'object';
  if (value && typeof value === 'object' && !envCall(value)) return 'raw';

  const own = ownValue(value);
  const type = (schema && schema.type) || param.kind;
  if (type === 'bool' || typeof own === 'boolean') return 'bool';
  if (type === 'int' || typeof own === 'number') return 'num';
  if (schema && Array.isArray(schema.allowedValues) && schema.allowedValues.length) return 'enum';
  if (typeof own === 'string' && (own.length > 40 || own.includes('\n'))) return 'long';
  return 'text';
}

function sectionState(params, ctx) {
  let env = 0;
  let dirty = 0;
  for (const p of params) {
    if (isEnvSourced(p.value)) env += 1;
    if (ctx.pendingFor(p.name)) dirty += 1;
  }
  return { env, dirty, total: params.length };
}

/**
 * Everything known about a parameter, assembled only when the popover opens.
 * The schema sentence comes from the Bicep type; the blocks come from the
 * comments above the parameter in the file itself; the variable and the
 * declared type are stated here rather than as columns, because ninety-seven
 * rows cannot each afford five columns and only one of the five is edited.
 */
function paramExplainer(param, schema, variable, type) {
  return () => [
    h('div', { class: 'explain-title' }, h('code', {}, param.name)),
    h(
      'dl',
      { class: 'explain-facts' },
      h('dt', {}, 'Type'),
      h('dd', {}, h('code', {}, type)),
      variable ? h('dt', {}, 'Expression variable') : null,
      variable ? h('dd', { class: 'is-env' }, h('code', {}, variable)) : null
    ),
    schema && schema.description ? h('p', { class: 'doc-para' }, schema.description) : null,
    renderBlocks(param.doc, 'doc doc-param'),
  ];
}

/** Column header. Stated once per run of rows, sticky under the section band. */
function headRow() {
  return h(
    'div',
    { class: 'prow prow-head' },
    h('div', { class: 'pcell pcell-gut' }),
    h('div', { class: 'pcell pcell-ident' }, 'Parameter'),
    h('div', { class: 'pcell pcell-val' }, 'Value in this file')
  );
}

/**
 * The type to show when the compiler has not told us one.
 *
 * `param.kind` describes the syntax that produced the value, so an
 * expression-backed parameter reports `call`. Unwrapping the cast recovers
 * something true: `int(...)` and `bool(...)` name the type outright, and a bare
 * lookup always yields a string.
 */
const CAST_TYPE = { int: 'int', bool: 'bool', string: 'string', json: 'object' };

function declaredKind(param) {
  const v = param.value;
  if (!v || typeof v !== 'object' || !('__expr' in v)) return param.kind;
  if (v.callee === ENV_CALL) return 'string';
  if (CAST_TYPE[v.callee]) return CAST_TYPE[v.callee];
  return param.kind;
}

/**
 * One record: a provenance gutter, an identity cell, and the control.
 *
 * Three columns, not five. The variable name and the description were columns
 * because nothing else on the row could tell two blank fields apart -- but a
 * blank field now says `— not set · APIM_SERVICE_NAME` in its own cell, which
 * is the same fact in the place the eye is already looking. What is left moves
 * into the popover the name has always carried, and the row loses 500px of
 * width it was spending to say things twice. That width is what pays for the
 * second column.
 */
function subscriptionRow(param, ctx) {
  const subscription = param.subscription;
  const input = h('input', {
    class: 'ctl ctl-w-long',
    value: subscription.value || '',
    disabled: Boolean(subscription.error || !subscription.environmentName),
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': 'Azure subscription ID',
  });
  const save = h(
    'button',
    {
      class: 'btn btn-sm',
      disabled: !subscription.valid,
      onclick: async () => {
        await ctx.saveSubscriptionId({
          environmentName: subscription.environmentName,
          value: input.value,
          expectedHash: subscription.hash,
        });
      },
    },
    'Save to azd environment'
  );
  const initialProblem = subscription.error || (
    subscription.available && !subscription.valid
      ? subscription.configured
        ? 'AZURE_SUBSCRIPTION_ID is not a complete Azure subscription GUID.'
        : 'AZURE_SUBSCRIPTION_ID is missing. Enter a complete Azure subscription GUID.'
      : null
  );
  const status = h('p', {
    class: `param-guidance${initialProblem ? ' field-error' : ''}`,
    role: initialProblem ? 'alert' : 'status',
  }, initialProblem || (
    subscription.available
      ? `Only AZURE_SUBSCRIPTION_ID is read from and written to ${subscription.source}.`
      : `Saving creates ${subscription.source} with only AZURE_SUBSCRIPTION_ID.`
  ));
  input.addEventListener('input', () => {
    let valid = false;
    try {
      validateSubscriptionId(input.value);
      valid = input.value.trim() !== subscription.value;
      status.className = 'param-guidance';
      status.textContent = `Only AZURE_SUBSCRIPTION_ID will change in ${subscription.source}.`;
    } catch (error) {
      status.className = 'param-guidance field-error';
      status.textContent = error.message;
    }
    save.disabled = Boolean(subscription.error || !subscription.environmentName || !valid);
  });

  return h(
    'div',
    {
      class: 'prow prow-env',
      id: 'param-subscriptionId',
      dataset: { kind: 'text' },
    },
    h('div', { class: 'pcell pcell-gut', title: 'Read from the selected azd environment' }),
    h(
      'div',
      { class: 'pcell pcell-ident' },
      h('h3', { class: 'prow-name' }, 'subscriptionId'),
      h('span', { class: 'ptype' }, 'string'),
      h('span', { class: 'chip chip-env' }, 'azd env')
    ),
    h(
      'div',
      { class: 'pcell pcell-val' },
      h('div', { class: 'subscription-control' }, input, save),
      status
    )
  );
}

function paramRow(param, ctx) {
  const rendered = paramRowContent(param, ctx);
  return ctx.decorateParameter ? ctx.decorateParameter(param, rendered) : rendered;
}

function paramRowContent(param, ctx) {
  if (param.subscription) return subscriptionRow(param, ctx);
  const schema = ctx.schemaFor(param.name);
  const pending = ctx.pendingFor(param.name);
  if (ctx.readOnly && param.previewStatus && param.previewStatus !== 'literal') {
    const reason = param.previewStatus === 'sensitive' ? 'Sensitive value retained; not displayed.'
      : param.previewStatus === 'not-evaluated' ? 'Expression retained; not evaluated. No runtime value is available.'
        : 'Target value retained; its type or value cannot be verified here.';
    return h('div', { class: 'prow', id: `param-${param.name}`, dataset: { kind: 'raw' } },
      h('div', { class: 'pcell pcell-gut' }),
      h('div', { class: 'pcell pcell-ident' }, h('h3', { class: 'prow-name' }, param.name),
        h('span', { class: 'ptype' }, schema?.type || param.kind)),
      h('div', { class: 'pcell pcell-val' }, h('span', { class: 'hint' }, reason), ctx.migrationChoice?.([param.name])));
  }

  // The LLM backend array has a dedicated editor; it needs the full row width.
  if (param.name === 'llmBackendConfig') {
    return h(
      'div',
      { class: `prow prow-full${pending ? ' prow-dirty' : ''}`, id: `param-${param.name}` },
      h(
        'div',
        { class: 'prow-fullhead' },
        h('h3', { class: 'prow-name' }, param.name),
        h('span', { class: 'ptype' }, (schema && schema.type) || param.kind),
        pending ? h('span', { class: 'chip chip-dirty' }, 'edited') : null
      ),
      ctx.migrationChoice?.([param.name]),
      renderLlmBackends(param.value, ctx, ctx)
    );
  }

  const kind = valueKind(param, schema);
  const variable = envVarName(param.value);
  // The declared Bicep type, never the expression kind. `param.kind` is `call`
  // for anything wrapped in readEnvironmentVariable(), which says how the
  // value is produced rather than what it is.
  const type = (schema && schema.type) || declaredKind(param);
  const name = h('h3', { class: 'prow-name', title: param.name }, param.name);

  const valueCell = { kind };
  const findings = ctx.findingsFor(param.name);
  if (isBlank(param.value) && kind !== 'object' && kind !== 'array' && kind !== 'raw') {
    valueCell.blank = 'yes';
  }

  const ident = h(
    'div',
    { class: 'pcell pcell-ident' },
    explains(name, paramExplainer(param, schema, variable, type)),
    h('span', { class: 'ptype' }, type),
    schema && schema.secure ? h('span', { class: 'chip chip-secure' }, 'secure') : null,
    pending ? h('span', { class: 'chip chip-dirty' }, 'edited') : null
  );

  return h(
    'div',
    {
      class: `prow${pending ? ' prow-dirty' : ''}${variable ? ' prow-env' : ''}`,
      id: `param-${param.name}`,
      dataset: { kind },
    },
    // Provenance is a 2px spine in the gutter, not a column and not a chip on
    // the control. Many rows are expression-backed, so the
    // marker has to cost almost nothing and still be scannable down the run.
    h('div', {
      class: 'pcell pcell-gut',
      title: variable ? `Resolved from ${variable} at deployment time` : '',
    }),
    ident,
    h(
      'div',
      { class: 'pcell pcell-val', dataset: valueCell },
      targetAction(param, ctx),
      renderValue(param.value, [param.name], ctx, schema, recordOptions(param.name, ctx)),
      ctx.migrationChoice?.([param.name]),
      guidanceFor(param, ctx),
      findings.map((finding) =>
        h(
          'p',
          {
            class: finding.severity === 'warning' ? 'field-warning' : 'field-error',
            role: finding.severity === 'warning' ? 'status' : 'alert',
          },
          finding.message
        )
      )
    )
  );
}

/**
 * How many column-stacks a run of records is allowed to break into.
 *
 * A column has to hold enough records to read as a column: three rows split
 * across three stacks is a grid, not a datasheet. Four is the floor, so a
 * group earns its second stack at eight rows and its third at twelve.
 *
 * The earlier floor of six was measured and found to be the largest remaining
 * source of the defect this rebuild exists to remove. Thirteen of fifteen
 * groups fell under it, so thirteen groups rendered one stack, a 1331px row
 * and a 320px control -- 683px of dead width per row, which is the original
 * 767px complaint with a smaller number on it. Four is the smallest run that
 * still reads as a column, and it takes those thirteen groups to two.
 *
 * The CSS takes this as a maximum and the browser still refuses any stack
 * narrower than --stack-min, so the count is data-driven at both ends and
 * there is no breakpoint anywhere in it.
 */
const ROWS_PER_STACK = 4;

function stacksFor(count) {
  return Math.max(1, Math.min(3, Math.floor(count / ROWS_PER_STACK)));
}

function groupNode(group, byName, ctx) {
  const params = group.params.map((name) => byName.get(name)).filter(Boolean);
  if (!params.length && !group.label) return null;

  return h(
    'div',
    { class: 'grp' },
    group.label ? h('h4', { class: 'grp-label' }, sectionTitle(group.label)) : null,
    renderBlocks(group.blocks, 'doc doc-group'),
    h(
      'div',
      { class: 'prows', style: `--stacks: ${stacksFor(params.length)}` },
      params.map((p) => paramRow(p, ctx))
    )
  );
}

/**
 * Section titles come from banner comments, which are written in the file as
 * `// RESOURCE NAMES - Assign custom names to ...`. Shouting is a property of
 * the comment convention, not of the heading, and nine shouted bands down a
 * sheet read as nine alarms. Sentence case restores the hierarchy without
 * touching the file.
 *
 * Acronyms are the exception and they have to be enumerated: `LOG` and `SIZE`
 * are words that happen to be short, `SKU` and `API` are not, and no rule
 * about length can tell them apart.
 */
const ACRONYMS = new Set([
  'AI', 'API', 'APIM', 'CORS', 'DNS', 'ID', 'IP', 'JSON', 'JWT', 'LLM', 'MCP',
  'SDK', 'SKU', 'SKUS', 'SSL', 'TLS', 'TTL', 'URL', 'VM', 'VNET', 'XML',
]);

function sectionTitle(raw) {
  const text = String(raw || '');
  return text.replace(/\b[A-Z][A-Z0-9&/]*(?:\s+[A-Z][A-Z0-9&/]*)*\b/g, (run) => {
    const words = run.split(/\s+/);
    if (words.length === 1 && ACRONYMS.has(run)) return run;
    if (words.length === 1 && run.length < 3) return run;
    return words
      .map((w, i) => {
        if (ACRONYMS.has(w)) return w;
        return (i === 0 ? w.charAt(0) : w.charAt(0)) + w.slice(1).toLowerCase();
      })
      .join(' ');
  });
}

/**
 * The rail names sections; it does not gloss them. A banner comment usually
 * reads `NAME - one sentence about the name`, and the sentence is what made
 * every rail entry wrap onto a second line and then truncate mid-word. The
 * name alone fits; the full text stays on the title attribute.
 */
const SECTION_NAV_NAMES = Object.freeze([
  [/^basic parameters\b/i, 'Basics'],
  [/^feature flags\b/i, 'Features'],
  [/^resource names\b/i, 'Resources'],
  [/^monitoring\b/i, 'Monitoring'],
  [/^networking parameters\b/i, 'Networking'],
  [/^inference api diagnostic log settings\b/i, 'Inference logs'],
  [/^compute sku\s*&\s*size\b/i, 'Compute'],
  [/^accelerator specific parameters\b/i, 'Accelerator'],
  [/^entra id authentication\b/i, 'Entra ID'],
  [/^deployment notes\b/i, 'Notes'],
  [/^api management \(apim\) configuration\b/i, 'APIM'],
  [/^apim managed identity configuration\b/i, 'Managed identity'],
  [/^llm backend configuration array\b/i, 'Backends'],
  [/^circuit breaker configuration\b/i, 'Circuit breaker'],
  [/^circuit breaker defaults\b/i, 'Breaker defaults'],
  [/^session affinity \(sticky routing\)/i, 'Session affinity'],
  [/^session affinity defaults\b/i, 'Affinity defaults'],
  [/^model aliases\b/i, 'Model aliases'],
]);

export function sectionNavTitle(raw) {
  const text = String(raw || '');
  const known = SECTION_NAV_NAMES.find(([pattern]) => pattern.test(text));
  if (known) return known[1];
  const cut = text.split(/\s+[-\u2013\u2014:]\s+/)[0] || text;
  const short = cut.length <= 24 ? cut : cut.split(/\s+/).slice(0, 3).join(' ');
  return sectionTitle(short);
}

function sectionNode(section, byName, ctx) {  const params = section.params.map((n) => byName.get(n)).filter(Boolean);
  const isNote = params.length === 0;
  const isFeatureSection = featureSection(section);
  const st = sectionState(params, ctx);
  // Reference appendices stay folded; sections carrying controls open, because a
  // collapsed accordion showed four of ninety-seven rows on a full screen.
  const open = ctx.isOpen(section.id, !isNote);
  const blocks = section.blocks || [];

  const head = h(
    'summary',
    { class: 'sec-band' },
    h('span', { class: 'sec-caret' }, '\u203a'),
    h('span', { class: 'sec-title' }, sectionTitle(section.title)),
    h(
      'span',
      { class: 'sec-tokens' },
      requirementChip(section.requirement),
      isNote
        ? h('span', { class: 'chip chip-note' }, 'reference')
        : h('span', { class: 'chip chip-count' }, `${st.total}`),
      st.env ? h('span', { class: 'chip chip-env' }, `${st.env} expr`) : null,
      st.dirty ? h('span', { class: 'chip chip-dirty' }, `${st.dirty} edited`) : null
    ),
    open
      ? h('span', { class: 'sec-spacer' })
      : h('span', { class: 'sec-summary' }, summarise(section.blocks))
  );

  // Some sections carry a full field-by-field reference in their comments. It is
  // worth keeping, but printing it above the controls buries the thing the user
  // came to change -- llmBackendConfig's notes alone run past two screens. Long
  // reference folds away; short prose stays where it explains.
  const prose =
    !isNote && blocks.length > 3
      ? (() => {
          const key = `${section.id}__doc`;
          const docOpen = ctx.isOpen(key, false);
          const el = h(
            'details',
            { class: 'secdoc', open: docOpen },
            h(
              'summary',
              { class: 'secdoc-toggle' },
              h('span', { class: 'secdoc-caret' }, '\u203a'),
              `Reference notes from the file (${blocks.length})`
            ),
            renderBlocks(blocks, 'doc doc-section')
          );
          el.addEventListener('toggle', () => ctx.setOpen(key, el.open));
          return el;
        })()
      : renderBlocks(blocks, 'doc doc-section');

  const body = h(
    'div',
    { class: 'sec-body' },
    prose,
    isNote
      ? null
      : [
          headRow(),
          ...(section.groups || [{ label: null, blocks: [], params: section.params }])
            .map((g) => groupNode(g, byName, ctx))
            .filter(Boolean)
        ]
  );

  const el = h(
    'details',
    {
      class: `sec${isNote ? ' sec-note' : ''}${isFeatureSection ? ' sec-features' : ''}`,
      id: `section-${section.id}`,
      open,
    },
    head,
    body
  );
  el.addEventListener('toggle', () => ctx.setOpen(section.id, el.open));
  return el;
}

/**
 * Section index for the context rail.
 *
 * Exported separately from the document body so the shell can pin it beside the
 * content rather than pushing the first parameter below a wall of links. The
 * `data-section` attribute is what the shell's scroll-spy reads to keep the
 * current section marked while the sheet moves.
 */
export function renderOutlineNav(doc, ctx, onNavigate, variant) {
  const sections = deploymentPresentation(doc, ctx);
  if (!sections.length) return null;

  const tabs = variant === 'tabs';
  const list = h(
    'ul',
    { class: 'outline-list' },
    sections.map((s) => {
      const params = s.params.map((n) => (doc.params || []).find((p) => p.name === n)).filter(Boolean);
      const st = sectionState(params, ctx);
      return h(
        'li',
        {},
        h(
          'button',
          {
            class: `outline-link${s.params.length ? '' : ' outline-note'}`,
            dataset: { section: s.id },
            title: s.title,
            onclick: () => {
              ctx.setOpen(s.id, true);
              const target = document.getElementById(`section-${s.id}`);
              if (target) {
                target.open = true;
                const sheet = target.closest('.sheet');
                const sticky = target.closest('.sheetwrap')?.querySelector('.sheet-sticky');
                const behavior = tabs ? 'auto' : scrollBehavior();
                if (sheet && sticky) {
                  const top =
                    sheet.scrollTop +
                    target.getBoundingClientRect().top -
                    sheet.getBoundingClientRect().top -
                    sticky.getBoundingClientRect().height -
                    8;
                  sheet.scrollTo({ top: Math.max(0, top), behavior });
                } else {
                  target.scrollIntoView({ block: 'start', behavior });
                }
              }
              if (onNavigate) onNavigate(s.id);
            },
          },
          h('span', { class: 'outline-label' }, sectionNavTitle(s.title)),
          st.dirty
            ? h(
                'span',
                {
                  class: 'outline-badge outline-badge-dirty',
                  title: `${st.dirty} unsaved ${st.dirty === 1 ? 'change' : 'changes'}`,
                },
                '\u25cf'
              )
            : null,
          !tabs && s.params.length
            ? h('span', { class: 'outline-badge' }, s.params.length)
            : null,
          !tabs && st.env
            ? h(
                'span',
                { class: 'outline-env', title: `${st.env} expression-backed values` },
                st.env
              )
            : null
        )
      );
    })
  );
  const nav = h(
    'nav',
    { class: `outline${tabs ? ' outline-tabs' : ''}`, 'aria-label': 'Sections' },
    list
  );
  return nav;
}

export function renderParamDocument(doc, ctx) {
  const parameters = [...doc.params];
  if (doc.subscription) {
    parameters.push({
      name: 'subscriptionId',
      kind: 'string',
      value: doc.subscription.value || '',
      subscription: doc.subscription,
    });
  }
  const byName = new Map(parameters.map((p) => [p.name, p]));
  const outline = doc.outline || { intro: null, sections: [] };
  const sections = deploymentPresentation(doc, ctx);

  // Anything the outline missed still has to be editable -- presentation must
  // never be able to hide a parameter.
  const covered = new Set((ctx.completeProjection ? sections : [...(outline.sections || []), ...sections])
    .flatMap((section) => section.params));
  const orphans = parameters.filter((p) => !covered.has(p.name));

  return h(
    'div',
    { class: 'document' },
    outline.intro
      ? h(
          'section',
          { class: 'intro' },
          h('h2', { class: 'intro-title' }, outline.intro.title),
          renderBlocks(outline.intro.blocks, 'doc doc-intro')
        )
      : null,
    h(
      'div',
      { class: 'sections' },
      sections.map((s) => sectionNode(s, byName, ctx)),
      orphans.length
        ? h(
            'details',
            { class: 'sec', id: 'section-__other', open: true },
            h(
              'summary',
              { class: 'sec-band' },
              h('span', { class: 'sec-caret' }, '\u203a'),
              h('span', { class: 'sec-title' }, 'Other parameters'),
              h(
                'span',
                { class: 'sec-tokens' },
                h('span', { class: 'chip chip-count' }, `${orphans.length}`)
              ),
              h('span', { class: 'sec-spacer' })
            ),
            h(
              'div',
              { class: 'sec-body' },
              headRow(),
              h(
                'div',
                { class: 'prows', style: `--stacks: ${stacksFor(orphans.length)}` },
                orphans.map((p) => paramRow(p, ctx))
              )
            )
          )
        : null
    )
  );
}
