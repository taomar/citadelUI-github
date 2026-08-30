/** Line diff for the pre-save review. Small LCS, adequate for single-file edits. */

import { h } from './dom.mjs';

function lcsMatrix(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }
  return { table, cols };
}

export function diffLines(beforeText, afterText) {
  const a = beforeText.split('\n');
  const b = afterText.split('\n');
  const { table, cols } = lcsMatrix(a, b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], a: i + 1, b: j + 1 });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      out.push({ type: 'del', text: a[i], a: i + 1 });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j], b: j + 1 });
      j += 1;
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i], a: ++i });
  while (j < b.length) out.push({ type: 'add', text: b[j], b: ++j });
  return out;
}

/** Collapse unchanged regions so the reviewer sees only what moved. */
export function renderDiff(beforeText, afterText, context = 3) {
  const lines = diffLines(beforeText, afterText);
  const keep = new Set();
  lines.forEach((line, index) => {
    if (line.type === 'same') return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });

  const rows = [];
  let skipping = false;
  lines.forEach((line, index) => {
    if (!keep.has(index)) {
      if (!skipping) {
        rows.push(h('div', { class: 'diff-gap' }, '⋯'));
        skipping = true;
      }
      return;
    }
    skipping = false;
    const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    rows.push(
      h(
        'div',
        { class: `diff-line diff-${line.type}` },
        h('span', { class: 'diff-no' }, line.a ?? ''),
        h('span', { class: 'diff-no' }, line.b ?? ''),
        h('span', { class: 'diff-sign' }, sign),
        h('span', { class: 'diff-text' }, line.text)
      )
    );
  });

  if (!rows.length) rows.push(h('p', { class: 'empty' }, 'No changes.'));
  const stats = lines.reduce(
    (acc, l) => {
      if (l.type === 'add') acc.added += 1;
      if (l.type === 'del') acc.removed += 1;
      return acc;
    },
    { added: 0, removed: 0 }
  );
  return { node: h('div', { class: 'diff' }, rows), stats };
}
