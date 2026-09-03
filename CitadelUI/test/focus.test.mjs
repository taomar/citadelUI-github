/**
 * Acceptance gate for the documentation layer of the three focus areas: the
 * main deployment parameters, LLM backend onboarding, and access contracts.
 *
 * The UI derives its grouping from the banner comments the repo already carries
 * rather than from a hardcoded map, so a regression in banner parsing silently
 * degrades every form. The tests assert full parameter coverage and reject the
 * specific failure that a dashed sub-banner inside a body can cause: a body
 * terminating early and its remaining prose becoming the title of a bogus
 * section.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBicepParam } from '../server/bicepparam/parser.mjs';
import { buildOutline } from '../server/doclayer.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');

const FOCUS_FILES = [
  'bicep/infra/main.bicepparam',
  'bicep/infra/llm-backend-onboarding/main.bicepparam',
  'bicep/infra/citadel-access-contracts/main.bicepparam',
];

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push(`${name}\n    ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/* ------------------------------------------------------- documentation layer */

for (const rel of FOCUS_FILES) {
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  const doc = parseBicepParam(text);
  const outline = buildOutline(text, doc.params);

  check(`outline: ${rel} covers every parameter`, () => {
    const covered = outline.sections.reduce((n, s) => n + s.params.length, 0);
    assert(
      covered === doc.params.length,
      `${covered} of ${doc.params.length} parameters landed in a section`
    );
  });

  check(`outline: ${rel} has no runaway section titles`, () => {
    for (const s of outline.sections) {
      // A body that terminated early shows up as a title hundreds of chars long.
      assert(s.title.length <= 90, `title is ${s.title.length} chars: ${s.title.slice(0, 60)}...`);
      assert(!/={3,}|-{3,}/.test(s.title), `title still contains fence characters: ${s.title}`);
    }
  });

  check(`outline: ${rel} keeps fences out of parameter docs`, () => {
    for (const [name, blocks] of Object.entries(outline.paramDocs || {})) {
      assert(!JSON.stringify(blocks).includes('===='), `paramDocs.${name} contains a banner fence`);
    }
  });

  check(`outline: ${rel} assigns each parameter to exactly one section`, () => {
    const seen = new Set();
    for (const s of outline.sections) {
      for (const p of s.params) {
        assert(!seen.has(p), `parameter ${p} appears in more than one section`);
        seen.add(p);
      }
    }
  });
}

check('outline: dashed sub-banners stay inside their section body', () => {
  const rel = 'bicep/infra/citadel-access-contracts/main.bicepparam';
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  const outline = buildOutline(text, parseBicepParam(text).params);
  const services = outline.sections.find((s) => s.title === 'Services Configuration');
  assert(services, 'Services Configuration section is missing');
  assert(services.params.length === 1, `expected 1 param, got ${services.params.length}`);
  const headings = services.blocks.filter((b) => b.type === 'heading').map((b) => b.text);
  assert(
    headings.some((h) => h.startsWith('MULTI-ASSET CONTRACTS')),
    `MULTI-ASSET sub-banner did not become a heading (headings: ${JSON.stringify(headings)})`
  );
});

/* ------------------------------------------------------------------ report */

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
