/**
 * Bicep parameter serialisation.
 *
 * A faithful port of the notebook's `_bicep()` helper (cell 14) so the Request
 * tab shows the exact `.bicepparam` text the notebook would have written,
 * character for character, rather than an approximation of it.
 *
 * The notebook escapes a single quote as `\'`, which is what Bicep expects
 * inside a single-quoted string, so that behaviour is preserved.
 */

export function bicepValue(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) {
    const items = value.map((item) => `${pad}  ${bicepValue(item, indent + 1)}\n`).join('');
    return `[\n${items}${pad}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, item]) => `${pad}  ${key}: ${bicepValue(item, indent + 1)}\n`)
      .join('');
    return `{\n${entries}${pad}}`;
  }
  return "''";
}

/** `param x = <value>` line. */
export function bicepParam(name, value) {
  return `param ${name} = ${bicepValue(value)}`;
}
