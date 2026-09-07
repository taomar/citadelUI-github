/**
 * The landing catalogue: what it shows, what it refuses to show, and the
 * onboarding rule that a returning user never meets the attach form again.
 *
 * The status and filter rules are pure functions and are tested as such. The
 * rest is tested through the real DOM stub and through the stylesheet, because
 * the claims being made — a returning user sees their list first, the table
 * survives a phone width, every control has a name — are claims about what is
 * rendered, not about what a function returns.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { installDom, readText } from './_dom-stub.mjs';
import { TEST_TOKEN } from './_github-mock.mjs';
import { RepositorySelection } from '../web/js/github-selection.mjs';

installDom();

const {
  WORKSPACE_STATUS,
  filterWorkspaces,
  presentWorkspaceCatalog,
  relativeTime,
  runAddWorkspace,
  workspaceRow,
  workspaceStatus,
} = await import('../web/js/workspace-catalog.mjs');
const { RESUME_STAGES } = await import('../web/js/stage-progress.mjs');
const { closeDialog } = await import('../web/js/dialog.mjs');

const styles = readFileSync(new URL('../web/css/components.css', import.meta.url), 'utf8');
const catalogSource = readFileSync(new URL('../web/js/workspace-catalog.mjs', import.meta.url), 'utf8');
const contextSource = readFileSync(new URL('../web/js/workspace-context.mjs', import.meta.url), 'utf8');

function githubEnvironment(overrides = {}) {
  const { source: sourceOverrides, ...rest } = overrides;
  return {
    id: 'env-github',
    projectId: 'project-one',
    label: 'QA on GitHub',
    compatibility: 'supported',
    permission: 'granted',
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    lastScannedAt: '2026-01-01T00:00:00.000Z',
    ...rest,
    // Merged last and deliberately after the rest, so an override that names one
    // source field does not silently replace the whole union — which would make
    // a GitHub fixture stop being a GitHub fixture.
    source: {
      kind: 'github',
      connectionProfileId: 'profile-a',
      repositoryId: 9001,
      fullName: 'taomar/citadelQA',
      sourceBranch: 'main',
      workingBranch: 'citadel-ui/env-github',
      writeMode: 'working-branch',
      lastKnownHead: 'a'.repeat(40),
      capabilities: ['Main deployment'],
      validatedAt: '2026-01-01T00:00:00.000Z',
      ...(sourceOverrides || {}),
    },
  };
}

function localEnvironment(overrides = {}) {
  const { source: sourceOverrides, ...rest } = overrides;
  return {
    id: 'env-local',
    projectId: 'project-one',
    label: 'Local dev',
    compatibility: 'supported',
    permission: 'granted',
    lastOpenedAt: '2026-01-02T00:00:00.000Z',
    lastScannedAt: '2026-01-02T00:00:00.000Z',
    ...rest,
    source: {
      kind: 'local',
      folderName: 'citadel',
      localPath: 'C:\\source\\citadel',
      ...(sourceOverrides || {}),
    },
  };
}

const live = { id: 'profile-a', name: 'Work account', accountLogin: 'octo-dev', status: 'session' };
const idle = { ...live, status: 'persistent-idle' };
const dead = { ...live, status: 'reconnect' };

// ------------------------------------------------------------- status word --

test('a GitHub workspace is Ready only when its connection can actually be used', () => {
  const environment = githubEnvironment();
  assert.equal(workspaceStatus(environment, { connections: [live] }), 'ready');
  // Saved-but-idle is Ready too: the server restores it without asking.
  assert.equal(workspaceStatus(environment, { connections: [idle] }), 'ready');
  assert.equal(workspaceStatus(environment, { connections: [dead] }), 'reconnect');
  assert.equal(
    workspaceStatus(environment, { connections: [{ ...live, status: 'unavailable' }] }),
    'reconnect'
  );
  // The connection was removed. The workspace stays, and says what is missing.
  assert.equal(workspaceStatus(environment, { connections: [] }), 'missing');
  // A v3 record has no recorded account identity and is never guessed at.
  assert.equal(
    workspaceStatus(githubEnvironment({ source: { connectionProfileId: null } }), {
      connections: [live],
    }),
    'reconnect'
  );
  // Attached but never validated.
  assert.equal(
    workspaceStatus(githubEnvironment({ source: { validatedAt: null } }), { connections: [live] }),
    'stale'
  );
  assert.equal(
    workspaceStatus(githubEnvironment({ compatibility: 'invalid-citadel-root' }), {
      connections: [live],
    }),
    'incompatible'
  );
});

test('a local workspace is Missing when its folder handle is gone', () => {
  assert.equal(workspaceStatus(localEnvironment(), { hasHandle: true }), 'ready');
  assert.equal(workspaceStatus(localEnvironment(), { hasHandle: false }), 'missing');
  assert.equal(
    workspaceStatus(localEnvironment({ permission: 'reconnect-required' }), { hasHandle: true }),
    'reconnect'
  );
  assert.equal(
    workspaceStatus(localEnvironment({ lastScannedAt: null }), { hasHandle: true }),
    'stale'
  );
  assert.equal(
    workspaceStatus(localEnvironment({ compatibility: 'unavailable' }), { hasHandle: true }),
    'incompatible'
  );
});

test('every status has a word and a chip, and none of them is two words of hedging', () => {
  assert.deepEqual(Object.keys(WORKSPACE_STATUS).sort(), [
    'incompatible',
    'missing',
    'ready',
    'reconnect',
    'stale',
  ]);
  for (const [key, meta] of Object.entries(WORKSPACE_STATUS)) {
    assert.match(meta.label, /^[A-Z][a-z]+$/, key);
    assert.match(meta.chip, /^chip-/, key);
  }
});

// ------------------------------------------------------------------ a row ---

test('a row carries the seven facts the table compares, and no credential', () => {
  const row = workspaceRow(githubEnvironment(), {
    project: { id: 'project-one', label: 'Citadel' },
    connections: [live],
  });
  assert.equal(row.label, 'QA on GitHub');
  assert.equal(row.projectLabel, 'Citadel');
  assert.equal(row.kind, 'github');
  assert.equal(row.location, 'taomar/citadelQA');
  assert.equal(row.branch, 'main');
  assert.equal(row.workingBranch, 'citadel-ui/env-github');
  assert.equal(row.connectionName, 'Work account');
  assert.deepEqual(row.capabilities, ['Main deployment']);
  assert.equal(row.status, 'ready');
  assert.equal(JSON.stringify(row).includes('github_pat_'), false);

  const orphan = workspaceRow(githubEnvironment(), { connections: [] });
  assert.equal(orphan.connection, null);
  assert.equal(orphan.connectionName, 'Not connected');
});

// ------------------------------------------------------ search and filter ---

test('search matches every identifying fact, and filters compose', () => {
  const rows = [
    workspaceRow(githubEnvironment(), {
      project: { id: 'project-one', label: 'Citadel' },
      connections: [live],
    }),
    workspaceRow(localEnvironment(), {
      project: { id: 'project-one', label: 'Citadel' },
      hasHandle: true,
    }),
    workspaceRow(
      githubEnvironment({
        id: 'env-release',
        label: 'Release',
        source: { sourceBranch: 'release', workingBranch: 'citadel-ui/env-release' },
      }),
      { project: { id: 'project-one', label: 'Citadel' }, connections: [dead] }
    ),
  ];

  assert.deepEqual(
    filterWorkspaces(rows, { search: 'citadelQA' }).map((row) => row.label),
    ['QA on GitHub', 'Release']
  );
  assert.deepEqual(
    filterWorkspaces(rows, { search: 'release' }).map((row) => row.label),
    ['Release']
  );
  assert.deepEqual(
    filterWorkspaces(rows, { search: 'Work account' }).map((row) => row.label),
    ['QA on GitHub', 'Release']
  );
  assert.deepEqual(
    filterWorkspaces(rows, { search: 'C:\\source' }).map((row) => row.label),
    ['Local dev']
  );
  assert.deepEqual(filterWorkspaces(rows, { source: 'local' }).map((row) => row.label), ['Local dev']);
  assert.deepEqual(filterWorkspaces(rows, { status: 'reconnect' }).map((row) => row.label), ['Release']);
  assert.deepEqual(filterWorkspaces(rows, { source: 'local', status: 'reconnect' }), []);
  assert.deepEqual(filterWorkspaces(rows, { search: 'nothing here at all' }), []);
});

test('sorting is stable and reverses', () => {
  const rows = [
    workspaceRow(localEnvironment(), { hasHandle: true }),
    workspaceRow(githubEnvironment(), { connections: [live] }),
  ];
  assert.deepEqual(filterWorkspaces(rows, { sort: 'label' }).map((row) => row.label), [
    'Local dev',
    'QA on GitHub',
  ]);
  assert.deepEqual(
    filterWorkspaces(rows, { sort: 'label', direction: 'desc' }).map((row) => row.label),
    ['QA on GitHub', 'Local dev']
  );
  assert.deepEqual(filterWorkspaces(rows, { sort: 'source' }).map((row) => row.kind), [
    'github',
    'local',
  ]);
  assert.deepEqual(
    filterWorkspaces(rows, { sort: 'opened', direction: 'desc' }).map((row) => row.label),
    ['Local dev', 'QA on GitHub']
  );
});

test('relative time is honest at every distance', () => {
  const now = Date.parse('2026-03-01T12:00:00.000Z');
  assert.equal(relativeTime(null, now), 'Never');
  assert.equal(relativeTime('not a date', now), 'Unknown');
  assert.equal(relativeTime('2026-03-01T11:59:40.000Z', now), 'Just now');
  assert.equal(relativeTime('2026-03-01T11:30:00.000Z', now), '30 minutes ago');
  assert.equal(relativeTime('2026-03-01T09:00:00.000Z', now), '3 hours ago');
  assert.equal(relativeTime('2026-02-27T12:00:00.000Z', now), '2 days ago');
  // Past a week the relative form stops helping and an absolute date is used.
  assert.match(relativeTime('2025-11-01T12:00:00.000Z', now), /2025/);
});

// ---------------------------------------------------------- what it paints --

function stubActions(overrides = {}) {
  return {
    projects: [{ id: 'project-one', label: 'Citadel' }],
    listProjects: async () => [{ id: 'project-one', label: 'Citadel' }],
    listEnvironments: async () => [githubEnvironment(), localEnvironment()],
    hasHandle: async () => ({ kind: 'directory', name: 'citadel' }),
    listConnections: async () => ({ vault: { available: true, reason: 'ready' }, profiles: [live] }),
    listActivity: async () => [
      {
        id: 'e1',
        at: '2026-03-01T11:59:00.000Z',
        origin: 'server',
        action: 'connection.create',
        outcome: 'ok',
        reason: null,
        target: 'Work account',
        account: 'octo-dev',
      },
    ],
    createSelection: () => ({}),
    projectName: () => 'Citadel',
    ...overrides,
  };
}

async function paint(overrides = {}) {
  const container = document.createElement('main');
  const contexts = [];
  presentWorkspaceCatalog({
    container,
    actions: stubActions(overrides),
    onContext: (context) => contexts.push(context),
    now: () => Date.parse('2026-03-01T12:00:00.000Z'),
  });
  // Two microtask drains: the initial paint, then the refresh that follows it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { container, text: readText(container), contexts };
}

test('a returning user sees their saved workspaces, not an attach form', async () => {
  const { text } = await paint();
  assert.match(text, /Citadel workspaces/);
  assert.match(text, /Saved workspaces/);
  assert.match(text, /QA on GitHub/);
  assert.match(text, /Local dev/);
  assert.match(text, /taomar\/citadelQA/);
  assert.match(text, /Work account/);
  // The one creation affordance is a button, not a permanently open form.
  assert.match(text, /Add workspace/);
  assert.doesNotMatch(text, /Paste a GitHub fine-grained/);
  assert.doesNotMatch(text, /github_pat_/);
  assert.doesNotMatch(text, /Choose Citadel folder/);
});

test('both source badges carry text, not only a mark', async () => {
  const { text } = await paint();
  assert.match(text, /GitHub/);
  assert.match(text, /Local folder/);
  assert.match(catalogSource, /catalog-source-mark[^)]*'aria-hidden': 'true'/s);
});

test('every status word the table can show is spelled out', async () => {
  const { text } = await paint({
    listEnvironments: async () => [
      githubEnvironment(),
      githubEnvironment({ id: 'a', label: 'A', source: { connectionProfileId: 'gone' } }),
      githubEnvironment({ id: 'b', label: 'B', source: { validatedAt: null } }),
      githubEnvironment({ id: 'c', label: 'C', compatibility: 'invalid-citadel-root' }),
      localEnvironment({ id: 'd', label: 'D', permission: 'reconnect-required' }),
    ],
  });
  for (const meta of Object.values(WORKSPACE_STATUS)) {
    assert.match(text, new RegExp(meta.label), meta.label);
  }
});

test('the connections section names its account, status and attached workspaces', async () => {
  const { text } = await paint();
  assert.match(text, /GitHub connections/);
  assert.match(text, /@octo-dev/);
  assert.match(text, /Session only/);
  assert.match(text, /Persist this connection on this device \(encrypted\)/);
  // A connected profile exposes what it actually reaches.
  assert.match(text, /taomar\/citadelQA @ main/);
});

test('with no key mounted the persistence promise is not made', async () => {
  const { text } = await paint({
    listConnections: async () => ({
      vault: { available: false, reason: 'no-key-file' },
      profiles: [live],
    }),
  });
  assert.match(text, /No credential key is mounted, so connections last for this session only\./);
});

test('an empty catalogue teaches instead of showing a blank sheet', async () => {
  const { text } = await paint({
    listEnvironments: async () => [],
    listConnections: async () => ({ vault: { available: true, reason: 'ready' }, profiles: [] }),
    listActivity: async () => [],
  });
  assert.match(text, /No workspaces yet\./);
  assert.match(text, /A workspace is one Citadel repository/);
  assert.match(text, /Add your first workspace/);
  assert.match(text, /No GitHub connections yet\./);
  assert.match(text, /Nothing is recorded yet\./);
  // With nothing to search, the search box is not offered.
  assert.doesNotMatch(text, /Search workspaces/);
});

test('a load failure is reported rather than left as an empty list', async () => {
  const { text } = await paint({
    listEnvironments: async () => {
      throw new Error('IndexedDB is unavailable in this browser.');
    },
  });
  assert.match(text, /The catalogue could not be loaded: IndexedDB is unavailable/);
});

test('the masthead is told what the landing screen is', async () => {
  const { contexts } = await paint();
  const last = contexts.at(-1);
  assert.equal(last.projectLabel, 'Citadel');
  assert.equal(last.environmentLabel, 'Workspaces');
  assert.equal(last.account, 'octo-dev');
  assert.equal(last.sourceKind, 'github');
});

test('recent activity reads as a sentence, with time, action and target', async () => {
  const { text } = await paint();
  assert.match(text, /Recent activity/);
  assert.match(text, /Connection created/);
  assert.match(text, /Work account/);
  assert.match(text, /@octo-dev/);
});

// ------------------------------------------------------------ the stepper --

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

function connectionControl(id) {
  const controls = descendants(document.getElementById('modal'))
    .filter((node) => node.getAttribute('id') === id);
  assert.equal(controls.length, 1, `${id} must occur exactly once in the displayed dialog`);
  return controls[0];
}

async function clickDialogButton(label) {
  const button = descendants(document.getElementById('modal'))
    .find((node) => node.tagName === 'BUTTON' && readText(node) === label);
  assert.ok(button, `${label} must be in the displayed dialog`);
  assert.equal(button.disabled, false);
  for (const handler of button.listeners.get('click') || []) {
    await handler({ target: button });
  }
}

async function openConnectionStep(t, { connections = [], available = false, actions = {} } = {}) {
  t.after(() => closeDialog());
  runAddWorkspace({
    connections,
    vault: { available },
    rows: [],
    onDone: () => {},
    actions: {
      createSelection: () => new RepositorySelection({
        listRepositories: async () => ({ repositories: [] }),
      }),
      ...actions,
    },
  });
  const choice = descendants(document.getElementById('modal'))
    .find((node) => node.tagName === 'BUTTON' && readText(node).startsWith('GitHub repository'));
  assert.ok(choice);
  choice.click();
}

for (const available of [false, true]) {
  test(`new GitHub token input stays in the displayed form with persistence ${available}`, async (t) => {
    const submitted = [];
    await openConnectionStep(t, {
      available,
      actions: {
        createConnection: async (value) => {
          submitted.push(value);
          assert.equal(connectionControl('catalog-connection-token').value, '');
          return { login: 'octo-dev', profileId: 'profile-a' };
        },
      },
    });
    const name = connectionControl('catalog-connection-name');
    const token = connectionControl('catalog-connection-token');
    const persist = connectionControl('catalog-connection-persist');
    assert.equal(token.disabled, true, 'a new connection still needs a name first');
    name.value = '   ';
    name.dispatch('input');
    assert.equal(token.disabled, true);
    name.value = 'Work account';
    name.dispatch('input');
    assert.equal(token.disabled, false);
    assert.equal(token.parentElement.getAttribute('for'), 'catalog-connection-token');
    assert.equal(persist.disabled, !available);
    persist.checked = available;
    token.value = TEST_TOKEN;
    await clickDialogButton('Continue');
    assert.deepEqual(submitted, [{ name: 'Work account', token: TEST_TOKEN, persist: available }]);
    assert.equal(token.value, '');
    assert.match(readText(document.getElementById('modal')), /Choose a repository/);
  });
}

test('a rejected GitHub token leaves a visible empty input for retry', async (t) => {
  let attempts = 0;
  await openConnectionStep(t, {
    actions: {
      createConnection: async () => {
        if (++attempts === 1) throw new Error('The GitHub token was rejected.');
        return { login: 'octo-dev', profileId: 'profile-a' };
      },
    },
  });
  const name = connectionControl('catalog-connection-name');
  name.value = 'Work account';
  name.dispatch('input');
  const token = connectionControl('catalog-connection-token');
  token.value = TEST_TOKEN;
  await clickDialogButton('Continue');
  assert.equal(connectionControl('catalog-connection-token'), token);
  assert.equal(token.value, '');
  assert.equal(token.disabled, false);
  assert.match(readText(document.getElementById('modal')), /The GitHub token was rejected/);
  token.value = TEST_TOKEN;
  await clickDialogButton('Continue');
  assert.equal(attempts, 2);
  assert.match(readText(document.getElementById('modal')), /Choose a repository/);
});

test('a reconnecting GitHub token stays in its existing connection form', async (t) => {
  const submitted = [];
  await openConnectionStep(t, {
    connections: [dead],
    actions: {
      reconnectConnection: async (id, value) => {
        submitted.push({ id, ...value });
        return { login: dead.accountLogin, profileId: id };
      },
    },
  });
  assert.equal(descendants(document.getElementById('modal'))
    .some((node) => node.getAttribute('id') === 'catalog-connection-name'), false);
  const token = connectionControl('catalog-connection-token');
  assert.equal(token.disabled, false);
  token.value = TEST_TOKEN;
  await clickDialogButton('Reconnect and continue');
  assert.deepEqual(submitted, [{ id: dead.id, token: TEST_TOKEN, persist: undefined }]);
  assert.equal(token.value, '');
  assert.match(readText(document.getElementById('modal')), /Choose a repository/);
});

for (const profile of [live, idle]) {
  test(`a ${profile.status} GitHub connection needs no token input`, async (t) => {
    const used = [];
    const use = async (id) => {
      used.push(id);
      return { login: profile.accountLogin, profileId: id };
    };
    await openConnectionStep(t, {
      connections: [profile],
      available: true,
      actions: { useConnection: use, resumeConnection: use },
    });
    assert.equal(descendants(document.getElementById('modal'))
      .some((node) => node.getAttribute('id') === 'catalog-connection-token'), false);
    if (profile === live) await clickDialogButton('Continue');
    else await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(used, [profile.id]);
    assert.match(readText(document.getElementById('modal')), /Choose a repository/);
  });
}

test('the stepper asks for a connection name before it enables the token field', () => {
  assert.match(
    catalogSource,
    /nameInput\.addEventListener\('input', \(\) => \{\s*\n\s*state\.newConnectionName = nameInput\.value;\s*\n\s*tokenInput\.disabled = !nameInput\.value\.trim\(\);/
  );
  assert.match(catalogSource, /disabled: mode === 'new' && !\(state\.newConnectionName \|\| ''\)\.trim\(\)/);
  assert.match(catalogSource, /if \(!name\) throw new Error\('Give this connection a name first\.'\);/);
  // The token never lingers in a live input.
  assert.match(catalogSource, /const token = tokenInput\.value;\s*\n\s*tokenInput\.value = '';/);
});

test('new-connection fields exist only in new mode', () => {
  // The reported defect: a saved, encrypted connection was selected and the
  // step still rendered "New connection name", a token field and the
  // persistence checkbox. The fields are now one arm of a four-way choice.
  assert.match(
    catalogSource,
    /\.\.\.\(mode === 'new' \? newFields : needsToken \? reconnectFields : live \? liveFields : idleFields\)/
  );
  assert.match(catalogSource, /const mode = selected \? 'existing' : 'new';/);
  assert.match(catalogSource, /const needsToken = Boolean\(selected\) && !live && !idle;/);
  // Creating a connection happens only in new mode.
  assert.match(catalogSource, /if \(mode === 'new'\) \{[^}]*actions\.createConnection/s);
});

test('a live connection is used as-is, and an idle one restores itself', () => {
  // Live: no token, no resume, just the credential the application already has.
  assert.match(catalogSource, /state\.account = live\s*\n\s*\? await actions\.useConnection\(selected\.id\)\s*\n\s*: await actions\.resumeConnection\(selected\.id\);/);
  assert.match(catalogSource, /This connection already has a credential\./);
  // Idle: restored automatically, with staged progress and no user step.
  assert.match(catalogSource, /Citadel is restoring it from the encrypted credential \\u2014 no token needed\./);
  assert.match(catalogSource, /new StageTracker\(RESUME_STAGES/);
  assert.match(catalogSource, /if \(idle && !state\.resumeFailed && !state\.working\) \{\s*\n\s*next\.click\(\);/);
  assert.deepEqual(
    RESUME_STAGES.map((stage) => stage.label),
    ['Restoring encrypted connection', 'Loading authorized repositories', 'Connected']
  );
});

test('a connection with no usable credential reconnects itself, keeping its name and account', () => {
  // Not "add a new connection": the existing profile is reconnected, its name is
  // fixed, and the server verifies the immutable account id.
  assert.match(catalogSource, /field\('catalog-connection-token', `Reconnect \$\{selected\?\.name\}`, tokenInput\)/);
  assert.match(catalogSource, /actions\.reconnectConnection\(selected\.id, \{/);
  assert.match(catalogSource, /A token for any other account is refused/);
  assert.match(catalogSource, /needsToken \? `Reconnect and continue` : 'Continue'/);
  // The persistence checkbox is offered only when ticking it could change
  // something.
  assert.match(catalogSource, /vault\.available \? persistRow : null/);
  // A credential that will not open is a recovery state for that connection.
  assert.match(catalogSource, /if \(selected && !needsToken\) state\.resumeFailed = true;/);
});

test('the dropdown lists every saved connection and defaults to a usable one', () => {
  // Every profile, including ones that need reconnecting — otherwise a
  // disconnected session-only connection would be unreachable and the user would
  // be pushed into creating a duplicate.
  assert.match(catalogSource, /const profiles = connections;/);
  assert.match(catalogSource, /profiles\.map\(\(profile\) =>\s*\n\s*h\(\s*\n\s*'option',/);
  assert.match(
    catalogSource,
    /profileId:\s*\n\s*connections\.find\(\(item\) => isConnectionLive\(item\)\)\?\.id \|\|\s*\n\s*connections\.find\(\(item\) => isConnectionResumable\(item\)\)\?\.id \|\|\s*\n\s*connections\[0\]\?\.id \|\|\s*\n\s*null,/
  );
  // Switching clears only the secret belonging to the mode being left.
  assert.match(catalogSource, /state\.newConnectionName = '';\s*\n\s*state\.resumeFailed = false;/);
});

test('no branch is preselected, and the local path is a shorter flow', () => {
  assert.match(catalogSource, /h\('option', \{ value: '', selected: !selection\.branch \}, 'Select a branch/);
  assert.match(catalogSource, /state\.kind === 'local' \? \['source', 'details', 'review'\] : steps/);
});

test('the review step names the exact commit the attach will be checked against', () => {
  assert.match(catalogSource, /selection\.validation\?\.head \|\| ''\)\.slice\(0, 12\)/);
  assert.match(catalogSource, /Citadel re-checks this exact commit on the server/);
  // Attach carries the validated head, so a branch that moved is refused.
  assert.match(catalogSource, /\.\.\.selection\.attachment\(\)/);
});

test('an already-attached branch offers the existing workspace instead of a duplicate', () => {
  assert.match(catalogSource, /is already attached to this project as/);
  assert.match(catalogSource, /'Open existing workspace'/);
});

test('the branch step defaults to the branch the user selected, and names the target', () => {
  // The defect: the working-branch checkbox arrived pre-ticked, so attaching
  // created `citadel-ui/<uuid>` and wrote there without anyone choosing it.
  assert.match(catalogSource, /id: 'catalog-branch-working',[\s\S]{0,120}checked: selection\.writeMode === 'working-branch'/);
  assert.match(catalogSource, /'Create a separate branch to work in'/);
  // The old pre-checked, self-recommending label is gone.
  assert.doesNotMatch(catalogSource, /Commit to a Citadel working branch/);
  // Where a save lands is stated on the step itself, before anything exists.
  assert.match(catalogSource, /class: 'catalog-target', role: 'status'/);
  assert.match(catalogSource, /decision = selection\.writeTarget\(\)/);
  assert.match(catalogSource, /say\(target, selection\.branch \? decision\.summary : ''\)/);
});

test('the new branch name is asked for, never prefilled', () => {
  const name = catalogSource.slice(catalogSource.indexOf("id: 'catalog-branch-name'"));
  // Comments stripped first: prose *about* not binding a value is not a value
  // binding, and the comment here says exactly that.
  const block = name.slice(0, name.indexOf('});')).replace(/\/\/[^\n]*/g, '');
  // A placeholder is a suggestion; a value is a decision nobody made.
  assert.match(block, /placeholder:/);
  assert.doesNotMatch(block, /\bvalue:/);
  // The suggestion is one click away, and only fills the field when clicked.
  assert.match(catalogSource, /suggestion\.addEventListener\('click'/);
  assert.match(catalogSource, /selection\.suggestedBranchName\(\)/);
});

test('an existing branch name must be adopted deliberately', () => {
  assert.match(catalogSource, /adoptRow\.hidden = !decision\.needsAdoption/);
  assert.match(catalogSource, /'Use the existing branch as it is'/);
  assert.match(catalogSource, /selection\.setAdoptExisting\(event\.target\.checked\)/);
});

test('branch protection is surfaced on the step, not after the first save fails', () => {
  assert.match(catalogSource, /decision\.ok && decision\.protectedTarget/);
  assert.match(catalogSource, /is protected\. Citadel will commit your change/);
});

test('the review step names the exact branch, not a category of branch', () => {
  assert.match(catalogSource, /'Writes go to',[\s\S]{0,400}selection\.writeTarget\(\)\.workingBranch/);
  // The wording that let an opaque `citadel-ui/<uuid>` pass review unnamed.
  assert.doesNotMatch(catalogSource, /a Citadel working branch created from this head/);
  assert.match(catalogSource, /will be created from \$\{selection\.branch\}/);
});

test('the setup panel offers the same choice as the stepper', () => {
  // A second door to the same operation must not keep the old default.
  const setup = readFileSync(new URL('../web/js/github-setup.mjs', import.meta.url), 'utf8');
  assert.match(setup, /id: 'setup-github-working-branch',[\s\S]{0,200}checked: false/);
  assert.match(setup, /'Create a separate branch to work in'/);
  assert.doesNotMatch(setup, /Commit to a Citadel working branch/);
  assert.match(setup, /id: 'setup-github-branch-name'/);
  assert.match(setup, /selection\.writeTarget\(\)/);
  const nameField = setup.slice(setup.indexOf("id: 'setup-github-branch-name'"));
  assert.doesNotMatch(
    nameField.slice(0, nameField.indexOf('});')).replace(/\/\/[^\n]*/g, ''),
    /\bvalue:/
  );
});

test('detaching is metadata only, and says so before it happens', () => {
  assert.match(catalogSource, /The repository, the \$\{row\.workingBranch\} branch and every commit on it are left exactly as they are\./);
  assert.match(catalogSource, /No file in \$\{row\.location\} is changed or deleted\./);
  assert.match(contextSource, /Metadata only\. No branch is deleted and no file is touched/);
  // Nothing in the catalogue or its actions calls a delete-ref path.
  assert.doesNotMatch(catalogSource, /deleteBranch|deleteRef|force: true/);
  assert.doesNotMatch(contextSource, /deleteBranch|deleteRef|force: true/);
});

test('removing a connection warns about the workspaces it will orphan', () => {
  assert.match(catalogSource, /saved workspace\$\{[^}]*\} reached GitHub through this connection/s);
  assert.match(catalogSource, /No branch is deleted and no token is revoked\./);
});

// ---------------------------------------------------- responsive and a11y --

test('the table stacks into labelled blocks at a phone width', () => {
  const narrow = styles.slice(styles.indexOf('@media (max-width: 52rem)'));
  assert.match(narrow, /\.catalog-table td::before \{[^}]*content: attr\(data-label\);/s);
  assert.match(narrow, /\.catalog-table thead \{[^}]*clip-path: inset\(50%\);/s);
  assert.match(narrow, /\.catalog-filters \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(narrow, /\.catalog-table td \{[^}]*justify-items: start;/s);
  // Specificity has to match the wide rule, or end-alignment survives the stack.
  assert.match(narrow, /\.catalog-table td:last-child:not\(\[colspan\]\) \{\s*text-align: start;/);
  // Every cell carries the label the stacked layout reveals.
  const cells = catalogSource.match(/h\(\s*'td',\s*\{[^}]*\}/gs) || [];
  const unlabelled = cells.filter((cell) => !cell.includes('data-label') && !cell.includes('colspan'));
  assert.deepEqual(unlabelled, [], 'a table cell has no data-label to show when stacked');
  // The action buttons are one grid item. Placed straight into the cell they
  // become cells of their own, and every second button lands under the label.
  assert.match(catalogSource, /\{ 'data-label': 'Actions' \},\s*\n\s*h\('div', \{ class: 'catalog-actions' \}/);
  assert.ok(styles.includes('@media (max-width: 30rem)'), 'no 320px rule');
});

test('nothing in the catalogue is sized in pixels', () => {
  const block = styles.slice(styles.indexOf('.workspace-catalog {'));
  const pixels = block.match(/:\s*-?\d+px/g) || [];
  // Two exceptions, both structural rather than layout: the design system's 1px
  // hairline, and the 1px/-1px clip idiom that hides a label from sight while
  // leaving it to a screen reader.
  assert.deepEqual(
    pixels.filter((value) => !/:\s*-?1px/.test(value)),
    []
  );
});

test('the catalogue survives a breakpoint change', () => {
  const app = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
  // `render()` is wired to two media-query listeners. Without a guard, resizing
  // the window paints the empty workspace over whatever the setup screen has
  // mounted — leaving a screen with no controls and an `ensureWorkspace` promise
  // that can never resolve.
  assert.match(app, /SECTIONS_IN_RAIL\.addEventListener\('change', \(\) => render\(\)\)/);
  assert.match(app, /COMPACT_NAV\.addEventListener\('change', \(\) => render\(\)\)/);
  assert.match(
    app,
    /function render\(\) \{\s*\n\s*if \(els\.shell\.dataset\.workspace !== 'active'\) \{\s*\n\s*updateHeaderContext\(\);\s*\n\s*return;/
  );
});
test('the catalogue is reachable and announced without sight', () => {
  assert.match(catalogSource, /'aria-label': 'Citadel workspaces'/);
  assert.match(catalogSource, /role: 'search'/);
  assert.match(catalogSource, /'aria-label': 'Search saved workspaces'/);
  assert.match(catalogSource, /'aria-label': 'Filter by source'/);
  assert.match(catalogSource, /'aria-label': 'Filter by status'/);
  assert.match(catalogSource, /'aria-label': 'Saved workspaces table'/);
  assert.match(catalogSource, /'aria-label': 'Add workspace progress'/);
  assert.match(catalogSource, /'aria-current': position === index \? 'step' : null/);
  assert.match(catalogSource, /'aria-expanded': String\(open_\)/);
  assert.match(catalogSource, /'aria-controls': 'catalog-activity-list'/);
  // Progress is polite; failure is an alert. One node flipping between the two
  // is announced inconsistently.
  assert.match(catalogSource, /class: 'field-error catalog-error', role: 'alert'/);
  assert.match(catalogSource, /class: 'catalog-progress', role: 'status', 'aria-live': 'polite'/);
  // A horizontally scrollable region is focusable, so it is reachable by keyboard.
  assert.match(catalogSource, /class: 'catalog-scroller',\s*\n\s*tabindex: '0'/);
  // The actions column header is named for a screen reader even though the
  // sighted header is empty.
  assert.match(catalogSource, /class: 'sr-only' \}, 'Actions'/);
  assert.match(styles, /\.sr-only \{[^}]*clip-path: inset\(50%\);/s);
});
