/**
 * The landing surface: saved workspaces first, everything else second.
 *
 * ## The problem this replaces
 *
 * Phase 1 met every returning user with the form they used once, months ago, to
 * attach their first repository: project label, environment label, local path,
 * source toggle, token field. Their actual workspaces were a short list of
 * "Reconnect" buttons underneath it. The screen was optimised for the one thing
 * a user does least often.
 *
 * So the primary surface is the catalogue — an Azure-resource-style list of what
 * they already have, searchable and filterable, with Open as the obvious verb.
 * Creating a workspace is one button that opens a guided flow, because that flow
 * is a sequence of dependent decisions (which connection, which repository,
 * which branch) and a flat form cannot express a dependency.
 *
 * ## Why a table and not cards
 *
 * A workspace is identified by seven facts — name, source, repository, branch,
 * connection, capability, freshness — and the user's real question is
 * comparative: which of these is the one I want, and is it ready. Columns answer
 * that in one scan. Cards would make each row a small poster and force the
 * comparison to happen in the reader's head.
 *
 * ## What this module owns and does not own
 *
 * It renders and it sequences. Every effect — attaching, opening, connecting,
 * removing — is injected as an action, so this file has no opinion about
 * IndexedDB, `/data`, or GitHub, and the flow it drives can be tested without
 * any of them.
 */
import { h, mount } from './dom.mjs';
import { showDialog, dismissDialog, confirmDialog } from './dialog.mjs';
import { environmentSourceOf } from './registry.mjs';
import { CONNECTION_PERSISTENCE_LABEL, connectionStorageDescription, connectionStatusLabel, isConnectionLive, isConnectionResumable } from './github-connections.mjs';
import { activityLabel, activityReason } from './activity.mjs';
import { isRepositorySelectable, repositoryBlockedReason } from './github-selection.mjs';
import { ATTACH_STAGES, LOCAL_ATTACH_STAGES, RESUME_STAGES, StageTracker, createStageRegion } from './stage-progress.mjs';
import { DEFAULT_REPOSITORY_SOURCE, parseRepositorySource, validateNewRepositoryName } from '../../shared/repository-source.mjs';
import { createRepositoryProgress } from './repository-progress.mjs';
import { openLocalSourceImport } from './local-source-import.mjs';

function newRepositoryCreationState(accountId = null) {
  return {
    accountId, name: '', sourceUrl: DEFAULT_REPOSITORY_SOURCE,
    key: null, signature: null, operation: null, uncertain: false,
  };
}

/**
 * The status vocabulary, in the order of how much attention a row deserves.
 *
 * One word per row. A row that needs two words needs a different word.
 */
export const WORKSPACE_STATUS = Object.freeze({
  ready: { label: 'Ready', chip: 'chip-ok' },
  reconnect: { label: 'Reconnect', chip: 'chip-warn' },
  stale: { label: 'Stale', chip: 'chip-neutral' },
  missing: { label: 'Missing', chip: 'chip-danger' },
  incompatible: { label: 'Incompatible', chip: 'chip-danger' },
});

/**
 * Which word describes this workspace right now.
 *
 * Deliberately answerable without a network call. A status that needed GitHub
 * would make the catalogue slow to paint and, worse, would make every row's
 * meaning depend on whether a request happened to succeed.
 */
export function workspaceStatus(environment, { connections = [], hasHandle = null } = {}) {
  const source = environmentSourceOf(environment);
  if (environment.compatibility === 'invalid-citadel-root' || environment.compatibility === 'unavailable') {
    return 'incompatible';
  }
  if (source.kind === 'github') {
    // A record migrated from v3 has no recorded account identity, so it cannot
    // be attributed to a connection without guessing. It reconnects instead.
    if (!source.connectionProfileId) return 'reconnect';
    const profile = connections.find((item) => item.id === source.connectionProfileId) || null;
    if (!profile) return 'missing';
    if (!isConnectionLive(profile) && !isConnectionResumable(profile)) return 'reconnect';
    return source.validatedAt ? 'ready' : 'stale';
  }
  if (hasHandle === false) return 'missing';
  if (environment.permission !== 'granted') return 'reconnect';
  return environment.lastScannedAt ? 'ready' : 'stale';
}

/** The row model the table renders, and the one the filters operate on. */
export function workspaceRow(environment, { project, connections = [], hasHandle = null } = {}) {
  const source = environmentSourceOf(environment);
  const connection =
    source.kind === 'github' && source.connectionProfileId
      ? connections.find((item) => item.id === source.connectionProfileId) || null
      : null;
  return {
    environment,
    project: project || null,
    source,
    connection,
    kind: source.kind,
    label: environment.label,
    projectLabel: project?.label || '',
    location: source.kind === 'github' ? source.fullName : source.folderName,
    detail: source.kind === 'github' ? source.localPath || null : source.localPath || null,
    branch: source.kind === 'github' ? source.sourceBranch : null,
    workingBranch: source.kind === 'github' ? source.workingBranch : null,
    capabilities: source.kind === 'github' ? source.capabilities || [] : [],
    connectionName: connection?.name || (source.kind === 'github' ? 'Not connected' : ''),
    status: workspaceStatus(environment, { connections, hasHandle }),
    lastOpenedAt: environment.lastOpenedAt || null,
    lastValidatedAt:
      source.kind === 'github' ? source.validatedAt || null : environment.lastScannedAt || null,
  };
}

function haystack(row) {
  return [
    row.label,
    row.projectLabel,
    row.location,
    row.detail,
    row.branch,
    row.workingBranch,
    row.connectionName,
    ...row.capabilities,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Search, filter and sort, as one pure function.
 *
 * Pure so the rules are testable without a DOM, and so the empty state can ask
 * the only question that matters: is the list empty because nothing is saved, or
 * because this query matched nothing? Those are different screens.
 */
export function filterWorkspaces(rows, { search = '', source = 'all', status = 'all', sort = 'label', direction = 'asc' } = {}) {
  const needle = String(search || '').trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (source !== 'all' && row.kind !== source) return false;
    if (status !== 'all' && row.status !== status) return false;
    return !needle || haystack(row).includes(needle);
  });
  const factor = direction === 'desc' ? -1 : 1;
  const by = {
    label: (row) => `${row.label}\u0000${row.projectLabel}`,
    source: (row) => `${row.kind}\u0000${row.location}`,
    status: (row) => `${row.status}\u0000${row.label}`,
    opened: (row) => row.lastOpenedAt || '',
  }[sort] || ((row) => row.label);
  return filtered.sort((left, right) => {
    const a = by(left);
    const b = by(right);
    if (a === b) return left.label.localeCompare(right.label);
    return a < b ? -factor : factor;
  });
}

/** "3 minutes ago" for anything recent, an absolute date once that stops helping. */
export function relativeTime(value, now = Date.now()) {
  if (!value) return 'Never';
  const at = Date.parse(value);
  if (Number.isNaN(at)) return 'Unknown';
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function chip(label, variant) {
  return h('span', { class: `chip ${variant}` }, label);
}

/** One mapping from a connection's status word to its chip, used by both surfaces. */
function statusChipFor(status) {
  if (status === 'persistent' || status === 'session') return 'chip-ok';
  if (status === 'persistent-idle') return 'chip-brand';
  if (status === 'unavailable') return 'chip-danger';
  return 'chip-warn';
}

/**
 * The source badge.
 *
 * Text plus a mark, never a mark alone: a two-value distinction carried only by
 * a glyph is unreadable to anyone who has not already learned the glyph.
 */
function sourceBadge(kind) {
  return h(
    'span',
    { class: `chip catalog-source catalog-source-${kind}` },
    h('span', { class: 'catalog-source-mark', 'aria-hidden': 'true' }),
    kind === 'github' ? 'GitHub' : 'Local folder'
  );
}

function field(id, labelText, control, hint = null) {
  return h(
    'label',
    { class: 'catalog-field', for: id },
    h('span', { class: 'catalog-field-label' }, labelText),
    control,
    hint ? h('small', { class: 'hint' }, hint) : null
  );
}

function githubTokenField(id, labelText, control, hint = null, purpose = 'existing') {
  const creating = purpose === 'create';
  const tokenPage = 'https://github.com/settings/personal-access-tokens/new';
  const help = h(
    'div',
    {
      id: `${id}-help`,
      class: 'catalog-token-help',
      hidden: true,
      role: 'region',
      'aria-label': 'Create a GitHub personal access token',
    },
    h(
      'a',
      {
        href: creating
          ? `${tokenPage}?name=Citadel%20repository%20creation&administration=write&contents=write&expires_in=1`
          : tokenPage,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      creating
        ? 'Open prefilled GitHub token form (Administration + Contents)'
        : 'Create a fine-grained token on GitHub'
    ),
    creating
      ? h('p', {}, 'This link only prefills a fine-grained token form; it does not create a token or grant permissions automatically. Review the settings on GitHub before generating the token.')
      : null,
    h(
      'ol',
      {},
      h('li', {}, creating
        ? 'Use a temporary token with a 1-day expiration. Verify Resource owner is your connected personal account; the new repository will belong to that account.'
        : 'Give the token a name and a short expiration. Set Resource owner to the user or organization that owns the repositories.'),
      h('li', {}, creating
        ? 'Under Repository access, choose All repositories for this creation flow. The new repository does not exist yet, so it cannot be selected beforehand.'
        : 'Under Repository access, choose Only select repositories and select only the repositories you will use.'),
      creating
        ? h('li', {}, 'Under Repository permissions, grant ', h('strong', {}, 'Administration: Read and write'), ' to create the private repository, and ', h('strong', {}, 'Contents: Read and write'), ' to read branches and import files (write includes read). Administration alone cannot read branches or populate the repository.')
        : h('li', {}, 'Under Repository permissions, set ', h('strong', {}, 'Contents: Read and write'), ' for Citadel editing.'),
      h('li', {}, 'Generate the token, copy it once, and paste it into the GitHub token field.')
    ),
    creating
      ? h('p', {}, h('strong', {}, 'Metadata: Read-only'), ' is automatic. Add ', h('strong', {}, 'Workflows: Read and write'), ' only if the source preview reports .github/workflows files. For those sources, Citadel disables Actions before copying and leaves Actions disabled for your review. No Actions, Pull requests or organization permission is needed.')
      : h('p', {}, h('strong', {}, 'Metadata: Read-only'), ' is included automatically. Leave all other repository, account and organization permissions unset. Pull requests, Actions, Workflows and administration permissions are not required.'),
    creating
      ? h('p', {}, 'After setup, narrow the token to Only select repositories and the new repository, remove Administration and any unneeded Workflows permission, or reconnect with a regular Contents-only token. Never share the token.')
      : h('p', {}, 'Contents: Read-only can read files, but cannot create branches or save changes. Citadel attaches repositories for editing, not read-only browsing.'),
    creating
      ? h('p', {}, 'New repositories are always private. A token cannot grant more access than your account already has.')
      : h('p', {}, 'If your organization requires approval, ask an organization owner to approve the token. Pending tokens can only read public resources. A token cannot grant more access than your account already has.')
  );
  const toggle = h(
    'button',
    {
      class: 'btn btn-sm',
      type: 'button',
      'aria-label': 'Token help for GitHub personal access tokens',
      'aria-expanded': 'false',
      'aria-controls': `${id}-help`,
      onclick: () => {
        help.hidden = !help.hidden;
        toggle.setAttribute('aria-expanded', String(!help.hidden));
      },
    },
    'Token help'
  );
  // Keep help controls outside the input's label; toggling never rebuilds the form.
  return h(
    'div',
    { class: 'catalog-field' },
    h(
      'div',
      { class: 'catalog-field-head' },
      h('label', { class: 'catalog-field-label', for: id }, labelText),
      toggle
    ),
    control,
    hint ? h('small', { class: 'hint' }, hint) : null,
    help
  );
}

function alertLine() {
  return h('p', { class: 'field-error catalog-error', role: 'alert', hidden: true });
}

function statusLine() {
  return h('p', { class: 'catalog-progress', role: 'status', 'aria-live': 'polite', hidden: true });
}

function say(node, text) {
  node.textContent = text || '';
  node.hidden = !text;
}

/**
 * Render the catalogue and resolve once a workspace is open.
 *
 * The promise is the contract with `ensureWorkspace`: the setup screen is a
 * blocking step that ends with exactly one workspace active.
 */
export function presentWorkspaceCatalog(options) {
  const {
    container,
    actions,
    now = () => Date.now(),
    preferences = {},
    savePreferences = () => {},
    sessions = null,
    onContext = () => {},
  } = options;

  return new Promise((resolve, reject) => {
    const view = {
      search: preferences.search || '',
      source: preferences.source || 'all',
      status: preferences.status || 'all',
      sort: preferences.sort || 'label',
      direction: preferences.direction || 'asc',
      activity: preferences.activity === 'open' ? 'open' : 'closed',
    };
    let rows = [];
    let connections = [];
    let vault = { available: false, reason: 'unknown' };
    let events = [];
    let loadError = null;
    let busy = false;
    let unsubscribe = null;

    /** Stop listening once a workspace is open; the catalogue is gone. */
    function settle(workspace) {
      unsubscribe?.();
      unsubscribe = null;
      resolve(workspace);
    }

    /**
     * What the masthead says while the catalogue is up.
     *
     * The header is the product's "where am I", and on the landing screen the
     * honest answer is the catalogue itself plus whichever connection is live.
     */
    function publishContext(extra = {}) {
      const live = connections.find((profile) => isConnectionLive(profile)) || null;
      onContext({
        sourceKind: live ? 'github' : null,
        projectLabel: 'Citadel',
        environmentLabel: 'Workspaces',
        account: live?.accountLogin || null,
        // The catalogue is not a source. Saying "Local path not recorded" here
        // would answer a question the screen is not asking, and would read as a
        // fault rather than as a state. The count is already on screen; the
        // header states what is *open*, which is nothing.
        location: live ? `Connected as ${live.accountLogin}` : 'No workspace open',
        ...extra,
      });
    }

    const banner = alertLine();
    const progress = statusLine();
    const root = h('section', { class: 'workspace-catalog', 'aria-label': 'Citadel workspaces' });

    function persist() {
      savePreferences({
        search: view.search,
        source: view.source,
        status: view.status,
        sort: view.sort,
        direction: view.direction,
        activity: view.activity,
      });
    }

    async function guard(work, message) {
      if (busy) return null;
      busy = true;
      say(banner, '');
      say(progress, message || 'Working\u2026');
      render();
      try {
        return await work();
      } catch (error) {
        say(banner, error?.message || String(error));
        return null;
      } finally {
        busy = false;
        say(progress, '');
        render();
      }
    }

    async function refresh() {
      try {
        const [projects, environments, connectionState, activity] = await Promise.all([
          actions.listProjects(),
          actions.listEnvironments(),
          actions.listConnections().catch(() => ({ profiles: [], vault })),
          actions.listActivity().catch(() => []),
        ]);
        connections = connectionState?.profiles || [];
        vault = connectionState?.vault || vault;
        events = activity || [];
        const byId = new Map(projects.map((project) => [project.id, project]));
        rows = await Promise.all(
          environments.map(async (environment) => {
            const hasHandle =
              environmentSourceOf(environment).kind === 'local'
                ? Boolean(await actions.hasHandle(environment.id))
                : null;
            return workspaceRow(environment, {
              project: byId.get(environment.projectId),
              connections,
              hasHandle,
            });
          })
        );
        loadError = null;
      } catch (error) {
        loadError = error?.message || String(error);
      }
      publishContext();
      render();
    }

    /** Open a workspace, closing the catalogue by resolving the promise. */
    function open(row) {
      return guard(async () => {
        const workspace = await actions.openEnvironment(row.environment);
        if (workspace) settle(workspace);
        return workspace;
      }, `Opening ${row.label}\u2026`);
    }

    function reconnect(row) {
      return guard(async () => {
        const workspace = await actions.reconnectEnvironment(row.environment, {
          connections,
          onProgress: (text) => say(progress, text),
        });
        if (workspace) settle(workspace);
        return workspace;
      }, `Reconnecting ${row.label}\u2026`);
    }

    async function rename(row) {
      const label = await actions.promptLabel({
        title: `Rename ${row.label}`,
        message: 'Workspace names are unique inside a project.',
        value: row.label,
      });
      if (!label || label === row.label) return;
      await guard(async () => {
        await actions.renameEnvironment(row.environment, label);
        await refresh();
      }, 'Renaming\u2026');
    }

    async function detach(row) {
      const confirmed = await confirmDialog({
        title: `Detach ${row.label}?`,
        message:
          row.kind === 'github'
            ? `This removes Citadel's record of ${row.location} on ${row.branch} from this device. The repository, the ${row.workingBranch} branch and every commit on it are left exactly as they are.`
            : `This removes Citadel's record of this folder from this device. No file in ${row.location} is changed or deleted.`,
        confirmLabel: 'Detach',
        tone: 'danger',
      });
      if (!confirmed) return;
      await guard(async () => {
        await actions.detachEnvironment(row.environment);
        await refresh();
      }, 'Detaching\u2026');
    }

    // ---- connections ------------------------------------------------------

    function connectionActions(profile) {
      const controls = [];
      if (isConnectionResumable(profile)) {
        controls.push(
          h(
            'button',
            {
              class: 'btn btn-sm btn-primary',
              type: 'button',
              disabled: busy,
              onclick: () =>
                guard(async () => {
                  await actions.resumeConnection(profile.id);
                  await refresh();
                }, `Restoring ${profile.name}\u2026`),
            },
            'Reconnect'
          )
        );
      } else if (!isConnectionLive(profile)) {
        controls.push(
          h(
            'button',
            {
              class: 'btn btn-sm btn-primary',
              type: 'button',
              disabled: busy,
              onclick: () => openReconnectDialog(profile),
            },
            'Reconnect'
          )
        );
      } else {
        controls.push(
          h(
            'button',
            {
              class: 'btn btn-sm',
              type: 'button',
              disabled: busy,
              onclick: () =>
                guard(async () => {
                  await actions.disconnectConnection(profile.id);
                  await refresh();
                }, `Disconnecting ${profile.name}\u2026`),
            },
            'Disconnect'
          )
        );
      }
      controls.push(
        h(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            disabled: busy,
            onclick: async () => {
              const name = await actions.promptLabel({
                title: `Rename ${profile.name}`,
                message: 'Connection names are unique on this device.',
                value: profile.name,
              });
              if (!name || name === profile.name) return;
              await guard(async () => {
                await actions.renameConnection(profile.id, name);
                await refresh();
              }, 'Renaming\u2026');
            },
          },
          'Rename'
        )
      );
      controls.push(
        h(
          'button',
          {
            class: 'btn btn-sm btn-danger-ghost',
            type: 'button',
            disabled: busy,
            onclick: async () => {
              const attached = rows.filter((row) => row.connection?.id === profile.id);
              const confirmed = await confirmDialog({
                title: `Remove ${profile.name}?`,
                message: attached.length
                  ? `${attached.length} saved workspace${
                      attached.length === 1 ? '' : 's'
                    } reached GitHub through this connection. They stay in the catalogue and will ask to be reconnected. No branch is deleted and no token is revoked.`
                  : 'The saved credential for this connection is deleted from this device. No branch is deleted and no token is revoked.',
                confirmLabel: 'Remove connection',
                tone: 'danger',
              });
              if (!confirmed) return;
              await guard(async () => {
                await actions.removeConnection(profile.id);
                await refresh();
              }, 'Removing\u2026');
            },
          },
          'Remove'
        )
      );
      return controls;
    }

    /**
     * The persistence control, in the one place it belongs.
     *
     * A single checkbox with no passphrase, no unlock and no key ceremony. When
     * no key is mounted it is disabled and says why, because an enabled control
     * that silently does nothing is worse than an honest refusal.
     */
    function persistenceControl(profile) {
      const id = `catalog-persist-${profile.id}`;
      const input = h('input', {
        id,
        type: 'checkbox',
        class: 'ctl-check',
        checked: profile.persisted,
        disabled: busy || !vault.available || (!profile.persisted && !isConnectionLive(profile)),
        onchange: () =>
          guard(async () => {
            await actions.setConnectionPersistence(profile.id, input.checked);
            await refresh();
          }, input.checked ? 'Encrypting\u2026' : 'Removing the saved credential\u2026'),
      });
      return h(
        'label',
        { class: 'catalog-persist', for: id },
        input,
        h('span', {}, CONNECTION_PERSISTENCE_LABEL)
      );
    }

    function connectionRows() {
      if (!connections.length) {
        return h(
          'tr',
          {},
          h(
            'td',
            { colspan: '5' },
            h(
              'div',
              { class: 'catalog-empty catalog-empty-inline' },
              h('p', {}, 'No GitHub connections yet.'),
              h(
                'p',
                { class: 'hint' },
                'A connection is one GitHub account and the repositories its token can reach. Add a workspace from a GitHub repository to create your first one.'
              )
            )
          )
        );
      }
      return connections.flatMap((profile) => {
        const attached = rows.filter((row) => row.connection?.id === profile.id);
        const main = h(
          'tr',
          { class: 'catalog-connection-row' },
          h(
            'td',
            { 'data-label': 'Connection' },
            h('span', { class: 'otable-link' }, profile.name),
            persistenceControl(profile)
          ),
          h(
            'td',
            { class: 'otable-path', 'data-label': 'Account' },
            h('code', {}, `@${profile.accountLogin}`)
          ),
          h(
            'td',
            { 'data-label': 'Status' },
            chip(connectionStatusLabel(profile.status), statusChipFor(profile.status))
          ),
          h('td', { 'data-label': 'Last connected' }, relativeTime(profile.lastConnectedAt, now())),
          h(
            'td',
            { 'data-label': 'Actions' },
            h('div', { class: 'catalog-actions' }, connectionActions(profile))
          )
        );
        // A connected profile shows what it actually reaches. Without this the
        // connections list and the workspace list are two unrelated tables that
        // happen to be about the same thing.
        const detail = h(
          'tr',
          { class: 'catalog-connection-detail' },
          h(
            'td',
            { colspan: '5' },
            attached.length
              ? h(
                  'ul',
                  { class: 'catalog-attached' },
                  attached.map((row) =>
                    h(
                      'li',
                      {},
                      h(
                        'button',
                        {
                          class: 'btn btn-link',
                          type: 'button',
                          disabled: busy,
                          onclick: () => (row.status === 'ready' ? open(row) : reconnect(row)),
                        },
                        `${row.location} @ ${row.branch}`
                      ),
                      h('span', { class: 'hint' }, ` \u2014 ${row.label}`)
                    )
                  )
                )
              : h('p', { class: 'hint' }, 'No workspaces are attached through this connection yet.')
          )
        );
        return [main, detail];
      });
    }

    function openReconnectDialog(profile) {
      const token = h('input', {
        id: 'catalog-reconnect-token',
        class: 'ctl',
        type: 'password',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'github_pat_...',
      });
      const persistInput = h('input', {
        id: 'catalog-reconnect-persist',
        type: 'checkbox',
        class: 'ctl-check',
        checked: profile.persisted,
        disabled: !vault.available,
      });
      const error = alertLine();
      const submit = h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onclick: async () => {
            const value = token.value;
            token.value = '';
            submit.disabled = true;
            try {
              await actions.reconnectConnection(profile.id, {
                token: value,
                persist: persistInput.checked,
              });
              dismissDialog(true);
              await refresh();
            } catch (failure) {
              say(error, failure?.message || String(failure));
              submit.disabled = false;
            }
          },
        },
        'Reconnect'
      );
      showDialog(
        `Reconnect ${profile.name}`,
        h(
          'div',
          { class: 'catalog-dialog' },
          h(
            'p',
            { class: 'hint' },
            `Paste a fine-grained token for ${profile.accountLogin}. A token for any other account is refused, because every workspace saved under this connection was chosen with this account's access.`
          ),
          githubTokenField('catalog-reconnect-token', 'GitHub token', token),
          h(
            'label',
            { class: 'catalog-persist', for: 'catalog-reconnect-persist' },
            persistInput,
            h('span', {}, CONNECTION_PERSISTENCE_LABEL)
          ),
          vault.available
            ? null
            : h(
                'p',
                { class: 'hint' },
                'No credential key is mounted on this deployment, so connections cannot be saved here. This session will work normally.'
              ),
          error
        ),
        [
          h('button', { class: 'btn', type: 'button', onclick: () => dismissDialog(false) }, 'Cancel'),
          submit,
        ],
        { initialFocus: token }
      );
    }

    // ---- rendering --------------------------------------------------------

    function workspaceActions(row) {
      const controls = [];
      if (row.status === 'ready' || row.status === 'stale') {
        controls.push(
          h(
            'button',
            {
              class: 'btn btn-sm btn-primary',
              type: 'button',
              disabled: busy,
              onclick: () => open(row),
            },
            'Open'
          )
        );
      } else {
        // Every other status, including `incompatible`. A workspace marked
        // incompatible at startup — a transient permission prompt, a folder that
        // was temporarily unreadable — was previously left with only Rename and
        // Detach, and nothing but reconnecting can clear the mark. Withholding
        // the one control that re-scans made the mark permanent, and Detach is
        // lossy: re-attaching mints a new environment id and orphans the working
        // branch holding the user's commits.
        controls.push(
          h(
            'button',
            {
              class: 'btn btn-sm btn-primary',
              type: 'button',
              disabled: busy,
              onclick: () => reconnect(row),
            },
            'Reconnect'
          )
        );
      }
      controls.push(
        h(
          'button',
          { class: 'btn btn-sm', type: 'button', disabled: busy, onclick: () => rename(row) },
          'Edit'
        )
      );
      controls.push(
        h(
          'button',
          {
            class: 'btn btn-sm btn-danger-ghost',
            type: 'button',
            disabled: busy,
            onclick: () => detach(row),
          },
          'Detach'
        )
      );
      return controls;
    }

    function sortButton(key, label) {
      const activeKey = view.sort === key;
      return h(
        'button',
        {
          class: `btn btn-link catalog-sort${activeKey ? ' catalog-sort-active' : ''}`,
          type: 'button',
          'aria-sort': activeKey ? (view.direction === 'asc' ? 'ascending' : 'descending') : 'none',
          onclick: () => {
            if (activeKey) view.direction = view.direction === 'asc' ? 'desc' : 'asc';
            else {
              view.sort = key;
              view.direction = 'asc';
            }
            persist();
            render();
          },
        },
        label,
        activeKey ? h('span', { 'aria-hidden': 'true' }, view.direction === 'asc' ? ' \u2191' : ' \u2193') : null
      );
    }

    function workspaceTable(visible) {
      return h(
        'div',
        {
          class: 'catalog-scroller',
          tabindex: '0',
          role: 'group',
          'aria-label': 'Saved workspaces table',
        },
        h(
          'table',
          { class: 'otable catalog-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, sortButton('label', 'Workspace')),
              h('th', { scope: 'col' }, sortButton('source', 'Source')),
              h('th', { scope: 'col' }, 'Repository or folder'),
              h('th', { scope: 'col' }, 'Branch'),
              h('th', { scope: 'col' }, 'Connection'),
              h('th', { scope: 'col' }, 'Capabilities'),
              h('th', { scope: 'col' }, sortButton('status', 'Status')),
              h('th', { scope: 'col' }, sortButton('opened', 'Last opened')),
              h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions'))
            )
          ),
          h(
            'tbody',
            {},
            visible.map((row) =>
              h(
                'tr',
                { class: 'catalog-row' },
                h(
                  'td',
                  { 'data-label': 'Workspace' },
                  h('span', { class: 'otable-link' }, row.label),
                  row.projectLabel ? h('small', { class: 'hint' }, row.projectLabel) : null
                ),
                h('td', { 'data-label': 'Source' }, sourceBadge(row.kind)),
                h(
                  'td',
                  { class: 'otable-path', 'data-label': 'Repository or folder' },
                  h('code', {}, row.location || 'Not recorded')
                ),
                h(
                  'td',
                  { class: 'otable-path', 'data-label': 'Branch' },
                  row.branch ? h('code', {}, row.branch) : h('span', { class: 'hint' }, '\u2014')
                ),
                h(
                  'td',
                  { class: 'catalog-connection-cell', 'data-label': 'Connection' },
                  row.kind === 'github'
                    ? h(
                        'span',
                        { class: row.connection ? '' : 'hint' },
                        row.connection ? row.connection.name : 'Not connected'
                      )
                    : h('span', { class: 'hint' }, '\u2014')
                ),
                h(
                  'td',
                  { class: 'catalog-capabilities', 'data-label': 'Capabilities' },
                  row.capabilities.length
                    ? row.capabilities.map((capability) => chip(capability, 'chip-neutral'))
                    : h('span', { class: 'hint' }, '\u2014')
                ),
                h(
                  'td',
                  { 'data-label': 'Status' },
                  chip(WORKSPACE_STATUS[row.status].label, WORKSPACE_STATUS[row.status].chip)
                ),
                h('td', { 'data-label': 'Last opened' }, relativeTime(row.lastOpenedAt, now())),
                // The buttons are one grid item, not three. Placed directly in
                // the cell they become cells of their own, and the stacked
                // layout drops every second one under the row label.
                h(
                  'td',
                  { 'data-label': 'Actions' },
                  h('div', { class: 'catalog-actions' }, workspaceActions(row))
                )
              )
            )
          )
        )
      );
    }

    function emptyWorkspaces(filtered) {
      if (rows.length && !filtered.length) {
        return h(
          'div',
          { class: 'catalog-empty' },
          h('p', {}, 'No workspace matches this search.'),
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                view.search = '';
                view.source = 'all';
                view.status = 'all';
                persist();
                render();
              },
            },
            'Clear filters'
          )
        );
      }
      return h(
        'div',
        { class: 'catalog-empty' },
        h('p', {}, 'No workspaces yet.'),
        h(
          'p',
          { class: 'hint' },
          'A workspace is one Citadel repository — a local folder, or a GitHub repository on a branch you choose. Once attached it appears here and opens in one click.'
        ),
        h(
          'button',
          { class: 'btn btn-primary', type: 'button', onclick: () => startAddWorkspace() },
          'Add your first workspace'
        )
      );
    }

    function filters() {
      const search = h('input', {
        id: 'catalog-search',
        class: 'ctl',
        type: 'search',
        value: view.search,
        placeholder: 'Search workspaces, repositories and branches',
        'aria-label': 'Search saved workspaces',
        oninput: (event) => {
          view.search = event.target.value;
          persist();
          renderList();
        },
      });
      const sourceSelect = h(
        'select',
        {
          id: 'catalog-source-filter',
          class: 'ctl',
          'aria-label': 'Filter by source',
          onchange: (event) => {
            view.source = event.target.value;
            persist();
            renderList();
          },
        },
        [
          ['all', 'All sources'],
          ['github', 'GitHub'],
          ['local', 'Local folder'],
        ].map(([value, label]) =>
          h('option', { value, selected: view.source === value }, label)
        )
      );
      const statusSelect = h(
        'select',
        {
          id: 'catalog-status-filter',
          class: 'ctl',
          'aria-label': 'Filter by status',
          onchange: (event) => {
            view.status = event.target.value;
            persist();
            renderList();
          },
        },
        [['all', 'All statuses'], ...Object.entries(WORKSPACE_STATUS).map(([key, meta]) => [key, meta.label])].map(
          ([value, label]) => h('option', { value, selected: view.status === value }, label)
        )
      );
      return h(
        'div',
        { class: 'catalog-filters', role: 'search' },
        search,
        sourceSelect,
        statusSelect
      );
    }

    function activityPanel() {
      const open_ = view.activity === 'open';
      return h(
        'section',
        { class: 'catalog-section catalog-activity' },
        h(
          'button',
          {
            class: 'btn btn-quiet catalog-activity-toggle',
            type: 'button',
            'aria-expanded': String(open_),
            'aria-controls': 'catalog-activity-list',
            onclick: () => {
              view.activity = open_ ? 'closed' : 'open';
              persist();
              render();
            },
          },
          h('h2', {}, 'Recent activity'),
          h('span', { class: 'hint' }, open_ ? 'Hide' : `${events.length} recorded`)
        ),
        h(
          'div',
          { id: 'catalog-activity-list', class: 'catalog-activity-body', hidden: !open_ },
          events.length
            ? h(
                'ol',
                { class: 'catalog-activity-items' },
                events.slice(0, 25).map((event) =>
                  h(
                    'li',
                    { class: `catalog-activity-item catalog-activity-${event.outcome}` },
                    h('time', { datetime: event.at }, relativeTime(event.at, now())),
                    h('span', { class: 'catalog-activity-action' }, activityLabel(event.action)),
                    event.target ? h('span', { class: 'catalog-activity-target' }, event.target) : null,
                    event.account ? h('code', {}, `@${event.account}`) : null,
                    activityReason(event.reason)
                      ? h('span', { class: 'hint' }, `\u2014 ${activityReason(event.reason)}`)
                      : null
                  )
                )
              )
            : h(
                'p',
                { class: 'hint' },
                'Connections, attachments and workspace opens are recorded here. Nothing is recorded yet.'
              )
        )
      );
    }

    let listHost = null;

    function renderList() {
      if (!listHost) return render();
      const visible = filterWorkspaces(rows, view);
      mount(listHost, visible.length ? workspaceTable(visible) : emptyWorkspaces(visible));
      return undefined;
    }

    function render() {
      const visible = filterWorkspaces(rows, view);
      listHost = h('div', { class: 'catalog-list' });
      mount(root,
        h(
          'header',
          { class: 'catalog-head' },
          h('h1', {}, 'Citadel workspaces'),
          h(
            'p',
            { class: 'hint' },
            'Open a saved workspace, or attach a new Citadel repository. Nothing here is edited until you open it.'
          ),
          h(
            'div',
            { class: 'catalog-head-actions' },
            // Only when there is a list to add to. On an empty catalogue the
            // empty state carries the call to action, and two identical primary
            // buttons on one screen is indecision rendered twice.
            rows.length
              ? h(
                  'button',
                  {
                    class: 'btn btn-primary',
                    type: 'button',
                    disabled: busy,
                    onclick: () => startAddWorkspace(),
                  },
                  'Add workspace'
                )
              : null
          ),
          progress,
          banner,
          loadError
            ? h('p', { class: 'field-error', role: 'alert' }, `The catalogue could not be loaded: ${loadError}`)
            : null
        ),
        h(
          'section',
          { class: 'catalog-section' },
          h(
            'div',
            { class: 'catalog-section-head' },
            h('h2', {}, 'Saved workspaces'),
            h('span', { class: 'hint' }, `${visible.length} of ${rows.length}`)
          ),
          rows.length ? filters() : null,
          listHost
        ),
        h(
          'section',
          { class: 'catalog-section' },
          h(
            'div',
            { class: 'catalog-section-head' },
            h('h2', {}, 'GitHub connections'),
            h(
              'span',
              { class: 'hint' },
              vault.available
                ? 'Connections can be saved on this device, encrypted.'
                : 'No credential key is mounted, so connections last for this session only.'
            )
          ),
          h(
            'div',
            {
              class: 'catalog-scroller',
              tabindex: '0',
              role: 'group',
              'aria-label': 'GitHub connections table',
            },
            h(
              'table',
              { class: 'otable catalog-table catalog-connections' },
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', { scope: 'col' }, 'Connection'),
                  h('th', { scope: 'col' }, 'Account'),
                  h('th', { scope: 'col' }, 'Status'),
                  h('th', { scope: 'col' }, 'Last connected'),
                  h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions'))
                )
              ),
              h('tbody', {}, connectionRows())
            )
          )
        ),
        activityPanel()
      );
      mount(listHost, visible.length ? workspaceTable(visible) : emptyWorkspaces(visible));
      return undefined;
    }

    function startAddWorkspace() {
      runAddWorkspace({
        actions,
        connections,
        vault,
        rows,
        onContext: (context) => publishContext(context),
        onDone: async (workspace) => {
          publishContext();
          if (workspace) settle(workspace);
          else await refresh();
        },
        onOpenExisting: (environmentId) => {
          const existing = rows.find((row) => row.environment.id === environmentId);
          if (existing) open(existing);
        },
      });
    }

    mount(container, root);
    render();
    // The credential is owned application-wide, so a connection established in
    // the stepper — or dropped by an expiry — changes every row's status here.
    // Subscribing is what makes the table and the masthead agree with the
    // manager instead of with whatever was true when they last painted.
    const release = sessions?.subscribe?.(() => {
      refresh().catch(() => {});
    });
    if (release) unsubscribe = release;
    refresh().catch((error) => reject(error));
  });
}

/**
 * The guided attach flow.
 *
 * A stepper rather than a form because the decisions are dependent: the
 * repositories you may pick come from the connection you chose, and the branches
 * come from the repository. A flat form would have to render every control at
 * once and disable most of them, which is a worse way of saying the same thing.
 *
 * Each step re-enters `showDialog`, which replaces the frame and moves focus to
 * the first control of the new step — so keyboard users land where the work is
 * rather than back at the dialog title.
 */
export function runAddWorkspace(options) {
  const { actions, connections, vault, rows, onDone, onOpenExisting, onContext = () => {} } = options;
  const state = {
    step: 'source',
    kind: null,
    githubIntent: 'existing',
    replaceCreationToken: false,
    creation: newRepositoryCreationState(),
    // Default to a connection the user can actually proceed with. Falling back
    // to any saved connection rather than to "new" matters: a profile that needs
    // reconnecting should offer to reconnect *itself*, not ask for a second
    // connection to the same account.
    profileId:
      connections.find((item) => isConnectionLive(item))?.id ||
      connections.find((item) => isConnectionResumable(item))?.id ||
      connections[0]?.id ||
      null,
    newConnectionName: '',
    resumeFailed: false,
    account: null,
    projectId: null,
    projectLabel: 'Citadel',
    environmentLabel: '',
    localPath: '',
    handle: null,
    scan: null,
    // True only while an irreversible step is in flight, so Escape and the
    // backdrop cannot cancel a dialog whose work has already started.
    working: false,
  };
  const selection = actions.createSelection();
  let closed = false;
  let disposeStep = null;

  function finish(workspace) {
    if (closed) return;
    closed = true;
    disposeStep?.();
    onDone(workspace || null);
  }

  function cancel(result) {
    if (result === true) return;
    finish(null);
  }

  const steps = ['source', 'connection', 'repository', 'branch', 'details', 'review'];

  function visibleSteps() {
    if (state.kind === 'local') return ['source', 'details', 'review'];
    return state.githubIntent === 'new'
      ? ['source', 'connection', 'creation', 'repository', 'branch', 'details', 'review']
      : steps;
  }

  function stepHeader() {
    const order = visibleSteps();
    const index = order.indexOf(state.step);
    return h(
      'ol',
      { class: 'catalog-steps', 'aria-label': 'Add workspace progress' },
      order.map((name, position) =>
        h(
          'li',
          {
            class: `catalog-step${position === index ? ' catalog-step-current' : ''}${
              position < index ? ' catalog-step-done' : ''
            }`,
            'aria-current': position === index ? 'step' : null,
          },
          { source: 'Source', connection: 'Connection', creation: 'Create repository', repository: 'Repository', branch: 'Branch', details: 'Details', review: 'Review' }[name]
        )
      )
    );
  }

  function present(title, body, actionButtons, initialFocus = null) {
    showDialog(
      title,
      h('div', { class: 'catalog-dialog' }, stepHeader(), body),
      actionButtons,
      { onDismiss: cancel, initialFocus, preventDismiss: () => Boolean(state.working) }
    );
  }

  function backButton(target) {
    return h(
      'button',
      { class: 'btn', type: 'button', onclick: () => go(target) },
      target ? 'Back' : 'Cancel'
    );
  }

  function go(step) {
    if (!step) {
      dismissDialog(false);
      return;
    }
    disposeStep?.();
    disposeStep = null;
    state.step = step;
    render();
  }

  // ---- steps ------------------------------------------------------------

  function sourceStep() {
    const choose = (kind, intent = 'existing') => {
      state.kind = kind;
      state.githubIntent = intent;
      go(kind === 'local' ? 'details' : 'connection');
    };
    const importLocal = async () => {
      if (state.working) return;
      state.working = true;
      state.kind = 'local';
      try {
        const workspace = await openLocalSourceImport({
          projects: actions.projects || [], projectId: state.projectId,
          projectLabel: state.projectLabel, environmentLabel: state.environmentLabel || 'Development',
          folderName: state.folderName || '',
          localPath: state.localPath, scan: actions.scanLocalSource, attach: actions.attachLocalSource,
          pickFolder: actions.pickFolder, client: actions.localSourceClient, onContext,
          onDraft: (values) => Object.assign(state, values),
        });
        if (workspace) finish(workspace);
        else if (!closed) go('source');
      } finally { state.working = false; }
    };
    present(
      'Add workspace',
      h(
        'div',
        { class: 'catalog-choice' },
        h(
          'button',
          { class: 'btn catalog-choice-option', type: 'button', onclick: () => choose('github') },
          h('strong', {}, 'Existing GitHub Repo'),
          h(
            'span',
            { class: 'hint' },
            'Edit a Citadel repository on a branch you choose. Saves become one commit on a Citadel working branch.'
          )
        ),
        h(
          'button',
          { class: 'btn catalog-choice-option', type: 'button', onclick: () => choose('github', 'new') },
          h('strong', {}, 'New GitHub Repo'),
          h('span', { class: 'hint' }, 'Create a private repository in your personal account from a Citadel source, then choose its workspace and branch as usual.')
        ),
        h(
          'button',
          { class: 'btn catalog-choice-option', type: 'button', onclick: importLocal },
          h('strong', {}, 'Create local from Citadel source'),
          h('span', { class: 'hint' }, 'Copy the complete public citadel-v1 source into a new local project folder, then open it. No GitHub token or Git history.')
        ),
        h(
          'button',
          { class: 'btn catalog-choice-option', type: 'button', onclick: () => choose('local') },
          h('strong', {}, 'Local'),
          h(
            'span',
            { class: 'hint' },
            'Edit a Citadel repository already on this machine. Saves are written through a verified backup-before-write transaction.'
          )
        )
      ),
      [h('button', { class: 'btn', type: 'button', onclick: () => dismissDialog(false) }, 'Cancel')]
    );
  }

  /**
   * Choose a GitHub connection.
   *
   * This step has four states, and the defect it was rebuilt to fix was showing
   * all of them at once: a user with a saved, encrypted connection selected was
   * still shown "New connection name", "GitHub token" and the persistence
   * checkbox, and reasonably asked why the product wanted a token it already
   * had. Fields that belong to creating a connection are now rendered only when
   * a connection is being created.
   *
   *   new              — no saved connection, or "Add a new connection" chosen.
   *   live             — the connection already has a credential; nothing to ask.
   *   idle             — the credential is saved and sealed; it is restored
   *                      automatically, with progress, and no token field.
   *   needs a token    — no usable credential; the *existing* connection is
   *                      reconnected, its name fixed, its account id verified.
   */
  function connectionStep() {
    const error = alertLine();
    const profiles = connections;
    const selected = profiles.find((profile) => profile.id === state.profileId) ||
      (state.account?.profile?.id === state.profileId ? state.account.profile : null);
    const mode = selected ? 'existing' : 'new';
    const live = selected ? isConnectionLive(selected) : false;
    const idle = selected ? isConnectionResumable(selected) : false;
    const creating = state.githubIntent === 'new';
    const needsToken = Boolean(selected) && ((!live && !idle) || (creating && state.replaceCreationToken));

    const stages = new StageTracker(RESUME_STAGES, { onChange: () => region.update(stages) });
    const region = createStageRegion({ label: 'Connection progress' });

    const chooser = profiles.length
      ? h(
          'select',
          {
            id: 'catalog-connection-select',
            class: 'ctl',
            'aria-label': 'GitHub connection',
            onchange: (event) => {
              // Switching clears only the secret belonging to the mode being
              // left. A token typed for one connection must never be submitted
              // for another.
              state.profileId = event.target.value || null;
              state.newConnectionName = '';
              state.resumeFailed = false;
              go('connection');
            },
          },
          h('option', { value: '' }, 'Add a new connection\u2026'),
          profiles.map((profile) =>
            h(
              'option',
              { value: profile.id, selected: state.profileId === profile.id },
              `${profile.name} (@${profile.accountLogin}) \u2014 ${connectionStatusLabel(profile.status)}`
            )
          )
        )
      : null;

    // ---- new connection ---------------------------------------------------

    const nameInput = h('input', {
      id: 'catalog-connection-name',
      class: 'ctl',
      maxlength: '80',
      value: state.newConnectionName || '',
      placeholder: 'Work account',
      'aria-label': 'Connection name',
    });
    const tokenInput = h('input', {
      id: 'catalog-connection-token',
      class: 'ctl',
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'github_pat_...',
      // In new mode the token stays closed until the connection has a name; when
      // reconnecting, the name already exists and there is nothing to gate on.
      disabled: mode === 'new' && !(state.newConnectionName || '').trim(),
      'aria-label': needsToken
        ? `Replacement token for ${selected.name}`
        : 'GitHub fine-grained personal access token',
    });
    const persistInput = h('input', {
      id: 'catalog-connection-persist',
      type: 'checkbox',
      class: 'ctl-check',
      checked: !creating && needsToken ? selected.credentialMode === 'persistent' : false,
      disabled: !vault.available,
    });
    nameInput.addEventListener('input', () => {
      state.newConnectionName = nameInput.value;
      tokenInput.disabled = !nameInput.value.trim();
    });

    const persistRow = h(
      'label',
      { class: 'catalog-persist', for: 'catalog-connection-persist' },
      persistInput,
      h('span', {}, CONNECTION_PERSISTENCE_LABEL)
    );
    const persistHint = vault.available
      ? h(
          'p',
          { class: 'hint' },
          'Encrypted with a key mounted outside this container and outside the data volume. It protects a stolen data volume, not a compromised host. Leave it unticked to keep the credential in memory only.'
        )
      : h(
          'p',
          { class: 'hint' },
          connectionStorageDescription({ available: false })
        );

    // Build only the active form: wrapping a shared input in an unused field
    // moves it out of the form the user will actually see.
    const newFields = mode === 'new' ? [
      field(
        'catalog-connection-name',
        'New connection name',
        nameInput,
        'Required. This is how the connection appears in the catalogue.'
      ),
      githubTokenField(
        'catalog-connection-token',
        'GitHub token',
        tokenInput,
        creating
          ? 'Temporary creation token: All repositories, Administration and Contents read/write. Token help explains conditional workflow access and narrowing access afterward.'
          : 'Fine-grained token. Repository access: Only select repositories. Repository permissions: Contents \u2014 Read and write.',
        creating ? 'create' : 'existing'
      ),
      persistRow,
      persistHint,
    ] : [];

    // ---- an existing connection -------------------------------------------

    const summary = selected
      ? h(
          'div',
          { class: 'catalog-connection-summary' },
          h('strong', {}, selected.name),
          h('code', {}, `@${selected.accountLogin}`),
          chip(connectionStatusLabel(selected.status), statusChipFor(selected.status))
        )
      : null;

    const reconnectFields = needsToken ? [
      h(
        'p',
        { class: 'hint' },
        `The saved credential for "${selected?.name}" is not usable. Paste a replacement fine-grained token for ${selected?.accountLogin}. A token for any other account is refused, because every workspace saved under this connection was chosen with this account's access.`
      ),
      githubTokenField('catalog-connection-token', `Reconnect ${selected?.name}`, tokenInput, null, creating ? 'create' : 'existing'),
      // Offered only when it can change something: with no key mounted there is
      // nothing to tick, and a control that does nothing is worse than none.
      vault.available ? persistRow : null,
      vault.available ? null : persistHint,
    ].filter(Boolean) : [];

    const liveFields = [
      h(
        'p',
        { class: 'hint' },
        creating
          ? 'This connection already has a credential. Creating and populating a new private repository needs All repositories access with Administration and Contents read/write. Use a temporary creation token if this connection is limited to existing repositories.'
          : 'This connection already has a credential. Continue to choose a repository \u2014 you can attach as many repositories and branches through it as you like.'
      ),
    ];

    const idleFields = [
      h(
        'p',
        { class: 'hint' },
        'This connection is saved on this device. Citadel is restoring it from the encrypted credential \u2014 no token needed.'
      ),
      region.root,
    ];

    // ---- continue ---------------------------------------------------------

    const next = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        onclick: async () => {
          next.disabled = true;
          state.working = true;
          say(error, '');
          try {
            if (mode === 'new') {
              const name = (nameInput.value || '').trim();
              if (!name) throw new Error('Give this connection a name first.');
              const token = tokenInput.value;
              tokenInput.value = '';
              stages.begin('restore', 'Validating the token with GitHub');
              const created = await actions.createConnection({
                name,
                token,
                persist: persistInput.checked,
              });
              state.account = created;
              state.profileId = created?.profile?.id || created?.profileId || null;
              if (persistInput.checked && created?.persisted === false) {
                say(
                  error,
                  'Connected, but the credential could not be encrypted on this device. This connection lasts for this session only.'
                );
              }
            } else if (needsToken) {
              const token = tokenInput.value;
              tokenInput.value = '';
              stages.begin('restore', `Reconnecting ${selected.name}`);
              state.account = await actions.reconnectConnection(selected.id, {
                token,
                persist: vault.available ? persistInput.checked : undefined,
              });
            } else {
              // Live or idle: the server already holds, or can unseal, the
              // credential. Nothing is asked of the user.
              stages.begin('restore', live ? `Using ${selected.name}` : `Restoring ${selected.name}`);
              state.account = live
                ? await actions.useConnection(selected.id)
                : await actions.resumeConnection(selected.id);
            }
            if (creating) {
              if (!Number.isSafeInteger(state.account?.accountId)) {
                throw new Error('GitHub returned an unusable account identity. Reconnect before creating a repository.');
              }
              if (state.creation.accountId !== state.account.accountId) {
                // The old account's durable attempts remain on the server.
                state.creation = newRepositoryCreationState(state.account.accountId);
              }
            } else {
              stages.begin('repos');
              await selection.connect(state.account);
            }
            stages.succeed();
            state.working = false;
            state.replaceCreationToken = false;
            go(creating ? 'creation' : 'repository');
          } catch (failure) {
            state.working = false;
            stages.fail(failure?.message || String(failure));
            // A saved credential that will not open is a recovery state for that
            // specific connection, not a reason to ask for a new connection.
            if (selected && !needsToken) state.resumeFailed = true;
            say(error, failure?.message || String(failure));
            next.disabled = false;
            if (state.resumeFailed) go('connection');
          }
        },
      },
      needsToken ? `Reconnect and continue` : 'Continue'
    );

    const body = h(
      'div',
      { class: 'catalog-form' },
      chooser
        ? field(
            'catalog-connection-select',
            'Connection',
            chooser,
            'Pick a saved connection, or choose "Add a new connection" to enter a token.'
          )
        : h(
            'p',
            { class: 'hint' },
            'No connection is saved yet. Name this one, then paste a fine-grained personal access token for the account that owns the repositories.'
          ),
      summary,
      ...(mode === 'new' ? newFields : needsToken ? reconnectFields : live ? liveFields : idleFields),
      creating && selected && !needsToken
        ? h('button', {
            class: 'btn btn-sm',
            type: 'button',
            onclick: () => { state.replaceCreationToken = true; go('connection'); },
          }, 'Update token for repository creation')
        : null,
      error
    );

    present(
      mode === 'new' ? 'Add a GitHub connection' : `Use ${selected.name}`,
      body,
      [backButton('source'), next],
      mode === 'new' ? chooser || nameInput : needsToken ? tokenInput : next
    );

    // An idle connection restores itself. Kicking it off after `present` keeps
    // the dialog painted first, and the attempt is tried once per entry so a
    // refused credential does not spin.
    if (idle && !needsToken && !state.resumeFailed && !state.working) {
      next.click();
    }
  }

  function creationStep() {
    const form = state.creation;
    const error = alertLine();
    const progress = createRepositoryProgress();
    const preview = h('div');
    const previous = h('div', { class: 'catalog-form' });
    let operation = form.operation;
    let history = [];
    let listed = false;
    let busy = false;
    let disposed = false;
    let timer = null;
    let ticker = null;
    let lastStatusAt = null;
    let statusFailed = false;
    let revision = 0;
    const active = () => operation && (operation.running === true || ['preparing', 'creating', 'copying', 'verifying'].includes(operation.state));
    const name = h('input', {
      id: 'catalog-create-repository-name', class: 'ctl', type: 'text', maxlength: '100',
      value: form.name, placeholder: 'my-citadel', autocomplete: 'off',
      oninput: () => { form.name = name.value; },
    });
    const source = h('input', {
      id: 'catalog-create-repository-source', class: 'ctl', type: 'url', maxlength: '2048',
      value: form.sourceUrl, autocomplete: 'off', spellcheck: 'false',
      oninput: () => { form.sourceUrl = source.value; },
    });
    const stopPolling = () => { if (timer) clearTimeout(timer); timer = null; };
    disposeStep = () => { disposed = true; stopPolling(); clearInterval(ticker); };

    function accept(result) {
      lastStatusAt = Date.now();
      statusFailed = false;
      operation = result;
      form.operation = result;
      form.uncertain = false;
      form.name = result.destination.name;
      if (result.sourceUrl) form.sourceUrl = result.sourceUrl;
      else if (result.source?.fullName && result.source?.ref) {
        form.sourceUrl = `https://github.com/${result.source.fullName}/tree/${result.source.ref.split('/').map(encodeURIComponent).join('/')}`;
      }
      name.value = form.name;
      source.value = form.sourceUrl;
      say(error, result.error?.message || '');
    }

    function schedule(delay = 1000) {
      stopPolling();
      if (!disposed && (active() || form.uncertain || statusFailed)) timer = setTimeout(() => poll(), delay);
    }

    async function poll() {
      if (disposed || busy || !operation) return;
      const id = operation.id;
      const generation = revision;
      try {
        const result = await actions.repositoryCreationStatus(id);
        if (disposed || busy || generation !== revision || id !== operation?.id) return;
        accept(result);
        paint();
        schedule();
      } catch (failure) {
        if (disposed || busy || generation !== revision || id !== operation?.id) return;
        statusFailed = true;
        say(error, `Setup status could not be confirmed: ${failure.message} Retrying automatically. The private repository may already exist; refresh this attempt rather than creating another.`);
        paint();
        schedule(3000);
      }
    }

    async function perform(work, { mutation = false } = {}) {
      if (busy) return;
      stopPolling();
      revision += 1;
      busy = true;
      if (mutation) form.uncertain = true;
      say(error, '');
      paint();
      try {
        const result = await work();
        if (!disposed) accept(result);
      } catch (failure) {
        if (!disposed) say(error, form.uncertain
          ? `${failure.message} GitHub may have completed this request. Refresh this same attempt to confirm the result; do not start another setup.`
          : failure?.message || String(failure));
      } finally {
        busy = false;
        if (!disposed) { paint(); schedule(); }
      }
    }

    async function refreshPrevious() {
      try {
        const result = await actions.listRepositoryCreations();
        if (disposed) return;
        history = result.operations;
        listed = true;
        paint();
      } catch (failure) {
        if (!disposed) say(error, `Previous setup attempts could not be loaded: ${failure.message} Refresh attempts before starting another setup.`);
      }
    }

    const prepare = h('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: () => perform(async () => {
        const validName = validateNewRepositoryName(name.value);
        parseRepositorySource(source.value);
        const signature = JSON.stringify([validName, source.value.trim()]);
        if (form.signature !== signature) {
          form.key = globalThis.crypto.randomUUID();
          form.signature = signature;
        }
        return actions.prepareRepository({ name: validName, sourceUrl: source.value.trim(), operationKey: form.key });
      }),
    }, 'Check source');
    const create = h('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: () => perform(() => actions.startRepositoryCreation(operation.id), { mutation: true }),
    }, 'Create private repository');
    const resume = h('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: () => perform(() => actions.resumeRepositoryCreation(operation.id), { mutation: true }),
    }, 'Resume this attempt');
    const pause = h('button', {
      class: 'btn', type: 'button',
      onclick: () => perform(() => actions.pauseRepositoryCreation(operation.id), { mutation: true }),
    }, 'Pause setup');
    const check = h('button', {
      class: 'btn', type: 'button',
      onclick: () => perform(() => actions.repositoryCreationStatus(operation.id)),
    }, 'Refresh status');
    const edit = h('button', {
      class: 'btn', type: 'button',
      onclick: () => {
        if (busy || form.uncertain || active() || operation?.created) {
          say(error, 'This attempt cannot be discarded. Refresh its status or pause it before continuing.');
          return;
        }
        stopPolling();
        revision += 1;
        operation = null;
        form.operation = null;
        form.key = null;
        form.signature = null;
        say(error, '');
        paint();
        name.focus();
      },
    }, 'Edit setup');
    const changeToken = h('button', {
      class: 'btn btn-sm', type: 'button',
      onclick: () => { state.replaceCreationToken = true; go('connection'); },
    }, 'Update connection token');
    const next = h('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: async () => {
        if (busy) return;
        revision += 1;
        stopPolling();
        busy = true;
        paint();
        try {
          const confirmed = await actions.repositoryCreationStatus(operation.id);
          if (confirmed.state !== 'complete') throw new Error('Repository setup is not complete. Resume this attempt first.');
          const repository = await actions.getRepository(confirmed.destination.repositoryId);
          await selection.connect(state.account);
          selection.includeRepository(repository);
          await selection.selectRepository(repository.id);
          state.working = false;
          go('repository');
        } catch (failure) {
          if (!disposed) say(error, `The private repository is retained, but the repository picker could not be opened: ${failure.message}`);
        } finally {
          busy = false;
          if (!disposed) paint();
        }
      },
    }, 'Continue to repository');
    const back = backButton('connection');
    const refresh = h('button', { class: 'btn btn-sm', type: 'button', onclick: refreshPrevious }, 'Refresh attempts');

    function paint() {
      state.working = busy || (Boolean(active()) && !statusFailed);
      name.disabled = busy || Boolean(operation);
      source.disabled = busy || Boolean(operation);
      prepare.hidden = Boolean(operation);
      prepare.disabled = busy || !listed || form.uncertain;
      create.hidden = form.uncertain || !operation?.canStart;
      create.disabled = busy || statusFailed;
      resume.hidden = form.uncertain || !operation?.canResume;
      resume.disabled = busy || statusFailed || operation?.retryAt > Date.now();
      pause.hidden = !operation || (!operation.canPause && !form.uncertain);
      pause.disabled = busy;
      check.hidden = !operation;
      check.disabled = busy;
      edit.hidden = !operation || operation.created || Boolean(active()) || form.uncertain;
      edit.disabled = busy || form.uncertain;
      next.hidden = form.uncertain || operation?.state !== 'complete';
      next.disabled = busy;
      back.disabled = state.working;
      changeToken.disabled = state.working;
      refresh.disabled = busy;
      progress.update({ operation, busy, uncertain: form.uncertain, lastStatusAt, statusFailed });
      for (const button of [prepare, create, resume, pause, next]) button.setAttribute('aria-busy', String(busy && !button.hidden));
      const row = (label, value) => h('div', { class: 'catalog-summary-row' }, h('dt', {}, label), h('dd', {}, value));
      mount(preview, operation ? h('div', { class: 'catalog-form' },
        h('dl', { class: 'catalog-summary' },
          row('Destination', h('code', {}, operation.destination.fullName)),
          row('Visibility', 'Private only'),
          row('Source', operation.source ? h('code', {}, `${operation.source.fullName} @ ${operation.source.ref}`) : 'Checking source'),
          operation.source?.commit ? row('Pinned commit', h('code', {}, operation.source.commit)) : null,
          operation.source?.fileCount ? row('Snapshot', `${operation.source.fileCount} files, ${(operation.source.totalBytes / 1024 / 1024).toFixed(1)} MiB; target branch main`) : null
        ),
        operation.source?.hasWorkflows
          ? h('p', { class: 'hint' }, operation.actionsDisabled
              ? 'Actions were disabled on this repository for the import. Review the copied workflows before re-enabling Actions. Workflows read/write is needed to copy these files.'
              : 'This source contains workflow files. The token also needs Workflows read/write. Actions will be disabled on the new repository before copying and remain disabled until you review the workflows.')
          : null,
        form.uncertain
          ? h('p', { class: 'hint' }, 'GitHub may have created or updated the private repository. This attempt is retained until its status is confirmed; editing the setup or starting a replacement is not safe yet.')
          : operation.created
          ? h('p', { class: 'hint' }, 'The private repository has been created and is retained if setup is interrupted. Resume this same attempt; it will not create another repository. ',
              h('a', { href: `https://github.com/${operation.destination.fullName}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open the private repository on GitHub'))
          : h('p', { class: 'hint' }, 'Checking the source creates nothing on GitHub. Review the pinned snapshot before choosing Create private repository.')
      ) : null);
      mount(previous, history.length ? h('details', {},
        h('summary', {}, 'Previous setup attempts'),
        h('ul', { class: 'catalog-attached' }, history.map((item) => h('li', {},
          h('button', {
            class: 'btn btn-sm', type: 'button', disabled: state.working || form.uncertain,
            onclick: () => perform(() => actions.repositoryCreationStatus(item.id)),
          }, `Open ${item.destination.fullName}`),
          h('span', { class: 'hint' }, ` \u2014 ${item.state}`)
        )))
      ) : null);
    }

    present(
      'Create a private GitHub repository',
      h('div', { class: 'catalog-form' },
        h('p', { class: 'hint' }, `The repository will be created in your personal account @${state.account.login}. New repositories are always private. Existing repositories are never overwritten.`),
        progress.root,
        field('catalog-create-repository-name', 'Repository name', name),
        field('catalog-create-repository-source', 'Source repository URL', source, 'Use a GitHub repository or branch URL. The checked-out source files, including binary assets and licenses, are copied into a fresh snapshot.'),
        h('div', { class: 'catalog-form-actions' }, changeToken, refresh),
        previous,
        preview,
        error
      ),
      [back, edit, prepare, create, resume, pause, check, next],
      name
    );
    ticker = setInterval(() => {
      progress.tick();
      if (operation?.retryAt) resume.disabled = busy || statusFailed || operation.retryAt > Date.now();
    }, 1000);
    paint();
    refreshPrevious();
    if (operation) poll();
  }

  function repositoryStep() {
    const error = alertLine();
    const search = h('input', {
      id: 'catalog-repo-search',
      class: 'ctl',
      type: 'search',
      value: selection.repositoryFilter,
      placeholder: 'Filter repositories',
      'aria-label': 'Filter repositories',
      oninput: (event) => {
        selection.setRepositoryFilter(event.target.value);
        paint();
      },
    });
    const list = h('select', {
      id: 'catalog-repo-list',
      class: 'ctl',
      size: '8',
      'aria-label': 'Repository',
    });
    const next = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Continue');

    function paint() {
      const visible = selection.visibleRepositories();
      mount(
        list,
        visible.map((repository) =>
          h(
            'option',
            {
              value: String(repository.id),
              disabled: !isRepositorySelectable(repository),
              selected: selection.repository?.id === repository.id,
            },
            `${repository.fullName} \u2014 ${[repository.visibility, repositoryBlockedReason(repository)]
              .filter(Boolean)
              .join(', ')}`
          )
        )
      );
      next.disabled = !selection.repository || !isRepositorySelectable(selection.repository);
    }

    list.addEventListener('change', async () => {
      say(error, '');
      try {
        await selection.selectRepository(list.value);
      } catch (failure) {
        say(error, failure?.message || String(failure));
      }
      paint();
    });
    next.addEventListener('click', () => go('branch'));

    paint();
    present(
      'Choose a repository',
      h(
        'div',
        { class: 'catalog-form' },
        h(
          'p',
          { class: 'hint' },
          `Signed in as ${state.account?.login || 'GitHub'}. Only repositories this token can reach are listed; archived and read-only repositories cannot be attached.`
        ),
        field('catalog-repo-search', 'Filter', search),
        field('catalog-repo-list', 'Repository', list),
        error
      ),
      [backButton('connection'), next],
      search
    );
  }

  function branchStep() {
    const error = alertLine();
    const progress = statusLine();
    const search = h('input', {
      id: 'catalog-branch-search',
      class: 'ctl',
      type: 'search',
      placeholder: 'Filter branches',
      'aria-label': 'Filter branches',
      oninput: (event) => {
        selection.setBranchFilter(event.target.value);
        paint();
      },
    });
    const list = h('select', {
      id: 'catalog-branch-list',
      class: 'ctl',
      size: '8',
      'aria-label': 'Source branch',
    });
    const writeMode = h('input', {
      id: 'catalog-branch-working',
      type: 'checkbox',
      class: 'ctl-check',
      checked: selection.writeMode === 'working-branch',
      onchange: (event) => {
        selection.setWriteMode(event.target.checked ? 'working-branch' : 'direct');
        paint();
      },
    });
    const branchName = h('input', {
      id: 'catalog-branch-name',
      class: 'ctl',
      type: 'text',
      // Deliberately no value and no `value:` binding. Pre-filling is how the
      // opaque `citadel-ui/<uuid>` branch happened: a name nobody typed looks
      // exactly like a name somebody approved.
      placeholder: 'e.g. citadel-ui/my-work',
      'aria-label': 'New branch name',
      oninput: (event) => {
        selection.setNewBranchName(event.target.value);
        paint();
      },
    });
    const suggestion = h('button', { class: 'btn btn-sm', type: 'button' }, 'Use suggested name');
    const adopt = h('input', {
      id: 'catalog-branch-adopt',
      type: 'checkbox',
      class: 'ctl-check',
      onchange: (event) => {
        selection.setAdoptExisting(event.target.checked);
        paint();
      },
    });
    const adoptRow = h(
      'label',
      { class: 'catalog-persist', for: 'catalog-branch-adopt' },
      adopt,
      h('span', {}, 'Use the existing branch as it is')
    );
    const nameRow = h(
      'div',
      { class: 'catalog-branch-name' },
      field('catalog-branch-name', 'New branch name', branchName),
      suggestion
    );
    // The whole point of the redesign: say where a save will land, before it
    // lands, in words, so nobody has to open GitHub to find out.
    const target = h('p', { class: 'catalog-target', role: 'status', 'aria-live': 'polite' });
    const targetProblem = alertLine();
    const protection = statusLine();
    const verdict = h('div', { class: 'catalog-verdict' });
    const next = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Continue');

    function paint() {
      const visible = selection.visibleBranches();
      mount(
        list,
        // Nothing is preselected. The branch decides which tree Citadel edits, so
        // it is chosen rather than defaulted.
        h('option', { value: '', selected: !selection.branch }, 'Select a branch\u2026'),
        visible.map((branch) =>
          h(
            'option',
            { value: branch.name, selected: selection.branch === branch.name },
            branch.protected ? `${branch.name} (protected)` : branch.name
          )
        )
      );
      say(progress, selection.validating ? 'Checking this branch for the Citadel source layout\u2026' : '');
      say(error, selection.validationError || '');
      const detected = selection.validation?.detected || [];
      mount(
        verdict,
        selection.validation?.supported
          ? [
              h('p', { class: 'catalog-verdict-ok' }, `${selection.repository.fullName} is a Citadel repository on ${selection.branch}.`),
              detected.length
                ? h('div', { class: 'catalog-capabilities' }, detected.map((item) => chip(item, 'chip-ok')))
                : null,
            ]
          : []
      );

      // The write target, stated before anything is created.
      const creating = selection.writeMode === 'working-branch';
      writeMode.checked = creating;
      nameRow.hidden = !creating;
      const decision = selection.writeTarget();
      say(target, selection.branch ? decision.summary : '');
      say(targetProblem, decision.problem || '');
      // Adoption is only offered for a name that actually collides, and only
      // while that exact name is in the field.
      adoptRow.hidden = !decision.needsAdoption;
      adopt.checked = selection.adoptExisting;
      const suggested = selection.suggestedBranchName();
      suggestion.hidden = !creating || !suggested;
      suggestion.textContent = suggested ? `Use ${suggested}` : 'Use suggested name';
      // Protection is a property of the branch, known from the branch list, so
      // it can be said at selection time rather than after the first save fails.
      say(
        protection,
        decision.ok && decision.protectedTarget
          ? `${decision.workingBranch} is protected. Citadel will commit your change and, if the branch refuses it, put that commit on a branch of its own and tell you where.`
          : ''
      );
      next.disabled = !selection.canAttach();
    }

    list.addEventListener('change', () => {
      selection.selectBranch(list.value);
      paint();
    });
    suggestion.addEventListener('click', () => {
      const name = selection.suggestedBranchName();
      if (!name) return;
      branchName.value = name;
      selection.setNewBranchName(name);
      paint();
      branchName.focus?.();
    });
    selection.onChange = () => paint();
    next.addEventListener('click', () => go('details'));

    paint();
    present(
      'Choose the source branch',
      h(
        'div',
        { class: 'catalog-form' },
        h(
          'p',
          { class: 'hint' },
          `Branches in ${selection.repository?.fullName || 'the selected repository'}. Citadel validates the branch you choose against the exact commit it is on before anything is created.`
        ),
        field('catalog-branch-search', 'Filter', search),
        field('catalog-branch-list', 'Source branch', list),
        h(
          'label',
          { class: 'catalog-persist', for: 'catalog-branch-working' },
          writeMode,
          // Unticked by default. Saves go to the branch above unless the user
          // asks for a separate one, which they then name.
          h('span', {}, 'Create a separate branch to work in')
        ),
        nameRow,
        adoptRow,
        target,
        targetProblem,
        protection,
        progress,
        verdict,
        error
      ),
      [backButton('repository'), next],
      search
    );
  }

  function detailsStep() {
    const error = alertLine();
    const projects = actions.projects || [];
    const suggested =
      state.environmentLabel ||
      (state.kind === 'github' && selection.branch ? selection.branch : 'Development');
    const projectSelect = h(
      'select',
      { id: 'catalog-details-project', class: 'ctl', 'aria-label': 'Project' },
      h('option', { value: '' }, 'New project\u2026'),
      projects.map((project) =>
        h('option', { value: project.id, selected: state.projectId === project.id }, project.label)
      )
    );
    const projectLabel = h('input', {
      id: 'catalog-details-project-label',
      class: 'ctl',
      value: state.projectLabel,
      maxlength: '160',
      'aria-label': 'New project name',
    });
    const environmentLabel = h('input', {
      id: 'catalog-details-environment',
      class: 'ctl',
      value: suggested,
      maxlength: '160',
      'aria-label': 'Workspace name',
    });
    const localPath = h('input', {
      id: 'catalog-details-path',
      class: 'ctl',
      value: state.localPath,
      placeholder: 'C:\\source\\citadel or /home/user/citadel',
      'aria-label': 'Local path',
    });
    const chosenFolder = h('p', { class: 'hint' }, state.handle ? `Folder: ${state.handle.name}` : '');
    const projectRow = field(
      'catalog-details-project',
      'Project',
      projectSelect,
      'Workspaces are grouped by project. A workspace name is unique inside its project.'
    );
    const projectLabelRow = field('catalog-details-project-label', 'New project name', projectLabel);
    projectSelect.addEventListener('change', () => {
      state.projectId = projectSelect.value || null;
      projectLabelRow.hidden = Boolean(projectSelect.value);
    });
    projectLabelRow.hidden = Boolean(state.projectId);

    const chooseFolder = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          say(error, '');
          try {
            state.handle = await actions.pickFolder();
            chosenFolder.textContent = `Folder: ${state.handle.name}`;
          } catch (failure) {
            if (failure?.name !== 'AbortError') say(error, failure?.message || String(failure));
          }
        },
      },
      state.handle ? 'Choose a different folder' : 'Choose Citadel folder'
    );

    const next = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        onclick: () => {
          say(error, '');
          state.projectId = projectSelect.value || null;
          state.projectLabel = projectLabel.value.trim();
          state.environmentLabel = environmentLabel.value.trim();
          state.localPath = localPath.value.trim();
          if (!state.projectId && !state.projectLabel) {
            say(error, 'Name the new project, or choose an existing one.');
            return;
          }
          if (!state.environmentLabel) {
            say(error, 'Name this workspace.');
            return;
          }
          const clash = rows.find(
            (row) =>
              row.environment.projectId === state.projectId &&
              row.label.trim().toLowerCase() === state.environmentLabel.toLowerCase()
          );
          if (clash) {
            say(error, `This project already has a workspace named "${clash.label}".`);
            return;
          }
          if (state.kind === 'local') {
            if (!state.localPath) {
              say(error, 'Enter the absolute path of the Citadel folder, for display in the header.');
              return;
            }
            if (!state.handle) {
              say(error, 'Choose the Citadel folder before continuing.');
              return;
            }
          } else {
            const existing = rows.find(
              (row) =>
                row.kind === 'github' &&
                row.environment.projectId === state.projectId &&
                (row.source.connectionProfileId || null) === state.profileId &&
                row.source.repositoryId === selection.repository?.id &&
                row.source.sourceBranch === selection.branch
            );
            if (existing) {
              say(
                error,
                `${existing.location} on ${existing.branch} is already attached to this project as "${existing.label}".`
              );
              const openExisting = h(
                'button',
                {
                  class: 'btn btn-primary',
                  type: 'button',
                  onclick: () => {
                    dismissDialog(true);
                    finish(null);
                    onOpenExisting(existing.environment.id);
                  },
                },
                'Open existing workspace'
              );
              error.after(openExisting);
              return;
            }
          }
          go('review');
        },
      },
      'Continue'
    );

    present(
      state.kind === 'local' ? 'Name and choose the folder' : 'Name this workspace',
      h(
        'div',
        { class: 'catalog-form' },
        projectRow,
        projectLabelRow,
        field('catalog-details-environment', 'Workspace name', environmentLabel),
        state.kind === 'local'
          ? field(
              'catalog-details-path',
              'Local path',
              localPath,
              'Display only. The browser cannot verify it against the selected folder.'
            )
          : null,
        state.kind === 'local' ? h('div', { class: 'catalog-form-actions' }, chooseFolder, chosenFolder) : null,
        error
      ),
      [backButton(state.kind === 'local' ? 'source' : 'branch'), next],
      environmentLabel
    );
  }

  function reviewStep() {
    const error = alertLine();
    const summary = (term, value) => h('div', { class: 'catalog-summary-row' }, h('dt', {}, term), h('dd', {}, value));
    // Real stages, driven by the attachment workflow's own await boundaries.
    // The region carries the spinner on the running step, a checkmark on each
    // completed one, and its list is `role=status aria-live=polite`.
    const local = state.kind === 'local';
    const stages = new StageTracker(local ? LOCAL_ATTACH_STAGES : ATTACH_STAGES, { onChange: () => region.update(stages) });
    const region = createStageRegion({
      label: 'Attachment progress', keepOnSuccess: true,
      waitingMessage: local ? 'Still working with the local folder\u2026 large folders or permission checks can take a moment.' : undefined,
    });
    let ticking = null;
    const track = (id, label) => {
      if (id === 'ready') stages.succeed(label);
      else stages.begin(id, label);
      // The "still waiting" line is time-based, so something has to re-render it
      // while a step is simply taking a while.
      if (stages.running && !ticking) ticking = setInterval(() => region.update(stages), 1000);
      if (!stages.running && ticking) {
        clearInterval(ticking);
        ticking = null;
      }
    };

    const attach = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        onclick: async () => {
          attach.disabled = true;
          state.working = true;
          say(error, '');
          if (local) stages.reset();
          try {
            const workspace =
              state.kind === 'local'
                ? await actions.attachLocal({
                    projectId: state.projectId,
                    projectLabel: state.projectLabel,
                    environmentLabel: state.environmentLabel,
                    localPath: state.localPath,
                    handle: state.handle,
                    stage: track,
                  })
                : await actions.attachGitHub({
                    projectId: state.projectId,
                    projectLabel: state.projectLabel,
                    environmentLabel: state.environmentLabel,
                    ...selection.attachment(),
                    stage: track,
                  });
            state.working = false;
            if (ticking) clearInterval(ticking);
            dismissDialog(true);
            finish(workspace);
          } catch (failure) {
            state.working = false;
            if (ticking) clearInterval(ticking);
            // An unresolved attempt is not a failure. The server may have
            // finished; the answer was lost. Saying "failed" here is what the
            // activity log contradicted, so the stage stays running and the
            // button offers to resume the *same* attempt.
            const unresolved = Boolean(failure?.attachUnresolved || failure?.attachUnconfirmed);
            stages.fail(failure?.message || String(failure), failure?.attachStage || null);
            if (unresolved) {
              stages.error = failure.message;
              stages.begin(failure.attachStage || 'branch');
              region.update(stages);
            }
            say(
              error,
              unresolved
                ? 'GitHub may have completed this step; checking\u2026 Retry resumes the same attempt and cannot create a second branch.'
                : ''
            );
            attach.textContent = unresolved ? 'Retry this attempt' : 'Attach workspace';
            attach.disabled = false;
          }
        },
      },
      'Attach workspace'
    );

    present(
      'Review and attach',
      h(
        'div',
        { class: 'catalog-form' },
        h(
          'dl',
          { class: 'catalog-summary' },
          summary('Project', state.projectId ? actions.projectName(state.projectId) : state.projectLabel),
          summary('Workspace', state.environmentLabel),
          summary('Source', state.kind === 'github' ? 'GitHub repository' : 'Local folder'),
          state.kind === 'github'
            ? summary('Repository', h('code', {}, selection.repository?.fullName || ''))
            : summary('Folder', h('code', {}, state.handle?.name || '')),
          state.kind === 'github' ? summary('Source branch', h('code', {}, selection.branch)) : null,
          state.kind === 'github'
            ? summary(
                'Writes go to',
                // The exact branch, named. "A Citadel working branch" was the
                // wording that let an opaque `citadel-ui/<uuid>` pass review
                // without the user ever seeing what it would be called.
                h('code', {}, selection.writeTarget().workingBranch || selection.branch)
              )
            : summary('Local path', h('code', {}, state.localPath)),
          state.kind === 'github' && selection.writeMode === 'working-branch'
            ? summary(
                'That branch',
                selection.writeTarget().branchChoice === 'adopted'
                  ? 'already exists, and you chose to use it'
                  : `will be created from ${selection.branch}`
              )
            : null,
          state.kind === 'github'
            ? summary(
                'Validated at',
                h('code', {}, (selection.validation?.head || '').slice(0, 12) || 'the current head')
              )
            : null
        ),
        h(
          'p',
          { class: 'hint' },
          state.kind === 'github'
            ? 'Citadel re-checks this exact commit on the server immediately before it creates anything. If the branch moved, the attach is refused rather than applied to a tree you did not review.'
            : 'Citadel reads the folder now to confirm it is a Citadel repository. Nothing is written.'
        ),
        region.root,
        error
      ),
      [backButton('details'), attach],
      attach
    );
  }

  function render() {
    // The masthead tracks the flow, so the header names the account, repository
    // and branch as they are chosen rather than sitting on a placeholder.
    onContext({
      sourceKind: state.kind,
      projectLabel: state.projectLabel || 'Citadel',
      environmentLabel: state.environmentLabel || 'New workspace',
      account: state.account?.login || null,
      repository: selection.repository?.fullName || null,
      branch: selection.branch || null,
    });
    ({
      source: sourceStep,
      connection: connectionStep,
      creation: creationStep,
      repository: repositoryStep,
      branch: branchStep,
      details: detailsStep,
      review: reviewStep,
    })[state.step]();
  }

  render();
  return { dispose: () => { closed = true; disposeStep?.(); } };
}
