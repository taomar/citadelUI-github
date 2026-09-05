/**
 * Hosted relay Microsoft Entra access-token contract.
 *
 * The relay app registration is external to this ARM deployment, so the code,
 * Bicep, and offline manifest preflight all enforce the same v2-only contract.
 */

import { getAzureCloudProfile } from './azureCloud.mjs';

export const RELAY_ACCESS_TOKEN_VERSION = 2;
export const RELAY_TOKEN_CONFIGURATION_ERROR = 'relay-token-configuration-invalid';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class RelayTokenConfigurationError extends TypeError {
  constructor(message) {
    super(`Hosted relay authentication configuration error: ${message}`);
    this.name = 'RelayTokenConfigurationError';
    this.code = RELAY_TOKEN_CONFIGURATION_ERROR;
  }
}

function fail(message) {
  throw new RelayTokenConfigurationError(message);
}

function canonicalGuid(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || !GUID_PATTERN.test(value)) {
    fail(`${label} must be a canonical lowercase Microsoft Entra GUID.`);
  }
  return value;
}

function requiredString(value, label) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${label} must be a non-empty value without surrounding whitespace or control characters.`);
  }
  return value;
}

function canonicalIssuer(value, tenantId, cloudProfile, label) {
  const issuer = requiredString(value, label);
  const expected = `${cloudProfile.tokenIssuerBase}/${tenantId}/v2.0`;
  if (issuer !== expected) {
    fail(`${label} must be exactly ${expected}.`);
  }
  return issuer;
}

/**
 * Validate the exact v2-only resource-app contract used by managed identity.
 */
export function validateRelayTokenContract({
  cloud,
  version,
  issuer,
  resource,
  audience,
  tenantId,
  clientId,
  labels = {},
} = {}) {
  const cloudLabel = labels.cloud ?? 'relay Azure cloud profile';
  const versionLabel = labels.version ?? 'relay token version';
  const issuerLabel = labels.issuer ?? 'relay token issuer';
  const resourceLabel = labels.resource ?? 'relay token resource';
  const audienceLabel = labels.audience ?? 'relay token audience';
  const tenantLabel = labels.tenantId ?? 'relay tenant ID';
  const clientLabel = labels.clientId ?? 'relay app client ID';

  let cloudProfile;
  try {
    cloudProfile = getAzureCloudProfile(cloud, cloudLabel);
  } catch (error) {
    fail(error.message);
  }
  if (version !== RELAY_ACCESS_TOKEN_VERSION && version !== String(RELAY_ACCESS_TOKEN_VERSION)) {
    fail(
      `${versionLabel} must be exactly ${RELAY_ACCESS_TOKEN_VERSION}; null/default or v1 app registrations issue incompatible v1 access tokens.`,
    );
  }
  const canonicalTenantId = canonicalGuid(tenantId, tenantLabel);
  const canonicalClientId = canonicalGuid(clientId, clientLabel);
  const canonicalResource = requiredString(resource, resourceLabel);
  const canonicalAudience = requiredString(audience, audienceLabel);
  const expectedResource = `api://${canonicalClientId}`;
  if (canonicalResource !== expectedResource) {
    fail(`${resourceLabel} must be exactly ${expectedResource}.`);
  }
  const expectedAudience = canonicalClientId;
  if (canonicalAudience !== expectedAudience) {
    fail(`${audienceLabel} must be exactly ${expectedAudience}.`);
  }

  return Object.freeze({
    cloud: cloudProfile.name,
    version: RELAY_ACCESS_TOKEN_VERSION,
    issuer: canonicalIssuer(issuer, canonicalTenantId, cloudProfile, issuerLabel),
    resource: canonicalResource,
    audience: canonicalAudience,
    tenantId: canonicalTenantId,
    clientId: canonicalClientId,
  });
}

/**
 * Read one runtime contract while retaining the exact environment-variable
 * name in any startup error.
 */
export function readRelayTokenContract(environment, names) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('the hosted relay environment must be an object.');
  }
  for (const key of ['cloud', 'version', 'issuer', 'resource', 'audience', 'tenantId', 'clientId']) {
    if (typeof names?.[key] !== 'string' || names[key] === '') {
      throw new TypeError(`readRelayTokenContract requires a ${key} environment-variable name.`);
    }
  }
  return validateRelayTokenContract({
    cloud: environment[names.cloud],
    version: environment[names.version],
    issuer: environment[names.issuer],
    resource: environment[names.resource],
    audience: environment[names.audience],
    tenantId: environment[names.tenantId],
    clientId: environment[names.clientId],
    labels: {
      cloud: names.cloud,
      version: names.version,
      issuer: names.issuer,
      resource: names.resource,
      audience: names.audience,
      tenantId: names.tenantId,
      clientId: names.clientId,
    },
  });
}

/**
 * Validate an exported Microsoft Graph application object without contacting
 * Azure. The nested api.requestedAccessTokenVersion value must be numeric 2;
 * null/default is deliberately rejected because it produces v1 access tokens.
 */
export function validateRelayAppRegistrationManifest(manifest, expectedContract) {
  const contract = validateRelayTokenContract(expectedContract);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('the relay app-registration manifest must be one JSON object.');
  }
  if (manifest.appId !== contract.clientId) {
    fail(`manifest appId must be exactly ${contract.clientId}.`);
  }
  if (!Array.isArray(manifest.identifierUris) || !manifest.identifierUris.includes(contract.resource)) {
    fail(`manifest identifierUris must include exactly ${contract.resource}.`);
  }
  if (!manifest.api || typeof manifest.api !== 'object' || Array.isArray(manifest.api)) {
    fail('manifest api must be an object with requestedAccessTokenVersion set to 2.');
  }
  if (manifest.api.requestedAccessTokenVersion !== RELAY_ACCESS_TOKEN_VERSION) {
    fail(
      'manifest api.requestedAccessTokenVersion must be the number 2; null/default or 1 issues incompatible v1 access tokens.',
    );
  }
  return Object.freeze({ ...contract, requestedAccessTokenVersion: RELAY_ACCESS_TOKEN_VERSION });
}

export function relayTokenConfigurationError(error) {
  if (!(error instanceof RelayTokenConfigurationError)) throw error;
  return Object.freeze({ code: error.code, detail: error.message });
}
