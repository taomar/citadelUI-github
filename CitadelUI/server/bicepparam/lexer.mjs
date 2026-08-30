/**
 * Lexer for the bounded .bicepparam grammar used by the Citadel accelerator.
 *
 * Trivia (whitespace + comments) is skipped for token purposes but never removed
 * from the source: every token carries absolute offsets so downstream editing can
 * splice the original text and leave all surrounding trivia byte-identical.
 */

const PUNCT = new Set(['[', ']', '{', '}', '(', ')', ',', ':', '=']);

export class LexError extends Error {
  constructor(message, offset, line) {
    super(`${message} (line ${line})`);
    this.offset = offset;
    this.line = line;
  }
}

function isIdentStart(ch) {
  return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

/**
 * Produce a token array. Token: { type, value, start, end, line, nlBefore }
 * `nlBefore` records whether a newline appeared in the trivia preceding the
 * token, which the parser needs because Bicep uses newlines as element
 * separators inside arrays and objects.
 */
export function tokenize(text) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let nlBefore = false;

  const push = (type, value, start) => {
    tokens.push({ type, value, start, end: i, line, nlBefore });
    nlBefore = false;
  };

  while (i < text.length) {
    const ch = text[i];

    // --- trivia -------------------------------------------------------------
    if (ch === '\n') {
      line += 1;
      nlBefore = true;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') {
          line += 1;
          nlBefore = true;
        }
        i += 1;
      }
      i += 2;
      continue;
    }

    // --- strings ------------------------------------------------------------
    if (ch === "'") {
      const start = i;
      // Multi-line string literal ('''...''') is not used by this repo today but
      // is cheap to tolerate so an upstream change cannot corrupt a save.
      if (text.startsWith("'''", i)) {
        i += 3;
        while (i < text.length && !text.startsWith("'''", i)) {
          if (text[i] === '\n') line += 1;
          i += 1;
        }
        i += 3;
        push('string', text.slice(start + 3, i - 3), start);
        continue;
      }
      i += 1;
      let value = '';
      while (i < text.length && text[i] !== "'") {
        if (text[i] === '\\') {
          const next = text[i + 1];
          if (next === 'n') value += '\n';
          else if (next === 'r') value += '\r';
          else if (next === 't') value += '\t';
          else if (next === '\\') value += '\\';
          else if (next === "'") value += "'";
          else if (next === '$') value += '$';
          else if (next === 'u') {
            // \u{XXXX}
            const m = /^\\u\{([0-9A-Fa-f]+)\}/.exec(text.slice(i));
            if (m) {
              value += String.fromCodePoint(parseInt(m[1], 16));
              i += m[0].length;
              continue;
            }
            value += next;
          } else value += next;
          i += 2;
          continue;
        }
        if (text[i] === '\n') {
          throw new LexError('Unterminated string literal', start, line);
        }
        value += text[i];
        i += 1;
      }
      if (i >= text.length) throw new LexError('Unterminated string literal', start, line);
      i += 1; // closing quote
      push('string', value, start);
      continue;
    }

    // --- numbers ------------------------------------------------------------
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(text[i + 1] || ''))) {
      const start = i;
      if (ch === '-') i += 1;
      while (i < text.length && /[0-9]/.test(text[i])) i += 1;
      push('number', Number(text.slice(start, i)), start);
      continue;
    }

    // --- identifiers / keywords --------------------------------------------
    if (isIdentStart(ch)) {
      const start = i;
      while (i < text.length && isIdentPart(text[i])) i += 1;
      const word = text.slice(start, i);
      if (word === 'true' || word === 'false') push('bool', word === 'true', start);
      else if (word === 'null') push('null', null, start);
      else push('ident', word, start);
      continue;
    }

    // --- punctuation --------------------------------------------------------
    if (PUNCT.has(ch)) {
      const start = i;
      i += 1;
      push('punct', ch, start);
      continue;
    }

    throw new LexError(`Unexpected character ${JSON.stringify(ch)}`, i, line);
  }

  tokens.push({ type: 'eof', value: null, start: i, end: i, line, nlBefore });
  return tokens;
}
