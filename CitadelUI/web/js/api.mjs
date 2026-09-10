import { createTransactionCommit } from './transaction-client.mjs';
import { WorkspaceService } from './workspace-service.mjs';
import { localRequest as request } from './local-api.mjs';
import { SourceMutationCoordinator } from './source-factory.mjs';
import { activeWorkspace, workspaceRegistry } from './workspace-context.mjs';
import { MigrationSession } from './migration-session.mjs';
import { TerraformExportSession } from './terraform-export-session.mjs';

// Composition root: the coordinator dispatches on the attached source kind, so
// every editor operation below stays source-agnostic.
const coordinator = new SourceMutationCoordinator({
  request,
  commitFiles: createTransactionCommit(request),
  contextProvider: activeWorkspace,
});

const workspace = new WorkspaceService({ request, coordinator });

export const api = {
  createTerraformExportSession: (options = {}) => new TerraformExportSession({
    ...options, contextProvider: activeWorkspace, registry: workspaceRegistry,
  }),
  createMigrationSession: (options = {}) => new MigrationSession({
    ...options,
    contextProvider: activeWorkspace,
    registry: workspaceRegistry,
    // Migration deliberately bypasses source dispatch: there is no path from
    // its apply action to GitHubCommitCoordinator, even on a writable branch.
    coordinator: coordinator.local,
  }),
  resetWorkspace: () => workspace.reset(),
  health: () => workspace.health(),
  deployments: (context) => workspace.deployments(context ? { context } : {}),
  deployment: (path, context) => workspace.deployment(path, context ? { context } : {}),
  preview: (path, operations, expectedHash, nativeIdentity, context) => workspace.preview(path, operations, expectedHash, nativeIdentity, context),
  save: (path, operations, expectedHash, nativeIdentity, context) => workspace.save(path, operations, expectedHash, nativeIdentity, context),
  prepareLocalOverwrite: (document, operations, context) => workspace.prepareLocalOverwrite(document, operations, context),
  saveLocalOverwrite: (review) => workspace.saveLocalOverwrite(review),
  createCommitBranch: (commit, branch, context) => workspace.createCommitBranch(commit, branch, context),
  saveSubscriptionId: (environmentName, value, expectedHash, context) =>
    workspace.saveSubscriptionId(environmentName, value, expectedHash, context),
  focus: (context) => workspace.focus(context),
  onboardedModels: (context) => workspace.onboardedModels(context),
  policyVariables: () => workspace.policyVariables(),
  contracts: (context) => workspace.contracts(context),
  contract: (id, context) => workspace.contract(id, context),
  accessContractTargets: (context) => workspace.accessContractTargets(context),
  createContract: (payload, context) => workspace.createContract(payload, context),
  restoreContract: (id) => workspace.restoreContract(id),
  previewPolicy: (path, changes, expectedHash, context) =>
    workspace.previewPolicy(path, changes, null, expectedHash, context),
  previewPolicyPayload: (payload, context) =>
    workspace.previewPolicy(payload.path, payload.changes, payload.text, payload.expectedHash, context),
  prepareLocalPolicyOverwrite: (policy, changes, text, context) =>
    workspace.prepareLocalPolicyOverwrite(policy, changes, text, context),
  savePolicy: (payload, context) => workspace.savePolicy(payload, context),
  compareEnvironment: (environmentId, path, context) => workspace.compareEnvironment(environmentId, path, context),
  previewCopy: (environmentId, path, names, expectedSourceHash, context) =>
    workspace.previewCopy(environmentId, path, names, expectedSourceHash, context),
  copyParameters: (environmentId, path, names, expectedSourceHash, expectedTargetHash, context) =>
    workspace.copyParameters(
      environmentId,
      path,
      names,
      expectedSourceHash,
      expectedTargetHash,
      context
    ),
  history: (context) => workspace.history(context),
  inspectRecovery: (transactionId, context) => workspace.inspectRecovery(transactionId, context),
  recoverTransaction: (transactionId, action, context) =>
    workspace.recoverTransaction(transactionId, action, context),
  restoreTransaction: (transactionId, context) => workspace.restoreTransaction(transactionId, context),
};
