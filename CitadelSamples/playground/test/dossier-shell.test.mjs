import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDossierUrlController } from '../web/js/urlState.mjs';

const SHELL = fileURLToPath(new URL('../web/js/render/shell.mjs', import.meta.url));
const DIRECTORY = fileURLToPath(new URL('../web/js/render/directory.mjs', import.meta.url));
const SHELL_CSS = fileURLToPath(new URL('../web/css/shell.css', import.meta.url));

function fakeWindow(initialHref) {
  const listeners = new Map();
  const location = { href: initialHref };
  const entries = [{ href: initialHref, state: null }];
  let cursor = 0;
  const absolute = (value) => new URL(value, location.href).href;
  const emit = (type, event = {}) => {
    event.type = type;
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const history = {
    get state() {
      return entries[cursor].state;
    },
    pushState(state, _title, href) {
      entries.splice(cursor + 1);
      entries.push({ href: absolute(href), state });
      cursor = entries.length - 1;
      location.href = entries[cursor].href;
    },
    replaceState(state, _title, href) {
      entries[cursor] = { href: absolute(href), state };
      location.href = entries[cursor].href;
    },
    go(delta) {
      const next = cursor + delta;
      if (next < 0 || next >= entries.length || next === cursor) return;
      const oldHash = new URL(location.href).hash;
      cursor = next;
      location.href = entries[cursor].href;
      emit('popstate', { state: entries[cursor].state });
      if (new URL(location.href).hash !== oldHash) emit('hashchange');
    },
  };
  return {
    location,
    history,
    confirm: () => true,
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? [];
      values.push(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((value) => value !== listener));
    },
    emit,
    entries,
    cursor: () => cursor,
  };
}

test('URL initialization fails closed and removes an unsafe run id', () => {
  const browser = fakeWindow(
    'https://example.test/playground?recipe=unknown&run=%3Csecret%3E&gatewayAccess.apiKey=discard#stage=source',
  );
  const changes = [];
  const controller = createDossierUrlController({
    windowRef: browser,
    validRecipeIds: ['prepare', 'publish'],
    defaultRecipeId: 'prepare',
    onStateChange: (state, detail) => changes.push({ state, detail }),
  });

  assert.deepEqual(controller.initialize(), {
    recipeId: 'prepare',
    stage: 'configure',
    runId: null,
  });
  assert.equal(
    browser.location.href,
    'https://example.test/playground?recipe=prepare#stage=configure',
  );
  assert.equal(changes[0].detail.source, 'initialize');
});

test('URL query preservation is explicit and still excludes undeclared state', () => {
  const browser = fakeWindow(
    'https://example.test/playground?recipe=prepare&testExecutor=1&gatewayAccess.apiKey=discard#stage=configure',
  );
  const controller = createDossierUrlController({
    windowRef: browser,
    validRecipeIds: ['prepare'],
    defaultRecipeId: 'prepare',
    preserveQueryParams: [
      'testExecutor',
      'gatewayAccess.apiKey',
      'refreshToken',
      'dbPassword',
    ],
  });
  controller.initialize();

  assert.equal(
    browser.location.href,
    'https://example.test/playground?recipe=prepare&testExecutor=1#stage=configure',
  );
});

test('a malformed applied URL falls back without throwing or retaining secret-shaped query state', () => {
  const browser = fakeWindow('https://example.test/playground?recipe=prepare#stage=configure');
  const controller = createDossierUrlController({
    windowRef: browser,
    validRecipeIds: ['prepare'],
    defaultRecipeId: 'prepare',
  });
  controller.initialize();

  assert.equal(controller.apply('http://[invalid', { prompt: false }), true);
  assert.deepEqual(controller.getState(), {
    recipeId: 'prepare',
    stage: 'configure',
    runId: null,
  });
  assert.equal(
    browser.location.href,
    'https://example.test/playground?recipe=prepare#stage=configure',
  );
});

test('URL push preserves safe state and browser back reapplies the prior state', () => {
  const browser = fakeWindow('https://example.test/playground?recipe=prepare#stage=configure');
  const changes = [];
  const controller = createDossierUrlController({
    windowRef: browser,
    validRecipeIds: ['prepare', 'publish'],
    defaultRecipeId: 'prepare',
    onStateChange: (state, detail) => changes.push({ state, source: detail.source }),
  });
  controller.initialize();

  assert.equal(controller.push({
    recipeId: 'publish',
    stage: 'review',
    runId: 'run-0001',
    apiKey: 'must-be-ignored',
  }), true);
  assert.equal(
    browser.location.href,
    'https://example.test/playground?recipe=publish&run=run-0001#stage=review',
  );
  assert.ok(!browser.location.href.includes('apiKey'));

  browser.history.go(-1);
  assert.deepEqual(controller.getState(), {
    recipeId: 'prepare',
    stage: 'configure',
    runId: null,
  });
  assert.equal(changes.at(-1).source, 'popstate');
});

test('unsaved ordinary inputs block push and restore a rejected browser traversal', () => {
  const browser = fakeWindow('https://example.test/playground?recipe=prepare#stage=configure');
  let dirty = false;
  let allow = true;
  let prompts = 0;
  const controller = createDossierUrlController({
    windowRef: browser,
    validRecipeIds: ['prepare', 'publish'],
    defaultRecipeId: 'prepare',
    hasUnsavedInputs: () => dirty,
    confirmNavigation: () => {
      prompts += 1;
      return allow;
    },
  });
  controller.initialize();
  controller.push({ recipeId: 'publish', stage: 'review', runId: null });

  dirty = true;
  allow = false;
  assert.equal(controller.push({ recipeId: 'prepare', stage: 'configure' }), false);
  assert.equal(browser.cursor(), 1);
  assert.equal(prompts, 1);

  browser.history.go(-1);
  assert.equal(browser.cursor(), 1);
  assert.deepEqual(controller.getState(), {
    recipeId: 'publish',
    stage: 'review',
    runId: null,
  });
  assert.equal(prompts, 2);
});

test('beforeunload warns only through the injected ordinary-input predicate', () => {
  const browser = fakeWindow('https://example.test/playground?recipe=prepare#stage=configure');
  let dirty = true;
  const controller = createDossierUrlController({
    windowRef: browser,
    validRecipeIds: ['prepare'],
    defaultRecipeId: 'prepare',
    hasUnsavedInputs: () => dirty,
  });
  controller.initialize();

  let prevented = false;
  const event = {
    returnValue: undefined,
    preventDefault() {
      prevented = true;
    },
  };
  browser.emit('beforeunload', event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');

  dirty = false;
  prevented = false;
  event.returnValue = undefined;
  browser.emit('beforeunload', event);
  assert.equal(prevented, false);
});

test('the renderer source enforces the dossier shell constraints', async () => {
  const [shell, directory, css] = await Promise.all([
    readFile(SHELL, 'utf8'),
    readFile(DIRECTORY, 'utf8'),
    readFile(SHELL_CSS, 'utf8'),
  ]);
  const source = `${shell}\n${directory}`;

  assert.match(shell, /DOSSIER_IDS\.masthead/);
  assert.match(shell, /DOSSIER_IDS\.globalIdentity/);
  assert.match(shell, /Ready to Attempt/);
  assert.match(shell, /Entra caller/);
  assert.match(shell, /Playground identity/);
  assert.match(shell, /Relay identity/);
  assert.match(shell, /Key Vault \/ key/);
  assert.match(shell, /Sign in with Microsoft/);
  assert.match(shell, /Switch Azure account/);
  assert.match(shell, /Account \/ subscription/);
  assert.match(shell, /text: 'Verify'/);
  assert.match(shell, /text: 'Set Active'/);
  assert.match(shell, /subscriptions\.find/);
  assert.match(shell, /\|\| !selectedId/);
  assert.match(shell, /Continue in terminal/);
  assert.match(shell, /Active subscription/);
  assert.match(shell, /Intended target/);
  assert.doesNotMatch(source, /device[- ]?code|verificationUrl|userCode/i);
  assert.doesNotMatch(source, /sha256|self-test/i);

  assert.match(directory, /data-recommended-next/);
  assert.match(directory, /data-readiness/);
  assert.match(directory, /data-dependencies/);
  assert.match(directory, /name: 'recipe-search'/);
  assert.match(directory, /autocomplete: 'off'/);
  assert.match(directory, /export function renderSampleSelect/);
  assert.doesNotMatch(shell, /renderSampleSelect/);

  assert.match(css, /min-height: 3rem/);
  assert.match(css, /--dossier-rail-width: 15rem/);
  assert.match(css, /@media \(min-width: 75rem\)/);
  assert.match(css, /@media \(max-width: 74\.999rem\)/);
  assert.match(css, /@media \(max-width: 47\.999rem\)/);
  assert.match(css, /font-family: var\(--mono/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient|backdrop-filter|text-transform:\s*uppercase/);
});
