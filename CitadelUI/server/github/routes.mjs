/**
 * Same-origin GitHub routes.
 *
 * The browser never calls GitHub. Every route here runs after the existing host,
 * origin, fetch-site, session-token, body-size, and concurrency checks, and then
 * additionally requires an opaque GitHub credential session id, except for the
 * explicit public-donor and local-source preparation routes. Local-source
 * preparation changes only its bounded in-memory cache, never GitHub or files.
 *
 * Editable workspace repository/branch identity comes from the authoritative
 * registry, never the request body. Public donors are separate ephemeral
 * selections: they cannot redirect or attach an editable environment.
 */
import { GitHubApiClient, githubError } from './api.mjs';
import { PublicGitHubDonorRoutes } from './public-donor.mjs';
import { MigrationSourceRoutes } from './migration-source.mjs';
import { GitHubSessionStore } from './sessions.mjs';
import { createConnectionLifecycle } from './connection-lifecycle.mjs';
import { createWorkspaceRoutes } from './workspace-routes.mjs';
import {
  AttachmentReservations,
  RESERVATION_PENDING,
  reservationFingerprint,
} from './attachments.mjs';
import {
  getRepository,
  listBranches,
  listRepositories,
  validateBranchName,
  validateCommitSha,
  validateRepositoryId,
  workingBranchName,
  WORKING_BRANCH_PREFIX,
} from './repositories.mjs';
import {
  assertAction,
  commitChangeSet,
  createCommitBranch,
  ensureWorkingBranch,
  inspectCommit,
  loadHistory,
  readSubscriptionId,
  revertCommit,
} from './workspace.mjs';
import { branchHead, loadTree, readBlob, readSourceBlob, requireBranchHead } from './git-reader.mjs';
import {
  assertAttachableRepository,
  inspectBranchCompatibility,
} from './compatibility.mjs';
import { RepositoryCreationService } from './repository-creation.mjs';
import { LocalSourceImportService } from './local-import.mjs';
import { assertNoWritableOverlap, configurationKey, configurationOf, nativeInventoryAlias, unitForAlias, validateConfiguration, workspaceScope } from '../../shared/workspace-configuration.mjs';
import { assertNativeDependencySafe, assertNativeFileSafe, decodeNativeBytes, readUnitSchema } from '../../shared/terraform/workspace.mjs';
import { githubScanProvider } from './scan-provider.mjs';
import { repositoryOwner } from '../../shared/repository-owner.mjs';

const SESSION_HEADER = 'x-citadel-github-session';

export { connectionStatus } from './connection-lifecycle.mjs';

function assertKeys(body, allowed) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.has(key))
  ) {
    throw githubError(400, 'INVALID_CONTENT', 'Request contains unsupported fields.');
  }
}

function environmentIdOf(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw githubError(400, 'INVALID_ENVIRONMENT', 'Invalid environment id.');
  }
  return id;
}

function transactionIdOf(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    throw githubError(400, 'INVALID_TRANSACTION', 'Invalid transaction id.');
  }
  return id;
}

/** Client-chosen idempotency key for an attach, so a lost response can retry. */
function operationKeyOf(value, optional = false) {
  if (value === undefined || value === null) {
    if (optional) return null;
    return null;
  }
  const key = String(value);
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(key)) {
    throw githubError(400, 'INVALID_OPERATION_KEY', 'Invalid attachment operation key.');
  }
  return key;
}

export class GitHubRoutes {
  constructor(options = {}) {
    this.sessions = options.sessions || new GitHubSessionStore(options.sessionOptions);
    this.client = options.client || new GitHubApiClient(options.clientOptions);
    // Same fixed-host client, but no credential store or session is passed to
    // the public donor. Its separate facade permits anonymous GETs only.
    this.publicDonor = new PublicGitHubDonorRoutes({ client: this.client, ...(options.publicDonorOptions || {}) });
    this.localImports = new LocalSourceImportService({ client: this.client, ...(options.localImportOptions || {}) });
    this.registryStore = options.registryStore;
    this.audit = options.audit || null;
    this.profiles = options.profiles || null;
    this.vault = options.vault || null;
    this.activity = options.activity || null;
    this.attachments = options.attachments || new AttachmentReservations();
    this.creations = options.creations || (options.dataRoot
      ? new RepositoryCreationService({
          dataRoot: options.dataRoot,
          client: this.client,
          note: (event) => this.note(event),
          validateSession: (session) => this.sessions.assertActive(session),
        })
      : null);
    this.allowClassicTokens = Boolean(options.allowClassicTokens);
    this.migrationSource = new MigrationSourceRoutes({
      client: this.client, editableSessions: this.sessions, profiles: this.profiles, vault: this.vault,
      listConnections: () => this.connections(), allowClassicTokens: this.allowClassicTokens,
      ...(options.migrationSourceOptions || {}),
    });
    // Trees are immutable for a given commit, so caching by commit SHA is safe
    // and keeps an alias-scoped blob read from refetching the tree per file.
    this.treeCache = new Map();
    this.treeCacheLimit = options.treeCacheLimit ?? 8;
    // Blobs are content-addressed, so a SHA hit is the same bytes by
    // definition. Bounded, in memory only, and never written to `/data`.
    this.blobCache = new Map();
    this.blobCacheLimit = options.blobCacheLimit ?? 512;
    const owner = this;
    this.connectionLifecycle = createConnectionLifecycle({
      get sessions() { return owner.sessions; },
      get profiles() { return owner.profiles; },
      get vault() { return owner.vault; },
      get client() { return owner.client; },
      get allowClassicTokens() { return owner.allowClassicTokens; },
      note: (event) => this.note(event),
      forgetCaches: () => this.forgetCaches(),
      assertKeys,
    });
    this.workspaceRoutes = createWorkspaceRoutes({
      get client() { return owner.client; },
      get audit() { return owner.audit; },
      tree: (...args) => this.tree(...args),
      blob: (...args) => this.blob(...args),
      assertKeys,
      transactionIdOf,
      assertAction,
      requireBranchHead,
      readBlob,
      loadHistory,
      inspectCommit,
      readSubscriptionId,
      commitChangeSet,
      createCommitBranch,
      revertCommit,
    });
  }

  /** Governance events never fail the operation they describe. */
  note(event) {
    if (!this.activity) return;
    Promise.resolve(this.activity.record(event)).catch(() => {});
  }

  requireProfiles() {
    return this.connectionLifecycle.requireProfiles();
  }

  profileIdOf(value) {
    return this.connectionLifecycle.profileIdOf(value);
  }

  async tree(token, fullName, commitSha, configuration) {
    const key = `${fullName}:${commitSha}:${configurationKey(configuration)}`;
    if (!this.treeCache.has(key)) {
      const snapshot = await loadTree(this.client, token, fullName, commitSha, configuration);
      this.treeCache.set(key, snapshot);
      while (this.treeCache.size > this.treeCacheLimit) {
        this.treeCache.delete(this.treeCache.keys().next().value);
      }
    }
    return this.treeCache.get(key);
  }

  /**
   * Read one in-scope source, reusing an identical blob already in memory.
   *
   * A Git blob SHA is a hash of its bytes, so a hit is the same bytes by
   * construction — this is a content-addressed cache, not a guess about
   * freshness. Which blob a *path* points to still comes from the tree for the
   * exact head every time, so the cache can never answer with a stale revision
   * of a file: the key changes the moment the content does.
   *
   * It matters because ten templates were being fetched sixteen times for one
   * scan, and the whole scan ran again on reopen. The bytes live only in this
   * process and are never written to `/data`.
   */
  async blob(token, fullName, head, alias, sha, snapshot, repositoryId, configuration) {
    workspaceScope(configuration).read(alias);
    const entry = snapshot?.files?.find((file) => file.alias === alias) || null;
    if (entry && sha && entry.sha !== validateCommitSha(sha, 'blob')) {
      throw githubError(409, 'STALE_SOURCE', 'File changed outside Citadel UI. Reload before saving.');
    }
    // Only an entry the alias resolves to in this exact tree may be served from
    // cache. Anything else falls through to the authoritative read, which
    // performs the scope and precondition checks.
    const key = entry ? `${repositoryId}:${entry.sha}` : null;
    if (key && this.blobCache.has(key) && configuration?.format !== 'terraform') {
      const hit = this.blobCache.get(key);
      // Refresh recency: a Map preserves insertion order, so re-inserting is
      // what makes the bounded eviction least-recently-used rather than
      // first-in.
      this.blobCache.delete(key);
      this.blobCache.set(key, hit);
      return hit;
    }
    const blob = await readSourceBlob(this.client, token, fullName, head, alias, sha, snapshot, configuration);
    if (configuration?.format === 'terraform') {
      blob.text = decodeNativeBytes(blob.bytes);
      await assertNativeDependencySafe(blob.text, alias);
      const unit = unitForAlias(configuration, alias);
      if (unit) {
        const provider = githubScanProvider(this.client, token, fullName, snapshot, configuration);
        const { parameters } = await readUnitSchema(provider, unit);
        await assertNativeFileSafe(blob.text, unit, parameters);
      }
    }
    if (key && blob?.sha === entry.sha && configuration?.format !== 'terraform') {
      this.blobCache.set(key, blob);
      while (this.blobCache.size > this.blobCacheLimit) {
        this.blobCache.delete(this.blobCache.keys().next().value);
      }
    }
    return blob;
  }

  /** Forget cached trees and blobs, on disconnect or an identity change. */
  forgetCaches() {
    this.treeCache.clear();
    this.blobCache.clear();
  }

  session(req) {
    return this.sessions.resolve(req.headers[SESSION_HEADER]);
  }

  /** Authoritative GitHub source for an environment, from the /data mirror. */
  async source(environmentId) {
    const id = environmentIdOf(environmentId);
    const environment = await this.registryStore.getEnvironment(id);
    if (!environment) {
      throw githubError(404, 'UNKNOWN_ENVIRONMENT', 'That environment is not registered.');
    }
    if (environment.source?.kind !== 'github') {
      throw githubError(400, 'NOT_GITHUB_ENVIRONMENT', 'That environment is not a GitHub repository.');
    }
    return { environmentId: id, ...environment.source, configuration: configurationOf(environment) };
  }

  /**
   * Re-resolve the repository by immutable id on every workspace operation so a
   * rename or transfer cannot silently retarget an attached environment.
   *
   * Ownership is enforced here as well, because this is the one place every
   * read and every write passes through. A workspace attached through one
   * connection must not be edited under another account's credential: the
   * repository and branch were chosen with that connection's access, and the
   * commit would be attributed to whoever happens to be connected now.
   */
  async resolve(req, environmentId) {
    const session = this.session(req);
    const source = await this.source(environmentId);
    this.assertOwnership(session, source);
    const repository = await getRepository(this.client, session.token, source.repositoryId);
    if (repository.fullName !== source.fullName) {
      throw githubError(
        409,
        'REPOSITORY_RENAMED',
        `This repository is now ${repository.fullName}. Reattach the environment before saving.`
      );
    }
    return { session, source, repository, token: session.token };
  }

  /**
   * Refuse a credential that does not belong to the environment's connection.
   *
   * An environment with no recorded connection predates named connections and is
   * left alone here: it is refused earlier, in the browser, and marking it
   * unusable server-side would strand a v3 record with no path back.
   */
  assertOwnership(session, source) {
    if (!source.connectionProfileId) return;
    if (session.profileId === source.connectionProfileId) return;
    throw githubError(
      409,
      'CONNECTION_MISMATCH',
      'This workspace was attached through a different GitHub connection. Reconnect that connection before opening it.'
    );
  }

  async connect(body) {
    return this.connectionLifecycle.connect(body);
  }

  async identify(token) {
    return this.connectionLifecycle.identify(token);
  }

  async connections() {
    return this.connectionLifecycle.connections();
  }

  async persist(profile, token) {
    return this.connectionLifecycle.persist(profile, token);
  }

  async connectionResult(profile, session, persisted, reason = null) {
    return this.connectionLifecycle.connectionResult(profile, session, persisted, reason);
  }

  async createConnection(body) {
    return this.connectionLifecycle.createConnection(body);
  }

  async reconnectConnection(profileId, body) {
    return this.connectionLifecycle.reconnectConnection(profileId, body);
  }

  async resumeConnection(profileId) {
    return this.connectionLifecycle.resumeConnection(profileId);
  }

  async renameConnection(profileId, body) {
    return this.connectionLifecycle.renameConnection(profileId, body);
  }

  async setConnectionPersistence(profileId, body) {
    return this.connectionLifecycle.setConnectionPersistence(profileId, body);
  }

  async disconnectConnection(profileId) {
    return this.connectionLifecycle.disconnectConnection(profileId);
  }

  async removeConnection(profileId) {
    return this.connectionLifecycle.removeConnection(profileId);
  }

  /**
   * Route dispatcher for `/api/github/*`.
   *
   * @returns {Promise<object>} plain JSON payload, never containing a credential
   */
  async handle({ req, url, parts, readBody }) {
    const method = req.method;
    const tail = parts.slice(2);

    if (tail[0] === 'migration-source' && tail.length === 2) {
      return this.migrationSource.handle({ req, url, operation: tail[1], readBody });
    }

    // The normal owner/browser transport guard still runs in server/index.mjs.
    // Public source readers do not resolve or borrow an editable PAT/session.
    if (tail[0] === 'local-imports') {
      return this.localImports.handle({ req, url, tail, readBody });
    }
    if (tail[0] === 'public-donor' && tail.length === 2) {
      return this.publicDonor.handle({ req, url, operation: tail[1] });
    }

    if (method === 'POST' && tail[0] === 'sessions' && tail.length === 1) {
      return this.connect(await readBody());
    }
    if (method === 'GET' && tail[0] === 'sessions' && tail.length === 1) {
      return this.sessions.status(req.headers[SESSION_HEADER]);
    }
    if (method === 'DELETE' && tail[0] === 'sessions' && tail.length === 2) {
      // Report what actually happened. The browser only forgets its opaque id
      // once the credential is confirmed gone, so a transport failure surfaces
      // rather than silently leaving a live session behind.
      const disconnected = this.sessions.destroy(tail[1]);
      this.forgetCaches();
      return { disconnected, erased: true };
    }

    // Saved connections. These manage credentials rather than use one, so they
    // are authorised by the browser session alone and never require a GitHub
    // session header — a browser that has lost its opaque id must still be able
    // to resume a connection it saved.
    if (method === 'GET' && tail[0] === 'connections' && tail.length === 1) {
      return this.connections();
    }
    if (method === 'POST' && tail[0] === 'connections' && tail.length === 1) {
      return this.createConnection(await readBody());
    }
    if (method === 'DELETE' && tail[0] === 'connections' && tail.length === 2) {
      return this.removeConnection(this.profileIdOf(tail[1]));
    }
    if (method === 'POST' && tail[0] === 'connections' && tail.length === 3) {
      const profileId = this.profileIdOf(tail[1]);
      if (tail[2] === 'reconnect') return this.reconnectConnection(profileId, await readBody());
      if (tail[2] === 'resume') return this.resumeConnection(profileId);
      if (tail[2] === 'rename') return this.renameConnection(profileId, await readBody());
      if (tail[2] === 'persistence') {
        return this.setConnectionPersistence(profileId, await readBody());
      }
      if (tail[2] === 'disconnect') return this.disconnectConnection(profileId);
    }

    if (method === 'GET' && tail[0] === 'repos' && tail.length === 1) {
      const session = this.session(req);
      return listRepositories(this.client, session.token);
    }
    if (method === 'GET' && tail[0] === 'repos' && tail.length === 2) {
      const session = this.session(req);
      return getRepository(this.client, session.token, validateRepositoryId(tail[1]));
    }
    if (tail[0] === 'repository-owners') {
      const session = this.session(req);
      if (!this.creations) throw githubError(503, 'REPOSITORY_CREATION_UNAVAILABLE', 'Repository creation is unavailable in this deployment.');
      if (method === 'GET' && tail.length === 1) return this.creations.listOwners(session);
      if (method === 'POST' && tail.length === 1) {
        const body = await readBody();
        assertKeys(body, new Set(['owner', 'organization']));
        if (Boolean(body.owner) === Boolean(body.organization)) {
          throw githubError(400, 'IMPORT_INVALID_INPUT', 'Choose one owner or one explicit organization handle.');
        }
        return this.creations.checkOwner(session, body.owner || body.organization);
      }
      throw githubError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
    }
    if (tail[0] === 'repository-creations') {
      const session = this.session(req);
      if (!this.creations) {
        throw githubError(503, 'REPOSITORY_CREATION_UNAVAILABLE', 'Repository creation is unavailable in this deployment.');
      }
      if (method === 'GET' && tail.length === 1) return this.creations.list(session);
      if (method === 'POST' && tail.length === 1) {
        const body = await readBody();
        assertKeys(body, new Set(['name', 'sourceUrl', 'operationKey', 'owner']));
        if (body.owner !== undefined) {
          try { repositoryOwner(body.owner); }
          catch { throw githubError(400, 'IMPORT_INVALID_OWNER', 'Choose a valid Personal or Organization owner.'); }
        }
        return this.creations.prepare(session, body);
      }
      if (method === 'GET' && tail.length === 2) return this.creations.status(session, tail[1]);
      if (method === 'POST' && tail.length === 3 && ['start', 'resume', 'pause'].includes(tail[2])) {
        assertKeys(await readBody(), new Set());
        return this.creations[tail[2]](session, tail[1]);
      }
      throw githubError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
    }
    if (method === 'GET' && tail[0] === 'repos' && tail[2] === 'branches' && tail.length === 3) {
      const session = this.session(req);
      return listBranches(this.client, session.token, validateRepositoryId(tail[1]));
    }
    // Read-only Citadel structure check for one repository and branch. Creates
    // nothing: the browser uses it to decide whether Attach may be enabled, and
    // attachment re-runs it against the head it is about to branch from.
    if (method === 'GET' && tail[0] === 'repos' && tail[2] === 'native-inventory' && tail.length === 3) {
      const session = this.session(req);
      const repository = await getRepository(this.client, session.token, validateRepositoryId(tail[1]));
      const branch = validateBranchName(url.searchParams.get('branch'));
      const head = await requireBranchHead(this.client, session.token, repository.fullName, branch);
      const tree = await loadTree(this.client, session.token, repository.fullName, head, undefined, { nativeInventory: true });
      return { head, files: tree.files.filter((entry) => nativeInventoryAlias(entry.alias)).map(({ alias, kind }) => ({ alias, kind })) };
    }
    if (['GET', 'POST'].includes(method) && tail[0] === 'repos' && tail[2] === 'compatibility' && tail.length === 3) {
      const session = this.session(req);
      const repository = await getRepository(
        this.client,
        session.token,
        validateRepositoryId(tail[1])
      );
      const input = method === 'POST' ? await readBody() : null;
      if (input) assertKeys(input, new Set(['branch', 'configuration']));
      const configuration = input?.configuration === undefined ? undefined : validateConfiguration(input.configuration);
      const branch = validateBranchName(input?.branch || url.searchParams.get('branch'));
      const verdict = await inspectBranchCompatibility(
        this.client,
        session.token,
        repository.fullName,
        branch,
        configuration
      );
      this.note({
        action: verdict.supported ? 'repository.validate' : 'validation.failure',
        outcome: verdict.supported ? 'ok' : 'failed',
        reason: verdict.supported ? null : 'not-a-citadel-repository',
        target: `${repository.fullName} @ ${branch}`,
        account: session.login,
      });
      return {
        repositoryId: repository.id,
        fullName: repository.fullName,
        branch,
        ...verdict,
      };
    }

    if (method === 'POST' && tail[0] === 'attachments' && tail.length === 1) {
      return this.attach(req, await readBody());
    }

    if (method === 'POST' && tail[0] === 'attachments' && tail[1] === 'abandon') {
      return this.abandon(req, await readBody());
    }

    if (method === 'POST' && tail[0] === 'attachments' && tail[1] === 'status') {
      return this.attachmentStatus(req, await readBody());
    }

    if (tail[0] === 'workspaces' && tail.length >= 3) {
      return this.workspace({ req, url, environmentId: tail[1], operation: tail[2], readBody });
    }

    throw githubError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
  }

  /**
   * Validate a repository/branch selection and prepare the working branch.
   *
   * Nothing is persisted here; the browser writes the resulting source union
   * into the registry, which mirrors it to `/data`.
   *
   * The response carries an opaque `operationId`. That is the only authority
   * cleanup accepts, so a browser can never name someone else's branch for
   * deletion. Supplying the same `operationKey` again returns the original
   * result, so a lost response can be retried without creating a second branch
   * or orphaning the first.
   */
  async attach(req, body) {
    assertKeys(
      body,
      new Set([
        'repositoryId',
        'sourceBranch',
        'environmentId',
        'writeMode',
        'workingBranch',
        'adoptExisting',
        'operationKey',
        'expectedHead',
        'configuration',
      ])
    );
    const session = this.session(req);
    const sessionFingerprint = reservationFingerprint(req.headers[SESSION_HEADER]);
    const clientKey = body.operationKey === undefined ? null : operationKeyOf(body.operationKey);
    // One attempt at a time per credential and key, so two identical requests
    // cannot both create a branch and both claim to own it.
    return this.attachments.serialize(sessionFingerprint, clientKey, async () => {
      const existing = this.attachments.findByKey(sessionFingerprint, clientKey);
      const configuration = body.configuration === undefined ? undefined : validateConfiguration(body.configuration);
      const selectionIdentity = JSON.stringify([body.repositoryId, body.sourceBranch, body.environmentId,
        body.writeMode, body.workingBranch || null, body.adoptExisting === true, configurationKey(configuration)]);
      if (existing?.selectionIdentity && existing.selectionIdentity !== selectionIdentity) {
        throw githubError(409, 'ATTACH_SELECTION_CHANGED', 'This attachment attempt belongs to a different repository, branch or native binding. Resume the original attempt or start a new one.');
      }
      if (existing?.result) return existing.result;

      const environmentId = environmentIdOf(body.environmentId);
      const repository = await getRepository(
        this.client,
        session.token,
        validateRepositoryId(body.repositoryId)
      );
      if (repository.archived || repository.disabled) {
        throw githubError(
          400,
          'REPOSITORY_ARCHIVED',
          'Archived repositories cannot be attached for editing.'
        );
      }
      if (!repository.canPush) {
        throw githubError(
          403,
          'REPOSITORY_READ_ONLY',
          'This credential has no push access to that repository.'
        );
      }
      const sourceBranch = validateBranchName(body.sourceBranch);
      const writeMode = body.writeMode === 'direct' ? 'direct' : 'working-branch';
      // The authoritative Citadel check, immediately before anything is created.
      //
      // The browser runs the same scan to decide whether to enable Attach, but
      // that decision is advisory: a bypassed UI, a replayed verdict, or a push
      // that landed between the check and this call would all otherwise attach
      // an ordinary repository. Re-reading the head here and rescanning it means
      // a failure happens before the first mutation, so no working branch and no
      // registry record can exist for a repository that did not qualify.
      const validated = await assertAttachableRepository(
        this.client,
        session.token,
        repository.fullName,
        sourceBranch,
        body.expectedHead ? validateCommitSha(body.expectedHead, 'head') : null,
        configuration
      );
      const head = validated.head;
      // The branch is the user's to name. `citadel-ui/<environmentId>` remains
      // the answer only when a caller supplies no name at all, which keeps the
      // API contract that predates branch naming working; the browser always
      // supplies one.
      const namedByUser = body.workingBranch !== undefined && body.workingBranch !== null;
      const adoptExisting = body.adoptExisting === true;
      const workingBranch =
        writeMode === 'direct'
          ? sourceBranch
          : namedByUser
            ? validateBranchName(body.workingBranch)
            : workingBranchName(environmentId);
      if (writeMode === 'working-branch' && workingBranch === sourceBranch) {
        throw githubError(
          400,
          'INVALID_BRANCH',
          `${sourceBranch} is the branch you selected. Attach it directly instead of asking Citadel to create it.`
        );
      }
      if (configuration?.format === 'terraform') {
        assertNoWritableOverlap([...(await this.registryStore.read()).environments,
          { id: environmentId, source: { kind: 'github', repositoryId: repository.id, workingBranch }, configuration }]);
      }

      // Provenance first. A create whose response is lost has still happened on
      // GitHub, and without a record written beforehand nothing could name the
      // branch to clean it up.
      const resumed = Boolean(existing);
      const reservation =
        existing ||
        this.attachments.reserve({
          sessionFingerprint,
          clientKey,
          repositoryId: repository.id,
          fullName: repository.fullName,
          environmentId,
          sourceBranch,
          workingBranch,
          writeMode,
          selectionIdentity,
        });

      let working;
      if (writeMode === 'direct') {
        working = { branch: sourceBranch, head, created: false, adopted: false };
      } else {
        try {
          working = await ensureWorkingBranch(
            this.client,
            session.token,
            repository.fullName,
            sourceBranch,
            workingBranch,
            {
              // Only a name a human typed can belong to somebody else. A derived
              // name embeds this environment's own id, and a resume is finishing
              // a branch this same operation already created.
              requireAbsent: namedByUser && !adoptExisting && !resumed,
            }
          );
        } catch (error) {
          // A name that already exists is a definite, answerable rejection, not
          // an ambiguous transport failure: nothing was created, so nothing has
          // to be reconciled or cleaned up. Letting it fall into the probe below
          // would find the branch, conclude the attach had half-succeeded, and
          // adopt the very branch this refusal exists to protect.
          if (error?.code === 'BRANCH_EXISTS') {
            this.attachments.discard(reservation);
            throw error;
          }
          // Ambiguous: the ref call may have succeeded before the failure. Ask
          // GitHub what actually exists rather than guessing.
          //
          // `branchHead` answers `null` only for a confirmed 404 and throws for
          // anything else, so the two cases stay apart. Collapsing a transient
          // lookup failure into "absent" would discard the reservation and leave
          // a branch nothing could ever name.
          let actual;
          try {
            actual = await branchHead(
              this.client,
              session.token,
              repository.fullName,
              workingBranch
            );
          } catch {
            // Neither confirmed created nor confirmed absent. The reservation
            // stays `pending`, so a retry with the same operation key reconciles
            // against whatever is really there.
            //
            // The status on this error is GitHub's own — a secondary rate limit
            // is a 403 and "Reference already exists" is a 422 — so status class
            // alone would read as a definite rejection and make the browser
            // discard the only handle that can resume or name the branch. The
            // marker says what the status cannot: this attach is unresolved.
            error.attachUnconfirmed = true;
            throw error;
          }
          if (actual === null) {
            // Positively absent: nothing was created, so nothing is left to
            // reconcile or clean up.
            this.attachments.discard(reservation);
            throw error;
          }
          // A branch sitting exactly at the source head is one this call just
          // created; anything else pre-existed and is not ours to remove.
          working = {
            branch: workingBranch,
            head: actual,
            created: actual === head,
            adopted: actual !== head,
          };
        }
        if (resumed && !working.created && working.head === head) {
          // Resuming this operation's own reservation. `ensureWorkingBranch`
          // sees a branch that already exists and reports `created: false`, but
          // the reservation is provenance that *this* operation was mid-create
          // when its answer was lost, so the branch is ours to clean up.
          working = { ...working, created: true, adopted: false };
        }
      }

      // Provenance, recorded rather than inferred later. A branch Citadel made
      // and a branch it was pointed at are different things to the person whose
      // repository it is, and only the moment of attaching knows which happened.
      const branchChoice =
        writeMode === 'direct' ? 'selected' : working.created ? 'created' : 'adopted';
      if (working.head !== head) {
        await assertAttachableRepository(this.client, session.token, repository.fullName, working.branch, working.head, configuration);
      }

      const result = {
        repository,
        ...(configuration ? { configuration } : {}),
        source: {
          kind: 'github',
          // Ownership comes from the credential that performed the attach, never
          // from the request body. A browser cannot claim an environment was
          // attached through a connection it does not hold.
          connectionProfileId: session.profileId || null,
          repositoryId: repository.id,
          fullName: repository.fullName,
          sourceBranch,
          workingBranch: working.branch,
          writeMode,
          branchChoice,
          lastKnownHead: working.head,
          capabilities: validated.detected || [],
          validatedAt: new Date().toISOString(),
        },
        head: working.head,
        createdWorkingBranch: working.created,
        operationId: reservation.operationId,
      };
      this.attachments.attach(reservation, {
        workingBranch: working.branch,
        baseHead: working.head,
        created: working.created,
        result,
      });
      this.note({
        action: 'repository.attach',
        outcome: 'ok',
        target: `${repository.fullName} @ ${sourceBranch}`,
        account: session.login,
      });
      return result;
    });
  }

  /**
   * What happened to an attach whose answer the browser never received?
   *
   * The reservation is already the authority on this: `attach` records
   * provenance before it touches a branch and publishes the result when it
   * succeeds. This exposes that record by the client's own operation key, so a
   * lost 502 can be reconciled with a cheap read instead of a second mutation.
   *
   * It reads and never writes. `unknown` means only that this server has no
   * record — after a restart, or past the reservation TTL — and the caller must
   * fall back to replaying the idempotent attach rather than assuming nothing
   * was created.
   */
  async attachmentStatus(req, body) {
    assertKeys(body, new Set(['operationKey']));
    const sessionFingerprint = reservationFingerprint(req.headers[SESSION_HEADER]);
    // Resolving the session first keeps this behind the same credential check as
    // every other route, and refuses a caller with no live session.
    this.session(req);
    const clientKey = operationKeyOf(body.operationKey);
    if (!clientKey) {
      throw githubError(400, 'INVALID_OPERATION_KEY', 'An attachment operation key is required.');
    }
    const reservation = this.attachments.findByKey(sessionFingerprint, clientKey);
    if (!reservation) return { state: 'unknown', result: null };
    return {
      state: reservation.state === RESERVATION_PENDING ? 'pending' : 'attached',
      // Exactly the payload the original attach would have returned, so a
      // reconciling caller continues along the ordinary path.
      result: reservation.result || null,
    };
  }

  /**
   * Resolve an attachment operation, removing a branch this server created if it
   * is still exactly as created.
   *
   * The request supplies only the opaque operation id. Repository, branch and
   * base head come from the server's own record, so cleanup cannot be aimed at
   * another environment. The result always states what happened.
   *
   * The reservation is retired only once cleanup is confirmed, or confirmed
   * unnecessary. A transient lookup or delete failure leaves it in place so the
   * caller can retry with the same id; discarding it there would destroy the
   * only provenance that could ever remove the branch.
   */
  async abandon(req, body) {
    assertKeys(body, new Set(['operationId']));
    const session = this.session(req);
    const sessionFingerprint = reservationFingerprint(req.headers[SESSION_HEADER]);
    const reservation = this.attachments.find(sessionFingerprint, body.operationId);

    if (reservation.state === RESERVATION_PENDING) {
      // The branch mutation never reported an outcome. Whatever exists is found
      // by lookup, not assumed.
      const actual = await branchHead(
        this.client,
        session.token,
        reservation.fullName,
        reservation.workingBranch
      ).catch(() => undefined);
      if (actual === undefined) {
        return {
          removed: false,
          reason: 'lookup-failed',
          branch: reservation.workingBranch,
          retryable: true,
        };
      }
      if (!actual) {
        this.attachments.resolve(reservation);
        return { removed: true, reason: 'already-absent', branch: reservation.workingBranch };
      }
      this.attachments.attach(reservation, {
        workingBranch: reservation.workingBranch,
        baseHead: actual,
        created: true,
        result: reservation.result,
      });
    }

    if (!reservation.created) {
      this.attachments.resolve(reservation);
      return { removed: false, reason: 'not-created' };
    }
    const branch = reservation.workingBranch;
    if (!branch.startsWith(WORKING_BRANCH_PREFIX)) {
      // Never touch a branch outside the Citadel namespace, such as a direct
      // write-mode source branch.
      this.attachments.resolve(reservation);
      return { removed: false, reason: 'not-a-citadel-branch', branch };
    }
    let head;
    try {
      head = await branchHead(this.client, session.token, reservation.fullName, branch);
    } catch (error) {
      return { removed: false, reason: 'lookup-failed', branch, message: error.message, retryable: true };
    }
    if (!head) {
      this.attachments.resolve(reservation);
      return { removed: true, reason: 'already-absent', branch };
    }
    if (head !== reservation.baseHead) {
      this.attachments.resolve(reservation);
      return { removed: false, reason: 'branch-moved', branch };
    }
    try {
      await this.client.request(
        `/repos/${reservation.fullName}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
        { token: session.token, method: 'DELETE' }
      );
    } catch (error) {
      return { removed: false, reason: 'delete-failed', branch, message: error.message, retryable: true };
    }
    this.attachments.resolve(reservation);
    return { removed: true, branch };
  }

  async workspace({ req, url, environmentId, operation, readBody }) {
    const resolved = await this.resolve(req, environmentId);
    return this.workspaceRoutes.workspace(resolved, { req, url, environmentId, operation, readBody });
  }

  async saveSubscriptionId({ token, fullName, branch, environmentId, repository, body }) {
    return this.workspaceRoutes.saveSubscriptionId({ token, fullName, branch, environmentId, repository, body });
  }
}

export { SESSION_HEADER };
