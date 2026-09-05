/**
 * Streamed run progress is a pure, bounded projection. These tests deliberately
 * feed hostile extra fields because transport events must not become a raw log.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CATALOGUE, buildSamplePlan, getSample } from '../src/catalogue/index.mjs';
import {
  RUN_PROGRESS_TEXT_LIMIT,
  classifyRunEvidence,
  createRunProgress,
  finalRunProgressResult,
  reduceRunProgress,
} from '../src/view/runProgress.mjs';
import { createLocalExecutorClient } from '../web/js/localClient.mjs';
import { makeFixtureReader } from './helpers/fixtures.mjs';

const ALL_IDS = CATALOGUE.samples.map((sample) => sample.id);

function progress(overrides = {}) {
  return createRunProgress({
    sampleId: 'azure-context-check',
    mode: 'execute',
    executorKind: 'local',
    ...overrides,
  });
}

function planFor(id) {
  return buildSamplePlan(getSample(id), makeFixtureReader()).plan;
}

test('evidence provenance distinguishes offline, local live-capable, hosted relay and preview runs', () => {
  assert.equal(classifyRunEvidence({ mode: 'offline-local', executorKind: 'local' }), 'offline');
  assert.equal(classifyRunEvidence({ mode: 'execute', executorKind: 'local' }), 'local-live-capable');
  assert.equal(classifyRunEvidence({ mode: 'execute', executorKind: 'relay' }), 'hosted-relay');
  assert.equal(classifyRunEvidence({ mode: 'execute', executorKind: 'relay-core' }), 'hosted-relay');
  assert.equal(classifyRunEvidence({ mode: 'preview', executorKind: 'relay' }), 'hosted-relay');
  assert.equal(classifyRunEvidence({ mode: 'preview', executorKind: 'local' }), 'preview');
  assert.equal(classifyRunEvidence({ mode: 'execute', executorKind: 'unavailable' }), 'preview');
});

test('run metadata is preserved without accepting absolute or escaping workspace paths', () => {
  const started = reduceRunProgress(progress(), {
    type: 'run-start',
    runId: 'run-0001',
    sampleId: 'azure-context-check',
    workspace: '.runs/run-0001',
  });
  assert.equal(started.meta.runId, 'run-0001');
  assert.equal(started.meta.workspace, '.runs/run-0001');
  assert.equal(started.meta.evidenceClass, 'local-live-capable');

  const unsafe = reduceRunProgress(started, {
    type: 'run-start',
    runId: 'run-0002',
    workspace: 'C:\\private\\run-0002',
  });
  assert.equal(unsafe.meta.runId, 'run-0002');
  assert.equal(unsafe.meta.workspace, '.runs/run-0001');
});

test('steps keep first-seen order, upsert in place and never regress after completion', () => {
  let state = progress();
  state = reduceRunProgress(state, {
    type: 'step-start',
    step: { id: 'second', kind: 'http', title: 'Second step' },
  });
  state = reduceRunProgress(state, {
    type: 'step-start',
    step: { id: 'first', kind: 'assertion', title: 'First step' },
  });
  state = reduceRunProgress(state, {
    type: 'step',
    step: { id: 'second', kind: 'http', title: 'Second step', state: 'completed', durationMs: 12, evidence: { status: 200 } },
  });
  state = reduceRunProgress(state, {
    type: 'step-start',
    step: { id: 'second', kind: 'http', title: 'Second step again' },
  });

  assert.deepEqual(state.steps.map((step) => step.id), ['second', 'first']);
  assert.equal(state.steps[0].state, 'completed');
  assert.equal(state.steps[0].durationMs, 12);
  assert.equal(state.steps[0].evidenceAvailable, true);
  assert.equal(state.steps[1].state, 'running');
});

test('event text is bounded and raw evidence, secrets, code, commands and paths never enter view state', () => {
  const marker = 'DO-NOT-EXPOSE';
  const long = 'x'.repeat(RUN_PROGRESS_TEXT_LIMIT + 50);
  const state = reduceRunProgress(progress(), {
    type: 'step',
    step: {
      id: 'safe-step',
      kind: 'library',
      title: long,
      state: 'failed',
      detail: long,
      evidence: { innocentName: marker },
      secretUpdates: { apiKey: marker },
      code: marker,
      command: marker,
      path: marker,
      artifactPath: marker,
    },
  });

  assert.equal(state.steps[0].title.length, RUN_PROGRESS_TEXT_LIMIT);
  assert.equal(state.steps[0].detail.length, RUN_PROGRESS_TEXT_LIMIT);
  assert.equal(state.steps[0].evidenceAvailable, true);
  assert.ok(!JSON.stringify(state).includes(marker));
  assert.deepEqual(Object.keys(state.steps[0]), [
    'id',
    'kind',
    'title',
    'state',
    'durationMs',
    'detail',
    'evidenceAvailable',
  ]);
});

test('a final result updates existing rows, appends unseen rows and produces a sanitized handoff', () => {
  let state = reduceRunProgress(progress(), {
    type: 'run-start',
    runId: 'run-0003',
    sampleId: 'azure-context-check',
    workspace: '.',
  });
  state = reduceRunProgress(state, {
    type: 'step-start',
    step: { id: 'early', title: 'Early', kind: 'http' },
  });
  state = reduceRunProgress(state, {
    type: 'result',
    result: {
      state: 'completed',
      sampleId: 'wrong-sample',
      summary: 'Completed.',
      steps: [
        { id: 'late', title: 'Late', kind: 'assertion', state: 'completed', evidence: { secret: 'hidden' } },
        { id: 'early', title: 'Early', kind: 'http', state: 'completed', durationMs: 8 },
      ],
      assertions: [{ id: 'expected', status: 'passed', detail: 'Observed.' }],
      secretUpdates: { value: 'hidden' },
      configurationUpdates: { path: 'hidden' },
      meta: { command: 'hidden', code: 'hidden', path: 'hidden' },
    },
  });

  assert.equal(state.final, true);
  assert.equal(state.state, 'completed');
  assert.equal(state.sampleId, 'azure-context-check');
  assert.deepEqual(state.steps.map((step) => step.id), ['early', 'late']);
  assert.equal(state.meta.runId, 'run-0003');
  assert.equal(state.meta.workspace, '.');

  const result = finalRunProgressResult(state);
  assert.equal(result.state, 'completed');
  assert.equal(result.meta.evidenceClass, 'local-live-capable');
  assert.deepEqual(result.configurationUpdates, {});
  assert.deepEqual(result.secretUpdates, {});
  assert.ok(!JSON.stringify(result).includes('hidden'));
});

test('offline validation accepts passed results and checks without changing provenance', () => {
  let state = createRunProgress({
    sampleId: 'source-validation',
    mode: 'offline-local',
    executorKind: 'local',
  });
  state = reduceRunProgress(state, {
    type: 'step',
    step: { id: 'syntax', title: 'Syntax', state: 'passed', detail: 'Parsed.' },
  });
  state = reduceRunProgress(state, {
    type: 'result',
    result: {
      state: 'passed',
      summary: 'Source validation passed.',
      steps: [{ id: 'syntax', title: 'Syntax', state: 'passed', detail: 'Parsed.' }],
      checks: [
        { id: 'imports', label: 'Imports', passed: true, detail: 'Resolved.' },
        { id: 'policy', label: 'Policy', state: 'passed', detail: 'Allowed.' },
      ],
    },
  });

  assert.equal(state.final, true);
  assert.equal(state.state, 'passed');
  assert.equal(state.meta.evidenceClass, 'offline');
  assert.deepEqual(state.steps.map((step) => step.id), ['syntax', 'imports', 'policy']);
  assert.deepEqual(state.steps.map((step) => step.state), ['passed', 'passed', 'passed']);
  assert.equal(finalRunProgressResult(state).state, 'passed');
});

test('passed cannot be claimed by a preview or live sample result', () => {
  for (const state of [
    createRunProgress({ sampleId: 'source-validation', mode: 'preview', executorKind: 'unavailable' }),
    progress(),
  ]) {
    const reduced = reduceRunProgress(state, {
      type: 'result',
      result: { state: 'passed', summary: 'Spoofed.' },
    });
    assert.equal(reduced.final, false);
    assert.equal(reduced.state, 'running');
    assert.equal(reduced.meta.evidenceClass, state.meta.evidenceClass);
    assert.equal(reduced.stream.malformedEvents, 1);
  }
});

test('malformed and partial stream warnings are counted without retaining line content', () => {
  let state = reduceRunProgress(progress(), null);
  state = reduceRunProgress(state, { type: 'stream-warning', code: 'malformed-ndjson', line: 'private' });
  state = reduceRunProgress(state, { type: 'stream-warning', code: 'partial-ndjson', line: 'private' });
  state = reduceRunProgress(state, { type: 'unknown', payload: 'private' });

  assert.equal(state.stream.eventsSeen, 4);
  assert.equal(state.stream.malformedEvents, 3);
  assert.equal(state.stream.partial, true);
  assert.equal(state.stream.ignoredEvents, 1);
  assert.ok(!JSON.stringify(state).includes('private'));
});

test('invalid or mismatched events cannot replace the current run identity', () => {
  let state = progress();
  state = reduceRunProgress(state, {
    type: 'run-start',
    runId: 'other-run',
    sampleId: 'another-sample',
    workspace: '.',
  });
  state = reduceRunProgress(state, {
    type: 'step',
    step: { id: '../unsafe', title: 'Unsafe', state: 'completed' },
  });
  state = reduceRunProgress(state, { type: 'result', result: { state: 'running' } });

  assert.equal(state.meta.runId, null);
  assert.deepEqual(state.steps, []);
  assert.equal(state.final, false);
  assert.equal(state.stream.ignoredEvents, 1);
  assert.equal(state.stream.malformedEvents, 2);
});

test('the local client skips malformed stream lines, preserves metadata and returns a later result', async () => {
  const encoder = new TextEncoder();
  const final = {
    type: 'result',
    result: {
      state: 'completed',
      summary: 'Completed after a malformed event.',
      steps: [],
      assertions: [],
    },
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          '{"type":"run-start","runId":"stream-0002","sampleId":"azure-context-check","workspace":".runs/stream-0002"}\n{not-json}\n',
        ),
      );
      controller.enqueue(encoder.encode(JSON.stringify(final)));
      controller.close();
    },
  });
  const client = createLocalExecutorClient({
    allowedSampleIds: ALL_IDS,
    supportedStepTypes: ['azure-cli', 'assertion'],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name) => {
          if (name.toLowerCase() === 'x-citadel-run-id') return 'stream-0002';
          if (name.toLowerCase() === 'content-type') return 'application/x-ndjson';
          return null;
        },
      },
      body,
    }),
  });
  const progressEvents = [];
  const plan = planFor('azure-context-check');
  const result = await client.execute(plan, {
    sampleId: plan.sampleId,
    onProgress: (event) => progressEvents.push(event),
  });

  assert.equal(result.state, 'completed');
  assert.equal(result.meta.runId, 'stream-0002');
  assert.equal(result.meta.workspace, '.runs/stream-0002');
  assert.deepEqual(progressEvents.map((event) => event.type), ['run-start', 'stream-warning']);
  assert.deepEqual(progressEvents[1], { type: 'stream-warning', code: 'malformed-ndjson' });
});

test('the local client reports a truncated final NDJSON line without exposing it', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"run-start","runId":"stream-0003"}\n{"type":"result","result":'));
      controller.close();
    },
  });
  const client = createLocalExecutorClient({
    allowedSampleIds: ALL_IDS,
    supportedStepTypes: ['azure-cli', 'assertion'],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name) => {
          if (name.toLowerCase() === 'x-citadel-run-id') return 'stream-0003';
          if (name.toLowerCase() === 'content-type') return 'application/x-ndjson';
          return null;
        },
      },
      body,
    }),
  });
  const progressEvents = [];
  const plan = planFor('azure-context-check');
  const result = await client.execute(plan, {
    sampleId: plan.sampleId,
    onProgress: (event) => progressEvents.push(event),
  });

  assert.equal(result.state, 'inconclusive');
  assert.deepEqual(progressEvents.map((event) => event.type), ['run-start', 'stream-warning']);
  assert.deepEqual(progressEvents[1], { type: 'stream-warning', code: 'partial-ndjson' });
});
