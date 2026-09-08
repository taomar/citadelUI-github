import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { installDom, readText } from './_dom-stub.mjs';

installDom();
const { h } = await import('../web/js/dom.mjs');
const { createEnvironmentForm, createGitHubConnectionSummary, createWorkspaceSettingsView } = await import('../web/js/workspace-settings-view.mjs');
const nodes = (root) => [root, ...root.children.flatMap(nodes)];
const button = (root, label) => nodes(root).find((node) => node.tagName === 'BUTTON' && readText(node) === label);

function environmentForm() {
  let panels = 0;
  let additions = 0;
  const labelInput = h('input', { id: 'environment-name', class: 'ctl', value: 'Production' });
  const pathInput = h('input', { id: 'environment-path', class: 'ctl', value: 'C:\\source\\citadel' });
  const form = createEnvironmentForm({
    labelInput, pathInput,
    addButton: h('button', { class: 'btn btn-primary', onclick: () => { additions += 1; } }, 'Add environment'),
    createGitHubPanel: () => { panels += 1; return h('div', {}, 'GitHub repository picker'); },
  });
  return { ...form, labelInput, pathInput, panels: () => panels, additions: () => additions };
}

test('settings view: switching sources keeps one visible environment label and preserves input', () => {
  const form = environmentForm();
  const parent = form.labelInput.parentElement;
  assert.equal(form.panels(), 0, 'GitHub is lazy and never connected by opening settings');
  for (const kind of ['github', 'local', 'github', 'local']) {
    form.chooseSource(kind);
    assert.equal(form.labelInput.parentElement, parent);
    assert.equal(parent.parentElement, form.root, 'the common field stays outside either source panel');
    assert.equal(parent.hidden, false);
    assert.equal(form.labelInput.value, 'Production');
    assert.equal(form.pathInput.value, 'C:\\source\\citadel');
    assert.equal(nodes(form.root).filter((node) => node.getAttribute('id') === 'environment-name').length, 1);
    assert.equal(button(form.root, 'Local folder').getAttribute('aria-pressed'), String(kind === 'local'));
    assert.equal(button(form.root, 'GitHub repository').getAttribute('aria-pressed'), String(kind === 'github'));
  }
  assert.equal(form.panels(), 1);
  assert.equal(form.additions(), 0);
  button(form.root, 'Add environment').click();
  assert.equal(form.additions(), 1);
});

test('settings view: source controls work by button activation and fields have explicit labels', () => {
  const form = environmentForm();
  button(form.root, 'GitHub repository').click();
  assert.equal(button(form.root, 'GitHub repository').getAttribute('aria-pressed'), 'true');
  button(form.root, 'Local folder').click();
  assert.equal(button(form.root, 'Local folder').getAttribute('aria-pressed'), 'true');
  for (const input of [form.labelInput, form.pathInput]) {
    assert.equal(input.parentElement.tagName, 'LABEL');
    assert.equal(input.parentElement.getAttribute('for'), input.getAttribute('id'));
    assert.ok(input.parentElement.classList.contains('catalog-field'));
  }
  assert.equal(button(form.root, 'Local folder').getAttribute('type'), 'button');
  assert.equal(button(form.root, 'Add environment').parentElement.className, 'catalog-form-actions');
});

test('settings view: a profile-backed account is connected without a legacy connected flag', () => {
  let disconnects = 0;
  const root = createGitHubConnectionSummary({
    login: 'fixture-owner', profileId: 'profile-one', profile: { status: 'session' },
  }, { disconnect: () => { disconnects += 1; }, connect: () => assert.fail('already connected') });
  assert.match(readText(root), /GitHub connected as fixture-owner/);
  assert.doesNotMatch(readText(root), /GitHub not connected/);
  assert.match(readText(root), /Session only/);
  button(root, 'Disconnect GitHub').click();
  assert.equal(disconnects, 1);
});

test('settings view: saved credentials are not described as memory-only and disconnected action remains usable', () => {
  const saved = createGitHubConnectionSummary({
    login: 'fixture-owner', persisted: true,
  }, { disconnect: () => {}, connect: () => {} });
  assert.match(readText(saved), /saved encrypted/);
  assert.doesNotMatch(readText(saved), /session-only|Reconnect after a container restart/);
  let connects = 0;
  const disconnected = createGitHubConnectionSummary(null, { connect: () => { connects += 1; }, disconnect: () => {} });
  button(disconnected, 'Connect GitHub').click();
  assert.equal(connects, 1);
});

test('settings view: project, connection, environments and add form have distinct headings and working actions', () => {
  let histories = 0;
  const form = environmentForm();
  const list = h('div', { class: 'environment-list' }, 'Production environment');
  const view = createWorkspaceSettingsView({
    projectLabel: 'Citadel project',
    projectActions: h('div', {}, h('button', {}, 'Rename project')),
    notice: h('p', { class: 'operation-status' }),
    connection: createGitHubConnectionSummary(null, { connect: () => {}, disconnect: () => {} }),
    environments: list, environmentCount: 1, addForm: form.root,
    tools: [h('button', { onclick: () => { histories += 1; } }, 'History')],
  });
  assert.deepEqual(nodes(view).filter((node) => node.tagName === 'H2').map(readText),
    ['Citadel project', 'GitHub connection', 'Environments', 'Add environment']);
  const sections = nodes(view).filter((node) => node.tagName === 'SECTION');
  for (const section of sections) {
    assert.ok(nodes(section).some((node) => node.getAttribute('id') === section.getAttribute('aria-labelledby')));
  }
  assert.equal(form.root.parentElement, sections[3]);
  assert.equal(list.parentElement, sections[2]);
  assert.equal(button(view, 'History').parentElement.parentElement, sections[2]);
  button(view, 'History').click();
  assert.equal(histories, 1);
});

test('settings view: the app uses the shared views and layout remains scoped, wrapping and token-based', () => {
  const app = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
  const flow = app.slice(app.indexOf('async function openWorkspaceSettingsContent'), app.indexOf('async function openWorkspaceSettings()'));
  assert.match(flow, /createEnvironmentForm\(/);
  assert.match(flow, /createWorkspaceSettingsView\(/);
  assert.match(flow, /createGitHubConnectionSummary\(account/);
  assert.match(flow, /const account = await githubSessions\.restore\(\)/);
  assert.doesNotMatch(flow, /status\.connected/);
  const styles = readFileSync(new URL('../web/css/components.css', import.meta.url), 'utf8');
  assert.match(styles, /\.settings-add-form \.setup-source-choice \{[^}]*margin: 0;/s);
  assert.match(styles, /\.workspace-settings \.environment-path code \{[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/s);
  assert.match(styles, /@media \(max-width: 48rem\) \{\s*\.workspace-settings \.environment-summary \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(styles, /\.workspace-settings \.operation-status:empty \{\s*display: none;/);
});
