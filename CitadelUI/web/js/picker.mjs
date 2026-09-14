/**
 * A list you can actually see.
 *
 * A native `<datalist>` looks like a dropdown but is not one: the arrow is
 * inconsistent across browsers, nothing opens until you type, and matching is
 * prefix-only. On a screen whose whole purpose is "which of these models can I
 * pick", that reads as an empty control.
 *
 * The panel is appended to `document.body` and positioned `fixed` rather than
 * absolutely inside its field. Every place this control is used sits inside at
 * least one clipping ancestor -- the backend card is `overflow: clip`, the
 * sheet scrolls, and the shell is `overflow: hidden` -- so an absolutely
 * positioned panel is cut off after a row or two. Escaping to the body is the
 * same approach the explanation popover already takes, for the same reason.
 */

import { h } from './dom.mjs';

const GAP = 4;
const EDGE = 12;
let pickerSequence = 0;
let activePicker = null;
let activeObserver = null;

function onOutsidePointer(event) {
  activePicker?.outside(event);
}

function onViewportChange() {
  activePicker?.follow();
}

function deactivate(instance) {
  if (activePicker !== instance) return;
  activePicker = null;
  document.removeEventListener('mousedown', onOutsidePointer);
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
  activeObserver?.disconnect();
}

function activate(instance) {
  if (activePicker === instance) return;
  activePicker?.close();
  activePicker = instance;
  document.addEventListener('mousedown', onOutsidePointer);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
  activeObserver ||= new MutationObserver(() => {
    if (activePicker && (!activePicker.input.isConnected || !activePicker.panel.isConnected)) {
      activePicker.close();
    }
  });
  activeObserver.observe(document.body, { childList: true, subtree: true });
}

export function filterPickerItems(items, query) {
  const q = String(query || '').trim().toLowerCase();
  return items.filter((item) => {
    const haystack = `${item.value} ${item.meta || ''}`.toLowerCase();
    return !q || haystack.includes(q);
  });
}

/**
 * @param options  candidate values, or `{ value, meta, group }` entries
 * @param onPick   called with the chosen string
 * @param props    `{ placeholder, ariaLabel, freeTextLabel, empty, groups }` where
 *                 `groups` is an array of `[key, label]` in display order
 */
export function picker(options, onPick, props = {}) {
  const items = options.map((o) => (typeof o === 'string' ? { value: o, meta: null } : o));
  const panelId = `picker-listbox-${++pickerSequence}`;
  let query = '';
  let preserveQueryOnFocus = false;

  const input = h('input', {
    class: 'ctl ctl-combo ctl-w-id',
    type: 'text',
    value: props.value || '',
    autocomplete: 'off',
    spellcheck: false,
    placeholder: props.placeholder || 'Search\u2026',
    'aria-label': props.ariaLabel || props.placeholder || 'Search options',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': panelId,
  });

  const panel = h('div', { class: 'mp-panel mp-portal', id: panelId, role: 'listbox' });
  const wrap = h('div', { class: 'mp' }, input);
  const lifecycle = {};
  const actions = new Set();
  const inAction = (target) => [...actions].some((action) => action.contains(target));

  const close = () => {
    deactivate(lifecycle);
    panel.classList.remove('mp-open');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    query = '';
    input.value = props.value || '';
    if (panel.isConnected) panel.remove();
  };

  const choose = (value) => {
    const name = String(value);
    if (!name && !props.allowEmpty) return;
    // Close before handing over: the caller re-renders synchronously, and a
    // panel left in the body would outlive the field that owns it.
    close();
    input.value = name;
    onPick(name);
  };

  const place = () => {
    const r = input.getBoundingClientRect();
    const vh = document.documentElement.clientHeight;
    const vw = document.documentElement.clientWidth;

    const panelWidth = Math.min(Math.max(r.width, 560), vw - EDGE * 2);
    panel.style.width = `${Math.round(panelWidth)}px`;
    panel.style.left = `${Math.round(Math.max(EDGE, Math.min(r.left, vw - EDGE - panelWidth)))}px`;

    // Prefer below, flip above when the space below cannot hold a useful list.
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    if (below < 180 && above > below) {
      panel.style.top = '';
      panel.style.bottom = `${Math.round(vh - r.top + GAP)}px`;
      panel.style.maxHeight = `${Math.round(Math.min(340, above))}px`;
    } else {
      panel.style.bottom = '';
      panel.style.top = `${Math.round(r.bottom + GAP)}px`;
      panel.style.maxHeight = `${Math.round(Math.min(340, Math.max(120, below)))}px`;
    }
  };

  const paint = () => {
    const q = query.trim().toLowerCase();
    const hits = filterPickerItems(items, query);
    panel.replaceChildren();

    const groups = props.groups || [];
    const placed = new Set();
    const emit = (list, label) => {
      if (!list.length) return;
      if (label) panel.append(h('div', { class: 'mp-group' }, label));
      for (const m of list) {
        placed.add(m);
        const optionId = `${panelId}-option-${items.indexOf(m)}`;
        panel.append(
          h(
            'button',
            {
              class: `mp-item${m.disabled ? ' mp-item-used' : ''}`,
              type: 'button',
              disabled: Boolean(m.disabled),
              onclick: () => choose(m.value),
              id: optionId,
              role: 'option',
              'aria-selected': String(String(m.value) === String(props.value || '')),
            },
            h('code', { class: 'mp-name' }, m.value),
            m.meta ? h('span', { class: 'mp-meta' }, m.meta) : null,
            m.usedLabel ? h('span', { class: 'mp-added' }, m.usedLabel) : null
          )
        );
      }
    };

    for (const [key, label] of groups) emit(hits.filter((m) => m.group === key), label);
    emit(
      hits.filter((m) => !placed.has(m)),
      groups.length ? 'Other' : null
    );

    const exact = items.some((m) => m.value.toLowerCase() === q);
    if (q && !exact && props.freeText !== false) {
      panel.append(
        h(
          'button',
          { class: 'mp-item mp-item-free', type: 'button', onclick: () => choose(input.value) },
          h('code', { class: 'mp-name' }, input.value.trim()),
          h('span', { class: 'mp-meta' }, props.freeTextLabel || 'use as typed')
        )
      );
    }

    if (!panel.childElementCount) {
      panel.append(
        h('p', { class: 'mp-empty' }, props.empty || 'No match. Type a value to use it anyway.')
      );
    }
  };

  const open = () => {
    activate(lifecycle);
    if (!panel.isConnected) document.body.appendChild(panel);
    paint();
    panel.classList.add('mp-open');
    input.setAttribute('aria-expanded', 'true');
    place();
  };

  input.addEventListener('focus', () => {
    if (!preserveQueryOnFocus) query = '';
    preserveQueryOnFocus = false;
    open();
  });
  input.addEventListener('click', () => {
    query = '';
    open();
  });
  input.addEventListener('input', () => {
    query = input.value;
    open();
  });
  if (props.commitOnBlur || props.freeText === false) {
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!input.isConnected) {
          close();
          return;
        }
        if (panel.contains(document.activeElement) || inAction(document.activeElement)) return;
        const exact = items.find((item) => String(item.value) === input.value);
        if (exact || props.freeText !== false) {
          if (String(input.value) === String(props.value || '')) close();
          else choose(input.value);
        } else {
          input.value = props.value || '';
          close();
        }
      }, 0);
    });
  }
  input.addEventListener('keydown', (e) => {
    const choices = () => Array.from(panel.querySelectorAll('.mp-item:not(:disabled)'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = choices();
      if (!rows.length) return;
      const active = rows.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown'
        ? (active + 1) % rows.length
        : (active <= 0 ? rows.length : active) - 1;
      rows[next].focus();
      input.setAttribute('aria-activedescendant', rows[next].id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const exact = items.find((item) => String(item.value) === input.value);
      if (exact || props.freeText !== false) choose(input.value);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  panel.addEventListener('keydown', (event) => {
    const rows = Array.from(panel.querySelectorAll('.mp-item:not(:disabled)'));
    const active = rows.indexOf(document.activeElement);
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      preserveQueryOnFocus = true;
      input.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!rows.length) return;
      const next = event.key === 'ArrowDown'
        ? (active + 1) % rows.length
        : (active <= 0 ? rows.length : active) - 1;
      rows[next].focus();
      input.setAttribute('aria-activedescendant', rows[next].id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      input.focus();
      close();
    }
  });
  panel.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!panel.isConnected) return;
      const active = document.activeElement;
      if (active === input || panel.contains(active) || inAction(active)) return;
      close();
    }, 0);
  });

  const follow = () => {
    if (!input.isConnected || !panel.isConnected) {
      close();
      return;
    }
    place();
  };
  const outside = (event) => {
    if (!wrap.contains(event.target) && !panel.contains(event.target) && !inAction(event.target)) close();
  };
  Object.assign(lifecycle, { input, panel, close, follow, outside });

  // Sibling actions belong to the picker until their click consumes the value.
  // A true outside mousedown still dismisses and restores the committed value.
  const action = (label, attributes = {}) => {
    const button = h('button', { ...attributes, type: 'button', onclick: () => choose(input.value) }, label);
    actions.add(button);
    return button;
  };

  return { el: wrap, input, choose: () => choose(input.value), action, items };
}
