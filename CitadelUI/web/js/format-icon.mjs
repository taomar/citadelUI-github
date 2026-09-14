import { h } from './dom.mjs';

const sources = Object.freeze({
  bicep: '/icons/bicep.svg',
  terraform: '/icons/terraform.svg',
});

/** Decorative companion to an existing, visible format label. */
export function formatIcon(format) {
  if (typeof format !== 'string' || !Object.hasOwn(sources, format)) {
    throw new TypeError(`Unsupported configuration format: ${String(format)}`);
  }
  const icon = h('img', {
    class: 'format-icon',
    src: sources[format],
    alt: '',
    'aria-hidden': 'true',
    width: 20,
    height: 20,
  });
  icon.draggable = false;
  return icon;
}
