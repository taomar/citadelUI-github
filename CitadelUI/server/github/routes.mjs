/**
 * Same-origin GitHub routes.
 *
 * The browser never calls GitHub. Every route here runs after the existing host,
 * origin, fetch-site, session-token, body-size, and concurrency checks, and then
 * additionally requires an opaque GitHub credential session id.
 *
 * Repository and branch identity always come from the authoritative registry
 * record for the environment, never from the request body, so a browser cannot
 * redirect an environment at a different repository.
 */
import { GitHubApiClient, githubError } from './api.mjs';
import { classifyToken, GitHubSessionStore } from './sessions.mjs';
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
  BLOB_MODE_FILE,
  WORKING_BRANCH_PREFIX,
} from './repositories.mjs';
import {
  assertAction,
  branchHead,
  commitChangeSet,
  ensureWorkingBranch,
  inspectCommit,
  loadHistory,
  loadTree,
  readBlob,
  readSourceBlob,
  readSubscriptionId,
  requireBranchHead,
  revertCommit,
} from './workspace.mjs';
import {
  readSubscriptionIdFromText,
  validateSubscriptionId,
  writeSubscriptionIdToText,
} from '../../shared/subscription-env.mjs';
import { MAX_ENV_BYTES, subscriptionEnvironmentAlias } from '../../shared/source-scope.mjs';
import {
  assertAttachableRepository,
  inspectBranchCompatibility,
} from './compatibility.mjs';

const SESSION_HEADER = 'x-citadel-github-session';

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
    this.registryStore = options.registryStore;
    this.audit = options.audit || null;
    this.attachments = options.attachments || new AttachmentReservations();
    this.allowClassicTokens = Boolean(options.allowClassicTokens);
    // Trees are immutable for a given commit, so caching by commit SHA is safe
    // and keeps an alias-scoped blob read from refetching the tree per file.
    this.treeCache = new Map();
    this.treeCacheLimit = options.treeCacheLimit ?? 8;
  }

  async tree(token, fullName, commitSha) {
    const key = `${fullName}:${commitSha}`;
    if (!this.treeCache.has(key)) {
      const snapshot = await loadTree(this.client, token, fullName, commitSha);
      this.treeCache.set(key, snapshot);
      while (this.treeCache.size > this.treeCacheLimit) {
        this.treeCache.delete(this.treeCache.keys().next().value);
      }
    }
    return this.treeCache.get(key);
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
    return { environmentId: id, ...environment.source };
  }

  /**
   * Re-resolve the repository by immutable id on every workspace operation so a
   * rename or transfer cannot silently retarget an attached environment.
   */
  async resolve(req, environmentId) {
    const session = this.session(req);
    const source = await this.source(environmentId);
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

  async connect(body) {
    assertKeys(body, new Set(['token']));
    this.sessions.assertLoginAllowed();
    const { token, kind } = classifyToken(body.token, { allowClassic: this.allowClassicTokens });
    const { data } = await this.client.request('/user', { token });
    if (!data || typeof data.login !== 'string' || typeof data.id !== 'number') {
      throw githubError(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected account.');
    }
    // The credential is handed to the store and nothing else. It is never
    // returned, logged, or written to disk.
    return this.sessions.create(
      token,
      { login: data.login, id: data.id, type: data.type || 'User' },
      { tokenKind: kind }
    );
  }

  /**
   * Route dispatcher for `/api/github/*`.
   *
   * @returns {Promise<object>} plain JSON payload, never containing a credential
   */
  async handle({ req, url, parts, readBody }) {
    const method = req.method;
    const tail = parts.slice(2);

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
      this.treeCache.clear();
      return { disconnected, erased: true };
    }

    if (method === 'GET' && tail[0] === 'repos' && tail.length === 1) {
      const session = this.session(req);
      return listRepositories(this.client, session.token);
    }
    if (method === 'GET' && tail[0] === 'repos' && tail[2] === 'branches' && tail.length === 3) {
      const session = this.session(req);
      return listBranches(this.client, session.token, validateRepositoryId(tail[1]));
    }
    // Read-only Citadel structure check for one repository and branch. Creates
    // nothing: the browser uses it to decide whether Attach may be enabled, and
    // attachment re-runs it against the head it is about to branch from.
    if (method === 'GET' && tail[0] === 'repos' && tail[2] === 'compatibility' && tail.length === 3) {
      const session = this.session(req);
      const repository = await getRepository(
        this.client,
        session.token,
        validateRepositoryId(tail[1])
      );
      const branch = validateBranchName(url.searchParams.get('branch'));
      return {
        repositoryId: repository.id,
        fullName: repository.fullName,
        branch,
        ...(await inspectBranchCompatibility(this.client, session.token, repository.fullName, branch)),
      };
    }

    if (method === 'POST' && tail[0] === 'attachments' && tail.length === 1) {
      return this.attach(req, await readBody());
    }

    if (method === 'POST' && tail[0] === 'attachments' && tail[1] === 'abandon') {
      return this.abandon(req, await readBody());
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
        'operationKey',
        'expectedHead',
      ])
    );
    const session = this.session(req);
    const sessionFingerprint = reservationFingerprint(req.headers[SESSION_HEADER]);
    const clientKey = body.operationKey === undefined ? null : operationKeyOf(body.operationKey);
    // One attempt at a time per credential and key, so two identical requests
    // cannot both create a branch and both claim to own it.
    return this.attachments.serialize(sessionFingerprint, clientKey, async () => {
      const existing = this.attachments.findByKey(sessionFingerprint, clientKey);
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
        body.expectedHead ? validateCommitSha(body.expectedHead, 'head') : null
      );
      const head = validated.head;
      const workingBranch = writeMode === 'direct' ? sourceBranch : workingBranchName(environmentId);

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
        });

      let working;
      if (writeMode === 'direct') {
        working = { branch: sourceBranch, head, created: false };
      } else {
        try {
          working = await ensureWorkingBranch(
            this.client,
            session.token,
            repository.fullName,
            sourceBranch,
            workingBranch
          );
        } catch (error) {
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
          working = { branch: workingBranch, head: actual, created: actual === head };
        }
        if (resumed && !working.created && working.head === head) {
          // Resuming this operation's own reservation. `ensureWorkingBranch`
          // sees a branch that already exists and reports `created: false`, but
          // the reservation is provenance that *this* operation was mid-create
          // when its answer was lost, so the branch is ours to clean up.
          working = { ...working, created: true };
        }
      }

      const result = {
        repository,
        source: {
          kind: 'github',
          repositoryId: repository.id,
          fullName: repository.fullName,
          sourceBranch,
          workingBranch: working.branch,
          writeMode,
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
      return result;
    });
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
    const { token, source, repository } = await this.resolve(req, environmentId);
    const fullName = repository.fullName;
    const branch = source.workingBranch;

    if (req.method === 'GET' && operation === 'tree') {
      const head = await requireBranchHead(this.client, token, fullName, branch);
      const tree = await this.tree(token, fullName, head);
      return {
        repository,
        branch,
        sourceBranch: source.sourceBranch,
        writeMode: source.writeMode,
        head,
        files: tree.files,
        rejected: tree.rejected,
        truncated: tree.truncated,
      };
    }

    if (req.method === 'GET' && operation === 'blob') {
      const head = await requireBranchHead(this.client, token, fullName, branch);
      const blob = await readSourceBlob(
        this.client,
        token,
        fullName,
        head,
        url.searchParams.get('alias'),
        url.searchParams.get('sha'),
        await this.tree(token, fullName, head)
      );
      return {
        alias: url.searchParams.get('alias'),
        sha: blob.sha,
        size: blob.size,
        hash: blob.hash,
        content: blob.bytes.toString('base64'),
      };
    }

    if (req.method === 'GET' && operation === 'history') {
      return {
        transactions: await loadHistory(this.client, token, fullName, branch, environmentId, {
          audit: this.audit,
        }),
      };
    }

    if (req.method === 'GET' && operation === 'commits') {
      const sha = validateCommitSha(url.searchParams.get('sha'));
      const record = this.audit
        ? await this.audit.find({
            commit: sha,
            repositoryId: repository.id,
            environmentId,
            branch,
          })
        : null;
      return {
        transaction: await inspectCommit(this.client, token, fullName, branch, sha, { record }),
      };
    }

    if (req.method === 'GET' && operation === 'subscription') {
      const head = await requireBranchHead(this.client, token, fullName, branch);
      return readSubscriptionId(
        this.client,
        token,
        fullName,
        head,
        String(url.searchParams.get('environmentName') || ''),
        { readSubscriptionIdFromText }
      );
    }

    if (req.method === 'POST' && operation === 'commits') {
      const body = await readBody();
      assertKeys(body, new Set(['action', 'expectedHead', 'transactionId', 'files']));
      return commitChangeSet(this.client, token, {
        fullName,
        branch,
        repositoryId: repository.id,
        expectedHead: body.expectedHead ? validateCommitSha(body.expectedHead) : null,
        files: body.files,
        action: assertAction(body.action),
        environmentId,
        transactionId: transactionIdOf(body.transactionId),
        audit: this.audit,
        // Deliberately omitted: the public endpoint never grants the
        // subscription capability, so no request can reach `.azure/**/.env`.
      });
    }

    if (req.method === 'POST' && operation === 'subscription') {
      const body = await readBody();
      assertKeys(
        body,
        new Set(['environmentName', 'value', 'expectedHead', 'expectedHash', 'transactionId'])
      );
      return this.saveSubscriptionId({
        token,
        fullName,
        branch,
        environmentId,
        repository,
        body,
      });
    }

    if (req.method === 'POST' && operation === 'reverts') {
      const body = await readBody();
      assertKeys(body, new Set(['commit', 'transactionId']));
      return revertCommit(this.client, token, {
        fullName,
        branch,
        repositoryId: repository.id,
        commitSha: validateCommitSha(body.commit),
        environmentId,
        transactionId: transactionIdOf(body.transactionId),
        audit: this.audit,
      });
    }

    throw githubError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
  }

  /**
   * Patch only `AZURE_SUBSCRIPTION_ID` in a tracked `.azure/<env>/.env`.
   *
   * Staleness is checked with the SHA-256 the user reviewed, which is the same
   * precondition the local provider uses, so both sources behave identically:
   * an existing file requires a matching hash, and creating one requires the
   * caller to have observed that the file was absent.
   *
   * Every other byte of the file is preserved and never returned.
   */
  async saveSubscriptionId({ token, fullName, branch, environmentId, repository, body }) {
    const id = validateSubscriptionId(body.value);
    const environmentName = String(body.environmentName || '');
    const alias = subscriptionEnvironmentAlias(environmentName);
    const head = await requireBranchHead(this.client, token, fullName, branch);
    if (body.expectedHead && head !== body.expectedHead) {
      throw githubError(
        409,
        'STALE_WORKSPACE',
        'The branch moved after you reviewed this environment file. Reload before saving.'
      );
    }
    const current = await readSubscriptionId(
      this.client,
      token,
      fullName,
      head,
      environmentName,
      { readSubscriptionIdFromText }
    );
    const expectedHash = body.expectedHash ?? null;
    if (
      (current.available && (typeof expectedHash !== 'string' || current.hash !== expectedHash)) ||
      (!current.available && expectedHash !== null)
    ) {
      throw githubError(
        409,
        'STALE_SOURCE',
        'The azd environment file changed outside Citadel UI. Reload before saving.'
      );
    }
    const before = current.available
      ? (await readBlob(this.client, token, fullName, current.blobSha, { maxBytes: MAX_ENV_BYTES })).text
      : '';
    const after = writeSubscriptionIdToText(before, id);
    if (after === before) return { ...current, changed: false };
    const bytes = Buffer.from(after, 'utf8');
    if (bytes.byteLength > MAX_ENV_BYTES) {
      throw githubError(413, 'ENV_TOO_LARGE', 'The azd environment file exceeds the 1 MiB safety limit.');
    }
    const result = await commitChangeSet(this.client, token, {
      fullName,
      branch,
      repositoryId: repository?.id,
      expectedHead: head,
      files: [
        {
          alias,
          create: !current.available,
          blobSha: current.blobSha,
          beforeHash: current.hash,
          mode: current.mode || BLOB_MODE_FILE,
          after: bytes.toString('base64'),
        },
      ],
      action: 'subscription-edit',
      environmentId,
      transactionId: transactionIdOf(body.transactionId),
      audit: this.audit,
      // The only place this capability is ever granted, and only for this path.
      subscriptionAlias: alias,
    });
    // The commit has landed. A failed verification read is reported as a warning
    // on a committed result, never as a save failure that invites a retry.
    try {
      const verified = await readSubscriptionId(
        this.client,
        token,
        fullName,
        result.commit,
        environmentName,
        { readSubscriptionIdFromText }
      );
      return { ...verified, changed: true, commit: result.commit, warnings: result.warnings };
    } catch (error) {
      return {
        ...current,
        value: id,
        changed: true,
        commit: result.commit,
        verified: false,
        warnings: [
          ...(result.warnings || []),
          `The subscription was committed, but it could not be re-read: ${error.message}`,
        ],
      };
    }
  }
}

export { SESSION_HEADER };
