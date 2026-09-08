import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './_dom-stub.mjs';
import { requireOwnerSession } from '../web/js/owner-gate.mjs';

for (const [code, field, clearsPassword] of [
  ['INVALID_USERNAME', 'gate-username', false],
  ['INVALID_PASSWORD', 'gate-password', true],
  ['INVALID_CREDENTIALS', 'gate-password', true],
]) {
  test(`${code} associates the owner error with ${field} without widening authentication`, async (t) => {
    const dom = installDom();
    document.querySelector = () => ({ content: code === 'INVALID_CREDENTIALS' ? 'claimed' : 'unclaimed' });
    const values = new Map();
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    globalThis.window = { localStorage: { setItem: (key, value) => values.set(key, value) } };
    t.after(() => { globalThis.window = originalWindow; globalThis.fetch = originalFetch; });
    let accepted = false;
    const calls = [];
    globalThis.fetch = async (path) => {
      calls.push(path);
      return {
        ok: accepted, status: accepted ? 200 : 400,
        json: async () => accepted ? { sessionToken: 'synthetic-session' }
          : { error: { code, message: code === 'INVALID_USERNAME' ? 'Choose a username of 1 to 64 characters.'
            : code === 'INVALID_PASSWORD' ? 'Choose a password of at least 8 characters.' : 'Invalid username or password.' } },
      };
    };
    const session = requireOwnerSession();
    const username = document.getElementById('gate-username');
    const password = document.getElementById('gate-password');
    password.value = 'synthetic form value';
    const form = dom.root.querySelector('form');
    const submit = async () => {
      for (const listener of form.listeners.get('submit')) await listener({ preventDefault() {} });
    };
    await submit();
    const target = document.getElementById(field);
    assert.equal(document.activeElement, target);
    assert.equal(target.getAttribute('aria-invalid'), 'true');
    assert.equal(target.getAttribute('aria-describedby'), 'gate-error');
    assert.equal(document.getElementById('gate-error').hidden, false);
    assert.equal(password.value, clearsPassword ? '' : 'synthetic form value');
    assert.equal(values.size, 0, 'an invalid form never receives a session');
    assert.deepEqual(calls, [code === 'INVALID_CREDENTIALS' ? '/api/owner/session' : '/api/owner/claim']);
    accepted = true;
    username.value = 'fixture-owner';
    password.value = 'synthetic form value';
    await submit();
    assert.equal(await session, 'synthetic-session');
    assert.equal(target.getAttribute('aria-invalid'), null);
    assert.equal(dom.root.querySelector('.gate'), null);
  });
}
