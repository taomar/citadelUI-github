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
  const bicep = await read('infra/main.bicep');
  for (const name of [
    'CITADEL_PLAYGROUND_RELAY_RESOURCE',
    'CITADEL_PLAYGROUND_RELAY_CLIENT_ID',
    'CITADEL_PLAYGROUND_RELAY_CALLER_PRINCIPAL',
    'CITADEL_RELAY_ALLOWED_ORIGINS',
    'CITADEL_RELAY_ALLOWED_SAMPLE_IDS',
    'CITADEL_RELAY_REQUEST_POLICY',
    'CITADEL_RELAY_SECRET_MAPPINGS',
    'CITADEL_RELAY_MANAGED_IDENTITY_CLIENT_ID',
  ]) {
    assert.match(bicep, new RegExp(name));
  }
  assert.match(bicep, /relayTokenAudience/);
  assert.match(bicep, /CITADEL_RELAY_ENTRA_AUTHENTICATED', value: 'true'/);
  assert.match(bicep, /CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED', value: 'true'/);
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
  assert.match(bicep, /minReplicas: 1/);
  assert.match(bicep, /maxReplicas: 2/);
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
