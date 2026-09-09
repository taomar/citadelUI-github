import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, readText } from './_dom-stub.mjs';
import { exportFixture, fixtureChoices, fixtureFiles, fixtureValues, laterBackendFixtureValues, FIXTURE_ACCESS_PATH, FIXTURE_POLICY } from './_terraform-export-fixture.mjs';
import { TerraformExportSession } from '../web/js/terraform-export-session.mjs';
import { openTerraformExport } from '../web/js/terraform-export-view.mjs';
import { parameterPresentation } from '../web/js/terraform-export-controls.mjs';

function setup(files, activePath = FIXTURE_ACCESS_PATH) {
  const dom = installDom();
  globalThis.window = dom.node();
  window.innerWidth = 1600; window.innerHeight = 1000;
  const surface = Object.fromEntries(['shell', 'workspace', 'areas', 'actions', 'rail', 'breadcrumb'].map((key) => [key, dom.node()]));
  dom.root.append(surface.shell);
  surface.shell.append(...Object.entries(surface).filter(([key]) => key !== 'shell').map(([, value]) => value));
  surface.shell.dataset.workspace = 'parameters'; surface.shell.dataset.rail = 'on';
  const normal = dom.node('input'); normal.value = 'original saved editor state';
  surface.workspace.append(normal);
  const fixture = exportFixture(files);
  const session = new TerraformExportSession({ contextProvider: () => fixture.context, registry: fixture.registry, activePath });
  return { ...dom, surface, normal, ...fixture, session };
}
const findButton = (root, text) => root.querySelectorAll('button').find((entry) => readText(entry) === text);
const findControl = (root, key) => root.querySelectorAll('input, select, button').find((entry) => entry.dataset.exportFocus === key);
const projectedField = (root, path) => root.querySelectorAll('.tf-field')
  .find((entry) => entry.dataset.sourcePath === JSON.stringify(path));
const fieldControl = (root, path) => projectedField(root, path)?.querySelector('input, select, textarea');
const parameterRow = (root, name) => root.querySelectorAll('.tf-source-row').find((entry) => entry.id === `param-${name}`);
const selectedValue = (control) => control.querySelectorAll('option')
  .find((option) => option.selected || option.hasAttribute('selected'))?.value ?? control.value;

test('integrated export surface preserves typed areas/models, source read-only controls, normal editor and focus', async () => {
  const fixture = setup();
  let allowExit = false;
  let exited = 0;
  const ui = await openTerraformExport({
    session: fixture.session, surface: fixture.surface, confirm: async () => allowExit, onExit: () => exited++,
  });
  assert.equal(fixture.surface.shell.dataset.workspace, 'terraform-export');
  assert.match(readText(ui.body), /Saved Bicep setting/);
  assert.match(readText(ui.body), /environment_name/);
  assert.equal(ui.body.querySelectorAll('.tf-source-row').length, 100, 'Every source setting, including relocated feature flags, is shown');
  assert.match(readText(fixture.surface.areas), /Azure Deployment.*LLM Onboarding.*Access Contracts/);
  assert(ui.body.querySelectorAll('input').some((entry) => entry.disabled));
  const subscription = ui.body.querySelectorAll('input').find((entry) => entry.getAttribute('aria-label') === 'Terraform input subscription_id');
  assert(subscription && !subscription.disabled);
  findControl(fixture.surface.areas, 'area:llm').click();
  assert.match(readText(ui.body), /synthetic-east/);
  assert.match(readText(ui.body.querySelector('.tf-selected-source')), /llm-backend-onboarding\/main.bicepparam/);
  assert(ui.body.querySelectorAll('.lm-row').length > 0);
  assert.match(readText(ui.body), /managed_identity_client_id/);
  assert(!readText(ui.body).includes('[object Object]'), 'Backend target objects use typed values, not string coercion');
  assert.equal(fixture.normal.value, 'original saved editor state');
  const save = window.dispatch('keydown', { key: 's', ctrlKey: true });
  assert(save.defaultPrevented);
  assert.match(readText(ui.body), /no Save action/);
  findButton(ui.footer, 'Exit export').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exited, 0);
  assert.equal(ui.closed, false);
  allowExit = true;
  findButton(ui.footer, 'Exit export').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exited, 1);
  assert.equal(fixture.surface.workspace.children[0], fixture.normal);
  assert.equal(fixture.surface.shell.dataset.workspace, 'parameters');
  assert.equal(fixture.surface.shell.dataset.rail, 'on');
  assert.equal(ui.closed, true);
});

test('review/back/approval are real handlers with source scopes, exact label and download failure recovery', async () => {
  const f = setup();
  let downloads = 0;
  const ui = await openTerraformExport({
    session: f.session, surface: f.surface,
    download: async () => { downloads++; throw new Error('Download setup failed'); },
  });

  test('exit restores the entry when the single-flight opener was disabled and browser focus fell to body', async () => {
    const fixture = setup();
    const entry = fixture.node('button');
    entry.dataset.terraformExportEntry = 'true';
    fixture.surface.actions.append(entry);
    document.body.focus();
    const ui = await openTerraformExport({ session: fixture.session, surface: fixture.surface, confirm: async () => true });
    findButton(ui.footer, 'Exit export').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(document.activeElement, entry);
  });
  for (const [area, inputs] of Object.entries(fixtureChoices())) for (const [key, value] of Object.entries(inputs)) f.session.setInput(area, key, value);
  // Refresh through a real UI navigation; no approval handler bypass.
  findControl(f.surface.areas, 'area:access').click();
  findButton(ui.footer, 'Reload saved source').click();
  await ui.whenIdle();
  findButton(ui.footer, 'Review ZIP').click();
  await ui.whenIdle();
  assert.match(readText(ui.body), /Review Terraform ZIP/);
  assert.match(readText(ui.body), /environments\/export-demo\.tfvars/);
  assert(findButton(ui.footer, 'Approve & export ZIP'));
  findButton(ui.footer, 'Back to mapping').click();
  assert.match(readText(ui.body), /Access Contracts - Terraform export/);
  findButton(ui.footer, 'Review ZIP').click();
  await ui.whenIdle();
  findButton(ui.footer, 'Approve & export ZIP').click();
  await ui.whenIdle();
  assert.equal(downloads, 1);
  assert.match(readText(ui.body), /Download setup failed/);
  assert(!readText(ui.body).includes('ZIP download requested'));
});

test('TF1: the real typed model surface exposes loss reasons and disables review without touching source', async () => {
  const values = laterBackendFixtureValues({ apiVersion: '2099-01-01', timeout: 347, inferenceApiVersion: '2099-02-02' });
  const fixture = setup(fixtureFiles(values));
  const before = fixture.root.allFiles();
  let downloads = 0;
  const ui = await openTerraformExport({
    session: fixture.session, surface: fixture.surface, download: async () => { downloads++; },
  });
  await fixture.session.select('deployment', { included: false });
  await fixture.session.select('access', { included: false });
  fixture.session.setInput('llm', 'target:managed_identity_client_id', fixtureChoices().llm['target:managed_identity_client_id']);
  findControl(fixture.surface.areas, 'area:llm').click();
  findButton(ui.footer, 'Reload saved source').click();
  await ui.whenIdle();
  assert.match(readText(ui.body), /Requires Terraform change/);
  assert.match(readText(ui.body), /qa-west-model.*independent-west/);
  const model = ui.body.querySelectorAll('.lm-name').find((entry) => readText(entry).includes('qa-west-model'));
  assert(model);
  model.click();
  const fields = ui.body.querySelectorAll('.tf-model-field').filter((entry) => entry.querySelector('.field-error'));
  assert.equal(fields.length, 3);
  assert(fields.every((entry) => readText(entry).includes('[0][0]')));
  assert.equal(findButton(ui.footer, 'Review ZIP').disabled, true);
  findButton(ui.footer, 'Review ZIP').click();
  assert(!findButton(ui.footer, 'Approve & export ZIP'));
  assert.equal(downloads, 0);
  assert.deepEqual(fixture.root.allFiles(), before);
});

test('Deployment renders actual target toggles, enum/number controls and Foundry records without duplicate dumps', async () => {
  const values = fixtureValues();
  values.deployment.apimSkuUnits = 7;
  values.deployment.aiFoundryInstances[0].networkInjectionEnabled = true;
  values.deployment.aiFoundryModelsConfig[0] = { name: 'gpt-4.1', version: '2025-04-14', aiserviceIndex: 0 };
  values.deployment.tags['payload.region'] = 'case-and-punctuation-stay-literal';
  const fixture = setup(fixtureFiles(values));
  const before = fixture.root.allFiles();
  const ui = await openTerraformExport({ session: fixture.session, surface: fixture.surface });
  const publicAccess = fieldControl(ui.body, ['aiFoundryExternalNetworkAccess']);
  assert.equal(publicAccess.type, 'checkbox');
  assert.equal(publicAccess.checked, false, 'Target false, not the saved Enabled/Disabled string');
  assert.match(readText(projectedField(ui.body, ['aiFoundryExternalNetworkAccess'])), /ai_foundry_external_access.*false.*Saved Bicep: "Disabled"/);
  const sku = fieldControl(ui.body, ['apimSku']);
  assert.equal(sku.tagName, 'SELECT');
  assert.deepEqual(sku.querySelectorAll('option').map((option) => option.value), ['Developer', 'StandardV2', 'Premium', 'PremiumV2']);
  assert.equal(fieldControl(ui.body, ['apimSkuUnits']).value, '1', 'Developer emits one, not the original units');
  assert.match(readText(projectedField(ui.body, ['apimSkuUnits'])), /Saved Bicep: 7/);
  const network = parameterRow(ui.body, 'keyVaultExternalNetworkAccess');
  assert.equal(network.querySelectorAll('.tf-local-value').length, 2);
  assert.deepEqual(network.querySelectorAll('.tf-local-value').map((node) => node.dataset.terraformPath),
    ['kv_public_network_access_enabled', 'network_acl_default_action']);
  assert.equal(network.querySelector('input').checked, false);
  assert.equal(selectedValue(network.querySelector('select')), 'Deny');
  const models = parameterRow(ui.body, 'aiFoundryModelsConfig');
  assert(models.querySelector('.rec'), 'Same incumbent Foundry record renderer');
  assert.equal(fieldControl(ui.body, ['aiFoundryModelsConfig', 0, 'aiserviceIndex']).tagName, 'SELECT');
  assert.equal(fieldControl(ui.body, ['aiFoundryModelsConfig', 0, 'publisher']).value, 'OpenAI');
  assert.equal(fieldControl(ui.body, ['aiFoundryModelsConfig', 0, 'capacity']).value, '100');
  assert.match(readText(projectedField(ui.body, ['aiFoundryModelsConfig', 0, 'capacity'])), /Target default/);
  assert.equal(fieldControl(ui.body, ['aiFoundryInstances', 0, 'networkInjectionEnabled']).checked, false,
    'Final globally-disabled output wins over the supplied true metadata');
  assert.equal(projectedField(ui.body, ['tags', 'payload.region']).dataset.terraformPath, 'tags["payload.region"]');
  assert.equal(ui.body.querySelectorAll('.tf-proposed-values').length, 0);
  assert(models.querySelectorAll('input, select').every((control) => control.disabled));
  assert.deepEqual(fixture.root.allFiles(), before);
});

test('two backend / twelve model export uses shared cards, groups, exact defaults, inspection focus and separate editable authority', async () => {
  const values = laterBackendFixtureValues();
  for (const [backendIndex, backend] of values.llm.llmBackendConfig.entries()) {
    backend.supportedModels = Array.from({ length: 6 }, (_, index) => ({
      ...backend.supportedModels[0], name: index ? `synthetic-${index}-long-model-deployment-name` : 'gpt-4.1',
    }));
    if (backendIndex === 0) {
      delete backend.authType;
      delete backend.supportedModels[0].capacity;
    }
  }
  const fixture = setup(fixtureFiles(values)), before = fixture.root.allFiles();
  const ui = await openTerraformExport({ session: fixture.session, surface: fixture.surface });
  findControl(fixture.surface.areas, 'area:llm').click();
  const backends = parameterRow(ui.body, 'llmBackendConfig');
  assert.equal(backends.querySelectorAll('.lb').length, 2);
  assert.equal(backends.querySelectorAll('.lm-name').length, 12);
  assert.equal(backends.querySelectorAll('.paths').length, 0, 'No flattened target backends/models under the real cards');
  assert.equal(backends.querySelectorAll('.tf-backend-target').length, 0, 'No second backend value representation');
  assert.equal(parameterRow(ui.body, 'modelAliases').querySelectorAll('.paths').length, 0);
  assert(parameterRow(ui.body, 'modelAliases').querySelector('.rec'));
  assert.equal(selectedValue(fieldControl(ui.body, ['llmBackendConfig', 0, 'authType'])), 'managed-identity');
  assert.match(readText(projectedField(ui.body, ['llmBackendConfig', 0, 'authType'])), /auth_scheme = "managedIdentity"/);
  const name = backends.querySelector('.lm-name');
  assert.match(name.getAttribute('aria-label'), /^Inspect model details/);
  name.focus(); name.click();
  assert.equal(document.activeElement.className, 'lm-editor-toggle');
  assert.equal(ui.body.querySelectorAll('.lm-section').length, 4);
  assert.equal(String(fieldControl(ui.body, ['llmBackendConfig', 0, 'supportedModels', 0, 'capacity']).value), '100');
  const format = fieldControl(ui.body, ['llmBackendConfig', 0, 'supportedModels', 0, 'modelFormat']);
  assert.equal(format.tagName, 'SELECT');
  assert.equal(format.disabled, true);
  assert.equal(readText(projectedField(ui.body, ['llmBackendConfig', 0, 'supportedModels', 0, 'modelFormat']).querySelector('.tf-field-name')),
    'modelFormat', 'Full indexed paths are secondary, not repeated primary field labels');
  assert.throws(() => format.dispatch('change'), /Saved-source export does not edit/);
  const client = ui.body.querySelectorAll('input').find((entry) => entry.getAttribute('aria-label') === 'Terraform input managed_identity_client_id');
  assert(client && !client.disabled);
  client.focus(); client.value = fixtureChoices().llm['target:managed_identity_client_id']; client.dispatch('change');
  assert.equal(document.activeElement.dataset.exportFocus, client.dataset.exportFocus);
  assert.equal(ui.body.querySelectorAll('.lm-section').length, 4, 'An export-only edit retains model inspection');
  const close = ui.body.querySelector('.lm-editor-toggle');
  close.focus(); close.click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Inspect model details: gpt-4.1');
  assert(ui.body.querySelectorAll('button').filter((entry) => /^(Add backend|Add model|Remove model)$/.test(readText(entry)))
    .every((entry) => entry.disabled && entry.hidden));
  assert.deepEqual(fixture.root.allFiles(), before);
});

test('Access keeps use-case/service structures, literal policy inspection and target string enums', async () => {
  const values = fixtureValues();
  values.access.useTargetFoundry = true;
  values.access.foundryConfig = { deploymentInPath: 'false', deploymentProvider: 'OpenAI', isSharedToAll: true, staticModels: ['gpt-4.1'] };
  const fixture = setup(fixtureFiles(values));
  const ui = await openTerraformExport({ session: fixture.session, surface: fixture.surface });
  findControl(fixture.surface.areas, 'area:access').click();
  assert(parameterRow(ui.body, 'useCase').querySelector('.defs'));
  assert.equal(fieldControl(ui.body, ['useCase', 'businessUnit']).value, 'finance');
  assert.equal(projectedField(ui.body, ['useCase', 'businessUnit']).dataset.terraformPath, 'use_case.business_unit');
  assert.equal(fieldControl(ui.body, ['foundryConfig', 'isSharedToAll']).type, 'checkbox');
  const inPath = fieldControl(ui.body, ['foundryConfig', 'deploymentInPath']);
  assert.equal(inPath.tagName, 'SELECT');
  assert.equal(selectedValue(inPath), 'false', 'The target requires a string, not a boolean');
  assert.deepEqual(inPath.querySelectorAll('option').map((option) => option.value), ['true', 'false']);
  assert.equal(selectedValue(fieldControl(ui.body, ['foundryConfig', 'connectionCategory'])), 'ApiManagement');
  assert.equal(parameterRow(ui.body, 'foundryConfig').querySelectorAll('.paths').length, 0);
  assert(parameterRow(ui.body, 'foundryConfig').querySelector('.defs'));
  assert.equal(parameterRow(ui.body, 'apiNameMapping').querySelectorAll('.paths').length, 0);
  assert.equal(ui.body.querySelectorAll('.chiplist-add').length, 0, 'Mapped scalar lists do not expose an Add input');
  const services = parameterRow(ui.body, 'services');
  assert(services.querySelector('.rec'));
  assert.equal(services.querySelectorAll('.paths').length, 0);
  assert.equal(fieldControl(ui.body, ['services', 0, 'endpointSecretName']).value, 'FINANCE-LLM-ENDPOINT');
  assert.equal(services.querySelectorAll('.raw-editor').length, 1, 'Actual shared XML inspection, not an array dump');
  assert.equal(services.querySelector('.policy-raw').value, FIXTURE_POLICY);
  assert.equal(services.querySelector('.policy-raw').disabled, true);
  const more = services.querySelector('.rec-toggle');
  assert.equal(more.disabled, false);
  more.dispatch('click', { currentTarget: more });
  assert.equal(services.querySelector('.rec-detail').hidden, false);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(services.querySelectorAll('.tf-proposed-values').length, 0);
  assert.doesNotMatch(readText(services), /Saved Bicep only; no emitted value/, 'A populated target structure is not labelled omitted');
});

test('projection presentation does not mutate mapping, source, values or serialized output', async () => {
  const fixture = setup();
  await fixture.session.initialize();
  for (const [area, inputs] of Object.entries(fixtureChoices())) for (const [key, value] of Object.entries(inputs)) fixture.session.setInput(area, key, value);
  for (const area of fixture.session.view().areas) {
    const freeze = (value) => {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(area.projection);
    const before = JSON.stringify(area.projection);
    for (const row of area.projection.rows) parameterPresentation(area.id, row);
    assert.equal(JSON.stringify(area.projection), before);
  }
  assert.equal((await fixture.session.review()).zipHash, '0e367a7f6e0cfc3282bde906173679c55d6697307373c4da121688b0c26b5480');
});

test('session-aware model remains true, visibly blocked when collapsed and beside the familiar routing control', async () => {
  const values = fixtureValues();
  values.llm.llmBackendConfig[0].supportedModels[0].sessionAwareModel = true;
  const fixture = setup(fixtureFiles(values)), before = fixture.root.allFiles();
  const ui = await openTerraformExport({ session: fixture.session, surface: fixture.surface });
  findControl(fixture.surface.areas, 'area:llm').click();
  const modelRow = ui.body.querySelectorAll('.lm-row').find((row) => row.querySelector('.lm-name'));
  assert.match(readText(modelRow), /gpt-4.1.*Requires Terraform change/);
  modelRow.querySelector('.lm-name').click();
  const field = projectedField(ui.body, ['llmBackendConfig', 0, 'supportedModels', 0, 'sessionAwareModel']);
  assert.equal(field.querySelector('input').checked, true);
  assert.equal(field.querySelector('input').disabled, true);
  assert.match(readText(field), /Saved Bicep only; no emitted value.*sticky routing/);
  assert.equal(findButton(ui.footer, 'Review ZIP').disabled, true);
  assert.deepEqual(fixture.root.allFiles(), before);
});

test('missing saved sources and multiple saved Access choices have distinct, area-specific states', async () => {
  const files = fixtureFiles();
  delete files['bicep/infra/main.bicepparam'];
  const fixture = setup(files, null);
  const ui = await openTerraformExport({ session: fixture.session, surface: fixture.surface });
  assert.equal(ui.body.querySelector('.tf-source-selector').disabled, true);
  assert.match(readText(ui.body.querySelector('.tf-source-hint')), /No saved Azure Deployment parameter configuration/);
  assert.doesNotMatch(readText(ui.body.querySelector('.tf-source-hint')), /Other contracts/);
  assert.match(readText(fixture.surface.areas), /No saved configuration/);
  findControl(fixture.surface.areas, 'area:access').click();
  const selector = ui.body.querySelector('.tf-source-selector');
  assert.equal(selector.disabled, false);
  assert.equal(selector.value, '');
  assert.equal(selector.querySelectorAll('option').length, 4);
  assert(selector.querySelectorAll('option').slice(1).every((option) => option.value.endsWith('.bicepparam')));
  assert.match(readText(ui.body.querySelector('.tf-source-hint')), /Choose one of 3 saved Access Contracts configurations; contracts are not merged/);
  assert.match(readText(fixture.surface.areas), /Choose saved configuration/);
  selector.value = FIXTURE_ACCESS_PATH; selector.dispatch('change');
  await ui.whenIdle();
  assert.match(readText(ui.body.querySelector('.tf-source-hint')), /3 saved Access Contracts configurations available/);
  assert.equal(ui.body.querySelector('.tf-source-selector').value, FIXTURE_ACCESS_PATH);
});
