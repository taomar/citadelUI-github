import { randomUUID } from 'node:crypto';
import {
  DIAGNOSTICS_LIMITS as LIMITS, clientDiagnostic, copyClientDiagnostic,
  copyDiagnosticReport, copyDiagnosticState, isDiagnosticId,
} from '../shared/diagnostics.mjs';

const ERRORS = Object.freeze({
  DIAGNOSTICS_CHANGED: [409, 'The capture changed in another tab. Refresh before changing it.'],
  DIAGNOSTICS_ACTIVE: [409, 'Stop capture before clearing its report.'],
  DIAGNOSTICS_INVALID: [400, 'The diagnostic request contains unsupported data.'],
  DIAGNOSTICS_RATE_LIMITED: [429, 'Diagnostic request limit reached. Wait a minute and retry.'],
});

export function diagnosticsError(code) {
  const [status, message] = ERRORS[code] || ERRORS.DIAGNOSTICS_INVALID;
  return Object.assign(new Error(message), { status, code: Object.hasOwn(ERRORS, code) ? code : 'DIAGNOSTICS_INVALID' });
}

const emptyCounts = () => ({
  received: 0, stored: 0, deduplicated: 0, omitted: 0, omittedByRate: 0,
  omittedByCapacity: 0, clientQueueOmitted: 0, rejectedBatches: 0, eventBytes: 2,
});
const add = (value, increment = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + increment);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** One server process, one bounded memory-only capture. Never receives a request. */
export class DiagnosticCapture {
  #capture = null;
  #events = [];
  #index = new Map();
  #counts = emptyCounts();
  #clock;
  #setTimer;
  #clearTimer;
  #timer = null;
  #startedWall = 0;
  #startedMono = 0;
  #elapsed = 0;
  #eventWindow = { start: 0, count: 0 };
  #rateWindows = new Map();

  constructor({ now = Date.now, monotonic = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.#clock = { now, monotonic };
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  #progress() {
    if (!this.#capture?.active) return this.#elapsed;
    // Either clock can end a capture, neither can extend it. The high-water mark
    // also covers a wall-clock rollback after it previously moved forward.
    this.#elapsed = Math.max(this.#elapsed, this.#clock.now() - this.#startedWall, this.#clock.monotonic() - this.#startedMono, 0);
    return this.#elapsed;
  }

  #stop(reason, observed = this.#progress()) {
    const elapsed = Math.min(observed, LIMITS.durationMs);
    if (observed >= LIMITS.durationMs) reason = 'expired';
    this.#capture = {
      ...this.#capture,
      active: false,
      remainingMs: 0,
      stoppedAt: new Date(this.#startedWall + elapsed).toISOString(),
      stopObservedAt: new Date(this.#clock.now()).toISOString(),
      stopReason: reason,
    };
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
  }

  #expire() {
    const elapsed = this.#progress();
    if (this.#capture?.active && elapsed >= LIMITS.durationMs) this.#stop('expired', elapsed);
    return elapsed;
  }

  #schedule() {
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      this.#expire();
      if (this.#capture?.active) this.#schedule();
    }, Math.max(1, Math.ceil(LIMITS.durationMs - this.#progress())));
    this.#timer?.unref?.();
  }

  status() {
    const elapsed = this.#expire();
    const capture = this.#capture && {
      ...this.#capture,
      remainingMs: this.#capture.active ? Math.max(0, Math.ceil(LIMITS.durationMs - elapsed)) : 0,
    };
    return copyDiagnosticState({ capture, counts: this.#counts });
  }

  setEnabled(enabled, expectedCaptureId) {
    this.#expire();
    if (typeof enabled !== 'boolean' || (expectedCaptureId !== null && !isDiagnosticId(expectedCaptureId))) {
      throw diagnosticsError('DIAGNOSTICS_INVALID');
    }
    // Duplicate ON is an acknowledgement of the existing interval, never renewal.
    if (enabled && this.#capture?.active) return this.status();
    if ((this.#capture?.id || null) !== expectedCaptureId) throw diagnosticsError('DIAGNOSTICS_CHANGED');
    if (!enabled) {
      if (this.#capture?.active) this.#stop('manual');
      return this.status();
    }
    this.#events = [];
    this.#index.clear();
    this.#counts = emptyCounts();
    this.#startedWall = this.#clock.now();
    this.#startedMono = this.#clock.monotonic();
    this.#elapsed = 0;
    this.#eventWindow = { start: 0, count: 0 };
    this.#capture = {
      id: randomUUID(), startedAt: new Date(this.#startedWall).toISOString(),
      deadlineAt: new Date(this.#startedWall + LIMITS.durationMs).toISOString(),
      stoppedAt: null, stopObservedAt: null, stopReason: null, active: true, remainingMs: LIMITS.durationMs,
    };
    this.#schedule();
    return this.status();
  }

  clear(expectedCaptureId) {
    this.#expire();
    if (this.#capture?.active) throw diagnosticsError('DIAGNOSTICS_ACTIVE');
    if ((this.#capture?.id || null) !== expectedCaptureId) throw diagnosticsError('DIAGNOSTICS_CHANGED');
    this.#capture = null;
    this.#events = [];
    this.#index.clear();
    this.#counts = emptyCounts();
    return this.status();
  }

  accepts(captureId) {
    this.#expire();
    return Boolean(this.#capture?.active && this.#capture.id === captureId);
  }

  limitRequest(kind) {
    const limits = {
      read: LIMITS.readRequestsPerMinute, download: LIMITS.downloadRequestsPerMinute,
      control: LIMITS.controlRequestsPerMinute, ingest: LIMITS.ingestRequestsPerMinute,
    };
    if (!Object.hasOwn(limits, kind)) throw diagnosticsError('DIAGNOSTICS_INVALID');
    const now = this.#clock.monotonic();
    const prior = this.#rateWindows.get(kind);
    const window = prior && now - prior.start < 60000 ? prior : { start: now, count: 0 };
    this.#rateWindows.set(kind, window);
    if (window.count >= limits[kind]) throw diagnosticsError('DIAGNOSTICS_RATE_LIMITED');
    window.count++;
  }

  rejectBatch() {
    this.#expire();
    if (this.#capture?.active) this.#counts.rejectedBatches = add(this.#counts.rejectedBatches);
  }

  ingest(captureId, events, clientQueueOmitted) {
    if (!this.accepts(captureId)) return { accepted: false, state: this.status() };
    this.#counts.clientQueueOmitted = add(this.#counts.clientQueueOmitted, clientQueueOmitted);
    for (const event of events) this.#record(copyClientDiagnostic(event), 'client', null);
    return { accepted: true, state: this.status() };
  }

  recordRequest(operation, status, code, exception, correlationId, context = {}) {
    this.#expire();
    if (!this.#capture?.active) return;
    const fields = clientDiagnostic({ code, name: exception }, operation, 'request', { ...context, status });
    if (fields.status === null || !isDiagnosticId(correlationId)) return;
    this.#record(fields, 'server', correlationId);
  }

  #record(fields, source, correlationId) {
    const elapsed = this.#expire();
    if (!this.#capture?.active) return;
    this.#counts.received = add(this.#counts.received);
    if (elapsed - this.#eventWindow.start >= 60000) this.#eventWindow = { start: elapsed, count: 0 };
    if (this.#eventWindow.count++ >= LIMITS.eventsPerMinute) {
      this.#counts.omitted = add(this.#counts.omitted);
      this.#counts.omittedByRate = add(this.#counts.omittedByRate);
      return;
    }
    // Server requests keep their individual correlation. Browser repeats share
    // an allowlisted signature; this is a record count, not an incident count.
    const key = JSON.stringify([fields, source, correlationId]);
    const prior = this.#index.get(key);
    const timestamp = new Date(this.#startedWall + Math.floor(elapsed)).toISOString();
    const event = prior ? { ...prior, lastAt: timestamp, occurrences: add(prior.occurrences) } : {
      ...copyClientDiagnostic(fields), source, id: this.#events.length + 1,
      firstAt: timestamp, lastAt: timestamp, occurrences: 1, correlationId,
    };
    const delta = bytes(event) - (prior ? bytes(prior) : 0) + (!prior && this.#events.length ? 1 : 0);
    if ((!prior && this.#events.length >= LIMITS.records) || this.#counts.eventBytes + delta > LIMITS.eventBytes) {
      this.#counts.omitted = add(this.#counts.omitted);
      this.#counts.omittedByCapacity = add(this.#counts.omittedByCapacity);
      return;
    }
    this.#counts.eventBytes += delta;
    if (prior) {
      this.#counts.deduplicated = add(this.#counts.deduplicated);
      Object.assign(prior, event);
    } else {
      this.#events.push(event);
      this.#index.set(key, event);
      this.#counts.stored++;
    }
  }

  report() {
    const state = this.status();
    return copyDiagnosticReport({
      schemaVersion: 1, application: 'citadel-ui', scope: 'server-instance',
      kind: !state.capture ? 'empty' : state.capture.active ? 'snapshot' : 'final',
      limits: { ...LIMITS }, ...state, events: this.#events,
    });
  }

  shutdown() {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#capture = null;
    this.#events = [];
    this.#index.clear();
    this.#counts = emptyCounts();
    this.#rateWindows.clear();
  }
}
