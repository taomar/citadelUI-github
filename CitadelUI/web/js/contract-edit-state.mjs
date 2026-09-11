import { sameNativeDraftBinding } from '../../shared/terraform/drafts.mjs';

function policyPending(state) {
  return Object.keys(state.policyChanges || {}).length > 0 || typeof state.policyRaw === 'string';
}

export function hasParameterInputs(state) {
  return Object.keys(state.parameterInputs || {}).length > 0;
}

export function parameterInput(state, path) {
  return state.parameterInputs?.[JSON.stringify(path)] || null;
}

export function setParameterInput(state, path, input) {
  if (!Array.isArray(path) || !path.length || input && typeof input.value !== 'string') {
    throw new Error('A pending input requires its parameter path and literal text.');
  }
  const key = JSON.stringify(path), previous = state.parameterInputs || {};
  const next = input ? {
    path: [...path], value: input.value, composing: Boolean(input.composing),
    badInput: Boolean(input.badInput), validationMessage: input.validationMessage || '',
  } : undefined;
  if (JSON.stringify(previous[key]) === JSON.stringify(next)) return false;
  state.parameterInputs = { ...previous };
  if (next) state.parameterInputs[key] = next;
  else delete state.parameterInputs[key];
  return true;
}

export function editorPendingCount(state) {
  const operations = state.operations || [];
  const covered = new Set(operations.filter((op) => op.op === 'set').map((op) => JSON.stringify(op.path)));
  const inputs = Object.keys(state.parameterInputs || {}).filter((key) => !covered.has(key)).length;
  return operations.length + inputs + (policyPending(state) ? 1 : 0);
}

export function captureContractEdits(state, { allQuarantines = false } = {}) {
  const quarantines = state.quarantinedDrafts || new Map();
  const retained = allQuarantines ? quarantines :
    new Map([...quarantines].filter(([path]) => path === state.current?.path));
  return {
    workspaceKey: state.workspaceKey || null,
    parameterPath: state.current?.path || null,
    parameterHash: state.current?.hash || null,
    nativeIdentity: state.current?.nativeIdentity || null,
    operations: structuredClone(state.operations || []),
    parameterInputs: structuredClone(state.parameterInputs || {}),
    policyPath: state.contract?.policy?.path || null,
    policyHash: state.contract?.policy?.hash || null,
    policyChanges: structuredClone(state.policyChanges || {}),
    policyRaw: state.policyRaw ?? null,
    policyMode: state.policyMode || 'guided',
    quarantinedDrafts: structuredClone(retained),
  };
}

function assertDraftOwner(state, snapshot) {
  if (snapshot?.workspaceKey && snapshot.workspaceKey !== state.workspaceKey) {
    throw new Error('This retained draft belongs to another workspace configuration. It was not applied.');
  }
}

export function selectQuarantinedDraft(state, path = state.current?.path) {
  state.quarantinedDraft = state.quarantinedDrafts?.get(path)?.[0] || null;
}

export function retainQuarantinedDraft(state, snapshot, reason, path = snapshot?.parameterPath || state.current?.path) {
  assertDraftOwner(state, snapshot);
  if (!path) throw new Error('A retained draft requires its original document identity.');
  state.quarantinedDrafts ||= new Map();
  // Quarantine owns immutable snapshots, never snapshots of its own container.
  const { quarantinedDrafts, quarantinedDraft, ...pending } = snapshot;
  const retained = { ...structuredClone(pending), parameterPath: path, workspaceKey: state.workspaceKey || null, reason };
  const entries = state.quarantinedDrafts.get(path) || [];
  if (!entries.some((entry) => JSON.stringify(entry) === JSON.stringify(retained))) entries.push(retained);
  state.quarantinedDrafts.set(path, entries);
  selectQuarantinedDraft(state, state.current?.path || path);
}

export function restoreQuarantinedDrafts(state, snapshot) {
  assertDraftOwner(state, snapshot);
  for (const [path, entries] of snapshot?.quarantinedDrafts || []) {
    for (const entry of entries) retainQuarantinedDraft(state, entry, entry.reason, path);
  }
  selectQuarantinedDraft(state);
}

export function discardQuarantinedDraft(state, path = state.current?.path) {
  state.quarantinedDrafts?.delete(path);
  selectQuarantinedDraft(state);
}

export function invalidatePolicyPreview(state) {
  state.policyRevision = (state.policyRevision || 0) + 1;
  state.policyPreview = null;
  state.policyPreviewPending = false;
  state.policyPreviewError = null;
}

export function policyPreviewIdentity(state) {
  return {
    document: state.current,
    path: state.contract?.policy?.path,
    hash: state.contract?.policy?.hash,
    changes: state.policyChanges,
    raw: state.policyRaw,
    mode: state.policyMode,
    revision: state.policyRevision || 0,
  };
}

export function ownsPolicyPreview(state, identity) {
  return Boolean(identity && identity.document === state.current &&
    identity.path === state.contract?.policy?.path && identity.hash === state.contract?.policy?.hash &&
    identity.changes === state.policyChanges && identity.raw === state.policyRaw &&
    identity.mode === state.policyMode && identity.revision === (state.policyRevision || 0));
}

export function clearEditorPending(state) {
  state.operations = [];
  state.parameterInputs = {};
  state.inputScope = {};
  state.policyChanges = {};
  state.policyRaw = null;
  invalidatePolicyPreview(state);
}

export function restoreContractEdits(
  state,
  snapshot,
  options = { parameters: true, policy: true }
) {
  assertDraftOwner(state, snapshot);
  const conflicts = [];
  clearEditorPending(state);
  restoreQuarantinedDrafts(state, snapshot);

  if (options.parameters !== false && (snapshot?.operations?.length || hasParameterInputs(snapshot || {}))) {
    if (
      snapshot.parameterPath === state.current?.path &&
      snapshot.parameterHash === state.current?.hash &&
      (!state.current?.nativeIdentity || sameNativeDraftBinding(snapshot.nativeIdentity, state.current.nativeIdentity))
    ) {
      state.operations = structuredClone(snapshot.operations || []);
      state.parameterInputs = structuredClone(snapshot.parameterInputs || {});
    } else {
      conflicts.push(snapshot.parameterPath || 'parameter file');
    }
  }

  const savedPolicyPending =
    Object.keys(snapshot?.policyChanges || {}).length > 0 || typeof snapshot?.policyRaw === 'string';
  if (options.policy !== false && savedPolicyPending) {
    if (
      snapshot.policyPath === state.contract?.policy?.path &&
      snapshot.policyHash === state.contract?.policy?.hash
    ) {
      state.policyChanges = structuredClone(snapshot.policyChanges || {});
      state.policyRaw = snapshot.policyRaw ?? null;
      state.policyMode = snapshot.policyMode || state.policyMode;
    } else {
      conflicts.push(snapshot.policyPath || 'policy file');
    }
  }

  return conflicts;
}
