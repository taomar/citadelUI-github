/**
 * Documentation layer.
 *
 * The three focus parameter files are already heavily documented by their
 * authors using a consistent banner convention:
 *
 *   // ============================================================
 *   // REQUIRED: API Management (APIM) Configuration
 *   // ============================================================
 *   // Specifies the target APIM instance where ...
 *   //
 *   // Properties:
 *   // - subscriptionId: Azure subscription ID where APIM is deployed
 *   // ============================================================
 *   param apim = { ... }
 *
 * Rather than hardcoding a curated group list in the UI -- which would encode
 * the same knowledge in two places and drift the moment the repo changes --
 * this module derives the section outline from those banners. The grouping the
 * user sees is therefore always the grouping the file's authors wrote.
 *
 * This layer is strictly READ-ONLY. It produces no edit operations and never
 * feeds the writer, so a parsing mistake here can degrade presentation but can
 * never corrupt a parameter file.
 */

const FENCE = /^(={3,}|-{3,})$/;
/**
 * Sections are delimited by `=` fences only. `-` fences are sub-headings that
 * live *inside* a section body. Surveyed across the repo this holds without
 * exception: bicep/infra/main.bicepparam uses 18 `=` fences and zero dashed
 * ones, while every dashed fence in the other files sits inside a body (e.g.
 * "MULTI-ASSET CONTRACTS" within Services Configuration). Treating the two
 * alike made a body terminate early and its remaining prose become the title
 * of a bogus section.
 */
const SECTION_FENCE = /^={3,}$/;
const REQ_PREFIX = /^(REQUIRED|OPTIONAL)\s*:\s*/i;
const PARAM_LIST = /^(REQUIRED|OPTIONAL)\s+PARAMETERS\s*:\s*(.*)$/i;
const LIST_ITEM = /^(?:[-*]|\d+\.)\s+(.*)$/;

function stripComment(line) {
  const t = line.trim();
  if (!t.startsWith('//')) return null;
  return t.slice(2).replace(/^ /, '').trimEnd();
}

function isFence(stripped) {
  return stripped !== null && FENCE.test(stripped.trim());
}

function isSectionFence(stripped) {
  return stripped !== null && SECTION_FENCE.test(stripped.trim());
}

function slug(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

/* ------------------------------------------------------------------ body */

/**
 * Turn a banner body (comment text with the `//` already stripped) into an
 * ordered list of render blocks. Deliberately a tiny subset of markdown: the
 * source is prose written for humans, not a markup language, so the parser
 * only recognises shapes that actually occur in these files.
 */
export function parseDocBody(lines) {
  const blocks = [];
  let para = [];

  const flush = () => {
    if (para.length) {
      blocks.push({ type: 'para', text: para.join(' ').trim() });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) {
      flush();
      continue;
    }

    // Dashed sub-banner inside a body: fence / text / fence.
    if (FENCE.test(line)) {
      const title = (lines[i + 1] || '').trim();
      const closing = (lines[i + 2] || '').trim();
      if (title && !FENCE.test(title) && FENCE.test(closing)) {
        flush();
        blocks.push({ type: 'heading', text: title });
        i += 2;
      }
      continue;
    }

    const paramList = line.match(PARAM_LIST);
    if (paramList) {
      flush();
      blocks.push({
        type: 'paramlist',
        requirement: paramList[1].toLowerCase(),
        names: paramList[2]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      flush();
      const last = blocks[blocks.length - 1];
      const target = last && last.type === 'list' ? last : (blocks.push({ type: 'list', items: [] }), blocks[blocks.length - 1]);
      const body = item[1];
      const sep = body.indexOf(':');
      // `- name: description` becomes a definition; anything else is a plain
      // bullet. Only split when the term looks like an identifier, so prose
      // bullets containing a colon are not mangled.
      if (sep > 0 && /^[A-Za-z_][\w.$-]*$/.test(body.slice(0, sep).trim())) {
        target.items.push({ term: body.slice(0, sep).trim(), text: body.slice(sep + 1).trim() });
      } else {
        target.items.push({ term: null, text: body });
      }
      continue;
    }

    // Indented continuation of the bullet directly above.
    const last = blocks[blocks.length - 1];
    if (!para.length && /^\s{2,}/.test(raw) && last && last.type === 'list' && last.items.length) {
      const li = last.items[last.items.length - 1];
      li.text = `${li.text} ${line}`.trim();
      continue;
    }

    // `Example:` style lead-in followed by a block of code.
    const next = lines[i + 1] ? lines[i + 1].trim() : '';
    const nextRaw = lines[i + 1] || '';
    const looksLikeCode =
      next && !LIST_ITEM.test(next) && (/^\s{2,}/.test(nextRaw) || /^(param\s|\{|\[)/.test(next));
    if (line.endsWith(':') && next && !LIST_ITEM.test(next) && (/example/i.test(line) || looksLikeCode)) {
      flush();
      const code = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !FENCE.test(lines[j].trim())) {
        code.push(lines[j]);
        j += 1;
      }
      if (code.length) {
        blocks.push({ type: 'code', label: line.replace(/:$/, ''), lines: dedent(code) });
        i = j - 1;
        continue;
      }
    }

    para.push(line);
  }

  flush();
  return blocks;
}

function dedent(lines) {
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    min = Math.min(min, l.length - l.trimStart().length);
  }
  if (!Number.isFinite(min) || min === 0) return lines.slice();
  return lines.map((l) => l.slice(min));
}

/* --------------------------------------------------------------- scanning */

/**
 * Scan one stretch of text that sits between parameter declarations and pull
 * out banner sections plus the trailing comment block (which documents the
 * parameter that follows the gap).
 */
function scanGap(text, offset) {
  const sections = [];
  const lines = text.split('\n');
  let trailing = null;
  let i = 0;

  while (i < lines.length) {
    const stripped = stripComment(lines[i]);

    if (stripped === null) {
      // A non-comment, non-blank line resets any comment we were holding.
      if (lines[i].trim()) trailing = null;
      i += 1;
      continue;
    }

    if (isSectionFence(stripped)) {
      const titles = [];
      let j = i + 1;
      while (j < lines.length) {
        const s = stripComment(lines[j]);
        if (s === null || isSectionFence(s)) break;
        titles.push(s);
        j += 1;
      }
      const closer = j < lines.length ? stripComment(lines[j]) : null;
      if (titles.length && isSectionFence(closer)) {
        const body = [];
        let k = j + 1;
        while (k < lines.length) {
          const s = stripComment(lines[k]);
          if (s === null || isSectionFence(s)) break;
          body.push(s);
          k += 1;
        }
        if (k < lines.length && isSectionFence(stripComment(lines[k]))) k += 1;

        const rawTitle = titles.join(' ').trim();
        const req = rawTitle.match(REQ_PREFIX);
        sections.push({
          title: rawTitle.replace(REQ_PREFIX, '').trim(),
          requirement: req ? req[1].toLowerCase() : null,
          blocks: parseDocBody(body),
          offset,
          params: [],
          groups: [],
        });
        trailing = null;
        i = k;
        continue;
      }
      i += 1;
      continue;
    }

    // A plain comment block. The last one in the gap documents the next param.
    const block = [];
    while (i < lines.length) {
      const s = stripComment(lines[i]);
      if (s === null || isSectionFence(s)) break;
      block.push(s);
      i += 1;
    }
    trailing = block.length ? block : null;
  }

  return { sections, trailing };
}

/* ---------------------------------------------------------------- outline */

/**
 * Build the section outline for a parsed document.
 *
 * @param {string} text  raw file text
 * @param {Array}  params parsed params, each with `.start` and `.value.end`
 */
export function buildOutline(text, params) {
  const sections = [];
  const leads = new Map();

  let cursor = 0;
  for (const p of params) {
    const gap = scanGap(text.slice(cursor, p.start), cursor);
    sections.push(...gap.sections);
    if (gap.trailing) leads.set(p.name, gap.trailing);
    // Attach to the section opened most recently before this parameter.
    if (sections.length) sections[sections.length - 1].params.push(p.name);
    else {
      sections.push({
        title: 'Parameters',
        requirement: null,
        blocks: [],
        offset: 0,
        params: [p.name],
        groups: [],
      });
    }
    cursor = p.value.end;
  }
  sections.push(...scanGap(text.slice(cursor), cursor).sections);

  // A leading section that captured no parameters is the file overview.
  let intro = null;
  if (sections.length && sections[0].params.length === 0) intro = sections.shift();

  for (const s of sections) s.groups = buildGroups(s.params, leads);

  const paramDocs = {};
  for (const [name, lines] of leads) {
    // Lead comments promoted to sub-group labels are rendered as group
    // headings instead, so they must not be repeated on the parameter.
    if (!isGroupLabel(name, sections)) paramDocs[name] = parseDocBody(lines);
  }

  const ids = new Set();
  for (const s of sections) {
    let id = slug(s.title);
    let n = 2;
    while (ids.has(id)) id = `${slug(s.title)}-${n++}`;
    ids.add(id);
    s.id = id;
    delete s.offset;
  }
  if (intro) {
    intro.id = 'overview';
    delete intro.offset;
    delete intro.groups;
  }

  return { intro, sections, paramDocs };
}

/**
 * Split a section's parameters into sub-groups.
 *
 * A comment block that is followed by two or more parameters is a heading for
 * that run (`// Subnet names` above four subnet parameters). A comment block
 * covering a single parameter is that parameter's own documentation.
 */
function buildGroups(names, leads) {
  const groups = [];
  let current = { label: null, blocks: [], params: [] };

  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    const lead = leads.get(name);
    if (lead) {
      let run = 1;
      while (i + run < names.length && !leads.has(names[i + run])) run += 1;
      if (run >= 2) {
        if (current.params.length) groups.push(current);
        const blocks = parseDocBody(lead);
        const head = blocks[0] && blocks[0].type === 'para' ? blocks[0].text : lead[0];
        current = {
          label: head,
          blocks: blocks[0] && blocks[0].type === 'para' ? blocks.slice(1) : blocks,
          params: [],
        };
      }
    }
    current.params.push(name);
  }
  if (current.params.length) groups.push(current);
  return groups;
}

function isGroupLabel(name, sections) {
  for (const s of sections) {
    for (const g of s.groups) {
      if (g.label && g.params[0] === name) return true;
    }
  }
  return false;
}
