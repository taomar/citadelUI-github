import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  contractCreationBoundary, contractCreationDirectory, immutableManifestHash,
  normalizeChangedAliases, normalizeChangedNames, normalizeCreatedDirectories,
  normalizeFailedChangedAliases, normalizeManifestFiles, normalizeSourceAlias,
  publicManifest, serializeImmutableManifest, transactionError, transactionValidation,
  validateCommitPlan, validateReceipts,
} from '../server/transaction-manifest.mjs';
import * as facade from '../server/transactions.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const finalHash = '1'.repeat(64);
const now = Date.parse('2026-01-01T00:00:00.000Z');
const legacy = {
  version: 1, transactionId: 'tx-fixed', environmentId: 'env-one', environmentLabel: null,
  targetId: 'gateway', targetLabel: 'contract-create', status: 'preparing', recoveryRequired: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  changedAliases: ['policies/new.xml', 'bicep/main.bicepparam'],
  changedNames: { 'policies/new.xml': ['zeta', 'alpha'], 'bicep/main.bicepparam': ['enabled'] },
  createdDirectories: ['policies'], ownedCleanupDirectories: ['policies', 'bicep'],
  files: [
    { id: 'file-1', alias: 'bicep/main.bicepparam', existed: true, originalSize: 0, originalHash: emptyHash, backupVerified: true, finalSize: 7, finalHash, receiptVerified: false },
    { id: 'file-2', alias: 'policies/new.xml', existed: false, originalSize: 0, originalHash: null, backupVerified: false, finalSize: null, finalHash: null, receiptVerified: false },
  ],
  authorizedManifestHash: null, auditRecorded: false,
};
const omitted = structuredClone(legacy);
for (const key of ['changedNames', 'createdDirectories', 'ownedCleanupDirectories']) delete omitted[key];
const nulls = { ...omitted, changedNames: null, createdDirectories: null, ownedCleanupDirectories: null, configuration: null, nativeProof: { ignored: true } };
const configuration = {
  version: 1, format: 'terraform', profileId: 'native-profile', revision: 1,
  units: [{ id: 'deployment-unit', area: 'deployment', rootAlias: '', valueAlias: 'environments/operator.tfvars', syntax: 'hcl-tfvars', allowCreate: true, nonsecret: true }],
};
const native = {
  ...legacy, configuration,
  nativeProof: { version: 1, configuration: JSON.stringify(configuration), units: [
    { unitId: 'deployment-unit', valueAlias: 'environments/operator.tfvars', dependencies: [
      { alias: 'main.tf', hash: '2'.repeat(64) }, { alias: 'variables.tf', hash: '3'.repeat(64) },
    ], sensitiveParameters: [] },
  ] },
  changedAliases: ['environments/operator.tfvars'],
  changedNames: { 'environments/operator.tfvars': ['enabled'] },
  createdDirectories: ['environments'], ownedCleanupDirectories: ['environments'],
  files: [{ ...legacy.files[1], id: 'file-1', alias: 'environments/operator.tfvars' }],
};

// Captured from a4abe053's incumbent hash input before extraction, not from these helpers.
const snapshots = [
  {
    name: 'legacy creation and receipt metadata', manifest: legacy,
    json: '{"version":1,"transactionId":"tx-fixed","environmentId":"env-one","targetId":"gateway","changedAliases":["policies/new.xml","bicep/main.bicepparam"],"changedNames":{"policies/new.xml":["zeta","alpha"],"bicep/main.bicepparam":["enabled"]},"createdDirectories":["policies"],"ownedCleanupDirectories":["policies","bicep"],"files":[{"id":"file-1","alias":"bicep/main.bicepparam","existed":true,"originalSize":0,"originalHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"id":"file-2","alias":"policies/new.xml","existed":false,"originalSize":0,"originalHash":null}]}',
    digest: '7f6674025d15cb8ad19b2e9ff64124cbc98748fcf0ab5cad658596208bedb2f7',
  },
  {
    name: 'omitted legacy optional fields', manifest: omitted,
    json: '{"version":1,"transactionId":"tx-fixed","environmentId":"env-one","targetId":"gateway","changedAliases":["policies/new.xml","bicep/main.bicepparam"],"files":[{"id":"file-1","alias":"bicep/main.bicepparam","existed":true,"originalSize":0,"originalHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"id":"file-2","alias":"policies/new.xml","existed":false,"originalSize":0,"originalHash":null}]}',
    digest: '4f5fbca4ee8434b196aad9b2685ac691dd9902c352c8bfee0fc7949a035dacd3',
  },
  {
    name: 'explicit nulls and unbound proof', manifest: nulls,
    json: '{"version":1,"transactionId":"tx-fixed","environmentId":"env-one","targetId":"gateway","changedAliases":["policies/new.xml","bicep/main.bicepparam"],"changedNames":null,"createdDirectories":null,"ownedCleanupDirectories":null,"files":[{"id":"file-1","alias":"bicep/main.bicepparam","existed":true,"originalSize":0,"originalHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"id":"file-2","alias":"policies/new.xml","existed":false,"originalSize":0,"originalHash":null}]}',
    digest: 'bcd24214e37208a08dcd060fa574afe0ab14756afe3ca27cd9d43e14267b012a',
  },
  {
    name: 'native bindings and ordered dependency proof', manifest: native,
    json: String.raw`{"version":1,"transactionId":"tx-fixed","environmentId":"env-one","targetId":"gateway","changedAliases":["environments/operator.tfvars"],"changedNames":{"environments/operator.tfvars":["enabled"]},"createdDirectories":["environments"],"ownedCleanupDirectories":["environments"],"configuration":{"version":1,"format":"terraform","profileId":"native-profile","revision":1,"units":[{"id":"deployment-unit","area":"deployment","rootAlias":"","valueAlias":"environments/operator.tfvars","syntax":"hcl-tfvars","allowCreate":true,"nonsecret":true}]},"nativeProof":{"version":1,"configuration":"{\"version\":1,\"format\":\"terraform\",\"profileId\":\"native-profile\",\"revision\":1,\"units\":[{\"id\":\"deployment-unit\",\"area\":\"deployment\",\"rootAlias\":\"\",\"valueAlias\":\"environments/operator.tfvars\",\"syntax\":\"hcl-tfvars\",\"allowCreate\":true,\"nonsecret\":true}]}","units":[{"unitId":"deployment-unit","valueAlias":"environments/operator.tfvars","dependencies":[{"alias":"main.tf","hash":"2222222222222222222222222222222222222222222222222222222222222222"},{"alias":"variables.tf","hash":"3333333333333333333333333333333333333333333333333333333333333333"}],"sensitiveParameters":[]}]},"files":[{"id":"file-1","alias":"environments/operator.tfvars","existed":false,"originalSize":0,"originalHash":null}]}`,
    digest: 'b265654d2caa217d1d43d130a55ff1864301cb0e480404daef6739dbff26453f',
  },
];

for (const { name, manifest, json, digest } of snapshots) {
  test(`T6 manifest exact immutable bytes: ${name}`, () => {
    const before = structuredClone(manifest);
    assert.equal(serializeImmutableManifest(manifest), json);
    assert.equal(hash(json), digest);
    assert.equal(immutableManifestHash(manifest), digest);
    assert.deepEqual(manifest, before);
  });

  test(`T6 manifest facade reads and authorizes an incumbent journal: ${name}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'citadel-manifest-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const options = { dataRoot: root, now: () => now, ...(manifest.configuration ? {
      getEnvironment: async () => ({ configuration: manifest.configuration }),
    } : {}) };
    const store = new facade.TransactionStore(options);
    await store.initialize();
    const { environmentId, transactionId } = manifest;
    const manifestPath = store.manifestPath(environmentId, transactionId);
    const originalJournal = `${JSON.stringify(manifest, null, 2)}\n`;
    await facade.atomicWrite(manifestPath, originalJournal);
    await facade.atomicWrite(store.secretPath(environmentId, transactionId), JSON.stringify({
      transactionTokenHash: hash('test-token'),
    }));
    await facade.atomicWrite(store.leasePath(environmentId), JSON.stringify({
      transactionId, status: 'active', expiresAt: '2026-01-01T00:05:00.000Z',
    }));
    for (const file of manifest.files.filter((entry) => entry.existed)) {
      await facade.atomicWrite(join(store.transactionRoot(environmentId, transactionId), 'files', `${file.id}.backup`), '');
    }
    assert.equal(JSON.stringify(await store.getTransaction(environmentId, transactionId)), JSON.stringify(manifest));
    assert.equal(JSON.stringify((await store.history(environmentId))[0]), JSON.stringify(manifest));
    assert.equal(await readFile(manifestPath, 'utf8'), originalJournal, 'reads do not migrate an incumbent journal');
    const authorization = await store.authorize(environmentId, transactionId, 'test-token');
    assert.equal(authorization.manifestHash, digest);
    const expectedAuthorized = { ...manifest, status: 'authorized', authorizedManifestHash: digest };
    assert.equal(await readFile(manifestPath, 'utf8'), `${JSON.stringify(expectedAuthorized, null, 2)}\n`);
    const restarted = new facade.TransactionStore(options);
    assert.equal(JSON.stringify(await restarted.getTransaction(environmentId, transactionId)), JSON.stringify(expectedAuthorized));
    await restarted.beginCommit(environmentId, transactionId, authorization.authorizationToken, {
      manifestHash: digest,
      files: manifest.files.map((file) => ({ alias: file.alias, originalHash: file.originalHash, finalHash, finalSize: 7 })),
    });
    await restarted.commitReceipt(environmentId, transactionId, authorization.authorizationToken, {
      receipts: manifest.files.map((file) => ({ alias: file.alias, hash: finalHash, size: 7 })),
    });
    const committed = await restarted.getTransaction(environmentId, transactionId);
    assert.equal(committed.status, 'committed');
    assert.equal(committed.auditRecorded, true);
    assert.equal(immutableManifestHash(committed), digest);
    assert.ok(committed.files.every((file) => file.receiptVerified));
    await assert.rejects(readFile(store.leasePath(environmentId)), { code: 'ENOENT' });
  });
}

test('T6 manifest public projection preserves serialized receipt fields and clones undefined without JSON loss', () => {
  const expected = '{"version":1,"transactionId":"tx-fixed","environmentId":"env-one","environmentLabel":null,"targetId":"gateway","targetLabel":"contract-create","status":"preparing","recoveryRequired":false,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","changedAliases":["policies/new.xml","bicep/main.bicepparam"],"changedNames":{"policies/new.xml":["zeta","alpha"],"bicep/main.bicepparam":["enabled"]},"createdDirectories":["policies"],"ownedCleanupDirectories":["policies","bicep"],"files":[{"id":"file-1","alias":"bicep/main.bicepparam","existed":true,"originalSize":0,"originalHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","backupVerified":true,"finalSize":7,"finalHash":"1111111111111111111111111111111111111111111111111111111111111111","receiptVerified":false},{"id":"file-2","alias":"policies/new.xml","existed":false,"originalSize":0,"originalHash":null,"backupVerified":false,"finalSize":null,"finalHash":null,"receiptVerified":false}],"authorizedManifestHash":null,"auditRecorded":false}';
  assert.equal(JSON.stringify(publicManifest(legacy)), expected);
  const input = { ...native, extension: undefined, recoveryNotes: [undefined, null] };
  const result = publicManifest(input);
  assert.deepEqual(result, input);
  assert.ok(Object.hasOwn(result, 'extension'));
  assert.equal(result.extension, undefined);
  assert.equal(result.recoveryNotes[0], undefined);
  result.nativeProof.units[0].dependencies.reverse();
  result.files[0].receiptVerified = true;
  assert.equal(input.nativeProof.units[0].dependencies[0].alias, 'main.tf');
  assert.equal(input.files[0].receiptVerified, false);
});

test('T6 manifest immutable hash omits undefined, ignores lifecycle fields and preserves nested order', () => {
  const undefinedFields = { ...omitted, changedNames: undefined, createdDirectories: undefined, ownedCleanupDirectories: undefined };
  assert.equal(serializeImmutableManifest(undefinedFields), snapshots[1].json);
  assert.equal(immutableManifestHash(undefinedFields), snapshots[1].digest);
  const terminal = { ...legacy, status: 'rolled_back', recoveryRequired: true, auditRecorded: true,
    environmentLabel: 'Renamed', targetLabel: null, authorizedManifestHash: 'ignored',
    committedAt: 'later', updatedAt: 'later', failedChangedAliases: ['policies/new.xml'],
    revertCleanupDirectories: ['policies'], rolledBackAt: 'later',
    files: legacy.files.map((file) => ({ ...file, finalHash: emptyHash, finalSize: 0, receiptVerified: true, backupVerified: true })),
  };
  assert.equal(serializeImmutableManifest(terminal), snapshots[0].json);
  assert.equal(immutableManifestHash(terminal), snapshots[0].digest);
  for (const change of [
    (value) => value.files.reverse(),
    (value) => value.changedAliases.reverse(),
    (value) => value.changedNames['policies/new.xml'].reverse(),
    (value) => { value.changedNames = Object.fromEntries(Object.entries(value.changedNames).reverse()); },
    (value) => value.createdDirectories.push('other'),
    (value) => value.ownedCleanupDirectories.reverse(),
  ]) {
    const value = structuredClone(legacy);
    change(value);
    assert.notEqual(immutableManifestHash(value), snapshots[0].digest);
  }
  const reorderedProof = structuredClone(native);
  reorderedProof.nativeProof.units[0].dependencies.reverse();
  assert.notEqual(immutableManifestHash(reorderedProof), snapshots[3].digest);
  const noProof = { ...native, nativeProof: undefined };
  assert.equal(Object.hasOwn(JSON.parse(serializeImmutableManifest(noProof)), 'nativeProof'), false);
  assert.equal(JSON.parse(serializeImmutableManifest({ ...native, nativeProof: null })).nativeProof, null);
});

function rejects(work, code, message, status = 400) {
  assert.throws(work, (error) => {
    assert.equal(Object.getPrototypeOf(error), Error.prototype);
    assert.equal(error.name, 'Error');
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
}

test('T6 manifest facades retain alias and error identity and the validation descriptor', () => {
  assert.equal(facade.normalizeSourceAlias, normalizeSourceAlias);
  assert.equal(facade.transactionError, transactionError);
  assert.equal(facade.transactionValidation, transactionValidation);
  assert.equal(Object.isFrozen(transactionValidation), true);
  assert.deepEqual(transactionValidation.allowedExtensions, ['.bicep', '.bicepparam', '.xml']);
  assert.equal(transactionValidation.normalizeSourceAlias, normalizeSourceAlias);
  assert.equal(normalizeSourceAlias('Folder/FILE.XML'), 'Folder/FILE.XML');
  for (const [alias, code, message] of [
    [null, 'INVALID_ALIAS', 'Invalid source alias.'],
    ['C:/main.xml', 'INVALID_ALIAS', 'Source aliases must be relative POSIX paths.'],
    ['a\\main.xml', 'INVALID_ALIAS', 'Source aliases must be relative POSIX paths.'],
    ['a/../main.xml', 'INVALID_ALIAS', 'Source alias contains an unsafe segment.'],
    ['a//main.xml', 'INVALID_ALIAS', 'Source alias contains an unsafe segment.'],
    ['.AZURE/main.xml', 'EXCLUDED_ALIAS', 'The .azure directory is excluded.'],
    ['a/.env.local', 'EXCLUDED_ALIAS', 'Environment files are excluded.'],
    ['a/main.tfvars', 'UNSUPPORTED_ALIAS', 'Unsupported source file type.'],
  ]) rejects(() => normalizeSourceAlias(alias), code, message);
  assert.equal(normalizeSourceAlias('environments/operator.tfvars', configuration), 'environments/operator.tfvars');
  rejects(() => normalizeSourceAlias('environments/other.tfvars', configuration), 'NATIVE_SOURCE_SCOPE',
    "Only this workspace unit's selected nonsecret operator values can be written. Configuration and shared policies are read-only.");
});

test('T6 manifest normalization retains file order, legacy field fallbacks and distinct change errors', () => {
  const candidates = [
    { alias: 'z.xml', exists: true, originalSize: 0, originalHash: emptyHash },
    { alias: 'a.bicepparam', existed: false, exists: true, size: 0, hash: null },
  ];
  const before = structuredClone(candidates);
  const { aliases, files } = normalizeManifestFiles(candidates);
  assert.equal(JSON.stringify(files), '[{"id":"file-1","alias":"z.xml","existed":true,"originalSize":0,"originalHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","backupVerified":false,"finalSize":null,"finalHash":null,"receiptVerified":false},{"id":"file-2","alias":"a.bicepparam","existed":false,"originalSize":0,"originalHash":null,"backupVerified":false,"finalSize":null,"finalHash":null,"receiptVerified":false}]');
  assert.deepEqual([...aliases], ['z.xml', 'a.bicepparam']);
  assert.deepEqual(candidates, before);
  assert.deepEqual(normalizeChangedAliases(undefined, aliases), ['a.bicepparam', 'z.xml']);
  assert.deepEqual(normalizeChangedAliases(null, aliases), ['a.bicepparam', 'z.xml']);
  assert.deepEqual(normalizeChangedAliases(['z.xml', 'z.xml'], aliases), ['z.xml']);
  rejects(() => normalizeChangedAliases([], aliases), 'INVALID_CHANGES', 'At least one changed alias is required.');
  rejects(() => normalizeChangedAliases(['missing.xml'], aliases), 'UNKNOWN_CHANGED_ALIAS', 'Changed alias is not in the manifest.');
  assert.deepEqual(normalizeFailedChangedAliases(legacy, null), []);
  rejects(() => normalizeFailedChangedAliases(legacy, false), 'INVALID_CHANGES', 'Invalid changed aliases.');
  rejects(() => normalizeFailedChangedAliases(legacy, ['missing.xml']), 'UNKNOWN_CHANGED_ALIAS', 'Unknown changed alias.');
  for (const [value, code, message] of [
    [[], 'INVALID_FILES', 'One to 250 source files are required.'],
    [[candidates[0], candidates[0]], 'DUPLICATE_ALIAS', 'Duplicate source alias.'],
    [[{ alias: 'a.xml', size: 0 }], 'INVALID_EXISTENCE', 'File existence must be declared.'],
    [[{ alias: 'a.xml', existed: false, size: -1 }], 'INVALID_SIZE', 'Invalid original size.'],
    [[{ alias: 'a.xml', existed: true, size: 0, hash: 'A'.repeat(64) }], 'INVALID_HASH', 'Invalid original hash.'],
    [[{ alias: 'a.xml', existed: false, size: 0, hash: emptyHash }], 'INVALID_NEW_FILE', 'New files must have null hash and zero size.'],
  ]) rejects(() => normalizeManifestFiles(value), code, message);
});

test('T6 manifest changed-name and directory normalization preserves exact ordering and boundaries', () => {
  const aliases = new Set(['z.xml', 'a.xml']);
  assert.deepEqual(normalizeChangedNames(undefined, aliases), []);
  assert.equal(JSON.stringify(normalizeChangedNames(['z', 'a[0]', 'z'], aliases)), '["a[0]","z"]');
  assert.equal(JSON.stringify(normalizeChangedNames({ 'z.xml': ['z', 'a', 'z'], 'a.xml': ['n'] }, aliases)), '{"a.xml":["n"],"z.xml":["a","z"]}');
  rejects(() => normalizeChangedNames(null, aliases), 'INVALID_CHANGED_NAMES', 'Changed names must be a list or an alias-to-list object.');
  rejects(() => normalizeChangedNames(['a=value'], aliases), 'INVALID_CHANGED_NAME', 'Invalid changed name.');
  rejects(() => normalizeChangedNames({ 'missing.xml': [] }, aliases), 'UNKNOWN_CHANGED_NAME_ALIAS', 'Changed-name alias is not in the manifest.');
  rejects(() => normalizeChangedNames(Array(101).fill('a'), aliases), 'INVALID_CHANGED_NAMES', 'Changed names must be an array of at most 100 names.');
  const boundary = 'bicep/infra/citadel-access-contracts/contracts';
  const files = ['main.bicepparam', 'policy.xml'].map((leaf) => ({ alias: `${boundary}/alpha/${leaf}`, existed: false }));
  assert.equal(contractCreationBoundary(files), boundary);
  assert.equal(contractCreationDirectory(files), `${boundary}/alpha`);
  assert.equal(contractCreationBoundary([{ alias: 'elsewhere/main.xml' }]), null);
  assert.equal(contractCreationBoundary([...files, { alias: `${boundary}/beta/main.xml` }]), null);
  assert.equal(JSON.stringify(normalizeCreatedDirectories([`${boundary}/alpha`, boundary, boundary], files)), `["${boundary}","${boundary}/alpha"]`);
  assert.deepEqual(normalizeCreatedDirectories(undefined, files), []);
  rejects(() => normalizeCreatedDirectories(null, files), 'INVALID_CREATED_DIRECTORIES', 'Created directories must be an array of at most 250 aliases.');
  rejects(() => normalizeCreatedDirectories(['../alpha'], files), 'INVALID_DIRECTORY_ALIAS', 'Directory alias contains an unsafe segment.');
  rejects(() => normalizeCreatedDirectories(['C:/alpha'], files), 'INVALID_DIRECTORY_ALIAS', 'Directory aliases must be relative POSIX paths.');
  rejects(() => normalizeCreatedDirectories(['unrelated'], files), 'INVALID_CREATED_DIRECTORY', 'Created directories must contain a newly created source.');
  rejects(() => normalizeCreatedDirectories([boundary], files.map((file) => ({ ...file, existed: true }))), 'INVALID_CREATED_DIRECTORY', 'Created directories must contain a newly created source.');
});

test('T6 manifest commit plans and receipt facades preserve Maps, receipt identity and rollback distinctions', () => {
  const manifest = structuredClone(legacy);
  const before = structuredClone(manifest);
  const plan = manifest.files.map((file) => ({ alias: file.alias, originalHash: file.originalHash, finalHash, finalSize: 7 }));
  assert.equal(JSON.stringify([...validateCommitPlan(manifest, plan)]), '[["bicep/main.bicepparam",{"finalHash":"1111111111111111111111111111111111111111111111111111111111111111","finalSize":7}],["policies/new.xml",{"finalHash":"1111111111111111111111111111111111111111111111111111111111111111","finalSize":7}]]');
  rejects(() => validateCommitPlan(manifest, []), 'INVALID_COMMIT_PLAN', 'Commit plan must cover every changed alias.');
  rejects(() => validateCommitPlan(manifest, [plan[0], plan[0]]), 'DUPLICATE_ALIAS', 'Duplicate commit alias.');
  rejects(() => validateCommitPlan(manifest, [{ ...plan[0], originalHash: null }, plan[1]]), 'STALE_ORIGINAL_HASH', 'Prepared source hash is stale.', 409);
  rejects(() => validateCommitPlan(manifest, [{ ...plan[0], finalHash: 'bad' }, plan[1]]), 'INVALID_HASH', 'Invalid final hash.');
  rejects(() => validateCommitPlan(manifest, [{ ...plan[0], finalSize: '7' }, plan[1]]), 'INVALID_SIZE', 'Invalid final size.');
  const receipts = manifest.files.map((file) => ({ alias: file.alias, hash: file.finalHash, size: file.finalSize }));
  const store = new facade.TransactionStore({ dataRoot: tmpdir() });
  for (const validate of [validateReceipts, store.validateReceipts.bind(store)]) {
    const result = validate(manifest, receipts, false);
    assert.deepEqual([...result.keys()], ['bicep/main.bicepparam', 'policies/new.xml']);
    assert.equal(result.get(receipts[0].alias), receipts[0]);
    assert.equal(result.get(receipts[1].alias), receipts[1]);
    rejects(() => validate(manifest, undefined, false), 'INVALID_RECEIPTS', 'Receipts must cover every changed alias.');
    rejects(() => validate(manifest, [receipts[0], receipts[0]], false), 'INVALID_RECEIPTS', 'Receipt alias is duplicate or unknown.');
    rejects(() => validate(manifest, [{ ...receipts[0], size: '7' }, receipts[1]], false), 'FINAL_RECEIPT_FAILED', 'Receipt does not match the expected source hash and size.', 409);
    const rollback = [{ alias: receipts[0].alias, hash: emptyHash, size: 0 }, { alias: receipts[1].alias, removed: true }];
    assert.equal(validate(manifest, rollback, true).get(receipts[1].alias), rollback[1]);
    rejects(() => validate(manifest, [rollback[0], { ...rollback[1], removed: 1 }], true), 'ROLLBACK_RECEIPT_FAILED', 'New source was not removed.', 409);
    rejects(() => validate(manifest, [receipts[0], rollback[1]], true), 'ROLLBACK_RECEIPT_FAILED', 'Receipt does not match the expected source hash and size.', 409);
  }
  assert.deepEqual(manifest, before);
});
