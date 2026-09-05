import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTls } from './helpers/hostedTls.mjs';
import { tenantId, clientId, subscriptionId, fixtureGatewayPolicy } from './helpers/hostedFixtures.mjs';

test('production Docker image boots HTTPS with read-only secret mounts and encrypted health checks', {
  skip: process.env.CITADEL_RUN_HOSTED_CONTAINER_TEST !== '1',
  timeout: 120000,
}, async () => {
  const tls = testTls();
  const name = 'citadel-auth-v4-8ea0cc0f-app';
  const image = 'citadel-auth-v4-8ea0cc0f:app';
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const docker = (...args) => {
    const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, `Docker ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  writeFileSync(join(tls.directory, 'client.txt'), 'SYNTHETIC-TEST-ONLY-client-secret');
  writeFileSync(join(tls.directory, 'policy.json'), JSON.stringify(fixtureGatewayPolicy()));
  let created = false;
  try {
    docker('create', '--name', name, '--network', 'none', '--read-only',
      '--mount', `type=bind,source=${tls.directory},target=/run/test,readonly`,
      '--env', 'CITADEL_PLAYGROUND_PUBLIC_ORIGIN=https://localhost:8443',
      '--env', 'CITADEL_PLAYGROUND_AZURE_CLOUD=AzureCloud',
      '--env', 'CITADEL_PLAYGROUND_OPERATOR_REQUIRED_APP_ROLE=Citadel.Operator',
      '--env', `CITADEL_PLAYGROUND_ENTRA_TENANT_ID=${tenantId}`,
      '--env', `CITADEL_PLAYGROUND_ENTRA_CLIENT_ID=${clientId}`,
      '--env', 'CITADEL_ENTRA_CLIENT_SECRET_FILE=/run/test/client.txt',
      '--env', 'CITADEL_TLS_CERT_FILE=/run/test/server.pem',
      '--env', 'CITADEL_TLS_KEY_FILE=/run/test/server.key',
      '--env', 'NODE_EXTRA_CA_CERTS=/run/test/ca.pem',
      '--env', `CITADEL_HOSTED_SUBSCRIPTION_IDS=${JSON.stringify([subscriptionId])}`,
      '--env', 'CITADEL_HOSTED_GATEWAY_POLICY_FILE=/run/test/policy.json', image);
    created = true;
    docker('start', name);
    const check = `
      const https=require('node:https'); const assert=require('node:assert/strict');
      https.get('https://localhost:8443/api/capabilities',res=>{
        assert.equal(res.statusCode,200);let text='';res.on('data',part=>text+=part);res.on('end',()=>{
          const value=JSON.parse(text); assert.equal(value.auth.available,true);
          assert.equal(value.auth.signedIn,false); assert.equal(value.executor.canExecute,false);
          assert.equal(value.hosted.allowedSampleIds.length,7); console.log('ordinary HTTPS entry ready, operator session required');
        });
      }).on('error',()=>{process.exitCode=1;});
    `;
    await new Promise((resolve) => setTimeout(resolve, 700));
    docker('exec', name, 'node', 'src/hosted/healthcheck.mjs');
    assert.match(docker('exec', name, 'node', '-e', check), /operator session required/);
    docker('restart', name);
    await new Promise((resolve) => setTimeout(resolve, 700));
    docker('exec', name, 'node', 'src/hosted/healthcheck.mjs');
    assert.match(docker('exec', name, 'node', '-e', check), /ordinary HTTPS entry ready/);
    const inspection = JSON.parse(docker('inspect', name))[0];
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspection.Mounts.every((mount) => mount.RW === false), true);
    assert.equal(inspection.HostConfig.NetworkMode, 'none');
    assert.equal(inspection.Config.User, 'node');
    assert.deepEqual(inspection.Config.Cmd, ['node', 'hosted-server.mjs']);
    assert.equal(Object.values(inspection.NetworkSettings.Ports ?? {}).every((bindings) => bindings === null), true);
  } finally {
    if (created) docker('rm', '--force', name);
    tls.clean();
  }
});
