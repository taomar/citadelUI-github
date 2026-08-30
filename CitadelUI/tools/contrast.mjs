import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file's own location, not the cwd, so the report can be run
// from the project root or from CitadelUI/ and always reads the same stylesheet.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, '..', 'web', 'css', 'app.css'), 'utf8');
const raw = new Map(
  [...css.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((match) => [match[1], match[2].trim()])
);

function resolve(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`Circular token reference: --${name}`);
  const value = raw.get(name);
  if (!value) throw new Error(`Missing token: --${name}`);
  const ref = value.match(/^var\(--([a-z0-9-]+)\)$/i);
  return ref ? resolve(ref[1], new Set([...seen, name])) : value;
}

function rgb(name) {
  const value = resolve(name);
  const match = value.match(/^#([0-9a-f]{6})$/i);
  if (!match) throw new Error(`--${name} does not resolve to a six-digit hex color`);
  return [0, 2, 4].map((index) => Number.parseInt(match[1].slice(index, index + 2), 16));
}

function luminance(color) {
  const channels = color.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const first = luminance(rgb(foreground));
  const second = luminance(rgb(background));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const pairs = [
  ['ink-1', 'sheet'], ['ink-2', 'sheet'], ['ink-3', 'sheet'],
  ['ink-1', 'well'], ['ink-2', 'well'], ['ink-3', 'well'],
  ['ink-1', 'zebra'], ['ink-2', 'zebra'], ['ink-3', 'zebra'],
  ['ink-1', 'band'], ['ink-2', 'band'], ['ink-3', 'band'],
  ['ink-1', 'ground'], ['ink-2', 'ground'], ['ink-3', 'ground'],
  ['ink-1', 'brass-wash'], ['brass', 'brass-wash'],
  ['ink-1', 'prov-wash'], ['prov', 'prov-wash'],
  ['ink-1', 'ok-wash'], ['ok', 'ok-wash'],
  ['bad-ink', 'bad-wash'], ['bad', 'bad-wash'],
  ['on-brass', 'brass'], ['on-brass', 'brass-2'],
  ['nav-ink', 'nav'], ['nav-muted', 'nav'], ['nav-accent', 'nav-active'],
];

const results = pairs.map(([foreground, background]) => ({
  foreground,
  background,
  ratio: contrast(foreground, background),
}));
const failures = results.filter((result) => result.ratio < 4.5);
const minimum = results.reduce((lowest, result) => result.ratio < lowest.ratio ? result : lowest);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    failures: failures.length,
    minimum: { ...minimum, ratio: Number(minimum.ratio.toFixed(2)) },
    results: results.map((result) => ({ ...result, ratio: Number(result.ratio.toFixed(2)) })),
  }, null, 2));
} else {
  console.table(results.map((result) => ({
    text: `--${result.foreground}`,
    surface: `--${result.background}`,
    ratio: `${result.ratio.toFixed(2)}:1`,
  })));
  console.log(`Minimum: --${minimum.foreground} on --${minimum.background} = ${minimum.ratio.toFixed(2)}:1`);
  console.log(failures.length
    ? `FAIL: ${failures.length} pair(s) are below WCAG AA.`
    : `PASS: all ${results.length} text/surface pairs meet WCAG AA.`);
}

process.exitCode = failures.length ? 1 : 0;
