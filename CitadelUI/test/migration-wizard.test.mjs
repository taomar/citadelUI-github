import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { openMigrationWizard } from '../web/js/migration-wizard.mjs';
import { MIGRATION_AREAS, MigrationSession } from '../web/js/migration-session.mjs';
import { MigrationError } from '../shared/migration-input.mjs';
import { CURRENT, SCHEMA, TEMPLATE, deferred, migrationHarness, MigrationFileHandle, TARGET } from './_migration-fixture.mjs';
import { PUBLIC_FILE, PUBLIC_REPO, PUBLIC_SCHEMA, PUBLIC_TEMPLATE, PUBLIC_TEXT, publicHarness } from './_migration-public-fixture.mjs';
import { authenticatedHarness } from './_migration-auth-fixture.mjs';

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
function button(wizard, action) {
  return find(wizard.body, (node) => node.dataset?.action === action) ||
    find(wizard.footer, (node) => node.dataset?.action === action);
}
async function press(wizard, action) {
  const node = button(wizard, action);
  assert(node, `missing action ${action}`);
  assert(!node.disabled, `disabled action ${action}`);
  node.click();
  await wizard.whenIdle();
}

async function open(options = {}) {
  const dialog = await loadDialogModule();
  const harness = options.harness || migrationHarness();
  const downloads = [];
  let applied = null;
  const wizard = await openMigrationWizard({
    session: harness.session,
    chooseDirectory: async () => harness.donorRoot,
    chooseFiles: async () => [new MigrationFileHandle('main.bicepparam', 'param count = 5\n')],
    download: async (file) => downloads.push(file),
    onApplied: async (result) => { applied = result; },
    show: dialog.showDialog,
    dismiss: dialog.dismissDialog,
    confirm: options.realConfirm ? dialog.confirmDialog : async () => true,
    ...options.wizard,
  });
  return { wizard, harness, dialog, downloads, applied: () => applied };
}

async function pair(wizard, picker = 'choose-folder') {
  if (wizard.step === 'pair') await press(wizard, 'change-source');
  await press(wizard, picker);
  const target = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Destination parameter file');
  target.value = TARGET;
  target.dispatch('change');
  const source = find(wizard.body, (node) => node.dataset?.sourceId);
  assert(source);
  source.checked = true;
  source.dispatch('change');
  await press(wizard, 'map');
  assert.equal(wizard.step, 'map', readText(wizard.body));
}

async function review(wizard) {
  const decision = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Decision for Count');
  const candidate = find(decision, (node) => node.tagName === 'OPTION' && node.value.startsWith('accept:') && !node.disabled);
  assert(candidate);
  decision.value = candidate.value;
  decision.dispatch('change');
  await press(wizard, 'keep-remaining');
  await press(wizard, 'preview');
  assert.equal(wizard.step, 'review', readText(wizard.body));
}

test('migration wizard is usable end-to-end through synthetic folder handles and the existing dialog stack', async () => {
  const { wizard, harness, dialog, downloads, applied } = await open({ realConfirm: true });
  assert.equal(dialog.modal.open, true);
  assert.match(readText(dialog.modal), /Migrate Citadel Configuration/);
  assert.doesNotMatch(readText(dialog.modal), /Migrate a repo|Migrate repo/);
  assert.match(readText(wizard.body), /Current workspace|Currently checked-out files/);
  assert.match(readText(wizard.body), /No host path is sent to the server/);
  assert.equal(button(wizard, 'map'), null, 'file pairing belongs to the next stage');
  await pair(wizard);
  assert.match(readText(wizard.body), /Current type: int/);
  assert.match(readText(wizard.body), /old|Donor/);
  assert.match(readText(wizard.body), /Removed \/ unrecognized donor field/);
  await review(wizard);
  assert.match(readText(wizard.body), /1 proposed edits.*0 copied to destination/);
  assert.match(readText(wizard.body), /Not deployment-ready certification/);
  await press(wizard, 'export-report');
  await press(wizard, 'export-draft');
  assert.equal(downloads.length, 2);
  assert.match(downloads[1].text, /param Count = 4/);
  assert.equal(harness.api.trace.length, 0);

  const apply = button(wizard, 'apply');
  apply.click();
  apply.click(); // a detached old control must not start another operation
  assert.equal(wizard.busy, true);
  assert.match(readText(dialog.modal), /Apply reviewed migration locally/);
  const confirm = find(dialog.modal, (node) => node.tagName === 'BUTTON' && readText(node) === 'Apply reviewed local changes');
  assert(confirm);
  confirm.click();
  await wizard.whenIdle();
  assert.equal(wizard.step, 'done');
  assert.equal(applied().target, TARGET);
  assert.equal(harness.api.trace.filter((event) => event === 'prepare').length, 1);
  assert.match(readText(wizard.body), /History for undo\/recovery/);
  await press(wizard, 'export-history');
  const history = JSON.parse(downloads.at(-1).text);
  assert.equal(history.reports[0].status, 'applied');
  assert.equal(history.reports[0].summary.copied, 1);
  assert.deepEqual(history.reports[0].pairs[0].oldOnlyNames, ['removed']);
  assert.doesNotMatch(downloads.at(-1).text, /legacy-only|"value":/);
  await press(wizard, 'close');
  assert.equal(dialog.modal.open, false);
});

test('migration wizard explicit file picker provides real mapping, not just a folder-only demonstration', async () => {
  const { wizard, harness } = await open();
  await pair(wizard, 'choose-files');
  await review(wizard);
  await press(wizard, 'apply');
  assert.match((await harness.provider.read(TARGET)).text, /param Count = 5/);
});

test('migration wizard can pair another area after apply without losing reports or reusing the previous review token', async () => {
  const llm = 'bicep/infra/llm-backend-onboarding/main.bicepparam';
  const harness = migrationHarness({
    targetFiles: { [TARGET]: CURRENT, [TEMPLATE]: SCHEMA, [llm]: CURRENT, [llm.replace(/\.bicepparam$/, '.bicep')]: SCHEMA },
  });
  const { wizard, downloads } = await open({ harness });
  await pair(wizard);
  await review(wizard);
  await press(wizard, 'apply');
  assert.equal(wizard.step, 'done');
  assert(button(wizard, 'another-target'));
  await press(wizard, 'export-history');
  const oldReviewId = JSON.parse(downloads.at(-1).text).reports[0].reviewId;
  await press(wizard, 'another-target');
  assert.equal(wizard.step, 'pair');
  assert(button(wizard, 'map').disabled);
  input(wizard, 'Migration area', 'llm-onboarding');
  input(wizard, 'Destination parameter file', llm);
  const source = find(wizard.body, (node) => node.dataset?.sourceId);
  source.checked = true;
  source.dispatch('change');
  await press(wizard, 'map');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Decision for Count').value, 'pending');
  await assert.rejects(harness.session.apply(oldReviewId, { reviewed: true }), { code: 'review' });
  await review(wizard);
  await press(wizard, 'export-history');
  const reports = JSON.parse(downloads.at(-1).text).reports;
  assert.deepEqual(reports.map((report) => report.destination.target), [TARGET, llm]);
  assert.deepEqual(reports.map((report) => report.status), ['applied', 'preview-only']);
  assert.equal(harness.targetTrace.filter((entry) => entry.startsWith('write:')).length, 1);
  assert(!harness.donorTrace.some((entry) => /^(?:write|writable):/.test(entry)));
});

test('migration wizard apply confirmation cancellation leaves all files unchanged', async () => {
  const { wizard, harness } = await open({ wizard: { confirm: async () => false } });
  await pair(wizard);
  await review(wizard);
  await press(wizard, 'apply');
  assert.equal(wizard.step, 'review');
  assert.equal(harness.api.trace.length, 0);
  assert.match(readText(wizard.body), /Apply cancelled/);
});

test('migration wizard blocks unsafe candidate selection and exposes unresolved/new/default guidance', async () => {
  const harness = migrationHarness({ donorText: "param count = 'wrong-type'\nparam removed = readEnvironmentVariable('DO_NOT_DISPLAY', 'hidden')\n" });
  const { wizard } = await open({ harness });
  await pair(wizard);
  assert.match(readText(wizard.body), /Type \/ current-constraint mismatch/);
  assert.match(readText(wizard.body), /Current field \/ no paired donor assignment/);
  assert.match(readText(wizard.body), /Nonliteral expression \/ dynamic reference/);
  assert.doesNotMatch(readText(wizard.body), /DO_NOT_DISPLAY/);
  const decision = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Decision for Count');
  const candidate = find(decision, (node) => node.tagName === 'OPTION' && node.value.startsWith('accept:'));
  assert(candidate.disabled);
  await press(wizard, 'preview');
  assert(button(wizard, 'apply').disabled);
});

test('migration wizard refuses dismissal and duplicate clicks while applying, with visible in-dialog progress', async () => {
  const gate = deferred();
  const entered = deferred();
  const harness = migrationHarness({ hooks: { authorize: async () => { entered.resolve(); await gate.promise; } } });
  const { wizard, dialog } = await open({ harness });
  await pair(wizard);
  await review(wizard);
  const apply = button(wizard, 'apply');
  apply.click();
  apply.click();
  await entered.promise;
  assert.equal(dialog.dismissDialog(), false);
  assert.equal(wizard.body.getAttribute('aria-busy'), 'true');
  assert.match(readText(wizard.body), /backing up, and applying/);
  assert(button(wizard, 'apply').disabled);
  gate.resolve();
  await wizard.whenIdle();
  assert.equal(harness.api.trace.filter((event) => event === 'prepare').length, 1);
});

test('migration wizard stale export discards the preview and cannot overwrite current editor work', async () => {
  const { wizard, harness, downloads } = await open();
  await pair(wizard);
  await review(wizard);
  harness.state.pending = true;
  await press(wizard, 'export-draft');
  assert.equal(wizard.step, 'pair');
  assert.match(readText(wizard.body), /does not overwrite drafts/);
  assert.equal(downloads.length, 0);
  assert.equal(harness.api.trace.length, 0);
});

test('migration wizard changing pairings requires rebuilding decisions and does not auto-select filename matches', async () => {
  const { wizard, harness } = await open();
  await press(wizard, 'choose-folder');
  assert(button(wizard, 'map').disabled);
  await pair(wizard);
  await review(wizard);
  await press(wizard, 'back');
  await press(wizard, 'pair');
  await press(wizard, 'map');
  const decision = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Decision for Count');
  assert.equal(decision.value, 'pending');
  assert.equal(harness.api.trace.length, 0);
});

test('migration wizard remote identity and export-only restriction are unmistakable; no apply control is present', async () => {
  const harness = migrationHarness();
  let writes = 0;
  const context = {
    projectId: 'remote-project',
    environment: { id: 'remote', label: 'Remote workspace', source: {
      kind: 'github', repositoryId: 42, fullName: 'synthetic/current', sourceBranch: 'main',
      workingBranch: 'review-branch', writeMode: 'working-branch',
    } },
    provider: {
      remote: true,
      entries: () => harness.provider.entries(),
      read: (alias) => harness.provider.read(alias),
      tree: async () => ({ head: 'a'.repeat(40), branch: 'review-branch', repository: { id: 42, fullName: 'synthetic/current' } }),
    },
  };
  harness.session = new MigrationSession({
    contextProvider: () => context, registry: harness.registry,
    coordinator: { commit: async () => { writes += 1; } },
  });
  const { wizard, downloads } = await open({ harness });
  assert.match(readText(wizard.body), /synthetic\/current/);
  assert.match(readText(wizard.body), /review-branch/);
  assert.match(readText(wizard.body), /No remote writes or commits/);
  await pair(wizard);
  await review(wizard);
  assert.equal(button(wizard, 'apply'), null);
  await press(wizard, 'export-draft');
  assert.equal(downloads.length, 1);
  assert.equal(writes, 0);
});

test('migration wizard malformed donor errors never echo source contents', async () => {
  const { wizard, harness } = await open({ wizard: {
    chooseFiles: async () => [new MigrationFileHandle('broken.bicepparam', "param count = 'SYNTHETIC_PRIVATE_MARKER\n")],
  } });
  await press(wizard, 'choose-files');
  const target = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Destination parameter file');
  target.value = TARGET;
  target.dispatch('change');
  const source = find(wizard.body, (node) => node.dataset?.sourceId);
  source.checked = true;
  source.dispatch('change');
  await press(wizard, 'map');
  assert.match(readText(wizard.body), /malformed or uses unsupported/);
  assert.doesNotMatch(readText(wizard.body), /SYNTHETIC_PRIVATE_MARKER/);
  assert.equal(harness.api.trace.length, 0);
  input(wizard, 'Destination parameter file', TARGET);
  assert.equal(find(wizard.body, (node) => node.classList?.contains('field-error')), null);
  assert.equal(find(wizard.body, (node) => node.classList?.contains('migration-notice')).getAttribute('role'), 'status');
});

test('migration command is gated on an active workspace and protects the existing pending editor flow', async () => {
  const app = await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
  const actions = app.slice(app.indexOf('function renderActions()'), app.indexOf('let setupContext'));
  assert.match(actions, /activeWorkspace\(\)/);
  assert.match(actions, /const migration = workspace/);
  assert.match(actions, /Migrate Citadel Configuration/);
  assert.doesNotMatch(actions, /Migrate a repo|Migrate repo/);
  const launch = app.slice(app.indexOf('async function openParameterMigration'), app.indexOf('function renderActions()'));
  assert.match(launch, /if \(pendingCount\(\)\)/);
  assert.doesNotMatch(launch, /discardAllPending|removeDraft|stashCurrentPending/);
  assert.match(launch, /current !== context \|\| pendingCount\(\)/);
});

function input(wizard, label, value) {
  const field = find(wizard.body, (node) => node.getAttribute?.('aria-label') === label);
  assert(field, `missing field ${label}`);
  field.value = value;
  field.dispatch(field.tagName === 'SELECT' ? 'change' : 'input');
}

async function publicPair(wizard) {
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', `https://github.com/${PUBLIC_REPO}`);
  await press(wizard, 'find-repository');
  const ref = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA');
  assert.equal(ref.value, '', 'repository metadata must not choose the default branch');
  input(wizard, 'Source branch, tag, or full commit SHA', 'legacy-main');
  await press(wizard, 'read-github');
  input(wizard, 'Destination parameter file', TARGET);
  const source = find(wizard.body, (node) => node.dataset?.sourceId === PUBLIC_FILE);
  source.checked = true;
  source.dispatch('change');
  await press(wizard, 'map');
}

test('migration public wizard connects without a PAT, shows pinned provenance, maps and applies locally', async () => {
  const harness = publicHarness();
  const { wizard, downloads, applied } = await open({ harness, wizard: { publicRequest: harness.request } });
  await publicPair(wizard);
  assert.equal(wizard.step, 'map', readText(wizard.body));
  assert.match(readText(wizard.body), /Public GitHub donor — anonymous, read-only/);
  assert.match(readText(wizard.body), /Pinned commit:/);
  assert.match(readText(wizard.body), /Pinned tree:/);
  assert.match(readText(wizard.body), /Repository ID: 8001 · branch: legacy-main/);
  await review(wizard);
  await press(wizard, 'export-report');
  assert.equal(JSON.parse(downloads[0].text).donor.revision.repositoryId, 8001);
  await press(wizard, 'apply');
  assert.equal(applied().target, TARGET);
  assert.equal(harness.api.trace.filter((entry) => entry === 'prepare').length, 1);
  assert(harness.github.calls.every((call) => call.method === 'GET'));
});

test('migration public wizard ref changes invalidate the donor and all prior decisions immediately', async () => {
  const harness = publicHarness();
  const { wizard } = await open({ harness, wizard: { publicRequest: harness.request } });
  await publicPair(wizard);
  await review(wizard);
  await press(wizard, 'back');
  await press(wizard, 'pair');
  await press(wizard, 'change-source');
  input(wizard, 'Source branch, tag, or full commit SHA', 'different-ref');
  assert.equal(wizard.step, 'donor');
  assert.equal(button(wizard, 'map'), null);
  assert.match(readText(wizard.body), /discards the current pairing and decisions/);
  assert.equal(harness.api.trace.length, 0);
});

test('migration public wizard read/rate errors are explicit and do not render an empty successful mapping', async () => {
  const harness = publicHarness();
  const { wizard, downloads } = await open({ harness, wizard: { publicRequest: harness.request } });
  await publicPair(wizard);
  await review(wizard);
  harness.github.overrides.set('/repositories/8001', (github) =>
    github.json(403, { message: 'SYNTHETIC_PRIVATE_MARKER' }, { 'x-ratelimit-remaining': '0' }));
  await press(wizard, 'export-draft');
  assert.equal(wizard.step, 'donor');
  assert.match(readText(wizard.body), /Anonymous GitHub rate limit reached/);
  assert.match(readText(wizard.body), /read the GitHub source again/);
  assert.doesNotMatch(readText(wizard.body), /SYNTHETIC_PRIVATE_MARKER/);
  assert.equal(button(wizard, 'map'), null);
  assert.equal(downloads.length, 0);
  assert.equal(harness.api.trace.length, 0);
});

test('migration public wizard supports explicit tag refs and drops slow responses for edited selections', async () => {
  const harness = publicHarness();
  harness.github.seed('v-older', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA }, { tag: true });
  const { wizard } = await open({ harness, wizard: { publicRequest: harness.request } });
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', PUBLIC_REPO);
  input(wizard, 'Source ref type', 'tag');
  input(wizard, 'Source branch, tag, or full commit SHA', 'v-older');
  await press(wizard, 'read-github');
  assert.match(readText(wizard.body), /tag: v-older/);
  await press(wizard, 'change-source');
  input(wizard, 'Source branch, tag, or full commit SHA', 'v-older-again');
  const gate = deferred();
  const entered = deferred();
  harness.github.overrides.set(`/repos/${PUBLIC_REPO}`, async (github) => {
    entered.resolve();
    await gate.promise;
    return github.json(200, github.repository);
  });
  button(wizard, 'find-repository').click();
  await entered.promise;
  input(wizard, 'Source repository URL or owner/repo', 'synthetic/another');
  gate.resolve();
  await wizard.whenIdle();
  assert.equal(button(wizard, 'map'), null);
  assert.match(readText(wizard.body), /public donor repository, ref, commit, tree, or file identity changed/i);
});

test('migration wizard exposes all areas and retains separate downloadable reports across file pairings', async () => {
  const targets = [
    [TARGET, 'deployment'],
    ['bicep/infra/apim-gateway-upgrade/main.bicepparam', 'apim-upgrade'],
    ['bicep/infra/apim-gateway-upgrade/supporting-services.bicepparam', 'supporting-services'],
    ['bicep/infra/llm-backend-onboarding/main.bicepparam', 'llm-onboarding'],
    ['bicep/infra/citadel-access-contracts/main.bicepparam', 'access-contracts'],
    ['bicep/infra/citadel-access-contracts/synthetic-instance/main.bicepparam', 'access-contracts'],
  ];
  const targetFiles = Object.fromEntries(targets.flatMap(([alias]) => [
    [alias, "using './current.bicep'\nparam Count = 2\n"],
    [alias.replace(/[^/]+$/, 'current.bicep'), 'param Count int\n'],
  ]));
  const harness = migrationHarness({ targetFiles, donorText: 'param count = 4\n' });
  const { wizard, downloads } = await open({ harness });
  await press(wizard, 'choose-folder');
  const areaSelect = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Migration area');
  for (const area of MIGRATION_AREAS) assert.match(readText(areaSelect), new RegExp(area.label));
  for (const [alias, area] of targets) {
    input(wizard, 'Migration area', area);
    const targetSelect = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Destination parameter file');
    assert(targetSelect.children.filter((node) => node.value).every((node) =>
      targets.some(([path, kind]) => path === node.value && kind === area)));
    input(wizard, 'Destination parameter file', alias);
    const source = find(wizard.body, (node) => node.dataset?.sourceId);
    assert.equal(Boolean(source.checked), false, 'each new target requires explicit donor pairing');
    source.checked = true;
    source.dispatch('change');
    await press(wizard, 'map');
    const names = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Per-file parameter name report');
    assert.match(readText(names), /Old-only parameters absent from this current target: None/);
    await review(wizard);
    if (alias !== targets.at(-1)[0]) await press(wizard, 'another-target');
  }
  await press(wizard, 'export-history');
  const reports = JSON.parse(downloads.at(-1).text).reports;
  assert.deepEqual(reports.map((report) => report.pairs[0].target.file), targets.map(([alias]) => alias));
  assert(reports.every((report) => report.status === 'preview-only' && report.pairs[0].oldOnlyNames.length === 0));
  assert(reports.every((report) => report.classification.matched === 1 &&
    report.summary.proposedEdits === 1 && report.summary.copied === 0));
  assert.doesNotMatch(downloads.at(-1).text, /"value":|"rows":/);
  assert.equal(harness.api.trace.length, 0);
});

test('migration public wizard requires an explicit ref and never substitutes the repository default branch', async () => {
  const harness = publicHarness();
  harness.github.repository.default_branch = 'citadel-v1';
  const revision = harness.github.seed('main', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA });
  const { wizard } = await open({ harness, wizard: { publicRequest: harness.request } });
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', PUBLIC_REPO);
  await press(wizard, 'find-repository');
  const ref = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA');
  assert.equal(ref.value, '');
  await press(wizard, 'read-github');
  assert.equal(wizard.step, 'donor');
  assert.match(readText(wizard.body), /explicit branch, tag, or full commit SHA/);
  input(wizard, 'Source ref type', 'commit');
  input(wizard, 'Source branch, tag, or full commit SHA', revision.commit);
  await press(wizard, 'find-repository');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source repository URL or owner/repo').value,
    PUBLIC_REPO);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source ref type').value, 'commit');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA').value,
    revision.commit);
  await press(wizard, 'read-github');
  assert.equal(wizard.step, 'pair');
  assert(!harness.github.calls.some((call) => call.path.includes('/git/ref/')));
});

function findAll(node, predicate) {
  return [
    ...(predicate(node) ? [node] : []),
    ...(node.children || []).flatMap((child) => findAll(child, predicate)),
  ];
}

function sourceConnectionStub(options = {}) {
  let connected = false;
  let selectedProfile = null;
  const calls = [];
  const profile = { id: 'source-profile', name: 'Source connection', accountLogin: 'source-reader' };
  const controller = {
    get connected() { return connected; },
    status: () => connected ? {
      connected: true, account: { id: 41, login: 'source-reader' },
      profile: selectedProfile, credentialSource: selectedProfile ? 'saved-connection' : 'session-pat',
    } : { connected: false },
    listConnections: async () => {
      calls.push({ action: 'list' });
      return { profiles: [profile], vault: { available: false } };
    },
    connect: async (selection) => {
      calls.push({ action: 'connect', hasToken: Object.hasOwn(selection, 'token'), profileId: selection.profileId });
      await options.connect?.(selection);
      connected = true;
      selectedProfile = selection.profileId ? { id: profile.id, name: profile.name } : null;
      return controller.status();
    },
    disconnect: async () => {
      calls.push({ action: 'disconnect' });
      connected = false;
      await options.disconnect?.();
      return { erased: true };
    },
    inspectRepository: async () => {
      calls.push({ action: 'inspect' });
      throw new MigrationError('private-access');
    },
    createDonor: () => {
      calls.push({ action: 'donor' });
      throw new MigrationError('private-read');
    },
  };
  return { controller, calls };
}

async function access(wizard, mode) {
  input(wizard, 'GitHub source access', mode);
  await wizard.whenIdle();
}

test('migration UI uses original catalog steps, source choices, summaries and field controls throughout', async () => {
  const { wizard } = await open();
  assert(wizard.body.classList.contains('catalog-dialog'));
  const steps = find(wizard.body, (node) => node.classList?.contains('catalog-steps'));
  assert.equal(readText(steps), 'SourceFilesMappingReview');
  assert.equal(steps.children[0].getAttribute('aria-current'), 'step');
  assert(steps.children[0].classList.contains('catalog-step-current'));
  for (const key of ['choose-folder', 'choose-files', 'choose-github']) {
    assert(button(wizard, key).classList.contains('catalog-choice-option'));
  }
  assert(find(wizard.body, (node) => node.classList?.contains('catalog-summary')));
  assert.equal(find(wizard.body, (node) => node.classList?.contains('write-context')), null);
  assert.match(readText(wizard.body), /private source/);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Migration area'), null);
  await pair(wizard);
  for (const control of findAll(wizard.body, (node) => ['INPUT', 'SELECT'].includes(node.tagName))) {
    assert(control.classList.contains(control.getAttribute('type') === 'checkbox' ? 'ctl-check' : 'ctl'));
    assert(control.getAttribute('name'));
    assert(control.getAttribute('aria-label') || control.parentElement.tagName === 'LABEL');
  }
  await review(wizard);
  assert(button(wizard, 'export-report').parentElement.classList.contains('catalog-form-actions'));
  assert(!find(wizard.footer, (node) => node.dataset?.action === 'export-report'));
  assert.match(readText(wizard.body), /Old-only parameters absent from this current target: removed/);
});

test('migration UI scoped CSS reuses original controls without redefining their type or the global dialog', async () => {
  const css = await readFile(new URL('../web/css/components.css', import.meta.url), 'utf8');
  const scoped = css.slice(css.indexOf('/* ===================================================== parameter migration */'),
    css.indexOf('/* ============================================================== the sheet */'));
  assert(scoped.length > 0);
  assert.doesNotMatch(scoped, /\.migration-field|\.migration-steps|font:\s*inherit|font-family:|#[a-f\d]{3,8}\b/i);
  assert.doesNotMatch(scoped, /(?:^|\n)\.modal(?:\s|[.{[:])/);
  assert.match(scoped, /font-size: var\(--t-h3\)/);
  assert.match(scoped, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(scoped, /white-space: normal/);
});

test('migration UI restores keyboard focus to recreated area and file selection controls', async () => {
  const { wizard } = await open();
  await press(wizard, 'choose-folder');
  input(wizard, 'Migration area', 'deployment');
  assert.equal(document.activeElement, find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Migration area'));
  input(wizard, 'Destination parameter file', TARGET);
  assert.equal(document.activeElement, find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Destination parameter file'));
  const source = find(wizard.body, (node) => node.dataset?.sourceId);
  source.checked = true;
  source.dispatch('change');
  assert.equal(document.activeElement, find(wizard.body, (node) => node.dataset?.sourceId === source.dataset.sourceId));
});

test('migration UI starts each stage at its identities and keeps same-stage action focus', async () => {
  const { wizard } = await open();
  await pair(wizard);
  assert.equal(wizard.body.parentElement.scrollTop, 0);
  const retain = button(wizard, 'keep-remaining');
  retain.focus();
  await press(wizard, 'keep-remaining');
  assert.equal(document.activeElement, button(wizard, 'keep-remaining'));
  wizard.body.parentElement.scrollTop = 400;
  await press(wizard, 'preview');
  assert.equal(wizard.body.parentElement.scrollTop, 0);
});

test('migration UI opens native source pickers synchronously within the triggering user action', async () => {
  const harness = migrationHarness();
  let inGesture = false;
  let called = false;
  const { wizard } = await open({ harness, wizard: {
    chooseDirectory: () => {
      assert(inGesture, 'do not await a network or rendering task before opening the picker');
      called = true;
      return Promise.resolve(harness.donorRoot);
    },
  } });
  inGesture = true;
  button(wizard, 'choose-folder').click();
  inGesture = false;
  assert(called);
  await wizard.whenIdle();
  assert.equal(wizard.step, 'pair');
});

test('migration UI provides an empty filter state without losing parameter decisions', async () => {
  const { wizard } = await open();
  await pair(wizard);
  input(wizard, 'Filter parameter names', 'not-a-parameter');
  const search = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Filter parameter names');
  search.dispatch('change');
  assert.match(readText(wizard.body), /No parameter names match/);
  search.value = '';
  search.dispatch('change');
  assert(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Decision for Count'));
});

test('migration source UI keeps PAT help outside its label and preserves the same password control and typed values', async () => {
  const { controller } = sourceConnectionStub();
  const { wizard } = await open({ wizard: { sourceConnection: controller } });
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', 'synthetic/source');
  input(wizard, 'Source branch, tag, or full commit SHA', 'older-branch');
  await access(wizard, 'token');
  const token = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source GitHub token');
  assert.equal(token.getAttribute('type'), 'password');
  assert.equal(token.getAttribute('autocomplete'), 'off');
  token.value = 'ui-only-token-marker';
  const toggle = find(wizard.body, (node) => node.tagName === 'BUTTON' && readText(node) === 'Token help');
  const parent = token.parentElement;
  assert.notEqual(toggle.parentElement.tagName, 'LABEL');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(token.parentElement, parent);
  assert.equal(token.value, 'ui-only-token-marker');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source GitHub token'), token);
  assert.match(readText(wizard.body), /Contents: Read-only/);
  assert.match(readText(wizard.body), /Metadata: Read-only/);
  assert.doesNotMatch(readText(wizard.body), /Contents: Read and write|Administration: Read and write|All repositories/);
  assert.doesNotMatch(readText(wizard.body), /ui-only-token-marker/);
  await press(wizard, 'connect-source');
  assert.equal(token.value, '');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source repository URL or owner/repo').value, 'synthetic/source');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA').value, 'older-branch');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source GitHub token'), null);
  await press(wizard, 'close');
});

test('migration source UI clears submitted PAT immediately, uses single-flight progress, and prevents dismissal during authentication', async () => {
  const gate = deferred();
  const entered = deferred();
  const { controller, calls } = sourceConnectionStub({ connect: async (selection) => {
    assert.equal(selection.token, 'ui-only-token-marker');
    entered.resolve();
    await gate.promise;
  } });
  const { wizard, dialog } = await open({ wizard: { sourceConnection: controller } });
  await press(wizard, 'choose-github');
  await access(wizard, 'token');
  const token = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source GitHub token');
  token.value = 'ui-only-token-marker';
  const submit = button(wizard, 'connect-source');
  submit.click();
  submit.click();
  await entered.promise;
  assert.equal(token.value, '');
  assert.equal(button(wizard, 'connect-source').getAttribute('aria-busy'), 'true');
  assert.equal(dialog.dismissDialog(), false);
  assert.equal(calls.filter((call) => call.action === 'connect').length, 1);
  gate.resolve();
  await wizard.whenIdle();
  assert.match(readText(wizard.body), /Source connected/);
  await press(wizard, 'close');
});

test('migration source UI selects a saved connection explicitly without ordinary destination connection actions', async () => {
  const { controller, calls } = sourceConnectionStub();
  const { wizard, harness } = await open({ wizard: { sourceConnection: controller } });
  await press(wizard, 'choose-github');
  await access(wizard, 'saved');
  assert(button(wizard, 'connect-source').disabled);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source GitHub token'), null);
  input(wizard, 'Saved source connection', 'source-profile');
  await press(wizard, 'connect-source');
  assert.deepEqual(calls.find((call) => call.action === 'connect'),
    { action: 'connect', hasToken: false, profileId: 'source-profile' });
  assert.equal(harness.api.trace.length, 0);
  await press(wizard, 'close');
});

test('migration source UI does not dismiss on cleanup failure and retries erasure even when already disconnected', async () => {
  let attempts = 0;
  let failCleanup = false;
  const { controller } = sourceConnectionStub({ disconnect: async () => {
    if (failCleanup && ++attempts === 1) throw new MigrationError('private-disconnect');
  } });
  const { wizard, dialog } = await open({ wizard: { sourceConnection: controller } });
  await press(wizard, 'choose-github');
  await access(wizard, 'token');
  input(wizard, 'Source GitHub token', 'ui-only-token-marker');
  await press(wizard, 'connect-source');
  failCleanup = true;
  await press(wizard, 'close');
  assert.equal(controller.connected, false);
  assert.equal(dialog.modal.open, true);
  const error = find(wizard.body, (node) => node.classList?.contains('field-error'));
  assert(error && !error.hidden && readText(error));
  await press(wizard, 'close');
  assert.equal(attempts, 2);
  assert.equal(dialog.modal.open, false);
});

test('migration source UI guards Escape with awaited source cleanup and clears unsubmitted tokens on mode change', async () => {
  const { controller, calls } = sourceConnectionStub();
  const { wizard, dialog } = await open({ wizard: { sourceConnection: controller } });
  await press(wizard, 'choose-github');
  await access(wizard, 'token');
  const token = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source GitHub token');
  token.value = 'ui-only-token-marker';
  await access(wizard, 'public');
  assert.equal(token.value, '');
  const count = calls.filter((call) => call.action === 'disconnect').length;
  assert.equal(dialog.dismissDialog(), false);
  await wizard.whenIdle();
  assert.equal(dialog.modal.open, false);
  assert.equal(calls.filter((call) => call.action === 'disconnect').length, count + 1);
});

test('migration source UI clears failed PAT submissions and never falls back to anonymous source reads', async () => {
  const { controller } = sourceConnectionStub({ connect: async () => { throw new MigrationError('private-auth-invalid'); } });
  let publicReads = 0;
  const { wizard } = await open({ wizard: {
    sourceConnection: controller, publicRequest: async () => { publicReads += 1; },
  } });
  await press(wizard, 'choose-github');
  await access(wizard, 'token');
  const token = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source GitHub token');
  token.value = 'ui-only-token-marker';
  await press(wizard, 'connect-source');
  assert.equal(token.value, '');
  assert.equal(controller.connected, false);
  assert.equal(publicReads, 0);
  assert.equal(button(wizard, 'read-github'), null);
  assert(find(wizard.body, (node) => node.classList?.contains('field-error')));
  await press(wizard, 'close');
});

async function actualSource(wizard, harness, mode = 'token') {
  await press(wizard, 'choose-github');
  await access(wizard, mode);
  if (mode === 'saved') input(wizard, 'Saved source connection', 'existing-connection');
  else input(wizard, 'Source GitHub token', harness.token);
  await press(wizard, 'connect-source');
  assert.equal(harness.connection.connected, true, readText(wizard.body));
}

async function actualPair(wizard, harness, mode = 'token') {
  await actualSource(wizard, harness, mode);
  input(wizard, 'Source repository URL or owner/repo', PUBLIC_REPO);
  await press(wizard, 'find-repository');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA').value, '');
  input(wizard, 'Source branch, tag, or full commit SHA', 'legacy-main');
  await press(wizard, 'read-github');
  assert.equal(wizard.step, 'pair', readText(wizard.body));
  input(wizard, 'Destination parameter file', TARGET);
  const source = find(wizard.body, (node) => node.dataset?.sourceId === PUBLIC_FILE);
  assert(source && !source.checked);
  source.checked = true;
  source.dispatch('change');
  await press(wizard, 'map');
  assert.equal(wizard.step, 'map', readText(wizard.body));
}

for (const mode of ['token', 'saved']) {
  test(`migration actual ${mode} source wizard uses real controller/routes through local apply without changing destination credentials`, async () => {
    const harness = authenticatedHarness();
    const originalProfile = structuredClone(harness.profileData.get('existing-connection'));
    const { wizard, downloads } = await open({ harness, wizard: { sourceConnection: harness.connection } });
    await actualPair(wizard, harness, mode);
    assert.match(readText(wizard.body), /GitHub donor — authenticated, read-only/);
    assert.equal(wizard.body.parentElement.scrollTop, 0);
    await review(wizard);
    assert.equal(wizard.body.parentElement.scrollTop, 0);
    await press(wizard, 'export-report');
    for (const output of [readText(wizard.body), downloads[0].text, JSON.stringify(harness.connection.status())]) {
      assert(!output.includes(harness.token));
      assert(!output.includes(harness.destinationToken));
      assert(harness.mintedIds.every((id) => !output.includes(id)));
    }
    await press(wizard, 'apply');
    assert.equal(wizard.step, 'done', readText(wizard.body));
    assert.equal(harness.api.trace.filter((entry) => entry === 'prepare').length, 1);
    assert.equal(harness.targetTrace.filter((entry) => entry.startsWith('write:')).length, 1);
    assert(harness.github.authCalls.every((entry) => entry.method === 'GET' && entry.authenticated));
    assert(harness.localCalls.every((entry) => entry.path.startsWith('/api/github/migration-source/')));
    assert.equal(harness.github.repository.permissions.push, false);
    assert.equal(harness.github.repository.permissions.admin, false);
    await press(wizard, 'close');
    assert.equal(harness.routes.migrationSource.sessions.size, 0);
    assert.equal(harness.routes.migrationSource.readers.size, 0);
    assert(harness.sessions.resolve(harness.destination.id).token === harness.destinationToken);
    assert.deepEqual(harness.profileData.get('existing-connection'), originalProfile);
    assert.deepEqual(harness.vaultWrites, []);
  });
}

test('migration actual controller wizard preserves the dialog and retries failed source erasure', async () => {
  const harness = authenticatedHarness();
  const { wizard, dialog } = await open({ harness, wizard: { sourceConnection: harness.connection } });
  await actualSource(wizard, harness);
  harness.hooks.failErase = true;
  await press(wizard, 'close');
  assert.equal(dialog.modal.open, true);
  assert.equal(harness.connection.connected, false);
  assert.equal(harness.routes.migrationSource.sessions.size, 1, 'failed transport must not be reported as erasure');
  assert.match(readText(wizard.body), /retry|erasure|erase/i);
  assert(find(wizard.body, (node) => node.getAttribute?.('role') === 'alert'));
  harness.hooks.failErase = false;
  await press(wizard, 'close');
  assert.equal(dialog.modal.open, false);
  assert.equal(harness.routes.migrationSource.sessions.size, 0);
  assert.equal(harness.routes.migrationSource.readers.size, 0);
  assert(harness.sessions.resolve(harness.destination.id).token === harness.destinationToken);
});

test('migration actual controller wizard rejects late cancelled authentication and clears its password input', async (t) => {
  const harness = authenticatedHarness();
  const gate = deferred();
  const entered = deferred();
  t.after(() => gate.resolve());
  harness.hooks.connected = async () => { entered.resolve(); await gate.promise; };
  const { wizard, dialog } = await open({ harness, wizard: { sourceConnection: harness.connection } });
  await press(wizard, 'choose-github');
  await access(wizard, 'token');
  const token = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source GitHub token');
  token.value = harness.token;
  button(wizard, 'connect-source').click();
  await entered.promise;
  assert.equal(token.value, '');
  assert.equal(dialog.dismissDialog(), false);
  assert(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'GitHub source access').disabled);
  const cancelled = harness.connection.disconnect();
  gate.resolve();
  await cancelled;
  await wizard.whenIdle();
  assert.equal(harness.connection.connected, false);
  assert.equal(harness.routes.migrationSource.sessions.size, 0);
  assert.equal(button(wizard, 'read-github'), null);
  assert(find(wizard.body, (node) => node.getAttribute?.('role') === 'alert'));
  assert(!readText(wizard.body).includes(harness.token));
  assert(harness.sessions.resolve(harness.destination.id).token === harness.destinationToken);
  await press(wizard, 'close');
});

test('migration actual controller wizard erases authenticated access before an explicit public-mode change and invalidates review', async () => {
  const harness = authenticatedHarness();
  const { wizard, downloads } = await open({ harness, wizard: { sourceConnection: harness.connection } });
  await actualPair(wizard, harness);
  await review(wizard);
  await press(wizard, 'export-history');
  const reviewId = JSON.parse(downloads.at(-1).text).reports[0].reviewId;
  await press(wizard, 'another-target');
  await press(wizard, 'change-source');
  await access(wizard, 'public');
  assert.equal(harness.connection.connected, false);
  assert.equal(harness.routes.migrationSource.sessions.size, 0);
  assert.equal(wizard.step, 'donor');
  assert.equal(button(wizard, 'map'), null);
  await assert.rejects(harness.session.apply(reviewId, { reviewed: true }), { code: 'review' });
  assert.match(readText(wizard.body), /Reviewed per-file name reports \(1\)/);
  assert(harness.sessions.resolve(harness.destination.id).token === harness.destinationToken);
  assert.deepEqual(harness.vaultWrites, []);
  await press(wizard, 'close');
});
