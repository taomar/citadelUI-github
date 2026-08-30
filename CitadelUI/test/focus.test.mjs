/**
 * Acceptance gate for the three focus areas: the main deployment parameters,
 * LLM backend onboarding, and access contracts.
 *
 * Two things are guarded here.
 *
 * 1. The documentation layer. The UI derives its grouping from the banner
 *    comments the repo already carries rather than from a hardcoded map, so a
 *    regression in banner parsing silently degrades every form. The tests
 *    assert full parameter coverage and reject the specific failure that a
 *    dashed sub-banner inside a body can cause: a body terminating early and
 *    its remaining prose becoming the title of a bogus section.
 *
 * 2. The access contract write paths. Policy edits and contract creation must
 *    be surgical -- a fixed number of lines change and nothing else moves --
 *    because both artefacts are hand-authored documentation as much as they
 *    are configuration.
 */

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBicepParam } from '../server/bicepparam/parser.mjs';
import { buildOutline } from '../server/doclayer.mjs';
import {
  listContracts,
  readContract,
  readPolicyControls,
  applyPolicyChanges,
  createContract,
  CONTRACT_ROOT,
  TEMPLATE,
} from '../server/contracts.mjs';

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

function changedLines(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(al.length, bl.length); i += 1) {
    if (al[i] !== bl[i]) out.push(i + 1);
  }
  return out;
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

/* -------------------------------------------------------- contract discovery */

check('contracts: plumbing folders are excluded', () => {
  const { contracts } = listContracts();
  for (const c of contracts) {
    assert(!/\/?(modules|policies|base-contracts)(\/|$)/.test(c.id), `plumbing folder listed: ${c.id}`);
  }
});

check('contracts: the template pair resolves', () => {
  const { template } = listContracts();
  assert(template.id === TEMPLATE.id, `unexpected template id ${template.id}`);
  assert(template.paramFile === TEMPLATE.paramFile, 'template param path drifted');
  assert(template.hasPolicy, 'template policy file not found');
  assert(template.paramCount > 0, 'template parsed to zero parameters');
  assert(!template.error, `template failed to parse: ${template.error}`);
});

check('contracts: the module root is not itself listed as a contract', () => {
  const { contracts } = listContracts();
  const roots = contracts.filter((c) => c.dir === CONTRACT_ROOT && !c.isTemplate);
  assert(roots.length === 0, 'module root surfaced as a plain contract');
});

/* ----------------------------------------------------------- policy controls */

const policyXml = readFileSync(join(repoRoot, TEMPLATE.policyFile), 'utf8');

check('policy: control spans address exactly their own value', () => {
  const c = readPolicyControls(policyXml);
  assert(c.allowedModels, 'allowedModels control missing');
  assert(
    policyXml.slice(c.allowedModels.span.start, c.allowedModels.span.end) === c.allowedModels.value,
    'allowedModels span does not match its value'
  );
  assert(c.tokenLimit, 'tokenLimit control missing');
  assert(c.tokenLimit.enabled === true, 'default policy token limit should be enabled');
  for (const [key, attr] of Object.entries(c.tokenLimit.attributes)) {
    assert(
      policyXml.slice(attr.span.start, attr.span.end) === attr.value,
      `tokenLimit.${key} span does not match its value`
    );
  }
  assert(c.responseHeaders && c.responseHeaders.value === true, 'responseHeaders control missing');
});

check('policy: commented-out fragments are not reported as live', () => {
  const c = readPolicyControls(policyXml);
  assert(
    !c.fragments.includes('raise-throttling-events'),
    'a fragment inside an XML comment was reported as live'
  );
  assert(c.fragments.includes('set-llm-requested-model'), 'live fragment was not reported');
});

check('policy: each structured edit touches exactly one line', () => {
  const cases = [
    ['allowedModels', { allowedModels: 'gpt-4.1,gpt-4o' }],
    ['responseHeaders', { responseHeaders: false }],
    ['tokenLimit attributes', { tokenLimit: { attributes: { 'tokens-per-minute': 7500 } } }],
    ['tokenLimit disable', { tokenLimit: { enabled: false } }],
  ];
  for (const [label, changes] of cases) {
    const out = applyPolicyChanges(policyXml, changes);
    const lines = changedLines(policyXml, out);
    assert(lines.length === 1, `${label}: expected 1 changed line, got ${lines.length}`);
  }
});

check('policy: disable then enable is byte-identical', () => {
  const off = applyPolicyChanges(policyXml, { tokenLimit: { enabled: false } });
  assert(readPolicyControls(off).tokenLimit.enabled === false, 'disabled policy still reads as enabled');
  const back = applyPolicyChanges(off, { tokenLimit: { enabled: true } });
  assert(back === policyXml, 'round trip did not restore the original bytes');
});

check('policy: disabling while editing an attribute merges both', () => {
  const out = applyPolicyChanges(policyXml, {
    tokenLimit: { enabled: false, attributes: { 'tokens-per-minute': 42 } },
  });
  assert(changedLines(policyXml, out).length === 1, 'merge path changed more than one line');
  const reread = readPolicyControls(out);
  assert(reread.tokenLimit.enabled === false, 'merged result is not disabled');
  assert(
    reread.tokenLimit.attributes['tokens-per-minute'].value === '42',
    'merged attribute edit was lost'
  );
});

/* -------------------------------------------------------- contract creation */

/* Must never collide with a real contract folder: this directory is rmSync'd
   recursively by every check below. `contracts` used to be the value here,
   which resolved to the live user contract root and deleted all of it. */
const scratchParent = '.scratch-contracts';
const scratchDir = join(repoRoot, CONTRACT_ROOT, scratchParent);

check('contracts: creation rewires only `using` and `policyXml`', () => {
  if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true });
  try {
    const res = createContract({ name: 'acceptance-test', parent: scratchParent });
    const template = readFileSync(join(repoRoot, TEMPLATE.paramFile), 'utf8');
    const created = readFileSync(join(repoRoot, res.created[0]), 'utf8');

    const lines = changedLines(template, created);
    assert(lines.length === 2, `expected 2 changed lines, got ${lines.length}: ${lines}`);

    const count = (s) => (s.match(/\/\//g) || []).length;
    assert(
      count(template) === count(created),
      `comment markers changed: ${count(template)} -> ${count(created)}`
    );

    assert(res.using === '../../main.bicep', `using not recomputed: ${res.using}`);
    assert(created.includes(`using '../../main.bicep'`), 'using statement not rewritten');
    assert(
      created.includes(`policyXml: loadTextContent('ai-product-policy.xml')`),
      'policyXml was not pointed at the copied policy'
    );
    assert(!/loadTextContent\('ai-product-policy\.xml'\) {2,}/.test(created), 'stale padding left behind');

    const reread = readContract(`${scratchParent}/acceptance-test`);
    assert(reread.policy, 'created contract does not resolve its policy');
    assert(reread.policy.name === 'ai-product-policy.xml', `unexpected policy ${reread.policy.name}`);
    assert(
      reread.policy.text === policyXml,
      'copied policy is not byte-identical to the default policy'
    );
  } finally {
    if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true });
  }
});

check('contracts: creation rejects unsafe names', () => {
  for (const name of ['../escape', 'Has Space', '', 'a/../b', 'with_underscore']) {
    let threw = false;
    try {
      createContract({ name, parent: scratchParent });
    } catch {
      threw = true;
    } finally {
      if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true });
    }
    assert(threw, `name ${JSON.stringify(name)} was accepted`);
  }
});

check('contracts: creation normalises case rather than rejecting it', () => {
  if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true });
  try {
    // Contract identity feeds Azure resource names, which are lowercase, so
    // folding the case is friendlier than making the user retype the name.
    const res = createContract({ name: 'HR-ChatAgent', parent: scratchParent });
    assert(res.id === `${scratchParent}/hr-chatagent`, `unexpected id ${res.id}`);
  } finally {
    if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true });
  }
});

/* ------------------------------------------------------------------ report */

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
