import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createContainerAppsEntraAuthenticator } from '../src/relay/principalAuth.mjs';
import { buildSamplePlan, CATALOGUE, getSample } from '../src/catalogue/index.mjs';
import { createSampleRequestPolicy } from '../src/relay/requestPolicy.mjs';
import { makeFixtureReader } from './helpers/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFile(new URL(path, `file://${root}`), 'utf-8');

test('Container Apps deployment keeps public playground and relay boundaries explicit', async () => {
  const bicep = await read('infra/main.bicep');
  assert.match(bicep, /resource playgroundIdentity 'Microsoft\.ManagedIdentity\/userAssignedIdentities/);
  assert.match(bicep, /resource relayIdentity 'Microsoft\.ManagedIdentity\/userAssignedIdentities/);
  assert.match(bicep, /resource relay 'Microsoft\.App\/containerApps[\s\S]*?external: false/);
  assert.match(bicep, /resource playground 'Microsoft\.App\/containerApps[\s\S]*?external: true/);
  assert.match(bicep, /resource relayAuth 'Microsoft\.App\/containerApps\/authConfigs/);
  assert.match(bicep, /resource playgroundAuth 'Microsoft\.App\/containerApps\/authConfigs/);
  assert.match(bicep, /unauthenticatedClientAction: 'Return401'/);
  assert.match(bicep, /unauthenticatedClientAction: 'RedirectToLoginPage'/);
  assert.match(bicep, /allowedAudiences:[\s\S]*relayEntraClientId/);
  assert.match(bicep, /defaultAuthorizationPolicy:[\s\S]*allowedApplications:[\s\S]*allowedPrincipals:/);
  assert.match(bicep, /param hostedOperatorRequiredAppRole string = 'Citadel\.Operator'/);
  assert.match(bicep, /param hostedOperatorAllowedPrincipalIds array = \[\]/);
  assert.match(bicep, /param hostedOperatorAllowedGroupIds array = \[\]/);
  for (const suffix of ['PrincipalIds', 'GroupIds']) {
    const parameter = ['hosted', 'Operator', 'Platform', 'Allowed', suffix].join('');
    assert.match(bicep, new RegExp(`param ${parameter} array = \\[\\]`));
  }
  assert.match(bicep, /param relayRequestedAccessTokenVersion int/);
  assert.match(bicep, /@allowed\(\[\s*2\s*\]\)/);
  assert.match(bicep, /param azureCloud string/);
  assert.match(bicep, /'AzureCloud'[\s\S]*'AzureUSGovernment'[\s\S]*'AzureChinaCloud'/);
  assert.doesNotMatch(bicep, /AzureGermanCloud|login\.microsoftonline\.de|vault\.microsoftazure\.de/);
  assert.match(bicep, /relayTokenIssuer = '\$\{azureCloudProfile\.tokenIssuerBase\}\/\$\{entraTenantId\}\/v2\.0'/);
  assert.match(bicep, /openIdIssuer: relayTokenIssuer/);
});

test('deployment grants only image pull and relay Key Vault secret read access', async () => {
  const bicep = await read('infra/main.bicep');
  assert.match(bicep, /7f951dda-4ed3-4680-a7ca-43fe172d538d/);
  assert.match(bicep, /4633458b-17de-408a-b874-0445c86b69e6/);
  assert.match(bicep, /resource relayKeyVaultSecretsUser/);
  assert.doesNotMatch(bicep, /\b(Contributor|Owner)\b/);
  assert.doesNotMatch(bicep, /name: 'CITADEL_PLAYGROUND_RELAY_TOKEN'|CITADEL_PLAYGROUND_EXECUTE_TOKEN/);
  assert.doesNotMatch(bicep, /secretRef\(|clientSecret|password/i);
});

test('deployment passes managed-identity service authentication and exact relay policy inputs', async () => {
  const [bicep, managedIdentity, playgroundServer, relayServer, deploymentGuide] = await Promise.all([
    read('infra/main.bicep'),
    read('src/relay/managedIdentity.mjs'),
    read('server.mjs'),
    read('relay-server.mjs'),
    read('infra/README.md'),
  ]);
  for (const name of [
    'CITADEL_PLAYGROUND_RELAY_RESOURCE',
    'CITADEL_PLAYGROUND_AZURE_CLOUD',
    'CITADEL_PLAYGROUND_RELAY_AUDIENCE',
    'CITADEL_PLAYGROUND_RELAY_TOKEN_VERSION',
    'CITADEL_PLAYGROUND_RELAY_TOKEN_ISSUER',
    'CITADEL_PLAYGROUND_RELAY_ENTRA_CLIENT_ID',
    'CITADEL_PLAYGROUND_RELAY_CLIENT_ID',
    'CITADEL_PLAYGROUND_RELAY_CALLER_PRINCIPAL',
    'CITADEL_PLAYGROUND_RELAY_ALLOWED_SAMPLE_IDS',
    'CITADEL_PLAYGROUND_ENTRA_CLIENT_ID',
    'CITADEL_PLAYGROUND_OPERATOR_REQUIRED_APP_ROLE',
    'CITADEL_PLAYGROUND_OPERATOR_ALLOWED_PRINCIPAL_IDS',
    'CITADEL_PLAYGROUND_OPERATOR_ALLOWED_GROUP_IDS',
    'CITADEL_PLAYGROUND_RELAY_TIMEOUT_MS',
    'CITADEL_PLAYGROUND_PUBLIC_ORIGIN',
    'CITADEL_RELAY_ALLOWED_ORIGINS',
    'CITADEL_RELAY_TOKEN_VERSION',
    'CITADEL_RELAY_AZURE_CLOUD',
    'CITADEL_RELAY_ARM_CLOUD',
    'CITADEL_RELAY_ARM_ENDPOINT',
    'CITADEL_RELAY_KEY_VAULT_RESOURCE',
    'CITADEL_RELAY_KEY_VAULT_DNS_SUFFIX',
    'CITADEL_RELAY_TOKEN_ISSUER',
    'CITADEL_RELAY_TOKEN_RESOURCE',
    'CITADEL_RELAY_TOKEN_AUDIENCE',
    'CITADEL_RELAY_ENTRA_CLIENT_ID',
    'CITADEL_RELAY_ALLOWED_SAMPLE_IDS',
    'CITADEL_RELAY_REQUEST_POLICY',
    'CITADEL_RELAY_SECRET_MAPPINGS',
    'CITADEL_RELAY_MANAGED_IDENTITY_CLIENT_ID',
    'CITADEL_RELAY_BODY_LIMIT_BYTES',
    'CITADEL_RELAY_RUN_TIMEOUT_MS',
    'CITADEL_RELAY_HTTP_TIMEOUT_MS',
    'CITADEL_RELAY_MAX_REQUESTS_PER_RUN',
    'CITADEL_RELAY_MAX_CONCURRENT_REQUESTS',
  ]) {
    assert.match(bicep, new RegExp(name));
  }
  assert.match(bicep, /relayTokenResource/);
  for (const value of [
    'https://login.microsoftonline.com',
    'https://management.azure.com/',
    'https://vault.azure.net',
    '.vault.azure.net',
    'https://login.microsoftonline.us',
    'https://management.usgovcloudapi.net/',
    'https://vault.usgovcloudapi.net',
    '.vault.usgovcloudapi.net',
    'https://login.chinacloudapi.cn',
    'https://login.partner.microsoftonline.cn',
    'https://management.chinacloudapi.cn',
    'https://vault.azure.cn',
    '.vault.azure.cn',
  ]) {
    assert.ok(bicep.includes(value), `Bicep cloud profiles must include ${value}`);
  }
  assert.match(bicep, /CITADEL_RELAY_ARM_CLOUD', value: environment\(\)\.name/);
  assert.match(bicep, /CITADEL_RELAY_ARM_ENDPOINT', value: environment\(\)\.resourceManager/);
  assert.match(bicep, /CITADEL_RELAY_TOKEN_AUDIENCE', value: relayEntraClientId/);
  assert.match(bicep, /CITADEL_PLAYGROUND_RELAY_AUDIENCE', value: relayEntraClientId/);
  assert.match(bicep, /CITADEL_RELAY_ENTRA_AUTHENTICATED', value: 'true'/);
  assert.match(bicep, /CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED', value: 'true'/);
  assert.match(
    bicep,
    /CITADEL_PLAYGROUND_RELAY_ALLOWED_SAMPLE_IDS', value: string\(relayAllowedSampleIds\)/,
  );
  assert.match(
    bicep,
    /CITADEL_PLAYGROUND_RELAY_TIMEOUT_MS', value: string\(relayRunTimeoutMs \+ 15000\)/,
  );
  assert.match(
    bicep,
    /CITADEL_RELAY_ALLOWED_SAMPLE_IDS', value: string\(relayAllowedSampleIds\)/,
  );
  assert.match(
    bicep,
    /playgroundPublicOrigin = 'https:\/\/\$\{playgroundName\}\.\$\{managedEnvironment\.properties\.defaultDomain\}'/,
  );
  assert.doesNotMatch(bicep, /name: 'IDENTITY_(?:ENDPOINT|HEADER)'/, 'platform identity variables must never be authored by Bicep');
  assert.match(managedIdentity, /environment\[CONTAINER_APPS_ENDPOINT_ENV\]/);
  assert.match(managedIdentity, /'X-IDENTITY-HEADER'/);
  assert.match(managedIdentity, /redirect: 'error'/);
  assert.match(playgroundServer, /createManagedIdentityCredentialProvider\(\{[\s\S]*?environment: env/);
  assert.match(relayServer, /createKeyVaultSecretProvider\(\{[\s\S]*?environment: env/);
  assert.match(deploymentGuide, /`IDENTITY_ENDPOINT`/);
  assert.match(deploymentGuide, /`IDENTITY_HEADER`/);
  assert.match(deploymentGuide, /Partial or malformed injection fails/);
  assert.match(deploymentGuide, /"requestedAccessTokenVersion": 2/);
  assert.match(deploymentGuide, /relay-token-configuration-invalid/);
  assert.match(deploymentGuide, /npm run check:relay-app/);
  assert.match(deploymentGuide, /npm run check:playground-app/);
  assert.match(await read('infra/main.bicepparam'), /relayRequestedAccessTokenVersion = 2/);
  assert.match(await read('infra/main.bicepparam'), /hostedOperatorRequiredAppRole = 'Citadel\.Operator'/);
  const parameterFile = await read('infra/main.bicepparam');
  for (const suffix of ['PrincipalIds', 'GroupIds']) {
    const parameter = ['hosted', 'Operator', 'Platform', 'Allowed', suffix].join('');
    assert.match(parameterFile, new RegExp(`${parameter} = \\[\\]`));
  }
  assert.match(deploymentGuide, /AzureUSGovernment/);
  assert.match(deploymentGuide, /AzureChinaCloud/);
  assert.match(deploymentGuide, /login\.partner\.microsoftonline\.cn/);
  assert.match(deploymentGuide, /authentication-national-cloud/);
  assert.match(deploymentGuide, /access-tokens#validate-tokens/);
  assert.match(deploymentGuide, /login\.chinacloudapi\.cn\/common\/v2\.0\/\.well-known\/openid-configuration/);
  assert.match(deploymentGuide, /closed on October 29, 2021/i);
  assert.match(await read('infra/main.bicepparam'), /relayRequestedAccessTokenVersion = 2/);
  assert.match(await read('infra/main.bicepparam'), /azureCloud = 'AzureCloud'/);
});

test('the example Weather MCP request policy names and authorizes the canonical rebuilt plan exactly', async () => {
  const parameters = await read('infra/main.bicepparam');
  const endpoint = 'https://apim-gateway-host.example/mcp/weather-tool-mcp/mcp';
  for (const stepId of ['mcp-initialize', 'mcp-initialized', 'tools-list']) {
    assert.match(
      parameters,
      new RegExp(`'${stepId}': \\{[\\s\\S]*?'https://<apim-gateway-host>/mcp/weather-tool-mcp/mcp'[\\s\\S]*?'api-key'`),
    );
  }
  assert.doesNotMatch(parameters, /Ocp-Apim-Subscription-Key|\/weather\/mcp|\binitialize:\s*\{/);

  const readFixture = makeFixtureReader({
    'hub.gatewayUrl': 'https://apim-gateway-host.example',
    'gatewayAccess.subscriptionKeyHeader': 'api-key',
  });
  const { plan } = buildSamplePlan(getSample('weather-mcp-discovery'), readFixture);
  const requestPolicy = createSampleRequestPolicy({
    'weather-mcp-discovery': Object.fromEntries(
      ['mcp-initialize', 'mcp-initialized', 'tools-list'].map((stepId) => [
        stepId,
        { urls: [endpoint], headerNames: ['api-key'] },
      ]),
    ),
  });
  assert.deepEqual(
    plan.steps.filter((step) => step.type === 'http').map((step) => step.id),
    ['mcp-initialize', 'mcp-initialized', 'tools-list'],
  );
  assert.deepEqual(requestPolicy.authorizeStaticPlan('weather-mcp-discovery', plan), { ok: true });
  assert.equal(CATALOGUE.byId.has('weather-mcp-discovery'), true);
});

test('Container Apps probes match implemented health endpoints and constrain resources', async () => {
  const [bicep, playground, relay] = await Promise.all([
    read('infra/main.bicep'),
    read('server.mjs'),
    read('src/relay/server.mjs'),
  ]);
  assert.match(bicep, /path: '\/api\/live'/);
  assert.match(bicep, /path: '\/api\/health'/);
  assert.match(bicep, /path: '\/livez'/);
  assert.match(bicep, /path: '\/readyz'/);
  assert.match(playground, /path === '\/api\/live'/);
  assert.match(playground, /path === '\/api\/health'/);
  assert.match(relay, /requestPath === '\/livez'/);
  assert.match(relay, /requestPath === '\/healthz' \|\| requestPath === '\/readyz'/);
  assert.match(bicep, /cpu: json\('0\.5'\)/);
  assert.match(bicep, /memory: '1Gi'/);
  const relayResource = bicep.match(/resource relay 'Microsoft\.App\/containerApps[\s\S]*?resource relayAuth/)[0];
  const playgroundResource = bicep.match(/resource playground 'Microsoft\.App\/containerApps[\s\S]*?resource playgroundAuth/)[0];
  assert.match(relayResource, /(?:^|\n)\s*minReplicas: 1\s*(?:\n|$)/);
  assert.match(relayResource, /(?:^|\n)\s*maxReplicas: 1\s*(?:\n|$)/);
  assert.match(playgroundResource, /(?:^|\n)\s*minReplicas: 1\s*(?:\n|$)/);
  assert.match(playgroundResource, /(?:^|\n)\s*maxReplicas: 2\s*(?:\n|$)/);
  assert.match(bicep, /relayEffectiveRequestTimeoutMs = min\(relayRequestTimeoutMs, relayRunTimeoutMs\)/);
  assert.match(bicep, /CITADEL_RELAY_HTTP_TIMEOUT_MS', value: string\(relayEffectiveRequestTimeoutMs\)/);
});

test('hosted relay documentation prohibits scale-out until nonce and admission state are actually shared', async () => {
  const [deploymentGuide, readme] = await Promise.all([read('infra/README.md'), read('README.md')]);
  assert.match(deploymentGuide, /each active revision at exactly one replica/i);
  assert.match(deploymentGuide, /scale-out is prohibited[\s\S]*shared atomic\s+adapter/i);
  assert.match(deploymentGuide, /Revision\s+transitions\s+and\s+process\s+restarts\s+replace\s+that\s+local\s+state/i);
  assert.match(readme, /direct `\/execute` path uses process-local atomic nonce consumption/i);
  assert.match(readme, /horizontal scale-out is prohibited[\s\S]*shared atomic\s+adapter/i);
  assert.match(readme, /Revision\s+transitions\s+and\s+process\s+restarts\s+replace\s+that\s+local\s+state/i);
});

test('relay image is non-root, zero-dependency, and excludes local process execution', async () => {
  const [dockerfile, packageJson] = await Promise.all([
    read('Dockerfile.relay'),
    read('package.json'),
  ]);
  assert.match(dockerfile, /^FROM node:20-alpine/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /COPY playground\/src\/server\/assertions\.mjs/);
  assert.match(dockerfile, /COPY playground\/src\/server\/redaction\.mjs/);
  assert.match(dockerfile, /COPY playground\/src\/server\/runRequest\.mjs/);
  assert.doesNotMatch(dockerfile, /--chown=node:node/);
  assert.doesNotMatch(dockerfile, /npm (install|ci)|apk add|azure-cli|python|child_process|localExecutor|transports\.mjs/i);
  assert.deepEqual(JSON.parse(packageJson).dependencies, { '@azure/msal-node': '6.0.0', jose: '6.2.12' });
});

test('hosted Entra trust accepts only the deployment tenant and a valid platform principal', async () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const clientId = '22222222-2222-2222-2222-222222222222';
  const principalId = '33333333-3333-3333-3333-333333333333';
  const roleType = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role';
  const authenticator = createContainerAppsEntraAuthenticator({
    tenantId,
    clientId,
    requiredRole: 'Citadel.Operator',
  });
  const principal = Buffer.from(
    JSON.stringify({
      auth_typ: 'aad',
      name_typ: 'name',
      claims: [
        { typ: 'tid', val: tenantId },
        { typ: 'aud', val: clientId },
        { typ: 'oid', val: principalId },
        { typ: roleType, val: 'Citadel.Operator' },
      ],
      role_typ: roleType,
    }),
  ).toString('base64');
  assert.deepEqual(
    await authenticator.authenticate({ headers: { 'x-ms-client-principal': principal } }),
    {
      ok: true,
      principal: principalId,
      tenant: tenantId,
      roles: ['Citadel.Operator'],
      authorization: { role: true, principal: false, group: false },
    },
  );
  assert.deepEqual(
    await authenticator.authenticate({
      headers: {
        'x-ms-client-principal': Buffer.from(
          JSON.stringify({
            auth_typ: 'aad',
            role_typ: roleType,
            claims: [
              { typ: 'tid', val: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
              { typ: 'aud', val: clientId },
              { typ: 'oid', val: principalId },
              { typ: roleType, val: 'Citadel.Operator' },
            ],
          }),
        ).toString('base64'),
      },
    }),
    {
      ok: false,
      status: 403,
      authenticated: true,
      reason: 'container-apps-principal-not-authorized',
    },
  );
});
