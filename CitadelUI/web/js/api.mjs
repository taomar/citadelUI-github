import { createTransactionCommit } from './transaction-client.mjs';
import { WorkspaceService } from './workspace-service.mjs';
import { localRequest as request } from './local-api.mjs';
import { SourceMutationCoordinator } from './source-factory.mjs';
import { activeWorkspace } from './workspace-context.mjs';

// Composition root: the coordinator dispatches on the attached source kind, so
// every editor operation below stays source-agnostic.
const coordinator = new SourceMutationCoordinator({
  request,
  commitFiles: createTransactionCommit(request),
  contextProvider: activeWorkspace,
});

const workspace = new WorkspaceService({ request, coordinator });

export const api = {
  resetWorkspace: () => workspace.reset(),
  health: () => workspace.health(),
  deployments: () => workspace.deployments(),
  deployment: (path) => workspace.deployment(path),
  preview: (path, operations, expectedHash) => workspace.preview(path, operations, expectedHash),
  save: (path, operations, expectedHash) => workspace.save(path, operations, expectedHash),
  saveSubscriptionId: (environmentName, value, expectedHash) =>
    workspace.saveSubscriptionId(environmentName, value, expectedHash),
  focus: () => workspace.focus(),
  onboardedModels: () => workspace.onboardedModels(),
  policyVariables: () => workspace.policyVariables(),
  contracts: () => workspace.contracts(),
  contract: (id) => workspace.contract(id),
  accessContractTargets: () => workspace.accessContractTargets(),
  createContract: (payload) => workspace.createContract(payload),
  restoreContract: (id) => workspace.restoreContract(id),
  previewPolicy: (path, changes, expectedHash) =>
    workspace.previewPolicy(path, changes, null, expectedHash),
  savePolicy: (payload) => workspace.savePolicy(payload),
  compareEnvironment: (environmentId, path) => workspace.compareEnvironment(environmentId, path),
  previewCopy: (environmentId, path, names, expectedSourceHash) =>
    workspace.previewCopy(environmentId, path, names, expectedSourceHash),
  copyParameters: (environmentId, path, names, expectedSourceHash, expectedTargetHash) =>
    workspace.copyParameters(
      environmentId,
      path,
      names,
      expectedSourceHash,
      expectedTargetHash
    ),
  history: () => workspace.history(),
  inspectRecovery: (transactionId) => workspace.inspectRecovery(transactionId),
  recoverTransaction: (transactionId, action) =>
    workspace.recoverTransaction(transactionId, action),
  restoreTransaction: (transactionId) => workspace.restoreTransaction(transactionId),
};
