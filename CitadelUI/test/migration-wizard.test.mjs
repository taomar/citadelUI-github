import assert from 'node:assert/strict';
import test, { before, beforeEach, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { openMigrationWizard } from '../web/js/migration-wizard.mjs';
import { MIGRATION_AREAS, MigrationSession } from '../web/js/migration-session.mjs';
import { MigrationError } from '../shared/migration-input.mjs';
import { CURRENT, LEGACY, SCHEMA, TEMPLATE, deferred, migrationHarness as baseMigrationHarness, MigrationFileHandle, TARGET, useSnapshotTestRequest } from './_migration-fixture.mjs';
import { PUBLIC_FILE, PUBLIC_REPO, PUBLIC_SCHEMA, PUBLIC_TEMPLATE, PUBLIC_TEXT, publicHarness } from './_migration-public-fixture.mjs';
import { authenticatedHarness } from './_migration-auth-fixture.mjs';
import { serializeValue } from '../shared/bicepparam/serialize.mjs';
import { isolatedSnapshotApp } from './_migration-snapshot-fixture.mjs';
import { SNAPSHOT_ENDPOINT } from '../shared/migration-snapshot.mjs';
import { LocalTransactionCoordinator } from '../web/js/mutation-coordinator.mjs';
import { createTransactionCommit } from '../web/js/transaction-client.mjs';
import { readBicepParameters } from '../shared/migration-input.mjs';
import {
  JOURNEY_MAIN, JOURNEY_LLM, JOURNEY_FINANCE, JOURNEY_SUPPORT, JOURNEY_OLD_SECOND,
  journeyTargetFiles, journeySourceFiles, journeyNewBackends, journeyOldBackends, oldAlias,
} from './_migration-journey-data.mjs';

let snapshotApp;
const cleanup = [];
before(async () => {
  snapshotApp = await isolatedSnapshotApp({ after: (fn) => cleanup.push(fn) });
  useSnapshotTestRequest(snapshotApp.request);
});
beforeEach(async () => {
  for (const source of (await snapshotApp.request(SNAPSHOT_ENDPOINT)).sources) {
    await snapshotApp.request(`${SNAPSHOT_ENDPOINT}/${source.id}/delete`, { method: 'POST', body: '{}' });
  }
});
after(async () => { for (const fn of cleanup) await fn(); useSnapshotTestRequest(undefined); });

const SOURCE = `older/${TARGET}`;
function migrationHarness(options = {}) {
  const harness = baseMigrationHarness({
    ...options,
    donorFiles: options.donorFiles || { [SOURCE]: options.donorText ?? LEGACY },
  });
  harness.plan = (extra = {}) => harness.session.plan({ donor: harness.donor, sourceIds: [SOURCE], targetAlias: TARGET, ...extra });
  return harness;
}

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
  input(wizard, 'Migration area', 'deployment');
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
  const decision = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  assert(decision && !decision.disabled);
  decision.checked = true;
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
  assert.match(readText(wizard.body), /Old-only parameters absent from this current target: removed/);
  await review(wizard);
  assert.match(readText(wizard.body), /1 change to import/);
  assert.match(readText(wizard.body), /Nothing has been copied/);
  assert.match(readText(wizard.body), /not deployment-ready certification/);
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
    targetFiles: { [TARGET]: CURRENT, [TEMPLATE]: SCHEMA, [llm]: journeyTargetFiles[llm], [llm.replace(/\.bicepparam$/, '.bicep')]: 'param llmBackendConfig array\n' },
    donorFiles: { [SOURCE]: LEGACY, [`older/${llm}`]: journeySourceFiles[oldAlias(llm)] },
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
  assert.equal(wizard.session.view().rows[0].structured.summary.selectedFields, 0);
  await assert.rejects(harness.session.apply(oldReviewId, { reviewed: true }), { code: 'review' });
  proposeBackend(wizard, 'aaif-new', 'aif-old');
  confirmBackend(wizard);
  selectImport(wizard, 'Capacity for aaif-new / chat');
  await press(wizard, 'preview');
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
  assert.match(readText(wizard.body), /1 target-only parameter kept/);
  assert.doesNotMatch(readText(wizard.body), /DO_NOT_DISPLAY/);
  const decision = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  assert(decision.disabled);
  await press(wizard, 'preview');
  assert.equal(wizard.step, 'review');
  assert.equal(harness.api.trace.length, 0);
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

test('target editor conflicts revoke preview authority but retain source and selected choices for retry', async () => {
  const { wizard, harness, downloads } = await open();
  await pair(wizard);
  await review(wizard);
  harness.state.pending = true;
  await press(wizard, 'export-draft');
  assert.equal(wizard.step, 'map');
  assert.match(readText(wizard.body), /does not overwrite drafts/);
  assert.equal(downloads.length, 0);
  assert.equal(harness.api.trace.length, 0);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').checked, true);
  harness.state.pending = false;
  await press(wizard, 'preview');
  await press(wizard, 'export-draft');
  assert.equal(downloads.length, 1);
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
  const decision = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  assert.equal(decision.checked, false);
  assert.equal(harness.api.trace.length, 0);
});

test('destination-led checkboxes retain rows, preview selected values, and undo prior accepts on uncheck/discard', async () => {
  const harness = migrationHarness({
    targetText: "using './main.bicep'\nparam Count = 2\nparam newOnly = true\n",
    schemaText: 'param Count int\nparam newOnly bool\nparam schemaOnly int = 3\n',
    donorText: 'param count = 4\nparam schemaOnly = 5\nparam oldOnly = true\n',
  });
  const { wizard } = await open({ harness });
  await pair(wizard);
  input(wizard, 'Comparison view', 'all');
  const editable = () => findAll(wizard.body, (node) => node.getAttribute?.('aria-label')?.startsWith('Import '));
  assert.deepEqual(editable().map((node) => node.getAttribute('aria-label')), ['Import Count', 'Import newOnly']);
  assert(editable().every((node) => !node.checked));
  const setCount = (checked) => {
    const box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
    box.checked = checked;
    box.dispatch('change');
  };
  setCount(true);
  assert.equal(editable().length, 2, 'marking an import must not hide other new parameters');
  await press(wizard, 'preview');
  assert.match(readText(wizard.body), /1 change to import/);
  await press(wizard, 'back');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').checked, true);
  setCount(false);
  await press(wizard, 'preview');
  assert.match(readText(wizard.body), /Nothing will change/);
  assert.doesNotMatch(readText(wizard.body), /Selected-value diff/);
  await press(wizard, 'back');
  setCount(true);
  await press(wizard, 'discard-changes');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').checked, false);
  assert.equal(harness.api.trace.length, 0);
});

test('matching identical parameters are kept out of the default review and can be inspected explicitly', async () => {
  const { wizard } = await open({ harness: migrationHarness({ donorText: 'param count = 2\n' }) });
  await pair(wizard);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Comparison view').value, 'differences');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count'), null);
  assert.match(readText(wizard.body), /1 identical parameter kept unchanged/);
  assert.match(readText(wizard.body), /Nothing needs importing in this target/);
  input(wizard, 'Comparison view', 'same');
  const box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  assert(box);
  assert.equal(box.checked, false);
  assert.match(readText(wizard.body), /Already same · kept/);
  input(wizard, 'Comparison view', 'all');
  assert(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import newDefault'));
});

test('unknown old layouts remain explicitly selectable by matching actual new-file names', async () => {
  const harness = migrationHarness({ donorFiles: { 'archive/custom-values.bicepparam': 'param cOuNt = 6\nparam oldOnly = true\n' } });
  const { wizard } = await open({ harness });
  await press(wizard, 'choose-folder');
  input(wizard, 'Migration area', 'deployment');
  input(wizard, 'Destination parameter file', TARGET);
  const chooser = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Other old parameter file');
  assert(chooser && !chooser.disabled);
  input(wizard, 'Other old parameter file', 'archive/custom-values.bicepparam');
  await press(wizard, 'use-other-source');
  input(wizard, 'Migration area', 'llm-onboarding');
  input(wizard, 'Migration area', 'deployment');
  assert.equal(sourceControls(wizard).find((node) => node.dataset.sourceAlias === 'archive/custom-values.bicepparam').checked, true,
    'broadening the filter must retain an explicitly selected unclassified source');
  await press(wizard, 'map');
  assert.match(readText(wizard.body), /Source \(old\): cOuNt/);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').disabled, false);
  assert.equal(harness.api.trace.length, 0);
});

test('structured LLM review confirms backend pairing and persists model-field choices through preview and back', async () => {
  const path = 'bicep/infra/llm-backend-onboarding/main.bicepparam';
  const backend = (id, capacity) => ({
    backendId: id, backendType: 'ai-foundry', endpoint: `https://${id}.example.invalid/`,
    authType: 'managed-identity', supportedModels: [{ name: 'chat', modelVersion: '1', capacity }],
  });
  const harness = migrationHarness({
    targetFiles: {
      [path]: `using './main.bicep'\nparam llmBackendConfig = ${serializeValue([backend('aaif-new', 50)])}\n`,
      [path.replace(/\.bicepparam$/, '.bicep')]: 'param llmBackendConfig array\n',
    },
    donorFiles: { [`older/${path}`]: `param llmBackendConfig = ${serializeValue([backend('aif-old', 90)])}\n` },
  });
  const { wizard } = await open({ harness });
  await press(wizard, 'choose-folder');
  input(wizard, 'Migration area', 'llm-onboarding');
  input(wizard, 'Destination parameter file', path);
  toggleSource(wizard, `older/${path}`, true);
  await press(wizard, 'map');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import llmBackendConfig'), null);
  const chooser = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Old backend for aaif-new');
  assert.equal(chooser.value, '');
  const option = chooser.children.find((node) => node.value && !node.disabled);
  input(wizard, 'Old backend for aaif-new', option.value);
  const confirm = find(wizard.body, (node) => node.tagName === 'BUTTON' && readText(node) === 'Confirm backend pairing');
  assert(!confirm.disabled);
  confirm.click();
  const label = 'Import Capacity for aaif-new / chat';
  let box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === label);
  assert(box && !box.checked && !box.disabled);
  wizard.body.parentElement.scrollTop = 300;
  box.checked = true;
  box.dispatch('change');
  assert.equal(wizard.body.parentElement.scrollTop, 300);
  assert.equal(document.activeElement.getAttribute('aria-label'), label);
  await press(wizard, 'preview');
  assert.match(readText(wizard.body), /aaif-new \/ chat \/ Capacity/);
  assert.match(readText(wizard.body), /90/);
  await press(wizard, 'back');
  box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === label);
  assert(box.checked);
  box.checked = false;
  box.dispatch('change');
  await press(wizard, 'preview');
  assert.match(readText(wizard.body), /Nothing will change/);
  assert.equal(harness.api.trace.length, 0);
});

test('cancel confirms only staged value imports and cancellation keeps the same wizard decisions', async () => {
  let confirmations = 0;
  const { wizard, dialog } = await open({ wizard: { confirm: async () => { confirmations += 1; return false; } } });
  await pair(wizard);
  const box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  box.checked = true;
  box.dispatch('change');
  await press(wizard, 'close');
  assert.equal(confirmations, 1);
  assert(dialog.modal.open);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').checked, true);
  await press(wizard, 'discard-changes');
  await press(wizard, 'close');
  assert.equal(confirmations, 1);
  assert.equal(dialog.modal.open, false);
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
    snapshotRequest: snapshotApp.request,
  });
  const { wizard, downloads } = await open({ harness });
  assert.match(readText(wizard.body), /synthetic\/current/);
  assert.match(readText(wizard.body), /review-branch/);
  assert.match(readText(wizard.body), /No remote writes or commits/);
  await pair(wizard);
  await press(wizard, 'preview');
  assert.match(readText(wizard.body), /Nothing will change/);
  assert.match(readText(wizard.body), /Preview\/export only/);
  assert.doesNotMatch(readText(wizard.body), /Local apply is blocked|Selected-value diff/);
  assert.equal(button(wizard, 'apply'), null);
  await press(wizard, 'back');
  await review(wizard);
  assert.equal(button(wizard, 'apply'), null);
  await press(wizard, 'export-draft');
  assert.equal(downloads.length, 1);
  assert.equal(writes, 0);
});

test('migration wizard malformed donor errors are surfaced during discovery without exposing source contents', async () => {
  const { wizard, harness } = await open({ wizard: {
    chooseFiles: async () => [new MigrationFileHandle('broken.bicepparam', "param count = 'SYNTHETIC_PRIVATE_MARKER\n")],
  } });
  await press(wizard, 'choose-files');
  assert.match(readText(wizard.body), /No usable parameter inputs were captured/);
  assert.doesNotMatch(readText(wizard.body), /SYNTHETIC_PRIVATE_MARKER/);
  assert.equal(harness.api.trace.length, 0);
  assert.equal(button(wizard, 'map'), null);
  assert.equal(find(wizard.body, (node) => node.dataset?.sourceId), null);
});

test('migration wizard reports absent configuration without offering template or module stand-ins', async () => {
  const harness = migrationHarness({ donorFiles: {
    'bicep/infra/citadel-access-contracts/main.bicepparam': 'param useCase = {}\n',
    'bicep/infra/citadel-access-contracts/base-contracts/common/main.bicepparam': 'param useCase = {}\n',
  } });
  const { wizard } = await open({ harness });
  await press(wizard, 'choose-folder');
  assert.equal(wizard.step, 'donor');
  assert.match(readText(wizard.body), /No usable parameter inputs were captured/);
  assert.equal(find(wizard.body, (node) => node.dataset?.sourceId), null);
  assert.equal(button(wizard, 'map'), null);
  const targets = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Destination parameter file');
  assert.equal(targets, null);
  assert.equal(harness.api.trace.length, 0);
});

test('migration wizard announces local source read failures and clears the error on a successful retry', async () => {
  const file = new MigrationFileHandle('main.bicepparam', 'param Count = 4\n');
  const read = file.getFile.bind(file);
  let denied = true;
  file.getFile = async () => {
    if (denied) throw new DOMException('SYNTHETIC_PRIVATE_MARKER', 'NotReadableError');
    return read();
  };
  const { wizard, harness } = await open({ wizard: { chooseFiles: async () => [file] } });
  await press(wizard, 'choose-files');
  const error = find(wizard.body, (node) => node.getAttribute?.('role') === 'alert');
  assert(error);
  assert.match(readText(error), /could not be read/);
  assert.doesNotMatch(readText(wizard.body), /SYNTHETIC_PRIVATE_MARKER/);
  assert.equal(wizard.step, 'donor');
  denied = false;
  await press(wizard, 'choose-files');
  assert.equal(wizard.step, 'pair');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('role') === 'alert'), null);
  assert.equal(harness.api.trace.length, 0);
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
  if (label === 'Migration area') {
    const control = button(wizard, `area-${value}`);
    assert(control, `missing area navigation ${value}`);
    assert.equal(control.disabled, false);
    control.focus();
    control.click();
    return;
  }
  const field = find(wizard.body, (node) => node.getAttribute?.('aria-label') === label);
  assert(field, `missing field ${label}`);
  field.value = label === 'Other old parameter file'
    ? field.children.find((option) => readText(option).startsWith(`${value} ·`))?.value || value : value;
  field.dispatch(field.tagName === 'SELECT' ? 'change' : 'input');
}

async function publicPair(wizard) {
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', `https://github.com/${PUBLIC_REPO}`);
  await press(wizard, 'find-repository');
  const ref = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch');
  assert.equal(ref.value, '', 'repository metadata must not choose the default branch');
  assert.equal(ref.tagName, 'SELECT');
  input(wizard, 'Source branch', 'legacy-main');
  await press(wizard, 'read-github');
  input(wizard, 'Migration area', 'deployment');
  input(wizard, 'Destination parameter file', TARGET);
  const source = find(wizard.body, (node) => node.dataset?.sourceAlias === PUBLIC_FILE);
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

test('proposed source ref changes retain the complete source and every choice until successful confirmed replacement', async () => {
  const harness = publicHarness();
  harness.github.seed('different-ref', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA });
  const { wizard } = await open({ harness, wizard: { publicRequest: harness.request } });
  await publicPair(wizard);
  await review(wizard);
  const snapshotId = wizard.session.view().donor.id;
  await press(wizard, 'change-source');
  await press(wizard, 'choose-github');
  input(wizard, 'Source branch', 'different-ref');
  assert.equal(wizard.step, 'donor');
  assert.equal(button(wizard, 'map'), null);
  assert.match(readText(wizard.body), /does not change the current copy or any target drafts/);
  await press(wizard, 'return-source');
  assert.equal(wizard.step, 'review');
  assert.equal(wizard.session.view().donor.id, snapshotId);
  await press(wizard, 'back');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').checked, true);
  assert.equal(harness.api.trace.length, 0);
});

test('complete source exports without quota; an explicit failed refresh preserves source, choices and preview', async () => {
  const harness = publicHarness();
  const { wizard, downloads } = await open({ harness, wizard: { publicRequest: harness.request } });
  await publicPair(wizard);
  await review(wizard);
  const snapshotId = wizard.session.view().donor.id;
  const before = harness.github.calls.length;
  harness.github.overrides.set('/repositories/8001', (github) =>
    github.json(403, { message: 'SYNTHETIC_PRIVATE_MARKER' }, { 'x-ratelimit-remaining': '0' }));
  await press(wizard, 'export-draft');
  assert.equal(wizard.step, 'review');
  assert.equal(harness.github.calls.length, before, 'export does not query the old source');
  assert.equal(downloads.length, 1);
  harness.github.overrides.set(`/repos/${PUBLIC_REPO}`, (github) =>
    github.json(403, { message: 'SYNTHETIC_PRIVATE_MARKER' }, { 'x-ratelimit-remaining': '0' }));
  await press(wizard, 'refresh-source');
  assert.equal(wizard.step, 'donor');
  assert.match(readText(wizard.body), /Anonymous GitHub rate limit reached/);
  assert.doesNotMatch(readText(wizard.body), /SYNTHETIC_PRIVATE_MARKER/);
  assert.equal(button(wizard, 'map'), null);
  await press(wizard, 'return-source');
  assert.equal(wizard.step, 'review');
  assert.equal(wizard.session.view().donor.id, snapshotId);
  await press(wizard, 'export-draft');
  assert.equal(downloads.length, 2);
  assert.match(downloads.at(-1).text, /Count = 4/);
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
  await press(wizard, 'choose-github');
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

test('migration wizard exposes only discovered three-area configurations and retains separate reports', async () => {
  const targets = [
    [TARGET, 'deployment'],
    ['bicep/infra/llm-backend-onboarding/main.bicepparam', 'llm-onboarding'],
    ['bicep/infra/citadel-access-contracts/synthetic-instance/main.bicepparam', 'access-contracts'],
    ['bicep/infra/citadel-access-contracts/another-instance/main.bicepparam', 'access-contracts'],
  ];
  const targetFiles = Object.fromEntries(targets.flatMap(([alias, area]) => [
    [alias, `using './current.bicep'\n${area === 'llm-onboarding'
      ? `param llmBackendConfig = ${serializeValue(journeyNewBackends)}`
      : area === 'access-contracts' ? "param useCase = { name: 'existing' }\nparam productName = 'new-contract'" : 'param Count = 2'}\n`],
    [alias.replace(/[^/]+$/, 'current.bicep'), area === 'llm-onboarding' ? 'param llmBackendConfig array\n'
      : area === 'access-contracts' ? 'param useCase object\nparam productName string\n' : 'param Count int\n'],
  ]));
  const irrelevant = [
    'bicep/infra/apim-gateway-upgrade/main.bicepparam',
    'bicep/infra/app-insights-alert/main.bicepparam',
    'bicep/infra/citadel-access-contracts/main.bicepparam',
    'bicep/infra/citadel-access-contracts/base-contracts/common/main.bicepparam',
    'bicep/infra/citadel-publish-contracts/main.bicepparam',
    'bicep/infra/foundry-integration/main.bicepparam',
  ];
  const donorFiles = Object.fromEntries([
    ...targets.map(([alias, area]) => [`older/${alias}`, area === 'llm-onboarding'
      ? `param llmBackendConfig = ${serializeValue(journeyOldBackends)}\n`
      : area === 'access-contracts' ? "param useCase = { name: 'old' }\nparam productName = 'old-contract'\n" : 'param count = 4\n']),
    ...irrelevant.map((alias) => [alias, 'param count = 4\n']),
  ]);
  const harness = migrationHarness({ targetFiles, donorFiles });
  const { wizard, downloads } = await open({ harness });
  await press(wizard, 'choose-folder');
  const areaNav = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Migration areas');
  for (const area of MIGRATION_AREAS) assert.match(readText(areaNav), new RegExp(area.label));
  assert.equal(MIGRATION_AREAS.length, 3);
  assert.doesNotMatch(sourceControls(wizard).map((node) => node.dataset.sourceId).join('\n'),
    /same filename|app-insights-alert|apim-gateway-upgrade|foundry-integration|base-contracts/);
  const otherFiles = find(wizard.body, (node) => node.tagName === 'DETAILS' && readText(node.children[0]).includes('Other old parameter files'));
  assert.equal(otherFiles.open, false, 'unclassified file selection is on demand, not primary inventory noise');
  for (const [alias, area] of targets) {
    input(wizard, 'Migration area', area);
    assert.equal(button(wizard, `area-${area}`).getAttribute('aria-current'), 'page');
    const targetSelect = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Destination parameter file');
    assert(targetSelect.children.filter((node) => node.value).every((node) =>
      targets.some(([path, kind]) => path === node.value && kind === area)));
    const sources = findAll(wizard.body, (node) => node.dataset?.sourceId);
    assert(sources.length > 0);
    assert(sources.every((node) => node.dataset.sourceArea === area));
    assert(sources.every((node) => !node.checked), 'a new target starts with its own explicit source pairing');
    assert.equal(targetSelect.value, '', 'Review another file opens a fresh target slot without discarding earlier drafts');
    input(wizard, 'Destination parameter file', alias);
    const source = find(wizard.body, (node) => node.dataset?.sourceId);
    assert.equal(Boolean(source.checked), false, 'each new target requires explicit donor pairing');
    source.checked = true;
    source.dispatch('change');
    await press(wizard, 'map');
    const names = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Per-file parameter name report');
    assert.match(readText(names), /Old-only parameters absent from this current target: None/);
    if (area === 'llm-onboarding') {
      proposeBackend(wizard, 'aaif-new', 'aif-old');
      confirmBackend(wizard);
      selectImport(wizard, 'Capacity for aaif-new / chat');
      await press(wizard, 'preview');
    } else if (area === 'access-contracts') {
      selectImport(wizard, 'productName');
      await press(wizard, 'preview');
    } else await review(wizard);
    if (alias !== targets.at(-1)[0]) await press(wizard, 'another-target');
  }
  await press(wizard, 'export-history');
  const reports = JSON.parse(downloads.at(-1).text).reports;
  assert.deepEqual(reports.map((report) => report.pairs[0].target.file), targets.map(([alias]) => alias));
  assert(reports.every((report) => report.status === 'preview-only' && report.pairs[0].oldOnlyNames.length === 0));
  assert(reports.every((report) => report.classification.matched > 0 &&
    report.summary.proposedEdits === 1 && report.summary.copied === 0));
  assert.doesNotMatch(downloads.at(-1).text, /"value":|"rows":/);
  assert.equal(harness.api.trace.length, 0);
});

async function openMixedSelection(options = {}) {
  const llm = 'bicep/infra/llm-backend-onboarding/main.bicepparam';
  const otherDeployment = `previous/${TARGET}`;
  const llmSource = `older/${llm}`;
  const harness = migrationHarness({
    targetFiles: {
      [TARGET]: "using './current.bicep'\nparam Count = 2\n",
      [TARGET.replace(/[^/]+$/, 'current.bicep')]: 'param Count int\n',
      [llm]: journeyTargetFiles[llm],
      [llm.replace(/\.bicepparam$/, '.bicep')]: 'param llmBackendConfig array\n',
    },
    donorFiles: {
      [SOURCE]: 'param count = 4\n',
      [otherDeployment]: 'param count = 5\n',
      [llmSource]: journeySourceFiles[oldAlias(llm)],
    },
  });
  const context = await open({ ...options, harness });
  await press(context.wizard, 'choose-folder');
  return { ...context, llm, otherDeployment, llmSource };
}

function sourceControls(wizard) {
  return findAll(wizard.body, (node) => node.dataset?.sourceId);
}

function toggleSource(wizard, id, checked) {
  const control = sourceControls(wizard).find((node) => node.dataset.sourceAlias === id);
  assert(control, `missing source ${id}`);
  assert.equal(control.disabled, false, `disabled source ${id}`);
  control.checked = checked;
  control.dispatch('change');
}

test('migration area navigation retains separate source selections and destinations without confirmation', async () => {
  let confirmations = 0;
  const { wizard, llm, otherDeployment, llmSource } = await openMixedSelection({
    wizard: { confirm: async () => { confirmations += 1; return true; } },
  });
  const target = () => find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Destination parameter file');
  assert.equal(sourceControls(wizard).length, 2);
  assert.equal(wizard.area, 'deployment');
  toggleSource(wizard, SOURCE, true);
  input(wizard, 'Destination parameter file', TARGET);
  toggleSource(wizard, otherDeployment, true);
  input(wizard, 'Migration area', 'llm-onboarding');
  assert.equal(wizard.area, 'llm-onboarding');
  assert.equal(sourceControls(wizard).length, 1);
  assert.equal(target().value, '');
  toggleSource(wizard, llmSource, true);
  input(wizard, 'Destination parameter file', llm);
  input(wizard, 'Migration area', 'deployment');
  assert.equal(target().value, TARGET);
  assert.deepEqual(sourceControls(wizard).filter((node) => node.checked).map((node) => node.dataset.sourceAlias).sort(),
    [SOURCE, otherDeployment].sort());
  input(wizard, 'Migration area', 'llm-onboarding');
  assert.equal(target().value, llm);
  assert.equal(sourceControls(wizard)[0].checked, true);
  await press(wizard, 'clear-sources');
  assert(sourceControls(wizard).every((node) => !node.checked && !node.disabled));
  assert.equal(target().value, llm);
  input(wizard, 'Migration area', 'deployment');
  assert.equal(sourceControls(wizard).filter((node) => node.checked).length, 2);
  input(wizard, 'Migration area', 'access-contracts');
  assert.match(readText(wizard.body), /No eligible source configuration/);
  assert.equal(button(wizard, 'area-deployment').disabled, false);
  assert.equal(confirmations, 0);
});

test('migration preserves mapping and preview decisions independently while navigating areas', async () => {
  const { wizard, harness, llm, llmSource } = await openMixedSelection();
  toggleSource(wizard, SOURCE, true);
  input(wizard, 'Destination parameter file', TARGET);
  await press(wizard, 'map');
  let box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  box.checked = true;
  box.dispatch('change');
  await press(wizard, 'preview');
  assert.match(readText(wizard.body), /Target after import: 4/);
  input(wizard, 'Migration area', 'llm-onboarding');
  toggleSource(wizard, llmSource, true);
  input(wizard, 'Destination parameter file', llm);
  await press(wizard, 'map');
  proposeBackend(wizard, 'aaif-new', 'aif-old');
  confirmBackend(wizard);
  selectImport(wizard, 'Capacity for aaif-new / chat');
  await press(wizard, 'preview');
  assert.match(readText(wizard.body), /Target after import: 90/);
  input(wizard, 'Migration area', 'deployment');
  assert.equal(wizard.step, 'review');
  assert.match(readText(wizard.body), /Target after import: 4/);
  assert.deepEqual(wizard.session.view().pairs.map((pair) => pair.source.file), [SOURCE]);
  await press(wizard, 'back');
  await press(wizard, 'discard-changes');
  input(wizard, 'Migration area', 'llm-onboarding');
  assert.equal(wizard.step, 'review');
  assert.match(readText(wizard.body), /Target after import: 90/);
  assert.deepEqual(wizard.session.view().pairs.map((pair) => pair.source.file), [llmSource]);
  assert.equal(harness.api.trace.length, 0);
});

test('closing an empty area still protects pending choices in another area', async () => {
  let confirmations = 0;
  const { wizard, dialog } = await openMixedSelection({
    wizard: { confirm: async () => { confirmations += 1; return false; } },
  });
  toggleSource(wizard, SOURCE, true);
  input(wizard, 'Destination parameter file', TARGET);
  await press(wizard, 'map');
  const box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  box.checked = true;
  box.dispatch('change');
  input(wizard, 'Migration area', 'access-contracts');
  await press(wizard, 'close');
  assert.equal(confirmations, 1);
  assert.equal(dialog.modal.open, true);
  input(wizard, 'Migration area', 'deployment');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').checked, true);
});

test('migration value comparison labels old sources separately from the current new target', async () => {
  const { wizard } = await openMixedSelection();
  toggleSource(wizard, SOURCE, true);
  input(wizard, 'Destination parameter file', TARGET);
  await press(wizard, 'map');
  assert.match(readText(wizard.body), /Source \(old\) · read-only/);
  assert.match(readText(wizard.body), /Target \(new\) · values to keep or update/);
  const row = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'New parameter Count');
  const labels = findAll(row, (node) => node.classList?.contains('migration-cell-label')).map(readText);
  assert.deepEqual(labels, ['Target parameter (new)', 'Source value (old / previous)', 'Current target value (new)']);
  const box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  box.checked = true;
  box.dispatch('change');
  await press(wizard, 'preview');
  assert.match(readText(wizard.body), /Target before: 2/);
  assert.match(readText(wizard.body), /Target after import: 4/);
  assert.match(readText(wizard.body), /Source \(old\): older\/bicep\/infra\/main\.bicepparam/);
});

test('migration duplicate-source dropdown contains source files only and labels them as source', async () => {
  const { wizard, otherDeployment } = await openMixedSelection();
  toggleSource(wizard, SOURCE, true);
  toggleSource(wizard, otherDeployment, true);
  input(wizard, 'Destination parameter file', TARGET);
  await press(wizard, 'map');
  const chooser = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source (old) for Count');
  assert(chooser);
  assert.equal(readText(chooser.children[0]), 'Choose source (old) value…');
  assert(chooser.children.slice(1).every((node) => readText(node).startsWith('Source: count')));
});

test('resolving a source or unchecking an import does not remove the active filtered row', async () => {
  const { wizard, otherDeployment } = await openMixedSelection();
  toggleSource(wizard, SOURCE, true);
  toggleSource(wizard, otherDeployment, true);
  input(wizard, 'Destination parameter file', TARGET);
  await press(wizard, 'map');
  input(wizard, 'Comparison view', 'attention');
  const chooser = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source (old) for Count');
  input(wizard, 'Source (old) for Count', chooser.children[1].value);
  let box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  assert(box, 'a resolved row remains available for import selection');
  box.checked = true;
  box.dispatch('change');
  input(wizard, 'Comparison view', 'selected');
  box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  box.checked = false;
  box.dispatch('change');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').checked, false);
  assert.match(readText(wizard.body), /Edited rows stay visible/);
  await press(wizard, 'refresh-mapping-filter');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count'), null);
  input(wizard, 'Comparison view', 'all');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').checked, false);
});

test('migration reuses current editor sections and feature groups without hiding parameters', async () => {
  const targetText = [
    "using './main.bicep'",
    '// ============================================================================',
    '// BASIC PARAMETERS',
    '// ============================================================================',
    "param environmentName = 'new'",
    "param location = 'west'",
    '// ============================================================================',
    '// RESOURCE NAMES',
    '// ============================================================================',
    "param apimServiceName = 'new-service'",
    'param useExistingVnet = false',
    '// ============================================================================',
    '// FEATURE FLAGS',
    '// ============================================================================',
    'param enableAPICenter = false',
    '',
  ].join('\n');
  const harness = migrationHarness({
    targetText,
    schemaText: 'param environmentName string\nparam location string\nparam apimServiceName string\nparam useExistingVnet bool\nparam enableAPICenter bool\n',
    donorText: "param environmentName = 'old'\nparam location = 'east'\nparam apimServiceName = 'old-service'\nparam useExistingVnet = true\nparam enableAPICenter = true\n",
  });
  const { wizard } = await open({ harness });
  await pair(wizard);
  const sections = wizard.session.view().sections;
  assert.deepEqual(sections.map((section) => section.label), ['Basics', 'Features', 'Resources']);
  assert.deepEqual(sections.map((section) => section.title), ['Basics', 'Features', 'Resources']);
  const features = sections.find((section) => section.label === 'Features');
  assert.deepEqual(features.groups.map((group) => group.label), ['Data, safety & governance', 'Network topology']);
  const groups = findAll(wizard.body, (node) => node.classList?.contains('migration-parameter-section'));
  assert.equal(groups.length, 3);
  assert.match(readText(groups[1]), /useExistingVnet/);
  assert.doesNotMatch(readText(groups[2]), /useExistingVnet/);
  const imports = findAll(wizard.body, (node) => node.getAttribute?.('aria-label')?.startsWith('Import '));
  assert.equal(imports.length, 5);
  assert.equal(new Set(imports.map((node) => node.getAttribute('aria-label'))).size, 5);
  assert(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Target parameter sections'));
});

test('runtime expressions are clearly unavailable rather than invented previous or current values', async () => {
  const expression = "readEnvironmentVariable('SYNTHETIC_RUNTIME_NAME')";
  const harness = migrationHarness({
    targetText: `using './main.bicep'\nparam Count = ${expression}\n`,
    schemaText: 'param Count string\n',
    donorText: `param count = ${expression}\n`,
  });
  const { wizard } = await open({ harness });
  await pair(wizard);
  assert.match(readText(wizard.body), /No importable differences/);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count'), null);
  await press(wizard, 'inspect-unresolved');
  const cells = findAll(wizard.body, (node) => node.classList?.contains('migration-value-cell'));
  assert(cells.every((cell) => readText(cell).includes('Its value is not available for comparison.')));
  assert(cells.every((cell) => !readText(cell).includes('[withheld')));
  assert.doesNotMatch(readText(wizard.body), /SYNTHETIC_RUNTIME_NAME/);
  assert.match(readText(wizard.body), /Migration does not evaluate functions, variables or environment-specific inputs/);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').disabled, true);
});

test('revise from preview reopens a collapsed target parameter section', async () => {
  const { wizard } = await open();
  await pair(wizard);
  const box = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  box.checked = true;
  box.dispatch('change');
  const row = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'New parameter Count');
  const section = find(wizard.body, (node) => node.classList?.contains('migration-parameter-section'));
  section.open = false;
  section.dispatch('toggle');
  await press(wizard, 'preview');
  await press(wizard, `revise-${row.dataset.row}`);
  assert.equal(wizard.step, 'map');
  assert.equal(find(wizard.body, (node) => node.classList?.contains('migration-parameter-section')).open, true);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count').checked, true);
});

test('migration same-stage changes preserve scroll and focus without scrolling controls into view', async () => {
  const { wizard } = await openMixedSelection();
  const scroller = wizard.body.parentElement;
  const replace = wizard.body.replaceChildren.bind(wizard.body);
  wizard.body.replaceChildren = (...children) => {
    replace(...children);
    scroller.scrollTop = 0;
  };
  scroller.scrollTop = 480;
  toggleSource(wizard, SOURCE, true);
  assert.equal(scroller.scrollTop, 480);
  assert.equal(document.activeElement, sourceControls(wizard).find((node) => node.dataset.sourceAlias === SOURCE));
  assert.deepEqual(document.activeElement.focusOptions, { preventScroll: true });
  input(wizard, 'Destination parameter file', TARGET);
  assert.equal(scroller.scrollTop, 480);
  assert.deepEqual(document.activeElement.focusOptions, { preventScroll: true });
  toggleSource(wizard, SOURCE, false);
  assert.equal(scroller.scrollTop, 480);
});

test('migration public wizard requires an explicit ref and never substitutes the repository default branch', async () => {
  const harness = publicHarness();
  harness.github.repository.default_branch = 'citadel-v1';
  const revision = harness.github.seed('main', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA });
  const { wizard } = await open({ harness, wizard: { publicRequest: harness.request } });
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', PUBLIC_REPO);
  await press(wizard, 'find-repository');
  const ref = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch');
  assert.equal(ref.value, '');
  assert(button(wizard, 'read-github').disabled);
  assert.equal(wizard.step, 'donor');
  assert.match(readText(wizard.body), /Select a source branch before reading/);
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

test('inline source preparation failures stay actionable and retry through the same visible control', async () => {
  const harness = publicHarness();
  const { wizard } = await open({ harness, wizard: { publicRequest: harness.request } });
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', PUBLIC_REPO);
  await press(wizard, 'find-repository');
  input(wizard, 'Source branch', 'legacy-main');
  const failedBlob = `/repos/${PUBLIC_REPO}/git/blobs/${harness.github.blobs.keys().next().value}`;
  harness.github.overrides.set(failedBlob, (github) => github.json(503, { message: 'synthetic unavailable' }));
  await press(wizard, 'prepare-source');
  assert.equal(wizard.step, 'donor');
  assert.equal(wizard.busy, false);
  assert.equal(button(wizard, 'prepare-source').disabled, false);
  assert.equal(button(wizard, 'read-github').disabled, false);
  assert(find(wizard.body, (node) => node.getAttribute?.('role') === 'alert'));
  assert.match(readText(wizard.body), /Preparation did not complete.*Existing saved sources and target drafts are unchanged/);
  assert.equal((await wizard.session.preparedSources()).length, 0);
  harness.github.overrides.delete(failedBlob);
  await press(wizard, 'prepare-source');
  assert.equal(wizard.step, 'pair');
  assert.equal((await wizard.session.preparedSources()).length, 1);
});

test('manual source refs update both preparation actions without replacing the typed input', async () => {
  const harness = publicHarness();
  harness.github.seed('old-tag', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA }, { tag: true });
  const { wizard } = await open({ harness, wizard: { publicRequest: harness.request } });
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', PUBLIC_REPO);
  input(wizard, 'Source ref type', 'tag');
  const ref = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA');
  assert.equal(button(wizard, 'prepare-source').disabled, true);
  assert.equal(button(wizard, 'read-github').disabled, true);
  input(wizard, 'Source branch, tag, or full commit SHA', 'old-tag');
  assert.equal(button(wizard, 'prepare-source').disabled, false);
  assert.equal(button(wizard, 'read-github').disabled, false);
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA'), ref);
  input(wizard, 'Source branch, tag, or full commit SHA', '');
  assert.equal(button(wizard, 'prepare-source').disabled, true);
  assert.equal(button(wizard, 'read-github').disabled, true);
  input(wizard, 'Source branch, tag, or full commit SHA', 'old-tag');
  await press(wizard, 'prepare-source');
  assert.equal(wizard.step, 'pair');
});

test('migration source Branch uses collected repository options while Tag and commit stay manually enterable', async () => {
  const harness = publicHarness();
  harness.github.seed('release/older', { [PUBLIC_FILE]: PUBLIC_TEXT });
  const { wizard } = await open({ harness, wizard: { publicRequest: harness.request } });
  await press(wizard, 'choose-github');
  const initial = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch');
  assert.equal(initial.tagName, 'SELECT');
  assert(initial.disabled);
  input(wizard, 'Source repository URL or owner/repo', PUBLIC_REPO);
  await press(wizard, 'find-repository');
  const branch = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch');
  assert.deepEqual(branch.children.map((node) => node.value), ['', 'legacy-main', 'release/older']);
  assert.equal(branch.value, '');
  input(wizard, 'Source branch', 'release/older');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch').value, 'release/older');
  assert.equal(button(wizard, 'read-github').disabled, false);
  input(wizard, 'Source ref type', 'tag');
  const tag = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA');
  assert.equal(tag.tagName, 'INPUT');
  assert.equal(tag.value, '');
  input(wizard, 'Source branch, tag, or full commit SHA', 'v-older');
  input(wizard, 'Source ref type', 'commit');
  const commit = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA');
  assert.equal(commit.tagName, 'INPUT');
  assert.equal(commit.value, '');
  input(wizard, 'Source branch, tag, or full commit SHA', 'a'.repeat(40));
  input(wizard, 'Source ref type', 'branch');
  await wizard.whenIdle();
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch').value, '');
  assert(button(wizard, 'read-github').disabled);
});

test('migration branch empty/error states are explicit and branch retry never selects a default', async () => {
  const harness = publicHarness();
  harness.github.refs.clear();
  const { wizard } = await open({ harness, wizard: { publicRequest: harness.request } });
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', PUBLIC_REPO);
  await press(wizard, 'find-repository');
  assert.match(readText(wizard.body), /no branches to select/);
  assert(button(wizard, 'read-github').disabled);
  harness.github.seed('release/added', { [PUBLIC_FILE]: PUBLIC_TEXT });
  await press(wizard, 'load-branches');
  input(wizard, 'Source branch', 'release/added');
  assert.equal(button(wizard, 'read-github').disabled, false);
  harness.github.overrides.set(`/repos/${PUBLIC_REPO}/branches`, (github) =>
    github.json(500, { message: 'SYNTHETIC_PRIVATE_MARKER' }));
  await press(wizard, 'load-branches');
  assert.match(readText(wizard.body), /Retry branches/);
  assert.doesNotMatch(readText(wizard.body), /SYNTHETIC_PRIVATE_MARKER/);
  assert(button(wizard, 'read-github').disabled);
  harness.github.overrides.delete(`/repos/${PUBLIC_REPO}/branches`);
  await press(wizard, 'load-branches');
  const branch = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch');
  assert.equal(branch.disabled, false);
  assert.equal(branch.value, '');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('role') === 'alert'), null);
});

for (const change of ['repository', 'refType']) {
  test(`migration branch lookup discards responses after ${change} changes`, async () => {
    const harness = publicHarness();
    const gate = deferred();
    const entered = deferred();
    harness.github.overrides.set(`/repos/${PUBLIC_REPO}/branches`, async (github) => {
      entered.resolve();
      await gate.promise;
      return github.json(200, [{ name: 'old-repository-branch', commit: { sha: 'a'.repeat(40) } }]);
    });
    const { wizard } = await open({ harness, wizard: { publicRequest: harness.request } });
    await press(wizard, 'choose-github');
    input(wizard, 'Source repository URL or owner/repo', PUBLIC_REPO);
    button(wizard, 'find-repository').click();
    await entered.promise;
    assert.match(readText(wizard.body), /Loading branches/);
    if (change === 'repository') input(wizard, 'Source repository URL or owner/repo', 'synthetic/another');
    else input(wizard, 'Source ref type', 'commit');
    gate.resolve();
    await wizard.whenIdle();
    assert.doesNotMatch(readText(wizard.body), /old-repository-branch/);
    if (change === 'repository') {
      assert(button(wizard, 'read-github').disabled);
      assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch').value, '');
    } else {
      assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source ref type').value, 'commit');
      assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA').value, '');
    }
  });
}

test('migration source access changes clear collected branches and their selected value', async () => {
  const harness = publicHarness();
  const { controller } = sourceConnectionStub();
  const { wizard } = await open({ harness, wizard: { publicRequest: harness.request, sourceConnection: controller } });
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', PUBLIC_REPO);
  await press(wizard, 'find-repository');
  input(wizard, 'Source branch', 'legacy-main');
  await access(wizard, 'token');
  await access(wizard, 'public');
  const branch = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch');
  assert.equal(branch.value, '');
  assert(branch.disabled);
  assert.equal(branch.children.length, 1);
  assert(button(wizard, 'read-github').disabled);
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
  assert.equal(document.activeElement, button(wizard, 'area-deployment'));
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

test('migration UI filters on input, preserves caret and decisions, and clears an empty worklist', async () => {
  const { wizard } = await open();
  await pair(wizard);
  const decision = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count');
  decision.checked = true;
  decision.dispatch('change');
  for (const value of ['no-match', 'a'.repeat(512), 'Co', '']) {
    const search = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Filter parameter names');
    search.focus();
    search.value = value;
    search.setSelectionRange(Math.min(1, value.length), value.length, 'backward');
    search.dispatch('input');
    const replacement = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Filter parameter names');
    assert.equal(document.activeElement, replacement);
    assert.equal(replacement.value, value);
    assert.deepEqual([replacement.selectionStart, replacement.selectionEnd, replacement.selectionDirection],
      [Math.min(1, value.length), value.length, 'backward']);
    if (value === 'no-match' || value.length > 100) assert.match(readText(wizard.body), /No parameter names match/);
    else assert(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count'));
  }
  assert(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import Count'));
  assert.equal(wizard.session.view().rows.find((row) => row.name === 'Count').decision.kind, 'accept');
});

test('migration source UI keeps PAT help outside its label and preserves the same password control and typed values', async () => {
  const { controller } = sourceConnectionStub();
  const { wizard } = await open({ wizard: { sourceConnection: controller } });
  await press(wizard, 'choose-github');
  input(wizard, 'Source repository URL or owner/repo', 'synthetic/source');
  input(wizard, 'Source ref type', 'tag');
  input(wizard, 'Source branch, tag, or full commit SHA', 'older-tag');
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
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch, tag, or full commit SHA').value, '',
    'changing source access clears the old ref while retaining the typed repository');
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
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source branch').value, '');
  input(wizard, 'Source branch', 'legacy-main');
  await press(wizard, 'read-github');
  assert.equal(wizard.step, 'pair', readText(wizard.body));
  input(wizard, 'Migration area', 'deployment');
  input(wizard, 'Destination parameter file', TARGET);
  const source = find(wizard.body, (node) => node.dataset?.sourceAlias === PUBLIC_FILE);
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

test('changing acquisition credentials erases only the live source session and retains the completed target review', async () => {
  const harness = authenticatedHarness();
  const { wizard, downloads } = await open({ harness, wizard: { sourceConnection: harness.connection } });
  await actualPair(wizard, harness);
  await review(wizard);
  await press(wizard, 'export-history');
  const reviewId = JSON.parse(downloads.at(-1).text).reports[0].reviewId;
  await press(wizard, 'another-target');
  await press(wizard, 'change-source');
  await press(wizard, 'choose-github');
  await access(wizard, 'public');
  assert.equal(harness.connection.connected, false);
  assert.equal(harness.routes.migrationSource.sessions.size, 0);
  assert.equal(wizard.step, 'donor');
  assert.equal(button(wizard, 'map'), null);
  await press(wizard, 'return-source');
  input(wizard, 'Destination parameter file', TARGET);
  assert.equal(wizard.step, 'review');
  const sourceCalls = harness.github.authCalls.length;
  await press(wizard, 'export-draft');
  assert.match(downloads.at(-1).text, /Count = 4/);
  assert.equal(harness.github.authCalls.length, sourceCalls);
  assert.match(readText(wizard.body), /Reviewed per-file name reports \(1\)/);
  assert(harness.sessions.resolve(harness.destination.id).token === harness.destinationToken);
  assert.deepEqual(harness.vaultWrites, []);
  await press(wizard, 'close');
});

function selectImport(wizard, name, checked = true) {
  const checkbox = find(wizard.body, (node) => node.getAttribute?.('aria-label') === `Import ${name}`);
  assert(checkbox && !checkbox.disabled, `importable ${name}`);
  checkbox.focus();
  checkbox.checked = checked;
  checkbox.dispatch('change');
}

function proposeBackend(wizard, backendId, sourceId) {
  const label = `Old backend for ${backendId}`;
  const select = find(wizard.body, (node) => node.getAttribute?.('aria-label') === label);
  const choice = select.children.find((option) => readText(option).startsWith(`${sourceId} ·`));
  assert(choice && !choice.disabled);
  input(wizard, label, choice.value);
}

function confirmBackend(wizard) {
  const button = find(wizard.body, (node) => node.tagName === 'BUTTON' && !node.disabled && /^Confirm backend pairing|^Confirm replacement/.test(readText(node)));
  assert(button && !button.disabled);
  button.click();
}

test('continuous realistic offline journey preserves two Access drafts, confirmed model choices and target-only transaction authority', async (t) => {
  let confirmations = 0;
  let allowReplacement = false;
  const harness = migrationHarness({ targetFiles: journeyTargetFiles, donorFiles: journeySourceFiles });
  harness.session = new MigrationSession({
    contextProvider: () => harness.context, registry: harness.registry, snapshotRequest: snapshotApp.request,
    coordinator: new LocalTransactionCoordinator({ request: snapshotApp.request, commitFiles: createTransactionCommit(snapshotApp.request) }),
  });
  const { wizard, downloads } = await open({ harness, wizard: {
    confirm: async ({ title }) => { confirmations += 1; return !title.includes('Replace') || allowReplacement; },
  } });
  await press(wizard, 'choose-folder');
  const originalReads = harness.donorTrace.length;
  const forbid = (handle) => {
    handle.queryPermission = handle.requestPermission = handle.isSameEntry = handle.resolve = async () => { throw new Error('Original handle use after capture'); };
    if (handle.kind === 'file') handle.getFile = async () => { throw new Error('Original file read after capture'); };
    else {
      handle.entries = async function* () { throw new Error('Original enumeration after capture'); };
      for (const child of handle.children.values()) forbid(child);
    }
  };
  forbid(harness.donorRoot);
  toggleSource(wizard, oldAlias(JOURNEY_MAIN), true);
  toggleSource(wizard, JOURNEY_OLD_SECOND, true);
  toggleSource(wizard, JOURNEY_OLD_SECOND, false);
  toggleSource(wizard, JOURNEY_OLD_SECOND, true);
  input(wizard, 'Destination parameter file', JOURNEY_MAIN);
  await press(wizard, 'map');
  const candidates = find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Source (old) for environmentName');
  input(wizard, 'Source (old) for environmentName', candidates.children[1].value);
  selectImport(wizard, 'environmentName');
  await press(wizard, 'preview');
  assert.equal(wizard.session.view().donor.revision.snapshotId.length, 36);
  assert.match(readText(wizard.body), /1 change to import/);
  assert(!button(wizard, 'apply').disabled, 'retained unrelated runtime dependencies do not block environmentName');
  await press(wizard, 'export-draft');
  const deploymentDraft = downloads.at(-1).text;

  input(wizard, 'Migration area', 'llm-onboarding');
  input(wizard, 'Destination parameter file', JOURNEY_LLM);
  toggleSource(wizard, oldAlias(JOURNEY_LLM), true);
  await press(wizard, 'map');
  proposeBackend(wizard, 'aaif-new', 'aif-old');
  confirmBackend(wizard);
  selectImport(wizard, 'Capacity for aaif-new / chat');
  const confirmed = wizard.session.view().rows[0].structured.backends.find((backend) => backend.backendId === 'aaif-new').confirmedSource;
  proposeBackend(wizard, 'aaif-new', 'old-other');
  let structured = wizard.session.view().rows[0].structured;
  assert.equal(structured.summary.selectedFields, 1);
  assert.equal(structured.backends.find((backend) => backend.backendId === 'aaif-new').confirmedSource, confirmed);
  assert.match(readText(wizard.body), /Confirmed source still in use: aif-old/);
  assert.match(readText(wizard.body), /1 target-only field/);
  await press(wizard, 'preview');
  await press(wizard, 'export-draft');
  const llmDraft = readBicepParameters(downloads.at(-1).text).parameters[0].value;
  const expected = structuredClone(journeyNewBackends);
  expected[1].supportedModels[1].capacity = 90;
  assert.deepEqual(JSON.parse(JSON.stringify(llmDraft)), expected);
  await press(wizard, 'back');
  proposeBackend(wizard, 'aaif-new', 'aif-old');
  await press(wizard, 'preview');

  input(wizard, 'Migration area', 'access-contracts');
  input(wizard, 'Destination parameter file', JOURNEY_FINANCE);
  toggleSource(wizard, oldAlias(JOURNEY_FINANCE), true);
  await press(wizard, 'map');
  selectImport(wizard, 'productName');
  await press(wizard, 'preview');
  const financeSession = wizard.session;
  input(wizard, 'Destination parameter file', JOURNEY_SUPPORT);
  assert.equal(wizard.step, 'pair');
  assert(sourceControls(wizard).every((checkbox) => !checkbox.checked));
  toggleSource(wizard, oldAlias(JOURNEY_SUPPORT), true);
  await press(wizard, 'map');
  selectImport(wizard, 'productName');
  await press(wizard, 'preview');
  input(wizard, 'Destination parameter file', JOURNEY_FINANCE);
  assert.equal(wizard.session, financeSession);
  assert.equal(wizard.step, 'review');
  assert.match(readText(wizard.body), /finance-old/);
  await press(wizard, 'back');
  await press(wizard, 'pair');
  assert.match(readText(wizard.body), /saved draft.*retained/i);
  toggleSource(wizard, oldAlias(JOURNEY_FINANCE), false);
  toggleSource(wizard, oldAlias(JOURNEY_SUPPORT), true);
  await press(wizard, 'map');
  assert.equal(wizard.step, 'map');
  assert.deepEqual(wizard.session.view().pairs.map((pair) => pair.source.file), [oldAlias(JOURNEY_FINANCE)], 'declined replacement restores the named target draft');
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import productName').checked, true);
  selectImport(wizard, 'productName', false);
  await press(wizard, 'preview');
  assert.match(readText(wizard.body), /Nothing will change/);
  input(wizard, 'Destination parameter file', JOURNEY_SUPPORT);
  assert.equal(wizard.step, 'review');
  assert.match(readText(wizard.body), /support-old/);

  input(wizard, 'Migration area', 'deployment');
  assert.equal(wizard.step, 'review');
  await press(wizard, 'export-draft');
  assert.equal(downloads.at(-1).text, deploymentDraft);
  const targetFile = await harness.provider.fileHandle(JOURNEY_MAIN);
  const read = targetFile.getFile.bind(targetFile);
  targetFile.getFile = async () => { throw new Error('Synthetic target connection failure'); };
  await press(wizard, 'export-draft');
  assert.equal(wizard.step, 'map');
  assert.match(readText(wizard.body), /current target could not be revalidated/);
  targetFile.getFile = read;
  assert.equal(find(wizard.body, (node) => node.getAttribute?.('aria-label') === 'Import environmentName').checked, true);
  await press(wizard, 'preview');
  await press(wizard, 'apply');
  const finalMain = (await harness.provider.read(JOURNEY_MAIN)).text;
  assert.equal(finalMain, journeyTargetFiles[JOURNEY_MAIN].replace("'new-environment'", "'resolved-old'"));
  const history = await snapshotApp.request(`/api/transactions?environmentId=${harness.context.environment.id}`);
  assert.equal(history.transactions.length, 1);
  assert.equal(history.transactions[0].status, 'committed');
  assert.equal(harness.donorTrace.length, originalReads);
  input(wizard, 'Migration area', 'llm-onboarding');
  assert.equal(wizard.step, 'review');
  assert.equal(wizard.session.view().rows[0].structured.summary.selectedFields, 1);
  await press(wizard, 'back');
  await press(wizard, 'discard-changes');
  assert.equal(wizard.session.view().rows[0].structured.summary.selectedFields, 0);
  input(wizard, 'Migration area', 'access-contracts');
  assert.equal(wizard.step, 'review');
  assert.match(readText(wizard.body), /support-old/);
  assert.equal((await harness.provider.read(JOURNEY_LLM)).text, journeyTargetFiles[JOURNEY_LLM]);
  assert.equal((await harness.provider.read(JOURNEY_SUPPORT)).text, journeyTargetFiles[JOURNEY_SUPPORT]);
  assert.equal((await harness.provider.read(JOURNEY_FINANCE)).text, journeyTargetFiles[JOURNEY_FINANCE]);
  assert.equal(confirmations, 2, 'only declined target replacement and explicit local apply confirm; navigation does not');
  t.diagnostic(JSON.stringify({ journey: 'Deployments > LLM > Access finance > Access support > Deployments',
    oldReadCounters: { afterCapture: originalReads, afterJourney: harness.donorTrace.length },
    originalHandlesDenied: true, localTransaction: history.transactions[0].status, sourceWrites: 0, githubWrites: 0 }));
});
