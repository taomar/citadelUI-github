#!/usr/bin/env node
/**
 * Production entrypoint for the HTTP/assertion-only relay. All authorization
 * inputs are deployment-owned environment values; no request selects a tenant,
 * destination, policy, secret, or identity.
 */

import { CATALOGUE, buildSamplePlan, requirementsFor } from './src/catalogue/index.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRelayAllowedSampleIds, parseRelayAllowedSampleIds } from './src/relay/requestSchema.mjs';
import { createOriginAllowlist } from './src/relay/originAllowlist.mjs';
import { createSampleRequestPolicy } from './src/relay/requestPolicy.mjs';
import { createKeyVaultSecretProvider } from './src/relay/secretProvider.mjs';
import { validateRelayCloudConfiguration } from './src/relay/azureCloud.mjs';
import { createContainerAppsEntraAuthenticator } from './src/relay/principalAuth.mjs';
import {
  HostedAuthorizationConfigurationError,
  hostedAuthorizationConfigurationError,
} from './src/relay/operatorAuthorization.mjs';
import { createRelayTenantBundle, createStaticTenantPolicy } from './src/relay/tenantPolicy.mjs';
import { createRelayServer } from './src/relay/server.mjs';
import {
  readRelayTokenContract,
  relayTokenConfigurationError,
  RelayTokenConfigurationError,
} from './src/relay/tokenContract.mjs';
import {
  readHostedRelayLimits,
  relayExecutorLimitsFromHosted,
  relayServerLimitsFromHosted,
} from './src/relay/limits.mjs';
import { createServer } from 'node:http';

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be configured.`);
  return value;
}

function json(env, name) {
  try {
    return JSON.parse(required(env, name));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError(`${name} must be valid JSON.`);
    throw error;
  }
}

function secretMappings(env, vaultUrl) {
  const configured = json(env, 'CITADEL_RELAY_SECRET_MAPPINGS');
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new TypeError('CITADEL_RELAY_SECRET_MAPPINGS must be a JSON object of logical refs to Key Vault secret names.');
  }
  return Object.fromEntries(
    Object.entries(configured).map(([ref, secretName]) => {
      if (typeof secretName !== 'string' || secretName === '') {
        throw new TypeError(`CITADEL_RELAY_SECRET_MAPPINGS.${ref} must be a non-empty secret name.`);
      }
      return [ref, { vaultUrl, secretName }];
    }),
  );
}

export function buildHostedRelay(env = process.env) {
  if (env.CITADEL_RELAY_ENTRA_AUTHENTICATED !== 'true') {
    throw new RelayTokenConfigurationError('CITADEL_RELAY_ENTRA_AUTHENTICATED must be exactly true.');
  }
  const tokenContract = readRelayTokenContract(env, {
    cloud: 'CITADEL_RELAY_AZURE_CLOUD',
    version: 'CITADEL_RELAY_TOKEN_VERSION',
    issuer: 'CITADEL_RELAY_TOKEN_ISSUER',
    resource: 'CITADEL_RELAY_TOKEN_RESOURCE',
    audience: 'CITADEL_RELAY_TOKEN_AUDIENCE',
    tenantId: 'CITADEL_RELAY_TENANT_ID',
    clientId: 'CITADEL_RELAY_ENTRA_CLIENT_ID',
  });
  let cloudProfile;
  try {
    cloudProfile = validateRelayCloudConfiguration({
      cloud: tokenContract.cloud,
      armCloud: env.CITADEL_RELAY_ARM_CLOUD,
      armEndpoint: env.CITADEL_RELAY_ARM_ENDPOINT,
      keyVaultResource: env.CITADEL_RELAY_KEY_VAULT_RESOURCE,
      keyVaultDnsSuffix: env.CITADEL_RELAY_KEY_VAULT_DNS_SUFFIX,
      keyVaultUrl: env.CITADEL_RELAY_KEY_VAULT_URI,
      labels: {
        cloud: 'CITADEL_RELAY_AZURE_CLOUD',
        armCloud: 'CITADEL_RELAY_ARM_CLOUD',
        armEndpoint: 'CITADEL_RELAY_ARM_ENDPOINT',
        keyVaultResource: 'CITADEL_RELAY_KEY_VAULT_RESOURCE',
        keyVaultDnsSuffix: 'CITADEL_RELAY_KEY_VAULT_DNS_SUFFIX',
        keyVaultUrl: 'CITADEL_RELAY_KEY_VAULT_URI',
      },
    });
  } catch (error) {
    throw new RelayTokenConfigurationError(error.message);
  }
  const tenantId = tokenContract.tenantId;
  const allowedPrincipalId = required(env, 'CITADEL_RELAY_ALLOWED_PRINCIPAL_ID');
  const allowedSampleIds = parseRelayAllowedSampleIds(
    env.CITADEL_RELAY_ALLOWED_SAMPLE_IDS,
    CATALOGUE,
    { buildSamplePlan, requirementsFor },
  );
  const allowedOrigins = json(env, 'CITADEL_RELAY_ALLOWED_ORIGINS');
  const requestPolicy = json(env, 'CITADEL_RELAY_REQUEST_POLICY');
  const hostedLimits = readHostedRelayLimits(env);
  const structuralAllowedSampleIds = computeRelayAllowedSampleIds(CATALOGUE, { buildSamplePlan, requirementsFor });
  const bundle = createRelayTenantBundle({
    allowedSampleIds,
    originAllowlist: createOriginAllowlist(allowedOrigins),
    requestPolicy: createSampleRequestPolicy(requestPolicy),
    secretProvider: createKeyVaultSecretProvider({
      mappings: secretMappings(env, cloudProfile.vaultUrl),
      cloud: cloudProfile.name,
      clientId: required(env, 'CITADEL_RELAY_MANAGED_IDENTITY_CLIENT_ID'),
      environment: env,
    }),
    limits: relayExecutorLimitsFromHosted(hostedLimits),
  });
  const tenantPolicy = createStaticTenantPolicy(
    {
      [tenantId]: {
        ...bundle,
        allowedPrincipals: [allowedPrincipalId],
      },
    },
    { structuralAllowedSampleIds },
  );
  const server = createRelayServer({
    tenantPolicy,
    authenticator: createContainerAppsEntraAuthenticator({
      tenantId,
      clientId: tokenContract.clientId,
      allowedPrincipalIds: [allowedPrincipalId],
    }),
    host: env.CITADEL_RELAY_HOST ?? '0.0.0.0',
    ...relayServerLimitsFromHosted(hostedLimits),
  });
  server.tokenContract = tokenContract;
  server.cloudProfile = cloudProfile;
  return server;
}

function createConfigurationErrorServer(error) {
  const configurationError =
    error instanceof RelayTokenConfigurationError
      ? relayTokenConfigurationError(error)
      : hostedAuthorizationConfigurationError(error);
  return createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const live = path === '/livez';
    const payload = live
      ? { status: 'ok' }
      : path === '/healthz' || path === '/readyz'
        ? { status: 'error', ...configurationError }
        : {
            state: 'blocked',
            summary: 'Hosted relay authentication configuration is invalid.',
            ...configurationError,
          };
    response.writeHead(live ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(JSON.stringify(payload));
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  let server;
  try {
    server = buildHostedRelay(process.env);
  } catch (error) {
    if (
      !(error instanceof RelayTokenConfigurationError) &&
      !(error instanceof HostedAuthorizationConfigurationError)
    ) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);
    server = createConfigurationErrorServer(error);
  }
  const port = Number(process.env.CITADEL_RELAY_PORT ?? 8080);
  const host = process.env.CITADEL_RELAY_HOST ?? '0.0.0.0';
  server.listen(port, host, () => process.stdout.write(`Citadel relay listening on ${host}:${port}\n`));
}
