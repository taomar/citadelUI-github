import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const foundation = readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8');
const components = readFileSync(new URL('../web/css/components.css', import.meta.url), 'utf8');
const rules = (source) => [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => ({
    selector: match[1].trim(),
    declarations: new Map([...match[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)]
      .map((declaration) => [declaration[1], declaration[2].trim()])),
  }));
const declarations = (source, selector) => new Map(rules(source)
  .filter((rule) => rule.selector.split(',').some((value) => value.trim() === selector))
  .flatMap((rule) => [...rule.declarations]));

for (const [control, selector] of [
  ['Tools', '.shell-menu-trigger'],
  ['explorer areas', '.rail-areas .area'],
  ['explorer files', '.rail-areas .nav-item'],
]) {
  test(`Azure transition contrast: ${control} disables inverse interpolation in the base rule for entry and exit`, () => {
    assert.equal(declarations(components, selector).get('transition'), 'none',
      'A state-only override leaves the reverse transition unsafe.');
  });
}

test('Azure transition contrast: affected states do not restart an inherited transition', () => {
  const scoped = rules(components).filter(({ selector }) => selector.includes('.shell-menu-trigger') ||
    /\.rail-areas[^{}]*(?:\.area\b|\.nav-item\b)/.test(selector));
  const overrides = scoped.flatMap((rule) => [...rule.declarations]
    .filter(([name]) => /^transition(?:-|$)/.test(name)));
  assert(overrides.length >= 2);
  for (const [name, value] of overrides) {
    assert.equal(name, 'transition');
    assert.equal(value, 'none');
  }
});

test('Azure transition contrast: reduced motion cannot interpolate navigation label ink separately', () => {
  const selector = '.rail-areas :is(.area, .nav-item) :is(.area-title, .area-sub, .nav-name, .nav-meta)';
  const labels = rules(components).find((rule) => rule.selector === selector);
  assert.equal(labels?.declarations.get('transition'), 'none');
});

test('Azure transition contrast: unrelated foundation control motion remains enabled', () => {
  for (const selector of ['.btn', '.area', '.nav-item']) {
    assert.match(declarations(foundation, selector).get('transition'), /background var\(--fast\) var\(--ease\)/);
  }
  assert.match(declarations(foundation, '.btn').get('transition'), /color var\(--fast\) var\(--ease\)/);
});
