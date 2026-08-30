/* Grid/child arity audit.
   The .diff-line bug was a CSS grid declaring fewer tracks than the JS emits
   children, which silently pushes the overflow into an implicit row where it
   gets the width of track 1 and wraps a character at a time. This walks every
   grid container in the live DOM and flags the same shape anywhere else:
   a container whose in-flow child count is not a whole multiple of its used
   track count, i.e. a ragged final row.

   Reported, not asserted: a ragged row is legal when the author meant it
   (`grid-column: span N`, `column-span: all`). The output is a shortlist to
   read, not a pass/fail gate. Subgrid rows are skipped -- their tracks come
   from the parent and the child count is checked there. */

export const GRID_AUDIT = `(() => {
  const out = [];
  const seen = new Map();
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display !== 'grid' && cs.display !== 'inline-grid') continue;
    if (cs.gridTemplateColumns === 'none' || cs.gridTemplateColumns.includes('subgrid')) continue;
    const tracks = cs.gridTemplateColumns.trim().split(/\\s+(?![^(]*\\))/).length;
    if (!tracks) continue;

    const kids = [...el.children].filter(k => {
      const ks = getComputedStyle(k);
      if (ks.display === 'none' || ks.position === 'absolute' || ks.position === 'fixed') return false;
      return true;
    });
    if (!kids.length) continue;

    // A child that deliberately spans is not part of the arity question.
    const spans = kids.some(k => {
      const s = getComputedStyle(k);
      return /span/.test(s.gridColumn) || s.gridColumn === '1 / -1' || s.gridColumnEnd === '-1';
    });

    const rows = new Set(kids.map(k => Math.round(k.getBoundingClientRect().top))).size;
    const ragged = kids.length % tracks !== 0;

    const key = el.className || el.tagName;
    if (seen.has(key)) { seen.get(key).count++; continue; }
    const rec = {
      sel: String(key).slice(0, 60),
      tracks,
      kids: kids.length,
      rows,
      ragged,
      spans,
      count: 1,
      suspect: ragged && !spans && kids.length > tracks
    };
    seen.set(key, rec);
    out.push(rec);
  }
  return out.filter(r => r.suspect);
})()`;
