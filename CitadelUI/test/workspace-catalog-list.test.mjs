import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { installDom, readText } from './_dom-stub.mjs';
import { RepositorySelection } from '../web/js/github-selection.mjs';
import { nativeConfiguration } from './_native-fixture.mjs';
import { h } from '../web/js/dom.mjs';
import { renderWorkspaceCatalogList } from '../web/js/workspace-catalog-list.mjs';

const dom = installDom();
const { presentWorkspaceCatalog, workspaceRow, WORKSPACE_STATUS, relativeTime } = await import('../web/js/workspace-catalog.mjs');
const { closeDialog, dismissDialog, showDialog } = await import('../web/js/dialog.mjs');
const turn = () => new Promise((resolve) => setImmediate(resolve));
let frames = [];
const flushFrames = () => { for (const callback of frames.splice(0)) callback(); };
const all = (node, predicate) => [
  ...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => all(child, predicate)),
];
const button = (root, label) => all(root, (node) => node.tagName === 'BUTTON' && readText(node) === label)[0];
const workspaceRows = (root) => all(root, (node) => node.classList.contains('catalog-row'));
const labels = (root) => workspaceRows(root).map((row) => readText(row.children[0].children[0]));
const count = (root) => all(root, (node) => node.classList.contains('catalog-result-count'))[0];
const addButton = (root) => button(root, 'Add workspace') || button(root, 'Add your first workspace');
const controls = () => ['catalog-search', 'catalog-source-filter', 'catalog-status-filter'].map((id) => document.getElementById(id));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

beforeEach(async () => {
  closeDialog();
  await turn();
  dom.root.replaceChildren(dom.modal);
  document.activeElement = dom.root;
  frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  dom.modal.close = () => {
    if (!dom.modal.open) return;
    dom.modal.open = false;
    setImmediate(() => dom.modal.dispatch('close'));
  };
});
afterEach(async () => {
  closeDialog();
  await turn();
  flushFrames();
});

function environments() {
  const local = { kind: 'local', folderName: 'alpha', localPath: 'C:\\synthetic\\alpha' };
  return [
    {
      id: 'alpha', projectId: 'project-a', label: 'Alpha local', source: local,
      permission: 'granted', compatibility: 'supported',
      lastScannedAt: '2026-09-12T12:00:00.000Z', lastOpenedAt: '2026-09-12T12:00:00.000Z',
    },
    {
      id: 'beta', projectId: 'project-b', label: 'Beta local',
      source: { ...local, folderName: 'beta', localPath: 'C:\\synthetic\\beta' },
      permission: 'granted', compatibility: 'supported', lastScannedAt: '2026-09-12T12:00:00.000Z',
      configuration: nativeConfiguration(['access']),
    },
    {
      id: 'gamma', projectId: 'project-a', label: 'Gamma GitHub', compatibility: 'supported', permission: 'granted',
      source: {
        kind: 'github', connectionProfileId: 'profile-one', repositoryId: 41, fullName: 'synthetic/repo',
        sourceBranch: 'release', workingBranch: 'pending/gamma', writeMode: 'working-branch',
        capabilities: ['LLM Onboarding', 'Access Contracts'], validatedAt: '2026-09-12T12:00:00.000Z',
      },
      lastOpenedAt: 'invalid-time',
    },
  ];
}

async function catalog({ rows = environments(), preferences = {}, hasHandle = async (id) => id !== 'beta' } = {}) {
  const calls = [], saved = [], contexts = [];
  const state = { rows, released: 0, settled: false };
  const profiles = [{ id: 'profile-one', name: 'Profile & Name', status: 'session', accountLogin: 'synthetic' }];
  const container = dom.node('main');
  dom.root.append(container);
  let changed;
  const actions = {
    listProjects: async () => [{ id: 'project-a', label: 'Project A' }, { id: 'project-b', label: 'Project B' }],
    listEnvironments: async () => {
      if (state.loadError) throw state.loadError;
      return state.load ? state.load() : state.rows;
    },
    listConnections: async () => ({ profiles, vault: { available: false } }),
    listActivity: async () => [],
    hasHandle,
    createSelection: () => new RepositorySelection({ listRepositories: async () => ({ repositories: [] }) }),
    openEnvironment: async (environment) => {
      calls.push({ action: 'open', environment });
      return state.open ? state.open(environment) : null;
    },
    reconnectEnvironment: async (environment, options) => {
      calls.push({ action: 'reconnect', environment, options });
      return state.reconnect ? state.reconnect(environment, options) : null;
    },
  };
  const completion = presentWorkspaceCatalog({
    container, actions, preferences,
    now: () => Date.parse('2026-09-12T12:02:00.000Z'),
    savePreferences: (value) => saved.push(value),
    onContext: (value) => contexts.push(value),
    sessions: { subscribe(callback) { changed = callback; return () => { state.released += 1; }; } },
  });
  completion.then(() => { state.settled = true; });
  await turn();
  return { container, state, profiles, calls, saved, contexts, completion, refresh: () => changed() };
}

test('V7 catalog list: table structure, row facts and action wrappers match incumbent rendering', async () => {
  const f = await catalog();
  const scroller = all(f.container, (node) => node.getAttribute('aria-label') === 'Saved workspaces table')[0];
  assert.equal(scroller.className, 'catalog-scroller');
  assert.equal(scroller.getAttribute('tabindex'), '0');
  assert.equal(scroller.getAttribute('role'), 'group');
  const table = scroller.children[0];
  assert.equal(table.className, 'otable catalog-table');
  const headings = table.children[0].children[0].children;
  assert.deepEqual(headings.map(readText), [
    'Workspace \u2191', 'Source', 'Repository or folder', 'Branch', 'Connection',
    'Capabilities', 'Status', 'Last opened', 'Actions',
  ]);
  assert(headings.every((node) => node.getAttribute('scope') === 'col'));
  assert.equal(headings.at(-1).children[0].className, 'sr-only');
  const rows = workspaceRows(f.container);
  assert.deepEqual(rows.map((row) => row.children.map(readText)), [
    ['Alpha localProject A \u00b7 Bicep', 'Local folder', 'alpha', '\u2014', '\u2014', '\u2014', 'Ready', '2 minutes ago', 'OpenActionsRenameDetach'],
    ['Beta localProject B \u00b7 Terraform (1 unit)', 'Local folder', 'beta', '\u2014', '\u2014', 'Access Contracts', 'Unavailable folder', 'Never', 'Review recoveryActionsRenameDetach'],
    ['Gamma GitHubProject A \u00b7 Bicep', 'GitHub', 'synthetic/repo', 'SourcereleaseWrites: pending/gamma', 'Profile & Name', 'LLM OnboardingAccess Contracts', 'Ready', 'Unknown', 'OpenActionsRenameDetach'],
  ]);
  for (const row of rows) {
    assert.deepEqual(row.children.map((cell) => cell.getAttribute('data-label')),
      ['Workspace', 'Source', 'Repository or folder', 'Branch', 'Connection', 'Capabilities', 'Status', 'Last opened', 'Actions']);
    assert.equal(row.children[8].children.length, 1);
    assert.equal(row.children[8].children[0].className, 'catalog-actions');
    assert.equal(row.children[1].children[0].children[0].getAttribute('aria-hidden'), 'true');
  }
  assert.deepEqual(f.calls, []);
});

test('V7 catalog list: frozen environment data survives repeated search, source and status projection', async () => {
  const input = freeze(environments()), snapshot = structuredClone(input);
  const f = await catalog({ rows: input });
  const search = controls()[0];
  for (const [query, expected] of [['pending/gamma', ['Gamma GitHub']], ['Terraform', ['Beta local']],
    ['Profile & Name', ['Gamma GitHub']], ['C:\\synthetic\\alpha', ['Alpha local']], ['', ['Alpha local', 'Beta local', 'Gamma GitHub']]]) {
    search.value = query;
    search.dispatch('input');
    assert.deepEqual(labels(f.container), expected);
  }
  assert.deepEqual(input, snapshot);
  assert.equal(f.state.settled, false);
  assert.deepEqual(f.calls, []);
});

test('V7 catalog list: list-only updates retain each selected filter, caret, count node and Add opener', async () => {
  const f = await catalog(), original = controls(), counter = count(f.container), opener = addButton(f.container);
  const [search, source, status] = original;
  search.focus();
  for (const [query, expected] of [['Alpha', '1 of 3'], ['no-match', '0 of 3'], ['', '3 of 3']]) {
    const start = Math.min(1, query.length);
    search.value = query;
    search.setSelectionRange(start, query.length, 'backward');
    search.dispatch('input');
    assert.deepEqual(controls(), original);
    assert.equal(document.activeElement, search);
    assert.deepEqual([search.selectionStart, search.selectionEnd, search.selectionDirection], [start, query.length, 'backward']);
    assert.equal(count(f.container), counter);
    assert.equal(readText(counter), expected);
    assert.equal(addButton(f.container), opener);
  }
  for (const [control, value, expected] of [[source, 'local', '2 of 3'], [status, 'missing', '1 of 3'], [source, 'github', '0 of 3']]) {
    control.focus();
    control.value = value;
    control.dispatch('change');
    assert.equal(document.activeElement, control);
    assert.equal(control.value, value);
    assert.deepEqual(controls(), original);
    assert.equal(readText(counter), expected);
    assert.equal(addButton(f.container), opener);
  }
  assert.equal(button(f.container, 'Clear filters').className, 'btn');
  assert.deepEqual(f.calls, []);
});

test('V7 catalog list: blur, focus, change and click keep their existing filter boundary', async () => {
  const f = await catalog(), [search, source] = controls(), events = [];
  for (const [node, prefix, names] of [[search, 'search', ['input', 'blur']], [source, 'source', ['focus', 'change', 'click']]]) {
    for (const name of names) node.addEventListener(name, () => events.push(`${prefix}:${name}`));
  }
  search.focus();
  search.value = 'Alpha';
  search.dispatch('input');
  dom.root.dispatch('mousedown', { target: source });
  search.dispatch('blur', { relatedTarget: source });
  source.focus();
  source.value = 'github';
  source.dispatch('change');
  source.click();
  assert.deepEqual(events, ['search:input', 'search:blur', 'source:focus', 'source:change', 'source:click']);
  assert.equal(controls()[0], search);
  assert.equal(controls()[1], source);
  assert.equal(document.activeElement, source);
  assert.equal(readText(count(f.container)), '0 of 3');
});

test('V7 catalog list: Clear filters preserves sort and activity while retaining incumbent full-render replacement', async () => {
  const f = await catalog({ preferences: { sort: 'label', direction: 'desc', activity: 'open' } });
  const original = controls(), opener = addButton(f.container);
  original[0].value = 'unmatched';
  original[0].dispatch('input');
  button(f.container, 'Clear filters').click();
  assert(controls().every((node, index) => node !== original[index]));
  assert.equal(addButton(f.container), opener);
  assert.deepEqual(f.saved.at(-1), { search: '', source: 'all', status: 'all', sort: 'label', direction: 'desc', activity: 'open' });
  assert.deepEqual(labels(f.container), ['Gamma GitHub', 'Beta local', 'Alpha local']);
  button(f.container, 'Source').click();
  assert.deepEqual(labels(f.container), ['Gamma GitHub', 'Alpha local', 'Beta local']);
  assert.equal(f.saved.at(-1).sort, 'source');
  button(f.container, 'Source \u2191').click();
  assert.deepEqual(labels(f.container), ['Beta local', 'Alpha local', 'Gamma GitHub']);
  assert.equal(f.saved.at(-1).direction, 'desc');
  assert.equal(button(f.container, 'Source \u2193').parentElement.getAttribute('aria-sort'), 'descending');
});

for (const action of ['open', 'reconnect']) {
  test(`V7 catalog list: ${action} keeps canonical row authority and rejects stale-button reentry while busy`, async () => {
    const records = environments();
    if (action === 'reconnect') records[1].permission = 'prompt';
    const f = await catalog({ rows: records, hasHandle: async () => true }), pending = deferred();
    f.state[action] = () => pending.promise;
    const selected = f.state.rows[action === 'open' ? 0 : 1];
    const row = workspaceRows(f.container)[action === 'open' ? 0 : 1];
    const invoke = button(row, action === 'open' ? 'Open' : 'Reconnect folder');
    invoke.click();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].environment, selected);
    if (action === 'reconnect') assert.equal(f.calls[0].options.connections, f.profiles);
    assert.equal(addButton(f.container).disabled, true);
    assert(all(f.container, (node) => node.tagName === 'BUTTON' && node.closest('.catalog-actions'))
      .every((control) => control.disabled));
    assert(all(f.container, (node) => node.tagName === 'SUMMARY' && node.id.endsWith('-actions'))
      .every((control) => control.getAttribute('aria-disabled') === 'true'));
    invoke.click();
    assert.equal(f.calls.length, 1);
    assert.equal(f.state.settled, false);
    const result = { environment: selected, marker: 'confirmed-owner-context' };
    pending.resolve(result);
    assert.equal(await f.completion, result);
    await turn();
    assert.equal(f.state.released, 1);
    assert.equal(addButton(f.container).disabled, false);
  });
}

for (const code of ['ATTACH_UNRESOLVED', 'LOCAL_IMPORT_REGISTRY_PENDING', 'RECOVERY_REQUIRED']) {
  test(`V7 catalog list: a thrown ${code} outcome is not completion or an automatic retry`, async () => {
    const f = await catalog();
    f.state.open = async () => { throw Object.assign(new Error(`Unconfirmed ${code}`), { code }); };
    button(workspaceRows(f.container)[0], 'Open').click();
    await turn();
    assert.equal(f.calls.length, 1);
    assert.equal(f.state.settled, false);
    assert.equal(f.state.released, 0);
    assert.match(readText(f.container), new RegExp(`Unconfirmed ${code}`));
    assert.equal(addButton(f.container).disabled, false);
    assert.deepEqual(labels(f.container), ['Alpha local', 'Beta local', 'Gamma GitHub']);
  });
}

for (const initiallyPopulated of [false, true]) {
  for (const subsequentlyPopulated of [false, true]) {
    test(`V7 catalog list: actual Add opener survives Escape refresh (${initiallyPopulated} to ${subsequentlyPopulated})`, async () => {
      const f = await catalog({ rows: initiallyPopulated ? environments() : [] });
      const opener = addButton(f.container), originalControls = controls();
      assert.equal(all(f.container, (node) => node === opener).length, 1);
      opener.focus();
      opener.click();
      flushFrames();
      assert.equal(dom.modal.open, true);
      assert.match(readText(dom.modal), /Add workspace/);
      f.state.rows = subsequentlyPopulated ? environments() : [];
      dom.modal.dispatch('keydown', { key: 'Escape' });
      await turn();
      flushFrames();
      assert.equal(dom.modal.open, false);
      assert.equal(addButton(f.container), opener);
      assert.equal(opener.isConnected, true);
      assert.equal(document.activeElement, opener);
      assert.equal(readText(opener), subsequentlyPopulated ? 'Add workspace' : 'Add your first workspace');
      assert.equal(readText(count(f.container)), subsequentlyPopulated ? '3 of 3' : '0 of 0');
      if (initiallyPopulated && subsequentlyPopulated) assert(controls().every((node, index) => node !== originalControls[index]));
      assert.deepEqual(f.calls, []);
    });
  }
}

test('V7 catalog list: queued close and delayed catalog refresh preserve a successor frame and its field', async () => {
  const f = await catalog(), pending = deferred(), opener = addButton(f.container);
  opener.focus();
  opener.click();
  flushFrames();
  f.state.load = () => pending.promise;
  dismissDialog(false);
  const successor = dom.node('input');
  successor.value = 'Independent unfinished input';
  showDialog('Successor task', successor, [], { initialFocus: successor });
  flushFrames();
  pending.resolve(f.state.rows);
  await turn();
  flushFrames();
  assert.equal(dom.modal.open, true);
  assert.match(readText(dom.modal), /Successor task/);
  assert.equal(document.activeElement, successor);
  assert.equal(successor.value, 'Independent unfinished input');
  assert.equal(addButton(f.container), opener);
  assert.equal(opener.isConnected, true);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.settled, false);
});

test('V7 catalog list: failed refresh retains known rows and its actual opener without fabricating an open', async () => {
  const f = await catalog(), opener = addButton(f.container);
  f.state.loadError = new Error('Synthetic catalog read failure');
  f.refresh();
  await turn();
  assert.match(readText(f.container), /The catalogue could not be loaded: Synthetic catalog read failure/);
  assert.equal(addButton(f.container), opener);
  assert.deepEqual(labels(f.container), ['Alpha local', 'Beta local', 'Gamma GitHub']);
  assert.equal(readText(count(f.container)), '3 of 3');
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.settled, false);
});

function leafPorts(overrides = {}) {
  return {
    renderSortButton: (_key, label) => h('button', {}, label),
    renderSourceBadge: (kind) => h('span', {}, kind),
    renderChip: (label, variant) => h('span', { class: `chip ${variant}` }, label),
    renderStatus: (status) => h('span', {}, WORKSPACE_STATUS[status].label),
    formatTime: (value) => relativeTime(value, Date.parse('2026-09-12T12:02:00.000Z')),
    renderRowActions: () => [],
    onClearFilters: () => {},
    ...overrides,
  };
}

test('V7 catalog list composition: supplied row order and exact action nodes remain caller-owned', () => {
  const rows = freeze(environments().reverse().map((environment) => workspaceRow(environment)));
  const before = structuredClone(rows), sorts = [], rendered = [], acted = [], times = [];
  const actionNodes = rows.map((row) => h('button', { onclick: () => acted.push(row) }, 'Owner action'));
  const list = renderWorkspaceCatalogList({
    rows, hasWorkspaces: true,
    ...leafPorts({
      renderSortButton: (key, label) => { sorts.push([key, label]); return h('button', {}, label); },
      renderRowActions: (row) => { rendered.push(row); return [actionNodes[rows.indexOf(row)]]; },
      formatTime: (value) => { times.push(value); return 'Owner-formatted time'; },
    }),
  });
  assert.deepEqual(labels(list), ['Gamma GitHub', 'Beta local', 'Alpha local']);
  assert.deepEqual(sorts, [['label', 'Workspace'], ['source', 'Source'], ['status', 'Status'], ['opened', 'Last opened']]);
  assert.deepEqual(times, rows.map((row) => row.lastOpenedAt));
  assert(rendered.every((row, index) => row === rows[index]));
  assert.deepEqual(acted, []);
  workspaceRows(list).forEach((row, index) => {
    assert.equal(row.children[8].children[0].children[0], actionNodes[index]);
    actionNodes[index].click();
    assert.equal(acted[index], rows[index]);
  });
  assert.deepEqual(rows, before);
});

test('V7 catalog list composition: the empty view moves the real Add node without changing its state or listeners', () => {
  const calls = [];
  const opener = h('button', { class: 'owner-add', disabled: true, onclick: () => calls.push('add') }, 'Owner label');
  dom.root.append(opener);
  const first = renderWorkspaceCatalogList({ rows: [], hasWorkspaces: false, addWorkspaceButton: opener });
  assert.equal(first.className, 'catalog-empty');
  assert.match(readText(first), /No workspaces yet\./);
  assert.match(readText(first), /one Citadel repository \u2014 a local folder/);
  assert.equal(first.children.at(-1), opener);
  assert.equal(opener.disabled, true);
  assert.equal(opener.className, 'owner-add');
  assert.equal(readText(opener), 'Owner label');
  opener.click();
  assert.deepEqual(calls, []);
  const second = renderWorkspaceCatalogList({ rows: [], hasWorkspaces: false, addWorkspaceButton: opener });
  assert.equal(first.contains(opener), false);
  assert.equal(second.children.at(-1), opener);
  assert.equal(opener.listeners.get('click').length, 1);
  opener.disabled = false;
  opener.click();
  assert.deepEqual(calls, ['add']);
});

test('V7 catalog list composition: filtered-empty rendering only exposes the supplied clear callback', () => {
  const opener = h('button', {}, 'Owner Add'), calls = [];
  dom.root.append(opener);
  const list = renderWorkspaceCatalogList({
    rows: [], hasWorkspaces: true, addWorkspaceButton: opener,
    onClearFilters: () => calls.push('clear'),
  });
  assert.equal(list.className, 'catalog-empty');
  assert.equal(readText(list), 'No workspace matches this search.Clear filters');
  assert.equal(list.contains(opener), false);
  assert.equal(opener.parentElement, dom.root);
  assert.deepEqual(calls, []);
  const clear = button(list, 'Clear filters');
  assert.equal(clear.className, 'btn');
  assert.equal(clear.type, 'button');
  clear.click();
  assert.deepEqual(calls, ['clear']);
});

test('V7 catalog list composition: missing facts and literal text preserve the incumbent cell fallbacks', () => {
  const row = freeze({
    ...workspaceRow(environments()[2]), label: '<literal & name>', projectLabel: '', formatLabel: '',
    location: '', branch: null, capabilities: [],
  });
  const list = renderWorkspaceCatalogList({ rows: [row], hasWorkspaces: true, ...leafPorts() });
  const cells = workspaceRows(list)[0].children;
  assert.equal(readText(cells[0]), '<literal & name>');
  assert.equal(cells[0].children[0].tagName, 'SPAN');
  assert.equal(all(list, (node) => node.tagName === 'SCRIPT').length, 0);
  assert.equal(readText(cells[2]), 'Not recorded');
  assert.equal(readText(cells[3]), '\u2014');
  assert.equal(readText(cells[4]), 'Not connected');
  assert.equal(cells[4].children[0].className, 'hint');
  assert.equal(readText(cells[5]), '\u2014');
  assert.equal(readText(cells[6]), 'Missing');
});

test('V7 catalog list composition: renderer errors propagate without mutating models or inventing fallback state', () => {
  const rows = freeze([workspaceRow(environments()[0])]), before = structuredClone(rows);
  const failure = new Error('Owner rendering failed');
  assert.throws(() => renderWorkspaceCatalogList({
    rows, hasWorkspaces: true,
    ...leafPorts({ renderRowActions: () => { throw failure; } }),
  }), (error) => error === failure);
  assert.deepEqual(rows, before);
});
