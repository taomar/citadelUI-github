/**
 * The smallest DOM that `dialog.mjs` and `dom.mjs` need.
 *
 * Enough to exercise the dialog stack for real — showing, dismissing, refusing
 * a dismissal — without pulling in a browser. Anything the modules do not touch
 * is deliberately absent, so a test that starts depending on more of the DOM
 * fails loudly rather than passing against a fiction.
 */
class StubNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.parentElement = null;
    this.open = false;
    this.inert = false;
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.value = '';
    this.focused = false;
    this.selectionStart = ['INPUT', 'TEXTAREA'].includes(this.tagName) ? 0 : null;
    this.selectionEnd = this.selectionStart;
    this.selectionDirection = 'none';
    const owner = this;
    this.classList = {
      add(...names) {
        const set = new Set(owner.className.split(/\s+/).filter(Boolean));
        for (const name of names) set.add(name);
        owner.className = [...set].join(' ');
      },
      remove(...names) {
        const set = new Set(owner.className.split(/\s+/).filter(Boolean));
        for (const name of names) set.delete(name);
        owner.className = [...set].join(' ');
      },
      contains(name) {
        return owner.className.split(/\s+/).filter(Boolean).includes(name);
      },
      toggle(name, force) {
        const on = force === undefined ? !this.contains(name) : Boolean(force);
        if (on) this.add(name);
        else this.remove(name);
        return on;
      },
    };
  }

  append(...nodes) {
    for (const node of nodes) {
      // A browser moves an existing node; it cannot belong to two forms.
      if (node.parentElement) {
        const siblings = node.parentElement.children;
        siblings.splice(siblings.indexOf(node), 1);
      }
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    if (this.contains(globalThis.document?.activeElement)) globalThis.document.activeElement = document.body;
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._textContent = '';
    this.append(...nodes);
  }

  get textContent() { return this._textContent; }
  set textContent(value) {
    if (this.contains(globalThis.document?.activeElement)) globalThis.document.activeElement = document.body;
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._textContent = String(value);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (['disabled', 'hidden', 'checked'].includes(name)) this[name] = true;
    if (name === 'type' && this.tagName === 'INPUT' && !['text', 'search', 'password'].includes(value)) {
      this.selectionStart = this.selectionEnd = null;
    }
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (['disabled', 'hidden', 'checked'].includes(name)) this[name] = false;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  addEventListener(type, handler, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    if (options === true || options?.capture) this.listeners.get(type).unshift(handler);
    else this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((listener) => listener !== handler));
  }

  /** Deliver an event the way the dialog's own listeners expect. */
  dispatch(type, event = {}) {
    const payload = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      stopImmediatePropagation() { this.immediatePropagationStopped = true; },
      ...event,
    };
    for (const handler of this.listeners.get(type) || []) {
      handler(payload);
      if (payload.immediatePropagationStopped) break;
    }
    return payload;
  }

  dispatchEvent(event) {
    return !this.dispatch(event.type, {
      key: event.key, shiftKey: event.shiftKey, isComposing: event.isComposing, isTrusted: event.isTrusted,
    }).defaultPrevented;
  }

  click() {
    if (!this.disabled) this.dispatch('click');
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const visit = (node) => (node.children || []).flatMap((child) =>
      [...(child.matches(selector) ? [child] : []), ...visit(child)]);
    return visit(this);
  }

  matches(selector) {
    return selector.split(',').some((part) => {
      const value = part.trim();
      if (/^[a-z]+$/i.test(value)) return this.tagName === value.toUpperCase();
      if (value === '[data-editor-focus]') return this.dataset.editorFocus !== undefined;
      if (value === '[inert]') return this.inert;
      if (value === '.mp-item:not(:disabled)') return this.classList.contains('mp-item') && !this.disabled;
      if (/^\.[\w-]+$/.test(value)) return this.classList.contains(value.slice(1));
      return false;
    });
  }

  closest(selector) {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
  }

  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }

  get isConnected() {
    return this === globalThis.document?.body || Boolean(this.parentElement?.isConnected);
  }

  get childElementCount() { return this.children.length; }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get type() { return this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : ''); }
  set type(value) { this.setAttribute('type', value); }

  appendChild(node) { this.append(node); return node; }

  remove() {
    if (!this.parentElement) return;
    if (this.contains(globalThis.document?.activeElement)) document.activeElement = document.body;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  getClientRects() {
    return this.hidden ? [] : [this.getBoundingClientRect()];
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 100 };
  }

  focus(options = {}) {
    if (this.disabled) return;
    this.focused = true;
    this.focusOptions = options;
    if (globalThis.document) globalThis.document.activeElement = this;
    this.dispatch('focus');
  }

  setSelectionRange(start, end, direction = 'none') {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatch('close');
  }
}

/**
 * Install the stub globals without loading `dialog.mjs`.
 *
 * Panels build their own trees through `document.createElement`, so they need
 * the same minimal DOM but not the dialog stack.
 */
export function installDom() {
  const root = new StubNode('body');
  const modal = new StubNode('dialog');
  modal.id = 'modal';
  root.append(modal);

  globalThis.Node = StubNode;
  globalThis.Element = StubNode;
  globalThis.document = {
    activeElement: null,
    body: root,
    documentElement: { clientWidth: 1440, clientHeight: 1000 },
    getElementById: (id) => {
      const find = (node) => node.id === id ? node : node.children.map(find).find(Boolean);
      return find(root) || null;
    },
    createElement: (tag) => new StubNode(tag),
    createTextNode: (text) => {
      const node = new StubNode('#text');
      node.textContent = String(text);
      return node;
    },
    querySelector: () => null,
    addEventListener: (...args) => root.addEventListener(...args),
    removeEventListener: (...args) => root.removeEventListener(...args),
  };
  globalThis.requestAnimationFrame = (callback) => callback();
  return { root, modal, node: (tag = 'div') => new StubNode(tag) };
}

/** Every text node under `node`, joined — what the user would read. */
export function readText(node) {
  if (!node) return '';
  const own = node.textContent || '';
  const nested = (node.children || []).map((child) => readText(child)).join('');
  return `${own}${nested}`;
}

/**
 * Install the stub globals and return the dialog host.
 *
 * `dialog.mjs` holds module-level state, so each caller gets a fresh copy via a
 * cache-busting import rather than sharing one stack across tests.
 */
export async function loadDialogModule() {
  const { root, modal } = installDom();

  const module = await import(`../web/js/dialog.mjs?stub=${Math.random()}`);
  return { ...module, modal, root, node: (tag = 'div') => new StubNode(tag) };
}
