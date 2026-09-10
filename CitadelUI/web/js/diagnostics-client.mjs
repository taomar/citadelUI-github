import {
  DIAGNOSTICS_ENDPOINT, DIAGNOSTICS_LIMITS as LIMITS, clientDiagnostic,
  copyClientDiagnostic, copyDiagnosticReport, copyDiagnosticState,
  diagnosticException, diagnosticLocation, diagnosticResource, diagnosticRoute, exactKeys, isDiagnosticId, isDiagnosticPath,
} from '../../shared/diagnostics.mjs';

export const DIAGNOSTIC_ISSUES = Object.freeze({
  'status-unavailable': 'A diagnostic status request failed. Browser errors may be missing. Capture resumes on reconnection; the server deadline is unchanged.',
  'delivery-failed': 'Some browser diagnostics could not be delivered. The report may be incomplete. Failed batches are not retried.',
  'client-overflow': 'The bounded browser queue filled. Omitted browser records are counted when the next batch reaches the server.',
  'poll-only': 'Cross-tab notifications are unavailable in this browser. Capture changes are discovered by polling.',
});

const CHANNEL = 'citadel.diagnostics.v1';
const RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const ACTIONS = new Set(['status', 'report', 'download', 'capture', 'clear', 'events']);
const transportError = (status = null) => Object.assign(new Error('The diagnostic request could not be completed.'), { status });

async function responseJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_BYTES) throw transportError();
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_BYTES) throw transportError();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** No hooks or requests run merely by importing this module. */
export class DiagnosticsClient {
  #token;
  #fetch;
  #window;
  #document;
  #origin;
  #now;
  #monotonic;
  #setTimer;
  #clearTimer;
  #channelFactory;
  #channel = null;
  #includeReport;
  #captureErrors;
  #onUnauthorized;
  #state = null;
  #report = null;
  #connected = false;
  #issues = new Set();
  #listeners = new Set();
  #queue = [];
  #omitted = 0;
  #expiresMono = 0;
  #expiresWall = 0;
  #leaseMono = 0;
  #leaseWall = 0;
  #pollTimer = null;
  #flushTimer = null;
  #refreshPending = null;
  #flushPending = null;
  #controlPending = false;
  #deliveryBlocked = false;
  #generation = 0;
  #started = false;
  #hintAfter = 0;
  #controllers = new Set();

  constructor({
    token, fetchImpl = (...args) => fetch(...args), window: target = globalThis.window,
    document: doc = globalThis.document, origin = target?.location?.origin,
    now = Date.now, monotonic = () => performance.now(),
    setTimer = (...args) => setTimeout(...args), clearTimer = (...args) => clearTimeout(...args),
    channelFactory = (name) => new BroadcastChannel(name), includeReport = false, captureErrors = true,
    onUnauthorized = () => {},
  } = {}) {
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#window = target;
    this.#document = doc;
    this.#origin = origin;
    this.#now = now;
    this.#monotonic = monotonic;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#channelFactory = channelFactory;
    this.#includeReport = includeReport;
    this.#captureErrors = captureErrors;
    this.#onUnauthorized = onUnauthorized;
  }

  get state() { return this.#state ? copyDiagnosticState(this.#state) : null; }
  get report() { return this.#report ? copyDiagnosticReport(this.#report) : null; }
  get connected() { return this.#connected; }
  get issues() { return [...this.#issues]; }

  remainingMs() {
    if (!this.#state?.capture?.active) return 0;
    return Math.max(0, Math.ceil(Math.min(this.#expiresMono - this.#monotonic(), this.#expiresWall - this.#now())));
  }

  collecting() {
    return Boolean(this.#started && this.#connected && this.#state?.capture?.active && this.remainingMs() > 0 &&
      this.#monotonic() < this.#leaseMono && this.#now() < this.#leaseWall);
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }

  #issue(code, broadcast = true) {
    if (typeof code !== 'string' || !Object.hasOwn(DIAGNOSTIC_ISSUES, code)) return;
    const changed = !this.#issues.has(code);
    this.#issues.add(code);
    if (changed && broadcast && code !== 'poll-only') {
      this.#broadcast({ type: 'issue', code, captureId: this.#state?.capture?.id || null });
    }
    if (changed) this.#notify();
  }

  #broadcast(message) {
    if (!this.#channel) return;
    try {
      this.#channel.postMessage(message);
    } catch {
      this.#issue('poll-only', false);
    }
  }

  #applyState(state, requestStarted) {
    const safe = copyDiagnosticState(state);
    const changedCapture = this.#state?.capture?.id !== safe.capture?.id;
    if (changedCapture || this.#state?.capture?.active !== safe.capture?.active) ++this.#generation;
    if (changedCapture || !safe.capture?.active) {
      if (this.#queue.length) this.#issue('delivery-failed');
      this.#queue = [];
      this.#omitted = 0;
    }
    if (changedCapture) {
      for (const code of this.#issues) if (code !== 'poll-only') this.#issues.delete(code);
    }
    this.#state = safe;
    this.#connected = true;
    this.#deliveryBlocked = false;
    const nowMono = this.#monotonic();
    // Subtract the whole round trip, rather than extending a server deadline
    // by the response's travel time or relying on matching browser/server clocks.
    const remaining = Math.max(0, (safe.capture?.remainingMs || 0) - Math.max(0, nowMono - requestStarted));
    this.#expiresMono = nowMono + remaining;
    this.#expiresWall = this.#now() + remaining;
    this.#leaseMono = nowMono + LIMITS.clientLeaseMs;
    this.#leaseWall = this.#now() + LIMITS.clientLeaseMs;
    if (safe.capture?.active && (this.#queue.length || this.#omitted)) this.#scheduleFlush();
    if (changedCapture) this.#broadcast({ type: 'health' });
  }

  async #request(action, method = 'GET', body = null) {
    if (!ACTIONS.has(action)) throw transportError();
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = this.#setTimer(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.#fetch(`${DIAGNOSTICS_ENDPOINT}/${action}`, {
        method, mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        signal: controller.signal,
        headers: { 'X-Citadel-Session': this.#token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        // Never read an error response's text, headers or details into diagnostics.
        await response.body?.cancel?.();
        if (response.status === 401) this.#onUnauthorized();
        throw transportError(response.status);
      }
      return await responseJson(response);
    } finally {
      this.#clearTimer(timeout);
      this.#controllers.delete(controller);
    }
  }

  refresh() {
    if (this.#refreshPending) return this.#refreshPending;
    if (!this.#started || this.#controlPending) return Promise.resolve();
    const generation = this.#generation;
    const began = this.#monotonic();
    this.#refreshPending = (async () => {
      try {
        const response = await this.#request(this.#includeReport ? 'report' : 'status');
        if (!this.#started || generation !== this.#generation) return;
        if (this.#includeReport) {
          const report = copyDiagnosticReport(response);
          this.#applyState({ capture: report.capture, counts: report.counts }, began);
          this.#report = report;
        } else this.#applyState(response, began);
      } catch {
        if (!this.#started || generation !== this.#generation) return;
        this.#connected = false;
        this.#issue('status-unavailable');
      } finally {
        this.#refreshPending = null;
        if (this.#started) this.#notify();
      }
    })();
    return this.#refreshPending;
  }

  record(error, operation = 'app.action', category = 'handled', context = {}) {
    // Off means no inspection and no queue, including unknown/string reasons.
    if (!this.#captureErrors || !this.collecting()) return false;
    const safe = clientDiagnostic(error, operation, category, context);
    if (this.#queue.length >= LIMITS.clientQueueEvents) {
      this.#omitted = Math.min(Number.MAX_SAFE_INTEGER, this.#omitted + 1);
      this.#issue('client-overflow');
      return false;
    }
    this.#queue.push(safe);
    this.#scheduleFlush();
    return true;
  }

  #scheduleFlush() {
    if (this.#flushTimer !== null || !this.#started || this.#deliveryBlocked) return;
    this.#flushTimer = this.#setTimer(async () => {
      this.#flushTimer = null;
      await this.flush();
      if (this.collecting() && (this.#queue.length || this.#omitted)) this.#scheduleFlush();
    }, LIMITS.flushMs);
  }

  recordApi(error, path, status = null, method = 'GET') {
    if (!this.collecting() || isDiagnosticPath(typeof path === 'string' ? path.split(/[?#]/, 1)[0] : '')) return false;
    const detail = status === null ? { code: 'NETWORK_ERROR', name: diagnosticException(error) } : error;
    return this.record(detail, diagnosticRoute(path), 'request', {
      status, module: '/js/local-api.mjs', method, resource: diagnosticResource(path),
    });
  }

  flush() {
    if (this.#flushPending) return this.#flushPending;
    if (!this.collecting()) {
      if (this.#queue.length) this.#issue('delivery-failed');
      this.#queue = [];
      return Promise.resolve();
    }
    if (this.#deliveryBlocked) return Promise.resolve();
    if (!this.#queue.length && !this.#omitted) return Promise.resolve();
    const captureId = this.#state.capture.id;
    const generation = this.#generation;
    const batch = this.#queue.splice(0, LIMITS.batchEvents).map(copyClientDiagnostic);
    const omitted = Math.min(1000, this.#omitted);
    this.#omitted -= omitted;
    const began = this.#monotonic();
    this.#flushPending = (async () => {
      try {
        const result = await this.#request('events', 'POST', { captureId, events: batch, clientQueueOmitted: omitted });
        if (!exactKeys(result, ['accepted', 'state']) || typeof result.accepted !== 'boolean') throw transportError();
        const state = copyDiagnosticState(result.state);
        if (this.#started && generation === this.#generation) {
          if (!result.accepted) this.#issue('delivery-failed');
          this.#applyState(state, began);
        }
      } catch {
        // A failed send may have reached the server. Never retry the same batch
        // or replace the application error with a diagnostic transport error.
        if (this.#started && generation === this.#generation) {
          this.#deliveryBlocked = true;
          this.#omitted = Math.min(Number.MAX_SAFE_INTEGER, this.#omitted + omitted + batch.length);
          this.#issue('delivery-failed');
        }
      } finally {
        this.#flushPending = null;
        if (this.#started) this.#notify();
      }
    })();
    return this.#flushPending;
  }

  async #control(action, body) {
    if (this.#controlPending || !this.#started) throw transportError();
    this.#controlPending = true;
    ++this.#generation;
    const began = this.#monotonic();
    try {
      const state = await this.#request(action, 'POST', body);
      this.#applyState(state, began);
      this.#report = null;
      this.#broadcast({ type: 'refresh' });
    } finally {
      this.#controlPending = false;
      // Wait out an older poll so it cannot block the authoritative follow-up.
      await this.#refreshPending;
      await this.refresh();
      this.#notify();
    }
  }

  setEnabled(enabled, expectedCaptureId = this.#state?.capture?.id || null) {
    return this.#control('capture', { enabled, expectedCaptureId });
  }

  clear(expectedCaptureId = this.#state?.capture?.id || null) {
    return this.#control('clear', { expectedCaptureId });
  }

  async download() {
    return copyDiagnosticReport(await this.#request('download'));
  }

  #onError = (event) => {
    if (!this.collecting()) return;
    if (typeof event.filename === 'string' && [
      '/js/diagnostics-client.mjs', '/shared/diagnostics.mjs', '/shared/diagnostics-guidance.mjs',
    ].some((path) => event.filename === `${this.#origin}${path}`)) {
      this.#issue('delivery-failed');
      return;
    }
    const location = diagnosticLocation(event.filename, this.#origin, event.lineno, event.colno);
    this.record(event.error, 'client.uncaught', 'uncaught', location);
  };
  #onRejection = (event) => {
    this.record(event.reason, 'client.rejection', 'unhandled-rejection');
  };
  #onFocus = () => { this.#hint(); };
  #onVisibility = () => { if (this.#document?.visibilityState === 'visible') this.#hint(); };
  #onPageHide = () => { void this.flush(); };
  #hint() {
    const now = this.#monotonic();
    if (now < this.#hintAfter) return;
    this.#hintAfter = now + 1000;
    void this.refresh();
  }
  #onMessage = (event) => {
    const message = event.data;
    if (exactKeys(message, ['type']) && message.type === 'refresh') this.#hint();
    if (exactKeys(message, ['type']) && message.type === 'health') {
      for (const code of this.#issues) if (code !== 'poll-only') {
        this.#broadcast({ type: 'issue', code, captureId: this.#state?.capture?.id || null });
      }
    }
    if (exactKeys(message, ['type', 'code', 'captureId']) && message.type === 'issue' &&
        (message.captureId === null || isDiagnosticId(message.captureId)) &&
        message.captureId === (this.#state?.capture?.id || null)) this.#issue(message.code, false);
  };

  async start() {
    if (this.#started) return this.refresh();
    this.#started = true;
    if (this.#captureErrors) {
      this.#window?.addEventListener('error', this.#onError);
      this.#window?.addEventListener('unhandledrejection', this.#onRejection);
    }
    this.#window?.addEventListener('focus', this.#onFocus);
    this.#window?.addEventListener('pagehide', this.#onPageHide);
    this.#document?.addEventListener('visibilitychange', this.#onVisibility);
    try {
      this.#channel = this.#channelFactory(CHANNEL);
      this.#channel?.addEventListener('message', this.#onMessage);
      this.#broadcast({ type: 'health' });
    } catch {
      this.#issue('poll-only', false);
    }
    const poll = async () => {
      await this.refresh();
      if (this.#started) this.#pollTimer = this.#setTimer(poll, LIMITS.pollMs);
    };
    await poll();
  }

  stop() {
    this.#started = false;
    ++this.#generation;
    this.#clearTimer(this.#pollTimer);
    this.#clearTimer(this.#flushTimer);
    for (const controller of this.#controllers) controller.abort();
    this.#channel?.close();
    this.#channel = null;
    this.#window?.removeEventListener('error', this.#onError);
    this.#window?.removeEventListener('unhandledrejection', this.#onRejection);
    this.#window?.removeEventListener('focus', this.#onFocus);
    this.#window?.removeEventListener('pagehide', this.#onPageHide);
    this.#document?.removeEventListener('visibilitychange', this.#onVisibility);
    this.#queue = [];
    this.#report = null;
    this.#state = null;
    this.#token = null;
    this.#listeners.clear();
  }
}

let current = null;
export function startDiagnostics(options) {
  if (!current) {
    current = new DiagnosticsClient(options);
    void current.start();
  }
  return current;
}

export function reportClientError(error, operation = 'app.action', context = {}) {
  return current?.record(error, operation, 'handled', context) || false;
}

export function reportApiFailure(error, path, status = null, method = 'GET') {
  return current?.recordApi(error, path, status, method) || false;
}
