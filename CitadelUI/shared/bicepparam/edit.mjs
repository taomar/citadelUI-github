/**
 * Surgical, span-based editing of .bicepparam source.
 *
 * Design rule: we only ever splice the text ranges of values that actually
 * changed. Everything else — comments, blank lines, alignment, ordering — is
 * carried through byte-for-byte. This is the property that `az bicep
 * build-params` cannot provide, and it is why the accelerator's inline
 * documentation survives a round trip.
 */

import { parseBicepParam } from './parser.mjs';
import { serializeValue, indentLevelAt } from './serialize.mjs';
import { tokenize } from './lexer.mjs';

export class EditError extends Error {}

const ARGS = '__args';

function describePath(path) {
  return path
    .map((p) => (typeof p === 'number' ? `[${p}]` : p === ARGS ? '(args)' : `.${p}`))
    .join('')
    .replace(/^\./, '');
}

/** Walk a parsed document to the node addressed by `path`. */
export function resolvePath(doc, path) {
  if (!Array.isArray(path) || path.length === 0) {
    throw new EditError('An empty path cannot be resolved');
  }
  const [head, ...rest] = path;
  const param = doc.params.find((p) => p.name === head);
  if (!param) throw new EditError(`Parameter "${head}" is not declared in this file`);

  let node = param.value;
  let container = { kind: 'param', param };

  for (const seg of rest) {
    if (node.kind === 'object') {
      const prop = node.properties.find((p) => p.key === String(seg));
      if (!prop) {
        throw new EditError(`Property "${seg}" not found at ${describePath(path)}`);
      }
      container = { kind: 'objectProp', object: node, prop };
      node = prop.value;
    } else if (node.kind === 'array') {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length) {
        throw new EditError(`Index ${seg} out of range at ${describePath(path)}`);
      }
      container = { kind: 'arrayItem', array: node, index: idx };
      node = node.items[idx];
    } else if (node.kind === 'call' && seg === ARGS) {
      container = { kind: 'callArgs', call: node };
      // next segment selects the argument index
      continue;
    } else if (container.kind === 'callArgs') {
      const idx = Number(seg);
      const call = container.call;
      if (!Number.isInteger(idx) || idx < 0 || idx >= call.args.length) {
        throw new EditError(`Argument ${seg} out of range at ${describePath(path)}`);
      }
      node = call.args[idx];
      container = { kind: 'callArg', call, index: idx };
    } else {
      throw new EditError(
        `Cannot descend into a ${node.kind} value at ${describePath(path)}`
      );
    }
  }
  return { node, container, param };
}

/** Line-start offset for `offset`, so a removal can take the whole line. */
function lineStart(text, offset) {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/**
 * Insert into a literal that has no elements.
 *
 * An "empty" array or object is not necessarily empty text: several files in
 * this repo carry large commented-out templates between the brackets
 * (`llmBackendConfig` is 3.1 KB of examples with zero live items). Replacing the
 * whole bracket span would silently delete that documentation, so we insert
 * ahead of the closing bracket and only expand to multi-line when the literal is
 * genuinely bare.
 */
function insertIntoEmptyLiteral(text, node, rendered, level) {
  const inner = text.slice(node.innerStart, node.innerEnd);
  const pad = '  '.repeat(level);
  const itemIndent = '  '.repeat(level + 1);
  const open = node.kind === 'array' ? '[' : '{';
  const close = node.kind === 'array' ? ']' : '}';

  if (inner.trim() === '' && !inner.includes('\n')) {
    return {
      start: node.start,
      end: node.end,
      text: `${open}\n${itemIndent}${rendered}\n${pad}${close}`,
    };
  }

  const closeLineStart = lineStart(text, node.end - 1);
  const onOwnLine = text.slice(closeLineStart, node.end - 1).trim() === '';
  const at = onOwnLine ? closeLineStart : node.end - 1;
  return {
    start: at,
    end: at,
    text: onOwnLine ? `${itemIndent}${rendered}\n` : `\n${itemIndent}${rendered}\n${pad}`,
  };
}

/**
 * Whole-value migrations can replace a commented-out collection template.
 * Preserve its comments as comments inside the new collection (or ahead of a
 * scalar), never as data. Token gaps contain only trivia, so quote-like text
 * inside strings cannot be misidentified as a comment.
 */
function renderPreservingComments(text, node, value, level) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const rendered = serializeValue(value, level).replaceAll('\n', newline);
  const original = text.slice(node.start, node.end);
  const comments = [];
  let previous = 0;
  for (const token of tokenize(original)) {
    const trivia = original.slice(previous, token.start);
    comments.push(...[...trivia.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g)].map((match) => match[0]));
    previous = token.end;
  }
  if (!comments.length) return rendered;
  const prefix = comments.map((comment) => `${'  '.repeat(level + 1)}${comment}`).join(newline);
  if (rendered.startsWith('[') || rendered.startsWith('{')) {
    const rest = rendered.length === 2
      ? `${newline}${'  '.repeat(level)}${rendered.at(-1)}`
      : rendered.slice(1);
    return `${rendered[0]}${newline}${prefix}${rest}`;
  }
  return `${newline}${prefix}${newline}${'  '.repeat(level + 1)}${rendered}`;
}

/**
 * Build a splice for one operation.
 * Ops: set | append | insert | remove
 */
function buildSplice(doc, text, op) {
  if (op.op === 'addParam') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.name || '') ||
        doc.params.some((parameter) => parameter.name.toLowerCase() === op.name.toLowerCase())) {
      throw new EditError('A new parameter needs a unique Bicep identifier.');
    }
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const rendered = serializeValue(op.value).replaceAll('\n', newline);
    return {
      start: text.length,
      end: text.length,
      text: `${text.endsWith('\n') || !text ? '' : newline}param ${op.name} = ${rendered}${newline}`,
    };
  }

  if (op.op === 'set') {
    const { node } = resolvePath(doc, op.path);
    const level = indentLevelAt(text, node.start);
    return {
      start: node.start, end: node.end,
      text: op.preserveComments
        ? renderPreservingComments(text, node, op.value, level)
        : serializeValue(op.value, level),
    };
  }

  if (op.op === 'append' || op.op === 'insert') {
    const { node } = resolvePath(doc, op.path);
    if (node.kind !== 'array') {
      throw new EditError(`${describePath(op.path)} is not an array`);
    }
    const level = indentLevelAt(text, node.start);
    const itemIndent = '  '.repeat(level + 1);
    const rendered = serializeValue(op.value, level + 1);

    if (node.items.length === 0) {
      return insertIntoEmptyLiteral(text, node, rendered, level);
    }

    const index =
      op.op === 'append'
        ? node.items.length
        : Math.max(0, Math.min(Number(op.index ?? node.items.length), node.items.length));

    if (index >= node.items.length) {
      const last = node.items[node.items.length - 1];
      return { start: last.end, end: last.end, text: `\n${itemIndent}${rendered}` };
    }
    const target = node.items[index];
    const at = lineStart(text, target.start);
    return { start: at, end: at, text: `${itemIndent}${rendered}\n` };
  }

  if (op.op === 'remove') {
    const { node, container } = resolvePath(doc, op.path);

    if (container.kind === 'arrayItem') {
      let start = lineStart(text, node.start);
      let end = node.end;
      // Swallow a trailing comma and the rest of the line so we do not leave a
      // dangling separator. Comments are intentionally preserved: silently
      // deleting a user's documentation is worse than an orphaned comment.
      while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
      if (text[end] === ',') end += 1;
      if (text[end] === '\r') end += 1;
      if (text[end] === '\n') end += 1;
      // If the item did not start its own line, only remove the item itself.
      if (text.slice(start, node.start).trim() !== '') start = node.start;
      return { start, end, text: '' };
    }

    if (container.kind === 'objectProp') {
      let start = lineStart(text, container.prop.start);
      let end = container.prop.end;
      while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
      if (text[end] === ',') end += 1;
      if (text[end] === '\r') end += 1;
      if (text[end] === '\n') end += 1;
      if (text.slice(start, container.prop.start).trim() !== '') start = container.prop.start;
      return { start, end, text: '' };
    }

    throw new EditError(`${describePath(op.path)} cannot be removed`);
  }

  throw new EditError(`Unknown operation "${op.op}"`);
}

/**
 * Add a property to an object literal (used when a form surfaces an optional
 * field that is absent from the file).
 */
function buildAddProperty(doc, text, op) {
  const { node } = resolvePath(doc, op.path);
  if (node.kind !== 'object') throw new EditError(`${describePath(op.path)} is not an object`);
  const level = indentLevelAt(text, node.start);
  const inner = '  '.repeat(level + 1);
  const rendered = `${op.key}: ${serializeValue(op.value, level + 1)}`;

  if (node.properties.length === 0) {
    return insertIntoEmptyLiteral(text, node, rendered, level);
  }
  const last = node.properties[node.properties.length - 1];
  return { start: last.end, end: last.end, text: `\n${inner}${rendered}` };
}

/**
 * Apply a batch of operations to source text.
 * Splices are applied right-to-left so that offsets computed against the
 * original text remain valid throughout.
 */
export function applyEdits(text, operations) {
  if (!operations || operations.length === 0) return text;
  const doc = parseBicepParam(text);
  const additions = operations.filter((operation) => operation.op === 'addParam');
  const names = additions.map((operation) => String(operation.name).toLowerCase());
  if (new Set(names).size !== names.length) throw new EditError('Conflicting parameter additions.');

  const splices = operations.map((op, index) => ({
    ...(op.op === 'addProperty' ? buildAddProperty(doc, text, op) : buildSplice(doc, text, op)),
    addition: op.op === 'addParam',
    index,
  }));

  // Reject overlapping edits rather than producing corrupt output.
  const sorted = [...splices].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new EditError('Conflicting edits target overlapping regions of the file');
    }
  }

  let out = text;
  for (const splice of [...splices].sort((a, b) =>
    b.start - a.start || (a.addition && b.addition ? b.index - a.index : 0)
  )) {
    out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
  }
  return out;
}
