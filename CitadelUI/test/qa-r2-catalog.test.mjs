import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { installDom, readText } from './_dom-stub.mjs';
import { TEST_TOKEN } from './_github-mock.mjs';
import { RepositorySelection } from '../web/js/github-selection.mjs';

const dom = installDom();
const { presentWorkspaceCatalog, runAddWorkspace } = await import('../web/js/workspace-catalog.mjs');
const { closeDialog, dismissDialog, showDialog } = await import('../web/js/dialog.mjs');
const turn = () => new Promise((resolve) => setImmediate(resolve));
const all = (node, predicate) => [
  ...(predicate(node) ? [node] : []),
  ...node.children.flatMap((child) => all(child, predicate)),
];
const button = (root, label) => all(root, (node) => node.tagName === 'BUTTON' && readText(node) === label)[0];
const profile = { id: 'qa-session', name: 'Synthetic account', accountLogin: 'synthetic', status: 'session' };
let frames = [];

beforeEach(() => {
  closeDialog();
  dom.root.replaceChildren(dom.modal);
  document.activeElement = dom.root;
  frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  dom.modal.close = () => {
    dom.modal.open = false;
    setImmediate(() => dom.modal.dispatch('close'));
  };
});

function flushFrames() {
  for (const callback of frames.splice(0)) callback();
}

function connectionWizard(connections = []) {
  runAddWorkspace({
    connections, vault: { available: false }, rows: [], onDone() {},
    actions: {
      createSelection: () => new RepositorySelection({ listRepositories: async () => ({ repositories: [] }) }),
      createConnection: async () => ({ login: 'synthetic', accountId: 9001, profileId: profile.id, profile }),
      useConnection: async () => ({ login: 'synthetic', accountId: 9001, profileId: profile.id, profile }),
    },
  });
  all(dom.modal, (node) => node.tagName === 'BUTTON' && readText(node).startsWith('Existing GitHub Repo'))[0].click();
}

test('R2-07 connection introductions distinguish zero, one and multiple available profiles', () => {
  for (const connections of [[], [profile], [{ ...profile, status: 'persistent' }],
    [profile, { ...profile, id: 'second', name: 'Second account' }]]) {
    closeDialog();
    connectionWizard(connections);
    const text = readText(dom.modal);
    if (!connections.length) {
      assert.match(text, /No connection is saved yet/);
      assert(document.getElementById('catalog-connection-token'));
    } else {
      assert.doesNotMatch(text, /No connection is saved yet/);
      assert.match(text, /This connection already has a credential/);
      assert.equal(document.getElementById('catalog-connection-token'), null);
    }
  }
});

test('R2-07 a newly created session connection stays available on Bicep, native and new-repository reentry', async () => {
  connectionWizard();
  const name = document.getElementById('catalog-connection-name');
  name.value = profile.name;
  name.dispatch('input');
  document.getElementById('catalog-connection-token').value = TEST_TOKEN;
  button(dom.modal, 'Continue').click();
  await turn();
  button(dom.modal, 'Back').click();
  assert.match(readText(dom.modal), /This connection already has a credential/);
  assert.doesNotMatch(readText(dom.modal), /No connection is saved yet/);
  assert.equal(document.getElementById('catalog-connection-token'), null);
  button(dom.modal, 'Back').click();
  const format = all(dom.modal, (node) => node.getAttribute('aria-label') === 'Configuration format')[0];
  format.value = 'terraform';
  format.dispatch('change');
  all(dom.modal, (node) => node.tagName === 'BUTTON' && readText(node).startsWith('Existing GitHub Repo'))[0].click();
  assert.doesNotMatch(readText(dom.modal), /No connection is saved yet/);
  assert.match(readText(dom.modal), /This connection already has a credential/);
  button(dom.modal, 'Back').click();
  const bicep = all(dom.modal, (node) => node.getAttribute('aria-label') === 'Configuration format')[0];
  bicep.value = 'bicep';
  bicep.dispatch('change');
  all(dom.modal, (node) => node.tagName === 'BUTTON' && readText(node).startsWith('New GitHub Repo'))[0].click();
  assert.doesNotMatch(readText(dom.modal), /No connection is saved yet/);
  assert.match(readText(dom.modal), /Creating and populating a new private repository/);
  assert.equal(document.getElementById('catalog-connection-token'), null);
});

const environments = ['Native one', 'Bicep main', 'Native two', 'Bicep access', 'Bicep model'].map((label, index) => ({
  id: `qa-${index}`, projectId: 'qa-project', label, compatibility: 'supported', permission: 'granted',
  lastOpenedAt: '2026-09-10T00:00:00.000Z', lastScannedAt: '2026-09-10T00:00:00.000Z',
  source: { kind: 'local', folderName: `synthetic-${index}`, localPath: `C:\\synthetic\\qa-${index}` },
}));

async function catalog({ rows = environments, overrides = {} } = {}) {
  const container = dom.node('main');
  dom.root.append(container);
  presentWorkspaceCatalog({
    container,
    actions: {
      listProjects: async () => [{ id: 'qa-project', label: 'Synthetic Citadel' }],
      listEnvironments: async () => rows,
      listConnections: async () => ({ profiles: [], vault: { available: false } }),
      listActivity: async () => [],
      hasHandle: async () => true,
      createSelection: () => new RepositorySelection({ listRepositories: async () => ({ repositories: [] }) }),
      ...overrides,
    },
  });
  await turn();
  return container;
}

test('R2-08 catalog rows and count update together without replacing the active search field', async () => {
  const root = await catalog();
  const search = document.getElementById('catalog-search');
  search.focus();
  for (const [query, count] of [['Native', 2], ['no-match', 0], ['', 5]]) {
    search.value = query;
    search.setSelectionRange(query.length, query.length);
    search.dispatch('input');
    assert.match(readText(root), new RegExp(`${count} of 5`));
    assert.equal(document.getElementById('catalog-search'), search);
    assert.equal(document.activeElement, search);
    assert.equal(search.selectionStart, query.length);
    assert.equal(all(root, (node) => node.tagName === 'BUTTON' && readText(node) === 'Open').length, count);
  }
  const source = document.getElementById('catalog-source-filter');
  source.value = 'github';
  source.dispatch('change');
  assert.match(readText(root), /0 of 5/);
  source.value = 'all';
  source.dispatch('change');
  assert.match(readText(root), /5 of 5/);
});

for (const early of [true, false]) {
  for (const populated of [true, false]) {
    test(`R2-10 ${populated ? 'populated' : 'empty'} catalog restores its opener with ${early ? 'early' : 'late'} refresh`, async () => {
      let release;
      let delay = false;
      const rows = populated ? environments : [];
      const root = await catalog({ rows, overrides: {
        listEnvironments: () => delay ? new Promise((resolve) => { release = () => resolve(rows); }) : Promise.resolve(rows),
      } });
      const opener = button(root, populated ? 'Add workspace' : 'Add your first workspace');
      opener.focus();
      opener.click();
      flushFrames();
      delay = true;
      dom.modal.dispatch('keydown', { key: 'Escape' });
      if (early) { release(); await turn(); flushFrames(); }
      else { flushFrames(); release(); await turn(); }
      assert.equal(dom.modal.open, false);
      assert.equal(document.activeElement === button(root, populated ? 'Add workspace' : 'Add your first workspace'), true);
      assert.equal(document.activeElement.isConnected, true);
    });
  }
}

for (const successor of [false, true]) {
  test(`R2-10 a late catalog refresh does not steal focus from ${successor ? 'a successor modal' : 'a later user action'}`, async () => {
    let release;
    let delay = false;
    const root = await catalog({ overrides: {
      listEnvironments: () => delay ? new Promise((resolve) => { release = () => resolve(environments); }) : Promise.resolve(environments),
    } });
    const opener = button(root, 'Add workspace');
    opener.focus();
    opener.click();
    flushFrames();
    delay = true;
    dismissDialog(false);
    flushFrames();
    const next = dom.node('input');
    if (successor) showDialog('Next task', next, [], { initialFocus: next });
    else dom.root.append(next);
    flushFrames();
    next.focus();
    release();
    await turn();
    flushFrames();
    assert.equal(document.activeElement, next);
    assert.equal(dom.modal.open, successor);
  });
}
