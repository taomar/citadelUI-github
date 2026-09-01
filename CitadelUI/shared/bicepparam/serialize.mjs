/**
 * Serialize plain JS values back into Bicep parameter literal syntax.
 *
 * Only used to render the *replacement text for an edited value*, never to
 * re-emit a whole file. Indentation is caller-supplied so a spliced value lines
 * up with the surrounding, untouched source.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INDENT = '  ';

/** Escape a JS string into a Bicep single-quoted literal. */
export function quote(str) {
  const escaped = String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\$\{/g, '\\${')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

/**
 * A raw passthrough marker. The UI sends these back untouched for expressions we
 * intentionally do not model as data (function calls, references), so a save can
 * never silently rewrite e.g. loadTextContent('ai-product-policy.xml') into a
 * string literal containing the policy body.
 */
export function isRawExpr(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.__expr === 'string' &&
    typeof value.raw === 'string'
  );
}

export function serializeValue(value, indentLevel = 0) {
  const pad = INDENT.repeat(indentLevel);
  const padInner = INDENT.repeat(indentLevel + 1);

  if (isRawExpr(value)) return value.raw;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'string') return quote(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const lines = value.map((item) => `${padInner}${serializeValue(item, indentLevel + 1)}`);
    return `[\n${lines.join('\n')}\n${pad}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const lines = entries.map(([key, val]) => {
      const k = IDENT_RE.test(key) ? key : quote(key);
      return `${padInner}${k}: ${serializeValue(val, indentLevel + 1)}`;
    });
    return `{\n${lines.join('\n')}\n${pad}}`;
  }

  return 'null';
}

/** Indentation level implied by the column at which `offset` sits on its line. */
export function indentLevelAt(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  const match = /^[ \t]*/.exec(prefix);
  const width = match ? match[0].replace(/\t/g, '  ').length : 0;
  return Math.floor(width / INDENT.length);
}
