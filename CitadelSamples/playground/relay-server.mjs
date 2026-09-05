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
import { createContainerAppsEntraAuthenticator } from './src/relay/principalAuth.mjs';
import { createRelayTenantBundle, createStaticTenantPolicy } from './src/relay/tenantPolicy.mjs';
import { createRelayServer } from './src/relay/server.mjs';
import {
  readHostedRelayLimits,
  relayExecutorLimitsFromHosted,
  relayServerLimitsFromHosted,
} from './src/relay/limits.mjs';

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

function secretMappings(env) {
  const configured = json(env, 'CITADEL_RELAY_SECRET_MAPPINGS');
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new TypeError('CITADEL_RELAY_SECRET_MAPPINGS must be a JSON object of logical refs to Key Vault secret names.');
  }
  const vaultUrl = required(env, 'CITADEL_RELAY_KEY_VAULT_URI');
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
  const tenantId = required(env, 'CITADEL_RELAY_TENANT_ID');
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
      mappings: secretMappings(env),
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
  return createRelayServer({
    tenantPolicy,
    authenticator: createContainerAppsEntraAuthenticator({ tenantId }),
    host: env.CITADEL_RELAY_HOST ?? '0.0.0.0',
    ...relayServerLimitsFromHosted(hostedLimits),
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (process.env.CITADEL_RELAY_ENTRA_AUTHENTICATED !== 'true') {
    throw new Error('CITADEL_RELAY_ENTRA_AUTHENTICATED must be true for the hosted relay.');
  }
  const port = Number(process.env.CITADEL_RELAY_PORT ?? 8080);
  const host = process.env.CITADEL_RELAY_HOST ?? '0.0.0.0';
  const server = buildHostedRelay(process.env);
  server.listen(port, host, () => process.stdout.write(`Citadel relay listening on ${host}:${port}\n`));
}
