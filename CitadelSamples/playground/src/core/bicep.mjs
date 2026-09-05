/**
 * Bicep parameter serialisation.
 *
 * A faithful port of the notebook's `_bicep()` helper (cell 14) so the Request
 * tab shows the exact `.bicepparam` shape the notebook would have written.
 *
 * The notebook escapes a single quote as `\'`. User-authored values additionally
 * need Bicep's newline, backslash, interpolation and control-character escapes
 * so they remain one literal string instead of changing the generated program.
 */

import { isWellFormedUnicode } from './identifiers.mjs';

function bicepString(value) {
  if (!isWellFormedUnicode(value)) {
    throw new TypeError('Bicep strings must contain well-formed Unicode.');
  }
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\$\{/g, '\\${')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/gu, (character) => {
      return `\\u{${character.codePointAt(0).toString(16)}}`;
    });
}

export function bicepValue(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${bicepString(value)}'`;
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
