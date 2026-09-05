import { createSqliteRunStore } from '../../src/hosted/sqliteRunStore.mjs';
import { digest } from '../../src/hosted/request.mjs';

export const storageRecord = (nonce = 'first', target = 'service') => ({
  tenant: '11111111-1111-1111-1111-111111111111', owner: '22222222-2222-2222-2222-222222222222',
  sampleId: 'foundry-enable-a2a', adapterVersion: 'fixture-1', policyDigest: digest('fixed-policy'),
  identityDigest: digest({ target, operation: 'fixed' }), nonceHash: digest(nonce),
  targets: [{ resourceId: `/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/test/providers/Microsoft.ApiManagement/service/${target}`,
    origin: 'https://gateway.example.invalid' }],
});

if (process.send && process.argv[2]) {
  const store = createSqliteRunStore({ directory: process.argv[2] });
  const { run } = store.claim(storageRecord());
  store.beginEffect(run.id, 'write-once', digest('fixed-effect'));
  process.send({ runId: run.id, diagnostics: store.diagnostics() });
  process.on('message', () => { store.close(); process.exit(0); });
}
