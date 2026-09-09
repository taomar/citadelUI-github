import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { installDom, readText } from './_dom-stub.mjs';
import { publicSourceFixture } from './_local-source-fixture.mjs';
import { LocalDirectory } from './_local-directory-fixture.mjs';
import { DEFAULT_REPOSITORY_SOURCE } from '../shared/repository-source.mjs';

installDom();
const { openLocalSourceImport } = await import('../web/js/local-source-import.mjs');
const { createLocalSourceClient } = await import('../web/js/local-source-client.mjs');
const { scanProvider } = await import('../web/js/workspace-context.mjs');
const { WorkspaceRegistry } = await import('../web/js/registry.mjs');
const { closeDialog, showDialog } = await import('../web/js/dialog.mjs');
const { runAddWorkspace } = await import('../web/js/workspace-catalog.mjs');
const { RepositorySelection } = await import('../web/js/github-selection.mjs');

function nodes(node = document.getElementById('modal')) {
  return [node, ...node.children.flatMap((child) => nodes(child))];
}
function control(id) {
  const result = nodes().find((node) => node.id === id);
  assert(result, `Missing ${id}`);
  return result;
}
function button(label) {
  const result = nodes().find((node) => node.tagName === 'BUTTON' && readText(node) === label);
  assert(result, `Missing button: ${label}`);
  return result;
}
async function click(label) {
  const found = button(label);
  assert.equal(found.disabled, false, `${label} is disabled`);
  assert.equal(found.hidden, false, `${label} is hidden`);
  for (const handler of found.listeners.get('click') || []) await handler({ target: found });
}
function input(id, value) {
  const found = control(id);
  assert.equal(found.disabled, false);
  found.value = value;
  found.dispatch('input');
}
const drain = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, overrides = {}) {
  const fixture = publicSourceFixture();
  const parent = new LocalDirectory('empty-parent');
  const calls = [];
  const client = createLocalSourceClient((path, options = {}) => fixture.service.handle({
    req: { method: options.method || 'GET' }, url: new URL(path, 'http://fixture.invalid'),
    tail: path.split('/').filter(Boolean).slice(2),
    readBody: async () => JSON.parse(options.body),
  }));
  const options = {
    client, pollDelay: 0, scan: scanProvider,
    pickFolder: async () => { calls.push(['picker']); return parent; },
    attach: async (value) => { calls.push(['attach', value]); return { projectId: 'created-project', environment: { id: 'created-workspace' } }; },
    ...overrides,
  };
  t.after(async () => { fixture.service.shutdown(); await fixture.service.settled(); closeDialog(); });
  return { fixture, parent, calls, options, open: () => openLocalSourceImport(options) };
}

async function details() {
  input('local-import-project-label', 'Synthetic new project');
  input('local-import-environment', 'Local development');
  input('local-import-path', 'C:\\fixtures\\empty-parent');
  input('local-import-folder-name', 'Named Citadel project');
  await click('Choose empty parent folder');
  await click('Review local import');
}
function approve() {
  control('local-import-confirm').checked = true;
  control('local-import-confirm').dispatch('change');
}

test('local import UI: explicit source, pinned commit and destination confirmation precede copy and registration', async (t) => {
  const fixture = harness(t);
  const pending = fixture.open();
  assert.equal(control('local-import-source').value, DEFAULT_REPOSITORY_SOURCE);
  assert.match(readText(document.getElementById('modal')), /citadel-v1/);
  assert.doesNotMatch(readText(document.getElementById('modal')), /Writing to|Migration preview|Experimental/);
  assert.equal(fixture.calls.length, 0, 'source preparation must precede the native picker');
  await click('Prepare source and continue');
  assert.match(readText(document.getElementById('modal')), /Name the new local project/);
  await details();
  const text = readText(document.getElementById('modal'));
  assert(text.includes(fixture.fixture.github.sourceHead));
  assert(text.includes('citadel-v1'));
  assert(text.includes('Named Citadel project'));
  assert.doesNotMatch(text, /citadel-source-[0-9a-f-]{36}/);
  assert.equal(button('Import and open workspace').disabled, true);
  assert.equal(fixture.parent.children.size, 0);
  approve();
  await click('Import and open workspace');
  const result = await pending;
  assert.equal(result.environment.id, 'created-workspace');
  const registrations = fixture.calls.filter(([call]) => call === 'attach');
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0][1].projectLabel, 'Synthetic new project');
  assert.equal(registrations[0][1].localPath, 'C:\\fixtures\\empty-parent\\Named Citadel project');
  assert.equal(registrations[0][1].scan.compatibility, 'supported');
  assert.equal(fixture.fixture.service.operation, null, 'server cache is released before local copying');
});

test('local import UI: source/back navigation preserves labels and does not ask for a PAT', async (t) => {
  const fixture = harness(t);
  fixture.open();
  await click('Prepare source and continue');
  input('local-import-project-label', 'Retained label');
  input('local-import-environment', 'Retained environment');
  input('local-import-folder-name', 'My exact folder');
  await click('Back');
  assert.equal(button('Continue to destination').disabled, false);
  assert.doesNotMatch(readText(document.getElementById('modal')), /GitHub token field|Administration/);
  await click('Continue to destination');
  assert.equal(control('local-import-project-label').value, 'Retained label');
  assert.equal(control('local-import-environment').value, 'Retained environment');
  assert.equal(control('local-import-folder-name').value, 'My exact folder');
  await click('Back');
  await click('Change source');
  assert.equal(control('local-import-source').disabled, false);
  input('local-import-source', 'https://foreign.invalid/source');
  await click('Prepare source and continue');
  assert.match(readText(document.getElementById('modal')), /Use https:\/\/github.com/);
  assert.equal(fixture.parent.children.size, 0);
});

test('local import UI: cancelling a Settings import restores the existing Settings frame and unfinished fields', async (t) => {
  const field = document.createElement('input');
  field.id = 'unfinished-settings-field';
  field.value = 'Retained Settings value';
  showDialog('Projects and environments', field);
  const fixture = harness(t, { stack: true });
  const pending = fixture.open();
  await click('Prepare source and continue');
  input('local-import-folder-name', 'Cancelled named folder');
  await click('Cancel');
  assert.equal(await pending, null);
  assert.equal(document.getElementById('modal').open, true);
  assert.equal(control('unfinished-settings-field').value, 'Retained Settings value');
  assert.match(readText(document.getElementById('modal')), /Projects and environments/);
});

test('local import UI: the real Settings profile-draft store accepts the named-folder draft, and storage failures stay visible', async (t) => {
  const stored = new Map();
  let unavailable = false;
  const registry = new WorkspaceRegistry({
    dbName: 'local-source-ui-profile-draft', testMode: true, origin: 'http://fixture.invalid',
    storage: {
      getItem: (key) => stored.get(key) || null,
      setItem: (key, value) => { if (unavailable) throw new Error('Storage is full'); stored.set(key, value); },
      removeItem: (key) => stored.delete(key),
    },
  });
  const fixture = harness(t, {
    onDraft: ({ projectLabel, environmentLabel, localPath, folderName }) =>
      registry.saveProfileDraft('new-project', { projectLabel, environmentLabel, localPath, folderName }),
  });
  fixture.open();
  await click('Prepare source and continue');
  assert(control('local-import-project-label'), 'initial display must not be blocked by draft persistence');
  input('local-import-project-label', 'Settings project');
  input('local-import-folder-name', 'User named folder');
  assert.equal(registry.profileDraft('new-project').folderName, 'User named folder');
  assert.equal('projectId' in registry.profileDraft('new-project'), false);
  unavailable = true;
  input('local-import-folder-name', 'Kept after storage error');
  await click('Review local import');
  assert.match(readText(document.getElementById('modal')), /Could not retain the project form: Storage is full/);
  assert.equal(control('local-import-folder-name').value, 'Kept after storage error');
  assert.equal(fixture.parent.children.size, 0);
  unavailable = false;
  await click('Back');
  await click('Continue to destination');
  assert.equal(control('local-import-folder-name').value, 'Kept after storage error');
});

test('local import UI: an existing project keeps its real context and focuses the visible selector on return', async (t) => {
  const immediateFrame = globalThis.requestAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  t.after(() => { globalThis.requestAnimationFrame = immediateFrame; });
  const contexts = [];
  const fixture = harness(t, {
    projects: [{ id: 'existing-project', label: 'Existing project' }], projectId: 'existing-project',
    projectLabel: 'Unrelated new-project draft', onContext: (value) => contexts.push(value),
  });
  fixture.open();
  await click('Prepare source and continue');
  for (const frame of frames) frame();
  assert.equal(contexts.at(-1).projectLabel, 'Existing project');
  assert.equal(document.activeElement.id, 'local-import-project');
  assert.equal(control('local-import-folder-name').value, 'Existing project');
});

test('local import UI: invalid or conflicting child names stay editable and are never silently changed', async (t) => {
  const fixture = harness(t);
  fixture.open();
  await click('Prepare source and continue');
  input('local-import-project-label', 'Valid suggested name');
  assert.equal(control('local-import-folder-name').value, 'Valid suggested name');
  input('local-import-folder-name', 'NUL.txt');
  input('local-import-path', 'C:\\fixtures\\empty-parent');
  await click('Choose empty parent folder');
  await click('Review local import');
  assert.equal(control('local-import-folder-name').value, 'NUL.txt');
  assert.match(readText(document.getElementById('modal')), /Windows-safe project folder name/);
  input('local-import-project-label', 'Different project label');
  assert.equal(control('local-import-folder-name').value, 'NUL.txt', 'an edited name is never replaced by a suggestion');
  input('local-import-folder-name', 'Existing child');
  await click('Review local import');
  await fixture.parent.getDirectoryHandle('Existing child', { create: true });
  approve();
  await click('Import and open workspace');
  assert.match(readText(document.getElementById('modal')), /not empty/);
  assert.equal(fixture.calls.filter(([call]) => call === 'attach').length, 0);
  await click('Back');
  assert.equal(control('local-import-folder-name').value, 'Existing child');
});

test('local import UI: a cancelled picker and nonempty destination stay explicit without registering', async (t) => {
  let abort = true;
  const parent = new LocalDirectory();
  parent.put('.git/config', 'foreign');
  const fixture = harness(t, { pickFolder: async () => {
    if (abort) throw new DOMException('Picker cancelled', 'AbortError');
    return parent;
  } });
  const pending = fixture.open();
  await click('Prepare source and continue');
  await click('Choose empty parent folder');
  assert.match(readText(document.getElementById('modal')), /Folder selection cancelled/);
  abort = false;
  await click('Choose empty parent folder');
  assert.match(readText(document.getElementById('modal')), /not empty, including hidden files or .git/);
  assert.equal(fixture.calls.length, 0);
  await click('Cancel');
  assert.equal(await pending, null);
  assert.equal(parent.allFiles().length, 1);
});

test('local import UI: failed registration retains copy and exposes a non-writing retry; Escape cannot interrupt registration', async (t) => {
  let attempts = 0;
  const fixture = harness(t, {
    attach: async () => {
      attempts++;
      document.getElementById('modal').dispatch('keydown', { key: 'Escape' });
      assert.equal(document.getElementById('modal').open, true);
      if (attempts === 1) throw new Error('Registry unavailable; no workspace registered');
      return { environment: { id: 'retry-success' } };
    },
  });
  const pending = fixture.open();
  await click('Prepare source and continue');
  await details();
  approve();
  await click('Import and open workspace');
  assert.equal(document.getElementById('modal').open, true);
  assert.match(readText(document.getElementById('modal')), /Registry unavailable/);
  assert.equal(button('Keep folder and close').hidden, false);
  const writes = fixture.parent.owner.trace.filter((event) => event.operation === 'write').length;
  await click('Retry verified import');
  assert.equal((await pending).environment.id, 'retry-success');
  assert.equal(attempts, 2);
  assert.equal(fixture.parent.owner.trace.filter((event) => event.operation === 'write').length, writes);
});

test('local import UI: catalog entry reaches the same importer, independent of GitHub connections', async (t) => {
  const fixture = harness(t);
  let done;
  const result = new Promise((resolve) => { done = resolve; });
  const panel = runAddWorkspace({
    connections: [], vault: { available: false }, rows: [], onDone: done,
    actions: {
      projects: [],
      createSelection: () => new RepositorySelection({ listRepositories: async () => { throw new Error('GitHub must not be consulted'); } }),
      localSourceClient: fixture.options.client, pickFolder: fixture.options.pickFolder,
      scanLocalSource: scanProvider, attachLocalSource: fixture.options.attach,
    },
  });
  t.after(() => panel.dispose());
  const entry = nodes().find((node) => node.tagName === 'BUTTON' && readText(node).startsWith('Create local from Citadel source'));
  assert(entry);
  entry.click();
  await drain();
  assert.equal(control('local-import-source').value, DEFAULT_REPOSITORY_SOURCE);
  await click('Prepare source and continue');
  await details();
  approve();
  await click('Import and open workspace');
  assert.equal((await result).environment.id, 'created-workspace');
});

test('local import UI: catalog Cancel retains usable source choices after the queued native close event', async (t) => {
  const fixture = harness(t);
  const modal = document.getElementById('modal');
  const immediateClose = modal.close;
  modal.close = () => {
    if (!modal.open) return;
    modal.open = false;
    setImmediate(() => modal.dispatch('close'));
  };
  t.after(async () => { await drain(); modal.close = immediateClose; });
  let completions = 0;
  const panel = runAddWorkspace({
    connections: [], vault: { available: false }, rows: [], onDone: () => { completions++; },
    actions: {
      projects: [],
      createSelection: () => new RepositorySelection({ listRepositories: async () => { throw new Error('GitHub must not be consulted'); } }),
      localSourceClient: fixture.options.client, pickFolder: fixture.options.pickFolder,
      scanLocalSource: scanProvider, attachLocalSource: fixture.options.attach,
    },
  });
  t.after(() => panel.dispose());
  for (let attempt = 0; attempt < 2; attempt++) {
    const entry = nodes().find((node) => node.tagName === 'BUTTON' && readText(node).startsWith('Create local from Citadel source'));
    assert(entry);
    entry.click();
    assert.equal(control('local-import-source').value, DEFAULT_REPOSITORY_SOURCE);
    await click('Cancel');
    await drain();
    assert.equal(modal.open, true);
    assert.match(readText(modal), /Existing GitHub Repo/);
    assert(modal.contains(document.activeElement), 'the returned dialog must own keyboard focus');
    assert.equal(button('Cancel').disabled, false);
  }
  assert.deepEqual(fixture.fixture.calls, [], 'Cancel before preparation needs no source API call');
  assert.deepEqual(fixture.calls, [], 'no picker or registration is involved');
  assert.equal(completions, 0);
  await click('Cancel');
  await drain();
  assert.equal(modal.open, false);
});

test('local import UI: Settings New project wires the shared flow and removes current-GitHub context only for local setup', async () => {
  const app = await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
  const flow = app.slice(app.indexOf("'Creating project\\u2026'"), app.indexOf("}, 'New project')"));
  assert.match(flow, /kind === 'local-source'/);
  assert.match(flow, /openLocalSourceImport\(/);
  assert.match(flow, /attach: attachLocalSourceEnvironment/);
  assert.match(flow, /onDraft: \(\{ projectLabel, environmentLabel, localPath, folderName \}\)/);
  assert.match(flow, /folderName: draft.folderName/);
  assert.match(flow, /confirmPendingNavigation\(/);
  assert.match(flow, /context: kind === 'local'\s*\?/);
  assert.match(flow, /current workspace and GitHub repository are not changed/);
  assert.match(flow, /new BrowserDirectoryProvider\(handle\)/, 'existing folder attachment remains intact');
  assert.match(flow, /attachGitHubProject\(/, 'existing GitHub attachment remains intact');
});
