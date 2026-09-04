/** The recipe directory: grouped rail on the left, native selector when narrow. */

import { el, replace } from './dom.mjs';

export function renderDirectory({ container, countNode, model, onSelect }) {
  countNode.textContent = model.total === model.catalogueTotal ? `${model.total}` : `${model.total}/${model.catalogueTotal}`;

  if (model.empty) {
    replace(container, [
      el('p', { class: 'empty', text: `No recipe matches “${model.query}”. Clear the search to see all ${model.catalogueTotal}.` }),
    ]);
    return;
  }

  const groups = model.groups.map((group) =>
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
            el(
              'button',
              {
                type: 'button',
                class: 'dir-item',
                'aria-current': sample.selected ? 'true' : 'false',
                'data-sample': sample.id,
                onclick: () => onSelect(sample.id),
              },
              [
                el('span', { class: 'dir-item-name', text: sample.title }),
                el('span', { class: 'dir-item-meta' }, [
                  el('span', {
                    class: 'dir-item-dot',
                    'data-risk': sample.riskLevel,
                    title: sample.risk.label,
                    'aria-hidden': 'true',
                  }),
                  el('span', { text: sample.risk.label }),
                  sample.cells.length ? el('span', { text: `cell ${sample.cells.join(', ')}` }) : null,
                ]),
              ],
            ),
          ]),
        ),
      ),
    ]),
  );

  replace(container, groups);
}

export function renderSampleSelect({ select, model, selectedId, onSelect }) {
  replace(
    select,
    model.groups.map((group) =>
      el(
        'optgroup',
        { label: group.title },
        group.samples.map((sample) =>
          el('option', { value: sample.id, selected: sample.id === selectedId, text: sample.title }),
        ),
      ),
    ),
  );
  select.onchange = (event) => onSelect(event.target.value);
}
