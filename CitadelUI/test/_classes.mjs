import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'web', 'js');
const found = new Set();

for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
  const text = readFileSync(join(dir, file), 'utf8');
  for (const m of text.matchAll(/class:\s*(?:`([^`]+)`|'([^']+)')/g)) {
    const raw = (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ');
    for (const c of raw.split(/\s+/)) if (c) found.add(c);
  }
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g)) found.add(m[1]);
}

const cssDir = join(here, '..', 'web', 'css');
const css = readdirSync(cssDir)
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(cssDir, f), 'utf8'))
  .join('\n');
const styled = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) styled.add(m[1]);

const missing = [...found].filter((c) => !styled.has(c)).sort();
console.log('USED', found.size, 'MISSING', missing.length);
console.log(missing.join(' '));
