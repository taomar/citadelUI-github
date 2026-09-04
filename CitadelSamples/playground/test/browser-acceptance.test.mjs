import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  expectedParameterFields,
  expectedParameterPaths,
  expectedSourceContract,
  parameterZonePaths,
  validateSourceDomSnapshot,
  validateSourcePayload,
  validateValidationPayload,
  validateWritableControls,
} from '../scripts/browser-acceptance-contract.mjs';
import { browserCandidates, connectCdpPipe, createCheckReporter } from '../scripts/browser-harness.mjs';

const notebook = {
  metadata: { language_info: { name: 'python' } },
  cells: [
    { cell_type: 'markdown', source: ['# Prepare\n', 'Review before running.'] },
    { cell_type: 'code', source: ['value = "fixed"\n', 'print(value)\n'] },
  ],
};
const sample = {
  id: 'sample',
  sourceCells: [0, 1],
  configurationEntries: [
    { path: 'hub.name', label: 'Hub name', secret: false, blockingWhenBlank: true },
    { path: 'gatewayAccess.apiKey', label: 'API key', secret: true, blockingWhenBlank: true },
  ],
};
const notebookMeta = {
  fileName: 'source.ipynb',
  sha256: 'notebook-sha',
  bytes: 123,
};
const expected = expectedSourceContract({ sample, notebook, notebookMeta });
const parameterZones = [
  {
    id: 'configuration',
    title: 'Configuration',
    count: 1,
    fields: [{ path: 'hub.name', label: 'Hub name', secret: false, blockingWhenBlank: true }],
  },
  {
    id: 'secrets',
    title: 'Secrets',
    count: 1,
    fields: [{ path: 'gatewayAccess.apiKey', label: 'API key', secret: true, blockingWhenBlank: true }],
  },
];

test('the expected source contract preserves exact notebook text and derives immutable metadata', () => {
  assert.deepEqual(
    expected.cells.map((cell) => ({
      cellIndex: cell.cellIndex,
      cellType: cell.cellType,
      language: cell.language,
      text: cell.text,
      editable: cell.editable,
      protected: cell.protected,
    })),
    [
      {
        cellIndex: 0,
        cellType: 'markdown',
        language: 'markdown',
        text: '# Prepare\nReview before running.',
        editable: false,
        protected: true,
      },
      {
        cellIndex: 1,
        cellType: 'code',
        language: 'python',
        text: 'value = "fixed"\nprint(value)\n',
        editable: false,
        protected: true,
      },
    ],
  );
  for (const cell of expected.cells) {
    assert.equal(cell.bytes, Buffer.byteLength(cell.text, 'utf8'));
    assert.equal(cell.sha256, createHash('sha256').update(cell.text).digest('hex'));
  }
});

test('the source response validator enforces exact fields, source bytes, and parameter zones', () => {
  const payload = {
    protocolVersion: expected.protocolVersion,
    sampleId: expected.sampleId,
    notebook: { ...expected.notebook },
    protection: { editable: false },
    parameterZones: structuredClone(parameterZones),
    cells: expected.cells.map((cell) => ({ ...cell })),
  };
  assert.deepEqual(validateSourcePayload(payload, expected, expectedParameterFields(sample)), []);

  payload.cells[1].text = 'changed';
  payload.cells[1].editable = true;
  payload.parameterZones[0].fields[0].path = 'undeclared.path';
  payload.parameterZones[1].fields[0].secret = 'yes';
  const issues = validateSourcePayload(payload, expected, expectedParameterFields(sample));
  assert.ok(issues.some((entry) => /not an exact protected copy/.test(entry)));
  assert.ok(issues.some((entry) => /parameter zones must name exactly/.test(entry)));
  assert.ok(issues.some((entry) => /secret must be boolean/.test(entry)));
});

test('the DOM validator refuses editable or altered protected source', () => {
  const snapshot = expected.cells.map((cell) => ({
    cellIndex: cell.cellIndex,
    text: cell.text,
    protected: 'true',
    editable: 'false',
    editableDescendants: 0,
  }));
  assert.deepEqual(validateSourceDomSnapshot(snapshot, expected.cells), []);

  snapshot[0].editable = 'true';
  snapshot[1].editableDescendants = 1;
  const issues = validateSourceDomSnapshot(snapshot, expected.cells);
  assert.ok(issues.some((entry) => /not marked non-editable/.test(entry)));
  assert.ok(issues.some((entry) => /editable descendant/.test(entry)));
});

test('writable controls must map one-to-one to declared parameter zones and mask secrets', () => {
  const controls = [
    { path: 'hub.name', label: 'Hub name', tag: 'input', type: 'text', secret: false, inProtectedSource: false },
    {
      path: 'gatewayAccess.apiKey',
      label: 'API key',
      tag: 'input',
      type: 'password',
      secret: true,
      inProtectedSource: false,
    },
  ];
  const paths = expectedParameterPaths(sample);
  assert.deepEqual(validateWritableControls(controls, paths, parameterZonePaths(parameterZones)), []);

  controls[1].type = 'text';
  controls.push({
    path: 'source.code',
    label: 'Source',
    tag: 'textarea',
    type: 'textarea',
    secret: false,
    inProtectedSource: true,
  });
  const issues = validateWritableControls(controls, paths, parameterZonePaths(parameterZones));
  assert.ok(issues.some((entry) => /must use a password control/.test(entry)));
  assert.ok(issues.some((entry) => /writable inside protected source/.test(entry)));
  assert.ok(issues.some((entry) => /not declared by the recipe/.test(entry)));
});

test('offline validation requires compile-only labels, negative live claims, and an inline artifact', () => {
  const artifactText = 'compiled source evidence';
  const payload = {
    scenario: 'offline-python-source-validation',
    sampleId: sample.id,
    runId: 'source-validation-0001',
    state: 'passed',
    summary: 'Protected Python source compiled.',
    detail: '',
    mode: 'offline-local',
    validation: 'python-compile-only',
    sourceEditable: false,
    sourceExecuted: false,
    azureContacted: false,
    networkContacted: false,
    liveEvidence: false,
    source: {
      notebook: { ...expected.notebook },
      cells: expected.cells.map(({ cellIndex, cellType, bytes, sha256 }) => ({ cellIndex, cellType, bytes, sha256 })),
    },
    steps: [],
    checks: [],
    artifact: {
      fileName: 'source-validation.txt',
      mediaType: 'text/plain',
      text: artifactText,
      bytes: Buffer.byteLength(artifactText),
      sha256: createHash('sha256').update(artifactText).digest('hex'),
      retainedInWorkspace: false,
    },
    workspaceRemoved: true,
  };
  assert.deepEqual(validateValidationPayload(payload, { sampleId: sample.id, expectedSource: expected }), []);

  payload.liveEvidence = true;
  payload.artifact.retainedInWorkspace = true;
  const issues = validateValidationPayload(payload, { sampleId: sample.id, expectedSource: expected });
  assert.ok(issues.some((entry) => /liveEvidence must be false/.test(entry)));
  assert.ok(issues.some((entry) => /must not be retained/.test(entry)));
});

test('the harness keeps browser discovery deterministic and reports all failures', () => {
  assert.deepEqual(
    browserCandidates({
      explicitPath: 'explicit-browser',
      env: { CITADEL_ACCEPTANCE_CHROME: 'acceptance-browser', CITADEL_SMOKE_CHROME: 'smoke-browser', LOCALAPPDATA: 'local' },
    }).slice(0, 4),
    ['explicit-browser', 'acceptance-browser', 'smoke-browser', 'local/Google/Chrome/Application/chrome.exe'],
  );

  const output = [];
  const reporter = createCheckReporter({ name: 'test', write: (line) => output.push(line) });
  reporter.equal('same', 1, 1);
  reporter.check('different', false, 'evidence');
  const result = reporter.finish();
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map((entry) => entry.label), ['different']);
  assert.match(output.join(''), /1\/2 checks passed/);
});

test('the zero-dependency CDP pipe routes replies and session events', async () => {
  const writes = new PassThrough();
  const reads = new PassThrough();
  const client = connectCdpPipe(writes, reads, { timeoutMs: 1_000 });
  let sent = Buffer.alloc(0);
  writes.on('data', (chunk) => {
    sent = Buffer.concat([sent, chunk]);
    const delimiter = sent.indexOf(0);
    if (delimiter < 0) return;
    const request = JSON.parse(sent.subarray(0, delimiter).toString('utf8'));
    reads.write(`${JSON.stringify({ id: request.id, result: { product: 'Chromium' } })}\0`);
  });

  assert.deepEqual(await client.send('Browser.getVersion'), { product: 'Chromium' });

  const page = client.session('page-session');
  const events = [];
  page.on('Runtime.exceptionThrown', (payload) => events.push(payload.text));
  reads.write(
    `${JSON.stringify({
      sessionId: 'page-session',
      method: 'Runtime.exceptionThrown',
      params: { text: 'expected event' },
    })}\0`,
  );
  assert.deepEqual(events, ['expected event']);
  client.close();
});
