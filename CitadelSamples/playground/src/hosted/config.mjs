import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { getAzureCloudProfile } from '../relay/azureCloud.mjs';
import { readHostedAuthorizationPolicy } from '../relay/operatorAuthorization.mjs';
import { createSampleRequestPolicy } from '../relay/requestPolicy.mjs';

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const GATEWAY_RECIPES = Object.freeze([
  'weather-mcp-discovery', 'learn-mcp-discovery', 'a2a-agent-card',
  'a2a-message-send', 'weather-tools-call',
]);
export const ARM_RECIPES = Object.freeze(['azure-context-check', 'apim-discovery']);
export const HOSTED_RECIPES = Object.freeze([...ARM_RECIPES, ...GATEWAY_RECIPES]);

export function httpsOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new TypeError('Configure one exact HTTPS origin without a path or credentials.'); }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new TypeError('Configure one exact HTTPS origin without a path or credentials.');
  }
  return url.origin;
}

export function secretFile(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError(`${label} requires an absolute mounted file path.`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
    throw new TypeError(`${label} requires a regular mounted file of at most 64 KiB.`);
  }
  return readFileSync(path, 'utf8');
}

export function readTls(env, origin) {
  const cert = secretFile(env.CITADEL_TLS_CERT_FILE, 'CITADEL_TLS_CERT_FILE');
  const key = secretFile(env.CITADEL_TLS_KEY_FILE, 'CITADEL_TLS_KEY_FILE');
  const certificate = new X509Certificate(cert);
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo)) {
    throw new TypeError('The application TLS certificate is not currently valid.');
  }
  const hostname = new URL(origin).hostname;
  if (checkServerIdentity(hostname, certificate.toLegacyObject())) {
    throw new TypeError('The application TLS certificate does not match the public origin.');
  }
  const publicKey = createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' });
  if (!publicKey.equals(certificate.publicKey.export({ type: 'spki', format: 'der' }))) {
    throw new TypeError('The mounted TLS private key does not match the certificate.');
  }
  return { cert, key, minVersion: 'TLSv1.2', expiresAt: Date.parse(certificate.validTo) };
}

function integer(env, name, fallback, max) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`${name} is outside its permitted range.`);
  return value;
}

export function readHostedConfig(env = process.env) {
  const origin = httpsOrigin(env.CITADEL_PLAYGROUND_PUBLIC_ORIGIN);
  if (!['0', '1', undefined].includes(env.CITADEL_HOSTED_STAGED_MODE)) throw new TypeError('CITADEL_HOSTED_STAGED_MODE must be 0 or 1.');
  const stagedEnabled = env.CITADEL_HOSTED_STAGED_MODE === '1';
  const stagedDirectory = stagedEnabled ? env.CITADEL_HOSTED_STATE_DIRECTORY : null;
  if (stagedEnabled && (typeof stagedDirectory !== 'string' || !isAbsolute(stagedDirectory))) {
    throw new TypeError('Explicit staged mode requires an absolute dedicated local state directory.');
  }
  const issues = [];
  const read = (name, fn) => {
    try { return fn(); } catch { issues.push(`${name}: missing or invalid deployment configuration.`); return null; }
  };
  const cloud = read('CITADEL_PLAYGROUND_AZURE_CLOUD', () => {
    if (!env.CITADEL_PLAYGROUND_AZURE_CLOUD) throw new TypeError('An explicit Azure cloud is required');
    return getAzureCloudProfile(env.CITADEL_PLAYGROUND_AZURE_CLOUD);
  });
  const guid = (name) => read(name, () => {
    if (!GUID.test(env[name] ?? '')) throw new TypeError(name);
    return env[name];
  });
  const tenantId = guid('CITADEL_PLAYGROUND_ENTRA_TENANT_ID');
  const clientId = guid('CITADEL_PLAYGROUND_ENTRA_CLIENT_ID');
  const clientSecret = read('CITADEL_ENTRA_CLIENT_SECRET_FILE', () => {
    const value = secretFile(env.CITADEL_ENTRA_CLIENT_SECRET_FILE, 'Client credential').trim();
    if (!value) throw new TypeError('Empty credential');
    return value;
  });
  const policy = read('CITADEL_PLAYGROUND_OPERATOR_*', () => readHostedAuthorizationPolicy(env));
  const authIssues = [...issues];
  const subscriptionIds = read('CITADEL_HOSTED_SUBSCRIPTION_IDS', () => {
    const values = JSON.parse(env.CITADEL_HOSTED_SUBSCRIPTION_IDS ?? '');
    if (!Array.isArray(values) || values.length > 100 || !values.every((id) => GUID.test(id)) || new Set(values).size !== values.length) {
      throw new TypeError('Invalid subscription policy');
    }
    return Object.freeze(values);
  }) ?? [];
  const gatewayPolicy = read('CITADEL_HOSTED_GATEWAY_POLICY_FILE', () => {
    const value = JSON.parse(secretFile(env.CITADEL_HOSTED_GATEWAY_POLICY_FILE, 'Gateway policy'));
    if (!value || !Array.isArray(value.origins) || !value.origins.length || value.origins.length > 20) throw new TypeError('Missing gateway origins');
    value.origins.forEach(httpsOrigin);
    if (!value.samples || Object.keys(value.samples).some((id) => !GATEWAY_RECIPES.includes(id))) throw new TypeError('Unknown gateway sample');
    createSampleRequestPolicy(value.samples);
    for (const steps of Object.values(value.samples)) {
      for (const step of Object.values(steps)) {
        if (step.urls.some((url) => !value.origins.includes(new URL(url).origin))) throw new TypeError('Gateway route outside origin policy');
      }
    }
    return value;
  });
  if (env.CITADEL_PLAYGROUND_RELAY_URL) {
    issues.push('Optional relay is disabled in hosted BFF mode; an all-HTTPS credential transport needs separate configuration and review.');
  }
  return Object.freeze({
    origin, callback: `${origin}/auth/callback`, logoutRedirect: `${origin}/`, cloud, tenantId, clientId, clientSecret, policy,
    authIssues: Object.freeze(authIssues), issues: Object.freeze(issues),
    subscriptionIds, gatewayPolicy, stagedEnabled, stagedDirectory,
    resourcePurposes: Object.freeze([]),
    idleMs: integer(env, 'CITADEL_SESSION_IDLE_SECONDS', 1800, 1800) * 1000,
    absoluteMs: integer(env, 'CITADEL_SESSION_ABSOLUTE_SECONDS', 28800, 28800) * 1000,
    transactionMs: integer(env, 'CITADEL_AUTH_TRANSACTION_SECONDS', 300, 300) * 1000,
    maxSessions: integer(env, 'CITADEL_MAX_SESSIONS', 500, 2000),
    maxTransactions: integer(env, 'CITADEL_MAX_AUTH_TRANSACTIONS', 100, 500),
    maxConcurrentRuns: integer(env, 'CITADEL_MAX_CONCURRENT_RUNS', 8, 32),
  });
}
