/**
 * Hover/focus explanations.
 *
 * A configuration file's documentation is reference material: you need it the
 * first time you meet a parameter and almost never again. Printing it under
 * every row costs the vertical space that makes ninety-seven parameters
 * readable as a table, so the prose moves into a popover attached to the thing
 * it describes -- the parameter name, the field label, the object key.
 *
 * There is exactly one popover element for the whole page. Attaching an
 * explanation to a trigger does not create a node; it registers the trigger and
 * borrows the shared panel on demand. With ~250 documented fields on screen
 * that difference is the difference between a live UI and a slow one.
 *
 * Hover alone would make the documentation unreachable by keyboard and on
 * touch, so the trigger is focusable and opens on focus as well. Pointer opens
 * are delayed slightly so that sweeping the mouse across a table does not
 * strobe; keyboard opens are immediate, because focus is deliberate.
 */

const OPEN_DELAY = 140;
const CLOSE_DELAY = 90;
const GAP = 8;
const EDGE = 12;

let panel = null;
let body = null;
let current = null;
let openTimer = 0;
let closeTimer = 0;
let seq = 0;

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement('div');
  panel.className = 'explain';
  panel.setAttribute('role', 'tooltip');
  panel.id = 'explain-panel';
  body = document.createElement('div');
  body.className = 'explain-body';
  panel.appendChild(body);

  // Keep the panel alive while the pointer is inside it, so an explanation
  // containing a link or a long line can actually be read and selected.
  panel.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  panel.addEventListener('mouseleave', () => scheduleClose());

  document.body.appendChild(panel);
  return panel;
}

/**
 * Places the panel under the trigger, flipping above when it would overflow the
 * viewport bottom and clamping horizontally. Measured after the content is in
 * place, because the height depends on the text.
 */
function place(trigger) {
  const rect = trigger.getBoundingClientRect();
  const size = panel.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  let top = rect.bottom + GAP;
  if (top + size.height > vh - EDGE) {
    const above = rect.top - GAP - size.height;
    top = above >= EDGE ? above : Math.max(EDGE, vh - EDGE - size.height);
  }

  let left = rect.left;
  if (left + size.width > vw - EDGE) left = vw - EDGE - size.width;
  if (left < EDGE) left = EDGE;

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function show(trigger) {
  const render = trigger.__explain;
  if (!render) return;

  ensurePanel();
  clearTimeout(closeTimer);

  if (current && current !== trigger) current.removeAttribute('aria-describedby');
  current = trigger;

  body.replaceChildren();
  const content = render();
  if (content) body.append(...(Array.isArray(content) ? content : [content]));

  // Position from a clean slate: a stale left/top from the previous trigger
  // would let the panel measure against the wrong edge and mis-flip.
  panel.style.left = '0px';
  panel.style.top = '0px';
  panel.classList.add('explain-open');
  place(trigger);

  trigger.setAttribute('aria-describedby', panel.id);
}

function hide() {
  clearTimeout(openTimer);
  if (!panel) return;
  panel.classList.remove('explain-open');
  if (current) current.removeAttribute('aria-describedby');
  current = null;
}

function scheduleOpen(trigger, delay) {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  if (delay === 0) {
    show(trigger);
    return;
  }
  openTimer = setTimeout(() => show(trigger), delay);
}

function scheduleClose() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  closeTimer = setTimeout(hide, CLOSE_DELAY);
}

/**
 * Marks `el` as carrying an explanation. `render` is called lazily each time
 * the popover opens and returns a node or array of nodes -- deferring it keeps
 * the cost of a screenful of triggers to a few attributes.
 *
 * Returns `el` so it composes inside an `h(...)` call.
 */
export function explains(el, render) {
  if (!el || typeof render !== 'function') return el;

  el.__explain = render;
  el.classList.add('explain-trigger');
  if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  if (!el.id) el.id = `xt-${++seq}`;

  el.addEventListener('mouseenter', () => scheduleOpen(el, OPEN_DELAY));
  el.addEventListener('mouseleave', scheduleClose);
  el.addEventListener('focus', () => scheduleOpen(el, 0));
  el.addEventListener('blur', hide);

  return el;
}

/** True when there is anything worth explaining, so callers can skip the marker. */
export function hasExplanation(...parts) {
  return parts.some((p) => (Array.isArray(p) ? p.length > 0 : Boolean(p)));
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !current) return;
    // Only swallow the key when a popover is actually open, so Escape keeps
    // working for the pickers and dialogs elsewhere in the app.
    e.stopPropagation();
    const trigger = current;
    hide();
    trigger.blur();
  });

  // A re-render can replace the trigger node while its popover is open, which
  // would otherwise leave the panel floating beside nothing.
  window.addEventListener(
    'scroll',
    () => {
      if (!current) return;
      if (current.isConnected) place(current);
      else hide();
    },
    true
  );
  window.addEventListener('resize', hide);
}
