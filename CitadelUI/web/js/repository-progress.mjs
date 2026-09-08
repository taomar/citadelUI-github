import { h } from './dom.mjs';

export const STATUS_DELAY_MS = 10_000;
export const ACTIVITY_DELAY_MS = 15_000;

const ACTIVE = new Set(['preparing', 'creating', 'copying', 'verifying']);
const PHASES = {
  source: { label: 'Source validation', verb: 'validated' },
  copy: { label: 'File copy', verb: 'copied' },
  verify: { label: 'File verification', verb: 'verified' },
};
const TITLES = {
  preparing: 'Checking the source',
  ready: 'Ready to create the repository',
  creating: 'Creating the private repository',
  copying: 'Copying source files',
  verifying: 'Verifying the import',
  paused: 'Setup paused',
  failed: 'Setup stopped',
  complete: 'Repository ready',
};
const PUBLISHING = new Set(['publishing-main', 'default-branch', 'bootstrap-cleanup']);

function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function text(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

/** Percentages describe confirmed files in one phase, never overall time left. */
export function createRepositoryProgress({ now = () => Date.now() } = {}) {
  const mark = h('span', { class: 'stage-mark', 'aria-hidden': 'true' });
  const title = h('strong');
  const heading = h('p', { class: 'stage repository-progress-heading', role: 'status', 'aria-live': 'polite' }, mark, title);
  const detail = h('p', { class: 'repository-progress-detail' });
  const count = h('p', { class: 'repository-progress-count', role: 'status', 'aria-live': 'polite' });
  const meter = h('progress', { class: 'repository-progress-meter', hidden: true });
  const itemPath = h('code');
  const item = h('p', { class: 'repository-progress-item', hidden: true }, 'Current item: ', itemPath);
  const timing = h('p', { class: 'repository-progress-timing', 'aria-live': 'off' });
  const waiting = h('p', { class: 'repository-progress-waiting', role: 'status', 'aria-live': 'polite', hidden: true });
  const root = h('section', {
    class: 'repository-progress', hidden: true, 'aria-label': 'Repository setup progress',
  }, heading, detail, count, meter, item, timing, waiting);
  let state = {};
  let watchedId = null;
  let observedAt = now();
  let changedAt = observedAt;
  let signature = '';

  function tick() {
    const { operation, busy = false, uncertain = false, lastStatusAt = null, statusFailed = false } = state;
    root.hidden = !operation && !busy && !uncertain;
    if (root.hidden) return;
    const at = now();
    const running = Boolean(operation && (operation.running || ACTIVE.has(operation.state)));
    const delayed = running && at - (lastStatusAt ?? observedAt) >= STATUS_DELAY_MS;
    const unknown = statusFailed || delayed;
    const retrying = Number.isFinite(operation?.retryAt) && operation.retryAt > at;
    const publishing = PUBLISHING.has(operation?.stageId);
    const finished = operation?.state === 'complete' && !uncertain && !unknown;
    let label = TITLES[operation?.state] || 'Contacting GitHub';
    if (publishing && running) label = 'Publishing the snapshot on main';
    if (operation?.stageId === 'verify-settings' && running) label = 'Checking private repository settings';
    if (retrying) label = 'Waiting to resume';
    if (uncertain) label = 'Confirming the last request';
    if (unknown) label = 'Waiting for a status update';
    text(title, label);
    heading.className = `stage repository-progress-heading ${unknown || retrying ? 'stage-pending'
      : finished ? 'stage-done' : running || busy || uncertain ? 'stage-active'
        : operation?.state === 'failed' ? 'stage-failed' : 'stage-pending'}`;
    text(mark, finished ? '\u2713' : operation?.state === 'failed' ? '\u2717' : '');

    let description = operation?.stage || 'Sending the setup request. Keep this dialog open for live progress.';
    if (operation?.state === 'copying' && !publishing) {
      description = 'Copying files and folders. GitHub writes are paced to avoid rate limits; publication and verification follow.';
    } else if (publishing && running) {
      description = 'The files are copied. Publishing the import commit and main branch before final verification.';
    } else if (operation?.state === 'verifying') {
      description = operation.stageId === 'verify-settings'
        ? 'All files have been verified. Confirming private visibility and the final branch.'
        : 'The snapshot is on GitHub. Reading files back before confirming the repository is ready.';
    } else if (finished) {
      description = 'The private repository is created and verified. Continue to repository to choose a branch.';
    }
    text(detail, description);

    const progress = operation?.progress;
    const phase = PHASES[progress?.phase];
    const phaseMatches = progress?.phase === 'source' && ['preparing', 'ready'].includes(operation?.state)
      || progress?.phase === 'copy' && operation?.state === 'copying'
      || progress?.phase === 'verify' && operation?.state === 'verifying'
      || ['paused', 'failed'].includes(operation?.state);
    const measurable = Boolean(phase && phaseMatches && !publishing && operation?.stageId !== 'verify-settings' &&
      !finished && !busy && !uncertain && Number.isSafeInteger(progress?.total) && progress.total > 0 &&
      Number.isSafeInteger(progress.completed) && progress.completed >= 0 && progress.completed <= progress.total);
    count.hidden = !measurable;
    meter.hidden = !measurable;
    if (measurable) {
      const percent = Math.floor(progress.completed * 100 / progress.total);
      const summary = `${progress.completed} of ${progress.total} files ${phase.verb} (${percent}% of ${phase.label.toLowerCase()}).`;
      text(count, summary);
      meter.setAttribute('max', String(progress.total));
      meter.setAttribute('value', String(progress.completed));
      meter.setAttribute('aria-label', phase.label);
      meter.setAttribute('aria-valuetext', summary);
    }
    item.hidden = !measurable || !progress.currentPath;
    text(itemPath, item.hidden ? '' : progress.currentPath);

    const started = Date.parse(operation?.startedAt);
    const updated = Date.parse(operation?.updatedAt);
    const activityAt = Number.isFinite(updated) ? updated : changedAt;
    const end = running || busy || uncertain || unknown ? at : Number.isFinite(updated) ? updated : changedAt;
    const elapsed = Number.isFinite(started)
      ? `Elapsed ${duration(end - started)}`
      : `Watching for ${duration(end - observedAt)}`;
    const freshness = running || unknown || uncertain
      ? lastStatusAt === null ? 'Waiting for the first status response' : `Last status ${duration(at - lastStatusAt)} ago`
      : '';
    text(timing, [elapsed, freshness, retrying ? `Retry in ${duration(operation.retryAt - at)}` : ''].filter(Boolean).join(' \u00b7 '));
    let waitText = '';
    if (statusFailed) {
      waitText = 'Live updates were interrupted. Retrying automatically; Refresh status checks this same attempt. Do not create another repository.';
    } else if (delayed) {
      waitText = 'A status response is taking longer than expected. The import may still be running. Use Refresh status to check this same attempt.';
    } else if (retrying) {
      waitText = 'GitHub needs a cooldown before this attempt can resume. The private repository is retained.';
    } else if (uncertain) {
      waitText = 'The last request may have finished. Confirming this attempt before allowing another action.';
    } else if (running && at - activityAt >= ACTIVITY_DELAY_MS) {
      waitText = 'Waiting for the next confirmed activity. Large files and GitHub request pacing can take time. Refresh or pause this same attempt rather than starting again.';
    } else if (running) {
      waitText = 'Status refreshes automatically. File copy and verification have separate counts; neither is an estimate of time remaining.';
    }
    waiting.hidden = !waitText;
    text(waiting, waitText);
  }

  function update(next) {
    state = next;
    const id = next.operation?.id || null;
    if (id !== watchedId) {
      watchedId = id;
      observedAt = now();
      changedAt = observedAt;
      signature = '';
    }
    const current = JSON.stringify([next.operation?.state, next.operation?.stageId, next.operation?.progress]);
    if (current !== signature) { signature = current; changedAt = now(); }
    tick();
  }

  return { root, update, tick };
}
