import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, readText } from './_dom-stub.mjs';
import { exportFixture, fixtureChoices, FIXTURE_ACCESS_PATH } from './_terraform-export-fixture.mjs';
import { TerraformExportSession } from '../web/js/terraform-export-session.mjs';
import { openTerraformExport } from '../web/js/terraform-export-view.mjs';

function setup() {
  const dom = installDom();
  globalThis.window = dom.node();
  window.innerWidth = 1600; window.innerHeight = 1000;
  const surface = Object.fromEntries(['shell', 'workspace', 'areas', 'actions', 'rail', 'breadcrumb'].map((key) => [key, dom.node()]));
  dom.root.append(surface.shell);
  surface.shell.append(...Object.entries(surface).filter(([key]) => key !== 'shell').map(([, value]) => value));
  surface.shell.dataset.workspace = 'parameters'; surface.shell.dataset.rail = 'on';
  const normal = dom.node('input'); normal.value = 'original saved editor state';
  surface.workspace.append(normal);
  const fixture = exportFixture();
  const session = new TerraformExportSession({ contextProvider: () => fixture.context, registry: fixture.registry, activePath: FIXTURE_ACCESS_PATH });
  return { ...dom, surface, normal, ...fixture, session };
}
const findButton = (root, text) => root.querySelectorAll('button').find((entry) => readText(entry) === text);
const findControl = (root, key) => root.querySelectorAll('input, select, button').find((entry) => entry.dataset.exportFocus === key);

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
