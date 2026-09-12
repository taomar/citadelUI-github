import { githubError } from './api.mjs';
import { BLOB_MODE_FILE, validateCommitSha } from './repositories.mjs';
import { workspaceScope } from '../../shared/workspace-configuration.mjs';
import { MAX_ENV_BYTES, subscriptionEnvironmentAlias } from '../../shared/source-scope.mjs';
import {
  readSubscriptionIdFromText,
  validateSubscriptionId,
  writeSubscriptionIdToText,
} from '../../shared/subscription-env.mjs';

/** Adapt requests only after GitHubRoutes resolves their editable authority. */
export function createWorkspaceRoutes(ports) {
  const {
    assertKeys, transactionIdOf, assertAction,
    requireBranchHead, readBlob, loadHistory, inspectCommit, readSubscriptionId,
    commitChangeSet, createCommitBranch, revertCommit,
  } = ports;
  return {
    get client() { return ports.client; },
    get audit() { return ports.audit; },
    tree(...args) { return ports.tree(...args); },
    blob(...args) { return ports.blob(...args); },

    async workspace(resolved, { req, url, environmentId, operation, readBody }) {
      const { token, source, repository } = resolved;
      const fullName = repository.fullName;
      const branch = source.workingBranch;

      if (req.method === 'GET' && operation === 'tree') {
        const head = await requireBranchHead(this.client, token, fullName, branch);
        const tree = await this.tree(token, fullName, head, source.configuration);
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
        const alias = url.searchParams.get('alias');
        workspaceScope(source.configuration).read(alias);
        const snapshot = await this.tree(token, fullName, head, source.configuration);
        const blob = await this.blob(
          token,
          fullName,
          head,
          alias,
          url.searchParams.get('sha'),
          snapshot,
          repository.id,
          source.configuration
        );
        return {
          alias,
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
            configuration: source.configuration,
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
          transaction: await inspectCommit(this.client, token, fullName, branch, sha, { record, configuration: source.configuration }),
        };
      }

      if (req.method === 'GET' && operation === 'subscription') {
        if (source.configuration.format === 'terraform') throw githubError(400, 'NATIVE_NO_SUBSCRIPTION_BRIDGE', 'The azd bridge is not a native Terraform editor.');
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
        assertKeys(body, new Set(['action', 'expectedHead', 'transactionId', 'files', 'nativeProof', 'nativeIdentity']));
        return commitChangeSet(this.client, token, {
          fullName,
          branch,
          requestBody: body,
          repositoryId: repository.id,
          expectedHead: body.expectedHead ? validateCommitSha(body.expectedHead) : null,
          files: body.files,
          action: assertAction(body.action),
          environmentId,
          transactionId: transactionIdOf(body.transactionId),
          audit: this.audit,
          configuration: source.configuration,
          nativeProof: body.nativeProof,
          nativeIdentity: body.nativeIdentity,
          // Deliberately omitted: the public endpoint never grants the
          // subscription capability, so no request can reach `.azure/**/.env`.
        });
      }

      if (req.method === 'POST' && operation === 'commit-branches') {
        // The user's answer to a refused save: put that commit on a branch of
        // this name. Nothing here runs without it — a refusal on its own creates
        // no ref at all.
        const body = await readBody();
        assertKeys(body, new Set(['commit', 'branch']));
        return createCommitBranch(this.client, token, {
          fullName,
          commitSha: validateCommitSha(body.commit),
          branch: body.branch,
          // The branch the refused save was aiming at. The audit record was
          // written against it, so it is how the commit is proven to belong to
          // this workspace.
          intendedBranch: branch,
          configuration: source.configuration,
          environmentId,
          repositoryId: repository.id,
          audit: this.audit,
        });
      }

      if (req.method === 'POST' && operation === 'subscription') {
        if (source.configuration.format === 'terraform') throw githubError(400, 'NATIVE_NO_SUBSCRIPTION_BRIDGE', 'The azd bridge is not a native Terraform editor.');
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
          configuration: source.configuration,
        });
      }

      throw githubError(404, 'ROUTE_NOT_FOUND', 'API route not found.');
    },

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
    },
  };
}
