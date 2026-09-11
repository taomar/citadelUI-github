/** Only a confirmed application or an explicit no-op completes a mutation. */
export function mutationOutcome(result) {
  if (result?.recoveryRequired || result?.outcome === 'recovery-required') return 'recovery-required';
  if (result?.indeterminate || result?.applied === null || result?.outcome === 'indeterminate') return 'indeterminate';
  if (result?.unresolved || result?.outcome === 'pending') return 'pending';
  if (result?.outcome === 'unchanged' && result.applied === false && result.changed === false) return 'unchanged';
  if (result?.applied === true && (!result.outcome || result.outcome === 'applied')) return 'applied';
  return result?.applied === false ? 'pending' : 'indeterminate';
}

export function mutationComplete(result) {
  const outcome = mutationOutcome(result);
  return outcome === 'applied' || outcome === 'unchanged';
}

export function withMutationOutcome(result) {
  const outcome = mutationOutcome(result);
  return {
    ...result,
    outcome,
    applied: outcome === 'applied' ? true : ['pending', 'unchanged'].includes(outcome) ? false : null,
    changed: outcome === 'applied',
  };
}
