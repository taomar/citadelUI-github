/**
 * Acceptance gate for the comment-preserving write path.
 *
 * The accelerator's .bicepparam files are mostly documentation: the access
 * contract file alone is ~80% comments. Any save path that loses them is a
 * regression, so these tests run against every real .bicepparam file in the
 * repository rather than synthetic fixtures.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokenize } from '../server/bicepparam/lexer.mjs';
import { parseBicepParam, nodeToValue } from '../server/bicepparam/parser.mjs';
import { applyEdits } from '../server/bicepparam/edit.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.azure', '.backups']);

function findParamFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) findParamFiles(full, out);
    else if (entry.endsWith('.bicepparam')) out.push(full);
  }
  return out;
}

function countComments(text) {
  let line = 0;
  let block = 0;
  for (const tok of []) void tok;
  // Count via a light scan that ignores comment markers inside string literals.
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 2;
      else {
        if (ch === "'") inString = false;
        i += 1;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      line += 1;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      block += 1;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    i += 1;
  }
  return { line, block, total: line + block };
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push(`${name}\n    ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const files = findParamFiles(repoRoot);
console.log(`Discovered ${files.length} .bicepparam files under ${repoRoot}\n`);
assert(files.length > 0, 'no .bicepparam files found');

let totalComments = 0;
let totalParams = 0;

for (const file of files) {
  const rel = relative(repoRoot, file);
  const text = readFileSync(file, 'utf8');
  const comments = countComments(text);
  totalComments += comments.total;

  check(`lex: ${rel}`, () => {
    const tokens = tokenize(text);
    assert(tokens.length > 0, 'no tokens produced');
    assert(tokens[tokens.length - 1].type === 'eof', 'token stream does not end with eof');
    // Spans must be monotonic and inside the source.
    let prev = -1;
    for (const tok of tokens) {
      assert(tok.start >= prev, `token span went backwards at line ${tok.line}`);
      assert(tok.end <= text.length, 'token span exceeds source length');
      prev = tok.start;
    }
  });

  let doc;
  check(`parse: ${rel}`, () => {
    doc = parseBicepParam(text);
    assert(doc.params.length > 0, 'no parameters parsed');
    for (const p of doc.params) {
      assert(
        text.slice(p.value.start, p.value.end).length > 0,
        `empty value span for param ${p.name}`
      );
    }
  });
  if (!doc) continue;
  totalParams += doc.params.length;

  check(`no-op edit is byte-identical: ${rel}`, () => {
    assert(applyEdits(text, []) === text, 'empty edit list mutated the file');
  });

  check(`span slices reproduce source: ${rel}`, () => {
    for (const p of doc.params) {
      const slice = text.slice(p.value.start, p.value.end);
      const reparsed = parseBicepParam(`using 'x.bicep'\nparam ${p.name} = ${slice}`);
      assert(reparsed.params.length === 1, `re-parse of ${p.name} span failed`);
    }
  });

  check(`edit preserves every comment: ${rel}`, () => {
    const target = doc.params.find(
      (p) => p.value.kind === 'string' || p.value.kind === 'bool' || p.value.kind === 'number'
    );
    if (!target) return; // file has no scalar param to poke
    const newValue =
      target.value.kind === 'string'
        ? 'citadel-ui-roundtrip-probe'
        : target.value.kind === 'bool'
          ? !target.value.value
          : target.value.value + 1;

    const edited = applyEdits(text, [{ op: 'set', path: [target.name], value: newValue }]);
    const after = countComments(edited);
    assert(
      after.total === comments.total,
      `comment count changed: ${comments.total} -> ${after.total}`
    );

    // Everything outside the edited value span must be untouched.
    const prefix = text.slice(0, target.value.start);
    assert(edited.startsWith(prefix), 'bytes before the edited value changed');
    const suffix = text.slice(target.value.end);
    assert(edited.endsWith(suffix), 'bytes after the edited value changed');

    const reparsed = parseBicepParam(edited);
    const got = reparsed.params.find((p) => p.name === target.name);
    assert(got, 'edited parameter disappeared');
    assert(
      nodeToValue(got.value) === newValue,
      `value not applied: expected ${newValue}, got ${nodeToValue(got.value)}`
    );
  });

  check(`array append keeps comments: ${rel}`, () => {
    const target = doc.params.find((p) => p.value.kind === 'array');
    if (!target) return;
    const edited = applyEdits(text, [
      { op: 'append', path: [target.name], value: 'citadel-ui-probe' },
    ]);
    const after = countComments(edited);
    assert(
      after.total === comments.total,
      `comment count changed on append: ${comments.total} -> ${after.total}`
    );
    const reparsed = parseBicepParam(edited);
    const got = reparsed.params.find((p) => p.name === target.name);
    assert(got.value.items.length === target.value.items.length + 1, 'item was not appended');
  });
}

console.log(`\nFiles: ${files.length}  Params: ${totalParams}  Comments: ${totalComments}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll round-trip fidelity checks passed.');
