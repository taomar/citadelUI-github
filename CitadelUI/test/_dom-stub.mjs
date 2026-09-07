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
    this.className = '';
    this.textContent = '';
    this.parentElement = null;
    this.open = false;
    this.inert = false;
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.focused = false;
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
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  /** Deliver an event the way the dialog's own listeners expect. */
  dispatch(type, event = {}) {
    const payload = {
      type,
      target: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    for (const handler of this.listeners.get(type) || []) handler(payload);
    return payload;
  }

  click() {
    if (!this.disabled) this.dispatch('click');
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 100 };
  }

  focus() {
    this.focused = true;
    if (globalThis.document) globalThis.document.activeElement = this;
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
  root.append(modal);

  globalThis.Node = StubNode;
  globalThis.Element = StubNode;
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => (id === 'modal' ? modal : null),
    createElement: (tag) => new StubNode(tag),
    createTextNode: (text) => {
      const node = new StubNode('#text');
      node.textContent = String(text);
      return node;
    },
    querySelector: () => null,
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
