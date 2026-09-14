import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { installDom, readText } from './_dom-stub.mjs';
import { h } from '../web/js/dom.mjs';
import { formatIcon } from '../web/js/format-icon.mjs';

installDom();

for (const [format, label] of [['bicep', 'Bicep'], ['terraform', 'Terraform']]) {
  test(`format icons: ${format} uses its local SVG without changing the visible label`, () => {
    const icon = formatIcon(format);
    const control = h('button', { type: 'button' }, icon, label);
    assert.equal(icon.tagName, 'IMG');
    assert.equal(icon.className, 'format-icon');
    assert.equal(icon.getAttribute('src'), `/icons/${format}.svg`);
    assert.equal(icon.getAttribute('alt'), '');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(icon.getAttribute('width'), '20');
    assert.equal(icon.getAttribute('height'), '20');
    assert.equal(icon.draggable, false);
    assert.equal(readText(control), label);
  });

  test(`format icons: ${format} has a self-contained vector asset`, async () => {
    const svg = await readFile(new URL(`../web/icons/${format}.svg`, import.meta.url), 'utf8');
    assert.match(svg, /<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, new RegExp(`<title>${label} configuration</title>`));
    assert.match(svg, /<path\b/);
    assert.doesNotMatch(svg, /<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(/i);
  });
}

test('format icons: each placement gets a distinct node', () => {
  assert.notEqual(formatIcon('bicep'), formatIcon('bicep'));
  assert.notEqual(formatIcon('terraform').getAttribute('src'), formatIcon('bicep').getAttribute('src'));
});

test('format icons: unsupported formats cannot select arbitrary assets', () => {
  for (const format of [undefined, null, '', 'Bicep', 'json', '__proto__', '../secret', 'https://example.invalid/icon.svg']) {
    assert.throws(() => formatIcon(format), TypeError);
  }
});
