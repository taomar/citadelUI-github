import { h, mount } from './dom.mjs';
import { confirmDialog } from './dialog.mjs';
import { DIAGNOSTIC_ISSUES } from './diagnostics-client.mjs';
import {
  DIAGNOSTICS_LIMITS as LIMITS, DIAGNOSTIC_OPERATIONS,
  copyDiagnosticReport, copyDiagnosticState, diagnosticFilename,
} from '../../shared/diagnostics.mjs';
import { diagnosticGuidance } from '../../shared/diagnostics-guidance.mjs';

export async function downloadDebugReport(report) {
  const safe = copyDiagnosticReport(report);
  const blob = new Blob([`${JSON.stringify(safe, null, 2)}\n`], { type: 'application/json; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: diagnosticFilename(safe) });
  try {
    document.body.append(link);
    link.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    link.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const when = (value) => value ? `${value.slice(0, 10)} ${value.slice(11, 19)} UTC` : 'Not started';
const time = (value) => `${value.slice(11, 19)} UTC`;
const countdown = (ms) => {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
};

/** Fixed DOM for controls; polling replaces only the noninteractive report rows. */
export function mountDebugPage(container, {
  client, confirm = confirmDialog, download = downloadDebugReport,
  setTimer = setInterval, clearTimer = clearInterval,
}) {
  let busy = false;
  let rowKey = null;
  const problem = h('p', { class: 'debug-error', role: 'alert', hidden: true });
  const delivery = h('p', { class: 'debug-notice', role: 'status', hidden: true });
  const actionStatus = h('p', { class: 'debug-hint', role: 'status', hidden: true });
  const captureStatus = h('span', { class: 'debug-status', role: 'status' }, 'Reading status...');
  const remaining = h('span', { class: 'debug-countdown', 'aria-live': 'off' });
  const started = h('dd');
  const deadline = h('dd');
  const stopped = h('dd');
  const toggle = h('input', {
    type: 'checkbox', role: 'switch', disabled: true,
    'aria-label': 'Instance-wide debugging', 'aria-describedby': 'debug-scope debug-window',
    onchange: () => {
      const enabled = toggle.checked;
      const expectedId = client.state?.capture?.id || null;
      return run(async () => {
        if (enabled && expectedId && !(await confirm({
          title: 'Replace the previous debug report?',
          message: 'Starting a new 30-minute capture permanently replaces the retained report. Download it first if you need to keep it.',
          confirmLabel: 'Replace and start capture', cancelLabel: 'Keep report',
        }))) return;
        await client.setEnabled(enabled, expectedId);
      }, 'Capture could not be changed. Refresh its status and retry.');
    },
  });
  const downloadButton = h('button', {
    type: 'button', class: 'btn btn-primary', disabled: true,
    onclick: () => run(async () => {
      await download(await client.download());
      actionStatus.textContent = 'Report download requested. Share the JSON file manually; Citadel has not uploaded it.';
      actionStatus.hidden = false;
    }, 'The debug report could not be downloaded. Retry. Nothing has been shared.', downloadButton),
  }, 'Download debug report');
  const clearButton = h('button', {
    type: 'button', class: 'btn', disabled: true,
    onclick: () => {
      const expectedId = client.state?.capture?.id || null;
      return run(async () => {
        if (!(await confirm({
          title: 'Clear the captured report?',
          message: 'This removes the latest capture from server memory. Download the report first if you need to keep it.',
          confirmLabel: 'Clear report', cancelLabel: 'Keep report',
        }))) return;
        await client.clear(expectedId);
      }, 'The report could not be cleared. Refresh its status and retry.', clearButton);
    },
  }, 'Clear report');
  const refreshButton = h('button', {
    type: 'button', class: 'btn',
    onclick: () => run(() => client.refresh(), 'Diagnostic status could not be refreshed.', refreshButton),
  }, 'Refresh');
  const reportKind = h('span', { class: 'debug-report-kind' });
  const counts = h('p', { class: 'debug-counts' });
  const omitted = h('p', { class: 'debug-notice', hidden: true });
  const empty = h('p', { class: 'debug-empty' }, 'No capture yet. Turn on instance-wide debugging to begin.');
  const rows = h('tbody');
  const table = h('table', { class: 'debug-table', hidden: true },
    h('caption', { class: 'debug-hint' }, 'Errors first, newest first. Recognized optional browser requests follow.'),
    h('thead', {}, h('tr', {}, ['First seen', 'Source and operation', 'Safe error details', 'Count']
      .map((label) => h('th', { scope: 'col' }, label)))), rows);
  const root = h('div', { class: 'sheetwrap debug-content' },
    h('header', { class: 'debug-heading' },
      h('h1', {}, 'Diagnostic capture'),
      h('p', { id: 'debug-scope' }, 'This applies to the whole Citadel server instance, not just this tab. Reproduce the problem in the application while capture is on.')),
    problem, delivery,
    h('section', { class: 'debug-section', 'aria-label': 'Capture controls' },
      h('div', { class: 'debug-capture-bar' },
        h('label', { class: 'toggle debug-toggle' }, toggle,
          h('span', { class: 'toggle-track', 'aria-hidden': 'true' }),
          h('span', { class: 'toggle-label' }, 'Instance-wide debugging')),
        captureStatus, remaining),
      h('p', { id: 'debug-window', class: 'debug-hint' },
        'Off by default. Automatically stops 30 minutes after you enable it. Closing this page, reloading, or opening another tab never extends that deadline.'),
      h('dl', { class: 'debug-timing' },
        h('dt', {}, 'Started'), started,
        h('dt', {}, 'Automatic off'), deadline,
        h('dt', {}, 'Stopped'), stopped)),
    h('section', { class: 'debug-section', 'aria-label': 'Captured report' },
      h('div', { class: 'debug-report-heading' }, h('h2', {}, 'Captured errors'), reportKind),
      h('div', { class: 'debug-actions' }, downloadButton, clearButton, refreshButton),
      actionStatus, counts, omitted, empty, h('div', { class: 'debug-table-wrap' }, table),
      h('p', { class: 'debug-hint' },
        'Only the latest report is retained, in server memory. Stop capture before clearing it. Restarting the server clears the report and leaves debugging off.')),
    h('details', { class: 'debug-help' },
      h('summary', {}, 'Capture coverage and privacy'),
      h('p', {}, 'Records contain fixed error categories, known application codes, HTTP status, known exception classes and bundled module locations when available. Server errors have a server-generated correlation ID. Messages, stacks, URLs, input, source values, paths, labels, credentials, headers and cookies are excluded.'),
      h('p', {}, 'Server/API failures are captured immediately while enabled. Signed-in application tabs discover capture within about 5 seconds while running normally. Reload tabs opened before this feature was installed. Sleeping, offline or throttled tabs may miss errors; there is no historical recovery. Browser capture pauses after 15 seconds without a status response.'),
      h('p', {}, 'Matching browser records are grouped. Multiple boundaries may report the same failure; record counts are not unique incident counts. Queue loss, rejected batches and server limit omissions are reported separately. A failed send may have arrived, so it is not retried and cannot always be counted exactly.'),
      h('p', {}, 'A download during capture is a snapshot; after stop it is final. No errors recorded means no errors were captured, not that the instance passed a test. Citadel never uploads this report.')));
  mount(container, root);

  async function run(work, fallback, button = toggle) {
    if (busy) return;
    busy = true;
    problem.hidden = true;
    actionStatus.hidden = true;
    button.setAttribute('aria-busy', 'true');
    render();
    try {
      await work();
    } catch (error) {
      problem.textContent = error?.status === 409
        ? 'The capture changed in another tab. Its current state has been refreshed; review it before retrying.'
        : error?.status === 429 ? 'Diagnostic request limit reached. Wait a minute, then refresh and retry.' : fallback;
      problem.hidden = false;
    } finally {
      busy = false;
      button.removeAttribute('aria-busy');
      render();
      button.focus();
    }
  }

  function renderRows(report) {
    const key = report ? JSON.stringify([report.capture?.id, report.counts.received, report.counts.stored, report.counts.deduplicated]) : null;
    if (key === rowKey) return;
    rowKey = key;
    const ordered = (report?.events || []).map((event) => ({ event, explanation: diagnosticGuidance(event) }))
      .sort((left, right) => Number(left.explanation.level === 'info') - Number(right.explanation.level === 'info') ||
        right.event.lastAt.localeCompare(left.event.lastAt) || right.event.id - left.event.id);
    mount(rows, ...ordered.map(({ event, explanation }) => {
      return h('tr', {},
        h('td', {}, time(event.firstAt), event.occurrences > 1 ? h('span', { class: 'debug-event-detail' }, `Last ${time(event.lastAt)}`) : null),
        h('td', {}, event.source === 'server' ? 'Server' : 'Browser',
          h('span', { class: 'debug-event-detail' }, DIAGNOSTIC_OPERATIONS[event.operation]),
          event.resource ? h('code', { class: 'debug-event-detail' }, `${event.method ? `${event.method} ` : ''}${event.resource}`)
            : event.method ? h('span', { class: 'debug-event-detail' }, `${event.method} / requested name excluded`) : null),
        h('td', {},
          h('strong', { class: 'debug-event-summary' }, explanation.summary),
          explanation.level === 'info' ? h('span', { class: 'debug-event-detail' }, 'Informational / optional browser request') : null,
          h('code', { class: 'debug-event-detail' }, [
            event.status ? `HTTP ${event.status}` : null,
            !['UNKNOWN', 'HTTP_ERROR'].includes(event.code) ? event.code : null,
            event.exception !== 'UnknownError' ? event.exception : null,
          ].filter(Boolean).join(' / ') || 'No recognized application code or exception class'),
          h('p', { class: 'debug-event-meaning' }, explanation.meaning),
          h('details', { class: 'debug-event-help' },
            h('summary', {}, 'Suggested next step'),
            h('p', {}, explanation.next)),
          event.module ? h('code', { class: 'debug-event-detail' }, `${event.line ? 'Location' : 'Reporting module'} ${event.module}${event.line ? `:${event.line}` : ''}${event.column ? `:${event.column}` : ''}`) : null,
          event.correlationId ? h('code', { class: 'debug-event-detail' }, `Correlation ${event.correlationId}`) : null),
        h('td', {}, event.occurrences));
    }));
  }

  function render() {
    try {
      const state = client.state ? copyDiagnosticState(client.state) : null;
      const report = client.report ? copyDiagnosticReport(client.report) : null;
      const capture = state?.capture;
      const active = Boolean(capture?.active);
      const left = client.remainingMs();
      toggle.checked = active;
      toggle.disabled = busy || !client.connected || !state;
      downloadButton.disabled = busy || !client.connected || !capture;
      clearButton.disabled = busy || !client.connected || !capture || active;
      refreshButton.disabled = busy;
      captureStatus.textContent = !client.connected ? 'Status unavailable'
        : active && left > 0 ? 'On' : active ? 'Confirming automatic off...'
          : capture?.stopReason === 'expired' ? 'Off - stopped automatically' : 'Off';
      captureStatus.dataset.active = String(active && left > 0);
      remaining.textContent = client.connected && active && left > 0 ? `${countdown(left)} remaining` : '';
      started.textContent = when(capture?.startedAt);
      deadline.textContent = capture ? when(capture.deadlineAt) : '30 minutes after enabling';
      stopped.textContent = capture?.stoppedAt
        ? `${when(capture.stoppedAt)}${capture.stopReason === 'expired' ? ' (automatic cutoff)' : ' (manual stop)'}` : active ? 'Not stopped' : 'Not started';
      reportKind.textContent = !capture ? 'No report yet' : active ? 'Live capture / downloads are snapshots' : 'Final report';
      const value = state?.counts;
      counts.textContent = value
        ? `${value.stored} / ${LIMITS.records} records; ${value.eventBytes.toLocaleString()} / ${LIMITS.eventBytes.toLocaleString()} event bytes. ${value.received} received; ${value.deduplicated} repeats grouped.`
        : 'Reading the retained report...';
      omitted.hidden = !value || !(value.omitted || value.clientQueueOmitted || value.rejectedBatches);
      if (value) omitted.textContent = `${value.omitted} server omissions (${value.omittedByCapacity} capacity, ${value.omittedByRate} rate); ${value.clientQueueOmitted} browser queue/send omissions reported; ${value.rejectedBatches} rejected batches. The report is incomplete.`;
      delivery.textContent = client.issues.map((code) => DIAGNOSTIC_ISSUES[code]).filter(Boolean).join(' ');
      delivery.hidden = !delivery.textContent;
      table.hidden = !report?.events.length;
      empty.hidden = Boolean(report?.events.length);
      empty.textContent = !state || !client.connected ? 'Reconnect to read the authoritative report.'
        : !capture ? 'No capture yet. Turn on instance-wide debugging to begin.'
          : !report ? 'Refreshing the retained report...' : 'No errors recorded in this capture.';
      renderRows(report);
    } catch {
      problem.textContent = 'The debug report could not be displayed. Refresh and retry; no report data has been shared.';
      problem.hidden = false;
      toggle.disabled = downloadButton.disabled = clearButton.disabled = true;
    }
  }
  const unsubscribe = client.subscribe(render);
  const timer = setTimer(render, 1000);
  render();
  return { root, render, dispose() { clearTimer(timer); unsubscribe(); root.remove(); } };
}
