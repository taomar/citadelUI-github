import { sameNativeDraftBinding } from '../../shared/terraform/drafts.mjs';
import {
  captureContractEdits, hasParameterInputs, invalidatePolicyPreview,
  restoreContractEdits, restoreQuarantinedDrafts, retainQuarantinedDraft,
} from './contract-edit-state.mjs';

export function createEditorDocumentSession({ views, currentOwner, contextProvider, documents, drafts, loadGate, publish }) {
  // The shell's generation also retires workspace loads and policy previews.
  // The load gate keeps blur and pause ahead of every capture below.
  const current = (ticket, generation) => views.isCurrent(ticket) && loadGate.isCurrentGeneration(generation);

  function restoreView(remembered, ticket, generation) {
    if (remembered) publish.frame(() => {
      if (!current(ticket, generation)) return;
      publish.restoreView(remembered);
    });
  }

  function loadContract(id, preserved = null, preserveOptions = undefined, transition = null) {
    return loadGate.run('Opening contract. Editing is paused until loading finishes.', async () => {
      const owner = currentOwner(), ticket = views.ticket(), generation = loadGate.nextGeneration(), context = contextProvider();
      owner.documentGeneration = generation;
      const loaded = await publish.withStatus('Loading contract\u2026', async () => {
        const [contract, accessTargets] = await Promise.all([
          documents.contract(id, context), documents.accessContractTargets(context),
        ]);
        if (!current(ticket, generation)) return null;
        const draftState = { workspaceId: owner.workspaceId, workspaceKey: owner.workspaceKey,
          quarantinedDrafts: new Map([...owner.quarantinedDrafts].filter(([path]) => path === contract.param.path)) };
        const operations = await drafts.restoreParameterDraft(contract.param, draftState);
        return { contract, accessTargets, operations, draftState };
      });
      if (!loaded || !current(ticket, generation)) return false;
      const { contract, accessTargets, operations, draftState } = loaded;
      owner.contractId = id;
      owner.contract = contract;
      owner.accessTargets = accessTargets;
      owner.current = contract.param;
      owner.baselineValidation = documents.validateDocument(contract.param);
      restoreQuarantinedDrafts(owner, draftState);
      if (owner.quarantinedDraft) publish.setStatus(owner.quarantinedDraft.reason, 'error');
      owner.operations = operations;
      owner.parameterInputs = {};
      owner.inputScope = {};
      owner.policyChanges = {};
      owner.policyRaw = null;
      invalidatePolicyPreview(owner);
      const remembered = owner.documentViews.get(contract.param.path);
      owner.open = new Map(remembered?.open || []);
      if (remembered) owner.tab = remembered.tab;
      if (preserved) {
        const conflicts = restoreContractEdits(owner, preserved, preserveOptions);
        if (conflicts.length) {
          retainQuarantinedDraft(owner, preserved, `Pending edits are quarantined because source changed: ${conflicts.join(', ')}.`);
          publish.setStatus(
            `Pending edits could not be reapplied because source changed: ${conflicts.join(', ')}.`,
            'error'
          );
        }
      } else {
        drafts.restoreStashedPending();
      }
      if (owner.policyRaw === null && Object.keys(owner.policyChanges).length) await publish.refreshPolicyPreview();
      if (!current(ticket, generation)) return false;
      publish.render();
      publish.restoreDocumentNotice();
      restoreView(remembered, ticket, generation);

      // Suggestions are fetched after the contract is shown, not as a load prerequisite.
      if (!owner.onboardedModels.length) {
        try {
          const [{ models }, specs] = await Promise.all([
            documents.onboardedModels(),
            documents.policyVariables(),
          ]);
          if (!current(ticket, generation)) return true;
          owner.onboardedModels = models || [];
          owner.policyVariables = specs.variables || [];
          owner.throttleSpecs = specs.throttles || null;
          owner.semanticCacheSpec = specs.semanticCache || null;
          owner.contentSafetySpec = specs.contentSafety || null;
          publish.render();
        } catch {
          if (currentOwner() === owner) owner.onboardedModels = [];
        }
      }
      return true;
    }, transition);
  }

  function loadDocument(path, { preserve = false, selection = null, transition = null } = {}) {
    return loadGate.run('Opening document. Editing is paused until loading finishes.', async () => {
      const owner = currentOwner(), ticket = views.ticket(), generation = loadGate.nextGeneration(), context = contextProvider();
      owner.documentGeneration = generation;
      const pending = preserve ? captureContractEdits(owner) : null;
      const previousIdentity = owner.current?.nativeIdentity;
      const loaded = await publish.withStatus('Loading\u2026', async () => {
        const doc = await documents.deployment(path, context);
        if (!current(ticket, generation)) return null;
        const draftState = { workspaceId: owner.workspaceId, workspaceKey: owner.workspaceKey,
          quarantinedDrafts: new Map([...owner.quarantinedDrafts].filter(([path]) => path === doc.path)) };
        const draft = await drafts.restoreParameterDraft(doc, draftState);
        return { doc, draft, draftState };
      });
      if (!loaded || !current(ticket, generation)) return false;
      const { doc, draft, draftState } = loaded;
      if (selection) Object.assign(owner, selection);
      owner.current = doc;
      restoreQuarantinedDrafts(owner, draftState);
      if (owner.quarantinedDraft) publish.setStatus(owner.quarantinedDraft.reason, 'error');
      owner.baselineValidation = documents.documentFindings(doc);
      owner.operations = draft;
      owner.parameterInputs = {};
      owner.inputScope = {};
      owner.policyChanges = {};
      owner.policyRaw = null;
      invalidatePolicyPreview(owner);
      if (pending && (pending.operations.length || hasParameterInputs(pending))) {
        if (pending.parameterHash === doc.hash && (!doc.nativeIdentity || sameNativeDraftBinding(previousIdentity, doc.nativeIdentity))) {
          owner.operations = pending.operations;
          owner.parameterInputs = structuredClone(pending.parameterInputs || {});
        } else retainQuarantinedDraft(owner, pending, 'The file or its native schema/dependencies changed while this workspace was inactive. Its pending draft is retained, not applied to the new source.');
      }
      drafts.restoreStashedPending();
      const remembered = owner.documentViews.get(path);
      owner.open = new Map(remembered?.open || []);
      if (remembered) owner.tab = remembered.tab;
      if (owner.tab === 'policy') owner.tab = 'params';
      publish.render();
      publish.restoreDocumentNotice();
      restoreView(remembered, ticket, generation);
      return true;
    }, transition);
  }

  return { loadContract, loadDocument };
}
