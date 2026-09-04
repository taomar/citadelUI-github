/**
 * Offline Python validation for protected notebook source.
 *
 * The route selects a catalogue sample and the browser body contains only the
 * protocol version. This module extracts source from the imported notebook,
 * writes it to a unique run workspace, and invokes one shipped stdlib-only validator. The
 * notebook cells are compiled but never executed. The workspace is removed in
 * `finally`, including after timeout, cancellation, or failure.
 */

import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CATALOGUE } from '../catalogue/index.mjs';
import { createRunWorkspace, makeRunId } from './workspace.mjs';
import { spawnProcess } from './transports.mjs';
import { validateCodeValidationRequest } from './recipeRequest.mjs';
import { readSampleSource } from './sourceView.mjs';
import { RequestRefused } from './runRequest.mjs';

export const CODE_VALIDATION_SCENARIO = 'offline-python-source-validation';
export const DEFAULT_CODE_VALIDATION_LIMITS = Object.freeze({
  timeoutMs: 15_000,
  maxOutputBytes: 128 * 1024,
  maxConcurrentRuns: 2,
});

export function createCodeValidationManager({
  playgroundRoot,
  catalogue = CATALOGUE,
  pythonExecutable = process.platform === 'win32' ? 'python' : 'python3',
  spawn = spawnProcess,
  sourceReader = readSampleSource,
  writeFileImpl = writeFile,
  readFileImpl = readFile,
  removeImpl = rm,
  limits = {},
} = {}) {
  if (!playgroundRoot) throw new TypeError('createCodeValidationManager requires playgroundRoot');
  const bounds = Object.freeze({ ...DEFAULT_CODE_VALIDATION_LIMITS, ...limits });
  const active = new Map();
  let sequence = 0;

  async function start(sampleId, payload, { onStart, onProgress } = {}) {
    const request = validateCodeValidationRequest(sampleId, payload, catalogue);
    if (active.size >= bounds.maxConcurrentRuns) {
      throw new RequestRefused(
        `${active.size} offline validation run(s) are already active; the limit is ${bounds.maxConcurrentRuns}.`,
        { code: 'too-many-runs', status: 429 },
      );
    }

    sequence += 1;
    const runId = makeRunId(`code-${request.sample.id}`, sequence);
    const workspace = createRunWorkspace({ playgroundRoot, runId });
    const controller = new AbortController();
    active.set(runId, { controller, sampleId: request.sample.id });

    let result;
    let cleanupError = null;
    try {
      await workspace.ensureRoot();
      onStart?.({ runId, sampleId: request.sample.id });
      onProgress?.({ type: 'run-start', runId, sampleId: request.sample.id });
      result = await validateInWorkspace({
        playgroundRoot,
        workspace,
        request,
        pythonExecutable,
        spawn,
        sourceReader,
        writeFileImpl,
        readFileImpl,
        signal: controller.signal,
        bounds,
        onProgress,
      });
    } catch (error) {
      result = baseResult({
        sampleId: request.sample.id,
        runId,
        state: controller.signal.aborted ? 'cancelled' : 'failed',
        summary: controller.signal.aborted
          ? 'Offline Python validation was cancelled.'
          : 'Offline Python validation could not be completed.',
        detail: safeError(error, workspace.root, playgroundRoot),
      });
    } finally {
      try {
        await removeImpl(workspace.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch (error) {
        cleanupError = error;
      }
      active.delete(runId);
    }

    if (cleanupError) {
      result = baseResult({
        sampleId: request.sample.id,
        runId,
        state: 'failed',
        summary: 'Offline validation finished, but its ephemeral workspace could not be removed.',
        detail: safeError(cleanupError, workspace.root, playgroundRoot),
        workspaceRemoved: false,
      });
    } else {
      result = Object.freeze({ ...result, workspaceRemoved: true });
    }
    onProgress?.({ type: 'result', result });
    return result;
  }

  function cancel(runId) {
    const run = active.get(runId);
    if (!run) return Object.freeze({ cancelled: false, reason: 'That offline validation is not in flight.' });
    run.controller.abort();
    return Object.freeze({ cancelled: true, runId, sampleId: run.sampleId });
  }

  function cancelAll() {
    for (const run of active.values()) run.controller.abort();
  }

  return Object.freeze({
    start,
    cancel,
    cancelAll,
    get activeCount() {
      return active.size;
    },
    listActive: () =>
      Object.freeze([...active.entries()].map(([runId, run]) => Object.freeze({ runId, sampleId: run.sampleId }))),
  });
}

async function validateInWorkspace({
  playgroundRoot,
  workspace,
  request,
  pythonExecutable,
  spawn,
  sourceReader,
  writeFileImpl,
  readFileImpl,
  signal,
  bounds,
  onProgress,
}) {
  const source = await sourceReader({ playgroundRoot, sample: request.sample });
  const codeCells = source.cells.filter((cell) => cell.cellType === 'code');
  const manifestTarget = workspace.resolve('code-validation/validation-request.json');
  const reportTarget = workspace.resolve('code-validation/validation-report.json');
  await workspace.ensureDirFor(manifestTarget.absolute);

  const cells = [];
  for (const cell of codeCells) {
    const fileName = `cell-${String(cell.cellIndex).padStart(3, '0')}.py`;
    const target = workspace.resolve(`code-validation/${fileName}`);
    await workspace.ensureDirFor(target.absolute);
    await writeFileImpl(target.absolute, cell.text, 'utf8');
    cells.push({
      cellIndex: cell.cellIndex,
      fileName,
      bytes: cell.bytes,
      sha256: cell.sha256,
    });
  }

  const manifest = {
    schemaVersion: 1,
    scenario: CODE_VALIDATION_SCENARIO,
    sampleId: request.sample.id,
    notebook: source.notebook,
    cells,
  };
  await writeFileImpl(manifestTarget.absolute, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const stepStart = {
    id: 'compile-protected-notebook-source',
    title: 'Compile protected notebook source',
    kind: 'python',
  };
  onProgress?.({ type: 'step-start', step: stepStart });
  const began = Date.now();

  if (signal.aborted) {
    const step = stepRecord(stepStart, 'cancelled', Date.now() - began, 'Cancelled before Python started.');
    onProgress?.({ type: 'step', step });
    return baseResult({
      sampleId: request.sample.id,
      runId: workspace.runId,
      state: 'cancelled',
      summary: 'Offline Python validation was cancelled.',
      steps: [step],
      source,
    });
  }

  const validatorScript = resolve(playgroundRoot, 'runtime', 'python', 'validate_notebook_source.py');
  const processResult = await spawn({
    executable: pythonExecutable,
    // -I ignores Python environment configuration; -S prevents site, .pth, and
    // sitecustomize startup code. Only the shipped validator is loaded.
    args: ['-I', '-S', validatorScript, manifestTarget.absolute, reportTarget.absolute],
    cwd: workspace.root,
    signal,
    timeoutMs: bounds.timeoutMs,
    maxOutputBytes: bounds.maxOutputBytes,
  });
  const durationMs = Date.now() - began;
  const stdout = safeOutput(processResult.stdout, workspace.root, playgroundRoot);
  const stderr = safeOutput(processResult.stderr, workspace.root, playgroundRoot);

  if (signal.aborted) {
    const step = stepRecord(stepStart, 'cancelled', durationMs, 'The Python compile process was cancelled.', {
      exitCode: processResult.code,
      stdout,
      stderr,
    });
    onProgress?.({ type: 'step', step });
    return baseResult({
      sampleId: request.sample.id,
      runId: workspace.runId,
      state: 'cancelled',
      summary: 'Offline Python validation was cancelled.',
      steps: [step],
      source,
    });
  }
  if (processResult.spawnFailed || pythonUnavailable(processResult)) {
    const step = stepRecord(stepStart, 'blocked', durationMs, 'The configured Python executable was not found.', {
      exitCode: processResult.code,
      stderr,
    });
    onProgress?.({ type: 'step', step });
    return baseResult({
      sampleId: request.sample.id,
      runId: workspace.runId,
      state: 'blocked',
      summary: 'Not validated — a Python interpreter is not available.',
      detail: 'Install Python 3.10 or newer, or set CITADEL_PLAYGROUND_PYTHON to the approved interpreter.',
      steps: [step],
      source,
    });
  }
  if (processResult.timedOut) {
    const step = stepRecord(
      stepStart,
      'failed',
      durationMs,
      `The Python compile process exceeded its ${Math.round(bounds.timeoutMs / 1000)}s timeout.`,
      { exitCode: processResult.code, stdout, stderr },
    );
    onProgress?.({ type: 'step', step });
    return baseResult({
      sampleId: request.sample.id,
      runId: workspace.runId,
      state: 'failed',
      summary: 'Offline Python validation timed out.',
      steps: [step],
      source,
    });
  }
  if (processResult.code !== 0) {
    const step = stepRecord(stepStart, 'failed', durationMs, `The Python validator exited ${processResult.code}.`, {
      exitCode: processResult.code,
      stdout,
      stderr,
    });
    onProgress?.({ type: 'step', step });
    return baseResult({
      sampleId: request.sample.id,
      runId: workspace.runId,
      state: 'failed',
      summary: 'The offline Python validator failed before it produced a report.',
      steps: [step],
      source,
    });
  }

  const artifactText = await readFileImpl(reportTarget.absolute, 'utf8');
  let report;
  try {
    report = JSON.parse(artifactText);
  } catch {
    throw new Error('The Python validator returned an invalid JSON report.');
  }
  if (
    report?.schemaVersion !== 1 ||
    report?.scenario !== CODE_VALIDATION_SCENARIO ||
    report?.sampleId !== request.sample.id ||
    report?.sourceExecuted !== false ||
    report?.azureContacted !== false ||
    report?.networkContacted !== false ||
    report?.liveEvidence !== false ||
    !Array.isArray(report.checks) ||
    report.checks.length !== codeCells.length
  ) {
    throw new Error('The Python validator returned a report that does not match this request.');
  }
  for (const [index, check] of report.checks.entries()) {
    const cell = codeCells[index];
    if (
      check?.cellIndex !== cell.cellIndex ||
      check?.bytes !== cell.bytes ||
      check?.sha256 !== cell.sha256 ||
      typeof check?.passed !== 'boolean'
    ) {
      throw new Error('The Python validator returned cell evidence that does not match the protected source.');
    }
  }

  const passed = report.state === 'passed' && report.checks.every((check) => check.passed === true);
  const step = stepRecord(
    stepStart,
    passed ? 'completed' : 'failed',
    durationMs,
    passed
      ? `Python compiled ${report.checks.length} exact notebook code cell(s) without executing them.`
      : 'Python found a syntax error in one or more protected notebook code cells.',
    {
      exitCode: processResult.code,
      compiledCells: report.checks.length,
      stdout,
      stderr,
    },
  );
  onProgress?.({ type: 'step', step });
  const artifactBytes = Buffer.byteLength(artifactText, 'utf8');
  const artifact = Object.freeze({
    fileName: `citadel-${request.sample.id}-offline-code-validation.json`,
    mediaType: 'application/json',
    text: artifactText,
    bytes: artifactBytes,
    sha256: createHash('sha256').update(artifactText, 'utf8').digest('hex'),
    retainedInWorkspace: false,
  });

  return baseResult({
    sampleId: request.sample.id,
    runId: workspace.runId,
    state: passed ? 'passed' : 'failed',
    summary: passed
      ? `Python compiled ${report.checks.length} protected notebook code cell(s). This was offline syntax validation, not a live scenario run.`
      : 'Python reported a syntax error in protected notebook source. This was offline validation, not a live scenario run.',
    detail:
      'The shipped validator used Python compile-only semantics. It did not import notebook dependencies, execute a cell, contact a network, or use a credential.',
    steps: [step],
    checks: report.checks,
    artifact,
    source,
  });
}

function stepRecord(step, state, durationMs, detail, evidence = {}) {
  return Object.freeze({
    ...step,
    state,
    durationMs,
    detail,
    evidence: Object.freeze(evidence),
  });
}

function baseResult({
  sampleId,
  runId,
  state,
  summary,
  detail = '',
  steps = [],
  checks = [],
  artifact = null,
  source = null,
  workspaceRemoved = false,
}) {
  return Object.freeze({
    scenario: CODE_VALIDATION_SCENARIO,
    sampleId,
    runId,
    state,
    summary,
    detail,
    mode: 'offline-local',
    validation: 'python-compile-only',
    sourceEditable: false,
    sourceExecuted: false,
    azureContacted: false,
    networkContacted: false,
    liveEvidence: false,
    source: source
      ? Object.freeze({
          notebook: source.notebook,
          cells: Object.freeze(
            source.cells.map((cell) =>
              Object.freeze({
                cellIndex: cell.cellIndex,
                cellType: cell.cellType,
                bytes: cell.bytes,
                sha256: cell.sha256,
              }),
            ),
          ),
        })
      : null,
    steps: Object.freeze([...steps]),
    checks: Object.freeze([...checks]),
    artifact,
    workspaceRemoved,
  });
}

function safeOutput(value, workspaceRoot, playgroundRoot) {
  return String(value ?? '')
    .replaceAll(workspaceRoot, '<ephemeral-workspace>')
    .replaceAll(playgroundRoot, '<playground>')
    .slice(0, 4096);
}

function safeError(error, workspaceRoot, playgroundRoot) {
  return safeOutput(error?.message ?? String(error), workspaceRoot, playgroundRoot);
}

function pythonUnavailable(result) {
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  return (
    result?.code === 9009 ||
    /\bENOENT\b|python was not found|no such file|not recognized as an internal or external command|app execution aliases/i.test(
      output,
    )
  );
}
