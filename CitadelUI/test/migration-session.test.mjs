import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { BrowserReadOnlyDirectoryProvider, BrowserDirectoryProvider } from '../web/js/directory-provider.mjs';
import { MigrationDonor } from '../web/js/migration-donor.mjs';
import { discoverMigrationTargets, MIGRATION_AREAS, MigrationSession } from '../web/js/migration-session.mjs';
import { MIGRATION_LIMITS } from '../shared/migration-input.mjs';
import { serializeValue } from '../shared/bicepparam/serialize.mjs';
import { backendTemplate } from '../web/js/llmschema.mjs';
import { primaryCapabilities } from '../shared/citadel-core.mjs';
import {
  acceptCount, CURRENT, deferred, folderFromFiles, LEGACY, MigrationDirectoryHandle,
  MigrationFileHandle, migrationHarness, TARGET, TEMPLATE,
} from './_migration-fixture.mjs';

test('migration donor provider asks only for read permission and has no write/create/subscription surface', async () => {
  const trace = [];
  const root = folderFromFiles('old', {
    'old.bicepparam': 'param count = 3\n',
    'old.bicep': 'param count int\n',
    '.azure/dev/.env': 'SYNTHETIC_PRIVATE_MARKER',
    '.git/private.bicepparam': 'param count = 4\n',
    'CitadelUI/private.bicepparam': 'param count = 4\n',
    '.hidden/private.bicepparam': 'param count = 4\n',
    'README.md': 'unrelated',
    'arbitrary.json': '{"unrelated":true}',
    'policy.xml': '<policies/>',
  }, trace);
  const provider = new BrowserReadOnlyDirectoryProvider(root);
  assert.deepEqual((await provider.entries()).map((entry) => entry.alias), ['old.bicep', 'old.bicepparam']);
  await provider.read('old.bicepparam');
  assert(trace.filter((event) => event.startsWith('permission:')).every((event) => event.startsWith('permission:read:')));
  assert(trace.every((event) => !/write|create=true|\.azure|\.env|\.git|CitadelUI|\.hidden/.test(event)));
  for (const method of ['write', 'remove', 'assertWritable', 'readSubscriptionId', 'writeSubscriptionId', 'subscriptionEnvironmentFile']) {
    assert.equal(provider[method], undefined);
  }
  const previous = trace.length;
  for (const alias of ['.azure/dev/.env', '.env', '.git/private.bicepparam', 'CitadelUI/private.bicepparam', '../escape.bicepparam', 'policy.xml', 'arbitrary.json']) {
    await assert.rejects(() => provider.read(alias));
  }
  assert.equal(trace.filter((event) => event.startsWith('file:')).length, 1);
  assert(trace.slice(previous).every((event) => !event.startsWith('file:')));
});

test('migration read-only permission denial is not upgraded to readwrite', async () => {
  const trace = [];
  const root = new MigrationDirectoryHandle('denied', {}, trace);
  root.permission = 'denied';
  const donor = new MigrationDonor({ folder: root });
  await assert.rejects(donor.entries({ request: true }), { code: 'permission' });
  assert.deepEqual(trace, ['permission:read:denied', 'request:read:denied']);
});

test('migration credential-shaped local file labels never enter report or transaction metadata', async () => {
  const name = 'token=SYNTHETIC_PRIVATE_MARKER.bicepparam';
  assert.throws(() => new MigrationDonor({ files: [new MigrationFileHandle(name, 'param Count = 4\n')] }),
    (error) => error.code === 'scope' && !error.message.includes('SYNTHETIC_PRIVATE_MARKER'));
  const h = migrationHarness({ donorFiles: { [name]: 'param Count = 4\n' } });
  await assert.rejects(h.donor.entries(), { code: 'scope' });
  assert.equal(h.api.trace.length, 0);
});

test('migration donor browsing never gates old folders on current compatibility and never mutates either side', async () => {
  const h = migrationHarness();
  assert.deepEqual((await h.donor.entries()).map((entry) => entry.alias), ['main.bicepparam']);
  const view = await h.plan();
  assert(view.rows.some((row) => row.name === 'Count'));
  await h.session.preview();
  assert.equal(h.api.trace.length, 0, 'discovery/preview must not even prepare a transaction');
  assert(h.targetTrace.every((entry) => !/^(?:writable|write):|create=true/.test(entry)));
  assert(h.donorTrace.every((entry) => !/readwrite|writable:|write:|create=true/.test(entry)));
});

test('migration target discovery exposes only the three supported areas and existing Access instances', async () => {
  const aliases = [
    TARGET, 'bicep/infra/apim-gateway-upgrade/main.bicepparam',
    'bicep/infra/apim-gateway-upgrade/supporting-services.bicepparam',
    'bicep/infra/llm-backend-onboarding/main.bicepparam',
    'bicep/infra/citadel-access-contracts/main.bicepparam',
  ];
  const files = {};
  for (const alias of aliases) {
    files[alias] = await readFile(new URL(`../../${alias}`, import.meta.url), 'utf8');
    files[alias.replace(/\.bicepparam$/, '.bicep')] = 'param placeholder string\n';
  }
  const root = 'bicep/infra/citadel-access-contracts';
  for (const alias of ['synthetic-a', 'synthetic-b', 'base-contracts/common', 'modules', 'policies']) {
    files[`${root}/${alias}/main.bicepparam`] = "using '../main.bicep'\nparam placeholder = 'synthetic'\n";
  }
  const provider = new BrowserDirectoryProvider(folderFromFiles('synthetic-current', files));
  const targets = await discoverMigrationTargets(provider);
  assert.equal(targets.length, 4);
  assert.deepEqual(MIGRATION_AREAS.map((area) => area.id), ['deployment', 'llm-onboarding', 'access-contracts']);
  assert.deepEqual(new Set(targets.map((target) => target.area)), new Set(MIGRATION_AREAS.map((area) => area.id)));
  assert.equal(targets.filter((target) => target.kind.includes('Upgrade')).length, 0);
  assert(targets.every((target) => target.state === 'available'));
  assert.equal(targets.filter((target) => target.kind === 'Access Contracts - existing instance').length, 2);
  assert(!targets.some((target) => target.alias === `${root}/main.bicepparam`));
  assert(!targets.some((target) => /base-contracts|\/modules\/|\/policies\//.test(target.alias)));
});

function signatureSource(signature, minimum = signature.length) {
  const names = [...signature];
  while (names.length < minimum) names.push(`syntheticField${names.length}`);
  return names.map((name) => `param ${name} = readEnvironmentVariable('SYNTHETIC_UNEVALUATED')`).join('\n');
}

test('migration source inventory reads actual three-area configurations and recognizes legacy signatures without basename guessing', async () => {
  const deployment = signatureSource(primaryCapabilities.mainSignature, primaryCapabilities.mainMinimumParameters);
  const llm = signatureSource(primaryCapabilities.llmSignature);
  const access = signatureSource(primaryCapabilities.accessSignature, primaryCapabilities.accessMinimumParameters);
  const contractRoot = 'older/bicep/infra/citadel-access-contracts';
  const files = {
    [`older/${TARGET}`]: deployment,
    'bicep/infra/resources.bicepparam': deployment,
    'older-layout/deployment-settings.bicepparam': deployment,
    'older/bicep/infra/llm-backend-onboarding/main.bicepparam': llm,
    'older-layout/models.bicepparam': llm,
    [`${contractRoot}/finance/main.bicepparam`]: access,
    'relocated/finance.bicepparam': `using '../bicep/infra/citadel-access-contracts/main.bicep'\n${access}`,
    [`${contractRoot}/main.bicepparam`]: access,
    [`${contractRoot}/base-contracts/common/main.bicepparam`]: access,
    [`${contractRoot}/modules/main.bicepparam`]: access,
    'validation/contract.bicepparam': access,
    'bicep/infra/apim-gateway-upgrade/main.bicepparam': deployment,
    'bicep/infra/citadel-publish-contracts/main.bicepparam': access,
    'bicep/infra/foundry-integration/samples/main.bicepparam': llm,
    'bicep/infra/app-insights-alert/main.bicepparam': 'param count = 3\n',
    'main.bicepparam': 'param count = 3\n',
    'generic/access-template.bicepparam': access,
  };
  const h = migrationHarness({ donorFiles: files });
  const progress = [];
  const inventory = await h.session.inventory(h.donor, { onProgress: (state) => progress.push(state) });
  assert.deepEqual(inventory.items.filter((item) => item.area === 'deployment').map((item) => item.alias).sort(),
    [`older/${TARGET}`, 'bicep/infra/resources.bicepparam', 'older-layout/deployment-settings.bicepparam'].sort());
  assert.equal(inventory.items.filter((item) => item.area === 'llm-onboarding').length, 2);
  assert.deepEqual(inventory.items.filter((item) => item.area === 'access-contracts').map((item) => item.alias).sort(),
    [`${contractRoot}/finance/main.bicepparam`, 'relocated/finance.bicepparam'].sort());
  assert.equal(inventory.items.length, 7);
  assert.equal(inventory.unassigned.length, 0);
  assert.equal(inventory.issues.length, 0);
  assert.equal(inventory.items.find((item) => item.alias === `${contractRoot}/finance/main.bicepparam`).name, 'finance');
  assert(inventory.items.every((item) => item.parameters > 0 && item.dynamic === item.parameters));
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
  assert.doesNotMatch(JSON.stringify(inventory), /SYNTHETIC_UNEVALUATED|"value":|"text":/);
  assert.equal(h.api.trace.length, 0);
  assert(h.donorTrace.every((entry) => !/readwrite|writable:|write:|create=true/.test(entry)));
});

test('migration source inventory reports no Access instances for a template-only repository', async () => {
  const text = signatureSource(primaryCapabilities.accessSignature, primaryCapabilities.accessMinimumParameters);
  const h = migrationHarness({ donorFiles: {
    'bicep/infra/citadel-access-contracts/main.bicepparam': text,
    'bicep/infra/citadel-access-contracts/base-contracts/common/main.bicepparam': text,
  } });
  const inventory = await h.session.inventory(h.donor);
  assert.deepEqual(inventory.items, []);
  assert.deepEqual(inventory.unassigned, []);
  assert.equal(inventory.ignored, 2);
  assert(!h.donorTrace.some((entry) => entry.startsWith('read:')));
});

test('migration recognizes qualified legacy resources inputs without requiring every current parameter name', async () => {
  const h = migrationHarness({ donorFiles: {
    'older/bicep/infra/resources.bicepparam': "using './resources.bicep'\nparam environmentName = 'old'\nparam logicAppsSkuName = 'legacy'\n",
    'another-module/resources.bicepparam': "param environmentName = 'not-a-deployment-proof'\n",
  } });
  const inventory = await h.session.inventory(h.donor);
  assert.deepEqual(inventory.items.map((item) => [item.area, item.alias]), [
    ['deployment', 'older/bicep/infra/resources.bicepparam'],
  ]);
  assert.equal(inventory.otherFiles.length, 1);
});

test('migration source inventory leaves loose files unassigned and reports malformed input without raw values', async () => {
  const h = migrationHarness();
  const donor = new MigrationDonor({ files: [
    new MigrationFileHandle('main.bicepparam', "param count = 4\nparam label = 'SYNTHETIC_PRIVATE_MARKER'\n"),
    new MigrationFileHandle('broken.bicepparam', "param label = 'SYNTHETIC_PRIVATE_MARKER\n"),
  ] });
  const inventory = await h.session.inventory(donor);
  assert.deepEqual(inventory.items, []);
  assert.equal(inventory.unassigned.length, 1);
  assert.equal(inventory.unassigned[0].id, 'file-1');
  assert.equal(inventory.unassigned[0].parameters, 2);
  assert.equal(inventory.issues.length, 1);
  assert.match(inventory.issues[0].reason, /malformed or uses unsupported/);
  assert.doesNotMatch(JSON.stringify(inventory), /SYNTHETIC_PRIVATE_MARKER/);
});

test('migration source inventory proves distinct identity before reading and does not hide read failures as an empty result', async () => {
  const h = migrationHarness();
  await assert.rejects(h.session.inventory(new MigrationDonor({ folder: h.root.alias('old-label') })), { code: 'identity' });
  assert(!h.targetTrace.some((entry) => entry.startsWith('read:')));
  const denied = new MigrationFileHandle('main.bicepparam', 'param count = 4\n');
  denied.getFile = async () => { throw new DOMException('SYNTHETIC_PRIVATE_MARKER', 'NotReadableError'); };
  await assert.rejects(h.session.inventory(new MigrationDonor({ files: [denied] })), { code: 'unavailable' });
  assert.equal(h.api.trace.length, 0);
});

test('migration source inventory discards stale asynchronous extraction and preserves pending editor work', async () => {
  const h = migrationHarness({ donorFiles: { [TARGET]: 'param Count = 4\n' } });
  const gate = deferred();
  const entered = deferred();
  const handle = await h.donor.handle(TARGET);
  handle.beforeRead = async () => { entered.resolve(); await gate.promise; };
  const pending = h.session.inventory(h.donor);
  await entered.promise;
  h.session.invalidate();
  gate.resolve();
  await assert.rejects(pending, { code: 'stale' });
  h.state.pending = true;
  await assert.rejects(h.session.inventory(h.donor), { code: 'pending' });
  assert.equal(h.api.trace.length, 0);
});

test('migration Access pairing writes only the explicitly chosen existing instance and reports its own old-only names', async () => {
  const root = 'bicep/infra/citadel-access-contracts';
  const first = `${root}/synthetic-a/main.bicepparam`;
  const second = `${root}/synthetic-b/main.bicepparam`;
  const h = migrationHarness({
    targetFiles: {
      [`${root}/main.bicep`]: 'param label string\n',
      [first]: "using '../main.bicep'\n// first current contract\nparam label = 'current-a'\n",
      [second]: "using '../main.bicep'\nparam label = 'current-b'\n",
      [`${root}/base-contracts/common/main.bicepparam`]: "using '../../main.bicep'\nparam label = 'base'\n",
    },
    donorFiles: {
      'old-a/main.bicepparam': "param label = 'accepted-a'\nparam retiredA = true\n",
      'old-b/main.bicepparam': "param label = 'not-selected-b'\nparam retiredB = true\n",
    },
  });
  const view = await h.plan({ targetAlias: first, sourceIds: ['old-a/main.bicepparam'] });
  assert.equal(view.target.kind, 'Access Contracts - existing instance');
  assert.deepEqual(view.pairs[0].oldOnlyNames, ['retiredA']);
  assert.equal(view.pairs[0].source.file, 'old-a/main.bicepparam');
  assert.equal(view.pairs[0].target.file, first);
  const selected = view.rows.find((row) => row.name === 'label');
  assert.equal(selected.candidates.length, 1);
  h.session.decide(selected.id, { kind: 'accept', candidateId: selected.candidates[0].id, semanticReviewed: true });
  const preview = await h.session.preview();
  await h.session.apply(preview.id, { reviewed: true });
  assert.match((await h.provider.read(first)).text, /label = 'accepted-a'/);
  assert.match((await h.provider.read(second)).text, /label = 'current-b'/);
  assert.equal(h.targetTrace.filter((entry) => entry.startsWith('write:')).length, 1);
  assert(!h.donorTrace.some((entry) => /^(?:write|writable):/.test(entry)));
  await assert.rejects(h.plan({
    targetAlias: `${root}/base-contracts/common/main.bicepparam`,
    sourceIds: ['old-a/main.bicepparam'],
  }), { code: 'scope' });
});

test('migration missing destination template is a visible unresolved target, not invented schema', async () => {
  const h = migrationHarness({ targetFiles: { [TARGET]: CURRENT } });
  const targets = await h.session.targets();
  assert.equal(targets[0].state, 'unresolved');
  const view = await h.plan();
  assert.equal(view.target.resolved, false);
  assert.equal(view.rows[0].candidates[0].eligible, false);
  h.session.keepRemaining();
  const preview = await h.session.preview();
  assert.equal(preview.canApply, false);
  assert(preview.report.unverified.some((entry) => entry.code === 'unknown-schema'));
  assert.equal(preview.canApply, false);
});

test('migration same folder under another label and overlapping ancestor/descendant roots are rejected by identity', async () => {
  for (const make of [
    async (h) => ({ folder: h.root.alias('different-label'), id: TARGET }),
    async (h) => ({ folder: new MigrationDirectoryHandle('outer', { nested: h.root }), id: `nested/${TARGET}` }),
    async (h) => ({ folder: await h.root.getDirectoryHandle('bicep'), id: 'infra/main.bicepparam' }),
  ]) {
    const h = migrationHarness();
    const selected = await make(h);
    const donor = new MigrationDonor({ folder: selected.folder });
    await assert.rejects(h.plan({ donor, sourceIds: [selected.id] }), { code: 'identity' });
    assert.equal(h.api.trace.length, 0);
    assert(h.targetTrace.every((event) => !event.startsWith('read:')), 'identity must be checked before contents');
  }
});

test('migration explicit file handles catch the same selected file under aliases and any file inside the destination root', async () => {
  const h = migrationHarness();
  const target = await h.provider.fileHandle(TARGET);
  const sameTarget = new MigrationDonor({ files: [target.alias('old.bicepparam')] });
  await assert.rejects(h.plan({ donor: sameTarget, sourceIds: ['file-1'] }), { code: 'identity' });
  const file = new MigrationFileHandle('one.bicepparam', LEGACY);
  const repeated = new MigrationDonor({ files: [file, file.alias('two.bicepparam')] });
  await assert.rejects(repeated.entries(), { code: 'identity' });
  assert.equal(h.api.trace.length, 0);
});

test('migration rejects unknown handle identity instead of trusting labels or paths', async () => {
  const h = migrationHarness();
  h.root.resolve = undefined;
  await assert.rejects(h.plan(), { code: 'identity' });
  assert.equal(h.api.trace.length, 0);
});

test('migration different explicit files with identical names remain separately selectable candidates', async () => {
  const h = migrationHarness();
  const donor = new MigrationDonor({ files: [
    new MigrationFileHandle('main.bicepparam', 'param count = 3\n'),
    new MigrationFileHandle('main.bicepparam', 'param count = 5\n'),
  ] });
  const view = await h.plan({ donor, sourceIds: ['file-1', 'file-2'] });
  const row = view.rows.find((entry) => entry.name === 'Count');
  assert.equal(row.candidates.length, 2);
  assert.notEqual(row.candidates[0].source.fileId, row.candidates[1].source.fileId);
  assert(row.categories.includes('ambiguous'));
});

test('migration ambiguous or unreadable donor templates cannot silently lose secure metadata', async () => {
  const h = migrationHarness();
  const donor = new MigrationDonor({ files: [
    new MigrationFileHandle('main.bicepparam', LEGACY),
    new MigrationFileHandle('legacy.bicep', 'param count int\n'),
    new MigrationFileHandle('legacy.bicep', '@secure()\nparam count int\n'),
  ] });
  await assert.rejects(h.plan({ donor, sourceIds: ['file-1'] }), { code: 'donor-template' });
  const template = new MigrationFileHandle('legacy.bicep', '@secure()\nparam count int\n');
  template.getFile = async () => { throw new DOMException('SYNTHETIC_PRIVATE_MARKER', 'NotReadableError'); };
  h.donorRoot.children.set('legacy.bicep', template);
  await assert.rejects(h.plan(), (error) => error.code === 'unavailable' && !error.message.includes('SYNTHETIC_PRIVATE_MARKER'));
  assert.equal(h.api.trace.length, 0);
});

test('migration file picker scope, declared size, actual byte size, and JSON envelope are enforced', async () => {
  for (const name of ['script.ps1', '.env', '../outside.bicepparam', 'arbitrary.xml']) {
    assert.throws(() => new MigrationDonor({ files: [new MigrationFileHandle(name, '')] }), { code: 'scope' });
  }
  const large = new MigrationFileHandle('big.json');
  large.getFile = async () => ({ size: MIGRATION_LIMITS.bytes + 1, arrayBuffer: async () => { throw new Error('must not read'); } });
  await assert.rejects(new MigrationDonor({ files: [large] }).read('file-1'), { code: 'limit' });
  large.getFile = async () => ({ size: 1, arrayBuffer: async () => new Uint8Array(MIGRATION_LIMITS.bytes + 1).buffer });
  await assert.rejects(new MigrationDonor({ files: [large] }).read('file-1'), { code: 'limit' });
  const h = migrationHarness();
  const donor = new MigrationDonor({ files: [new MigrationFileHandle('data.json', '{"count":3}')] });
  await assert.rejects(h.plan({ donor, sourceIds: ['file-1'] }), { code: 'envelope' });
});

test('migration target saved drafts and pending editor work survive launch and apply guards', async () => {
  const h = migrationHarness();
  h.state.pending = true;
  await assert.rejects(h.session.targets(), { code: 'pending' });
  h.state.pending = false;
  h.state.draft = { operations: [{ op: 'set', path: ['Count'], value: 7 }] };
  await assert.rejects(h.plan(), { code: 'pending' });
  assert.equal(h.state.draft.operations[0].value, 7);
  h.state.draft = null;
  const preview = await acceptCount(h);
  h.state.pending = true;
  await assert.rejects(h.session.apply(preview.id, { reviewed: true }), { code: 'pending' });
  assert.equal(h.api.trace.length, 0);
});

test('migration current LLM field metadata disables nested type-unsafe candidates before selection', async () => {
  const h = migrationHarness({
    targetText: "using './main.bicep'\nparam llmBackendConfig = []\n",
    schemaText: 'param llmBackendConfig array = []\n',
    donorText: "param llmBackendConfig = [{ backendId: 'synthetic' backendType: 'ai-foundry' endpoint: 'https://example.invalid' priority: '3' supportedModels: [{ name: 'synthetic-model' timeout: false }] }]\n",
  });
  const view = await h.plan();
  const row = view.rows[0];
  assert.equal(row.candidates[0].eligible, false);
  assert.equal(row.candidates[0].category, 'mismatch');
  assert(row.candidates[0].problems.some((problem) => problem.includes('priority')));
  assert(row.candidates[0].problems.some((problem) => problem.includes('timeout')));
  assert.throws(() => h.session.decide(row.id, {
    kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true,
  }), { code: 'decision' });
});

test('migration current LLM provider, auth, model and affinity choices gate real reviewed onboarding writes', async () => {
  const alias = 'bicep/infra/llm-backend-onboarding/main.bicepparam';
  const backend = {
    ...backendTemplate('ai-foundry'), endpoint: 'https://synthetic.example.invalid',
    supportedModels: [{ name: 'synthetic-model', sku: 'Standard', modelFormat: 'OpenAI' }],
  };
  for (const [name, value] of [
    ['llmBackendConfig', [{ ...backend, authType: 'SYNTHETIC_INVALID_AUTH' }]],
    ['llmBackendConfig', [{ ...backend, supportedModels: [{ name: 'synthetic-model', sku: 'INVALID_SKU' }] }]],
    ['sessionAffinityDefaults', { source: 'INVALID_SOURCE' }],
  ]) {
    const h = migrationHarness({
      targetFiles: {
        [alias]: "using './main.bicep'\nparam llmBackendConfig = []\nparam sessionAffinityDefaults = { source: 'Cookie' }\n",
        [alias.replace(/\.bicepparam$/, '.bicep')]: "param llmBackendConfig array = []\nparam sessionAffinityDefaults object = { source: 'Cookie' }\n",
      },
      donorText: `param ${name} = ${serializeValue(value)}\n`,
    });
    const view = await h.plan({ targetAlias: alias });
    assert.equal(view.rows.find((row) => row.name === name).candidates[0].eligible, false);
    assert.equal(h.api.trace.length, 0);
  }
  const h = migrationHarness({
    targetFiles: {
      [alias]: "using './main.bicep'\n// preserve current onboarding\nparam llmBackendConfig = []\n",
      [alias.replace(/\.bicepparam$/, '.bicep')]: 'param llmBackendConfig array = []\n',
    },
    donorText: `param llmBackendConfig = ${serializeValue([backend])}\n`,
  });
  const view = await h.plan({ targetAlias: alias });
  const row = view.rows[0];
  assert.equal(view.target.area, 'llm-onboarding');
  assert.equal(row.candidates[0].eligible, false);
  assert.equal(row.structured.backends.length, 0);
  assert.throws(() => h.session.decide(row.id, { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true }), { code: 'decision' });
  const preview = await h.session.previewSelected();
  assert.equal(preview.canApply, false);
  assert.equal(preview.changed, false);
  assert.match((await h.provider.read(alias)).text, /preserve current onboarding/);
  assert.equal(h.targetTrace.filter((entry) => entry.startsWith('write:')).length, 0);
  assert(!h.donorTrace.some((entry) => /^(?:write|writable):/.test(entry)));
});

test('migration draft, report, and diff redact donor material and never persist donor blobs', async () => {
  const marker = 'SYNTHETIC_PRIVATE_MARKER';
  const h = migrationHarness({
    donorText: `${LEGACY}param secretValue = '${marker}'\nparam nested = { config: { password: '${marker}' } }\n`,
    targetText: `// ${marker} in destination comment is also withheld\n${CURRENT}`,
  });
  const preview = await acceptCount(h);
  for (const object of [
    h.session.view(), preview,
    await h.session.export(preview.id, 'report'),
    await h.session.export(preview.id, 'draft'),
  ]) assert(!JSON.stringify(object).includes(marker));
  assert.equal(h.api.bodies.length, 0);
  assert.equal(h.state.draft, null);
  assert.equal(preview.report.binding.sources.length, 1);
  assert.equal(preview.report.binding.target.hash.length, 64);
  assert.equal(preview.report.destination.providerId.length > 0, true);
});

test('migration exports report only the name and metadata of unrecognized donor settings while unrelated matches apply', async () => {
  const marker = 'UNUSED_PRIVATE_CONFIGURATION_MARKER';
  const h = migrationHarness({ donorText: `param count = 4\nparam obsoleteSetting = '${marker}'\n` });
  const preview = await acceptCount(h);
  assert.deepEqual(preview.report.pairs[0].oldOnlyNames, ['obsoleteSetting']);
  for (const output of [h.session.view(), preview, await h.session.export(preview.id, 'report'), await h.session.export(preview.id, 'draft')]) {
    assert(!JSON.stringify(output).includes(marker));
  }
  await h.session.apply(preview.id, { reviewed: true });
  assert.equal(h.targetTrace.filter((entry) => entry.startsWith('write:')).length, 1);
  assert.doesNotMatch((await h.provider.read(TARGET)).text, /obsoleteSetting|UNUSED_PRIVATE_CONFIGURATION_MARKER/);
});

test('migration public guidance, provenance and reports are detached from private plans and reviewed decisions', async () => {
  const h = migrationHarness({ schemaText: '@allowed([2,4])\nparam Count int\nparam newDefault bool = true\n' });
  const preview = await acceptCount(h);
  const view = h.session.view();
  view.rows[0].guidance.allowedValues.push(7);
  view.rows[0].candidates[0].source.file = 'changed-outside-the-session';
  preview.report.summary.copied = 900;
  preview.report.blockers.push({ name: 'Count', code: 'injected' });
  const report = JSON.parse((await h.session.export(preview.id, 'report')).text);
  assert.equal(report.summary.copied, 0);
  assert.equal(report.summary.proposedEdits, 1);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.rows[0].candidates[0].source.file, 'main.bicepparam');
  assert.deepEqual(report.rows[0].guidance.allowedValues, [2, 4]);
});

for (const subject of ['donor', 'target', 'schema', 'workspace', 'project', 'provider', 'folder-label']) {
  test(`migration stale ${subject} invalidates decisions before export/apply`, async () => {
    const h = migrationHarness();
    const preview = await acceptCount(h);
    if (subject === 'donor') (await h.donorRoot.getFileHandle('main.bicepparam')).replace('param count = 7\n');
    if (subject === 'target') (await h.provider.fileHandle(TARGET)).replace(CURRENT.replace('Count = 2', 'Count = 7'));
    if (subject === 'schema') (await h.provider.fileHandle(TEMPLATE)).replace('@maxValue(3)\nparam Count int\n');
    if (subject === 'workspace') h.state.context = { ...h.context };
    if (subject === 'project') h.context.projectId = 'another-project';
    if (subject === 'provider') h.context.provider = new BrowserDirectoryProvider(h.root);
    if (subject === 'folder-label') h.context.environment.source.folderName = 'a-changed-label';
    await assert.rejects(h.session.export(preview.id, 'report'), { code: 'stale' });
    await assert.rejects(h.session.apply(preview.id, { reviewed: true }));
    assert.equal(h.api.trace.length, 0);
  });
}

test('migration donor template changes or newly available schema invalidate sensitivity decisions', async () => {
  const h = migrationHarness();
  const preview = await acceptCount(h);
  h.donorRoot.children.set('legacy.bicep', new MigrationFileHandle('legacy.bicep', '@secure()\nparam count int\n'));
  await assert.rejects(h.session.export(preview.id, 'draft'), { code: 'stale' });
  const fresh = await h.plan();
  assert.equal(fresh.rows[0].candidates[0].category, 'sensitive');
});

test('migration file identity changes invalidate even identical replacement bytes', async () => {
  const h = migrationHarness();
  const preview = await acceptCount(h);
  h.donorRoot.children.set('main.bicepparam', new MigrationFileHandle('main.bicepparam', LEGACY));
  await assert.rejects(h.session.preview(), { code: 'stale' });
  await assert.rejects(h.session.export(preview.id, 'report'), { code: 'review' });
});

test('migration selecting another donor/file pair invalidates the previous preview token', async () => {
  const h = migrationHarness();
  const preview = await acceptCount(h);
  const donor = new MigrationDonor({ files: [new MigrationFileHandle('main.bicepparam', 'param count = 8\n')] });
  await h.plan({ donor, sourceIds: ['file-1'] });
  await assert.rejects(h.session.apply(preview.id, { reviewed: true }), { code: 'review' });
  assert.equal(h.api.trace.length, 0);
});

test('migration slow planning cannot publish into a switched workspace or superseded file selection', async () => {
  for (const change of ['workspace', 'selection']) {
    const h = migrationHarness();
    const gate = deferred();
    const entered = deferred();
    const file = await h.donorRoot.getFileHandle('main.bicepparam');
    file.beforeRead = async () => { entered.resolve(); await gate.promise; };
    const planning = h.plan();
    await entered.promise;
    if (change === 'workspace') h.state.context = { ...h.context };
    else h.session.invalidate();
    gate.resolve();
    await assert.rejects(planning, { code: 'stale' });
    assert.equal(h.api.trace.length, 0);
  }
});

test('migration uses the real local prepare/backup/authorize/write/receipt path, not a direct write', async () => {
  const h = migrationHarness();
  const preview = await acceptCount(h);
  const result = await h.session.apply(preview.id, { reviewed: true });
  assert.equal(result.transactionId, 'synthetic-migration-transaction');
  assert.deepEqual(h.api.trace, ['prepare', 'backup', 'authorize', 'committing', 'receipt']);
  assert.equal((await h.provider.read(TARGET)).text, CURRENT.replace('Count = 2', 'Count = 4'));
  assert.equal((await h.donorRoot.getFileHandle('main.bicepparam')).text(), LEGACY);
  assert.equal(h.api.bodies[0].body.targetLabel, 'parameter-migration');
  assert.deepEqual(h.api.bodies[0].body.changedAliases, [TARGET]);
  assert.deepEqual(h.api.bodies[0].body.changedNames, { [TARGET]: ['Count'] });
  assert(h.donorTrace.every((entry) => !/writable|write:|readwrite|create=true/.test(entry)));
});

test('migration destination BOM survives the surgical local apply', async () => {
  const h = migrationHarness({ targetText: `\uFEFF${CURRENT}` });
  const preview = await acceptCount(h);
  await h.session.apply(preview.id, { reviewed: true });
  const target = await h.provider.fileHandle(TARGET);
  assert.deepEqual([...target.entry.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('migration receipt failure restores original destination bytes through transaction backups', async () => {
  const h = migrationHarness({ hooks: { receipt: async () => { throw new Error('Synthetic receipt failure'); } } });
  const preview = await acceptCount(h);
  await assert.rejects(h.session.apply(preview.id, { reviewed: true }), { code: 'apply-failed' });
  assert.equal((await h.provider.read(TARGET)).text, CURRENT);
  assert.deepEqual(h.api.trace, ['prepare', 'backup', 'authorize', 'committing', 'receipt', 'restore-backup', 'rollback']);
  assert(h.donorTrace.every((entry) => !/writable|write:|readwrite|create=true/.test(entry)));
});

test('migration backup failure prevents any destination write', async () => {
  const h = migrationHarness({ hooks: { backup: async () => { throw new Error('SYNTHETIC_PRIVATE_MARKER'); } } });
  const preview = await acceptCount(h);
  await assert.rejects(h.session.apply(preview.id, { reviewed: true }), (error) =>
    error.code === 'apply-failed' && !error.message.includes('SYNTHETIC_PRIVATE_MARKER'));
  assert(!h.targetTrace.some((event) => event.startsWith('writable:')));
  assert.equal((await h.provider.read(TARGET)).text, CURRENT);
});

test('migration donor/schema/workspace changes during transaction authorization are checked again before writing', async () => {
  for (const subject of ['donor', 'schema', 'workspace']) {
    const hooks = {};
    const h = migrationHarness({ hooks });
    const preview = await acceptCount(h);
    hooks.authorize = async () => {
      if (subject === 'donor') (await h.donorRoot.getFileHandle('main.bicepparam')).replace('param count = 8\n');
      if (subject === 'schema') (await h.provider.fileHandle(TEMPLATE)).replace('param Count string\n');
      if (subject === 'workspace') h.state.context = { ...h.context };
    };
    await assert.rejects(h.session.apply(preview.id, { reviewed: true }), { code: 'stale' });
    assert(!h.targetTrace.some((event) => event.startsWith('writable:')));
    assert.equal(h.api.trace.at(-1), 'fail');
  }
});

test('migration workspace switch during committing cannot retarget the already captured local write', async () => {
  const hooks = {};
  const h = migrationHarness({ hooks });
  const preview = await acceptCount(h);
  hooks.committing = async () => { h.state.context = { ...h.context }; };
  await assert.rejects(h.session.apply(preview.id, { reviewed: true }), { code: 'stale' });
  assert(!h.targetTrace.some((event) => event.startsWith('writable:')));
  assert.equal((await h.provider.read(TARGET)).text, CURRENT);
  assert.equal(h.api.trace.at(-1), 'rollback');
});

test('migration rechecks asynchronous permission and staged writable-stream boundaries before publishing bytes', async () => {
  for (const phase of ['permission', 'open-stream', 'stage-bytes']) {
    const h = migrationHarness();
    const preview = await acceptCount(h);
    if (phase === 'permission') {
      h.provider.assertWritable = async () => { h.state.context = { ...h.context }; };
    } else {
      const file = await h.provider.fileHandle(TARGET);
      const createWritable = file.createWritable.bind(file);
      file.createWritable = async (...args) => {
        const stream = await createWritable(...args);
        if (phase === 'open-stream') h.state.context = { ...h.context };
        else {
          const write = stream.write;
          stream.write = async (...values) => { await write(...values); h.state.context = { ...h.context }; };
        }
        return stream;
      };
    }
    await assert.rejects(h.session.apply(preview.id, { reviewed: true }), { code: 'stale' });
    assert.equal((await h.provider.read(TARGET)).text, CURRENT);
    assert(!h.targetTrace.some((event) => event.startsWith('write:')));
    if (phase !== 'permission') assert(h.targetTrace.some((event) => event.startsWith('abort:')));
  }
});

test('migration repeated apply clicks share one in-flight transaction and cannot replay its token', async () => {
  const gate = deferred();
  const entered = deferred();
  const h = migrationHarness({ hooks: { authorize: async () => { entered.resolve(); await gate.promise; } } });
  const preview = await acceptCount(h);
  const first = h.session.apply(preview.id, { reviewed: true });
  const second = h.session.apply(preview.id, { reviewed: true });
  assert.equal(first, second);
  await entered.promise;
  assert.throws(() => h.session.decide('target-1', { kind: 'keep' }), { code: 'review' });
  assert.equal(h.session.close(), false);
  gate.resolve();
  await first;
  assert.equal(h.api.trace.filter((event) => event === 'prepare').length, 1);
  await assert.rejects(h.session.apply(preview.id, { reviewed: true }), { code: 'review' });
});

function remoteHarness() {
  const h = migrationHarness();
  const revision = { head: 'a'.repeat(40), branch: 'review-current', repository: { id: 42, fullName: 'synthetic/current' } };
  let writes = 0;
  const provider = {
    remote: true,
    tree: async () => ({ ...revision, files: await h.provider.entries() }),
    entries: () => h.provider.entries(),
    read: (alias) => h.provider.read(alias),
    write: async () => { writes += 1; throw new Error('Remote writes are prohibited'); },
  };
  const context = {
    projectId: 'synthetic-remote-project', provider,
    environment: { id: 'synthetic-remote', label: 'Remote current', source: {
      kind: 'github', repositoryId: 42, fullName: 'synthetic/current', sourceBranch: 'main',
      workingBranch: 'review-current', writeMode: 'working-branch',
    } },
  };
  const session = new MigrationSession({
    contextProvider: () => context, registry: h.registry,
    coordinator: { commit: async () => { writes += 1; throw new Error('Remote commits are prohibited'); } },
  });
  return {
    ...h, session, context, revision,
    getWrites: () => writes,
    plan: () => session.plan({ donor: h.donor, sourceIds: ['main.bicepparam'], targetAlias: TARGET }),
  };
}

test('migration remote destinations allow fresh local exports but deny apply before any coordinator/provider write', async () => {
  const h = remoteHarness();
  const preview = await acceptCount(h);
  assert.equal(preview.canApply, false);
  assert.equal(preview.report.destination.revision.branch, 'review-current');
  assert.equal(preview.report.destination.revision.repositoryId, 42);
  assert.match((await h.session.export(preview.id, 'draft')).text, /param Count = 4/);
  await assert.rejects(h.session.apply(preview.id, { reviewed: true }), { code: 'remote' });
  assert.equal(h.getWrites(), 0);
  assert.equal(h.api.trace.length, 0);
});

test('migration remote branch/head/repository changes invalidate preview and exports', async () => {
  for (const field of ['head', 'branch', 'repository', 'workingBranch']) {
    const h = remoteHarness();
    const preview = await acceptCount(h);
    if (field === 'head') h.revision.head = 'b'.repeat(40);
    if (field === 'branch') h.revision.branch = 'another';
    if (field === 'repository') h.revision.repository = { id: 43, fullName: 'synthetic/another' };
    if (field === 'workingBranch') h.context.environment.source.workingBranch = 'another';
    await assert.rejects(h.session.export(preview.id, 'report'), { code: 'stale' });
    assert.equal(h.getWrites(), 0);
  }
});
