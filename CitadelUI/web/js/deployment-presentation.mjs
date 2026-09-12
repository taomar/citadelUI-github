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

export function featureSection(section) {
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

export function sectionTitle(raw) {
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
