function policyPending(state) {
  return Object.keys(state.policyChanges || {}).length > 0 || state.policyRaw !== null;
}

export function editorPendingCount(state) {
  return (state.operations || []).length + (policyPending(state) ? 1 : 0);
}

export function captureContractEdits(state) {
  return {
    parameterPath: state.current?.path || null,
    parameterHash: state.current?.hash || null,
    operations: structuredClone(state.operations || []),
    policyPath: state.contract?.policy?.path || null,
    policyHash: state.contract?.policy?.hash || null,
    policyChanges: structuredClone(state.policyChanges || {}),
    policyRaw: state.policyRaw,
    policyMode: state.policyMode || 'guided',
  };
}

export function clearEditorPending(state) {
  state.operations = [];
  state.policyChanges = {};
  state.policyRaw = null;
  state.policyPreview = null;
}

export function restoreContractEdits(
  state,
  snapshot,
  options = { parameters: true, policy: true }
) {
  const conflicts = [];
  clearEditorPending(state);

  if (options.parameters !== false && snapshot?.operations?.length) {
    if (
      snapshot.parameterPath === state.current?.path &&
      snapshot.parameterHash === state.current?.hash
    ) {
      state.operations = structuredClone(snapshot.operations);
    } else {
      conflicts.push(snapshot.parameterPath || 'parameter file');
    }
  }

  const savedPolicyPending =
    Object.keys(snapshot?.policyChanges || {}).length > 0 || snapshot?.policyRaw !== null;
  if (options.policy !== false && savedPolicyPending) {
    if (
      snapshot.policyPath === state.contract?.policy?.path &&
      snapshot.policyHash === state.contract?.policy?.hash
    ) {
      state.policyChanges = structuredClone(snapshot.policyChanges || {});
      state.policyRaw = snapshot.policyRaw;
      state.policyMode = snapshot.policyMode || state.policyMode;
    } else {
      conflicts.push(snapshot.policyPath || 'policy file');
    }
  }

  return conflicts;
}
