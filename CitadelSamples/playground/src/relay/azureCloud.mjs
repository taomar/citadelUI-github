/**
 * Trusted Azure cloud profiles for hosted relay authentication and Key Vault.
 *
 * These values are code-owned policy. Deployment configuration selects one
 * profile and repeats the expected endpoints so startup can detect drift, but
 * it cannot introduce a new login endpoint, token issuer, token audience, or
 * vault DNS suffix.
 */

const PROFILE_DEFINITIONS = {
  AzureCloud: {
    loginEndpoint: 'https://login.microsoftonline.com',
    tokenIssuerBase: 'https://login.microsoftonline.com',
    resourceManager: 'https://management.azure.com/',
    keyVaultResource: 'https://vault.azure.net',
    keyVaultDnsSuffix: '.vault.azure.net',
  },
  AzureUSGovernment: {
    loginEndpoint: 'https://login.microsoftonline.us',
    tokenIssuerBase: 'https://login.microsoftonline.us',
    resourceManager: 'https://management.usgovcloudapi.net/',
    keyVaultResource: 'https://vault.usgovcloudapi.net',
    keyVaultDnsSuffix: '.vault.usgovcloudapi.net',
  },
  AzureChinaCloud: {
    loginEndpoint: 'https://login.chinacloudapi.cn',
    tokenIssuerBase: 'https://login.partner.microsoftonline.cn',
    resourceManager: 'https://management.chinacloudapi.cn',
    keyVaultResource: 'https://vault.azure.cn',
    keyVaultDnsSuffix: '.vault.azure.cn',
  },
};

export const AZURE_CLOUD_PROFILES = Object.freeze(
  Object.fromEntries(
    Object.entries(PROFILE_DEFINITIONS).map(([name, profile]) => [
      name,
      Object.freeze({ name, ...profile }),
    ]),
  ),
);

export const SUPPORTED_AZURE_CLOUDS = Object.freeze(Object.keys(AZURE_CLOUD_PROFILES));

function requiredString(value, label) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty value without surrounding whitespace or control characters.`);
  }
  return value;
}

export function getAzureCloudProfile(value, label = 'Azure cloud profile') {
  const name = requiredString(value, label);
  if (!Object.prototype.hasOwnProperty.call(AZURE_CLOUD_PROFILES, name)) {
    throw new TypeError(`${label} must be exactly one of ${SUPPORTED_AZURE_CLOUDS.join(', ')}.`);
  }
  return AZURE_CLOUD_PROFILES[name];
}

function exactValue(value, expected, label) {
  const configured = requiredString(value, label);
  if (configured !== expected) {
    throw new TypeError(`${label} must be exactly ${expected}.`);
  }
  return configured;
}

export function validateKeyVaultUrl(value, cloud, label = 'Key Vault URI') {
  const profile = getAzureCloudProfile(cloud);
  const configured = requiredString(value, label);
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTPS vault URL for ${profile.name}.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const vaultName = hostname.endsWith(profile.keyVaultDnsSuffix)
    ? hostname.slice(0, -profile.keyVaultDnsSuffix.length)
    : '';
  const canonical = `https://${hostname}`;
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    vaultName === '' ||
    vaultName.includes('.') ||
    !/^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/.test(vaultName) ||
    (configured !== canonical && configured !== `${canonical}/`)
  ) {
    throw new TypeError(
      `${label} must be one unadorned HTTPS vault host ending in ${profile.keyVaultDnsSuffix}.`,
    );
  }
  return canonical;
}

/**
 * Validate the deployment-selected profile against the actual ARM cloud and
 * the repeated Key Vault values before any managed-identity token is requested.
 */
export function validateRelayCloudConfiguration({
  cloud,
  armCloud,
  armEndpoint,
  keyVaultResource,
  keyVaultDnsSuffix,
  keyVaultUrl,
  labels = {},
} = {}) {
  const cloudLabel = labels.cloud ?? 'relay Azure cloud profile';
  const profile = getAzureCloudProfile(cloud, cloudLabel);
  exactValue(armCloud, profile.name, labels.armCloud ?? 'relay ARM cloud');
  exactValue(armEndpoint, profile.resourceManager, labels.armEndpoint ?? 'relay ARM endpoint');
  exactValue(
    keyVaultResource,
    profile.keyVaultResource,
    labels.keyVaultResource ?? 'relay Key Vault token resource',
  );
  exactValue(
    keyVaultDnsSuffix,
    profile.keyVaultDnsSuffix,
    labels.keyVaultDnsSuffix ?? 'relay Key Vault DNS suffix',
  );
  const vaultUrl = validateKeyVaultUrl(keyVaultUrl, profile.name, labels.keyVaultUrl ?? 'relay Key Vault URI');
  return Object.freeze({ ...profile, vaultUrl });
}
