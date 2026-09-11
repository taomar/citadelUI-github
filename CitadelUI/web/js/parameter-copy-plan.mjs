/** Selection validation and source comparison remain the caller's responsibility. */
export function parameterCopyPlan(parameters, names) {
  const selected = parameters.filter(
    (parameter) => names.includes(parameter.name) && parameter.status === 'different'
  );
  return {
    selected,
    operations: selected.map((parameter) => ({
      op: 'set',
      path: [parameter.name],
      value: parameter.source,
    })),
    changed: selected.map((parameter) => parameter.name),
  };
}
