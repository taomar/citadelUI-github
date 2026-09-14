import { Parser, Language } from './vendor/tree-sitter.mjs';

export const NATIVE_PARSER_VERSION = 1;
export const NATIVE_LIMITS = Object.freeze({ bytes: 512 * 1024, depth: 64, nodes: 100000, parseMicros: 300000, operations: 1000 });
const encoder = new TextEncoder();
const parsers = new Map();
let initialization;

export function nativeError(message, node = null, code = 'NATIVE_SYNTAX') {
  const position = node?.startPosition;
  const location = position ? ` (line ${position.row + 1}, column ${position.column + 1})` : '';
  return Object.assign(new Error(`${message}${location}`), { code, status: 422 });
}

/** Pinned same-origin assets only; Node's filesystem is used only by the server/tests. */
export async function initializeNativeParser() {
  if (!initialization) {
    initialization = (async () => {
      const base = new URL('./vendor/', import.meta.url);
      const nodeRuntime = typeof process !== 'undefined' && Boolean(process.versions?.node);
      const bytes = async (name) => {
        if (nodeRuntime) return new Uint8Array(await (await import('node:fs/promises')).readFile(new URL(name, base)));
        const response = await fetch(new URL(name, base), { credentials: 'same-origin' });
        if (!response.ok) throw nativeError('The local native parser asset could not be loaded.', null, 'NATIVE_PARSER_UNAVAILABLE');
        return new Uint8Array(await response.arrayBuffer());
      };
      await Parser.init({ wasmBinary: await bytes('tree-sitter.wasm') });
      for (const [syntax, file] of [['hcl-tfvars', 'hcl.wasm'], ['json-tfvars', 'json.wasm']]) {
        const parser = new Parser();
        parser.setLanguage(await Language.load(await bytes(file)));
        parsers.set(syntax, parser);
      }
    })().catch((error) => { initialization = null; throw error; });
  }
  return initialization;
}

export const isExactNumber = (value) => value !== null && typeof value === 'object' &&
  Object.keys(value).length === 1 && typeof value.__tfNumber === 'string';
export function exactNumber(lexeme, syntax = 'hcl-tfvars') {
  const text = String(lexeme);
  if (text.length > 1024) throw nativeError('Exact number text exceeds the 1,024-character editor limit.', null, 'NATIVE_LIMIT');
  if (syntax === 'hcl-tfvars' && /^-?0\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
    throw nativeError('Unsupported editor numeric spelling: leading-zero notation is not supported by this literal reader. The document remains read-only and its original bytes are unchanged.', null, 'NATIVE_NUMBER_SYNTAX');
  }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
    throw nativeError('Enter an exact decimal number, not a calculation.', null, 'NATIVE_NUMBER');
  }
  // The packaged HCL grammar requires a decimal point in exponential literals.
  // Do not normalize the operator's input or mislabel a parser gap as rounding.
  if (syntax === 'hcl-tfvars' && /[eE]/.test(text) && !text.includes('.')) {
    throw nativeError('Unsupported editor syntax: integer-mantissa exponential numbers are valid Terraform but are not recognized by this HCL grammar. The document is read-only; original bytes are preserved. Use an external editor without converting or rounding the value.', null, 'NATIVE_NUMBER_GRAMMAR');
  }
  return { __tfNumber: text };
}

export const children = (node, type = null) => (node?.namedChildren || [])
  .filter((child) => child.type !== 'comment' && (!type || child.type === type));
export function unwrap(node) {
  while (['expression', 'literal_value', 'collection_value', 'template_expr', 'operation'].includes(node?.type)) {
    const list = children(node);
    if (list.length !== 1) throw nativeError('Functions, traversals and calculations are not variable-file literals.', node, 'NATIVE_EXPRESSION');
    node = list[0];
  }
  return node;
}

export function withNativeCst(text, syntax, run) {
  if (typeof text !== 'string' || encoder.encode(text).length > NATIVE_LIMITS.bytes) {
    throw nativeError('Native source exceeds the 512 KiB editor limit.', null, 'NATIVE_LIMIT');
  }
  if (text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
    throw nativeError('Native source must be valid Unicode without NUL characters.');
  }
  const parser = parsers.get(syntax);
  if (!parser) throw nativeError('The offline native parser is not initialized.', null, 'NATIVE_PARSER_UNAVAILABLE');
  const deadline = performance.now() + NATIVE_LIMITS.parseMicros / 1000;
  const tree = parser.parse(text, null, { progressCallback: () => performance.now() > deadline });
  if (!tree) { parser.reset(); throw nativeError('Native parsing exceeded the time limit.', null, 'NATIVE_LIMIT'); }
  try {
    if (syntax === 'hcl-tfvars' && tree.rootNode.hasError) {
      const exponent = tree.rootNode.descendantsOfType('numeric_lit').find((node) =>
        /^\d+$/.test(node.text) && /^[eE][+-]?\d+(?![\w.])/.test(text.slice(node.endIndex)));
      if (exponent) {
        throw nativeError('Unsupported editor syntax: this valid Terraform integer-mantissa exponent is not recognized by the selected HCL grammar. The whole document is read-only; no values are normalized or rounded and all original bytes are preserved.', exponent, 'NATIVE_NUMBER_GRAMMAR');
      }
    }
    const stack = [[tree.rootNode, 0]];
    let count = 0;
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (++count > NATIVE_LIMITS.nodes || depth > NATIVE_LIMITS.depth * 5) {
        throw nativeError('Native source exceeds the nesting/node limit.', node, 'NATIVE_LIMIT');
      }
      if (node.type === 'ERROR' || node.isMissing) {
        throw nativeError('Native source syntax could not be parsed at this location (missing or unexpected token). The document cannot be saved; no source bytes were rewritten.', node);
      }
      for (const child of node.children) stack.push([child, depth + 1]);
    }
    return run(tree.rootNode);
  } finally { tree.delete(); }
}

function literalText(text, node, quoted) {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (text.startsWith('$${', index) || text.startsWith('%%{', index)) {
      result += text.slice(index + 1, index + 3);
      index += 2;
    } else if (text.startsWith('${', index) || text.startsWith('%{', index)) {
      throw nativeError('Terraform templates are not literal values. Escape literal ${ as $${ and %{ as %%{, or edit this expression outside Citadel.', node, 'NATIVE_EXPRESSION');
    } else if (ch === '\\' && quoted) {
      const escape = text[++index];
      const escapes = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
      if (Object.hasOwn(escapes, escape)) result += escapes[escape];
      else if (escape === 'u' || escape === 'U') {
        const size = escape === 'u' ? 4 : 8;
        const hex = text.slice(index + 1, index + size + 1);
        const code = /^[a-fA-F0-9]+$/.test(hex) && hex.length === size ? parseInt(hex, 16) : -1;
        if (code < 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw nativeError('Invalid Unicode escape in HCL string.', node);
        result += String.fromCodePoint(code);
        index += size;
      } else throw nativeError('Invalid HCL string escape.', node);
    } else {
      if (quoted && /[\r\n]/.test(ch)) throw nativeError('Use a heredoc for a multiline HCL string.', node);
      result += ch;
    }
  }
  return result;
}

export function decodeHclString(node) {
  const source = node.text;
  if (node.type === 'heredoc_template') {
    const identifiers = children(node, 'heredoc_identifier');
    const first = identifiers[0], last = identifiers.at(-1);
    if (identifiers.length !== 2 || first.text !== last.text) throw nativeError('Ambiguous heredoc boundary.', node);
    const bodyStart = source.indexOf('\n') + 1;
    const lastOffset = last.startIndex - node.startIndex;
    const closingStart = source.lastIndexOf('\n', lastOffset - 1) + 1;
    let body = source.slice(bodyStart, closingStart).replaceAll('\r\n', '\n');
    if (source.startsWith('<<-')) {
      const indents = body.split('\n').filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)[0].length);
      const min = indents.length ? Math.min(...indents) : 0;
      body = body.split('\n').map((line) => line.slice(Math.min(min, /^[ \t]*/.exec(line)[0].length))).join('\n');
    }
    return literalText(body, node, false);
  }
  if (source[0] !== '"' || source.at(-1) !== '"') throw nativeError('Expected a quoted literal string.', node);
  return literalText(source.slice(1, -1), node, true);
}

export function objectKey(node) {
  const value = unwrap(node);
  if (value.type === 'variable_expr' && children(value).length === 1) return children(value)[0].text;
  if (value.type === 'identifier') return value.text;
  if (value.type === 'string_lit' || value.type === 'quoted_template') return decodeHclString(value);
  throw nativeError('Object keys must be literal names or quoted labels.', value, 'NATIVE_EXPRESSION');
}

function assertKey(key, seen, node) {
  if (key === '__tfNumber') throw nativeError('The __tfNumber key is reserved by the exact-number adapter.', node);
  if (seen.has(key)) throw nativeError('Duplicate key or variable assignment. Remove the duplicate before editing.', node, 'NATIVE_DUPLICATE');
  seen.add(key);
}

function record(node, kind, value, extra = {}) {
  return { kind, value, start: node.startIndex, end: node.endIndex, ...extra };
}

function commaSpans(node) {
  return node.children.filter((child) => child.type === ',').map((child) => ({ start: child.startIndex, end: child.endIndex }));
}

function hclLiteralNode(input, depth = 0) {
  if (depth > NATIVE_LIMITS.depth) throw nativeError('Native source exceeds 64 literal nesting levels.', input, 'NATIVE_LIMIT');
  const node = unwrap(input);
  const list = children(node);
  switch (node.type) {
    case 'numeric_lit':
      return record(node, 'number', exactNumber(node.text));
    case 'unary_operation':
      if (!/^-\s*\d/.test(node.text)) throw nativeError('Only a literal negative number is supported.', node, 'NATIVE_EXPRESSION');
      return record(node, 'number', exactNumber(`-${unwrap(list[0]).text}`));
    case 'bool_lit': return record(node, 'bool', node.text === 'true');
    case 'null_lit': return record(node, 'null', null);
    case 'string_lit':
    case 'quoted_template':
    case 'heredoc_template':
      return record(node, 'string', decodeHclString(node), { heredoc: node.type === 'heredoc_template' ? node.text : null });
    case 'tuple': {
      const items = children(node, 'expression').map((child) => hclLiteralNode(child, depth + 1));
      return record(node, 'array', items.map((item) => item.value), { items, close: list.at(-1).startIndex, commas: commaSpans(node) });
    }
    case 'object': {
      const seen = new Set();
      const properties = children(node, 'object_elem').map((child) => {
        const key = objectKey(child.childForFieldName('key'));
        assertKey(key, seen, child);
        return { key, start: child.startIndex, end: child.endIndex,
          node: hclLiteralNode(child.childForFieldName('val'), depth + 1) };
      });
      return record(node, 'object', Object.fromEntries(properties.map((property) => [property.key, property.node.value])),
        { properties, close: list.at(-1).startIndex, commas: commaSpans(node) });
    }
    default: throw nativeError('Only literal values are supported in .tfvars. Functions (including file()), traversals, templates and calculations require an external editor.', node, 'NATIVE_EXPRESSION');
  }
}

export const readHclLiteral = (node) => hclLiteralNode(node).value;

function jsonLiteralNode(node, depth = 0) {
  if (depth > NATIVE_LIMITS.depth) throw nativeError('Native source exceeds 64 literal nesting levels.', node, 'NATIVE_LIMIT');
  const list = children(node);
  switch (node.type) {
    case 'string': return record(node, 'string', JSON.parse(node.text));
    case 'number': return record(node, 'number', exactNumber(node.text, 'json-tfvars'));
    case 'true': case 'false': return record(node, 'bool', node.type === 'true');
    case 'null': return record(node, 'null', null);
    case 'array': {
      const items = list.map((item) => jsonLiteralNode(item, depth + 1));
      return record(node, 'array', items.map((item) => item.value), { items, close: node.endIndex - 1, commas: commaSpans(node) });
    }
    case 'object': {
      const seen = new Set();
      const properties = list.map((pair) => {
        if (pair.type !== 'pair') throw nativeError('Expected a JSON property.', pair);
        const key = JSON.parse(pair.childForFieldName('key').text);
        assertKey(key, seen, pair);
        return { key, start: pair.startIndex, end: pair.endIndex,
          node: jsonLiteralNode(pair.childForFieldName('value'), depth + 1) };
      });
      return record(node, 'object', Object.fromEntries(properties.map((property) => [property.key, property.node.value])),
        { properties, close: node.endIndex - 1, commas: commaSpans(node) });
    }
    default: throw nativeError('Expected strict JSON literals (no comments or trailing commas).', node);
  }
}

export function parseNativeValues(text, syntax = 'hcl-tfvars') {
  return withNativeCst(text, syntax, (root) => {
    if (syntax === 'json-tfvars') {
      // JSON.parse provides the stricter JSON grammar check; its numeric result
      // is never used. The CST handles duplicate keys and exact numeric lexemes.
      try { JSON.parse(text); } catch { throw nativeError('Malformed JSON variable file.'); }
      const list = children(root);
      if (list.length !== 1 || list[0].type !== 'object') throw nativeError('A JSON variable file must be one object.', root);
      return jsonLiteralNode(list[0]);
    }
    const bodies = children(root);
    if (bodies.some((node) => node.type !== 'body')) throw nativeError('Expected variable-file assignments.', root);
    const seen = new Set();
    const properties = (bodies[0] ? children(bodies[0]) : []).map((node, index, all) => {
      if (node.type !== 'attribute') throw nativeError('Blocks are not allowed in .tfvars; select an operator values file, not .tf configuration.', node);
      if (index && !text.slice(all[index - 1].endIndex, node.startIndex).includes('\n')) {
        throw nativeError('Separate variable assignments with a newline.', node);
      }
      const [name, value] = children(node);
      const key = name.text;
      assertKey(key, seen, node);
      return { key, start: node.startIndex, end: node.endIndex, node: hclLiteralNode(value) };
    });
    return { kind: 'object', start: 0, end: text.length, close: text.length, root: true, properties,
      value: Object.fromEntries(properties.map((property) => [property.key, property.node.value])) };
  });
}

function escapedHcl(value) {
  return JSON.stringify(value).replaceAll('${', () => '$${').replaceAll('%{', () => '%%{');
}

export function nativeLiteral(value, syntax = 'hcl-tfvars', indent = '', depth = 0) {
  if (depth > NATIVE_LIMITS.depth) throw nativeError('Edited value exceeds 64 nesting levels.');
  if (isExactNumber(value)) return exactNumber(value.__tfNumber, syntax).__tfNumber;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw nativeError('Use an exact decimal string for native numbers. JavaScript rounding is not accepted.', null, 'NATIVE_NUMBER');
    return String(value);
  }
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return syntax === 'json-tfvars' ? JSON.stringify(value) : escapedHcl(value);
  const next = `${indent}  `;
  if (Array.isArray(value)) return value.length
    ? `[\n${value.map((item) => `${next}${nativeLiteral(item, syntax, next, depth + 1)}`).join(',\n')}\n${indent}]` : '[]';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.some(([key]) => key === '__tfNumber')) throw nativeError('Invalid exact number.');
    return entries.length ? `{\n${entries.map(([key, item]) =>
      `${next}${syntax === 'json-tfvars' ? JSON.stringify(key) : /^[A-Za-z_][\w-]*$/.test(key) ? key : escapedHcl(key)}${syntax === 'json-tfvars' ? ': ' : ' = '}${nativeLiteral(item, syntax, next, depth + 1)}`)
      .join(syntax === 'json-tfvars' ? ',\n' : '\n')}\n${indent}}` : '{}';
  }
  throw nativeError('Undefined or nonliteral values cannot be written.');
}

export function nativeNodeAt(root, path) {
  let node = root;
  for (const key of path) {
    node = node?.kind === 'object' ? node.properties.find((property) => property.key === key)?.node
      : node?.kind === 'array' && Number.isInteger(key) ? node.items[key] : null;
    if (!node) throw nativeError('The edit no longer addresses a source value. Reopen the selected unit.', null, 'NATIVE_STALE_OPERATION');
  }
  return node;
}

function replacement(node, value, syntax, newline) {
  if (!node.heredoc) return nativeLiteral(value, syntax).replaceAll('\n', newline);
  if (typeof value !== 'string' || !value.endsWith('\n')) {
    throw nativeError('A heredoc edit must remain a string ending with a newline. Change its representation outside Citadel.');
  }
  const header = node.heredoc.slice(0, node.heredoc.indexOf('\n') + 1);
  const closing = node.heredoc.slice(node.heredoc.lastIndexOf('\n') + 1);
  const marker = closing.trim();
  if (value.split('\n').some((line) => line.trim() === marker)) {
    throw nativeError('The edited string contains the heredoc closing marker; choose another marker outside Citadel.');
  }
  const indent = header.startsWith('<<-') ? /^[ \t]*/.exec(closing)[0] : '';
  const body = value.replaceAll('${', () => '$${').replaceAll('%{', () => '%%{').split('\n').slice(0, -1)
    .map((line) => indent + line).join(newline) + newline;
  return header + body + closing;
}

function insertLiteral(text, node, content, syntax, edits) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const members = node.kind === 'array' ? node.items : node.properties;
  const tail = members.at(-1);
  const lineStart = text.lastIndexOf('\n', node.close - 1) + 1;
  const closingIndent = text.slice(lineStart, node.close);
  const ownLine = /^[ \t]*$/.test(closingIndent);
  const indent = node.root ? '' : ownLine ? `${closingIndent}  ` : '  ';
  const comma = node.kind === 'array' || syntax === 'json-tfvars';
  if (tail && comma) {
    const existing = (node.commas || []).some((separator) => separator.start >= tail.end &&
      !edits.some((edit) => edit.value === '' && edit.start <= separator.start && edit.end >= separator.end));
    if (!existing) edits.push({ start: tail.end, end: tail.end, value: ',' });
  }
  const location = ownLine ? lineStart : node.close;
  const prefix = node.root && (!text.length || text.endsWith('\n')) || ownLine ? '' : newline;
  const insertionKey = `${node.start}:${node.close}:${node.kind}`;
  let insertion = edits.find((edit) => edit.insertionKey === insertionKey);
  if (!insertion) {
    insertion = { start: location, end: location, insertionKey, contents: [] };
    edits.push(insertion);
  }
  insertion.contents.push(`${indent}${content.replaceAll('\n', newline)}`);
  insertion.value = prefix + insertion.contents.join(`${comma ? ',' : ''}${newline}`) + newline;
}

/** All addresses resolve against the original CST, not a reparsed shifted index. */
export function applyNativeEdits(text, operations, syntax = 'hcl-tfvars') {
  if (!Array.isArray(operations) || operations.length > NATIVE_LIMITS.operations) throw nativeError('Too many native edit operations.');
  const root = parseNativeValues(text, syntax);
  const edits = [];
  const removedMembers = new Map();
  const insertions = [];
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  for (const operation of operations) {
    const path = operation?.path;
    if (!Array.isArray(path) || !path.length || path.length > NATIVE_LIMITS.depth ||
        path.some((part) => typeof part !== 'string' && (!Number.isInteger(part) || part < 0))) throw nativeError('Invalid native edit path.');
    if (operation.op === 'set') {
      const parent = nativeNodeAt(root, path.slice(0, -1));
      const property = parent.kind === 'object' && parent.properties.find((item) => item.key === path.at(-1));
      if (parent.kind === 'object' && !property) {
        const key = path.at(-1);
        if (typeof key !== 'string') throw nativeError('Object keys must be strings.');
        insertions.push({ node: parent, content: `${syntax === 'json-tfvars' ? JSON.stringify(key) : /^[A-Za-z_][\w-]*$/.test(key) ? key : escapedHcl(key)}${syntax === 'json-tfvars' ? ': ' : ' = '}${nativeLiteral(operation.value, syntax)}` });
      } else {
        const node = nativeNodeAt(root, path);
        edits.push({ start: node.start, end: node.end, value: replacement(node, operation.value, syntax, newline) });
      }
    } else if (operation.op === 'append' || operation.op === 'addProperty') {
      const node = nativeNodeAt(root, path);
      if (operation.op === 'append' && node.kind !== 'array' || operation.op === 'addProperty' && node.kind !== 'object') {
        throw nativeError('The native edit target has a different collection type.');
      }
      let content = nativeLiteral(operation.value, syntax);
      if (operation.op === 'addProperty') {
        if (typeof operation.key !== 'string' || node.properties.some((property) => property.key === operation.key)) throw nativeError('Cannot add an existing or invalid native key.');
        content = `${syntax === 'json-tfvars' ? JSON.stringify(operation.key) : /^[A-Za-z_][\w-]*$/.test(operation.key) ? operation.key : escapedHcl(operation.key)}${syntax === 'json-tfvars' ? ': ' : ' = '}${content}`;
      }
      insertions.push({ node, content });
    } else if (operation.op === 'remove') {
      const parent = nativeNodeAt(root, path.slice(0, -1));
      const members = parent.kind === 'array' ? parent.items : parent.properties;
      const index = parent.kind === 'array' ? path.at(-1) : members.findIndex((property) => property.key === path.at(-1));
      const item = members[index];
      if (!item) throw nativeError('The value to remove no longer exists.');
      edits.push({ start: item.start, end: item.end, value: '' });
      if (!removedMembers.has(parent)) removedMembers.set(parent, new Set());
      removedMembers.get(parent).add(index);
    } else throw nativeError('Unsupported native edit operation.');
  }
  // Separators belong to the final surviving sequence, not to each deletion in
  // isolation. The CST identifies commas without mistaking comment text for one.
  for (const [parent, removed] of removedMembers) {
    const members = parent.kind === 'array' ? parent.items : parent.properties;
    let last = members.length - 1, left = 0;
    while (removed.has(last)) last -= 1;
    for (const comma of parent.commas || []) {
      while (left + 1 < members.length && members[left + 1].end <= comma.start) left += 1;
      if (removed.has(left) || left === last && last < members.length - 1) edits.push({ ...comma, value: '' });
    }
  }
  for (const { node, content } of insertions) {
    const removed = removedMembers.get(node);
    const key = node.kind === 'array' ? 'items' : 'properties';
    const target = removed ? { ...node, [key]: node[key].filter((_, index) => !removed.has(index)) } : node;
    insertLiteral(text, target, content, syntax, edits);
  }
  const seenSeparators = new Set();
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index];
    if (edit.value !== ',' || edit.start !== edit.end) continue;
    if (seenSeparators.has(edit.start)) edits.splice(index, 1);
    else seenSeparators.add(edit.start);
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end || (a.value === ',' ? -1 : b.value === ',' ? 1 : 0));
  for (let index = 1; index < edits.length; index++) {
    if (edits[index].start < edits[index - 1].end) throw nativeError('Overlapping native edits require a fresh review.', null, 'NATIVE_EDIT_OVERLAP');
  }
  let after = text;
  for (const edit of [...edits].reverse()) after = after.slice(0, edit.start) + edit.value + after.slice(edit.end);
  parseNativeValues(after, syntax);
  return after;
}
