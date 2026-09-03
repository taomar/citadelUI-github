/**
 * GitHub source setup panel for the landing page.
 *
 * Flow: connect a fine-grained token, review the account, search the
 * repositories that credential can actually reach, pick a branch, choose the
 * write mode, then attach.
 *
 * The user never types an owner/repository path. Repositories come from
 * `GET /user/repos` for the connected credential and branches from that
 * repository, so exactly what the token was granted appears and nothing is
 * hardcoded.
 *
 * All selection rules live in `github-selection.mjs`; this module only renders
 * that state and forwards events to it.
 */
import {
  checkGitHubCompatibility,
  connectGitHub,
  disconnectGitHub,
  githubStatus,
  listGitHubBranches,
  listGitHubRepositories,
} from './github-session.mjs';
import { githubSessions } from './github-session-manager.mjs';
import {
  RepositorySelection,
  TOKEN_REQUIREMENTS,
  isRepositorySelectable,
  repositoryBlockedReason,
} from './github-selection.mjs';
import { closeDialog, showDialog } from './dialog.mjs';
import { CONNECT_STAGES, StageTracker, createStageRegion } from './stage-progress.mjs';
import {
  connectionStatusLabel,
  isConnectionLive,
  isConnectionResumable,
  listConnections,
} from './github-connections.mjs';

function element(name, attributes = {}, ...children) {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function repositoryLabel(repository) {
  const blocked = repositoryBlockedReason(repository);
  const tags = [repository.visibility, blocked].filter(Boolean);
  return `${repository.fullName} — ${tags.join(', ')}`;
}

/**
 * How to create the credential this panel needs.
 *
 * Opened as a dialog because it is reference material the user reads once,
 * copies from, and dismisses; inline it would push the form it explains below
 * the fold.
 *
 * Two routes are offered because the token itself can only be created on
 * github.com — GitHub exposes no API or CLI command that mints a fine-grained
 * personal access token — so the command-line route opens that page and then
 * verifies the result before the user pastes it. `gh auth token` is deliberately
 * called out as unusable here: it returns an OAuth token, which Citadel refuses
 * because its access cannot be limited to selected repositories.
 */
const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new';

/**
 * The same page, prefilled with the name, description, expiry, and the single
 * permission Citadel actually uses.
 *
 * `target_name` and `owner` are deliberately absent: hard-coding either would
 * silently point the token at the wrong account for anyone whose repositories
 * live in an organisation. GitHub defaults the Resource owner to the signed-in
 * user, so the steps tell the user to verify it.
 *
 * `contents=write` is the only permission requested. Metadata is added by GitHub
 * automatically; Pull requests is not requested because Citadel opens a compare
 * URL that github.com's own session authorises and calls no pull request API.
 */
const TOKEN_PAGE_PREFILLED = `${TOKEN_PAGE}?name=Citadel+Control+Panel&description=Edit+Citadel+configuration+repositories&expires_in=30&contents=write`;

function permissionSpec() {
  const row = (name, value, note) =>
    element(
      'tr',
      {},
      element('th', { scope: 'row' }, element('code', {}, name)),
      element('td', {}, value),
      element('td', { class: 'setup-help-note' }, note)
    );
  return element(
    // Its own scroller: at narrow widths a three-column spec would otherwise
    // widen the whole dialog and clip the prose beside it.
    'div',
    { class: 'setup-help-spec-scroller', tabindex: '0', role: 'group', 'aria-label': 'Repository permissions' },
    element(
      'table',
      { class: 'setup-help-spec' },
      element('caption', {}, 'Repository permissions'),
      element(
        'tbody',
        {},
        row('Contents', 'Read and write', 'Reads sources and creates the commit.'),
        row('Metadata', 'Read-only', 'Granted automatically with repository access.')
      )
    )
  );
}

function commandBlock(lines) {
  return element(
    'pre',
    { class: 'setup-help-code' },
    element('code', {}, lines.join('\n'))
  );
}

function browserMethod() {
  return element(
    'div',
    { class: 'setup-help-method' },
    element(
      'a',
      {
        class: 'btn btn-primary setup-help-action',
        href: TOKEN_PAGE_PREFILLED,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      'Open prefilled GitHub token form'
    ),
    element(
      'p',
      { class: 'hint' },
      'Opens github.com with the name, description, a 30-day expiry and ',
      element('code', {}, 'Contents: Read and write'),
      ' already requested. GitHub selects the signed-in account as Resource owner — check it before generating.'
    ),
    element(
      'ol',
      { class: 'setup-help-steps' },
      element(
        'li',
        {},
        element('strong', {}, 'Resource owner'),
        ': choose the user or organization that owns the Citadel repositories.'
      ),
      element(
        'li',
        {},
        element('strong', {}, 'Repository access'),
        ': choose ',
        element('strong', {}, 'Only select repositories'),
        ', then select the Citadel repositories.'
      ),
      element(
        'li',
        {},
        element('strong', {}, 'Permissions \u203a Repository permissions'),
        ': use the permission search, find ',
        element('code', {}, 'Contents'),
        ', set ',
        element('strong', {}, 'Read and write'),
        ' (the prefilled link already requests it).'
      ),
      element(
        'li',
        {},
        element('code', {}, 'Metadata: Read-only'),
        ' is added automatically by GitHub and may not be editable.'
      ),
      element(
        'li',
        {},
        'Leave every other Repository, Account and Organization permission at ',
        element('strong', {}, 'No access'),
        '. Pull requests is not required.'
      ),
      element(
        'li',
        {},
        'Generate the token, copy it once, paste it only into Citadel, and use a short expiration.'
      )
    ),
    element(
      'p',
      { class: 'hint' },
      'Prefer to start from a blank form? Open ',
      element(
        'a',
        { href: TOKEN_PAGE, target: '_blank', rel: 'noopener noreferrer' },
        'Fine-grained personal access tokens'
      ),
      ' and follow the same steps.'
    ),
    permissionSpec()
  );
}

function commandLineMethod() {
  return element(
    'div',
    { class: 'setup-help-method' },
    element(
      'p',
      {},
      'A fine-grained token can only be created on github.com — there is no API or ',
      element('code', {}, 'gh'),
      ' command that mints one. Open the page from your shell, then verify the token before pasting it.'
    ),
    element('h4', {}, 'Required settings'),
    element(
      'p',
      {},
      'Whichever route you use, the token must be fine-grained with ',
      element('strong', {}, 'Repository access'),
      ' set to ',
      element('strong', {}, 'Only select repositories'),
      ', and only ',
      element('strong', {}, 'Contents: Read and write'),
      ' plus ',
      element('strong', {}, 'Metadata: Read-only'),
      '. Citadel needs no Pull requests permission.'
    ),
    element('h4', {}, 'Open the token page'),
    commandBlock([
      `# Windows\nstart ${TOKEN_PAGE}`,
      '',
      `# macOS\nopen ${TOKEN_PAGE}`,
      '',
      `# Linux\nxdg-open ${TOKEN_PAGE}`,
    ]),
    element('h4', {}, 'Verify it before pasting'),
    element(
      'p',
      {},
      'Confirm the account and that the repositories you expect are listed. Read the token at a masked prompt so it never reaches shell history, an argument list, or any longer-lived environment:'
    ),
    element('h4', {}, 'PowerShell'),
    commandBlock([
      '$token = Read-Host "GitHub token" -MaskInput',
      'try {',
      '  $env:GH_TOKEN = $token',
      '  gh api user --jq .login',
      "  gh api 'user/repos?per_page=100' --jq '.[].full_name'",
      '} finally {',
      '  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue',
      '  $token = $null',
      '}',
    ]),
    element('h4', {}, 'bash or zsh'),
    commandBlock([
      'read -rsp "GitHub token: " CITADEL_TOKEN; echo',
      "trap 'unset CITADEL_TOKEN' EXIT",
      '',
      '# Scoped to each command; never exported to later processes.',
      'GH_TOKEN="$CITADEL_TOKEN" gh api user --jq .login',
      'GH_TOKEN="$CITADEL_TOKEN" gh api \'user/repos?per_page=100\' --jq \'.[].full_name\'',
      '',
      'unset CITADEL_TOKEN',
    ]),
    element(
      'p',
      { class: 'hint' },
      'Without the GitHub CLI the same check is ',
      element(
        'code',
        {},
        'curl -sH "Authorization: Bearer $CITADEL_TOKEN" https://api.github.com/user'
      ),
      ', reusing the prompted variable. Never echo the token or type it into a command line.'
    ),
    element(
      'p',
      { class: 'setup-help-warn' },
      element('strong', {}, 'Do not use '),
      element('code', {}, 'gh auth token'),
      '. It returns the CLI\u2019s own OAuth token, which Citadel refuses because its access cannot be limited to selected repositories.'
    )
  );
}

function openTokenGuide() {
  const browser = browserMethod();
  const cli = commandLineMethod();
  cli.hidden = true;

  const tab = (label, selected) =>
    element(
      'button',
      {
        class: `btn btn-sm${selected ? ' btn-primary' : ''}`,
        type: 'button',
        role: 'tab',
        'aria-selected': String(selected),
      },
      label
    );
  const browserTab = tab('On GitHub.com', true);
  const cliTab = tab('From the command line', false);
  const select = (useBrowser) => {
    browser.hidden = !useBrowser;
    cli.hidden = useBrowser;
    browserTab.classList.toggle('btn-primary', useBrowser);
    cliTab.classList.toggle('btn-primary', !useBrowser);
    browserTab.setAttribute('aria-selected', String(useBrowser));
    cliTab.setAttribute('aria-selected', String(!useBrowser));
  };
  browserTab.addEventListener('click', () => select(true));
  cliTab.addEventListener('click', () => select(false));

  showDialog(
    'Create a GitHub access token',
    element(
      'div',
      { class: 'setup-help-body' },
      element(
        'div',
        { class: 'setup-help-tabs', role: 'tablist', 'aria-label': 'Token method' },
        browserTab,
        cliTab
      ),
      browser,
      cli,
      element(
        'p',
        { class: 'hint' },
        'GitHub shows the token once. If the repository belongs to an organisation, an owner may need to approve the token before it works.'
      )
    ),
    [element('button', { class: 'btn btn-primary', onclick: () => closeDialog() }, 'Close')],
    { initialFocus: browserTab }
  );
}

/**
 * Build the GitHub panel.
 *
 * @param {object} options `onAttach` receives the attachment payload; the
 *   caller owns registry writes and activation.
 */
export function createGitHubPanel(options = {}) {
  const {
    onAttach,
    onMessage = () => {},
    onContext = () => {},
    connect = connectGitHub,
    disconnect = disconnectGitHub,
    status = githubStatus,
    listRepositories = listGitHubRepositories,
    listBranches = listGitHubBranches,
    checkCompatibility = checkGitHubCompatibility,
    sessions = githubSessions,
  } = options;

  const selection = new RepositorySelection({
    listRepositories,
    listBranches,
    checkCompatibility,
    sessions,
    onStage: (id, label) => {
      if (id === 'ready') connectStages.succeed(label);
      else connectStages.begin(id, label);
    },
    onChange: () => render(),
  });
  // Declared before the tracker: `StageTracker`'s constructor resets, which
  // notifies, which renders this region. Declaring it after would be a temporal
  // dead zone the moment the panel is built.
  const connectProgress = createStageRegion({ label: 'GitHub connection progress' });
  const connectStages = new StageTracker(CONNECT_STAGES, { onChange: () => renderStages() });
  let slowTimer = null;

  function renderStages() {
    connectProgress.update(connectStages);
    // The "still waiting" line is time-based, so something has to re-render it
    // while a stage is simply taking a while.
    if (connectStages.running && !slowTimer) {
      slowTimer = setInterval(() => connectProgress.update(connectStages), 1000);
    } else if (!connectStages.running && slowTimer) {
      clearInterval(slowTimer);
      slowTimer = null;
    }
  }
  let attaching = false;

  const root = element('section', { class: 'setup-github' });
  const accountLine = element('small', { class: 'hint', id: 'setup-github-account' });
  // Progress and failure are separate elements on purpose. A single node whose
  // role flips between `status` and `alert` is announced inconsistently, and the
  // user needs the failure to persist while the progress line clears.
  const progressLine = element('p', {
    class: 'setup-github-progress',
    id: 'setup-github-progress',
    role: 'status',
    'aria-live': 'polite',
    hidden: true,
  });
  const errorLine = element('p', {
    class: 'field-error setup-github-error',
    id: 'setup-github-error',
    role: 'alert',
    hidden: true,
  });

  const tokenInput = element('input', {
    id: 'setup-github-token',
    name: 'githubToken',
    class: 'ctl',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'github_pat_...',
    'aria-label': 'GitHub fine-grained personal access token',
    'aria-describedby': 'setup-github-account setup-github-progress setup-github-error',
  });
  /**
   * Which saved connection this panel is using, and what to call a new one.
   *
   * Every credential this product accepts now belongs to a named connection.
   * Leaving one path that produces an anonymous session would leave workspaces
   * attached through nothing — visible in the catalogue, permanently marked
   * "Reconnect", and impossible to attribute to an account.
   */
  const connectionSelect = element('select', {
    id: 'setup-github-connection',
    class: 'ctl',
    'aria-label': 'GitHub connection',
  });
  const connectionName = element('input', {
    id: 'setup-github-connection-name',
    class: 'ctl',
    maxlength: '80',
    placeholder: 'Work account',
    'aria-label': 'New connection name',
  });
  const persistInput = element('input', {
    id: 'setup-github-persist',
    type: 'checkbox',
    class: 'ctl-check',
  });
  let savedConnections = [];
  let vaultAvailable = false;

  /** The chosen saved connection, or null when the user is adding one. */
  function chosenConnection() {
    return savedConnections.find((profile) => profile.id === connectionSelect.value) || null;
  }

  function renderConnections() {
    connectionSelect.replaceChildren(
      element('option', { value: '' }, 'Add a new connection\u2026'),
      ...savedConnections.map((profile) =>
        element(
          'option',
          { value: profile.id },
          `${profile.name} (@${profile.accountLogin}) \u2014 ${connectionStatusLabel(profile.status)}`
        )
      )
    );
    connectionSelect.hidden = savedConnections.length === 0;
    persistInput.disabled = !vaultAvailable;
  }

  async function loadConnections() {
    try {
      const result = await listConnections();
      savedConnections = (result?.profiles || []).filter(
        (profile) => isConnectionLive(profile) || isConnectionResumable(profile)
      );
      vaultAvailable = Boolean(result?.vault?.available);
    } catch {
      savedConnections = [];
      vaultAvailable = false;
    }
    renderConnections();
    render();
  }

  const searchInput = element('input', {
    id: 'setup-github-search',
    name: 'repositorySearch',
    class: 'ctl',
    type: 'search',
    placeholder: 'Filter repositories',
    'aria-label': 'Filter repositories',
  });
  const repositorySelect = element('select', {
    id: 'setup-github-repository',
    class: 'ctl',
    size: '6',
    'aria-label': 'Repository',
  });
  const branchSearch = element('input', {
    id: 'setup-github-branch-search',
    class: 'ctl',
    type: 'search',
    placeholder: 'Filter branches',
    'aria-label': 'Filter branches',
  });
  const branchSelect = element('select', {
    id: 'setup-github-branch',
    class: 'ctl',
    'aria-label': 'Source branch',
  });
  const workingBranchMode = element('input', {
    id: 'setup-github-working-branch',
    type: 'checkbox',
    // Unticked. Saves go to the branch the user selected unless they ask for a
    // separate one and name it.
    checked: false,
  });
  const workingBranchName = element('input', {
    id: 'setup-github-branch-name',
    class: 'ctl',
    type: 'text',
    // No prefilled value, deliberately: a name nobody typed reads as a name
    // somebody approved, which is how the opaque branch got created.
    placeholder: 'e.g. citadel-ui/my-work',
    'aria-label': 'New branch name',
  });
  const adoptExisting = element('input', {
    id: 'setup-github-adopt',
    type: 'checkbox',
  });
  const adoptRow = element(
    'label',
    { class: 'setup-github-mode', for: 'setup-github-adopt' },
    adoptExisting,
    element('span', {}, 'Use the existing branch as it is')
  );
  const branchNameRow = element(
    'label',
    { class: 'setup-stack', for: 'setup-github-branch-name' },
    'New branch name',
    workingBranchName
  );
  // Where a save will land, said before anything is created.
  const writeTargetLine = element('p', {
    class: 'setup-github-progress is-settled',
    id: 'setup-github-target',
    role: 'status',
    'aria-live': 'polite',
    hidden: true,
  });
  const writeTargetError = element('p', {
    class: 'field-error setup-github-error',
    id: 'setup-github-target-error',
    role: 'alert',
    hidden: true,
  });
  const attachButton = element('button', { class: 'btn btn-primary' }, 'Attach repository');
  // Structure verdict, next to the Branch row it describes.
  const validationLine = element('p', {
    class: 'setup-github-progress',
    id: 'setup-github-validation',
    role: 'status',
    'aria-live': 'polite',
    hidden: true,
  });
  const validationError = element('p', {
    class: 'field-error setup-github-error',
    id: 'setup-github-validation-error',
    role: 'alert',
    hidden: true,
  });

  function render() {
    const restoring = Boolean(sessions?.isRestoring);
    // The manager's lock is application-wide: another panel restoring or
    // exchanging a credential must disable this one's controls too, or a click
    // here is refused after the fact rather than prevented.
    const busy =
      selection.loading || selection.connecting || restoring || attaching || Boolean(sessions?.busy);
    accountLine.textContent = selection.connected
      ? `Connected as ${selection.account.login}. The token stays in server memory only and is cleared on restart or disconnect.`
      : TOKEN_REQUIREMENTS;

    // The attempt has to be visible, not merely inferable from a disabled
    // control. A user who cannot see that anything is happening reads a slow
    // connect as a dead button.
    // The staged list is the richer account of a connect, so the one-line
    // progress steps aside while it is running rather than saying it twice.
    const progress = connectStages.running
      ? ''
      : restoring
        ? 'Checking for an existing GitHub connection\u2026'
        : selection.connecting
          ? 'Connecting to GitHub\u2026'
          : selection.loading && selection.connected
            ? 'Loading repositories from GitHub\u2026'
            : '';
    progressLine.textContent = progress;
    progressLine.hidden = !progress;
    root.classList.toggle('is-busy', Boolean(progress));

    // A failure has to appear beside the field that caused it. Routing it only
    // to the page-level status put it after the whole form, where it was missed.
    // While the staged list is showing the failure with the step it failed at,
    // this would only repeat it.
    const failure =
      selection.error && !connectStages.error
        ? selection.connected
          ? selection.error
          : `Connection failed: ${selection.error}`
        : '';
    errorLine.textContent = failure;
    errorLine.hidden = !failure;

    connectButton.textContent = restoring
      ? 'Checking connection\u2026'
      : selection.connecting
        ? 'Connecting\u2026'
        : 'Connect GitHub';
    connectButton.setAttribute('aria-busy', String(selection.connecting || restoring));

    tokenInput.disabled = busy || selection.connected || Boolean(chosenConnection());
    connectButton.disabled = busy || selection.connected;
    connectionSelect.disabled = busy || selection.connected;
    connectionName.disabled = busy || selection.connected || Boolean(chosenConnection());
    connectionName.hidden = Boolean(chosenConnection());
    persistInput.disabled =
      busy || selection.connected || !vaultAvailable || Boolean(chosenConnection());
    disconnectButton.disabled = busy || !selection.connected;
    searchInput.disabled = busy || !selection.connected;
    repositorySelect.disabled = busy || !selection.connected;
    branchSearch.disabled = busy || !selection.repository;
    branchSelect.disabled = busy || !selection.repository;
    workingBranchMode.disabled = busy || !selection.branch;
    workingBranchName.disabled = busy || selection.writeMode !== 'working-branch';
    adoptExisting.disabled = busy;
    attachButton.disabled = busy || !selection.canAttach();

    if (searchInput.value !== selection.repositoryFilter) {
      searchInput.value = selection.repositoryFilter;
    }
    if (branchSearch.value !== selection.branchFilter) {
      branchSearch.value = selection.branchFilter;
    }

    const repositories = selection.visibleRepositories();
    repositorySelect.replaceChildren(
      ...(repositories.length
        ? repositories.map((repository) =>
            element(
              'option',
              {
                value: String(repository.id),
                selected: selection.repository?.id === repository.id,
                disabled: !isRepositorySelectable(repository),
                title: isRepositorySelectable(repository)
                  ? `Default branch ${repository.defaultBranch || 'unknown'}`
                  : 'Archived or read-only repositories cannot be attached for editing.',
              },
              repositoryLabel(repository)
            )
          )
        : [
            element(
              'option',
              { disabled: true },
              selection.connected
                ? 'No repository matches this filter.'
                : 'Connect GitHub to list repositories.'
            ),
          ])
    );

    const branches = selection.visibleBranches();
    branchSelect.replaceChildren(
      // The placeholder is a real, selected, non-value option so the control
      // opens on "no choice made" rather than on a branch nobody picked.
      ...(selection.repository
        ? [
            element(
              'option',
              { value: '', selected: !selection.branch, disabled: true },
              'Choose a branch'
            ),
          ]
        : []),
      ...(branches.length
        ? branches.map((branch) =>
            element(
              'option',
              { value: branch.name, selected: branch.name === selection.branch },
              branch.protected ? `${branch.name} (protected)` : branch.name
            )
          )
        : [
            element(
              'option',
              { disabled: true },
              selection.repository
                ? 'No branch matches this filter.'
                : 'Select a repository to list branches.'
            ),
          ])
    );

    workingBranchMode.checked = selection.writeMode === 'working-branch';
    branchNameRow.hidden = selection.writeMode !== 'working-branch';
    const writeTarget = selection.writeTarget();
    adoptRow.hidden = !writeTarget.needsAdoption;
    adoptExisting.checked = selection.adoptExisting;
    const targetText = selection.branch
      ? writeTarget.ok && writeTarget.protectedTarget
        ? `${writeTarget.summary} ${writeTarget.workingBranch} is protected; if it refuses the commit, Citadel puts it on a branch of its own and tells you where.`
        : writeTarget.summary
      : '';
    writeTargetLine.textContent = targetText;
    writeTargetLine.hidden = !targetText;
    writeTargetError.textContent = writeTarget.problem || '';
    writeTargetError.hidden = !writeTarget.problem || !selection.branch;

    // What the structure check is doing, or found, beside the Branch row.
    const checking = selection.validating;
    const verdict = selection.validation;
    const validationText = checking
      ? 'Checking Citadel structure\u2026'
      : verdict?.supported
        ? `Citadel repository confirmed on ${verdict.branch}${
            verdict.detected?.length ? `. Detected: ${verdict.detected.join(', ')}.` : '.'
          }`
        : '';
    validationLine.textContent = validationText;
    validationLine.hidden = !validationText;
    // Only the in-flight state gets the spinner; a settled verdict is not
    // progress and must not keep animating.
    validationLine.classList.toggle('is-settled', Boolean(validationText) && !checking);

    validationError.textContent = selection.validationError || '';
    validationError.hidden = !selection.validationError;

    // The panel states its own connection status in `accountLine`. Echoing that
    // outward as well printed the same sentence twice on the setup screen, so
    // `onMessage` carries only what the panel cannot show itself: errors, and
    // progress from the caller's own attach handler.
    if (selection.error) onMessage(selection.error);
    publishContext();
  }

  /** Tell the shell what this panel currently represents, for the masthead. */
  function publishContext() {
    onContext({
      account: selection.account?.login || null,
      repository: selection.repository?.fullName || null,
      branch: selection.branch || null,
      validated: selection.validation?.supported === true,
    });
  }

  const connectButton = element(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        // The raw token leaves the DOM before anything else, including before
        // the refusal check. Reading it after the guard left the credential
        // sitting in a live input for the lifetime of the page whenever another
        // panel happened to be restoring or connecting.
        const token = tokenInput.value;
        tokenInput.value = '';
        const existing = chosenConnection();
        const name = connectionName.value.trim();
        // Connecting is serialised application-wide, so two panels cannot both
        // exchange a credential and overwrite one browser session. A restore
        // still in flight counts: its answer would otherwise land afterwards and
        // replace whatever this connect established.
        if (selection.connecting || sessions?.busy) {
          // Never silent: a click that does nothing and says nothing reads as a
          // dead button, and the field has just been cleared.
          selection.error = 'A GitHub connection is already in progress. Try again in a moment.';
          onMessage(selection.error);
          render();
          return;
        }
        if (!existing && !name) {
          // Refused before the token is spent: a nameless connection cannot be
          // told apart from any other one later, and the name cannot be added
          // afterwards without another paste.
          selection.error = 'Name this connection before connecting.';
          onMessage(selection.error);
          render();
          connectionName.focus();
          return;
        }
        connectStages.reset();
        try {
          const account = await selection.beginConnect(connect, token, {
            skipTokenShape: Boolean(existing),
            exchange: existing
              ? () => sessions.resumeProfile(existing.id)
              : (value) =>
                  sessions.connectProfile({
                    name,
                    token: value,
                    persist: persistInput.checked,
                  }),
          });
          // A superseded attempt resolves to `null` without throwing and without
          // reaching the final stage. Left alone the tracker stays "running", so
          // the 1 Hz refresh never stops and the list sits on "Authenticating"
          // for the rest of the session.
          if (!account) connectStages.reset();
          else await loadConnections();
        } catch (error) {
          connectStages.fail(`Connection failed: ${error.message}`);
          onMessage(error.message);
          render();
          // The field is empty and enabled again, so returning focus to it is
          // the retry affordance; `errorLine` is an alert and is announced
          // without stealing focus from it.
          if (!tokenInput.disabled) tokenInput.focus();
        }
      },
    },
    'Connect GitHub'
  );

  const disconnectButton = element(
    'button',
    {
      class: 'btn btn-sm',
      type: 'button',
      onclick: async () => {
        try {
          const result = sessions ? await sessions.disconnect() : await disconnect();
          selection.reset();
          onMessage(
            result.alreadyAbsent
              ? 'That GitHub session had already expired. The token is not in server memory.'
              : 'Disconnected from GitHub. The token was erased from server memory.'
          );
        } catch (error) {
          // The credential may still be live, so the session id is deliberately
          // kept and the failure is shown rather than swallowed.
          onMessage(error.message);
          render();
        }
      },
    },
    'Disconnect GitHub'
  );

  tokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      connectButton.click();
    }
  });
  searchInput.addEventListener('input', () => selection.setRepositoryFilter(searchInput.value));
  branchSearch.addEventListener('input', () => selection.setBranchFilter(branchSearch.value));
  repositorySelect.addEventListener('change', async () => {
    try {
      await selection.selectRepository(repositorySelect.value);
    } catch (error) {
      onMessage(error.message);
      render();
    }
  });
  branchSelect.addEventListener('change', () => selection.selectBranch(branchSelect.value));
  workingBranchMode.addEventListener('change', () =>
    selection.setWriteMode(workingBranchMode.checked ? 'working-branch' : 'direct')
  );
  workingBranchName.addEventListener('input', () =>
    selection.setNewBranchName(workingBranchName.value)
  );
  adoptExisting.addEventListener('change', () =>
    selection.setAdoptExisting(adoptExisting.checked)
  );

  attachButton.addEventListener('click', async () => {
    if (!selection.canAttach()) return;
    attaching = true;
    render();
    try {
      await onAttach({ ...selection.attachment(), repository: selection.repository });
    } catch (error) {
      onMessage(error.message);
    } finally {
      attaching = false;
      render();
    }
  });

  root.replaceChildren(
    element(
      'label',
      { for: 'setup-github-connection' },
      'Connection',
      element(
        'span',
        { class: 'setup-stack' },
        connectionSelect,
        connectionName,
        element(
          'span',
          { class: 'setup-github-mode' },
          persistInput,
          element('span', {}, 'Persist this connection on this device (encrypted)')
        )
      )
    ),
    element(
      'label',
      { for: 'setup-github-token' },
      'Access token',
      element(
        'span',
        { class: 'setup-inline' },
        tokenInput,
        connectButton,
        disconnectButton
      ),
      accountLine,
      progressLine,
      connectProgress.root,
      errorLine,
      element(
        'button',
        {
          class: 'setup-help-link',
          type: 'button',
          onclick: () => openTokenGuide(),
        },
        'How to create this token'
      )
    ),
    element(
      'label',
      { for: 'setup-github-search' },
      'Repository',
      element('span', { class: 'setup-stack' }, searchInput, repositorySelect)
    ),
    element(
      'label',
      { for: 'setup-github-branch-search' },
      'Branch',
      element('span', { class: 'setup-stack' }, branchSearch, branchSelect),
      validationLine,
      validationError
    ),
    element(
      'label',
      { for: 'setup-github-working-branch' },
      'Write mode',
      element(
        'span',
        { class: 'setup-github-mode' },
        workingBranchMode,
        element('span', {}, 'Create a separate branch to work in')
      ),
      branchNameRow,
      adoptRow,
      writeTargetLine,
      writeTargetError
    ),
    element('div', { class: 'setup-actions' }, attachButton)
  );

  render();
  renderConnections();
  loadConnections().catch(() => {});

  // Every panel follows the one credential. Without this a panel that was open
  // when another one disconnected would keep showing its account and repository
  // list, and its Attach button would still be live.
  const unsubscribe = sessions?.subscribe((manager) => {
    if (!manager.connected && selection.connected) selection.reset();
    else render();
  });

  return {
    root,
    selection,
    /** Re-announce the panel's state to the shell, e.g. when it becomes visible. */
    publishContext,
    /**
     * Adopt whatever credential the application already holds.
     *
     * Delegated to the manager so a session restored in one panel becomes the
     * whole application's, and awaited so a panel cannot start a competing
     * connect while the answer is still outstanding.
     */
    async restore() {
      try {
        const current = sessions ? await sessions.restore() : await status();
        if (!current?.connected) return false;
        await selection.connect(current);
        return true;
      } catch {
        return false;
      }
    },
    /** Stop listening for credential changes when the panel goes away. */
    dispose() {
      unsubscribe?.();
    },
  };
}
