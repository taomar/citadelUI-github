/** Pause the predecessor's real controls without changing its edit buffers. */
export function pauseEditorForLoad(roots, notice, message) {
  const originalRoots = roots.filter(Boolean).map((root) => ({
    root, busy: root.getAttribute('aria-busy'),
  }));
  const controls = new Map();
  let released = false;
  function refresh() {
    if (released) return;
    for (const { root } of originalRoots) {
      root.setAttribute('aria-busy', 'true');
      for (const control of root.querySelectorAll('input, select, textarea, button')) {
        if (!controls.has(control)) controls.set(control, control.disabled);
        control.disabled = true;
      }
    }
  }
  notice.textContent = message;
  notice.hidden = false;
  refresh();
  return {
    refresh,
    release() {
      if (released) return;
      released = true;
      for (const [control, disabled] of controls) control.disabled = disabled;
      for (const { root, busy } of originalRoots) {
        if (busy === null) root.removeAttribute('aria-busy');
        else root.setAttribute('aria-busy', busy);
      }
      notice.hidden = true;
    },
  };
}
