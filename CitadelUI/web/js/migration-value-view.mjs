import { h } from './dom.mjs';
import { MIGRATION_CATEGORIES } from '../../shared/parameter-migration.mjs';
import { safeLabel } from '../../shared/migration-input.mjs';

const short = (value) => String(value ?? '[not supplied]').length > 100
  ? `${String(value).slice(0, 97)}…` : String(value ?? '[not supplied]');
const fileName = (value) => String(value || '').split('/').slice(-2).join('/');
const selected = (row) => row.decision.kind === 'accept' || row.decision.kind === 'models' && row.structured?.summary?.selectedFields > 0;
const alreadySame = (row) => row.candidates.length > 0 && row.candidates.every((candidate) => candidate.matchesCurrent === true);
const unreadableSource = (row) => row.candidates.length > 0 &&
  row.candidates.every((candidate) => candidate.valueStatus !== 'readable');
export const migrationQuantity = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
function needsAttention(row) {
  if (row.structured) {
    return !row.structured.available || row.structured.sourceIssues.length > 0 ||
      row.structured.backends.some((backend) => backend.issue ||
        backend.confirmedSource && backend.models.some((model) => model.issue));
  }
  return row.decision.kind === 'pending' && (row.candidates.length > 1 || row.candidates.some((candidate) => !candidate.eligible));
}

export function migrationSelectionSummary(rows) {
  const current = rows.filter((row) => !row.removed);
  return {
    selected: current.reduce((sum, row) => sum + (row.structured
      ? row.structured.summary?.selectedFields || 0 : Number(row.decision.kind === 'accept')), 0),
    changes: current.reduce((sum, row) => sum + (row.structured
      ? row.structured.summary?.changedFields || 0 : Number(row.status === 'copy')), 0),
    alreadyCurrent: current.reduce((sum, row) => sum + (row.structured
      ? row.structured.summary?.alreadyCurrent || 0 : Number(row.status === 'accepted-unchanged')), 0),
    selectedParameters: current.filter(selected).length,
    attention: current.filter(needsAttention).length,
    same: current.filter(alreadySame).length,
    targetOnly: current.filter((row) => !row.candidates.length).length,
    unavailable: current.filter(unreadableSource).length,
  };
}

export function migrationRowVisible(row, { filter = '', scope = 'all' } = {}) {
  if (row.removed || filter && !row.name.toLowerCase().includes(filter.toLowerCase())) return false;
  if (scope === 'selected') return selected(row);
  if (scope === 'attention') return needsAttention(row);
  if (scope === 'unresolved') return unreadableSource(row);
  if (scope === 'target-only') return !row.candidates.length;
  if (scope === 'differences') return selected(row) ||
    row.candidates.length > 0 && !alreadySame(row) && !unreadableSource(row);
  if (scope === 'same') return alreadySame(row);
  return true;
}

function details(title, content, key, options) {
  return h('details', {
    class: 'migration-value-details',
    open: options.expanded.get(key) || false,
    ontoggle: (event) => options.expanded.set(key, event.target.open),
  }, h('summary', {}, title), h('div', { class: 'migration-detail-body' }, content));
}

function valueCell(label, value, status = 'readable') {
  const explanation = {
    'not-evaluated': 'Expression or reference not evaluated. Its value is not available for comparison.',
    sensitive: 'Sensitive value. Not displayed or imported.',
    'unknown-schema': 'Value cannot be verified against the current target schema.',
    unresolved: 'Value cannot be read unambiguously.',
    missing: 'Not supplied in this file.',
  }[status];
  return h('div', { class: 'migration-value-cell' },
    h('span', { class: 'migration-cell-label' }, label),
    explanation ? h('span', { class: 'hint' }, explanation) : h('code', {}, short(value)));
}

export function renderMigrationValue(row, options) {
  const candidateId = options.candidates.get(row.id) ||
    (row.decision.kind === 'accept' ? row.decision.candidateId : '');
  const candidate = row.candidates.find((entry) => entry.id === candidateId) ||
    (row.candidates.length === 1 ? row.candidates[0] : null);
  const checked = row.decision.kind === 'accept';
  const checkbox = h('input', {
    class: 'ctl-check', type: 'checkbox', name: `import-${row.id}`, id: `import-${row.id}`,
    checked, disabled: options.busy || !candidate?.eligible, 'aria-label': `Import ${row.name}`,
    onchange: (event) => options.onImport(row, candidate, event.target.checked),
  });
  options.register(`import:${row.id}`, checkbox);
  let chooser = null;
  if (row.candidates.length > 1) {
    chooser = h('select', {
      class: 'ctl', name: `source-${row.id}`, disabled: options.busy,
      'aria-label': `Source (old) for ${row.name}`,
      onchange: (event) => options.onCandidate(row, event.target.value),
    }, h('option', { value: '' }, 'Choose source (old) value…'),
    row.candidates.map((entry) => h('option', { value: entry.id },
      `Source: ${entry.name} — ${fileName(entry.source.file)} · ${entry.source.occurrence}`)));
    chooser.value = candidate?.id || '';
    options.register(`match:${row.id}`, chooser);
  }
  const status = checked ? row.status === 'accepted-unchanged' ? 'Already same' : 'Selected'
    : !row.candidates.length ? 'New-only · kept'
      : !candidate ? 'Choose a source value'
        : candidate.valueStatus === 'not-evaluated' ? 'Source expression not evaluated'
          : !candidate.eligible ? MIGRATION_CATEGORIES[candidate.category]
            : candidate.matchesCurrent ? 'Already same · kept' : 'Keep current';
  const root = h('article', {
    class: 'migration-value-row', tabindex: -1, 'aria-label': `New parameter ${row.name}`,
    dataset: { row: row.id },
  },
  h('div', { class: 'migration-value-grid' },
    h('div', { class: 'migration-import-cell' }, checkbox),
    h('div', { class: 'migration-value-name' },
      h('span', { class: 'migration-cell-label' }, 'Target parameter (new)'),
      h('label', { for: `import-${row.id}` }, row.name),
      candidate ? h('small', { class: 'hint' }, `Source (old): ${candidate.name} · ${fileName(candidate.source.file)}`)
        : h('small', { class: 'hint' }, row.candidates.length ? 'Choose the old assignment to compare.' : 'No selected old file supplies this value.'),
      chooser),
    valueCell('Source value (old / previous)', candidate?.value || (row.candidates.length ? 'Choose a source value' : 'Not supplied'), candidate?.valueStatus),
    valueCell('Current target value (new)', row.current, row.currentValueStatus),
    h('span', { class: 'migration-value-status' }, status)),
  details('Full values and matching details', [
    h('div', { class: 'migration-values' },
      candidate ? h('section', {}, h('h4', {}, 'Source value (old / previous)'), h('pre', { class: 'migration-value' }, candidate.fullValue)) : null,
      h('section', {}, h('h4', {}, 'Current target value (new)'), h('pre', { class: 'migration-value' }, row.currentFull))),
    candidate ? h('p', { class: 'hint' }, `Source (old) parameter ${candidate.name}; ${candidate.source.file}; declaration ${candidate.source.occurrence}.`) : null,
    h('p', { class: 'hint' }, `Current type: ${row.guidance.type || 'unknown'}. ${row.guidance.description || ''}`),
    h('p', { class: 'hint' }, row.guidance.validation),
    candidate?.problems.length ? h('ul', {}, candidate.problems.map((problem) => h('li', {}, problem))) : null,
    h('p', { class: 'hint' }, row.categories.map((category) => MIGRATION_CATEGORIES[category]).join(' · ')),
  ], row.id, options));
  options.register(row.id, root);
  return root;
}

export function renderMigrationModels(row, options) {
  const review = row.structured;
  const root = h('article', { class: 'migration-model-review', tabindex: -1, dataset: { row: row.id }, 'aria-label': `New parameter ${row.name}` },
    h('h4', {}, row.name),
    h('p', { class: 'hint' }, 'Match each new backend explicitly, then select model fields. New backend identities, endpoints, authentication and unselected models stay unchanged.'));
  options.register(row.id, root);
  if (!review.available) {
    root.append(h('p', { class: 'migration-warning' }, review.issue));
    return root;
  }
  if (!review.backends.length) root.append(h('p', { class: 'hint' }, 'The new file has no backend/model targets. Old backends will not be added.'));
  for (const [index, backend] of review.backends.entries()) {
    const pairKey = `${row.id}:${backend.key}`;
    const draft = options.pairs.has(pairKey) ? options.pairs.get(pairKey) : backend.confirmedSource || '';
    const proposed = backend.options.find((entry) => entry.key === draft);
    const chooser = h('select', {
      class: 'ctl', name: pairKey, disabled: options.busy || Boolean(backend.issue),
      'aria-label': `Old backend for ${backend.backendId}`,
      onchange: (event) => options.onPairDraft(row, backend, event.target.value),
    }, h('option', { value: '' }, 'Choose an old backend…'),
    backend.options.map((entry) => h('option', { value: entry.key, disabled: !entry.eligible },
      `${entry.backendId} · ${entry.backendType} · ${fileName(entry.file)}${entry.key === backend.suggestion ? ' (same ID/provider)' : ''}${entry.issue ? ` — ${entry.issue}` : ''}`)));
    chooser.value = draft;
    options.register(`pair:${pairKey}`, chooser);
    const changing = backend.confirmedSource && draft !== backend.confirmedSource;
    const selectedFields = backend.models.reduce((sum, model) => sum + model.fields.filter((field) => field.selected).length, 0);
    const confirmed = backend.options.find((entry) => entry.key === backend.confirmedSource);
    const confirm = h('button', {
      class: 'btn btn-sm', type: 'button',
      disabled: options.busy || !proposed?.eligible || draft === backend.confirmedSource,
      onclick: () => options.onPair(row, backend, draft),
    }, draft && draft === backend.confirmedSource ? 'Pairing confirmed'
      : changing && selectedFields ? `Confirm replacement (clears ${selectedFields} choices)` : 'Confirm backend pairing');
    options.register(`confirm:${pairKey}`, confirm);
    const body = h('div', { class: 'migration-detail-body' },
      backend.issue ? h('p', { class: 'migration-warning' }, backend.issue) : null,
      h('label', { class: 'catalog-field' }, h('span', { class: 'catalog-field-label' }, `Target (new): ${backend.backendId} ← source (old) backend`), chooser),
      proposed ? h('p', { class: 'hint' },
        `Target (new) endpoint: ${backend.endpoint}. Source (old) endpoint: ${proposed.endpoint}. Pairing does not copy endpoint, authentication or routing settings.`) : null,
      h('div', { class: 'catalog-form-actions' }, confirm,
        backend.confirmedSource ? h('button', {
          class: 'btn btn-sm', type: 'button', disabled: options.busy,
          onclick: () => options.onClearPair(row, backend),
        }, 'Clear backend pairing') : null));
    if (confirmed) body.append(h('p', { class: 'hint' },
      `Confirmed source still in use: ${confirmed.backendId} · ${fileName(confirmed.file)}.`,
      changing ? ` The dropdown is only a proposal. Confirming a replacement clears this backend's ${selectedFields} selected field(s); other drafts stay unchanged.` : ''));
    if (!backend.confirmedSource) {
      body.append(h('p', { class: 'hint' }, 'Confirm the old backend before comparing models. Model names are never matched across backends.'));
    } else {
      for (const model of backend.models) {
        const modelKey = `${row.id}:${model.key}`;
        const shownFields = model.fields.filter((field) => options.showUnchanged ||
          ['different', 'source-only', 'incompatible'].includes(field.comparison) || field.selected ||
          options.heldFields?.has(`${modelKey}:${field.key}`));
        const identical = model.fields.filter((field) => field.comparison === 'same').length;
        const targetOnly = model.fields.filter((field) => field.comparison === 'target-only').length;
        const fields = h('div', { class: 'migration-model-fields' },
          model.issue ? h('p', { class: 'migration-warning' }, model.issue) : null,
          identical || targetOnly ? h('p', { class: 'hint' },
            `${migrationQuantity(identical, 'identical model field')} · ${migrationQuantity(targetOnly, 'target-only field')} kept. All new parameters shows these fields.`) : null,
          shownFields.map((field) => {
            const key = `${modelKey}:${field.key}`;
            const box = h('input', {
              class: 'ctl-check', type: 'checkbox', name: key, checked: field.selected,
              disabled: options.busy || !field.eligible,
              'aria-label': `Import ${field.label} for ${backend.backendId} / ${model.name}`,
              onchange: (event) => options.onModelField(row, backend, model, field, event.target.checked),
            });
            options.register(key, box);
            return h('div', { class: 'migration-model-field' },
              h('label', {}, box, h('span', {}, field.label)),
              valueCell('Source value (old / previous)', field.source), valueCell('Current target value (new)', field.current),
              h('small', { class: field.problems.length ? 'migration-warning' : 'hint' },
                field.problems.length ? field.problems.join(' ')
                  : field.comparison === 'target-only' ? 'Not supplied by old model · target kept'
                    : field.comparison === 'source-only' ? field.selected ? 'Selected optional field' : 'Old-only optional field · explicit choice required'
                  : field.selected ? field.differs ? 'Selected' : 'Already same'
                    : field.needsReview && field.differs ? 'Review format/version/API difference' : 'Keep current'));
          }));
        body.append(details([
          h('strong', {}, model.name),
          model.modelPath ? ` · route ${model.modelPath}` : '',
          ` · ${migrationQuantity(model.fields.filter((field) => field.selected).length, 'field')} selected`,
          model.issue ? ' · match needs review'
            : ` · ${model.fields.filter((field) => field.comparison === 'different').length} different · ${identical} identical · ${targetOnly} target-only`,
        ], fields, modelKey, options));
      }
      if (backend.unmatchedSourceModels.length) body.append(details('Old models not imported',
        h('ul', {}, backend.unmatchedSourceModels.map((model) => h('li', {}, `${model.name}: ${model.issue} (${model.status})`))),
        `${pairKey}:unmatched`, options));
    }
    const expanded = options.expanded.has(pairKey) ? options.expanded.get(pairKey) : index === 0;
    root.append(h('details', {
      class: 'migration-backend-review', open: expanded,
      ontoggle: (event) => options.expanded.set(pairKey, event.target.open),
    }, h('summary', {}, h('strong', {}, backend.backendId), ` · ${backend.backendType} · ${migrationQuantity(backend.models.length, 'new model')}`), body));
  }
  const notImported = [
    ...review.sourceIssues.map((entry) => `${entry.file}: ${entry.message}`),
    ...review.unpairedSources.map((entry) => `${entry.backendId} · ${fileName(entry.file)}: ${entry.issue} (${entry.status})`),
  ];
  if (notImported.length) root.append(details(`Old backend inputs not imported (${notImported.length})`,
    h('ul', {}, notImported.map((entry) => h('li', {}, safeLabel(entry)))), `${row.id}:not-imported`, options));
  return root;
}
