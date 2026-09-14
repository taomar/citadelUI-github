import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDialogModule } from './_dom-stub.mjs';

test('policy outline DOM fixture stores custom properties without enumerating its style method', async () => {
  const { node } = await loadDialogModule();
  const section = node('section');
  const other = node('section');
  section.style.color = 'navy';
  section.style.setProperty('--policy-jump-inset', '120px');
  assert.deepEqual(section.style, { color: 'navy', '--policy-jump-inset': '120px' });
  section.style.setProperty('--policy-jump-inset', 0);
  assert.equal(section.style['--policy-jump-inset'], '0');
  assert.deepEqual(other.style, {});
  assert.equal(Object.getOwnPropertyDescriptor(section.style, 'setProperty').writable, true);
});
