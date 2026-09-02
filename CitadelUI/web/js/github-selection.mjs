/**
 * Repository and branch selection state.
 *
 * Kept free of the DOM so the selection rules -- which repositories are
 * offered, what happens to the branch choice when the repository changes, and
 * exactly what gets attached -- are directly testable and cannot drift from
 * what the panel renders.
 *
 * Nothing here knows any repository or branch name. The lists come entirely
 * from what the connected credential can reach.
 */

/**
 * The exact settings the token needs, stated identically inline, in the token
 * guide, and in every panel's status line. Pull requests is deliberately
 * absent: Citadel opens a compare URL that github.com's own session authorises
 * and calls no pull request API, so asking for it would request more access
 * than the product uses.
 */
export const TOKEN_REQUIREMENTS =
  'Fine-grained token. Repository access: Only select repositories. Repository permissions: Contents — Read and write, Metadata — Read-only (automatic). Citadel UI never stores it.';

/** A repository that cannot receive Citadel commits is offered but not selectable. */
export function repositoryBlockedReason(repository) {
  if (!repository) return null;
  if (repository.disabled) return 'disabled';
  if (repository.archived) return 'archived';
  if (!repository.canPush) return 'read-only';
  return null;
}

export function isRepositorySelectable(repository) {
  return repositoryBlockedReason(repository) === null;
}

function matches(value, filter) {
  return !filter || String(value).toLowerCase().includes(filter.trim().toLowerCase());
}

/**
 * Reject a value that cannot possibly be a token, before it is sent.
 *
 * Deliberately minimal: the server's `classifyToken` is the authority on what is
 * accepted, and guessing at length or prefix here would reject credentials the
 * server would have taken. This only catches the two mistakes that are certainly
 * mistakes — an empty field, and a value broken across lines by copying.
 */
export function assertTokenShape(token) {
  const value = String(token || '').trim();
  if (!value) {
    throw new Error('Paste a GitHub fine-grained personal access token first.');
  }
  if (/\s/.test(value)) {
    throw new Error('That token contains whitespace. Copy it again without line breaks or spaces.');
  }
  return value;
}

export class RepositorySelection {
  constructor(options = {}) {
    this.listRepositories = options.listRepositories;
    this.listBranches = options.listBranches;
    this.checkCompatibility = options.checkCompatibility || null;
    // Notified as each real await boundary is crossed, so the panel can show
    // which step is running rather than an undifferentiated spinner.
    this.onStage = options.onStage || null;
    this.onChange = options.onChange || (() => {});
    // The credential itself is owned application-wide, not per panel: a per
    // panel lock cannot stop two panels from overwriting one browser session.
    this.sessions = options.sessions || null;
    this.requestId = 0;
    // Bumped whenever the credential changes, so responses belonging to a
    // superseded connection can be recognised and discarded.
    this.connectionId = 0;
    this.connecting = false;
    // Deliberately does not notify: a renderer that closes over this instance is
    // still in its temporal dead zone while the constructor runs.
    this.clear();
  }

  clear() {
    this.account = null;
    this.repositories = [];
    this.repositoriesTruncated = false;
    this.repositoryFilter = '';
    this.repository = null;
    this.branches = [];
    this.branchesTruncated = false;
    this.branchFilter = '';
    this.branch = '';
    this.writeMode = 'working-branch';
    this.loading = false;
    this.connecting = false;
    this.error = null;
    // Structure verdict for the selected repository and branch. Attach stays
    // refused until one arrives and reports `supported`.
    this.validating = false;
    this.validation = null;
    this.validationError = null;
    this.validationId = 0;
    // Guards against an out-of-order branch response from a repository the user
    // has already moved away from.
    this.requestId += 1;
    this.connectionId += 1;
  }

  reset() {
    this.clear();
    this.onChange(this);
  }

  get connected() {
    return Boolean(this.account);
  }

  /**
   * Exchange a credential for a session through the application-wide manager.
   *
   * The manager serialises across every panel and owns which credential is
   * active. This panel additionally binds its own generation, so a response it
   * started before losing the race cannot publish repositories.
   *
   * `options.exchange` replaces what is sent without changing any of the
   * concurrency rules around it. A named connection and a bare token differ only
   * in their request body; duplicating the generation, supersession and
   * stage-boundary logic per call site is how two of the three end up subtly
   * wrong. `options.skipTokenShape` exists for the one exchange that carries no
   * token at all — resuming a connection the server already holds.
   */
  async beginConnect(connect, token, options = {}) {
    const manager = this.sessions;
    const stage = this.onStage || (() => {});
    if (this.connecting || manager?.busy) {
      throw new Error('A GitHub connection is already in progress.');
    }
    this.connecting = true;
    this.error = null;
    this.onChange(this);
    const generation = ++this.connectionId;
    try {
      // Stage boundaries are the awaits themselves, so a stage can never be
      // reported as reached before the work it names has actually started.
      stage('token');
      if (!options.skipTokenShape) assertTokenShape(token);
      stage('auth');
      const outcome = options.exchange
        ? await options.exchange(token)
        : manager
          ? await manager.connect(token)
          : { account: await connect(token) };
      // `null` means the manager superseded this attempt and already revoked the
      // credential it obtained.
      const account = outcome?.account || null;
      if (!account || generation !== this.connectionId || (manager && !manager.isCurrent(outcome.generation))) {
        // Superseded while in flight: the credential is revoked rather than left
        // active and unreachable. Whatever superseded this attempt — a reset, a
        // disconnect, another panel — already released the lock and re-rendered.
        if (account && !manager) await account?.revoke?.().catch?.(() => {});
        if (generation === this.connectionId) {
          this.connecting = false;
          this.onChange(this);
        }
        return null;
      }
      this.account = account;
      this.connecting = false;
      this.onChange(this);
      stage('repos');
      await this.loadRepositories();
      stage('ready', `Connected as ${account.login}`);
      return account;
    } catch (error) {
      if (generation === this.connectionId) {
        this.connecting = false;
        this.error = error.message;
        this.onChange(this);
      }
      throw error;
    }
  }

  async connect(account) {
    this.account = account;
    await this.loadRepositories();
  }

  async loadRepositories() {
    // Every load is stamped with the current connection generation. A response
    // from a superseded connection is discarded rather than shown, so a second
    // credential can never display the first one's repositories.
    const generation = this.connectionId;
    this.loading = true;
    this.error = null;
    this.onChange(this);
    try {
      const result = await this.listRepositories();
      if (generation !== this.connectionId) return this.repositories;
      this.repositories = result.repositories || [];
      this.repositoriesTruncated = Boolean(result.truncated);
    } catch (error) {
      if (generation !== this.connectionId) return this.repositories;
      this.repositories = [];
      this.error = error.message;
      throw error;
    } finally {
      if (generation === this.connectionId) {
        this.loading = false;
        this.onChange(this);
      }
    }
    return this.repositories;
  }

  setRepositoryFilter(value) {
    this.repositoryFilter = String(value || '');
    this.onChange(this);
  }

  setBranchFilter(value) {
    this.branchFilter = String(value || '');
    this.onChange(this);
  }

  visibleRepositories() {
    return this.repositories.filter((repository) =>
      matches(repository.fullName, this.repositoryFilter)
    );
  }

  visibleBranches() {
    return this.branches.filter((branch) => matches(branch.name, this.branchFilter));
  }

  /**
   * Choose a repository and load its branches.
   *
   * Branch state is cleared immediately, including the branch filter, so a
   * filter typed for the previous repository cannot hide the new repository's
   * branches or leave a stale branch selected while the request is in flight.
   */
  async selectRepository(repositoryId) {
    const id = Number(repositoryId);
    const repository = this.repositories.find((item) => item.id === id) || null;
    const token = (this.requestId += 1);
    this.repository = repository;
    this.branches = [];
    this.branchesTruncated = false;
    this.branchFilter = '';
    this.branch = '';
    this.error = null;
    this.invalidateValidation();
    if (!repository) {
      this.onChange(this);
      return null;
    }
    this.loading = true;
    this.onChange(this);
    try {
      const result = await this.listBranches(repository.id);
      if (token !== this.requestId) return null;
      this.branches = result.branches || [];
      this.branchesTruncated = Boolean(result.truncated);
      // Deliberately left empty. Preselecting the default branch means a user
      // who never looked at this control still attaches *something*, and the
      // branch decides which tree Citadel edits. It has to be chosen.
      this.branch = '';
    } catch (error) {
      if (token !== this.requestId) return null;
      this.branches = [];
      this.branch = '';
      this.error = error.message;
      throw error;
    } finally {
      if (token === this.requestId) {
        this.loading = false;
        this.onChange(this);
      }
    }
    return this.repository;
  }

  selectBranch(name) {
    const value = String(name || '');
    this.branch = this.branches.some((branch) => branch.name === value) ? value : '';
    // A verdict belongs to one repository *and* one branch. Changing either
    // invalidates it, so Attach closes again until the new pair is checked.
    this.invalidateValidation();
    this.onChange(this);
    if (this.branch) this.validate().catch(() => {});
    return this.branch;
  }

  /** Discard any structure verdict; Attach is refused until a new one arrives. */
  invalidateValidation() {
    this.validationId += 1;
    this.validating = false;
    this.validation = null;
    this.validationError = null;
  }

  /**
   * Check that the selected repository and branch really are a Citadel
   * workspace, before anything is created.
   *
   * The server owns the verdict — it scans the tree with the same discovery the
   * local editor is judged by — and re-runs it during attachment. This call only
   * decides whether Attach may be offered, and which capabilities to name.
   */
  async validate() {
    if (!this.checkCompatibility || !this.repository || !this.branch) return null;
    const generation = (this.validationId += 1);
    const connection = this.connectionId;
    // The pair this verdict will be *about*, captured before the request. The
    // answer is bound to these rather than to whatever the response echoes: a
    // normalisation difference between what was asked and what came back would
    // otherwise make a successful check look permanently stale, leaving Continue
    // disabled and the line reading "Checking" forever.
    const repositoryId = this.repository.id;
    const branch = this.branch;
    this.validating = true;
    this.validation = null;
    this.validationError = null;
    this.onChange(this);
    try {
      const result = await this.checkCompatibility(repositoryId, branch);
      // A verdict that arrived after the user moved on, or under a credential
      // that has since been replaced, is discarded rather than shown.
      if (generation !== this.validationId || connection !== this.connectionId) return null;
      this.validation = { ...result, repositoryId, branch };
      if (!result.supported) {
        this.validationError = `${
          this.repository.fullName
        } is not a Citadel repository on ${branch}. Missing: ${
          (result.missingCapabilities || []).join(', ') || 'the Citadel source layout'
        }.`;
      }
      return this.validation;
    } catch (error) {
      if (generation !== this.validationId || connection !== this.connectionId) return null;
      this.validationError = error.message;
      return null;
    } finally {
      // Cleared when this attempt is still the current one. A superseded attempt
      // must not clear the flag its successor set, and the successor always runs
      // its own `finally`, so the flag cannot be stranded.
      if (generation === this.validationId) {
        this.validating = false;
        this.onChange(this);
      }
    }
  }

  setWriteMode(mode) {
    this.writeMode = mode === 'direct' ? 'direct' : 'working-branch';
    this.onChange(this);
    return this.writeMode;
  }

  selectedBranch() {
    return this.branches.find((branch) => branch.name === this.branch) || null;
  }

  canAttach() {
    return Boolean(
      this.connected &&
        !this.loading &&
        !this.connecting &&
        !this.validating &&
        this.repository &&
        isRepositorySelectable(this.repository) &&
        this.branch &&
        // A repository the token can push to is not automatically a Citadel
        // repository. Attach is offered only for a branch the server has
        // confirmed holds the Citadel source layout — and only for the exact
        // repository and branch that verdict was requested for.
        this.validation?.supported === true &&
        this.validation.branch === this.branch &&
        this.validation.repositoryId === this.repository.id
    );
  }

  /**
   * The exact payload the attach route receives.
   *
   * Identity is the immutable numeric repository id, never a name, so a rename
   * between listing and attaching cannot redirect the selection.
   */
  attachment() {
    if (!this.canAttach()) {
      throw new Error('Select a repository and branch you can push to.');
    }
    return {
      repositoryId: this.repository.id,
      sourceBranch: this.branch,
      writeMode: this.writeMode,
      // The exact head the structure check passed against. The server refuses
      // the attach if the branch has moved since, so a race cannot slip an
      // unvalidated tree past the gate.
      expectedHead: this.validation?.head || null,
    };
  }

  /** Short user-facing description of the current step. */
  status() {
    if (this.error) return this.error;
    if (!this.connected) {
      return TOKEN_REQUIREMENTS;
    }
    if (this.loading) return 'Loading from GitHub\u2026';
    if (!this.repository) {
      return this.repositoriesTruncated
        ? 'Showing the first page of repositories. Use the filter to narrow the list.'
        : `${this.repositories.length} repositories available to this token.`;
    }
    const blocked = repositoryBlockedReason(this.repository);
    if (blocked === 'read-only') {
      return 'This credential has no push access to that repository.';
    }
    if (blocked) {
      return `That repository is ${blocked} and cannot be attached for editing.`;
    }
    if (!this.branches.length) return 'That repository has no branches this token can list.';
    return `Select the source branch in ${this.repository.fullName}.`;
  }
}
