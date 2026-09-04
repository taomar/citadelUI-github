/** Tiny DOM helpers. No framework, no dependencies. */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('Refusing to set innerHTML');
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'disabled') node.disabled = Boolean(value);
    else if (key === 'selected') node.selected = Boolean(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replace(node, children) {
  clear(node);
  append(node, children);
  return node;
}

export function chip(label, tone = 'neutral', { mono = false } = {}) {
  return el('span', { class: `chip chip-${tone}${mono ? ' chip-mono' : ''}`, text: label });
}

/** An external link: always new-tab, always safe rel. */
export function link(label, href) {
  return el('a', { href, target: '_blank', rel: 'noreferrer noopener', text: label });
}

export function linkList(links = []) {
  if (!links.length) return null;
  return el(
    'ul',
    { class: 'links' },
    links.map((entry) => el('li', {}, [link(entry.label, entry.href)])),
  );
}

export function bullets(items, { warn = false } = {}) {
  if (!items?.length) return null;
  return el(
    'ul',
    { class: `bullets${warn ? ' bullets-warn' : ''}` },
    items.map((item) => el('li', { text: item })),
  );
}

export function facts(rows) {
  const list = el('dl', { class: 'facts' });
  for (const [label, value, options = {}] of rows) {
    if (value === undefined || value === null || value === '') continue;
    list.appendChild(el('dt', { text: label }));
    list.appendChild(
      el('dd', {}, [
        options.mono
          ? el('code', { class: options.external ? 'mono value-external' : 'mono', text: String(value) })
          : String(value),
      ]),
    );
  }
  return list;
}

export function section(title, children, { note = '' } = {}) {
  return el('section', { class: 'sec' }, [
    el('div', { class: 'sec-head' }, [
      el('h2', { class: 'sec-title', text: title }),
      note ? el('span', { class: 'sec-note', text: note }) : null,
    ]),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

export function disclosure(summaryText, children, { open = false } = {}) {
  return el('details', { class: 'disc', open: open || undefined }, [
    el('summary', { text: summaryText }),
    el('div', { class: 'disc-body' }, children),
  ]);
}
