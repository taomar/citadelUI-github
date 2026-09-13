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
  const shownAt = sequence;
  requestAnimationFrame(() => {
    if (sequence !== shownAt || !host().open || stack.at(-1) !== frame) return;
    const target = [frame.initialFocus, frame.body.querySelector('[autofocus]'),
      frame.heading, host().querySelector('.modal-close')]
      .find((node) => node instanceof Element && node.isConnected && !node.disabled &&
        !node.closest('[inert]') && node.getClientRects().length);
    target?.focus({ preventScroll: true });
  });
}

function renderFrame(frame) {
  const dialog = host();
  frame.heading = h('h2', { id: frame.titleId, tabindex: '-1' }, frame.title);
  frame.scroller = h('div', { class: 'modal-body' }, frame.status, frame.body);
  mount(
    dialog,
    h(
      'header',
      { class: 'modal-head' },
      frame.heading,
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
    frame.scroller,
    h('footer', { class: 'modal-foot' }, frame.actions)
  );
  frame.scroller.scrollTop = frame.scrollTop;
  dialog.setAttribute('aria-labelledby', frame.titleId);
  focusFrame(frame);
}

function closeHost(restore = true) {
  const dialog = host();
  const closedAt = sequence;
  const target = restore ? restoreFocus : null;
  stack = [];
  restoreFocus = null;
  setBackgroundInert(false);
  if (dialog.open) dialog.close();
  else dialog.replaceChildren();
  requestAnimationFrame(() => {
    if (sequence !== closedAt || dialog.open || !restore) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== target && !dialog.contains(active) &&
        active.isConnected && !active.disabled && !active.closest('[inert]') && active.getClientRects().length) return;
    const replacement = target?.id ? document.getElementById(target.id)
      : target?.dataset.shellFocus ? [...document.body.querySelectorAll('[data-shell-focus]')]
        .find((node) => node.dataset.shellFocus === target.dataset.shellFocus)
        : target?.dataset.editorFocus ? [...document.body.querySelectorAll('[data-editor-focus]')]
          .find((node) => node.dataset.editorFocus === target.dataset.editorFocus) : null;
    const destination = target?.isConnected && target !== document.body && !target.disabled ? target
      : replacement && !replacement.disabled ? replacement : document.getElementById('workspace');
    if (destination?.isConnected) destination.focus({ preventScroll: true });
  });
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
    // Native close events are queued; a successor may already own this host.
    if (!dialog.open) dialog.replaceChildren();
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
  const previous = stack.at(-1);
  if (previous?.scroller) previous.scrollTop = previous.scroller.scrollTop;
  const frame = {
    title,
    body,
    status: h('p', {
      class: 'modal-status hint', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', hidden: true,
    }),
    actions: actions.filter(Boolean),
    initialFocus: options.initialFocus || null,
    onDismiss: options.onDismiss || null,
    // A frame may refuse to be dismissed while an operation it started is still
    // in flight. Without this, Escape or the backdrop would resolve the dialog
    // as cancelled while the work it launched carried on.
    preventDismiss: options.preventDismiss || null,
    opener: options.returnFocus instanceof Element ? options.returnFocus : document.activeElement,
    titleId: `modal-title-${++sequence}`,
    scrollTop: 0,
  };
  if (!dialog.open) {
    restoreFocus = options.returnFocus instanceof Element ? options.returnFocus : document.activeElement;
    stack = [frame];
    setBackgroundInert(true);
    dialog.showModal();
  } else if (options.stack) {
    stack.push(frame);
  } else if (options.replaceTop) {
    frame.opener = stack.at(-1).opener;
    stack[stack.length - 1] = frame;
  } else {
    stack = [frame];
  }
  renderFrame(frame);
}

/** Keep asynchronous feedback with its original frame, not a successor modal. */
export function captureDialogStatus() {
  const frame = stack.at(-1);
  const announce = (message, tone = 'info') => {
    if (!frame || !stack.includes(frame) || !host().open) return false;
    frame.status.className = `modal-status ${tone === 'error' ? 'field-error' : 'hint'}`;
    frame.status.hidden = !message;
    frame.status.textContent = message || '';
    return true;
  };
  announce.isCurrent = () => Boolean(frame && stack.at(-1) === frame && host().open);
  announce.close = () => {
    if (!announce.isCurrent()) return false;
    closeHost();
    return true;
  };
  return announce;
}

export function dismissDialog(result) {
  // Checked before the frame is popped: a refused dismissal must leave the
  // dialog exactly as it was, still owning the stack, and must not report itself
  // as cancelled.
  const current = stack.at(-1);
  if (current?.preventDismiss?.() || current?.actions.some((action) => action.getAttribute('aria-busy') === 'true')) {
    current.status.hidden = false;
    current.status.textContent = 'This action is still running. Wait for its outcome before closing.';
    return false;
  }
  const dismissedAt = sequence;
  const frame = stack.pop();
  const previous = stack.at(-1);
  frame?.onDismiss?.(result);
  // A dismissal callback can synchronously transfer ownership to a new frame.
  if (sequence !== dismissedAt || stack.at(-1) !== previous) return true;
  if (!stack.length) {
    closeHost();
    return true;
  }
  renderFrame(previous);
  requestAnimationFrame(() => {
    if (sequence === dismissedAt && host().open && stack.at(-1) === previous && frame?.opener?.isConnected) frame.opener.focus({ preventScroll: true });
  });
  return true;
}

export function closeDialog({ restoreFocus = true } = {}) {
  closeHost(restoreFocus);
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
