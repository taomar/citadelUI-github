import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createContainerAppsEntraAuthenticator } from '../src/relay/principalAuth.mjs';

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
  assert.match(bicep, /allowedAudiences:[\s\S]*relayTokenAudience/);
});

test('deployment grants only image pull and relay Key Vault secret read access', async () => {
  const bicep = await read('infra/main.bicep');
  assert.match(bicep, /7f951dda-4ed3-4680-a7ca-43fe172d538d/);
  assert.match(bicep, /4633458b-17de-408a-b874-0445c86b69e6/);
  assert.match(bicep, /resource relayKeyVaultSecretsUser/);
  assert.doesNotMatch(bicep, /\b(Contributor|Owner)\b/);
  assert.doesNotMatch(bicep, /CITADEL_PLAYGROUND_RELAY_TOKEN|CITADEL_PLAYGROUND_EXECUTE_TOKEN/);
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
    'CITADEL_PLAYGROUND_RELAY_CLIENT_ID',
    'CITADEL_PLAYGROUND_RELAY_CALLER_PRINCIPAL',
    'CITADEL_RELAY_ALLOWED_ORIGINS',
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
  assert.match(bicep, /relayTokenAudience/);
  assert.match(bicep, /CITADEL_RELAY_ENTRA_AUTHENTICATED', value: 'true'/);
  assert.match(bicep, /CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED', value: 'true'/);
  assert.doesNotMatch(bicep, /name: 'IDENTITY_(?:ENDPOINT|HEADER)'/, 'platform identity variables must never be authored by Bicep');
  assert.match(managedIdentity, /environment\[CONTAINER_APPS_ENDPOINT_ENV\]/);
  assert.match(managedIdentity, /'X-IDENTITY-HEADER'/);
  assert.match(managedIdentity, /redirect: 'error'/);
  assert.match(playgroundServer, /createManagedIdentityCredentialProvider\(\{[\s\S]*?environment: env/);
  assert.match(relayServer, /createKeyVaultSecretProvider\(\{[\s\S]*?environment: env/);
  assert.match(deploymentGuide, /`IDENTITY_ENDPOINT`/);
  assert.match(deploymentGuide, /`IDENTITY_HEADER`/);
  assert.match(deploymentGuide, /Partial or malformed injection fails/);
});

test('Container Apps probes match implemented health endpoints and constrain resources', async () => {
  const [bicep, playground, relay] = await Promise.all([
    read('infra/main.bicep'),
    read('server.mjs'),
    read('src/relay/server.mjs'),
  ]);
  assert.match(bicep, /path: '\/api\/health'/);
  assert.match(bicep, /path: '\/healthz'/);
  assert.match(bicep, /path: '\/readyz'/);
  assert.match(playground, /path === '\/api\/health'/);
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
  assert.deepEqual(JSON.parse(packageJson).dependencies, {});
});

test('hosted Entra trust accepts only the deployment tenant and a valid platform principal', async () => {
  const authenticator = createContainerAppsEntraAuthenticator({ tenantId: 'tenant-a' });
  const principal = Buffer.from(
    JSON.stringify({
      name_typ: 'name',
      claims: [
        { typ: 'tid', val: 'tenant-a' },
        { typ: 'oid', val: 'playground-principal' },
        { typ: 'roles', val: 'relay.invoke' },
      ],
      role_typ: 'roles',
    }),
  ).toString('base64url');
  assert.deepEqual(
    await authenticator.authenticate({ headers: { 'x-ms-client-principal': principal } }),
    { ok: true, principal: 'playground-principal', tenant: 'tenant-a', roles: ['relay.invoke'] },
  );
  assert.deepEqual(
    await authenticator.authenticate({
      headers: { 'x-ms-client-principal': Buffer.from(JSON.stringify({ claims: [{ typ: 'tid', val: 'tenant-b' }] })).toString('base64url') },
    }),
    { ok: false, reason: 'container-apps-principal-not-authorized' },
  );
});
