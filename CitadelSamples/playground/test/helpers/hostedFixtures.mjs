import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { CATALOGUE, buildSamplePlan } from '../../src/catalogue/index.mjs';
import { GATEWAY_RECIPES } from '../../src/hosted/config.mjs';
import { getAzureCloudProfile } from '../../src/relay/azureCloud.mjs';
import { makeFixtureReader, FIXTURE_VALUES, FIXTURE_SECRETS } from './fixtures.mjs';

export const tenantId = '11111111-1111-1111-1111-111111111111';
export const clientId = '22222222-2222-2222-2222-222222222222';
export const oid = '33333333-3333-3333-3333-333333333333';
export const subscriptionId = FIXTURE_VALUES['hub.subscriptionId'];
export const gatewayOrigin = FIXTURE_VALUES['hub.gatewayUrl'];
export const operatorClaims = () => ({ tid: tenantId, oid, roles: ['Citadel.Operator'],
  preferred_username: 'operator@example.invalid', exp: Math.floor(Date.now() / 1000) + 3600 });

export function fixtureGatewayPolicy(origin = gatewayOrigin) {
  const read = makeFixtureReader({ 'hub.gatewayUrl': origin });
  return { origins: [origin], samples: Object.fromEntries(GATEWAY_RECIPES.map((id) => {
    const { plan } = buildSamplePlan(CATALOGUE.byId.get(id), read);
    return [id, Object.fromEntries(plan.steps.filter((step) => step.type === 'http').map((step) =>
      [step.id, { urls: [step.request.url], headerNames: Object.keys(step.request.headers ?? {}) }]))];
  })) };
}

export function hostedConfig(overrides = {}) {
  return {
    origin: 'https://localhost', callback: 'https://localhost/auth/callback',
    cloud: getAzureCloudProfile('AzureCloud'), tenantId, clientId, clientSecret: 'synthetic-test-client-secret',
    policy: { requiredRole: 'Citadel.Operator', allowedPrincipalIds: [], allowedGroupIds: [] },
    authIssues: [], issues: [], subscriptionIds: [subscriptionId], gatewayPolicy: fixtureGatewayPolicy(),
    idleMs: 1800000, absoluteMs: 28800000, transactionMs: 300000, maxSessions: 30, maxTransactions: 10,
    ...overrides,
  };
}

export function runPayload(sampleId, session, overrides = {}) {
  const sample = CATALOGUE.byId.get(sampleId);
  const read = makeFixtureReader(overrides);
  return { protocolVersion: 2, sampleId, contextVersion: session.contextVersion,
    inputs: Object.fromEntries(sample.configurationEntries.filter((entry) => !entry.secret).map((entry) => [entry.path, read(entry.path)])),
    secrets: Object.fromEntries(sample.configurationEntries.filter((entry) => entry.secret).map((entry) => [entry.path, FIXTURE_SECRETS[entry.path]])),
    acknowledgement: { accepted: true, sampleId } };
}

export function fixtureResourceResponse(url, options = {}) {
  const parsed = new URL(url);
  if (parsed.origin === 'https://management.azure.com') {
    const subscription = { subscriptionId, displayName: 'Synthetic subscription', tenantId, state: 'Enabled' };
    if (parsed.pathname === '/subscriptions') return Response.json({ value: [subscription] });
    if (parsed.pathname === `/subscriptions/${subscriptionId}`) return Response.json(subscription);
    const id = `/subscriptions/${subscriptionId}/resourceGroups/${FIXTURE_VALUES['hub.resourceGroupName']}/providers/Microsoft.ApiManagement/service`;
    const apim = { id: `${id}/apim-citadel-test`, name: 'apim-citadel-test', location: 'swedencentral',
      sku: { name: 'Developer' }, properties: { gatewayUrl: gatewayOrigin } };
    if (parsed.pathname === id) return Response.json({ value: [apim] });
    if (parsed.pathname === apim.id) return Response.json(apim);
    throw new Error('Unexpected fixture ARM operation');
  }
  if (parsed.origin !== gatewayOrigin) throw new Error('No external fixture destination allowed');
  if (options.method === 'GET' || !options.body) return Response.json({
    protocolVersion: '0.3.0', name: 'Synthetic agent', description: 'Offline test fixture',
    url: `${gatewayOrigin}/agent/hr-chat-agent`, version: '1.0', capabilities: {},
    defaultInputModes: ['text'], defaultOutputModes: ['text'], skills: [{ id: 'hr', name: 'HR' }],
  });
  const message = JSON.parse(options.body);
  if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } }
    : message.method === 'tools/list' ? { tools: [{ name: 'get-weather', inputSchema: { type: 'object' } }] }
    : message.method === 'tools/call' ? { isError: false, content: [{ type: 'text', text: JSON.stringify({
      city: message.params.arguments.city, temperature: 18,
      temperature_format: ['Seattle', 'New York City', 'Los Angeles'].includes(message.params.arguments.city) ? 'Fahrenheit' : 'Celsius',
      description: 'Synthetic weather', humidity: 50, wind_speed: 2,
    }) }] }
    : { kind: 'message', messageId: 'synthetic-message', role: 'agent', parts: [{ kind: 'text', text: 'Synthetic HR response' }] };
  return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers: { 'Mcp-Session-Id': 'synthetic-mcp-session' } });
}

// Test-only identity provider: no transport to Microsoft or a real resource.
export async function createIdentityFixture(config) {
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
  const authority = `${config.cloud.loginEndpoint}/${tenantId}`;
  const issuer = `${config.cloud.tokenIssuerBase}/${tenantId}/v2.0`;
  const codes = new Map();
  const calls = [];
  let lastClaims;
  function authorize(location, { roles = ['Citadel.Operator'] } = {}) {
    const url = new URL(location);
    if (url.searchParams.get('redirect_uri') !== config.callback || url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('Invalid fixture authorization');
    const code = randomUUID();
    codes.set(code, { nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge'),
      scope: url.searchParams.get('scope'), roles });
    const callback = new URL(config.callback);
    callback.searchParams.set('state', url.searchParams.get('state'));
    callback.searchParams.set('code', code);
    return callback.href;
  }
  async function fetchImpl(url, options = {}) {
    calls.push({ url, method: options.method ?? 'GET' });
    if (new URL(url).origin !== config.cloud.loginEndpoint) throw new Error('No real identity network permitted');
    if (url.includes('.well-known/openid-configuration')) return Response.json({
      issuer, authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
      token_endpoint: `${authority}/oauth2/v2.0/token`, jwks_uri: `${authority}/discovery/v2.0/keys`,
      end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
    });
    if (url.endsWith('/discovery/v2.0/keys')) return Response.json({ keys: [jwk] });
    if (!new URL(url).pathname.endsWith('/oauth2/v2.0/token')) throw new Error('Unexpected fixture identity endpoint');
    const parameters = new URLSearchParams(options.body);
    if (parameters.get('client_secret') !== config.clientSecret || parameters.get('client_id') !== clientId) throw new Error('Invalid fixture client');
    let tx;
    if (parameters.get('grant_type') === 'authorization_code') {
      tx = codes.get(parameters.get('code'));
      codes.delete(parameters.get('code'));
      if (!tx || createHash('sha256').update(parameters.get('code_verifier') ?? '').digest('base64url') !== tx.challenge
        || parameters.get('redirect_uri') !== config.callback) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      lastClaims = { ...operatorClaims(), roles: tx.roles, nonce: tx.nonce };
    } else if (parameters.get('grant_type') !== 'refresh_token') throw new Error('Unexpected fixture grant');
    const token = await new SignJWT(lastClaims).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setSubject(oid).setIssuer(issuer).setAudience(clientId).setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000) - 1).sign(keys.privateKey);
    return Response.json({ token_type: 'Bearer', scope: parameters.get('scope'),
      expires_in: 3600, ext_expires_in: 3600, access_token: 'synthetic-delegated-arm-token',
      refresh_token: 'synthetic-refresh-token', id_token: token,
      client_info: Buffer.from(JSON.stringify({ uid: oid, utid: tenantId })).toString('base64url') });
  }
  return { authorize, fetchImpl, calls };
}
