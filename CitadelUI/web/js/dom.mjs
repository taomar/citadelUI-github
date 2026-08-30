/** Minimal hyperscript helper — keeps the UI declarative without a framework. */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') el.innerHTML = value;
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  // Atomic, because a re-render triggered from a change handler can fire blur
  // on a child mid-loop; a stepwise removeChild then throws NotFoundError when
  // the browser has already detached the node it is holding.
  el.replaceChildren();
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}
