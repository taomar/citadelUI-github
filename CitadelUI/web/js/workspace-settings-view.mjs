import { h } from './dom.mjs';
import { connectionStatusLabel } from './github-connections.mjs';

function field(label, control, hint = null) {
  return h('label', { class: 'catalog-field', for: control.getAttribute('id') },
    h('span', { class: 'catalog-field-label' }, label),
    control,
    hint ? h('small', { class: 'hint' }, hint) : null
  );
}

export function createEnvironmentForm({ labelInput, pathInput, addButton, createGitHubPanel }) {
  const local = h('div', { class: 'catalog-form' },
    field('Local path', pathInput, 'Display only. Choose the repository folder when adding the environment; its browser handle grants file access.'),
    h('div', { class: 'catalog-form-actions' }, addButton)
  );
  const github = h('div', { class: 'catalog-form', hidden: true });
  const localChoice = h('button', {
    class: 'btn btn-sm btn-primary', type: 'button', 'aria-pressed': 'true',
    onclick: () => chooseSource('local'),
  }, 'Local folder');
  const githubChoice = h('button', {
    class: 'btn btn-sm', type: 'button', 'aria-pressed': 'false',
    onclick: () => chooseSource('github'),
  }, 'GitHub repository');
  let githubPanel = null;

  function chooseSource(kind) {
    if (kind !== 'local' && kind !== 'github') throw new Error('Choose a local folder or GitHub repository.');
    if (kind === 'github' && !githubPanel) {
      githubPanel = createGitHubPanel();
      github.append(githubPanel);
    }
    local.hidden = kind !== 'local';
    github.hidden = kind !== 'github';
    localChoice.classList.toggle('btn-primary', kind === 'local');
    githubChoice.classList.toggle('btn-primary', kind === 'github');
    localChoice.setAttribute('aria-pressed', String(kind === 'local'));
    githubChoice.setAttribute('aria-pressed', String(kind === 'github'));
  }

  const root = h('div', { class: 'settings-add-form catalog-form' },
    field('Environment label', labelInput),
    h('div', { class: 'setup-source-choice', role: 'group', 'aria-label': 'New environment source' }, localChoice, githubChoice),
    local,
    github
  );
  return { root, chooseSource };
}

export function createGitHubConnectionSummary(account, { connect, disconnect }) {
  const persistent = account?.persisted || account?.profile?.status === 'persistent';
  return h('div', { class: 'settings-connection-summary' },
    h('div', { class: 'catalog-form-actions' },
      h('span', { class: `chip ${account ? 'chip-ok' : 'chip-warn'}` },
        account ? `GitHub connected as ${account.login}` : 'GitHub not connected'),
      account ? h('span', { class: 'hint' }, connectionStatusLabel(persistent ? 'persistent' : 'session')) : null,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: account ? disconnect : connect },
        account ? 'Disconnect GitHub' : 'Connect GitHub')
    ),
    h('p', { class: 'hint' }, account
      ? persistent
        ? 'This connection is saved encrypted. Manage saved connections from Citadel workspaces.'
        : 'This credential is session-only. Reconnect after a container restart.'
      : 'Connect to attach a GitHub repository. Manage saved connections from Citadel workspaces.')
  );
}

export function createWorkspaceSettingsView({
  projectLabel, projectActions, notice, connection, environments, environmentCount, addForm, tools,
}) {
  return h('div', { class: 'workspace-settings' },
    h('section', { class: 'workspace-settings-section', 'aria-labelledby': 'settings-project-title' },
      h('div', { class: 'workspace-settings-heading' },
        h('h2', { id: 'settings-project-title' }, projectLabel),
        projectActions
      ),
      h('p', { class: 'hint' }, 'Project labels and environment profiles organize your work. Renaming or removing a profile does not change repository files.')
    ),
    notice,
    h('section', { class: 'workspace-settings-section', 'aria-labelledby': 'settings-connection-title' },
      h('h2', { id: 'settings-connection-title' }, 'GitHub connection'),
      connection
    ),
    h('section', { class: 'workspace-settings-section', 'aria-labelledby': 'settings-environments-title' },
      h('div', { class: 'workspace-settings-heading' },
        h('h2', { id: 'settings-environments-title' }, 'Environments'),
        h('span', { class: 'hint' }, `${environmentCount} ${environmentCount === 1 ? 'environment' : 'environments'}`)
      ),
      environments,
      h('div', { class: 'catalog-form-actions' }, tools)
    ),
    h('section', { class: 'workspace-settings-section', 'aria-labelledby': 'settings-add-title' },
      h('h2', { id: 'settings-add-title' }, 'Add environment'),
      h('p', { class: 'hint' }, 'Attach a local folder or an existing GitHub repository to this project.'),
      addForm
    )
  );
}
