import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { installDom } from './_dom-stub.mjs';
import { h } from '../web/js/dom.mjs';
import { decoratePolicy } from '../web/js/policynav.mjs';

const dom = installDom();
globalThis.HTMLElement = globalThis.Element;
let reduced, frames, observers;
globalThis.window = { matchMedia: () => ({ matches: reduced }) };
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
globalThis.IntersectionObserver = class {
  constructor(callback, options) {
    this.deliver = callback;
    this.options = options;
    this.targets = [];
    observers.push(this);
  }
  observe(target) { this.targets.push(target); }
};

beforeEach(() => {
  dom.root.replaceChildren(dom.modal);
  document.activeElement = document.body;
  reduced = false;
  frames = [];
  observers = [];
});

function policySheet({ height = 73, stored = 0 } = {}) {
  const sticky = h('div', { class: 'sheet-sticky' });
  let currentHeight = height;
  sticky.getBoundingClientRect = () => ({
    top: 121, bottom: 121 + currentHeight, height: currentHeight, left: 0, right: 1000, width: 1000,
  });
  const blocks = Array.from({ length: 9 }, (_, index) => {
    const title = dom.node('h3');
    const matches = title.matches.bind(title);
    title.matches = (selector) => selector.split(',').some((part) =>
      /^h[1-6]$/i.test(part.trim()) ? title.tagName === part.trim().toUpperCase() : matches(part));
    title.textContent = index ? `Block ${index}` : 'Scope';
    title.dataset.editorFocus = `policy:synthetic:block:${index}`;
    return h('div', { class: index ? 'pol-card' : 'pol-scope' }, title);
  });
  const policy = h('div', { class: 'policy' }, h('div', { class: 'policy-guided' }, blocks));
  const sheet = h('main', { class: 'sheet' }, sticky, policy);
  dom.root.append(sheet);
  const saved = new Map([['policy-block', stored]]), writes = [];
  decoratePolicy(policy, {
    isOpen: (key, fallback) => saved.has(key) ? saved.get(key) : fallback,
    setOpen: (key, value) => { saved.set(key, value); writes.push([key, value]); },
  });
  const sections = policy.querySelectorAll('.pnav-section'), calls = [];
  for (const section of sections) {
    section.dataset.block = section.getAttribute('data-block');
    const properties = new Map();
    section.style.setProperty = (name, value) => properties.set(name, String(value));
    section.style.getPropertyValue = (name) => properties.get(name) || '';
    section.scrollIntoView = (options) => calls.push({
      section, options, inset: section.style.getPropertyValue('--policy-jump-inset'),
    });
  }
  return {
    policy, sheet, sticky, saved, writes, sections, calls, links: policy.querySelectorAll('.pnav-link'),
    resize: (value) => { currentHeight = value; },
  };
}

for (const [reduce, height] of [[false, 73], [true, 152.75]]) {
  test(`UI policy jump: actual sticky height and focused heading retain ${reduce ? 'reduced' : 'default'} motion`, () => {
    reduced = reduce;
    const ui = policySheet({ height });
    ui.links[0].click();
    assert.equal(document.activeElement, ui.sections[0].querySelector('.pnav-section-title'));
    assert.deepEqual(document.activeElement.focusOptions, { preventScroll: true });
    assert.equal(document.activeElement.dataset.editorFocus, 'policy:synthetic:block:0');
    assert.deepEqual(ui.writes, [['policy-block', 0]]);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].inset, `${height}px`);
    assert.deepEqual(ui.calls[0].options, { block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  });
}

test('UI policy jump: each activation remeasures a header that has wrapped or resized', () => {
  const ui = policySheet({ height: 64.5 });
  ui.links[1].click();
  ui.resize(187.25);
  ui.links[1].click();
  assert.deepEqual(ui.calls.map((call) => call.inset), ['64.5px', '187.25px']);
  assert.equal(ui.saved.get('policy-block'), 1);
  assert.equal(document.activeElement, ui.sections[1].querySelector('.pnav-section-title'));
});

test('UI policy jump: the target uses its own sheet rather than another document header', () => {
  const other = policySheet({ height: 301 });
  const ui = policySheet({ height: 91.5 });
  ui.links[3].click();
  assert.equal(ui.calls[0].inset, '91.5px');
  assert.deepEqual(other.calls, []);
  assert.deepEqual(other.writes, []);
});

test('UI policy jump: a removed sticky header cannot leave a stale inset on the target', () => {
  const ui = policySheet({ height: 120 });
  ui.links[0].click();
  ui.sticky.remove();
  ui.links[0].click();
  assert.deepEqual(ui.calls.map((call) => call.inset), ['120px', '0px']);
  assert.equal(document.activeElement, ui.sections[0].querySelector('.pnav-section-title'));
});

test('UI policy jump: restoring a saved destination measures current geometry without stealing focus', () => {
  const ui = policySheet({ height: 166, stored: 4 });
  const outside = h('button', {}, 'Outside owner');
  dom.root.append(outside);
  outside.focus();
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].section, ui.sections[4]);
  assert.equal(ui.calls[0].inset, '166px');
  assert.equal(document.activeElement, outside);
  assert.equal(ui.saved.get('policy-block'), 4);
});

test('UI policy jump: a restored render retains an already focused control inside its document', () => {
  const ui = policySheet({ stored: 4 });
  const control = h('input', { value: 'Retained input' });
  ui.sections[1].append(control);
  control.focus();
  frames.shift()();
  assert.deepEqual(ui.calls, []);
  assert.deepEqual(ui.writes, []);
  assert.equal(document.activeElement, control);
  assert.equal(control.value, 'Retained input');
  assert.equal(ui.saved.get('policy-block'), 4);
});

test('UI policy jump: reading-band observations do not overwrite the saved jump or move focus', () => {
  const ui = policySheet();
  ui.links[2].click();
  const focused = document.activeElement, observer = observers[0];
  assert.deepEqual(observer.targets, ui.sections);
  assert.deepEqual(observer.options, { rootMargin: '-8% 0px -80% 0px', threshold: 0 });
  observer.deliver([{ target: ui.sections[3], isIntersecting: true }]);
  assert.equal(ui.links[3].getAttribute('aria-current'), 'true');
  assert.equal(ui.links[2].getAttribute('aria-current'), 'false');
  assert.equal(ui.saved.get('policy-block'), 2);
  assert.deepEqual(ui.writes, [['policy-block', 2]]);
  assert.equal(ui.calls.length, 1);
  assert.equal(document.activeElement, focused);
});

test('UI policy jump: the measured inset adds to the existing section gap only', () => {
  const css = readFileSync(new URL('../web/css/components.css', import.meta.url), 'utf8');
  assert.match(css, /\.pnav-section\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--policy-jump-inset,\s*0px\)\s*\+\s*var\(--sp-5\)\)/);
  assert.match(css, /\.sheet-sticky\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/);
});
