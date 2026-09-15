/**
 * Versioned, offline Azure product metadata used only for editor guidance.
 * Region lists are suggestions, not deployment-availability validation.
 */
import { AZURE_REGION_NAMES, AZURE_REGIONS } from '../../shared/azure-regions.mjs';

export const AZURE_META = Object.freeze({
  verifiedAt: '2026-08-30',
  sources: Object.freeze({
    regions: 'https://learn.microsoft.com/azure/reliability/regions-list',
    apimTiers: 'https://learn.microsoft.com/azure/api-management/api-management-features',
    apimV2: 'https://learn.microsoft.com/azure/api-management/v2-service-tiers-overview',
    apiCenterPricing: 'https://learn.microsoft.com/azure/api-center/overview',
    logicAppsHosting: 'https://learn.microsoft.com/azure/logic-apps/single-tenant-overview-compare',
    logicAppsPricing: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-pricing#pricing-tiers-in-the-standard-model',
  }),
});

export const REGION_NAMES = AZURE_REGION_NAMES;
export const PRIMARY_REGIONS = AZURE_REGIONS;
export const API_CENTER_REGIONS = AZURE_REGIONS;

export const APIC_LOCATION_VALUES = Object.freeze(['', ...API_CENTER_REGIONS]);

export const APIM_SKUS = Object.freeze({
  Developer: Object.freeze({
    min: 1,
    max: 1,
    label: 'Developer',
    help: 'Evaluation and development tier with no SLA; one unit only.',
  }),
  Premium: Object.freeze({
    min: 1,
    max: 12,
    label: 'Premium',
    help: 'Classic production tier with virtual-network, zone, and multi-region capabilities; this editor changes only capacity.',
  }),
  StandardV2: Object.freeze({
    min: 1,
    max: 10,
    label: 'Standard v2',
    help: 'Production v2 tier with faster provisioning and private endpoint support; availability features depend on the template configuration.',
  }),
  PremiumV2: Object.freeze({
    min: 1,
    max: 30,
    label: 'Premium v2',
    help: 'Highest v2 tier with expanded networking and scale; this template uses a supported 2024-05-01 API.',
  }),
});

export const LOGIC_APPS_TEMPLATE = Object.freeze({
  min: 1,
  max: 20,
  workerSizes: Object.freeze({
    WS1: Object.freeze({ vCpu: 1, memoryGb: 3.5 }),
    WS2: Object.freeze({ vCpu: 2, memoryGb: 7 }),
    WS3: Object.freeze({ vCpu: 4, memoryGb: 14 }),
  }),
  fixedFacts: Object.freeze([
    'Standard single-tenant Logic App',
    'Workflow Service Plan on Windows',
    'WS family',
    'WorkflowStandard tier',
    'maximumElasticWorkerCount 20',
    'minimumElasticInstanceCount 1',
    'preWarmedInstanceCount 1',
  ]),
});

export const API_CENTER_HELP =
  'Free is suited to evaluation and smaller catalogs; Standard adds production scale and governance capabilities. The template controls only the SKU.';
