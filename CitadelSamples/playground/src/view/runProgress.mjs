/**
 * Pure streamed-run state.
 *
 * Transport events are untrusted display input. This module projects only the
 * small public shape the in-flight UI needs: status, bounded labels, ordering,
 * and evidence provenance. Evidence values, updates, artifacts, commands, code,
 * and filesystem paths stay out of this model.
 */

export const RUN_PROGRESS_TEXT_LIMIT = 400;
export const RUN_EVIDENCE_CLASSES = Object.freeze([
  'offline',
  'local-live-capable',
  'hosted-relay',
  'preview',
]);

const RESULT_STATES = new Set(['blocked', 'completed', 'failed', 'cancelled', 'inconclusive']);
const STEP_STATES = new Set(['running', 'completed', 'failed', 'cancelled', 'skipped', 'inconclusive']);
const TERMINAL_STEP_STATES = new Set(['completed', 'failed', 'cancelled', 'skipped', 'inconclusive']);
const STREAM_WARNING_CODES = new Set(['malformed-ndjson', 'partial-ndjson']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Classify what a displayed run can prove. "Local live capable" deliberately
 * describes capability, not success; only the final result describes outcome.
 */
export function classifyRunEvidence({ mode = 'preview', executorKind = 'unavailable' } = {}) {
  if (mode === 'offline-local') return 'offline';
  if (mode === 'preview') return 'preview';
  if (executorKind === 'relay' || executorKind === 'relay-core' || executorKind === 'hosted-relay') {
    return 'hosted-relay';
  }
  if (mode === 'execute' && executorKind === 'local') return 'local-live-capable';
  return 'preview';
}

export function createRunProgress({ sampleId, mode = 'preview', executorKind = 'unavailable' } = {}) {
  const safeSampleId = identifier(sampleId);
  if (!safeSampleId) throw new TypeError('createRunProgress requires a catalogue sample id');
  return freezeProgress({
    sampleId: safeSampleId,
    state: 'running',
    final: false,
    summary: 'Starting the approved run.',
    detail: '',
    steps: [],
    assertions: [],
    meta: {
      runId: null,
      workspace: '',
      evidenceClass: classifyRunEvidence({ mode, executorKind }),
    },
    stream: {
      eventsSeen: 0,
      ignoredEvents: 0,
      malformedEvents: 0,
      partial: false,
    },
  });
}

/**
 * Reduce one decoded event without mutating the previous model.
 *
 * First sight of a step fixes its position. Later start/completion events update
 * that slot, and a repeated start can never regress a terminal step to running.
 */
export function reduceRunProgress(current, event) {
  if (!isProgress(current)) throw new TypeError('reduceRunProgress requires run progress state');
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return withStream(current, { malformedEvents: current.stream.malformedEvents + 1 });
  }

  switch (event.type) {
    case 'run-start':
      return reduceRunStart(current, event);
    case 'step-start':
      return reduceStep(current, event.step, true);
    case 'step':
      return reduceStep(current, event.step, false);
    case 'result':
      return reduceFinalResult(current, event.result);
    case 'stream-warning':
      return reduceStreamWarning(current, event);
    default:
      return withStream(current, { ignoredEvents: current.stream.ignoredEvents + 1 });
  }
}

/**
 * Return a sanitized ExecutionResult-compatible handoff after a streamed result
 * event. The normal local client result remains authoritative because it also
 * carries private in-memory updates that must never enter view state.
 */
export function finalRunProgressResult(progress) {
  if (!isProgress(progress) || !progress.final) return null;
  return Object.freeze({
    state: progress.state,
    sampleId: progress.sampleId,
    summary: progress.summary,
    detail: progress.detail,
    steps: Object.freeze(progress.steps.map((step) => Object.freeze({ ...step, evidence: Object.freeze({}) }))),
    assertions: Object.freeze(progress.assertions.map((assertion) => Object.freeze({ ...assertion }))),
    configurationUpdates: Object.freeze({}),
    secretUpdates: Object.freeze({}),
    meta: Object.freeze({ ...progress.meta }),
  });
}

function reduceRunStart(current, event) {
  const eventSampleId = identifier(event.sampleId);
  if (eventSampleId && eventSampleId !== current.sampleId) {
    return withStream(current, { ignoredEvents: current.stream.ignoredEvents + 1 });
  }
  const runId = identifier(event.runId);
  const workspace = workspaceReference(event.workspace);
  return nextProgress(current, {
    meta: {
      ...current.meta,
      runId: runId ?? current.meta.runId,
      workspace: workspace || current.meta.workspace,
    },
  });
}

function reduceStep(current, input, starting) {
  const step = projectStep(input, starting);
  if (!step) return withStream(current, { malformedEvents: current.stream.malformedEvents + 1 });

  const steps = [...current.steps];
  const index = steps.findIndex((candidate) => candidate.id === step.id);
  const previous = index >= 0 ? steps[index] : null;
  const merged = mergeStep(previous, step, starting);
  if (index >= 0) steps[index] = merged;
  else steps.push(merged);

  return nextProgress(current, {
    summary: clipText(
      starting
        ? `Running ${merged.title}.`
        : `${merged.title}: ${merged.state}.`,
    ),
    steps,
  });
}

function reduceFinalResult(current, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !RESULT_STATES.has(result.state)) {
    return withStream(current, { malformedEvents: current.stream.malformedEvents + 1 });
  }

  let steps = [...current.steps];
  for (const input of Array.isArray(result.steps) ? result.steps : []) {
    const step = projectStep(input, false);
    if (!step) continue;
    const index = steps.findIndex((candidate) => candidate.id === step.id);
    if (index >= 0) steps[index] = mergeStep(steps[index], step, false);
    else steps.push(step);
  }

  const runId = identifier(result.runId) ?? identifier(result.meta?.runId);
  const workspace = workspaceReference(result.workspace) || workspaceReference(result.meta?.workspace);
  return nextProgress(current, {
    state: result.state,
    final: true,
    summary: clipText(result.summary) || terminalSummary(result.state),
    detail: clipText(result.detail),
    steps,
    assertions: projectAssertions(result.assertions),
    meta: {
      ...current.meta,
      runId: runId ?? current.meta.runId,
      workspace: workspace || current.meta.workspace,
    },
  });
}

function reduceStreamWarning(current, event) {
  if (!STREAM_WARNING_CODES.has(event.code)) {
    return withStream(current, { ignoredEvents: current.stream.ignoredEvents + 1 });
  }
  return withStream(current, {
    malformedEvents: current.stream.malformedEvents + 1,
    partial: current.stream.partial || event.code === 'partial-ndjson',
  });
}

function projectStep(input, starting) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = identifier(input.id);
  if (!id) return null;
  const reportedState = STEP_STATES.has(input.state) ? input.state : null;
  return Object.freeze({
    id,
    kind: identifier(input.kind) ?? 'step',
    title: clipText(input.title) || id,
    state: starting ? 'running' : (reportedState ?? 'inconclusive'),
    durationMs: duration(input.durationMs),
    detail: clipText(input.detail),
    evidenceAvailable: hasPublicEvidence(input.evidence),
  });
}

function mergeStep(previous, next, starting) {
  if (!previous) return next;
  const keepTerminalState = starting && TERMINAL_STEP_STATES.has(previous.state);
  return Object.freeze({
    id: previous.id,
    kind: next.kind === 'step' ? previous.kind : next.kind,
    title: next.title === next.id ? previous.title : next.title,
    state: keepTerminalState ? previous.state : next.state,
    durationMs: starting ? previous.durationMs : next.durationMs,
    detail: starting ? previous.detail : next.detail,
    evidenceAvailable: previous.evidenceAvailable || next.evidenceAvailable,
  });
}

function projectAssertions(assertions) {
  if (!Array.isArray(assertions)) return [];
  return assertions.flatMap((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
    const id = identifier(input.id);
    if (!id) return [];
    return [
      Object.freeze({
        id,
        status: identifier(input.status) ?? 'inconclusive',
        detail: clipText(input.detail),
      }),
    ];
  });
}

function hasPublicEvidence(evidence) {
  return Boolean(evidence && typeof evidence === 'object' && !Array.isArray(evidence) && Object.keys(evidence).length > 0);
}

function identifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null;
}

function workspaceReference(value) {
  const text = clipText(value);
  if (!text) return '';
  if (/^[A-Za-z]:[\\/]/.test(text) || /^[\\/]{1,2}/.test(text)) return '';
  const segments = text.replaceAll('\\', '/').split('/');
  if (segments.includes('..') || /[\u0000-\u001f]/.test(text)) return '';
  return text;
}

function clipText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, RUN_PROGRESS_TEXT_LIMIT);
}

function duration(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 86_400_000) : 0;
}

function terminalSummary(state) {
  if (state === 'completed') return 'Run complete.';
  if (state === 'cancelled') return 'Run cancelled.';
  if (state === 'blocked') return 'Run blocked.';
  if (state === 'failed') return 'Run failed.';
  return 'Run inconclusive.';
}

function isProgress(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      identifier(value.sampleId) &&
      Array.isArray(value.steps) &&
      value.meta &&
      RUN_EVIDENCE_CLASSES.includes(value.meta.evidenceClass) &&
      value.stream,
  );
}

function withStream(current, streamChanges) {
  return nextProgress(current, {
    stream: { ...current.stream, ...streamChanges },
  });
}

function nextProgress(current, changes) {
  return freezeProgress({
    ...current,
    ...changes,
    stream: {
      ...current.stream,
      ...(changes.stream ?? {}),
      eventsSeen: current.stream.eventsSeen + 1,
    },
  });
}

function freezeProgress(progress) {
  return Object.freeze({
    ...progress,
    steps: Object.freeze([...progress.steps]),
    assertions: Object.freeze([...progress.assertions]),
    meta: Object.freeze({ ...progress.meta }),
    stream: Object.freeze({ ...progress.stream }),
  });
}
