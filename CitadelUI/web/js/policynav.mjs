/**
 * Navigable index for the guided policy editor.
 *
 * The guided editor emits eleven blocks in one column. At a normal window that
 * is roughly 2100px of content in an 860px viewport, so seven of the eleven
 * were below the fold with nothing on screen to say they existed -- a user
 * reported "I don't see content safety" while it was rendering correctly four
 * blocks down. Undiscoverable is indistinguishable from missing.
 *
 * This module never reaches into the editor's internals. It takes the finished
 * DOM, lifts each block out of the single column, and pairs it with an index
 * that lists every block and its state. Titles and state are read back off the
 * rendered nodes, so policyview.mjs can keep changing shape underneath without
 * this file needing to follow it.
 *
 * The same post-processing stance carries the density pass. A block that repeats
 * one set of fields per model was rendering as a stack of identical forms -- a
 * fallback plus three overrides meant sixteen inputs under sixteen helper
 * sentences, and the one question the screen exists to answer ("which model
 * differs?") had to be answered by reading every value twice. Those repeats are
 * folded into a matrix here, by matching field labels rather than field names,
 * so the fold survives policyview.mjs changing shape underneath it.
 */

import { h } from './dom.mjs';
import { explains } from './explain.mjs';

const STATE_LABEL = {
  on: 'active',
  off: 'not enforced',
  info: '',
};

/* ------------------------------------------------------ helper text on demand

   Every field carried a permanent sentence under its control. One is useful;
   sixteen stacked copies of four sentences are wallpaper, and they push the
   values -- the only thing a reader is scanning for -- apart. Per-field prose
   moves into the same hover/focus popover the deployment parameters already
   use, so this screen learns the app's existing vocabulary instead of a third
   pattern. Lead paragraphs on the card and on a sub-section stay put: there is
   only one of each and they carry the context the fields are read against. */

/**
 * A hint that states a hard bound or warns about the current file is not
 * decoration -- hiding it behind a hover would hide the reason an edit is about
 * to be rejected. These stay on the page.
 */
const LOAD_BEARING = /\b(maximum|minimum|at least|at most|no more than|most restrictive)\b/i;

function loadBearing(hint) {
  return hint.classList.contains('hint-warn') || LOAD_BEARING.test(hint.textContent);
}

function attachExplain(el, title, body) {
  if (!el || !body || el.classList.contains('explain-trigger')) return el;
  return explains(el, () => [
    h('div', { class: 'explain-title' }, title),
    h('p', { class: 'doc-para' }, body),
  ]);
}

/** Folds every non-load-bearing per-field hint into its label's popover. */
function foldFieldHints(root) {
  for (const fieldEl of root.querySelectorAll('.pol-field')) {
    const hint = fieldEl.querySelector(':scope > .hint');
    const label = fieldEl.querySelector(':scope > .pol-label');
    if (!hint || !label || loadBearing(hint)) continue;
    const body = hint.textContent.trim();
    if (!body) continue;
    hint.remove();
    attachExplain(label, label.textContent.trim(), body);
  }
}

/* ------------------------------------------------------- per-model matrix */

/** The control a field wraps, which is what decides both width and equality. */
function controlOf(fieldEl) {
  return fieldEl.querySelector('input, select, textarea');
}

function controlValue(fieldEl) {
  const el = controlOf(fieldEl);
  if (!el) return '';
  if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
  return el.value == null ? '' : String(el.value);
}

/**
 * The narrowest a column of each kind can be and still show its whole value,
 * counted in characters rather than pixels. Characters are what the content is
 * made of, so a column stated this way keeps holding its values when the root
 * font size changes or the window is zoomed — which a pixel constant does not.
 */
const MIN_COL = { name: 22, num: 15, bool: 10, enum: 15, text: 18, expr: 40 };

/** Padding and gaps around a matrix, also in characters. */
const MATRIX_GUTTER = 8;

/*
 * Matrix headings are scan labels, not field documentation. These deliberately
 * short forms keep the label and its unit on one line while the full source
 * label remains available to assistive technology and in the explanation.
 */
const COMPACT_LABELS = new Map([
  ['renewal period (seconds)', ['Renewal', 's']],
  ['bandwidth (kb)', ['Bandwidth', 'KB']],
  ['tokens per minute', ['TPM', '']],
  ['token quota', ['Quota', '']],
  ['quota period', ['Period', '']],
  ['increment condition', ['Count when', '']],
  ['increment count', ['Increment', '']],
  ['retry-after header', ['Retry header', '']],
  ['remaining-calls header', ['Remaining header', '']],
  ['total-calls header', ['Total header', '']],
  ['first period start', ['Period starts', '']],
]);

function compactLabel(label) {
  const compact = COMPACT_LABELS.get(label.toLowerCase());
  if (!compact) return { text: label, unit: '', shown: label };
  const [text, unit] = compact;
  return { text, unit, shown: unit ? `${text} · ${unit}` : text };
}

function boundText(body, hint) {
  const seconds = body.match(/\b(maximum|minimum)\s+(\d+)\s+seconds?\b/i);
  if (seconds) {
    const sign = seconds[1].toLowerCase() === 'maximum' ? '≤' : '≥';
    const never = /\bzero\b.*\bnever\b/i.test(body) ? ' · 0 = never' : '';
    return `${sign}${seconds[2]}s${never}`;
  }
  if (/\bmost restrictive\b/i.test(body)) return 'strictest';
  if (hint.classList.contains('hint-warn')) return 'warning';
  return 'limit';
}

function constraintFor(fieldEl, label) {
  const hint = fieldEl.querySelector(':scope > .hint');
  if (!hint || !loadBearing(hint)) return null;
  const body = hint.textContent.trim();
  if (!body) return null;
  const badge = h(
    'button',
    {
      class: 'pol-bound',
      type: 'button',
      'aria-label': `${label}: ${body}`,
    },
    boundText(body, hint)
  );
  attachExplain(badge, label, body);
  return badge;
}

/**
 * Width should follow content. A two-digit rate and a sixty-character policy
 * expression were getting identical columns, which is what truncated the
 * counter keys while half the window sat empty.
 */
function controlKind(fieldEl) {
  const el = controlOf(fieldEl);
  if (!el) return 'text';
  if (el.tagName === 'SELECT') return 'enum';
  if (el.type === 'checkbox') return 'bool';
  if (el.type === 'number') return 'num';
  return 'text';
}

/** A sub-section that is nothing but a heading and one grid of fields. */
function plainSub(sub) {
  const kids = Array.from(sub.children);
  const grid = kids.find((k) => k.classList.contains('pol-grid'));
  if (!grid) return null;
  const rest = kids.filter((k) => k !== grid);
  // Anything else in the box -- a note that a branch is only editable as raw
  // XML, say -- means the row would lose content on the way into a cell.
  if (rest.some((k) => k.tagName !== 'H5' && !k.classList.contains('pol-sub-head'))) return null;
  const fields = Array.from(grid.querySelectorAll(':scope > .pol-field'));
  if (!fields.length) return null;
  const head = rest[0] || null;
  const labels = fields.map((f) => (f.querySelector(':scope > .pol-label')?.textContent || '').trim());
  return { sub, fields, head, signature: labels.join('\u0001') };
}

function rowName(head) {
  if (!head) return 'All models';
  if (head.tagName === 'H5') return head.textContent.trim();
  return head.querySelector('h5')?.textContent.trim() || 'All models';
}

function rowActions(head) {
  if (!head || head.tagName === 'H5') return [];
  return Array.from(head.querySelectorAll('button, a'));
}

function headerCell(baseField, label, kind) {
  const hint = baseField.querySelector(':scope > .hint');
  const display = compactLabel(label);
  const cell = h(
    'th',
    { scope: 'col', dataset: { kind }, title: display.shown === label ? '' : label },
    h('span', { class: 'pol-matrix-th', 'aria-label': label }, display.shown)
  );
  if (!hint) return cell;
  const body = hint.textContent.trim();
  // The complete sentence is available from the compact heading. Hard bounds
  // also get a visible badge beside every affected control in bodyCell().
  attachExplain(cell.querySelector('.pol-matrix-th'), label, body);
  return cell;
}

function bodyCell(fieldEl, kind, label, baseValue, isBase) {
  // Read before moving: appending the control to the cell empties the field, so
  // asking it for a value afterwards compares every override against "".
  const value = controlValue(fieldEl);
  const control = fieldEl.querySelector(':scope > .pol-control');
  // The label rides along on the cell so the narrow layout, where the header
  // row is gone, can name each value again without a second render pass.
  const display = compactLabel(label);
  const constraint = constraintFor(fieldEl, label);
  const cell = h('td', {
    dataset: {
      kind,
      label: display.shown,
      constraint: constraint ? 'true' : 'false',
    },
  });
  if (control) {
    cell.append(
      h('div', { class: 'pol-matrix-control' }, control, constraint)
    );
  }
  if (isBase || baseValue === null) return cell;
  if (value === baseValue) return cell;
  // Difference is the payload of this table, so it is said three ways: a tint,
  // a mark, and a sentence -- never colour alone.
  cell.classList.add('pol-cell-diff');
  const shown = baseValue === '' ? 'empty' : baseValue;
  cell.prepend(h('span', { class: 'pol-cell-mark', 'aria-hidden': 'true' }));
  cell.append(h('span', { class: 'pol-cell-note' }, `differs from fallback (${shown})`));
  cell.title = `Fallback: ${shown}`;
  return cell;
}

/**
 * Collapses the repeated per-model sub-sections of one card into a single
 * table: one row per model, the fallback first and marked as such, each helper
 * sentence stated once in the header instead of once per row.
 */
function buildMatrix(group) {
  const base = group[0];
  const labels = base.fields.map(
    (f) => (f.querySelector(':scope > .pol-label')?.textContent || '').trim()
  );

  // Kind is a property of the column, not of one cell, so a column holding one
  // long expression is wide for every row.
  const kinds = base.fields.map((f, i) => {
    const kind = controlKind(f);
    if (kind !== 'text') return kind;
    const widest = Math.max(...group.map((g) => controlValue(g.fields[i]).length));
    return widest > 24 ? 'expr' : 'text';
  });

  const head = h(
    'tr',
    {},
    h('th', { scope: 'col', class: 'pol-matrix-corner' }, 'Model'),
    base.fields.map((f, i) => headerCell(f, labels[i], kinds[i]))
  );

  // Read the fallback before any row is built: assembling a row moves the live
  // control out of its field, so asking the base field for its value afterwards
  // would compare every override against an empty string.
  const baseValues = base.fields.map((f) => controlValue(f));

  const rows = group.map((entry, r) => {
    const isBase = r === 0;
    const actions = rowActions(entry.head);
    // The row header names which model the row is about. For the fallback row
    // the editor spells that out as a sentence, which is the right answer to a
    // different question -- the block's own intro already says it. In a column
    // sized for model ids a sentence wraps to four lines and pushes every other
    // row apart, so it is shortened here and the full wording kept on hover.
    const rawName = rowName(entry.head);
    const label = isBase && rawName.length > 18 ? 'Every other model' : rawName;
    const nameEl = h('span', { class: 'pol-matrix-name' }, label);
    if (label !== rawName) attachExplain(nameEl, label, rawName);
    return h(
      'tr',
      { class: isBase ? 'pol-matrix-base' : '' },
      h(
        'th',
        { scope: 'row' },
        nameEl,
        isBase && group.length > 1 ? h('span', { class: 'pol-matrix-tag' }, 'fallback') : null,
        actions.length ? h('span', { class: 'pol-matrix-act' }, actions) : null
      ),
      entry.fields.map((f, i) =>
        bodyCell(f, kinds[i], labels[i], isBase ? null : baseValues[i], isBase)
      )
    );
  });

  // The width a row genuinely needs. A nine-attribute rate limit cannot hold
  // nine live controls in a twelve-hundred pixel pane, and a table that has to
  // truncate its values is worse than no table at all.
  const displays = labels.map(compactLabel);
  const constraints = base.fields.map((field) => Boolean(
    field.querySelector(':scope > .hint') &&
    loadBearing(field.querySelector(':scope > .hint'))
  ));
  const need = kinds.reduce(
    (sum, kind, index) =>
      sum +
      Math.max(MIN_COL[kind], displays[index].shown.length + 3) +
      (constraints[index] ? 7 : 0),
    MIN_COL.name
  );

  return h(
    'table',
    { class: 'pol-matrix', dataset: { need: String(need) } },
    h('thead', {}, head),
    h('tbody', {}, rows)
  );
}

/**
 * One rule decides tabular versus stacked: does the pane hold the columns? That
 * covers a narrow window and a wide row equally, so neither needs a special
 * case and neither can truncate.
 *
 * The comparison happens in characters. `ch` is resolved from the pane's own
 * computed font, so zooming the browser or raising the base font size moves
 * both sides of the test together instead of stranding one of them.
 */
function chWidth(pane) {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;width:20ch';
  pane.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 20;
  probe.remove();
  return w > 0 ? w : 8;
}

function fitMatrices(pane) {
  const tables = pane.querySelectorAll('.pol-matrix[data-need]');
  if (!tables.length) return;
  const ch = chWidth(pane);
  const room = pane.clientWidth / ch - MATRIX_GUTTER;
  for (const table of tables) {
    table.classList.toggle('is-stacked', room < Number(table.dataset.need));
    if (
      !table.classList.contains('is-stacked') &&
      (
        table.scrollWidth > table.clientWidth + 1 ||
        table.getBoundingClientRect().width > table.parentElement.clientWidth + 1
      )
    ) {
      table.classList.add('is-stacked');
    }
  }
}

function watchFit(pane) {
  fitMatrices(pane);
  if (typeof ResizeObserver !== 'function') return;
  new ResizeObserver(() => fitMatrices(pane)).observe(pane);
}

/**
 * Rewrites a card whose sub-sections repeat one set of fields. Sub-sections are
 * matched on their label signature rather than on field names, so a block that
 * gains or loses an attribute upstream still folds.
 */
function foldRepeats(card) {
  const subs = Array.from(card.querySelectorAll(':scope > .pol-sub'));
  const groups = new Map();
  for (const sub of subs) {
    const parsed = plainSub(sub);
    if (!parsed) continue;
    if (!groups.has(parsed.signature)) groups.set(parsed.signature, []);
    groups.get(parsed.signature).push(parsed);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const table = buildMatrix(group);
    group[0].sub.replaceWith(table);
    for (const entry of group.slice(1)) entry.sub.remove();
  }
}

/* Width follows content everywhere a field appears, not only inside a matrix
   or a grid: a lone number field is still a number field. */
function tagFieldKinds(root) {
  for (const fieldEl of root.querySelectorAll('.pol-field')) {
    if (fieldEl.dataset.kind) continue;
    const kind = controlKind(fieldEl);
    const long = kind === 'text' && controlValue(fieldEl).length > 24;
    fieldEl.dataset.kind = long ? 'expr' : kind;
  }
}

function refineBlock(node) {
  if (node.classList.contains('pol-card')) foldRepeats(node);
  tagFieldKinds(node);
  foldFieldHints(node);
}

/**
 * Section titles come from whatever heading the block rendered for itself.
 * Blocks built with `field()` carry no heading, so their `.pol-label` is the
 * only name they have. The node is returned as well as the text, because the
 * section heading above the block makes the block's own copy redundant.
 */
function blockTitle(node, fallback) {
  const head = node.querySelector('.pol-card-head h4, .pol-card-head h3, h4, h3, .pol-label');
  const text = head && head.textContent.trim();
  return { text: text || fallback, node: text ? head : null };
}

/**
 * A block is off when the editor marked it absent, on when it carries an
 * enabled switch, and informational when it has no switch to read. Blocks built
 * with `field()` put their switch in the control slot instead of a card head.
 */
function blockState(node) {
  if (node.classList.contains('pol-card-off')) return 'off';
  const toggle =
    node.querySelector('.pol-card-head input[type="checkbox"]') ||
    node.querySelector(':scope > .pol-control > .toggle input[type="checkbox"]');
  if (!toggle) return 'info';
  return toggle.checked ? 'on' : 'off';
}

/** Counts that are worth showing in the index without opening the block. */
function blockTally(node) {
  const chips = node.querySelectorAll('.model-chip').length;
  if (chips) return `${chips}`;
  const rows = node.querySelectorAll('.pol-sub').length;
  return rows > 1 ? `${rows}` : '';
}

function collectBlocks(guided) {
  const blocks = [];
  for (const node of Array.from(guided.children)) {
    if (!(node instanceof HTMLElement)) continue;
    const fallback = node.classList.contains('pol-scope') ? 'Scope' : 'Policy';
    const title = blockTitle(node, fallback);
    blocks.push({
      node,
      title: title.text,
      titleNode: title.node,
      state: node.classList.contains('pol-scope') ? 'info' : blockState(node),
      tally: blockTally(node),
    });
  }
  return blocks;
}

const STATE_WORD = { on: 'on', off: 'off', info: '\u2014' };

function indexButton(block, i, select, activeIndex) {
  return h(
    'button',
    {
      class: `pnav-link${i === activeIndex ? ' current' : ''} pnav-${block.state}`,
      type: 'button',
      onclick: () => select(i),
    },
    h('span', { class: 'pnav-label' }, block.title),
    block.tally ? h('span', { class: 'pnav-tally' }, block.tally) : null,
    h(
      'span',
      { class: `pnav-state pnav-state-${block.state}`, title: STATE_LABEL[block.state] },
      STATE_WORD[block.state]
    )
  );
}

/**
 * Raw XML is the same file, not a different screen. The switch for it sits in
 * the sheet header beside the policy file path, where the mode being switched
 * is named. The index used to carry a second copy of that switch; two visible
 * controls for one piece of state is a thing to read and reconcile rather than
 * a shortcut, so the index now shows only what it is for — the blocks.
 */

/**
 * Wrap the rendered policy in an index plus one continuous document.
 *
 * This was a master/detail pair, which meant selecting a small block such as
 * "Allowed models" left roughly a thousand vertical pixels of empty pane and
 * hid the other eleven blocks behind a click each. A policy is one artifact
 * that is read top to bottom, so all twelve blocks now stay mounted in a single
 * scrolling column and the index becomes a scroll-spy over it: clicking scrolls
 * rather than swaps, and scrolling moves the highlight. Nothing is hidden,
 * nothing is empty, and the index still answers "what is on".
 */
export function decoratePolicy(policy, ctx) {
  const guided = policy.querySelector('.policy-guided');
  if (!guided) return policy;

  const blocks = collectBlocks(guided);
  if (blocks.length < 3) return policy;

  // Titles, state and tallies are read off the block as the editor rendered it;
  // only then is the block itself rewritten for density.
  for (const block of blocks) refineBlock(block.node);

  const key = 'policy-block';
  const stored = ctx && ctx.isOpen ? ctx.isOpen(key, 0) : 0;
  const activeIndex = Math.min(Math.max(Number(stored) || 0, 0), blocks.length - 1);

  // The section heading names the block once. A block that rendered its own
  // heading gives it up; a block whose only name is a control label keeps the
  // label, because removing it would orphan the control it names.
  const sections = blocks.map((b, i) => {
    const owned = b.titleNode && /^H[1-6]$/.test(b.titleNode.tagName);
    if (owned) b.titleNode.remove();
    return h(
      'section',
      { class: 'pnav-section', 'data-block': String(i), 'aria-label': b.title },
      owned || !b.titleNode ? h('h3', { class: 'pnav-section-title' }, b.title) : null,
      b.node
    );
  });

  const doc = h('div', { class: 'pnav-doc' }, sections);

  const list = h(
    'div',
    { class: 'pnav-list' },
    blocks.map((b, i) => indexButton(b, i, select, activeIndex))
  );

  function highlight(i) {
    list.querySelectorAll('.pnav-link').forEach((link, n) => {
      link.classList.toggle('current', n === i);
      link.setAttribute('aria-current', n === i ? 'true' : 'false');
    });
  }

  function select(i) {
    if (ctx && ctx.setOpen) ctx.setOpen(key, i);
    highlight(i);
    const target = sections[i];
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: motion() });
  }

  const active = blocks.filter((b) => b.state === 'on').length;
  const nav = h(
    'aside',
    { class: 'pnav' },
    h(
      'div',
      { class: 'pnav-head' },
      h('span', {}, 'Policy blocks'),
      h('span', { class: 'pnav-count' }, `${active} of ${blocks.length} on`)
    ),
    list,
    h(
      'p',
      { class: 'pnav-legend' },
      h('span', { class: 'pnav-state pnav-state-on' }, 'on'),
      ' enforced \u00b7 ',
      h('span', { class: 'pnav-state pnav-state-off' }, 'off'),
      ' present but not enforcing'
    )
  );

  guided.replaceChildren(nav, doc);
  guided.classList.add('policy-guided-nav');
  highlight(activeIndex);
  spy(sections, highlight);
  watchFit(doc);
  fitMatrices(doc);
  if (activeIndex > 0) requestAnimationFrame(() => select(activeIndex));
  return policy;
}

function motion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/**
 * Scroll-spy over whichever ancestor actually scrolls.
 *
 * An IntersectionObserver against a reading band near the top of the viewport
 * is cheaper than a scroll listener and does not need to know which container
 * owns the scroll. The active block is the topmost one currently intersecting
 * the band, which is what a reader would call "where I am".
 */
function spy(sections, onChange) {
  if (typeof IntersectionObserver !== 'function') return;
  const visible = new Set();
  let last = -1;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const i = Number(entry.target.dataset.block);
        if (entry.isIntersecting) visible.add(i);
        else visible.delete(i);
      }
      if (!visible.size) return;
      const i = Math.min(...visible);
      if (i === last) return;
      last = i;
      onChange(i);
    },
    // A band just below the top of the viewport: a block counts as "here" from
    // the moment its heading arrives until its last field leaves.
    { rootMargin: '-8% 0px -80% 0px', threshold: 0 }
  );

  for (const section of sections) observer.observe(section);
}
