/**
 * Parser producing a span-annotated tree for .bicepparam files.
 *
 * Every node records `[start, end)` offsets into the original source. Editing is
 * performed as surgical text splices against those spans (see edit.mjs), which is
 * what keeps the ~1,300 documentation comments in these files byte-identical
 * across a save. We deliberately do NOT implement a printer for whole files:
 * re-printing would discard trivia and is the exact failure mode of
 * `az bicep build-params`.
 */

import { tokenize, LexError } from './lexer.mjs';

export { LexError };

export class ParseError extends Error {
  constructor(message, token) {
    super(token ? `${message} (line ${token.line})` : message);
    this.token = token;
  }
}

class Cursor {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(offset = 0) {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  next() {
    return this.tokens[this.pos++];
  }
  at(type, value) {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  expect(type, value) {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ParseError(
        `Expected ${value !== undefined ? JSON.stringify(value) : type} but found ${
          t.type === 'eof' ? 'end of file' : JSON.stringify(String(t.value))
        }`,
        t
      );
    }
    return this.next();
  }
}

function parseExpression(cur, text) {
  const tok = cur.peek();

  if (tok.type === 'string') {
    cur.next();
    return { kind: 'string', value: tok.value, start: tok.start, end: tok.end };
  }
  if (tok.type === 'number') {
    cur.next();
    return { kind: 'number', value: tok.value, start: tok.start, end: tok.end };
  }
  if (tok.type === 'bool') {
    cur.next();
    return { kind: 'bool', value: tok.value, start: tok.start, end: tok.end };
  }
  if (tok.type === 'null') {
    cur.next();
    return { kind: 'null', value: null, start: tok.start, end: tok.end };
  }
  if (tok.type === 'punct' && tok.value === '[') return parseArray(cur, text);
  if (tok.type === 'punct' && tok.value === '{') return parseObject(cur, text);

  if (tok.type === 'ident') {
    // Function call, e.g. readEnvironmentVariable('X', 'y') / bool(...) / loadTextContent(...)
    if (cur.peek(1).type === 'punct' && cur.peek(1).value === '(') {
      const nameTok = cur.next();
      cur.next(); // '('
      const args = [];
      while (!(cur.at('punct', ')') || cur.at('eof'))) {
        args.push(parseExpression(cur, text));
        if (cur.at('punct', ',')) cur.next();
      }
      const close = cur.expect('punct', ')');
      return {
        kind: 'call',
        callee: nameTok.value,
        args,
        start: nameTok.start,
        end: close.end,
        raw: text.slice(nameTok.start, close.end),
      };
    }
    // Bare identifier reference (e.g. another param). Preserved verbatim.
    cur.next();
    return {
      kind: 'reference',
      name: tok.value,
      start: tok.start,
      end: tok.end,
      raw: text.slice(tok.start, tok.end),
    };
  }

  throw new ParseError(
    `Unsupported expression starting with ${JSON.stringify(String(tok.value))}`,
    tok
  );
}

function parseArray(cur, text) {
  const open = cur.expect('punct', '[');
  const items = [];
  while (!cur.at('punct', ']')) {
    if (cur.at('eof')) throw new ParseError('Unterminated array literal', cur.peek());
    items.push(parseExpression(cur, text));
    if (cur.at('punct', ',')) cur.next();
  }
  const close = cur.expect('punct', ']');
  return {
    kind: 'array',
    items,
    start: open.start,
    end: close.end,
    innerStart: open.end,
    innerEnd: close.start,
  };
}

function parseObject(cur, text) {
  const open = cur.expect('punct', '{');
  const properties = [];
  while (!cur.at('punct', '}')) {
    if (cur.at('eof')) throw new ParseError('Unterminated object literal', cur.peek());

    const keyTok = cur.next();
    if (keyTok.type !== 'ident' && keyTok.type !== 'string') {
      throw new ParseError(
        `Expected property name but found ${JSON.stringify(String(keyTok.value))}`,
        keyTok
      );
    }
    cur.expect('punct', ':');
    const value = parseExpression(cur, text);
    properties.push({
      key: String(keyTok.value),
      quoted: keyTok.type === 'string',
      keyStart: keyTok.start,
      keyEnd: keyTok.end,
      value,
      start: keyTok.start,
      end: value.end,
    });
    if (cur.at('punct', ',')) cur.next();
  }
  const close = cur.expect('punct', '}');
  return {
    kind: 'object',
    properties,
    start: open.start,
    end: close.end,
    innerStart: open.end,
    innerEnd: close.start,
  };
}

/**
 * Parse a .bicepparam document.
 * Returns { using, params, text } where each param carries the span of its
 * declaration and of its value expression.
 */
export function parseBicepParam(text) {
  const cur = new Cursor(tokenize(text));
  const params = [];
  let using = null;

  while (!cur.at('eof')) {
    const tok = cur.peek();

    if (tok.type === 'ident' && tok.value === 'using') {
      cur.next();
      const target = cur.peek();
      if (target.type === 'string') {
        cur.next();
        using = { path: target.value, start: target.start, end: target.end };
      } else if (target.type === 'ident' && target.value === 'none') {
        cur.next();
        using = { path: null, start: target.start, end: target.end };
      } else {
        throw new ParseError('Expected a module path after `using`', target);
      }
      continue;
    }

    if (tok.type === 'ident' && tok.value === 'param') {
      const kw = cur.next();
      const nameTok = cur.expect('ident');
      cur.expect('punct', '=');
      const value = parseExpression(cur, text);
      params.push({
        name: nameTok.value,
        nameStart: nameTok.start,
        nameEnd: nameTok.end,
        value,
        start: kw.start,
        end: value.end,
      });
      continue;
    }

    // `extends`/`var`/`type` are not used by this repo; skipping the token keeps
    // the parser from hard-failing if upstream introduces them, and the surgical
    // editor will simply never touch those regions.
    cur.next();
  }

  return { using, params, text };
}

/** Convert a parsed value node into a plain JS value for display/editing. */
export function nodeToValue(node) {
  switch (node.kind) {
    case 'string':
    case 'number':
    case 'bool':
    case 'null':
      return node.value;
    case 'array':
      return node.items.map(nodeToValue);
    case 'object': {
      const out = {};
      for (const p of node.properties) out[p.key] = nodeToValue(p.value);
      return out;
    }
    case 'call':
      // readEnvironmentVariable('VAR', 'default') resolves through the env layer;
      // here we surface the structure so the UI can edit the variable instead.
      return { __expr: node.kind, callee: node.callee, args: node.args.map(nodeToValue), raw: node.raw };
    case 'reference':
      return { __expr: 'reference', name: node.name, raw: node.raw };
    default:
      return null;
  }
}
