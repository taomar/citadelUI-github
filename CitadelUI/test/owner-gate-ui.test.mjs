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
    const shell = dom.node();
    shell.className = 'shell';
    dom.root.append(shell);
    document.querySelector = (selector) => selector === '.shell' ? shell
      : { content: code === 'INVALID_CREDENTIALS' ? 'claimed' : 'unclaimed' };
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
    assert.equal(shell.inert, true, 'the framed gate prevents focus reaching the workspace');
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
    assert.equal(shell.inert, true);
    assert.equal(dom.root.querySelector('.gate-submit').getAttribute('aria-busy'), null);
    assert.deepEqual(calls, [code === 'INVALID_CREDENTIALS' ? '/api/owner/session' : '/api/owner/claim']);
    accepted = true;
    username.value = 'fixture-owner';
    password.value = 'synthetic form value';
    await submit();
    assert.equal(await session, 'synthetic-session');
    assert.equal(target.getAttribute('aria-invalid'), null);
    assert.equal(dom.root.querySelector('.gate'), null);
    assert.equal(shell.inert, false, 'the workspace becomes interactive only after acceptance');
  });
}

test('the framed owner form reuses controls and submits once while visibly busy', async (t) => {
  const dom = installDom();
  document.querySelector = (selector) => selector === '.shell' ? null : { content: 'unclaimed' };
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = { localStorage: { setItem() {} } };
  t.after(() => { globalThis.window = originalWindow; globalThis.fetch = originalFetch; });
  let accept;
  let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise((resolve) => { accept = resolve; }); };
  const session = requireOwnerSession();
  assert.ok(dom.root.querySelector('.gate-masthead').classList.contains('titleblock'));
  assert.ok(dom.root.querySelector('.gate-rail').classList.contains('rail-areas'));
  const username = document.getElementById('gate-username');
  const password = document.getElementById('gate-password');
  assert.ok(username.classList.contains('ctl'));
  assert.equal(password.type, 'password');
  assert.equal(password.autocomplete, 'new-password');
  assert.equal(document.activeElement, username);
  const submit = dom.root.querySelector('.gate-submit');
  assert.ok(submit.classList.contains('btn-primary'));
  const listener = dom.root.querySelector('form').listeners.get('submit')[0];
  const pending = listener({ preventDefault() {} });
  assert.equal(submit.disabled, true);
  assert.equal(submit.getAttribute('aria-busy'), 'true');
  assert.equal(submit.textContent, 'Creating\u2026');
  await listener({ preventDefault() {} });
  assert.equal(calls, 1);
  accept({ ok: true, json: async () => ({ sessionToken: 'synthetic-session' }) });
  await pending;
  assert.equal(await session, 'synthetic-session');
});

test('an unavailable owner keeps the frame locked and offers no credential form', () => {
  const dom = installDom();
  const shell = dom.node();
  document.querySelector = (selector) => selector === '.shell' ? shell : { content: 'unavailable' };
  requireOwnerSession();
  assert.equal(shell.inert, true);
  assert.equal(dom.root.querySelector('.area-title').textContent, 'Unavailable');
  assert.equal(dom.root.querySelector('input'), null);
  assert.equal(dom.root.querySelector('button'), null);
});
