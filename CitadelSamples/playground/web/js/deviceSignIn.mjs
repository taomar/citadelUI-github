const active = new Set(['starting', 'pending', 'ready', 'cancelling']);
const messages = {
  starting: 'Requesting a code from Microsoft.',
  pending: 'Waiting for you to verify with Microsoft.',
  ready: 'Microsoft verification finished. Choose Finish sign-in to use this account.',
  cancelling: 'Cancellation requested. Waiting for the previous request to stop before retrying.',
  cancelled: 'Device sign-in cancelled.',
  expired: 'Device sign-in expired. Request a new code when ready.',
  declined: 'Microsoft verification was declined.',
  failed: 'Device sign-in stopped. Retry explicitly when ready.',
};

export function createDeviceSignIn({ post, refresh, changed, intervalMs = 1000 }) {
  let current = null, generation = 0, timer, completionAttempted = false, transientDisplay = false;
  let cancellationRequested = false;
  // Recent retired handles add local rollback protection behind capability request epochs.
  const retired = new Set();
  function retire(id) {
    if (!id) return;
    retired.add(id);
    if (retired.size > 32) retired.delete(retired.values().next().value);
  }
  function publish(value) { current = value; changed(value); }
  function stop() { clearTimeout(timer); timer = null; }
  function unavailable(message) {
    publish({ ...current, userCode: undefined, verificationUri: undefined, statusUnavailable: true, message });
  }
  async function readback(version, id) {
    try { await refresh(); }
    catch {
      if (version === generation && current?.flowId === id) unavailable(
        'The owning flow could not be checked. Choose Check status to retry this read; cancellation will not be sent again.');
      return;
    }
    if (version === generation && current?.flowId === id) await poll({ manual: true });
  }
  function schedule() {
    stop();
    if (current && (active.has(current.state) || current.settled === false || current.retryAfterMs > 0)
      && !completionAttempted) timer = setTimeout(poll, intervalMs);
  }
  async function poll({ manual = false } = {}) {
    const version = generation, id = current?.flowId;
    if (!id) return;
    if (!manual && Date.now() > current.deadlineAt + 70000) {
      unavailable('The status observation deadline passed. Choose Check status for a read-only update; no new code was requested.');
      return;
    }
    try {
      const result = await post('status', { flowId: id });
      if (version !== generation) return;
      const previousState = current.state;
      const { userCode, verificationUri, ...metadata } = result;
      publish({ ...metadata, ...(transientDisplay ? { userCode, verificationUri } : {}),
        cancellationRequested, resumed: !transientDisplay,
        ...(cancellationRequested && ['starting', 'pending', 'ready'].includes(result.state)
          ? { message: 'Cancellation is not confirmed. This flow is still active. Cancel it explicitly again or wait for its status; no account will be adopted.' } : {}) });
      if (!active.has(result.state) && active.has(previousState)) await refresh();
    } catch {
      if (version !== generation) return;
      unavailable('Status is unavailable. Choose Check status for this exact flow; no sign-in or cancellation will be retried.');
      return;
    }
    if (version === generation) schedule();
  }
  return Object.freeze({
    snapshot: () => current,
    reconcile(auth) {
      const flow = auth?.deviceFlow;
      if (!flow) {
        if (current && (active.has(current.state) || current.statusUnavailable)) { retire(current.flowId); generation++; stop(); publish(null); }
        return;
      }
      if (retired.has(flow.flowId)) return;
      if (flow.flowId === current?.flowId) return;
      retire(current?.flowId);
      generation++; stop(); completionAttempted = false; transientDisplay = false; cancellationRequested = false;
      publish({ ...flow, resumed: true });
      schedule();
    },
    async start(purpose) {
      generation++; stop(); completionAttempted = false; transientDisplay = true; cancellationRequested = false;
      const version = generation;
      let result;
      try { result = await post('start', { purpose }); }
      catch (error) {
        await refresh();
        throw error;
      }
      if (version !== generation) return;
      if (current?.flowId !== result.flowId) retire(current?.flowId);
      publish(result);
      await refresh();
      if (version === generation) schedule();
    },
    async cancel() {
      if (!current) return;
      const id = current.flowId, version = ++generation;
      stop(); completionAttempted = false; transientDisplay = false; cancellationRequested = true;
      publish({ ...current, state: 'cancelling', settled: false, cancellationRequested,
        userCode: undefined, verificationUri: undefined, statusUnavailable: false,
        message: 'Requesting cancellation. No account will be adopted from this flow.' });
      let result;
      try { result = await post('cancel', { flowId: id }); }
      catch {
        if (version !== generation) return;
        unavailable('Cancellation could not be confirmed. Checking this flow without retrying cancellation.');
        await readback(version, id);
        return;
      }
      if (version !== generation) return;
      publish({ ...result, cancellationRequested });
      try { await refresh(); }
      catch {
        if (version === generation) unavailable('The application state could not be refreshed. Choose Check status before requesting a new code.');
        return;
      }
      if (version === generation) schedule();
    },
    async checkStatus() {
      if (!current?.statusUnavailable) return;
      const id = current.flowId, version = ++generation;
      stop();
      await readback(version, id);
    },
    async complete() {
      if (!current || current.state !== 'ready' || completionAttempted || cancellationRequested || current.statusUnavailable) return;
      const id = current.flowId, version = ++generation;
      completionAttempted = true; stop();
      publish({ ...current, completionAttempted: true });
      try { await post('complete', { flowId: id }); }
      catch {
        if (version !== generation) return;
        // An uncertain response is reconciled, never replayed into a new account.
        await refresh();
        if (version !== generation) return;
        if (current?.flowId === id) publish({ ...current, completionAttempted: true,
          message: 'Completion could not be confirmed. Cancel and restart; completion will not be replayed.' });
        return;
      }
      if (version !== generation) return;
      retire(id);
      publish(null);
      await refresh();
    },
    dispose() { generation++; stop(); current = null; },
  });
}

export function updateDeviceSignIn(root, flow, { busy = false } = {}) {
  const panel = root.querySelector('#device-sign-in');
  if (!panel) return;
  panel.hidden = !flow;
  if (!flow) return;
  const text = (selector, value) => {
    const node = panel.querySelector(selector);
    if (node.textContent !== value) node.textContent = value;
  };
  text('[data-device-status]', flow.message ?? (flow.code === 'device-rate-limited'
    ? 'Microsoft asked to slow down. Wait for the cooldown, then choose Retry.' : messages[flow.state] ?? 'Device sign-in stopped.'));
  text('[data-device-code]', flow.userCode ?? '');
  text('[data-device-expiry]', `Time remaining: ${Math.max(0, Math.ceil((flow.expiresAt - Date.now()) / 1000))} seconds.`);
  text('[data-device-resumed]', flow.resumed ? 'This page was reloaded. The code is not restored. Cancel and request a new code if needed.' : '');
  const link = panel.querySelector('#device-verification-link');
  link.hidden = !flow.verificationUri;
  if (flow.verificationUri && new URL(flow.verificationUri).protocol === 'https:') {
    link.href = flow.verificationUri; link.textContent = flow.verificationUri;
  } else link.removeAttribute('href');
  const cancel = panel.querySelector('#device-cancel');
  cancel.hidden = !active.has(flow.state);
  cancel.disabled = busy || !['starting', 'pending', 'ready'].includes(flow.state);
  const complete = panel.querySelector('#device-complete');
  complete.hidden = flow.state !== 'ready' || flow.cancellationRequested === true;
  complete.disabled = busy || flow.state !== 'ready' || flow.completionAttempted === true
    || flow.cancellationRequested === true || flow.statusUnavailable === true;
  const retry = panel.querySelector('#device-retry');
  retry.hidden = active.has(flow.state);
  retry.disabled = busy || active.has(flow.state) || !flow.settled || flow.retryAfterMs > 0 || flow.statusUnavailable === true;
  const check = panel.querySelector('#device-check-status');
  check.hidden = flow.statusUnavailable !== true;
  check.disabled = busy || flow.statusUnavailable !== true;
}
