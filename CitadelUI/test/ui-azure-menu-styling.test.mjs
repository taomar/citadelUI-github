import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const foundation = readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8');
const components = readFileSync(new URL('../web/css/components.css', import.meta.url), 'utf8');
const declarations = (body) => new Map([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)]
  .map((match) => [match[1], match[2].trim()]));
const tokens = declarations(foundation.match(/:root\s*\{([^}]+)\}/)[1]);
const rules = (source) => [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => ({ selectors: match[1].split(',').map((selector) => selector.trim()), values: declarations(match[2]) }));
const componentRules = rules(components);
const rule = (selector) => new Map(componentRules.filter((entry) => entry.selectors.includes(selector))
  .flatMap((entry) => [...entry.values]));

function color(value, scope = tokens, seen = new Set()) {
  const variable = value.match(/^var\((--[\w-]+)\)$/);
  if (variable) {
    assert(!seen.has(variable[1]), 'Menu tokens must not be circular.');
    assert(scope.has(variable[1]), `${variable[1]} must be defined.`);
    return color(scope.get(variable[1]), scope, new Set([...seen, variable[1]]));
  }
  assert.match(value, /^#[0-9a-f]{6}$/i);
  return value.slice(1).match(/../g).map((channel) => Number.parseInt(channel, 16));
}

function luminance(rgb) {
  return rgb.map((channel) => channel / 255).map((channel) =>
    channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
}

function contrast(first, second, scope = tokens) {
  const a = luminance(color(first, scope)), b = luminance(color(second, scope));
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

test('Azure menu styling: menu selectors consume a shared legible light ramp', () => {
  assert.equal(rule('.shell-menu-panel').get('background'), 'var(--menu-surface)');
  assert.equal(rule('.mp-panel').get('background'), 'var(--menu-surface)');
  assert.equal(rule('.shell-menu-item').get('color'), 'var(--menu-ink)');
  for (const surface of ['menu-surface', 'menu-hover', 'menu-selected', 'menu-pressed']) {
    for (const ink of ['menu-ink', 'menu-muted']) {
      assert(contrast(`var(--${ink})`, `var(--${surface})`) >= 4.5, `${ink} on ${surface}`);
    }
  }
});

test('Azure menu styling: deep navigation and pale selection preserve text and marker contrast', () => {
  assert.equal(rule('.rail-areas').get('background'), 'var(--nav)');
  assert.equal(rule('.rail-areas .empty').get('color'), 'var(--nav-muted)');
  for (const surface of ['nav', 'nav-hover', 'nav-active']) {
    for (const ink of ['nav-ink', 'nav-muted']) {
      assert(contrast(`var(--${ink})`, `var(--${surface})`) >= 4.5, `${ink} on ${surface}`);
    }
  }
  const selected = rule('.rail-areas .area.active');
  assert.equal(selected.get('--nav-ink'), 'var(--menu-ink)');
  assert.equal(selected.get('--nav-muted'), 'var(--menu-muted)');
  assert(contrast('var(--brand)', selected.get('background')) >= 3);
  assert.match(foundation, /\.area\.active::before\s*\{[^}]*width:\s*2px;[^}]*background:\s*var\(--brand\)/);
});

test('Azure menu styling: Tools has separate resting, expanded and pressed surfaces without changing its label', () => {
  const resting = rule('.shell-menu-trigger'), expanded = rule(".shell-menu-trigger[aria-expanded='true']:not(:disabled)");
  const pressed = rule('.shell-menu-trigger:active:not(:disabled)');
  assert.notDeepEqual(color(resting.get('background')), color(expanded.get('background')));
  assert.notDeepEqual(color(expanded.get('background')), color(pressed.get('background')));
  for (const state of [resting, expanded, pressed]) {
    assert(contrast(state.get('color'), state.get('background')) >= 4.5);
    assert(contrast(state.get('border-color'), 'var(--sheet)') >= 3);
  }
  assert.equal(rule('.shell-menu-item:hover:not(:disabled)').get('background'), 'var(--menu-hover)');
  assert.equal(rule('.shell-menu-item:active:not(:disabled)').get('background'), 'var(--menu-pressed)');
});

test('Azure menu styling: menu and picker focus remains outlined against their active surfaces', () => {
  for (const selector of ['.shell-menu-item:focus-visible', '.mp-item:focus-visible']) {
    assert.match(rule(selector).get('outline'), /^2px solid var\(--menu-rule\)$/);
    assert.equal(rule(selector).get('outline-offset'), '-2px');
  }
  for (const surface of ['menu-surface', 'menu-hover', 'menu-selected', 'menu-pressed']) {
    assert(contrast('var(--menu-rule)', `var(--${surface})`) >= 3, surface);
  }
});

test('Azure menu styling: header aliases share navigation colors while the editor remains neutral', () => {
  const header = new Map([...tokens, ...rule('.titleblock')]);
  assert.equal(header.get('--header-control'), 'var(--nav-hover)');
  assert(contrast('var(--header-focus)', 'var(--nav-active)', header) >= 3);
  assert.equal(rule('.commandbar').get('background'), 'var(--sheet)');
  const sheet = color('var(--sheet)');
  assert.equal(new Set(sheet).size, 1, 'Navigation colors must not wash over the editing sheet.');
});

test('Azure menu styling: status colors and disabled menu affordances remain separate from selection', () => {
  for (const role of ['danger', 'warning', 'success']) {
    assert(contrast(`var(--${role})`, `var(--${role}-wash)`) >= 4.5, role);
    assert.notDeepEqual(color(`var(--${role})`), color('var(--brand)'));
  }
  assert.equal(rule('.mp-added').get('color'), 'var(--success)');
  assert.equal(rule('.mp-added').get('background'), 'var(--success-wash)');
  const disabled = rule('.shell-menu-item:disabled');
  assert.equal(disabled.get('cursor'), 'not-allowed');
  assert.equal(disabled.get('background'), 'transparent');
  assert(contrast(disabled.get('color'), 'var(--menu-surface)') >= 4.5);
});

test('Azure menu styling: document title, path and mode tabs have distinct legible surface roles', () => {
  const strip = rule('.sheet-strip'), title = rule('.strip-title'), path = rule('.strip-path');
  assert.equal(strip.get('background'), 'var(--menu-surface)');
  assert(contrast(title.get('color'), strip.get('background')) >= 4.5);
  assert(contrast(path.get('color'), strip.get('background')) >= 4.5);
  for (const selector of ['.strip-tabs .tab:hover:not(:disabled)', '.strip-tabs .tab.active', '.strip-tabs .tab:active:not(:disabled)']) {
    const state = rule(selector);
    assert(contrast(state.get('color'), state.get('background')) >= 4.5, selector);
  }
});

test('Azure menu styling: section and mode selection keep their non-color underline and inset focus', () => {
  const current = rule('.outline-tabs .outline-link.current');
  assert(contrast(current.get('border-bottom-color'), current.get('background')) >= 3);
  assert(contrast(rule('.outline-tabs .outline-link.current .outline-label').get('color'), current.get('background')) >= 4.5);
  for (const selector of ['.strip-tabs .tab:focus-visible', '.outline-tabs .outline-link:focus-visible']) {
    assert.equal(rule(selector).get('outline'), '2px solid var(--menu-rule)');
    assert.equal(rule(selector).get('outline-offset'), '-2px');
  }
  assert.match(foundation, /\.tab\.active::after\s*\{[^}]*height:\s*2px;[^}]*background:\s*var\(--brand\)/);
});

test('Azure menu styling: long document and category labels wrap without hiding their text', () => {
  for (const selector of ['.strip-path', '.strip-tabs .tab', '.outline-label']) {
    assert.equal(rule(selector).get('white-space'), 'normal');
    assert.equal(rule(selector).get('overflow-wrap'), 'anywhere');
  }
  assert.equal(rule('.strip-path').get('direction'), 'ltr');
  assert.equal(rule('.outline-tabs .outline-list').get('flex-wrap'), 'wrap');
  assert.equal(rule('.outline-tabs .outline-list').get('overflow-x'), 'auto');
  assert.equal(rule('.strip-tabs').get('overflow-x'), 'auto');
});
