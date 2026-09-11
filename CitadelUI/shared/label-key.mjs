/** Compare strings without changing the callers' validation or coercion rules. */
export function labelKey(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}
