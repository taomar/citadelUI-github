/**
 * Secret handling.
 *
 * Two guarantees are tested here. First, structural: a plan never contains a
 * secret value, so a preview cannot leak one. Second, textual: no source file
 * in the application reaches for browser storage, a cookie, or a log line that
 * could carry a credential out of memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGUE, SAMPLES, buildSamplePlan } from '../src/catalogue/index.mjs';
import { serializePlan } from '../src/core/plan.mjs';
import { previewPlan, previewSteps } from '../src/core/preview.mjs';
import {
  assertNoSecretValues,
  collectSecretRefs,
  findSecretValues,
  isSecretRef,
  redact,
  refToEnvVar,
  resolveSecretRefs,
  secretPlaceholder,
  secretRef,
  REDACTED,
} from '../src/core/secrets.mjs';
import { createPlaygroundState } from '../src/core/state.mjs';
import { FAKE_API_KEY, FIXTURE_SECRETS, makeFixtureReader } from './helpers/fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_DIRS = ['src', 'web', 'scripts'];

async function collectSourceFiles(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectSourceFiles(full, found);
    else if (['.mjs', '.js', '.html'].includes(extname(entry.name))) found.push(full);
  }
  return found;
}

async function allSourceFiles() {
  const files = [];
  for (const dir of SOURCE_DIRS) files.push(...(await collectSourceFiles(join(ROOT, dir))));
  files.push(join(ROOT, 'server.mjs'));
  return files;
}

/* ------------------------------------------------------ the ref itself */

test('a secret reference is inert and renders as an environment placeholder', () => {
  const ref = secretRef('gatewayAccess.apiKey');
  assert.ok(isSecretRef(ref));
  assert.equal(ref.ref, 'gatewayAccess.apiKey');
  assert.equal(ref.envVar, 'CITADEL_GATEWAY_ACCESS_API_KEY');
  assert.equal(secretPlaceholder(ref), '${CITADEL_GATEWAY_ACCESS_API_KEY}');
  assert.equal(refToEnvVar('keyVault.apiKeySecretName'), 'CITADEL_KEY_VAULT_API_KEY_SECRET_NAME');
  assert.throws(() => secretRef(''), TypeError);
});

test('redaction replaces live values and renders refs as placeholders', () => {
  const structure = { header: secretRef('gatewayAccess.apiKey'), note: `key is ${FAKE_API_KEY}`, list: [FAKE_API_KEY] };
  const redacted = redact(structure, FIXTURE_SECRETS);
  assert.equal(redacted.header, '${CITADEL_GATEWAY_ACCESS_API_KEY}');
  assert.equal(redacted.note, `key is ${REDACTED}`);
  assert.deepEqual(redacted.list, [REDACTED]);
});

test('the secret scanner finds a leaked value anywhere in a structure', () => {
  assert.deepEqual(findSecretValues({ a: { b: [FAKE_API_KEY] } }, FIXTURE_SECRETS), ['gatewayAccess.apiKey']);
  assert.deepEqual(findSecretValues({ a: 'clean' }, FIXTURE_SECRETS), []);
  assert.throws(() => assertNoSecretValues(`x ${FAKE_API_KEY}`, FIXTURE_SECRETS, 'Test'), /Test contains secret value/);
});

test('resolving refs is the only path from a ref to a value, and it is not used in the browser', () => {
  const resolved = resolveSecretRefs({ header: secretRef('gatewayAccess.apiKey') }, FIXTURE_SECRETS);
  assert.equal(resolved.header, FAKE_API_KEY);
  assert.throws(() => resolveSecretRefs({ h: secretRef('gatewayAccess.apiKey') }, {}), /Missing secret value/);
});

/* --------------------------------------------------- plans and previews */

test('no generated plan contains a secret value, in any serialisation', () => {
  for (const sample of SAMPLES) {
    const { plan } = buildSamplePlan(sample, makeFixtureReader());
    assert.ok(plan, `${sample.id} produced no plan`);
    assertNoSecretValues(plan, FIXTURE_SECRETS, `${sample.id} plan`);
    const serialized = serializePlan(plan);
    assert.ok(!serialized.includes(FAKE_API_KEY), `${sample.id} serialised plan leaks the key`);
  }
});

test('no preview — whole plan or single step — contains a secret value', () => {
  for (const sample of SAMPLES) {
    const { plan } = buildSamplePlan(sample, makeFixtureReader());
    const text = previewPlan(plan, { secrets: FIXTURE_SECRETS });
    assert.ok(!text.includes(FAKE_API_KEY), `${sample.id} preview leaks the key`);
    for (const step of previewSteps(plan, { secrets: FIXTURE_SECRETS })) {
      assert.ok(!step.text.includes(FAKE_API_KEY), `${sample.id}/${step.id} preview leaks the key`);
    }
  }
});

test('a recipe that needs the key renders it as a placeholder and declares the ref', () => {
  const needKey = [
    'weather-mcp-discovery',
    'learn-mcp-discovery',
    'a2a-agent-card',
    'a2a-message-send',
    'agent-framework-hr-question',
    'weather-tools-call',
    'tool-rate-limit-burst',
    'agent-rate-limit-burst',
  ];
  for (const id of needKey) {
    const sample = SAMPLES.find((candidate) => candidate.id === id);
    const { plan } = buildSamplePlan(sample, makeFixtureReader());
    assert.deepEqual(plan.secretRefs, ['gatewayAccess.apiKey'], `${id} does not declare the key ref`);
    const text = previewPlan(plan, { secrets: FIXTURE_SECRETS });
    assert.ok(text.includes('${CITADEL_GATEWAY_ACCESS_API_KEY}'), `${id} preview has no placeholder`);
    assert.ok(text.includes('Secrets are never written into this preview'), `${id} preview omits the notice`);
  }
});

test('collectSecretRefs deduplicates and preserves first-seen order', () => {
  const refs = collectSecretRefs([secretRef('a.b'), { x: secretRef('a.b') }, secretRef('c.d')]);
  assert.deepEqual(refs.map((ref) => ref.ref), ['a.b', 'c.d']);
});

/* ------------------------------------------------------- state handling */

test('state keeps secrets out of the serialisable snapshot', () => {
  const state = createPlaygroundState({ catalogue: CATALOGUE });
  state.set('hub.resourceGroupName', 'rg-test');
  state.set('gatewayAccess.apiKey', FAKE_API_KEY);

  assert.equal(state.hasSecret('gatewayAccess.apiKey'), true);
  assert.equal(state.read('gatewayAccess.apiKey'), FAKE_API_KEY, 'the validator can still see it');
  assert.equal(state.readPublic('gatewayAccess.apiKey'), '(set)', 'view models see presence, not value');

  const snapshot = state.toPersistable();
  assert.equal(snapshot.hub.resourceGroupName, 'rg-test');
  assert.equal(JSON.stringify(snapshot).includes(FAKE_API_KEY), false, 'the snapshot leaks the key');
  assert.equal(snapshot.gatewayAccess?.apiKey, undefined);
});

test('clearing a secret removes it, and defaults never seed a secret', () => {
  const state = createPlaygroundState({ catalogue: CATALOGUE });
  assert.equal(state.hasSecret('gatewayAccess.apiKey'), false);
  state.set('gatewayAccess.apiKey', FAKE_API_KEY);
  state.set('gatewayAccess.apiKey', '');
  assert.equal(state.hasSecret('gatewayAccess.apiKey'), false);
  assert.equal(state.read('gatewayAccess.apiKey'), '');
});

test('changing any input clears every acknowledgement', () => {
  const state = createPlaygroundState({ catalogue: CATALOGUE });
  state.setAcknowledged('cleanup', true);
  assert.equal(state.isAcknowledged('cleanup'), true);
  state.set('hub.location', 'westeurope');
  assert.equal(state.isAcknowledged('cleanup'), false, 'consent must not survive a configuration change');
});

test('an acknowledgement is spent by one run', () => {
  const state = createPlaygroundState({ catalogue: CATALOGUE });
  state.setAcknowledged('cleanup', true);
  assert.equal(state.consumeAcknowledgement('cleanup'), true);
  assert.equal(state.isAcknowledged('cleanup'), false);
  assert.equal(state.consumeAcknowledgement('cleanup'), false);
});

/* ------------------------------------------------- no persistence paths */

test('no source file touches browser storage, cookies or IndexedDB', async () => {
  const forbidden = [/\blocalStorage\b/, /\bsessionStorage\b/, /document\.cookie/, /\bindexedDB\b/, /\bopenDatabase\b/];
  for (const file of await allSourceFiles()) {
    const text = await readFile(file, 'utf-8');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${relative(ROOT, file)} uses ${pattern} — secrets must stay in memory`);
    }
  }
});

test('no source file writes a secret into a URL or the console', async () => {
  for (const file of await allSourceFiles()) {
    const text = await readFile(file, 'utf-8');
    assert.ok(
      !/console\.(log|info|warn|error|debug)\s*\([^)]*(apiKey|accessToken|secretValues|primary_key)/i.test(text),
      `${relative(ROOT, file)} may log a credential`,
    );
    assert.ok(
      !/(searchParams\.set|URLSearchParams)[^\n]*(apiKey|accessToken)/i.test(text),
      `${relative(ROOT, file)} may put a credential in a URL`,
    );
    const historyWrites = text.match(/history\.(pushState|replaceState)/g) ?? [];
    if (historyWrites.length > 0) {
      assert.equal(relative(ROOT, file), join('web', 'js', 'main.mjs'));
      assert.deepEqual(historyWrites, ['history.replaceState']);
      assert.match(
        text,
        /history\.replaceState\(null, '', `\$\{location\.pathname\}\$\{location\.search\}\$\{remaining \? `#\$\{remaining\}` : ''\}`\)/,
        'the only URL write must remove the bootstrap fragment without copying it',
      );
    }
  }
});

test('no fixture, test or provenance file carries anything resembling a real credential', async () => {
  const files = [
    ...(await collectSourceFiles(join(ROOT, 'test'))),
    join(ROOT, 'provenance.json'),
    join(ROOT, 'package.json'),
  ];
  for (const file of files) {
    const text = await readFile(file, 'utf-8');
    // A long, high-entropy run with no separators is what an APIM key looks
    // like. `/` is excluded so a long URL path is not mistaken for one.
    const suspects = text.match(/[A-Za-z0-9+]{40,}={0,2}/g) ?? [];
    for (const suspect of suspects) {
      const isKnownHash = /^[0-9a-f]{40,64}$/.test(suspect);
      assert.ok(isKnownHash, `${relative(ROOT, file)} contains a credential-shaped literal: ${suspect.slice(0, 12)}…`);
    }
  }
});

test('the only fixture secret is an obvious placeholder', () => {
  assert.match(FAKE_API_KEY, /^FAKE-/);
  assert.match(FAKE_API_KEY, /do-not-use/);
});
