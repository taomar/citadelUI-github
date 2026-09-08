/** Stable addresses for controls rebuilt by the ordinary parameter editor. */
export function editorField(node, path) {
  const controls = ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)
    ? [node] : [...node.querySelectorAll('input, select, textarea')];
  for (const [index, control] of controls.entries()) {
    control.dataset.editorFocus = JSON.stringify([path, index]);
    const initial = control.value;
    if (control.tagName !== 'TEXTAREA' &&
      (control.tagName !== 'INPUT' || !['text', 'password', 'number'].includes(control.type))) continue;
    if (control.getAttribute('role') === 'combobox') continue;
    let tabCommit = false;
    control.addEventListener('change', (event) => {
      // Chromium may emit a native change again while the first commit removes
      // this edited node. That reentrant notification is the same edit.
      if (tabCommit && event.isTrusted) event.stopImmediatePropagation();
    }, true);
    control.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing || control.disabled ||
        control.readOnly || control.value === initial) return;
      // Commit before native Tab starts blurring. Rendering during that blur
      // destroys both the old field and the browser's intended next control.
      tabCommit = true;
      try {
        control.dispatchEvent(new Event('change', { bubbles: true }));
      } finally {
        tabCommit = false;
      }
    });
  }
  return node;
}

export function preserveEditorFocus(root, render) {
  const active = document.activeElement;
  const key = root?.contains(active) ? active.dataset.editorFocus : null;
  const selection = key && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  const result = render();
  if (!key || active.isConnected ||
    (document.activeElement !== document.body && document.activeElement !== active)) return result;
  const replacement = [...root.querySelectorAll('[data-editor-focus]')]
    .find((control) => control.dataset.editorFocus === key);
  if (!replacement || replacement.disabled || replacement.closest('[inert]') ||
    !replacement.getClientRects().length) return result;
  replacement.focus({ preventScroll: true });
  if (selection && typeof replacement.selectionStart === 'number') replacement.setSelectionRange(...selection);
  return result;
}
