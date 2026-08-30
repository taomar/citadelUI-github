/**
 * Renders the documentation blocks produced by the server's doc layer.
 *
 * The source of this content is the banner comments the parameter files already
 * carry, so the vocabulary here is deliberately small: prose, bullets,
 * definitions, sub-headings, parameter name lists and example code. Anything
 * richer would be inventing structure the files do not actually have.
 */

import { h } from './dom.mjs';

function listBlock(block) {
  return h(
    'ul',
    { class: 'doc-list' },
    block.items.map((item) =>
      h(
        'li',
        { class: item.term ? 'doc-def' : 'doc-bullet' },
        item.term ? h('code', { class: 'doc-term' }, item.term) : null,
        item.term ? h('span', { class: 'doc-sep' }, '—') : null,
        h('span', { class: 'doc-text' }, item.text)
      )
    )
  );
}

function codeBlock(block) {
  // Examples are long and mostly commented-out alternatives. Collapsing them
  // keeps a section scannable while leaving the detail one click away.
  return h(
    'details',
    { class: 'doc-code' },
    h('summary', {}, block.label || 'Example'),
    h('pre', {}, h('code', {}, block.lines.join('\n')))
  );
}

function paramListBlock(block) {
  return h(
    'p',
    { class: 'doc-paramlist' },
    h('span', { class: `chip chip-${block.requirement}` }, block.requirement),
    block.names.map((n) => h('code', { class: 'doc-param-ref' }, n))
  );
}

export function renderBlocks(blocks, className = 'doc') {
  if (!blocks || !blocks.length) return null;
  return h(
    'div',
    { class: className },
    blocks.map((block) => {
      switch (block.type) {
        case 'heading':
          return h('h4', { class: 'doc-heading' }, block.text);
        case 'list':
          return listBlock(block);
        case 'code':
          return codeBlock(block);
        case 'paramlist':
          return paramListBlock(block);
        default:
          return h('p', { class: 'doc-para' }, block.text);
      }
    })
  );
}

/**
 * Condense a block list to a single line of prose, for collapsed summaries.
 */
export function summarise(blocks, limit = 150) {
  if (!blocks || !blocks.length) return null;
  const first = blocks.find((b) => b.type === 'para');
  if (!first) return null;
  return first.text.length > limit ? `${first.text.slice(0, limit - 1)}…` : first.text;
}
