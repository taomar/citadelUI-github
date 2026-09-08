import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { renderMigrationTargetPreview } from '../web/js/migration-target-preview.mjs';
import { migrationHarness } from './_migration-fixture.mjs';
import { openMigrationWizard } from '../web/js/migration-wizard.mjs';
import { isolatedSnapshotApp } from './_migration-snapshot-fixture.mjs';
import { publicHarness, PUBLIC_REPO } from './_migration-public-fixture.mjs';
import {
  journeyTargetFiles, journeySourceFiles, JOURNEY_MAIN, JOURNEY_LLM, oldAlias,
} from './_migration-journey-data.mjs';

function all(node, predicate) {
  return [ ...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => all(child, predicate)) ];
}

async function fixture(alias = JOURNEY_MAIN) {
  await loadDialogModule();
  const harness = migrationHarness({ targetFiles: journeyTargetFiles, donorFiles: journeySourceFiles });
  const view = await harness.session.plan({ donor: harness.donor, sourceIds: [oldAlias(alias)], targetAlias: alias });
  const render = (extra = {}) => renderMigrationTargetPreview({
    projection: harness.session.targetProjection(), rows: harness.session.view().rows, expanded: new Map(), heldRows: new Set(),
    onImport: (row, candidate) => harness.session.decide(row.id, { kind: 'accept', candidateId: candidate.id, semanticReviewed: true }),
    onUndo: (change) => harness.session.decide(change.rowId, { kind: 'keep' }),
    onMatch: () => {}, onRender: () => {}, ...extra,
  });
  return { ...harness, view, render };
}

test('target form uses actual parameter sections, typed controls and objects without a subscription or live editor callback', async () => {
  const h = await fixture();
  let form = h.render();
  assert(all(form, (node) => node.classList?.contains('sec-features')).length);
  assert(all(form, (node) => node.classList?.contains('outline-tabs')).length);
  assert(all(form, (node) => node.tagName === 'INPUT' && (node.type || node.getAttribute('type')) === 'checkbox').length);
  assert.match(readText(form), /SecurityControl/);
  assert.match(readText(form), /Basic Parameters/);
  assert.doesNotMatch(readText(form), /Deployment will reject/);
  assert.equal(all(form, (node) => node.dataset?.importPath).length, 0, 'unselected and equal values have no import highlights');
  assert.doesNotMatch(readText(form), /SYNTHETIC_UNRESOLVED_INSTANCES|Save to azd|AZURE_SUBSCRIPTION_ID|readEnvironmentVariable/);
  const select = all(form, (node) => node.getAttribute?.('aria-label') === 'Use source value for environmentName')[0];
  select.click();
  form = h.render();
  const marks = all(form, (node) => node.dataset?.importPath);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].dataset.importPath, '["environmentname"]');
  assert.match(readText(marks[0]), /Selected import — not saved/);
  assert.match(readText(marks[0]), /new-environment.*resolved-old/s);
  assert.match(readText(marks[0]), /archive\/bicep\/infra\/main.bicepparam/);
  assert(all(marks[0], (node) => node.tagName === 'INPUT').some((control) => control.value === 'resolved-old'));
  assert(all(form, (node) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)).every((control) => control.disabled));
  assert.equal(h.api.trace.length, 0, 'rendering/selection never invokes editor saving or prepares a transaction');
  assert.equal((await h.provider.read(JOURNEY_MAIN)).text, journeyTargetFiles[JOURNEY_MAIN]);
  all(form, (node) => node.getAttribute?.('aria-label') === 'Undo import environmentName')[0].click();
  assert.equal(all(h.render(), (node) => node.dataset?.importPath).length, 0);
  assert.equal((await h.session.previewSelected()).changed, false);
});

test('existing backend form highlights only the selected resolved model leaf and routes undo through model decisions', async () => {
  const h = await fixture(JOURNEY_LLM);
  const row = h.view.rows[0];
  const backend = row.structured.backends.find((entry) => entry.backendId === 'aaif-new');
  const source = backend.options.find((entry) => entry.backendId === 'aif-old');
  h.session.decideModel(row.id, { kind: 'pair', backendKey: backend.key, sourceKey: source.key, confirmed: true });
  const model = h.session.view().rows[0].structured.backends.find((entry) => entry.backendId === 'aaif-new').models.find((model) => model.name === 'chat');
  h.session.decideModel(row.id, { kind: 'source', backendKey: backend.key, modelKey: model.key, field: 'capacity', reviewed: true });
  const form = h.render({
    onUndo: (change) => h.session.decideModel(change.rowId, {
      kind: 'keep', backendKey: change.backendKey, modelKey: change.modelKey, field: change.field,
    }),
  });
  assert(all(form, (node) => node.classList?.contains('llm')).length, 'reuse the existing guided backend renderer');
  const marks = all(form, (node) => node.dataset?.importPath);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].dataset.importPath, '["llmbackendconfig",1,"supportedModels",1,"capacity"]');
  assert.match(readText(marks[0]), /backend aif-old.*model chat/s);
  assert(all(marks[0], (node) => node.tagName === 'INPUT').some((control) => Number(control.value) === 90));
  all(marks[0], (node) => node.tagName === 'BUTTON' && node.classList?.contains('migration-import-undo'))[0].click();
  assert.equal(h.session.view().rows[0].structured.summary.selectedFields, 0);
  assert.equal(h.api.trace.length, 0);
  assert.equal((await h.provider.read(JOURNEY_LLM)).text, journeyTargetFiles[JOURNEY_LLM]);
});

test('application migration owns the main workspace shell and excludes ordinary editor rendering while active', async () => {
  const app = await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
  const launch = app.slice(app.indexOf('async function openParameterMigration'), app.indexOf('function renderActions'));
  assert.match(launch, /surface: \{/);
  assert.match(launch, /workspace: els.workspace, areas: els.sidebar, actions: els.tbActions/);
  assert.match(app, /function render\(\) \{\s*if \(els.shell.dataset.workspace === 'migration'\) return;/);
  const preview = await readFile(new URL('../web/js/migration-target-preview.mjs', import.meta.url), 'utf8');
  assert.match(preview, /renderParamDocument\(doc, ctx\)/);
  assert.match(preview, /renderOutlineNav\(doc, ctx/);
  assert.doesNotMatch(preview, /subscription:|saveSubscriptionId:|editableValue\(|parameterMap\(|pushOperation\(/);
});

test('the full workspace migration surface renders, selects, undoes and exits without the editor save surface', async (t) => {
  const app = await isolatedSnapshotApp(t);
  const dom = await loadDialogModule();
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = previousWindow; });
  const h = migrationHarness({ targetFiles: journeyTargetFiles, donorFiles: journeySourceFiles, snapshotRequest: app.request });
  const shell = dom.node('div');
  shell.dataset.workspace = 'active';
  shell.dataset.rail = 'off';
  const workspace = dom.node('main'), areas = dom.node('nav'), actions = dom.node('div'), rail = dom.node('aside');
  shell.append(workspace, areas, actions, rail);
  const original = dom.node('button');
  original.textContent = 'Review & save';
  actions.append(original);
  let exited = false;
  const wizard = await openMigrationWizard({
    session: h.session, chooseDirectory: async () => h.donorRoot,
    surface: { shell, workspace, areas, actions, rail }, onExit: () => { exited = true; },
  });
  const action = async (key) => {
    const control = all(shell, (node) => node.dataset?.action === key)[0];
    assert(control && !control.disabled, key);
    control.click();
    await wizard.whenIdle();
  };
  await action('choose-folder');
  const target = all(workspace, (node) => node.getAttribute?.('aria-label') === 'Destination parameter file')[0];
  target.value = JOURNEY_MAIN;
  target.dispatch('change');
  const source = all(workspace, (node) => node.dataset?.sourceAlias === oldAlias(JOURNEY_MAIN))[0];
  source.checked = true;
  source.dispatch('change');
  await action('map');
  assert.equal(shell.dataset.workspace, 'migration');
  assert.equal(dom.modal.open, false, 'the parameter form is not a modal wizard');
  assert.doesNotMatch(readText(actions), /Review & save/);
  assert.match(readText(actions), /Review migration/);
  all(workspace, (node) => node.getAttribute?.('aria-label') === 'Use source value for environmentName')[0].click();
  await wizard.whenIdle();
  assert.equal(all(workspace, (node) => node.dataset?.importPath).length, 1);
  all(workspace, (node) => node.getAttribute?.('aria-label') === 'Undo import environmentName')[0].click();
  await wizard.whenIdle();
  assert.equal(all(workspace, (node) => node.dataset?.importPath).length, 0);
  await action('close');
  assert(exited);
  assert.equal(shell.dataset.workspace, 'active');
  assert.equal(actions.children[0], original);
  assert.equal(h.api.trace.length, 0);
});

async function workspaceReview(t, { publicRequest, startWithFolder = true } = {}) {
  const app = await isolatedSnapshotApp(t);
  const dom = await loadDialogModule();
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = previousWindow; });
  const h = migrationHarness({ targetFiles: journeyTargetFiles, donorFiles: journeySourceFiles, snapshotRequest: app.request });
  const shell = dom.node('div'), workspace = dom.node('main'), areas = dom.node('nav');
  const actions = dom.node('div'), rail = dom.node('aside');
  shell.dataset.workspace = 'active';
  shell.append(workspace, areas, actions, rail);
  const wizard = await openMigrationWizard({
    session: h.session, chooseDirectory: async () => h.donorRoot,
    surface: { shell, workspace, areas, actions, rail }, confirm: async () => true, publicRequest,
  });
  const actionNode = (key) => all(shell, (node) => node.dataset?.action === key)[0];
  const press = async (key) => {
    const node = actionNode(key);
    assert(node && !node.disabled, key);
    node.click();
    await wizard.whenIdle();
  };
  const click = async (label) => {
    const node = all(workspace, (entry) => entry.tagName === 'BUTTON' && !entry.disabled &&
      (entry.getAttribute?.('aria-label') === label || readText(entry) === label))[0];
    assert(node && !node.disabled, label);
    node.click();
    await wizard.whenIdle();
  };
  const input = async (label, value) => {
    const node = all(workspace, (entry) => entry.getAttribute?.('aria-label') === label)[0];
    assert(node && !node.disabled, label);
    if (typeof value === 'boolean') node.checked = value; else node.value = value;
    node.dispatch('change');
    await wizard.whenIdle();
  };
  const pair = async (area, alias) => {
    await press(`area-${area}`);
    await input('Destination parameter file', alias);
    const source = all(workspace, (node) => node.dataset?.sourceAlias === oldAlias(alias))[0];
    assert(source && !source.disabled);
    source.checked = true;
    source.dispatch('change');
    await press('map');
  };
  if (startWithFolder) await press('choose-folder');
  return { h, wizard, workspace, press, click, input, pair, actionNode };
}

test('GitHub source lookup and preparation can be completed beside the fields without finding a header action', async (t) => {
  const publicSource = publicHarness();
  const cx = await workspaceReview(t, { publicRequest: publicSource.request, startWithFolder: false });
  await cx.press('choose-github');
  const inline = () => all(cx.workspace, (node) => node.dataset?.action === 'prepare-source')[0];
  assert(inline(), 'the source preparation action must be in the main form');
  assert.equal(inline().disabled, true);
  assert.match(readText(cx.workspace), /1\. Find the old repository/);
  assert.match(readText(cx.workspace), /2\. Prepare the offline source/);
  await cx.input('Source repository URL or owner/repo', PUBLIC_REPO);
  await cx.press('find-repository');
  assert.equal(inline().disabled, true, 'finding a repository is not an implicit branch selection');
  assert.equal((await cx.wizard.session.preparedSources()).length, 0);
  await cx.input('Source branch', 'legacy-main');
  assert.equal(inline().disabled, false);
  assert.equal(readText(inline()), 'Prepare source and continue');
  assert.match(readText(cx.workspace), /Next: prepare an offline copy/);
  inline().click();
  assert.equal(cx.wizard.busy, true);
  assert.equal(cx.actionNode('read-github').disabled, true);
  assert.equal(inline().disabled, true);
  assert.equal(readText(inline()), 'Preparing source…');
  const pending = cx.wizard.whenIdle();
  cx.actionNode('read-github').click();
  assert.equal(cx.wizard.whenIdle(), pending, 'duplicate header clicks cannot start a second capture');
  await pending;
  assert.equal(cx.wizard.step, 'pair');
  assert.equal(cx.wizard.busy, false);
  assert.equal((await cx.wizard.session.preparedSources()).length, 1);
  assert.match(readText(cx.workspace), /Target configuration \(new\)/);
  assert.equal(cx.h.api.trace.length, 0, 'preparing the old source must not edit the target');
});

test('reviewing then opening source matching and undoing the final import returns to editable no-change state', async (t) => {
  const cx = await workspaceReview(t);
  await cx.pair('deployment', JOURNEY_MAIN);
  await cx.click('Use source value for environmentName');
  await cx.press('preview');
  assert.equal(cx.wizard.step, 'review');
  assert(cx.actionNode('apply'));
  await cx.click('Match source values');
  assert.equal(cx.wizard.step, 'map');
  await cx.input('Import environmentName', false);
  assert.equal(cx.wizard.step, 'map');
  assert.equal(cx.wizard.busy, false);
  assert.equal(cx.actionNode('apply'), undefined, 'editing must require a fresh review before apply');
  assert.equal(cx.actionNode('export-draft'), undefined, 'editing must not retain an old export action');
  assert.equal(all(cx.workspace, (node) => node.dataset?.importPath).length, 0);
  assert.equal(cx.h.api.trace.length, 0);
  await cx.press('preview');
  assert.match(readText(cx.workspace), /Nothing will change/);
  assert.equal(cx.actionNode('apply').disabled, true);
  assert.equal(cx.wizard.busy, false);
  assert.equal(cx.h.api.trace.length, 0);
});

test('scalar matching already expanded during review can revise a value and needs a fresh reviewed apply', async (t) => {
  const cx = await workspaceReview(t);
  await cx.pair('deployment', JOURNEY_MAIN);
  await cx.click('Match source values');
  await cx.input('Import environmentName', true);
  await cx.press('preview');
  assert.equal(cx.wizard.step, 'review');
  await cx.input('Import environmentName', false);
  assert.equal(cx.wizard.step, 'map');
  assert.equal(cx.wizard.busy, false);
  assert.equal(cx.actionNode('apply'), undefined);
  await cx.input('Import location', true);
  assert.equal(cx.h.api.trace.length, 0);
  await cx.press('preview');
  assert.equal(cx.wizard.step, 'review');
  assert.equal(cx.actionNode('apply').disabled, false);
  await cx.press('apply');
  assert.equal(cx.wizard.step, 'done');
  const after = (await cx.h.provider.read(JOURNEY_MAIN)).text;
  assert.equal(after, journeyTargetFiles[JOURNEY_MAIN].replace("location = 'westus2'", "location = 'eastus2'"));
  assert.equal(cx.h.api.trace.filter((entry) => entry === 'prepare').length, 1);
});

for (const mutation of ['model field', 'backend pairing']) {
  test(`an expanded ${mutation} decision on Review returns to editing and preserves another area's draft`, async (t) => {
    const cx = await workspaceReview(t);
    await cx.pair('deployment', JOURNEY_MAIN);
    await cx.click('Use source value for environmentName');
    await cx.press('preview');
    await cx.pair('llm-onboarding', JOURNEY_LLM);
    await cx.click('Match source values');
    const backend = () => cx.wizard.session.view().rows[0].structured.backends.find((entry) => entry.backendId === 'aaif-new');
    await cx.input('Old backend for aaif-new', backend().options.find((entry) => entry.backendId === 'aif-old').key);
    await cx.click('Confirm backend pairing');
    await cx.input('Import Capacity for aaif-new / chat', true);
    await cx.press('preview');
    assert.equal(cx.wizard.step, 'review');
    if (mutation === 'model field') {
      await cx.input('Import Capacity for aaif-new / chat', false);
    } else {
      const confirmed = backend().confirmedSource;
      await cx.input('Old backend for aaif-new', backend().options.find((entry) => entry.backendId === 'old-other').key);
      assert.equal(cx.wizard.step, 'review', 'an unconfirmed proposal must not mutate the reviewed pairing');
      assert.equal(backend().confirmedSource, confirmed);
      assert.equal(cx.wizard.session.view().rows[0].structured.summary.selectedFields, 1);
      await cx.click('Confirm replacement (clears 1 choices)');
    }
    assert.equal(cx.wizard.step, 'map');
    assert.equal(cx.wizard.busy, false);
    assert.equal(cx.actionNode('apply'), undefined);
    assert.equal(cx.wizard.session.view().rows[0].structured.summary.selectedFields, 0);
    assert.equal(all(cx.workspace, (node) => node.dataset?.importPath).length, 0);
    await cx.press('preview');
    assert.match(readText(cx.workspace), /Nothing will change/);
    await cx.press('area-deployment');
    assert.equal(cx.wizard.step, 'review');
    assert.equal(cx.wizard.session.view().rows.find((row) => row.name === 'environmentName').decision.kind, 'accept');
    assert.equal(cx.h.api.trace.length, 0);
    assert.equal((await cx.h.provider.read(JOURNEY_MAIN)).text, journeyTargetFiles[JOURNEY_MAIN]);
    assert.equal((await cx.h.provider.read(JOURNEY_LLM)).text, journeyTargetFiles[JOURNEY_LLM]);
  });
}

test('an initial async-action render error clears the operation lock and does not perform the action', async (t) => {
  const cx = await workspaceReview(t);
  await cx.pair('deployment', JOURNEY_MAIN);
  await cx.click('Use source value for environmentName');
  const original = cx.wizard.body.replaceChildren;
  cx.wizard.body.replaceChildren = function () {
    this.replaceChildren = original;
    throw new Error('Synthetic initial rendering failure');
  };
  await cx.press('preview');
  assert.equal(cx.wizard.busy, false);
  assert.equal(cx.wizard.step, 'map');
  assert.equal(cx.actionNode('apply'), undefined);
  assert(all(cx.workspace, (node) => node.getAttribute?.('role') === 'alert').length);
  assert.equal(cx.h.api.trace.length, 0);
  await cx.press('preview');
  assert.equal(cx.wizard.step, 'review');
  assert.equal(cx.wizard.busy, false);
});
