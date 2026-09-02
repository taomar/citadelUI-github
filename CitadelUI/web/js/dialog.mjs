import { h, mount } from './dom.mjs';

let stack = [];
let restoreFocus = null;
let sequence = 0;
let listenersInstalled = false;

function host() {
  return document.getElementById('modal');
}

function setBackgroundInert(value) {
  const dialog = host();
  for (const sibling of dialog.parentElement?.children || []) {
    if (sibling === dialog) continue;
    sibling.inert = value;
  }
}

function focusFrame(frame) {
  requestAnimationFrame(() => {
    const target =
      (frame.initialFocus instanceof Element && frame.initialFocus) ||
      frame.body.querySelector('[autofocus], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ||
      frame.actions.at(-1) ||
      host().querySelector('.modal-close');
    target?.focus();
  });
}

function renderFrame(frame) {
  const dialog = host();
  mount(
    dialog,
    h(
      'header',
      { class: 'modal-head' },
      h('h2', { id: frame.titleId }, frame.title),
      h(
        'button',
        {
          class: 'btn btn-ghost modal-close',
          type: 'button',
          'aria-label': `Close ${frame.title}`,
          onclick: () => dismissDialog(),
        },
        '\u2715'
      )
    ),
    h('div', { class: 'modal-body' }, frame.body),
    h('footer', { class: 'modal-foot' }, frame.actions)
  );
  dialog.setAttribute('aria-labelledby', frame.titleId);
  focusFrame(frame);
}

function closeHost() {
  const dialog = host();
  stack = [];
  setBackgroundInert(false);
  if (dialog.open) dialog.close();
  else dialog.replaceChildren();
  const target = restoreFocus;
  restoreFocus = null;
  requestAnimationFrame(() => target?.isConnected && target.focus());
}

function installListeners() {
  if (listenersInstalled) return;
  const dialog = host();
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismissDialog();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dismissDialog();
  });
  dialog.addEventListener('close', () => {
    dialog.replaceChildren();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!inside) dismissDialog();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const tabbable = [
      ...dialog.querySelectorAll(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      ),
    ].filter((element) => element.getClientRects().length);
    if (!tabbable.length) {
      event.preventDefault();
      return;
    }
    const first = tabbable[0];
    const last = tabbable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  listenersInstalled = true;
}

export function showDialog(title, body, actions = [], options = {}) {
  installListeners();
  const dialog = host();
  const frame = {
    title,
    body,
    actions: actions.filter(Boolean),
    initialFocus: options.initialFocus || null,
    onDismiss: options.onDismiss || null,
    // A frame may refuse to be dismissed while an operation it started is still
    // in flight. Without this, Escape or the backdrop would resolve the dialog
    // as cancelled while the work it launched carried on.
    preventDismiss: options.preventDismiss || null,
    opener: document.activeElement,
    titleId: `modal-title-${++sequence}`,
  };
  if (!dialog.open) {
    restoreFocus = document.activeElement;
    stack = [frame];
    setBackgroundInert(true);
    dialog.showModal();
  } else if (options.stack) {
    stack.push(frame);
  } else {
    stack = [frame];
  }
  renderFrame(frame);
}

export function dismissDialog(result) {
  // Checked before the frame is popped: a refused dismissal must leave the
  // dialog exactly as it was, still owning the stack, and must not report itself
  // as cancelled.
  const current = stack.at(-1);
  if (current?.preventDismiss?.()) return false;
  const frame = stack.pop();
  frame?.onDismiss?.(result);
  if (!stack.length) {
    closeHost();
    return true;
  }
  const previous = stack.at(-1);
  renderFrame(previous);
  requestAnimationFrame(() => frame?.opener?.isConnected && frame.opener.focus());
  return true;
}

export function closeDialog() {
  closeHost();
}

export function confirmDialog({
  title,
  message,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  tone = 'default',
  context = null,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dismissDialog(value);
    };
    showDialog(
      title,
      h(
        'div',
        { class: 'dialog-message' },
        context,
        h('p', {}, message)
      ),
      [
        h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, cancelLabel),
        h(
          'button',
          {
            class: tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary',
            type: 'button',
            onclick: () => finish(true),
          },
          confirmLabel
        ),
      ],
      {
        stack: true,
        onDismiss: () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        },
      }
    );
  });
}

export function choiceDialog({
  title,
  message,
  choices,
  context = null,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dismissDialog(value);
    };
    showDialog(
      title,
      h(
        'div',
        { class: 'dialog-message' },
        context,
        h('p', {}, message)
      ),
      choices.map((choice) =>
        h(
          'button',
          {
            class:
              choice.tone === 'danger'
                ? 'btn btn-danger'
                : choice.primary
                  ? 'btn btn-primary'
                  : 'btn',
            type: 'button',
            onclick: () => finish(choice.value),
          },
          choice.label
        )
      ),
      {
        stack: true,
        onDismiss: () => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        },
      }
    );
  });
}

export function promptDialog({
  title,
  description = '',
  fields,
  submitLabel = 'Save',
  cancelLabel = 'Cancel',
  context = null,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const controls = new Map();
    const formId = `dialog-form-${++sequence}`;
    const form = h(
      'form',
      {
        id: formId,
        class: 'dialog-form',
        onsubmit: (event) => {
          event.preventDefault();
          const values = Object.fromEntries(
            [...controls].map(([name, control]) => [name, control.value])
          );
          settled = true;
          resolve(values);
          dismissDialog(values);
        },
      },
      context,
      description ? h('p', { class: 'hint' }, description) : null,
      fields.map((field, index) => {
        const id = `${formId}-${field.name}`;
        const input = h('input', {
          id,
          name: field.name,
          class: 'ctl',
          type: field.type || 'text',
          value: field.value || '',
          placeholder: field.placeholder || '',
          required: field.required !== false,
          autocomplete: field.autocomplete || 'off',
          autofocus: index === 0,
        });
        controls.set(field.name, input);
        return h(
          'label',
          { class: 'dialog-field', for: id },
          h('span', {}, field.label),
          input,
          field.hint ? h('small', { class: 'hint' }, field.hint) : null
        );
      })
    );
    const submitButton = h(
      'button',
      { class: 'btn btn-primary', type: 'submit' },
      submitLabel
    );
    submitButton.setAttribute('form', formId);
    showDialog(
      title,
      form,
      [
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              settled = true;
              resolve(null);
              dismissDialog(null);
            },
          },
          cancelLabel
        ),
        submitButton,
      ],
      {
        stack: true,
        initialFocus: controls.values().next().value,
        onDismiss: () => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        },
      }
    );
  });
}
