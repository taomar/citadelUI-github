/** One recipe navigator, restyled as a rail, drawer, or full-height picker. */

import { el, replace } from './dom.mjs';

const STATE_TONES = Object.freeze({
  ready: 'success',
  complete: 'success',
  blocked: 'warning',
  missing: 'warning',
  'needs-input': 'warning',
  unknown: 'neutral',
  pending: 'neutral',
  'not-checked': 'neutral',
});

function statusDescriptor(value, fallback) {
  if (typeof value === 'string') {
    return { state: value, label: value.replaceAll('-', ' ') };
  }
  if (value && typeof value === 'object') {
    return {
      state: String(value.state ?? fallback.state),
      label: String(value.label ?? fallback.label),
    };
  }
  return fallback;
}

function readinessFor(sample) {
  if (sample.ready === true) return { state: 'ready', label: 'Inputs ready' };
  if (Number(sample.blockingCount) > 0) {
    const count = Number(sample.blockingCount);
    return { state: 'needs-input', label: `${count} input${count === 1 ? '' : 's'} needed` };
  }
  return statusDescriptor(sample.readiness, { state: 'not-checked', label: 'Readiness not checked' });
}

export function directoryDependencyStatus(sample) {
  const readiness = sample.readiness && typeof sample.readiness === 'object'
    ? sample.readiness
    : {};
  const missing = Array.isArray(readiness.dependencies)
    ? readiness.dependencies.filter((dependency) =>
        dependency
        && typeof dependency === 'object'
        && dependency.available === false
        && dependency.optional !== true)
    : [];
  if (readiness.dependencyReady === false) {
    return {
      state: 'missing',
      label: missing.length > 0
        ? `${missing.length} dependenc${missing.length === 1 ? 'y' : 'ies'} missing`
        : 'Dependency missing',
    };
  }
  if (readiness.dependencyReady === true) return { state: 'ready', label: 'Dependencies ready' };
  return statusDescriptor(readiness.dependencies, {
    state: 'not-checked',
    label: 'Dependencies not checked',
  });
}

function statusChip(descriptor, className) {
  const tone = STATE_TONES[descriptor.state] ?? 'neutral';
  return el('span', {
    class: `recipe-state ${className}`,
    'data-state': descriptor.state,
    'data-tone': tone,
    text: descriptor.label,
  });
}

function renderSample(sample, onSelect) {
  const readiness = readinessFor(sample);
  const dependencies = directoryDependencyStatus(sample);
  const recommendedNext = sample.recommendedNext === true || sample.recommended === true;

  return el('li', { class: 'recipe-directory-entry' }, [
    el(
      'button',
      {
        type: 'button',
        class: 'recipe-directory-item',
        'aria-current': sample.selected ? 'page' : undefined,
        'data-recipe-id': sample.id,
        'data-readiness': readiness.state,
        'data-dependencies': dependencies.state,
        'data-recommended-next': recommendedNext ? 'true' : 'false',
        disabled: sample.disabled === true,
        onclick: () => onSelect?.(sample.id),
      },
      [
        el('span', { class: 'recipe-directory-title', text: sample.title }),
        el('span', { class: 'recipe-directory-states' }, [
          recommendedNext
            ? el('span', {
                class: 'recipe-state recipe-state-recommended',
                'data-tone': 'brand',
                text: 'Recommended next',
              })
            : null,
          statusChip(readiness, 'recipe-state-readiness'),
          dependencies.state === 'missing'
            ? statusChip(dependencies, 'recipe-state-dependencies')
            : null,
        ]),
        el('span', { class: 'recipe-directory-meta' }, [
          sample.risk?.label
            ? el('span', {
                class: 'recipe-risk',
                'data-risk': sample.riskLevel ?? 'unknown',
                text: sample.risk.label,
              })
            : null,
        ]),
      ],
    ),
  ]);
}

function renderLegacyDirectory({ container, countNode, model, onSelect }) {
  countNode.textContent = model.total === model.catalogueTotal
    ? `${model.total}`
    : `${model.total}/${model.catalogueTotal}`;
  if (model.empty) {
    replace(container, [
      el('p', {
        class: 'empty',
        text: `No recipe matches "${model.query}". Clear the search to see all ${model.catalogueTotal}.`,
      }),
    ]);
    return container;
  }
  replace(
    container,
    model.groups.map((group) =>
      el('section', { class: 'dir-group' }, [
        el('h3', { class: 'dir-group-head' }, [
          group.title,
          el('span', { class: 'dir-group-count', text: String(group.count) }),
        ]),
        el(
          'ul',
          {},
          group.samples.map((sample) =>
            el('li', {}, [
              el('button', {
                type: 'button',
                class: 'dir-item',
                'aria-current': sample.selected ? 'true' : 'false',
                'data-sample': sample.id,
                onclick: () => onSelect?.(sample.id),
              }, [
                el('span', { class: 'dir-item-name', text: sample.title }),
                el('span', { class: 'dir-item-meta' }, [
                  el('span', {
                    class: 'dir-item-dot',
                    'data-risk': sample.riskLevel,
                    title: sample.risk.label,
                    'aria-hidden': 'true',
                  }),
                  el('span', { text: sample.risk.label }),
                  sample.cells.length
                    ? el('span', { translate: 'no', text: `cell ${sample.cells.join(', ')}` })
                    : null,
                ]),
              ]),
            ]),
          ),
        ),
      ]),
    ),
  );
  return container;
}

export function renderDirectory({
  container,
  countNode,
  model = {},
  onSelect,
  onQuery,
  onClose,
} = {}) {
  if (!container) throw new TypeError('A recipe directory container is required.');
  if (countNode) return renderLegacyDirectory({ container, countNode, model, onSelect });

  const ownerDocument = container.ownerDocument ?? globalThis.document;
  const priorSearch = ownerDocument?.activeElement?.id === 'recipe-directory-search'
    && container.contains(ownerDocument.activeElement)
    ? ownerDocument.activeElement
    : null;
  const priorSelection = priorSearch && typeof priorSearch.selectionStart === 'number'
    ? { start: priorSearch.selectionStart, end: priorSearch.selectionEnd }
    : null;
  const groups = Array.isArray(model.groups) ? model.groups : [];
  const total = Number.isFinite(model.total)
    ? model.total
    : groups.reduce((count, group) => count + (group.samples?.length ?? 0), 0);
  const catalogueTotal = Number.isFinite(model.catalogueTotal) ? model.catalogueTotal : total;
  const countLabel = total === catalogueTotal ? `${total}` : `${total}/${catalogueTotal}`;
  const headingId = 'recipe-directory-heading';
  const searchId = 'recipe-directory-search';

  container.setAttribute('aria-labelledby', headingId);
  replace(container, [
    el('div', { class: 'recipe-directory-header' }, [
      el('div', { class: 'recipe-directory-heading' }, [
        el('h2', { id: headingId, text: model.title ?? 'Recipes' }),
        el('span', {
          class: 'recipe-directory-count',
          'aria-label': `${total} of ${catalogueTotal} recipes shown`,
          text: countLabel,
        }),
      ]),
      el('button', {
        type: 'button',
        class: 'recipe-directory-close',
        'aria-label': 'Close recipe picker',
        text: 'Close',
        onclick: () => onClose?.(),
      }),
    ]),
    el('div', { class: 'recipe-directory-search' }, [
      el('label', {
        class: 'visually-hidden',
        for: searchId,
        text: 'Search recipes by name, group, risk, or notebook cell',
      }),
      el('input', {
        id: searchId,
        name: 'recipe-search',
        type: 'search',
        class: 'recipe-directory-search-input',
        value: model.query ?? '',
        placeholder: 'Search recipes…',
        autocomplete: 'off',
        spellcheck: 'false',
        oninput: (event) => onQuery?.(event.currentTarget.value),
      }),
    ]),
    model.empty || groups.length === 0
      ? el('p', {
          class: 'recipe-directory-empty',
          text: `No recipe matches "${model.query ?? ''}".`,
        })
      : el(
          'div',
          { class: 'recipe-directory-groups' },
          groups.map((group) => {
            const groupHeadingId = `recipe-group-${String(group.id).replace(/[^a-zA-Z0-9-]/g, '-')}`;
            return el('section', {
              class: 'recipe-directory-group',
              'aria-labelledby': groupHeadingId,
            }, [
              el('div', { class: 'recipe-directory-group-heading' }, [
                el('h3', { id: groupHeadingId, text: group.title }),
                el('span', {
                  class: 'recipe-directory-group-count',
                  'aria-label': `${group.samples?.length ?? 0} recipes`,
                  text: String(group.samples?.length ?? 0),
                }),
              ]),
              group.summary
                ? el('p', { class: 'recipe-directory-group-summary', text: group.summary })
                : null,
              el(
                'ul',
                { class: 'recipe-directory-list' },
                (group.samples ?? []).map((sample) => renderSample(sample, onSelect)),
              ),
            ]);
          }),
        ),
  ]);

  if (priorSearch) {
    const nextSearch = container.querySelector(`#${searchId}`);
    nextSearch?.focus();
    if (nextSearch && priorSelection) {
      nextSearch.setSelectionRange(priorSelection.start, priorSelection.end);
    }
  }

  return container;
}

/**
 * Compatibility seam for the current bootstrap. The dossier shell never calls
 * this helper; the parent integration can remove it with the old narrow markup.
 */
export function renderSampleSelect({ select, model, selectedId, onSelect }) {
  replace(
    select,
    (model.groups ?? []).map((group) =>
      el(
        'optgroup',
        { label: group.title },
        (group.samples ?? []).map((sample) =>
          el('option', {
            value: sample.id,
            selected: sample.id === selectedId,
            text: sample.title,
          }),
        ),
      ),
    ),
  );
  select.onchange = (event) => onSelect?.(event.target.value);
}
