import { h } from './dom.mjs';
import { renderParamDocument, renderOutlineNav } from './paramview.mjs';
import { MigrationError } from '../../shared/migration-input.mjs';

const address = (path) => JSON.stringify([String(path[0]).toLowerCase(), ...path.slice(1)]);
const short = (value) => value.length > 100 ? `${value.slice(0, 97)}\u2026` : value;

export function renderMigrationTargetPreview({ projection, rows, expanded, heldRows, onImport, onUndo, onMatch, onRender, register = () => {} }) {
  const changes = new Map(projection.changes.map((change) => [address(change.path), change]));
  const byName = new Map(rows.filter((row) => !row.removed).map((row) => [row.name.toLowerCase(), row]));
  const all = expanded.get('target-preview:filter') !== 'imported';
  const tab = expanded.get('target-preview:tab') || 'params';
  const doc = structuredClone(projection.document);
  if (!all) {
    const included = new Set(projection.changes.map((change) => String(change.path[0]).toLowerCase()));
    for (const row of rows) if (heldRows.has(row.id)) included.add(row.name.toLowerCase());
    doc.params = doc.params.filter((param) => included.has(param.name.toLowerCase()));
    doc.outline.sections = doc.outline.sections.map((section) => ({
      ...section, params: section.params.filter((name) => included.has(name.toLowerCase())),
      groups: section.groups.map((group) => ({ ...group, params: group.params.filter((name) => included.has(name.toLowerCase())) })),
    })).filter((section) => section.params.length);
  }
  const annotation = (change) => h('div', { class: 'migration-import-note' },
    h('strong', { class: 'chip migration-import-badge' }, 'Selected import \u2014 not saved'),
    h('details', {},
      h('summary', {}, `${short(change.before)} \u2192 ${short(change.after)}`),
      h('p', { class: 'hint' }, 'Source (old): ', h('code', {}, change.source.file),
        change.kind === 'model' ? ` \u00b7 backend ${change.source.backendId} \u00b7 model ${change.source.model}` : ` \u00b7 parameter ${change.source.parameter}`),
      h('div', { class: 'migration-values' },
        h('section', {}, h('strong', {}, 'Current target'), h('pre', { class: 'migration-value' }, change.before)),
        h('section', {}, h('strong', {}, 'Selected source'), h('pre', { class: 'migration-value' }, change.after)))),
    h('button', {
      type: 'button', class: 'btn btn-sm migration-import-undo',
      'aria-label': `Undo import ${change.kind === 'model' ? `${change.backendId} / ${change.model} / ${change.label}` : change.label}`,
      onclick: () => onUndo(change),
    }, 'Undo import'));
  const denyEdit = () => { throw new MigrationError('decision'); };
  const ctx = {
    readOnly: true, allParameters: true,
    onChange: denyEdit, onAppend: denyEdit, onRemove: denyEdit, onAddProperty: denyEdit, applyObject: denyEdit,
    // No subscription metadata, save callback, environment bridge or resolver.
    resolveEnv: () => null,
    schemaFor: (name) => doc.schema.parameters[name] || null,
    paramValue: (name) => doc.params.find((param) => param.name === name)?.value,
    pendingFor: () => false, findingsFor: () => [],
    isOpen: (key, fallback) => {
      const stateKey = `target-form:${key}`;
      if (expanded.has(stateKey)) return expanded.get(stateKey);
      const match = /^llm-(\d+)(?:-m-(\d+))?$/.exec(key);
      return match && projection.changes.some((change) => change.kind === 'model' &&
        change.path[1] === Number(match[1]) && (!match[2] || change.path[3] === Number(match[2]))) || fallback;
    },
    setOpen: (key, value) => expanded.set(`target-form:${key}`, value),
    rerender: () => onRender(document.activeElement?.dataset.previewFocus),
    decorateValue: (path, rendered) => {
      const change = changes.get(address(path));
      const node = h('div', {
        tabindex: -1, class: change ? 'migration-imported-field' : 'migration-preview-field',
        dataset: { previewPath: address(path), ...(change ? { importPath: address(path) } : {}) },
      }, rendered, change ? annotation(change) : null);
      register(`preview:${address(path)}`, node);
      return node;
    },
    migrationChoice: (path) => {
      const row = byName.get(String(path[0]).toLowerCase());
      if (!row || changes.has(address(path))) return null;
      if (row.structured) return h('button', {
        type: 'button', class: 'btn btn-sm migration-preview-choice', onclick: () => onMatch(row.id),
      }, 'Match source backends and model values');
      const candidate = row.candidates.length === 1 ? row.candidates[0]
        : row.candidates.find((candidate) => candidate.id === row.decision.candidateId);
      if (candidate?.eligible && !candidate.matchesCurrent) return h('button', {
        type: 'button', class: 'btn btn-sm migration-preview-choice',
        'aria-label': `Use source value for ${row.name}`, onclick: () => onImport(row, candidate),
      }, 'Use source value');
      if (row.candidates.length && !row.candidates.every((candidate) => candidate.matchesCurrent)) return h('button', {
        type: 'button', class: 'btn btn-sm migration-preview-choice', onclick: () => onMatch(row.id),
      }, candidate?.valueStatus === 'not-evaluated' ? 'Old value unavailable \u00b7 details' : 'Choose / inspect source values');
      return null;
    },
  };
  const form = renderParamDocument(doc, ctx);
  for (const control of form.querySelectorAll('input, select, textarea')) {
    control.disabled = true;
    control.setAttribute('aria-readonly', 'true');
  }
  for (const button of form.querySelectorAll('button')) {
    if (['migration-import-undo', 'migration-preview-choice', 'lm-name', 'lm-editor-toggle', 'rec-toggle']
      .some((name) => button.classList.contains(name))) {
      const controls = button.getAttribute('aria-controls');
      if (controls) {
        button.dataset.previewFocus = `preview-disclosure:${controls}`;
        register(button.dataset.previewFocus, button);
      }
      continue;
    }
    button.disabled = true;
    button.hidden = true;
  }
  const nav = renderOutlineNav(doc, ctx, (id) => {
    expanded.set('target-preview:section', id);
    for (const button of nav.querySelectorAll('button')) {
      button.classList.toggle('active', button.dataset.section === id);
      button.setAttribute('aria-current', button.dataset.section === id ? 'location' : 'false');
    }
  }, 'tabs');
  for (const button of nav?.querySelectorAll('button') || []) {
    const current = expanded.get('target-preview:section') || doc.outline.sections[0]?.id;
    button.classList.toggle('active', button.dataset.section === current);
    button.setAttribute('aria-current', button.dataset.section === current ? 'location' : 'false');
  }
  const tabButton = (key, label) => {
    const button = h('button', {
      type: 'button', class: `tab${tab === key ? ' active' : ''}`,
      onclick: () => { expanded.set('target-preview:tab', key); onRender(`preview-tab:${key}`); },
    }, label);
    register(`preview-tab:${key}`, button);
    return button;
  };
  const filterButton = h('button', {
    type: 'button', class: 'btn btn-sm', 'aria-pressed': String(!all),
    onclick: () => {
      expanded.set('target-preview:filter', all ? 'imported' : 'all');
      heldRows.clear();
      onRender('preview-filter');
    },
  }, all ? 'Show imported' : 'Show all');
  register('preview-filter', filterButton);
  return h('div', { class: 'sheetwrap migration-target-preview', 'aria-label': 'Migration target form' },
    h('div', { class: 'sheet-sticky' },
      h('header', { class: 'sheet-strip' },
        h('div', { class: 'strip-top' },
          h('h2', { class: 'strip-title' }, 'Migration preview (Experimental)'),
          h('code', { class: 'strip-path' }, doc.path),
          h('span', { class: 'chip chip-warn' }, `${projection.changes.length} selected imports \u00b7 not saved`)),
        h('div', { class: 'strip-tabs' }, h('nav', { class: 'tabs', 'aria-label': 'Migration target preview' },
          tabButton('params', `Parameters (${projection.document.params.length})`),
          tabButton('raw', 'Raw preview (redacted)')))),
      tab === 'params' ? nav : null),
    h('div', { class: 'migration-preview-tools' },
      h('span', { class: 'hint' }, 'Complete target form. Only selected, changed values are highlighted. Expressions and sensitive values remain in the target; they are not resolved here.'),
      filterButton,
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => onMatch(null) }, 'Match source values')),
    tab === 'params' ? h('div', { class: 'sheet-body' }, form)
      : h('div', { class: 'sheet-body' },
        h('p', { class: 'hint' }, 'Sanitized value draft, not a replacement file or deployment certification. Withheld values and comments are omitted; local apply preserves the original untouched bytes.'),
        h('pre', { class: 'raw' }, projection.draft)));
}
