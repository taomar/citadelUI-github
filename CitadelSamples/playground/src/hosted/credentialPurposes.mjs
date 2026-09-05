export const RESOURCE_PURPOSES = Object.freeze(['foundry', 'key-vault', 'insights']);
export const AUTH_PURPOSES = Object.freeze(['signin', 'azure', ...RESOURCE_PURPOSES]);
const PUBLIC_SCOPES = Object.freeze({
  foundry: 'https://ai.azure.com/.default',
  'key-vault': 'https://vault.azure.net/.default',
  insights: 'https://api.applicationinsights.io/Data.Read',
});

export function purposeEnabled(config, purpose) {
  if (purpose === 'signin' || purpose === 'azure') return true;
  // W1 has no verified production service contracts. Only trusted fixture configuration enables these.
  return RESOURCE_PURPOSES.includes(purpose) && config.stagedEnabled === true
    && config.cloud?.name === 'AzureCloud' && config.resourcePurposes?.includes(purpose) === true;
}

export function purposeScopes(config, purpose) {
  if (!purposeEnabled(config, purpose)) {
    throw Object.assign(new Error('This resource consent contract is not verified or enabled.'), { status: 403, code: 'service-contract-unverified' });
  }
  return purpose === 'signin' ? ['openid', 'profile']
    : purpose === 'azure' ? [`${config.cloud.resourceManager.replace(/\/?$/, '/')}.default`] : [PUBLIC_SCOPES[purpose]];
}

export function purposeStates(config, session) {
  return Object.fromEntries(['azure', ...RESOURCE_PURPOSES].map((purpose) => [purpose,
    !purposeEnabled(config, purpose) ? 'disabled'
      : (purpose === 'azure' ? session?.azure : session?.credentials?.[purpose]) ? 'connected' : 'consent-required']));
}
