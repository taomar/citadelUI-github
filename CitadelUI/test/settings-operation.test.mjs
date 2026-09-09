import assert from 'node:assert/strict';
import test from 'node:test';

import { createEnvironmentOperation } from '../web/js/settings-operation.mjs';

test('cancelled environment setup is not reported as successful completion', async () => {
  const statuses = [];
  const operation = createEnvironmentOperation({
    setInlineStatus: (message, tone) => statuses.push({ message, tone }),
    setGlobalStatus: () => {},
  })('Creating project', async () => false);
  assert.equal(await operation(), false);
  assert.deepEqual(statuses.at(-1), { message: 'Operation cancelled.', tone: 'info' });
});

for (const message of [
  'Folder permission was denied. Reconnect the environment and grant read/write access.',
  'The saved folder handle is missing. Reconnect this environment.',
  'The selected root is incompatible with Citadel UI.',
  'Registry revision conflict. Reload Settings before retrying.',
  'Registry mirror failed. Check the local Citadel service and retry.',
]) {
  test(`environment operation surfaces ${message.split('.')[0].toLowerCase()}`, async () => {
    const inline = [];
    const global = [];
    const wrap = createEnvironmentOperation({
      setInlineStatus: (detail, tone) => inline.push({ message: detail, tone }),
      setGlobalStatus: (detail, tone) => global.push({ message: detail, tone }),
    });
    const state = { environments: ['Development'] };
    const result = await wrap('Updating environment\u2026', async (onRollback) => {
      const before = [...state.environments];
      onRollback(async () => {
        state.environments = before;
      });
      state.environments = [];
      throw new Error(message);
    })();
    assert.equal(result, undefined);
    assert.deepEqual(state.environments, ['Development']);
    assert.deepEqual(inline.at(-1), { message, tone: 'error' });
    assert.deepEqual(global.at(-1), { message, tone: 'error' });
  });
}
