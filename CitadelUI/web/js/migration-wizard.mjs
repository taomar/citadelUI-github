import { h, mount } from './dom.mjs';
import { showDialog, dismissDialog, confirmDialog } from './dialog.mjs';
import { renderDiff } from './diff.mjs';
import { MigrationDonor } from './migration-donor.mjs';
import { inspectPublicDonorRepository, listPublicDonorBranches, PublicGitHubMigrationDonor } from './migration-public-donor.mjs';
import { MIGRATION_AREAS } from './migration-session.mjs';
import { MigrationError, migrationMessage, migrationParameterKey, safeLabel } from '../../shared/migration-input.mjs';
import { migrationQuantity as quantity, migrationRowVisible, migrationSelectionSummary, renderMigrationModels, renderMigrationValue } from './migration-value-view.mjs';
import { renderMigrationTargetPreview } from './migration-target-preview.mjs';

const STATUS = Object.freeze({
  copy: 'Accepted replacement',
  'accepted-unchanged': 'Accepted value already current — no edit',
  keep: 'Destination deliberately retained',
  'unreviewed-retain': 'Unreviewed — destination retained',
  'retain-current': 'Current value / inherited default retained',
  'not-copied': 'Not copied',
});

export function downloadMigrationFile(file) {
  const blob = new Blob([file.text], { type: `${file.type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: file.name });
  link.click();
  // No content/paths in a URL, registry, server draft, or activity entry.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function summaryRow(label, ...value) {
  return h('div', { class: 'catalog-summary-row' }, h('dt', {}, label), h('dd', {}, value));
}

function field(id, label, control, hint = null) {
  control.classList.add('ctl');
  control.setAttribute('id', id);
  control.setAttribute('name', id);
  if (hint) control.setAttribute('aria-describedby', `${id}-hint`);
  return h('label', { class: 'catalog-field', for: id },
    h('span', { class: 'catalog-field-label' }, label), control,
    hint ? h('small', { class: 'hint', id: `${id}-hint` }, hint) : null);
}

function disclosure(label, children, { open = false, className = '', ontoggle } = {}) {
  return h('details', { class: `sec migration-row ${className}`.trim(), open, ontoggle },
    h('summary', { class: 'sec-band' },
      h('span', { class: 'sec-caret', 'aria-hidden': 'true' }, '\u203a'),
      h('span', { class: 'migration-row-title' }, label)),
    h('div', { class: 'migration-detail-body' }, children));
}

function contextNode(destination, target = null) {
  return h('section', { class: 'migration-context', 'aria-label': 'Current destination' },
    h('dl', { class: 'catalog-summary' },
      summaryRow('Destination', `${destination.project} › ${destination.workspace}`),
      summaryRow(destination.remote ? 'Repository' : 'Local folder',
        h('code', {}, destination.remote ? destination.location : destination.folder)),
      destination.remote ? summaryRow('Branch', h('code', {}, destination.branch)) : null,
      target ? summaryRow('Parameter file', h('code', {}, safeLabel(target.alias))) : null),
    h('details', {},
      h('summary', { class: 'hint' }, 'Destination details'),
      h('div', { class: 'migration-detail-body' },
        h('p', { class: 'hint' }, destination.remote
          ? 'Preview and local export only. No remote writes or commits.'
          : destination.localBranchNote),
        !destination.remote && destination.location !== destination.folder
          ? h('p', { class: 'hint' }, 'Display-only location: ', h('code', {}, destination.location)) : null,
        target ? h('p', { class: 'hint' }, 'Current template: ',
          h('code', {}, safeLabel(target.template || 'Unresolved / missing'))) : null)),
  );
}

/**
 * A local-first modal, deliberately independent of setup/GitHub attachment.
 * Native pickers are injectable for synthetic handle tests, not automated by
 * pretending an OS picker can be clicked by Playwright.
 */
export async function openMigrationWizard({
  session,
  chooseDirectory = globalThis.showDirectoryPicker
    ? () => globalThis.showDirectoryPicker({ id: 'citadel-migration-donor', mode: 'read' }) : null,
  chooseFiles = globalThis.showOpenFilePicker
    ? () => globalThis.showOpenFilePicker({
      id: 'citadel-migration-files', multiple: true, excludeAcceptAllOption: true,
      types: [{
        description: 'Bicep parameters, optional Bicep templates, or ARM deployment parameters',
        accept: { 'text/plain': ['.bicepparam', '.bicep'], 'application/json': ['.json'] },
      }],
    }) : null,
  download = downloadMigrationFile,
  publicRequest,
  sourceConnection = null,
  onApplied = async () => {},
  show = showDialog,
  dismiss = dismissDialog,
  confirm = confirmDialog,
  surface = null,
  onExit = () => {},
}) {
  const sourceSession = session;
  const areaReviews = new Map();
  const targetReviews = new Map();
  let pairingOriginal = null;
  let sourceReturn = null;
  let preparedSources = [];
  const body = h('div', { class: surface ? 'migration-workspace' : 'catalog-dialog migration-body' });
  const footer = h('div', { class: 'migration-actions' });
  const notice = h('p', { class: 'catalog-progress migration-notice', role: 'status', 'aria-live': 'polite' });
  let step = 'donor';
  let renderedScreen = null;
  let sourceKind = '';
  let accessMode = 'public';
  let connection = sourceConnection;
  let profiles = [];
  let profileId = '';
  let tokenHelpExpanded = false;
  let allowDismiss = false;
  let busy = false;
  let busyAction = null;
  let returnActionFocus = null;
  let failed = false;
  let pending = null;
  let closed = false;
  let message = '';
  let targets = [];
  let donor = null;
  let donorEntries = [];
  let unassignedEntries = [];
  let otherEntries = [];
  let otherSourceId = '';
  let additionalSources = new Map();
  let donorRevision = null;
  let donorExclusions = [];
  let donorGeneration = 0;
  let repositoryInfo = null;
  let branches = [];
  let branchState = 'idle';
  let branchFailure = '';
  let branchesTruncated = false;
  const githubForm = { repository: '', refType: 'branch', ref: '' };
  const sourceControls = new Map();
  let selectedIds = new Set();
  let area = '';
  let targetAlias = '';
  let view = null;
  let preview = null;
  let result = null;
  let filter = '';
  let mappingScope = 'differences';
  let heldMappingRows = new Set();
  let candidateChoices = new Map();
  let backendChoices = new Map();
  const reportHistory = [];
  const decisionControls = new Map();
  const pairingControls = new Map();
  let expandedRows = new Map();
  const actionControls = new Map();
  const tokenInput = h('input', {
    id: 'migration-source-token', name: 'migration-source-token', class: 'ctl',
    type: 'password', autocomplete: 'off', spellcheck: false,
    placeholder: 'github_pat_…', 'aria-label': 'Source GitHub token',
    'aria-describedby': 'migration-source-token-hint',
  });

  function action(label, handler, { primary = false, disabled = false, key = label, className = '' } = {}) {
    const button = h('button', {
      type: 'button', class: `${primary ? 'btn btn-primary' : 'btn'} ${className}`.trim(),
      disabled: busy || disabled, dataset: { action: key },
      'aria-busy': busy && busyAction === key ? 'true' : null,
      onclick: (event) => {
        if (busy) return pending;
        busyAction = key;
        const result = handler(event);
        if (!busy) busyAction = null;
        return result;
      },
    }, label);
    actionControls.set(key, button);
    return button;
  }

  function resetPlan() {
    session.invalidate();
    failed = false;
    view = null;
    preview = null;
    expandedRows.clear();
    candidateChoices.clear();
    backendChoices.clear();
    heldMappingRows.clear();
    mappingScope = 'differences';
  }

  function reviewState() {
    return {
      session, step, selectedIds, targetAlias, view, preview, result, filter, mappingScope,
      heldMappingRows, candidateChoices, backendChoices, expandedRows,
      additionalSources, otherSourceId, message, failed, pairingOriginal,
      scrollTop: body.parentElement?.scrollTop || 0,
      focus: [...decisionControls, ...pairingControls, ...actionControls]
        .find(([, control]) => control === document.activeElement)?.[0] || null,
    };
  }

  function newReview() {
    return {
      session: sourceSession.forkReview(),
      step: 'pair', selectedIds: new Set(), targetAlias: '', view: null, preview: null, result: null,
      filter: '', mappingScope: 'differences', heldMappingRows: new Set(),
      candidateChoices: new Map(), backendChoices: new Map(), expandedRows: new Map(),
      additionalSources: new Map(), otherSourceId: '', message: '', failed: false,
      pairingOriginal: null, scrollTop: 0, focus: null,
    };
  }

  function restoreReview(saved) {
    ({ session, step, selectedIds, targetAlias, view, preview, result, filter, mappingScope,
      heldMappingRows, candidateChoices, backendChoices, expandedRows, additionalSources,
      otherSourceId, message, failed, pairingOriginal } = saved);
  }

  function saveAreaReview() {
    if (!area || !donor || step === 'donor') return;
    const saved = reviewState();
    areaReviews.set(area, saved);
    targetReviews.set(`${area}:${targetAlias}`, saved);
  }

  function selectArea(next, { initial = false } = {}) {
    if (sourceReturn && step === 'donor') {
      area = sourceReturn.area;
      restoreReview(sourceReturn.review);
      sourceReturn = null;
      if (next === area) { render('migration-area'); return; }
    }
    if ((!initial && busy) || next === area) return;
    if (!MIGRATION_AREAS.some((item) => item.id === next)) throw new MigrationError('scope');
    saveAreaReview();
    const saved = areaReviews.get(next) || newReview();
    area = next;
    restoreReview(saved);
    areaReviews.set(area, saved);
    if (!initial) {
      render(saved.focus || 'migration-area');
      if (body.parentElement) body.parentElement.scrollTop = saved.scrollTop;
      saveAreaReview();
    }
  }

  function stateHasChoices(saved) {
    return saved && (saved.step !== 'done' && saved.view && migrationSelectionSummary(saved.view.rows).selected > 0 ||
      saved.step !== 'done' && saved.view?.rows.some((row) => row.structured?.summary?.confirmedBackends > 0) ||
      saved.pairingOriginal && stateHasChoices(saved.pairingOriginal));
  }

  function hasProposedChanges() {
    return stateHasChoices(reviewState()) || stateHasChoices(sourceReturn?.review) ||
      [...targetReviews.values()].some(stateHasChoices);
  }

  function selectTarget(next) {
    if (next === targetAlias || busy) return;
    if (next && !targets.some((target) => target.alias === next && target.area === area)) throw new MigrationError('scope');
    const initial = !targetAlias && !view && !pairingOriginal && !targetReviews.has(`${area}:${next}`);
    let scrollTop = body.parentElement?.scrollTop || 0;
    if (initial) {
      targetReviews.delete(`${area}:`);
      targetAlias = next;
      otherSourceId = '';
    } else {
      saveAreaReview();
      const saved = targetReviews.get(`${area}:${next}`) || { ...newReview(), targetAlias: next };
      restoreReview(saved);
      scrollTop = saved.scrollTop;
    }
    message = 'Each target keeps a separate draft. Browsing does not discard choices.';
    render('migration-target');
    if (body.parentElement) body.parentElement.scrollTop = scrollTop;
    saveAreaReview();
  }

  function renderTargetNavigation() {
    const select = h('select', {
      disabled: busy, 'aria-label': 'Destination parameter file',
      onchange: (event) => selectTarget(event.target.value),
    }, h('option', { value: '' }, 'Choose the current destination…'),
    targets.filter((target) => target.area === area).map((target) => {
      const saved = targetReviews.get(`${area}:${target.alias}`);
      return h('option', { value: target.alias }, `${target.name} — ${target.label}${stateHasChoices(saved) ? ' · saved choices' : ''}`);
    }));
    select.value = targetAlias;
    pairingControls.set('migration-target', select);
    return field('migration-target', 'Target configuration (new)', select,
      'Each existing target has its own source pairing, selections and preview.');
  }

  function editPairing() {
    if (pairingOriginal) return;
    saveAreaReview();
    pairingOriginal = reviewState();
    session = sourceSession.forkReview();
    selectedIds = new Set(selectedIds);
    additionalSources = new Map(additionalSources);
    expandedRows = new Map(expandedRows);
    view = null;
    preview = null;
    step = 'pair';
    message = `The saved draft for ${safeLabel(targetAlias)} is retained until a replacement mapping succeeds and is confirmed.`;
    render('migration-target');
  }

  function cancelPairing() {
    if (!pairingOriginal) return;
    session.close();
    restoreReview(pairingOriginal);
    message = 'Saved file pairing and all choices restored.';
    render();
  }

  function renderAreaNavigation() {
    return h('nav', { class: 'migration-area-navigation', 'aria-label': 'Migration areas' },
      MIGRATION_AREAS.map((item) => {
        const active = item.id === area;
        const saved = active ? { selectedIds, view, step } : areaReviews.get(item.id);
        const count = saved?.view ? migrationSelectionSummary(saved.view.rows).selected : 0;
        const subtitle = saved?.step === 'done' ? 'Applied locally'
          : count ? `${quantity(count, 'value')} selected`
            : saved?.selectedIds.size ? `${quantity(saved.selectedIds.size, 'source file')} selected`
              : 'Choose source values';
        const control = h('button', {
          type: 'button', class: `area${active ? ' active' : ''}`, disabled: busy || !donor,
          'aria-current': active ? 'page' : null,
          dataset: { action: `area-${item.id}`, area: item.id },
          onclick: () => selectArea(item.id),
        }, h('span', { class: 'area-title' }, item.id === 'deployment' && surface ? 'Azure Deployment' : item.label),
        h('span', { class: 'area-sub' }, subtitle));
        if (active) pairingControls.set('migration-area', control);
        actionControls.set(`area-${item.id}`, control);
        return control;
      }),
      h('p', { class: 'migration-area-hint' }, 'Move between areas freely. Each keeps its own selections and review.'));
  }

  function selectedSourceArea() {
    const source = sourceEntries().find((entry) => selectedIds.has(entry.id));
    return source?.area || (selectedIds.size ? targets.find((target) => target.alias === targetAlias)?.area || area : '');
  }

  function sourceEntries() {
    return [...donorEntries, ...additionalSources.values()];
  }

  function retainCompatibleTarget() {
    const pairingArea = selectedSourceArea() || area;
    if (pairingArea && targetAlias &&
        !targets.some((target) => target.alias === targetAlias && target.area === pairingArea)) {
      targetAlias = '';
    }
  }

  function resetDonor() {
    resetPlan();
    for (const saved of areaReviews.values()) if (saved.session !== sourceSession) saved.session.close();
    if (session !== sourceSession) session.close();
    areaReviews.clear();
    for (const saved of targetReviews.values()) {
      saved.session.close();
      saved.pairingOriginal?.session.close();
    }
    targetReviews.clear();
    pairingOriginal = null;
    session = sourceSession;
    sourceSession.invalidate();
    donorGeneration += 1;
    donor = null;
    donorRevision = null;
    donorEntries = [];
    unassignedEntries = [];
    otherEntries = [];
    otherSourceId = '';
    additionalSources.clear();
    donorExclusions = [];
    selectedIds = new Set();
    targets = [];
    area = '';
    targetAlias = '';
  }

  function clearBranches() {
    branches = [];
    branchState = 'idle';
    branchFailure = '';
    branchesTruncated = false;
  }

  function forgetRepository() {
    repositoryInfo = null;
    clearBranches();
    githubForm.ref = '';
  }

  function branchSelected() {
    return githubForm.refType !== 'branch' || Boolean(repositoryInfo && branchState === 'loaded' &&
      branches.some((branch) => branch.name === githubForm.ref));
  }

  function sourceReady() {
    return Boolean(githubForm.repository.trim() && githubForm.ref.trim() && branchSelected());
  }

  function sourcePreparationHint() {
    if (busy && ['prepare-source', 'read-github'].includes(busyAction)) return message || 'Preparing the offline source…';
    if (failed && sourceReady()) return 'Preparation did not complete. Resolve the error above, then prepare the source again. Existing saved sources and target drafts are unchanged.';
    if (sourceReady()) return 'Next: prepare an offline copy, then choose the values to import. This does not change the target.';
    if (githubForm.refType !== 'branch') return 'Enter the source repository and an explicit tag or full commit SHA to continue.';
    if (branchState === 'loading') return 'Loading branches. Choose a branch when the list is ready.';
    if (branchState === 'error') return 'Retry the branch lookup, then choose a branch to continue.';
    if (branchState === 'loaded' && !branches.length) return 'This repository has no branches. Choose another repository or an explicit tag or commit.';
    return repositoryInfo ? 'Choose a source branch, then prepare its offline copy to continue.'
      : 'Find the repository, choose a branch, then prepare the source to continue.';
  }

  function changeSource() {
    return run('Opening source choices…', async () => {
      if (!sourceReturn) {
        saveAreaReview();
        sourceReturn = { area, review: reviewState() };
      }
      preparedSources = await sourceSession.preparedSources();
      sourceKind = '';
      step = 'donor';
      message = 'The current prepared source and every target draft are kept until a replacement is prepared and confirmed.';
    });
  }

  function returnToSource() {
    if (!sourceReturn) return;
    area = sourceReturn.area;
    restoreReview(sourceReturn.review);
    sourceReturn = null;
    render('migration-area');
  }

  function refreshSource() {
    return run('Preparing an explicit source refresh…', async () => {
      if (!donor?.snapshot) return;
      if (!sourceReturn) {
        saveAreaReview();
        sourceReturn = { area, review: reviewState() };
      }
      const previous = donor;
      step = 'donor';
      if (donorRevision?.repository) {
        sourceKind = 'github';
        Object.assign(githubForm, { repository: donorRevision.repository, refType: donorRevision.refType, ref: donorRevision.ref });
        accessMode = previous.kind === 'public-github' ? 'public' : accessMode === 'public' ? 'token' : accessMode;
        if (previous.kind !== 'public-github' && !connection?.connected) {
          forgetRepository();
          message = 'Reconnect only to acquire the refreshed source. The current offline copy and drafts are unchanged.';
          return;
        }
        const selection = { ...githubForm, repositoryId: donorRevision.repositoryId };
        const selected = previous.kind === 'public-github'
          ? new PublicGitHubMigrationDonor({ ...selection, request: publicRequest })
          : connection.createDonor(selection);
        await readSourceInventory(selected, donorGeneration);
      } else {
        sourceKind = '';
        const selection = previous.kind === 'local-folder' ? await chooseDirectory() : await chooseFiles();
        const selected = new MigrationDonor(previous.kind === 'local-folder' ? { folder: selection } : { files: selection });
        await selected.entries({ request: true });
        await readSourceInventory(selected, donorGeneration);
      }
    });
  }

  async function sourceController() {
    if (!connection) {
      const { MigrationGitHubConnection } = await import('./migration-github-connection.mjs');
      connection = new MigrationGitHubConnection();
    }
    return connection;
  }

  function requestClose() {
    if (busy) return pending;
    const staged = hasProposedChanges();
    tokenInput.value = '';
    if (!connection && !staged) {
      allowDismiss = true;
      dismiss();
      return;
    }
    return run(staged ? 'Confirming whether to discard proposed changes…' : 'Erasing the source connection…', async () => {
      if (staged && !await confirm({
        title: 'Discard proposed migration changes?',
        message: 'Your pending import choices in all areas will be discarded. Completed imports are not undone; pending choices have not changed either environment.',
        confirmLabel: 'Discard proposed changes',
        cancelLabel: 'Keep reviewing',
      })) {
        message = 'Proposed changes kept. Continue reviewing or preview the selected values.';
        return;
      }
      if (connection) await connection.disconnect();
      allowDismiss = true;
      dismiss();
    });
  }

  function leaveGitHub() {
    tokenInput.value = '';
    return run('Closing the GitHub source…', async () => {
      if (connection) await connection.disconnect();
      forgetRepository();
      sourceKind = '';
      message = '';
    });
  }

  function chooseAnotherTarget() {
    selectTarget('');
  }

  function rememberReport() {
    const report = preview.report;
    reportHistory.push(structuredClone({
      reviewId: preview.id, capturedAt: new Date().toISOString(), status: 'preview-only',
      certification: 'Historical name report only, not an active plan or deployment-ready configuration.',
      destination: report.destination, donor: report.donor, binding: report.binding,
      pairs: report.pairs, summary: report.summary, classification: report.classification,
      blockers: report.blockers, unresolved: report.unresolved,
    }));
  }

  function migrationContext(target) {
    const oldName = donor ? safeLabel(donorRevision?.repository || donor.label) : 'Choose an old environment';
    return h('section', { class: 'migration-context', 'aria-label': 'Migration context' },
      h('div', { class: 'migration-flow-context' },
        h('p', {}, h('strong', {}, 'Source (old) · read-only'), h('span', {}, oldName),
          donorRevision?.repository ? h('small', { class: 'hint' }, `${donorRevision.refType}: ${donorRevision.refType === 'commit' ? donorRevision.commit : safeLabel(donorRevision.ref)}`) : null),
        h('p', {}, h('strong', {}, 'Target (new) · values to keep or update'),
          h('span', {}, `${session.destination.project} › ${session.destination.workspace}`),
          target ? h('small', { class: 'hint' }, safeLabel(target.alias)) : null)),
      h('p', { class: 'hint' }, session.destination.remote
        ? 'Preview/export only. No remote writes or commits.'
        : 'Local apply is available after review. The old source is never written.'),
      disclosure('Source and destination details', [
        contextNode(session.destination, target),
        donor ? h('p', {}, 'Read-only source: ', h('code', {}, oldName)) : null,
        donor?.snapshot ? h('p', { class: 'hint' },
          `Prepared ${donor.snapshot.createdAt}: ${donor.snapshot.files} configuration/template files. Sensitive application data is retained privately in this app until you delete it. Reviewing uses this immutable copy, not the original source.`) : null,
        donor?.snapshot ? action('Refresh old source', refreshSource, { key: 'refresh-source',
          disabled: donor.kind === 'local-folder' && !chooseDirectory || donor.kind === 'local-files' && !chooseFiles }) : null,
        donor && step !== 'pair' && step !== 'donor' ? action('Change old source', changeSource, { key: 'change-source' }) : null,
        donorRevision?.repository ? [
          h('p', {}, donor.kind === 'authenticated-github' ? 'GitHub donor — authenticated, read-only' : 'Public GitHub donor — anonymous, read-only'),
          h('p', {}, `Repository ID: ${donorRevision.repositoryId} · ${donorRevision.refType}: ${donorRevision.refType === 'commit' ? donorRevision.commit : safeLabel(donorRevision.ref)}`),
          h('p', {}, 'Pinned commit: ', h('code', {}, donorRevision.commit)),
          h('p', {}, 'Pinned tree: ', h('code', {}, donorRevision.treeSha)),
        ] : null,
      ]));
  }

  function render(focusRow = null) {
    if (closed) return;
    const screen = `${area}:${step}:${sourceKind}:${accessMode}:${Boolean(connection?.connected)}`;
    const sameScreen = renderedScreen === screen;
    const scroller = body.parentElement;
    const scrollTop = sameScreen ? scroller?.scrollTop : null;
    const focusedAction = document.activeElement?.dataset?.action;
    actionControls.clear();
    decisionControls.clear();
    pairingControls.clear();
    const selectedTarget = view?.target || targets.find((target) => target.alias === targetAlias);
    const heading = h('h3', { tabindex: -1 }, {
      donor: sourceKind === 'github' ? 'GitHub source' : 'Choose a source',
      pair: 'Choose source configuration',
      map: 'Select old values to import',
      review: 'Preview selected values',
      done: 'Local migration applied',
    }[step]);
    notice.textContent = message;
    notice.hidden = !message;
    notice.className = `migration-notice ${failed ? 'field-error catalog-error' : 'catalog-progress'}`;
    notice.setAttribute('role', failed ? 'alert' : 'status');
    notice.setAttribute('aria-live', failed ? 'assertive' : 'polite');
    body.setAttribute('aria-busy', busy ? 'true' : 'false');
    const content = step === 'donor' ? renderSourceChoice()
      : step === 'pair' ? renderPairing()
      : step === 'map' ? surface ? renderTargetWorkspace() : renderMapping()
        : step === 'review' ? surface ? h('div', {}, renderTargetWorkspace(), renderReview()) : renderReview()
          : h('section', { class: 'migration-result' },
            h('p', {}, `${result.copied} reviewed parameter replacement${result.copied === 1 ? '' : 's'} applied to the displayed local destination.`),
            h('p', {}, 'Transaction receipt: ', h('code', {}, safeLabel(result.transactionId))),
            h('p', {}, 'The donor was not written. Previous destination bytes are backed up through the normal transaction history; use Settings > History for undo/recovery.'),
            h('p', { class: 'hint' }, 'No deployment ran. Review remaining semantic/reference items separately before using this configuration.'),
          );
    const steps = ['donor', 'pair', 'map', 'review'];
    const position = step === 'done' ? steps.length : steps.indexOf(step);
    const panel = h('div', { class: 'migration-area-panel' },
      surface ? null : h('ol', { class: 'catalog-steps', 'aria-label': 'Migration progress' },
        ['Source', 'Files', 'Mapping', 'Review'].map((label, index) =>
          h('li', {
            class: `catalog-step${index === position ? ' catalog-step-current' : index < position ? ' catalog-step-done' : ''}`,
            'aria-current': index === position ? 'step' : null,
          }, label))),
      migrationContext(selectedTarget),
      donor && step !== 'donor' ? renderTargetNavigation() : null,
      surface && ['map', 'review'].includes(step) ? null : heading, notice, content, renderReportHistory(),
    );
    mount(body, surface ? panel : donor && step !== 'donor'
      ? h('div', { class: 'migration-area-layout' }, renderAreaNavigation(), panel) : panel);
    if (surface) {
      mount(surface.areas, renderAreaNavigation());
      if (surface.breadcrumb) surface.breadcrumb.textContent = selectedTarget?.alias || 'Migration preview';
    }
    const actions = [
      action(surface ? 'Exit migration' : step === 'done' ? 'Close' : 'Cancel', requestClose, { key: 'close' }),
    ];
    if (step === 'donor' && sourceKind === 'github') {
      actions.push(
        action('Back', leaveGitHub, { key: 'source-options' }),
        accessMode !== 'public' && !connection?.connected
          ? action(accessMode === 'saved' ? 'Use source connection' : 'Connect source', connectSource,
            { primary: true, disabled: accessMode === 'saved' && !profileId, key: 'connect-source' })
          : action('Prepare source', connectGitHub, { primary: true, disabled: !sourceReady(), key: 'read-github' }),
      );
    } else if (step === 'pair') {
      const pairingArea = selectedSourceArea() || area;
      actions.push(action('Change source', changeSource, { key: 'change-source' }));
      if (pairingOriginal) actions.push(action('Cancel pairing changes', cancelPairing, { key: 'cancel-pairing' }));
      actions.push(action('Inspect mapping', () => run('Reading selected files and current schema…', async () => {
        const candidate = await session.plan({ donor, sourceIds: [...selectedIds], targetAlias });
        if (stateHasChoices(pairingOriginal) && !await confirm({
          title: 'Replace this target draft?',
          message: `Replace the saved import choices for ${safeLabel(targetAlias)} with this new file pairing? Other target and area drafts stay unchanged.`,
          confirmLabel: 'Replace this target draft', cancelLabel: 'Keep saved draft',
        })) {
          cancelPairing();
          return;
        }
        pairingOriginal?.session.close();
        pairingOriginal = null;
        view = candidate;
        preview = null;
        step = 'map';
        message = 'Check only the values you want to import. Everything else in the new file stays unchanged.';
      }), {
        primary: true,
        disabled: !donor || !selectedIds.size || !pairingArea ||
          !targets.some((target) => target.alias === targetAlias && target.area === pairingArea),
        key: 'map',
      }));
    } else if (step === 'map') {
      actions.push(
        action('Change file pairing', editPairing, { key: 'pair' }),
        action(surface ? 'Review migration' : `Preview ${quantity(migrationSelectionSummary(view.rows).changes, 'change')}`, () => run('Rechecking selected values, files and workspace…', async () => {
          preview = await session.previewSelected();
          view = session.view();
          rememberReport();
          step = 'review';
          message = '';
        }), { primary: true, key: 'preview' }),
      );
    } else if (step === 'review') {
      actions.push(
        action('Back to mapping', () => { step = 'map'; render(); }, { key: 'back' }),
      );
      if (!session.destination.remote) {
        actions.push(action(surface ? 'Apply selected values' : `Apply ${quantity(preview.report.summary.changeCount, 'change')}`, () => run('Awaiting explicit local-apply confirmation…', async () => {
          const agreed = await confirm({
            title: 'Apply reviewed migration locally?',
            message: `Apply ${quantity(preview.report.summary.changeCount, 'selected change')} to this one new configuration file? All unselected values stay unchanged. A verified backup is required before writing; no deployment runs.`,
            confirmLabel: 'Apply reviewed local changes',
            context: contextNode(session.destination, view.target),
          });
          if (!agreed) { message = 'Apply cancelled. Nothing was written.'; return; }
          message = 'Verifying freshness, backing up, and applying the local transaction…';
          render();
          result = await session.apply(preview.id, { reviewed: true });
          const saved = reportHistory.find((report) => report.reviewId === preview.id);
          saved.status = 'applied';
          saved.summary.copied = result.copied;
          saved.transactionId = safeLabel(result.transactionId);
          step = 'done';
          message = 'Local changes applied; no remote writes and no donor writes.';
          try { await onApplied(result); }
          catch { message = 'Local changes were applied. Reopen the destination editor to refresh it safely.'; }
        }), { primary: true, disabled: !preview.canApply, key: 'apply' }));
      } else if (surface) actions.push(action('Export migration', () => exportFile('draft'), { primary: true, key: 'export-migration' }));
    } else if (step === 'done') {
      actions.push(action('Review another file', chooseAnotherTarget, { key: 'another-target' }));
    }
    if (step === 'donor' && sourceReturn) actions.push(action('Return to prepared source', returnToSource, { key: 'return-source' }));
    const selection = view && ['map', 'review'].includes(step) ? migrationSelectionSummary(view.rows) : null;
    mount(footer, surface ? h('strong', { class: 'chip chip-warn' }, 'Migration preview') : null,
      selection ? h('p', { class: 'migration-footer-summary', role: 'status' },
      `${quantity(selection.selected, 'value')} selected · ${quantity(selection.changes, 'change')}${selection.alreadyCurrent ? ` · ${selection.alreadyCurrent} already same` : ''}`) : null, actions);
    if (focusRow) (decisionControls.get(focusRow) || pairingControls.get(focusRow) || actionControls.get(focusRow) || sourceControls.get(focusRow))?.focus({ preventScroll: true });
    else if (!sameScreen) requestAnimationFrame(() => {
      heading.focus({ preventScroll: true });
      if (body.parentElement) body.parentElement.scrollTop = 0;
    });
    else if (!busy) actionControls.get(returnActionFocus || focusedAction)?.focus({ preventScroll: true });
    if (sameScreen && scroller && Number.isFinite(scrollTop)) scroller.scrollTop = scrollTop;
    if (!busy) returnActionFocus = null;
    renderedScreen = screen;
    saveAreaReview();
  }

  function renderSourceChoice() {
    if (sourceKind === 'github') return renderGitHubSetup();
    const choice = (label, hint, handler, key, disabled = false) =>
      action([h('strong', {}, label), h('span', { class: 'hint' }, hint)], handler,
        { key, disabled, className: 'catalog-choice-option' });
    return h('div', { class: 'catalog-form' },
      h('p', { class: 'hint' }, 'Prepare the old configuration once. Mapping, navigation and review use its private offline copy, not the original folder or repository.'),
      action('Reload prepared list', () => run('Loading retained source copies…', async () => {
        preparedSources = await sourceSession.preparedSources();
      }), { key: 'reload-prepared' }),
      preparedSources.length ? h('section', { class: 'catalog-form', 'aria-label': 'Prepared sources' },
        h('h4', {}, 'Prepared sources'),
        preparedSources.map((source) => h('div', { class: 'catalog-form-actions' },
          h('span', { class: 'hint' }, source.source?.label || 'Unavailable source',
            ` · ${source.status}${source.id === donor?.id ? ' · current' : ''}`),
          source.status === 'complete' ? action('Use prepared source', () => run('Opening the prepared source…', async () => {
            if (source.id === donor?.id && sourceReturn) { returnToSource(); return; }
            await readSourceInventory(await sourceSession.openPreparedSource(source.id), donorGeneration);
          }), { key: `use-prepared-${source.id}` }) : null,
          action('Delete retained copy', () => run('Confirming source deletion…', async () => {
            if (!await confirm({
              title: 'Delete this prepared source?', message: `Delete ${source.source?.label || 'this unavailable capture'} from private application storage? This cannot be undone.`,
              confirmLabel: 'Delete retained copy', cancelLabel: 'Keep source',
            })) return;
            await sourceSession.deletePreparedSource(source.id);
            preparedSources = await sourceSession.preparedSources();
          }), { key: `delete-prepared-${source.id}`, disabled: source.id === donor?.id })))) : null,
      h('div', { class: 'catalog-choice' },
        choice('Local folder', 'Read parameter files from a checked-out folder on this machine.',
          () => pick('folder'), 'choose-folder', !chooseDirectory),
        choice('Parameter files', 'Choose .bicepparam or ARM deployment-parameters JSON files.',
          () => pick('files'), 'choose-files', !chooseFiles),
        choice('GitHub repository', 'Read a public repository anonymously, or use a connection or token for a private source.',
          () => { sourceKind = 'github'; message = ''; render(); }, 'choose-github')),
      !chooseDirectory || !chooseFiles ? h('p', { class: 'migration-warning' },
        'Local selection requires a browser with file-system access, such as desktop Edge or Chrome. GitHub sources remain available.') : null,
      disclosure('Supported files and read-only access', [
        h('p', { class: 'hint' }, 'Folders and explicit files support .bicepparam, strict ARM deploymentParameters JSON and referenced .bicep templates within the normal safe scope. Select optional .bicep files for donor @secure metadata.'),
        h('p', { class: 'hint' }, 'Local folders use currently checked-out files, not another Git branch. No host path is sent to the server. Scripts are not accepted or executed.'),
        h('p', { class: 'hint' }, 'Configuration can contain sensitive values or comments. The captured copy is owner-only application data, retained until explicit deletion: at most 8 copies / 256 MiB total, 64 MiB / 256 files per copy. No automatic refresh or eviction.'),
      ]),
    );
  }

  function renderPairing() {
    const entries = sourceEntries();
    const selectionArea = selectedSourceArea();
    const pairingArea = selectionArea || area;
    const areaTargets = targets.filter((target) => !pairingArea || target.area === pairingArea);
    const parameters = [
      ...entries.filter((entry) => !area || entry.area === area),
      ...(area ? unassignedEntries.map((entry) => ({ ...entry, area })) : []),
    ].sort((left, right) => left.name.localeCompare(right.name) || left.alias.localeCompare(right.alias));
    const groups = MIGRATION_AREAS.map((entry) => ({
      ...entry, items: parameters.filter((source) => source.area === entry.id),
    })).filter((entry) => entry.items.length);
    return h('div', { class: 'migration-pairing' },
      h('p', { class: 'hint' }, 'Select old source files for this area, then choose the current target. Use the area navigation to move between configurations; each keeps its own choices. No environment files change here.'),
      groups.map((group) => h('fieldset', { class: 'migration-sources', 'aria-label': `${group.label} source configurations` },
        h('legend', {}, group.label),
        group.items.map((entry) => {
          const checkbox = h('input', {
            class: 'ctl-check', name: 'migration-source-file',
            type: 'checkbox', checked: selectedIds.has(entry.id),
            disabled: busy,
            'aria-describedby': 'migration-selection-hint',
            dataset: { sourceId: entry.id, sourceAlias: entry.alias, sourceArea: entry.area },
            onchange: (event) => {
              if (busy) return pending;
              if (entry.area !== area) {
                event.target.checked = false;
                failed = true;
                message = 'That source belongs to another area. Open its area before selecting it.';
                render('migration-area');
                return;
              }
              if (event.target.checked) selectedIds.add(entry.id);
              else selectedIds.delete(entry.id);
              retainCompatibleTarget();
              resetPlan();
              message = '';
              render(entry.id);
            },
          });
          pairingControls.set(entry.id, checkbox);
          return h('label', { class: 'migration-source' }, checkbox,
            h('span', { class: 'migration-source-copy' },
              h('strong', {}, safeLabel(entry.name)),
              h('span', { class: 'hint' }, `${entry.parameters} parameter assignments`,
                entry.dynamic ? ` · ${entry.dynamic} expressions require review` : '',
                donor.kind === 'local-files' ? ' · explicitly selected file' : ''),
              h('code', { class: 'migration-source-path' }, safeLabel(entry.alias))));
        })
      )),
      !groups.length && !busy ? h('p', { class: 'migration-warning' }, otherEntries.length
        ? 'Choose a new destination, then select matching values from Other old parameter files below.'
        : unassignedEntries.length && !area
        ? 'Choose an area to review the selected parameter files.'
        : area ? 'No eligible source configuration was found in this area.'
          : 'No eligible Deployments, LLM Onboarding, or Access Contracts were found. Choose another source.') : null,
      h('div', { class: 'catalog-form-actions' },
        h('span', { class: 'hint', id: 'migration-selection-hint' },
          selectedIds.size
            ? `${selectedIds.size} selected in ${MIGRATION_AREAS.find((entry) => entry.id === selectionArea)?.label || 'this area'}. These choices are kept when you navigate to another area.`
            : 'Select configuration from one area for each review.'),
        action('Clear selection', () => {
          const focusSource = [...selectedIds][0];
          selectedIds = new Set();
          resetPlan();
          message = '';
          render(focusSource || 'migration-area');
        }, { disabled: !selectedIds.size, key: 'clear-sources' })),
      pairingArea && !areaTargets.length && !busy ? h('p', { class: 'migration-warning' }, 'No existing destination configuration was found for this area. No target or contract instance will be invented.') : null,
      otherEntries.length ? renderOtherSources() : null,
      donorExclusions.length ? disclosure(`${donorExclusions.length} source reading issues`, [
        h('ul', {}, donorExclusions.slice(0, 50).map((entry) => h('li', {}, `${entry.file}: ${entry.reason}`))),
        donorExclusions.length > 50 ? h('p', { class: 'hint' }, 'Showing the first 50 exclusions.') : null,
      ]) : null,
      h('p', { class: 'hint' }, 'Only selected old files contribute matching values. Review at most 16 together. Base templates, publish contracts, policies, scripts and known tooling remain outside migration.'),
    );
  }

  function renderOtherSources() {
    const target = targets.find((entry) => entry.alias === targetAlias);
    const names = new Set((target?.parameterNames || []).map(migrationParameterKey));
    const files = otherEntries.map((entry) => ({
      ...entry, matches: entry.names.filter((name) => names.has(migrationParameterKey(name))).length,
    }));
    const chooser = h('select', {
      class: 'ctl', name: 'other-source-file', disabled: busy || !target,
      'aria-label': 'Other old parameter file',
      onchange: (event) => { otherSourceId = event.target.value; render('other-source'); },
    }, h('option', { value: '' }, target ? 'Choose an old parameter file…' : 'Choose a new destination first…'),
    files.map((entry) => h('option', { value: entry.id, disabled: !entry.matches },
      `${safeLabel(entry.alias)} · ${entry.matches} matching new parameters`)));
    chooser.value = otherSourceId;
    pairingControls.set('other-source', chooser);
    const selected = files.find((entry) => entry.id === otherSourceId);
    return disclosure(`Other old parameter files (${files.length})`, [
      h('p', { class: 'hint' }, 'An unfamiliar old layout is not a reason to discard its values. Choose the new destination, then explicitly select a parsed old file with matching names. No old definitions are added.'),
      field('migration-other-source', 'Old parameter file', chooser),
      action('Use selected old file', () => {
        const chosenArea = selectedSourceArea();
        if (!target || !selected?.matches || chosenArea && chosenArea !== target.area) {
          failed = true;
          message = 'Choose a compatible new destination or clear the current source selection first.';
          render('other-source');
          return;
        }
        additionalSources.set(selected.id, { ...selected, area: target.area });
        selectedIds.add(selected.id);
        resetPlan();
        message = 'Old file selected explicitly. Only matching values for the current new file will be proposed.';
        render('other-source');
      }, { key: 'use-other-source', disabled: !target || !selected?.matches }),
    ], { open: expandedRows.get('other-sources') || false, ontoggle: (event) => expandedRows.set('other-sources', event.target.open) });
  }

  function renderTokenField() {
    tokenInput.disabled = busy;
    const help = h('div', {
      id: 'migration-token-help', class: 'catalog-token-help',
      hidden: !tokenHelpExpanded, role: 'region', 'aria-label': 'Read-only source token help',
    },
    h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener noreferrer' },
      'Create a fine-grained token on GitHub'),
    h('ol', {},
      h('li', {}, 'Give the token a name and a short expiration. Set Resource owner to the user or organization that owns the source.'),
      h('li', {}, 'Under Repository access, choose Only select repositories and select the source repository.'),
      h('li', {}, 'Under Repository permissions, set ', h('strong', {}, 'Contents: Read-only'), '.'),
      h('li', {}, 'Generate the token, copy it once, and paste it into Source GitHub token.')),
    h('p', {}, h('strong', {}, 'Metadata: Read-only'), ' is included automatically. Leave other permissions unset. Source reading does not require write, Administration, repository creation, Actions, or Workflows permissions.'),
    h('p', {}, 'Organization approval may be required before a token can read private repositories. A token cannot grant more access than your account has.'),
    h('p', {}, 'This token is session-only and is erased from the form when submitted. Saved connection persistence is managed separately in Settings.'));
    const toggle = h('button', {
      type: 'button', class: 'btn btn-sm', disabled: busy,
      'aria-controls': 'migration-token-help', 'aria-expanded': String(tokenHelpExpanded),
      onclick: () => {
        tokenHelpExpanded = !tokenHelpExpanded;
        help.hidden = !tokenHelpExpanded;
        toggle.setAttribute('aria-expanded', String(tokenHelpExpanded));
      },
    }, 'Token help');
    return h('div', { class: 'catalog-field' },
      h('div', { class: 'catalog-field-head' },
        h('label', { class: 'catalog-field-label', for: 'migration-source-token' }, 'Source GitHub token'), toggle),
      tokenInput,
      h('small', { id: 'migration-source-token-hint', class: 'hint' },
        'Fine-grained token. Only select the source repository; Contents: Read-only. Metadata read is automatic. Session only.'),
      help);
  }

  function renderGitHubSetup() {
    const access = h('select', {
      disabled: busy, 'aria-label': 'GitHub source access',
      onchange: (event) => changeAccess(event.target.value),
    },
    h('option', { value: 'public' }, 'Public repository (anonymous)'),
    h('option', { value: 'saved' }, 'Saved GitHub connection'),
    h('option', { value: 'token' }, 'Personal access token'));
    access.value = accessMode;
    const status = connection?.status() || { connected: false };
    const credentialFields = [];
    if (accessMode !== 'public' && status.connected) {
      credentialFields.push(
        h('div', { class: 'catalog-connection-summary' },
          h('strong', {}, status.profile ? safeLabel(status.profile.name) : 'Session-only source connection'),
          h('code', {}, `@${safeLabel(status.account.login)}`),
          h('span', { class: 'chip chip-ok' }, 'Connected')),
        h('p', { class: 'hint' }, 'This read-only source session is separate from your destination connection.'),
        h('div', { class: 'catalog-form-actions' },
          action('Change source connection', () => run('Erasing the source connection…', async () => {
            tokenInput.value = '';
            donorGeneration += 1;
            forgetRepository();
            await connection.disconnect();
            message = 'Source connection erased. Choose a connection or paste a new source token.';
          }), { key: 'disconnect-source' })));
    } else if (accessMode === 'saved') {
      const chooser = h('select', {
        disabled: busy, 'aria-label': 'Saved source connection',
        onchange: (event) => {
          profileId = event.target.value;
          donorGeneration += 1;
          forgetRepository();
          render('saved-profile');
        },
      }, h('option', { value: '' }, 'Choose a saved connection…'),
      profiles.map((profile) => h('option', { value: profile.id },
        `${safeLabel(profile.name)} (@${safeLabel(profile.accountLogin)})`)));
      chooser.value = profileId;
      sourceControls.set('saved-profile', chooser);
      credentialFields.push(field('migration-source-profile', 'Source connection', chooser,
        'Uses a separate read-only source session. It does not reconnect, replace, or sign out your destination.'));
      if (!profiles.length && !busy) credentialFields.push(h('p', { class: 'hint' },
        'No saved connections are available. Choose Personal access token to connect this source for the session.'));
    } else if (accessMode === 'token') {
      credentialFields.push(renderTokenField());
    }
    if (accessMode !== 'public' && !status.connected) {
      return h('div', { class: 'catalog-form migration-source-setup' },
        field('migration-github-access', 'GitHub access', access), credentialFields,
        h('div', { class: 'catalog-form-actions' },
          action(accessMode === 'saved' ? 'Use source connection' : 'Connect source', connectSource,
            { primary: true, disabled: accessMode === 'saved' && !profileId, key: 'connect-source-inline' })));
    }
    const repositoryField = (key, label, placeholder, hint = null) => {
      const input = h('input', {
        type: 'text', value: githubForm[key], disabled: busy, placeholder,
        autocomplete: 'off', spellcheck: false, 'aria-label': label,
        oninput: (event) => changeRepositoryField(key, event.target.value, event.target.selectionStart),
        onchange: (event) => changeRepositoryField(key, event.target.value, event.target.selectionStart),
      });
      sourceControls.set(key, input);
      return field(`migration-github-${key}`, label, input, hint);
    };
    const type = h('select', {
      disabled: busy, 'aria-label': 'Source ref type',
      onchange: (event) => changeRepositoryField('refType', event.target.value),
    }, ['branch', 'tag', 'commit'].map((value) => h('option', { value },
      value === 'commit' ? 'Full commit SHA' : value === 'branch' ? 'Branch' : 'Tag')));
    type.value = githubForm.refType;
    sourceControls.set('refType', type);
    let refField;
    if (githubForm.refType === 'branch') {
      const branch = h('select', {
        disabled: busy || branchState !== 'loaded' || !branches.length,
        'aria-label': 'Source branch',
        onchange: (event) => changeRepositoryField('ref', event.target.value),
      }, h('option', { value: '' }, branchState === 'loading' ? 'Loading branches…'
        : branchState === 'error' ? 'Branch lookup failed'
          : branchState === 'loaded' && !branches.length ? 'No branches found'
            : repositoryInfo ? 'Choose a branch…' : 'Find the repository first…'),
      branches.map((entry) => h('option', { value: entry.name }, entry.name)));
      branch.value = githubForm.ref;
      sourceControls.set('ref', branch);
      refField = field('migration-github-ref', 'Source branch', branch,
        'Choose an actual repository branch. The default branch is not selected automatically.');
    } else {
      refField = repositoryField('ref', 'Source branch, tag, or full commit SHA',
        githubForm.refType === 'commit' ? 'Enter the full commit SHA…' : 'Enter an explicit tag…');
    }
    const prepare = action(busy && ['prepare-source', 'read-github'].includes(busyAction)
      ? 'Preparing source…' : 'Prepare source and continue', connectGitHub,
      { primary: true, disabled: !sourceReady(), key: 'prepare-source' });
    prepare.setAttribute('aria-describedby', 'migration-prepare-source-hint');
    const preparationHint = h('p', { id: 'migration-prepare-source-hint', class: 'hint', role: 'status', 'aria-live': 'polite' },
      sourcePreparationHint());
    sourceControls.set('prepare-source-hint', preparationHint);
    const findRepository = action('Find repository', () => run('Checking source repository access…', async () => {
      const generation = donorGeneration;
      const repository = accessMode === 'public'
        ? await inspectPublicDonorRepository(githubForm.repository, publicRequest)
        : await connection.inspectRepository(githubForm.repository);
      if (generation !== donorGeneration) throw new MigrationError(accessMode === 'public' ? 'public-stale' : 'private-stale');
      if (repositoryInfo && repositoryInfo.id !== repository.id) githubForm.ref = '';
      repositoryInfo = repository;
      if (githubForm.refType === 'branch') await loadBranches();
      else message = sourceReady() ? 'Repository found. Prepare the offline source to continue.'
        : 'Repository found. Enter an explicit tag or full commit SHA before reading.';
    }), { key: 'find-repository' });
    return h('div', { class: 'catalog-form migration-source-setup' },
    field('migration-github-access', 'GitHub access', access),
    credentialFields,
    accessMode === 'public' ? h('p', { class: 'hint' },
      'Anonymous reads use no saved credentials. For a private source, select a saved connection or personal access token above.') : null,
    h('section', { class: 'migration-source-stage', 'aria-labelledby': 'migration-source-repository-title' },
      h('h4', { id: 'migration-source-repository-title' }, '1. Find the old repository'),
      repositoryField('repository', 'Source repository URL or owner/repo', 'https://github.com/owner/repo…',
        'Use the repository root. Choose the branch or tag in the next step.'),
      h('div', { class: 'catalog-form-actions' }, findRepository,
        repositoryInfo ? h('span', { class: 'chip chip-ok' }, 'Repository found') : null),
      repositoryInfo ? h('p', { class: 'hint' },
        `${safeLabel(repositoryInfo.fullName)} · default branch: ${safeLabel(repositoryInfo.defaultBranch || 'not reported')} (not selected automatically)`) : null),
    h('section', { class: 'migration-source-stage', 'aria-labelledby': 'migration-source-prepare-title' },
    h('h4', { id: 'migration-source-prepare-title' }, '2. Prepare the offline source'),
    h('div', { class: 'migration-source-revision' },
      field('migration-github-ref-type', 'Ref type', type),
      refField),
    branchFailure && githubForm.refType === 'branch'
      ? h('p', { class: 'field-error', role: 'alert' }, branchFailure) : null,
    branchesTruncated && githubForm.refType === 'branch'
      ? h('p', { class: 'migration-warning' }, 'Branch listing reached the 500-branch limit. Select a listed branch or use an explicit tag or full commit SHA.') : null,
    branchState === 'loaded' && !branches.length && githubForm.refType === 'branch'
      ? h('p', { class: 'hint' }, 'This repository has no branches to select. Refresh branches or choose another repository.') : null,
    h('div', { class: 'catalog-form-actions' },
      prepare,
      repositoryInfo && githubForm.refType === 'branch'
        ? action(branchState === 'error' ? 'Retry branches' : 'Refresh branches',
          () => run('Loading repository branches…', loadBranches), { key: 'load-branches' }) : null),
    preparationHint),
    disclosure('Snapshot and access details', [
      h('p', { class: 'hint' }, 'A branch or tag is pinned during capture. The complete configuration copy is retained privately and used offline; only explicit Refresh reacquires the old source. A full commit SHA selects historical content. Invalid input never falls back to the default branch.'),
      h('p', { class: 'hint' }, 'Only supported parameter files and referenced templates are read. No source writes or scripts are permitted. Access and rate-limit errors stop the operation; access modes never switch automatically.'),
      accessMode === 'public' ? h('p', { class: 'hint' }, 'Anonymous GitHub quotas apply to the app server’s IP.') : null,
    ]),
    );
  }

  function changeAccess(mode) {
    if (mode === accessMode) return;
    tokenInput.value = '';
    return run('Changing source access…', async () => {
      if (connection) await connection.disconnect();
      donorGeneration += 1;
      forgetRepository();
      accessMode = mode;
      if (mode !== 'public') await sourceController();
      if (mode === 'saved') {
        const result = await connection.listConnections();
        profiles = result.profiles;
        if (!profiles.some((profile) => profile.id === profileId)) profileId = '';
      }
      message = '';
    });
  }

  function connectSource() {
    return run('Connecting the read-only GitHub source…', async () => {
      donorGeneration += 1;
      forgetRepository();
      try {
        const controller = await sourceController();
        const attempt = controller.connect(accessMode === 'saved' ? { profileId } : { token: tokenInput.value });
        tokenInput.value = '';
        await attempt;
        message = 'Source connected. Choose its repository and an explicit ref.';
      } finally {
        tokenInput.value = '';
      }
    });
  }

  function changeRepositoryField(key, value, cursor = null) {
    if (githubForm[key] === value) return;
    githubForm[key] = value;
    donorGeneration += 1;
    if (key === 'repository') forgetRepository();
    if (key === 'refType') {
      clearBranches();
      githubForm.ref = '';
    }
    message = donor ? 'Preparing a different source does not change the current copy or any target drafts.' : '';
    if (key !== 'ref' || githubForm.refType === 'branch') {
      render();
      const input = sourceControls.get(key);
      input?.focus({ preventScroll: true });
      if (cursor !== null) input?.setSelectionRange?.(cursor, cursor);
    } else {
      for (const key of ['read-github', 'prepare-source']) {
        const control = actionControls.get(key);
        if (control) control.disabled = busy || !sourceReady();
      }
      const hint = sourceControls.get('prepare-source-hint');
      if (hint) hint.textContent = sourcePreparationHint();
    }
    if (key === 'refType' && value === 'branch' && repositoryInfo) {
      return run('Loading repository branches…', loadBranches);
    }
  }

  async function loadBranches() {
    const repository = repositoryInfo;
    const generation = donorGeneration;
    const mode = accessMode;
    if (!repository || githubForm.refType !== 'branch') throw new MigrationError('public-input');
    branchState = 'loading';
    branchFailure = '';
    branches = [];
    branchesTruncated = false;
    message = 'Loading repository branches…';
    render();
    try {
      const result = mode === 'public'
        ? await listPublicDonorBranches(repository, publicRequest)
        : await connection.listBranches(repository);
      if (generation !== donorGeneration || repositoryInfo !== repository || accessMode !== mode || githubForm.refType !== 'branch') {
        throw new MigrationError(mode === 'public' ? 'public-stale' : 'private-stale');
      }
      branches = result.branches;
      branchesTruncated = result.truncated;
      branchState = 'loaded';
      if (!branches.some((branch) => branch.name === githubForm.ref)) githubForm.ref = '';
      message = sourceReady() ? 'Source branch selected. Prepare the offline source to continue.'
        : branches.length ? 'Repository found. Select a source branch before reading.' : '';
    } catch (error) {
      if (generation === donorGeneration && repositoryInfo === repository && githubForm.refType === 'branch') {
        branchState = 'error';
        branchFailure = migrationMessage(error);
        githubForm.ref = '';
      }
      throw error;
    }
  }

  function connectGitHub() {
    return run('Resolving the source ref and reading its pinned tree…', async () => {
      if (!sourceReady()) throw new MigrationError('public-input');
      const generation = donorGeneration;
      const selection = { ...githubForm, repositoryId: repositoryInfo?.id ?? null };
      const selected = accessMode === 'public'
        ? new PublicGitHubMigrationDonor({ ...selection, request: publicRequest })
        : connection.createDonor(selection);
      await selected.entries();
      if (generation !== donorGeneration) throw new MigrationError(accessMode === 'public' ? 'public-stale' : 'private-stale');
      await readSourceInventory(selected, generation, selected.provenance(), selected.exclusions());
    });
  }

  function renderTargetWorkspace() {
    const matching = expandedRows.get('target-preview:matching') === true;
    const revise = (work, key) => run('Updating the migration preview…', async () => {
      for (const change of session.targetProjection().changes) heldMappingRows.add(change.rowId);
      view = work();
      preview = null;
      step = 'map';
      message = '';
    }, { focusRow: key, scrollTop: body.parentElement?.scrollTop });
    return h('section', { class: 'migration-form-workspace' },
      matching ? disclosure('Source matching and import choices', renderMapping(), {
        open: true, className: 'migration-matching-panel',
        ontoggle: (event) => expandedRows.set('target-preview:matching', event.target.open),
      }) : null,
      renderMigrationTargetPreview({
        projection: session.targetProjection(), rows: view.rows, expanded: expandedRows, heldRows: heldMappingRows,
        register: (key, node) => decisionControls.set(key, node),
        onRender: (key) => render(key),
        onMatch: (rowId) => {
          expandedRows.set('target-preview:matching', true);
          reviewRow(rowId);
        },
        onImport: (row, candidate) => revise(() => session.decide(row.id,
          { kind: 'accept', candidateId: candidate.id, semanticReviewed: true }), `preview:${JSON.stringify([row.name.toLowerCase()])}`),
        onUndo: (change) => revise(() => change.kind === 'model'
          ? session.decideModel(change.rowId, {
            kind: 'keep', backendKey: change.backendKey, modelKey: change.modelKey, field: change.field,
          }) : session.decide(change.rowId, { kind: 'keep' }),
          `preview:${JSON.stringify([String(change.path[0]).toLowerCase(), ...change.path.slice(1)])}`),
      }));
  }

  function renderMapping() {
    const rows = view.rows.filter((row) => migrationRowVisible(row, { filter, scope: mappingScope }) ||
      heldMappingRows.has(row.id) && migrationRowVisible(row, { filter }));
    const stats = migrationSelectionSummary(view.rows);
    const unresolvedValues = view.rows.filter((row) => !row.removed &&
      (row.currentValueStatus === 'not-evaluated' || row.candidates.some((candidate) => candidate.valueStatus === 'not-evaluated'))).length;
    const search = h('input', {
      type: 'search', value: filter, disabled: busy, autocomplete: 'off', spellcheck: false,
      'aria-label': 'Filter parameter names', placeholder: 'Parameter name…',
      onchange: (event) => { filter = event.target.value; heldMappingRows.clear(); render('filter'); },
    });
    pairingControls.set('filter', search);
    const scope = h('select', {
      class: 'ctl', name: 'mapping-scope', disabled: busy, 'aria-label': 'Comparison view',
      onchange: (event) => { mappingScope = event.target.value; heldMappingRows.clear(); render('mapping-scope'); },
    }, h('option', { value: 'differences' }, 'Differences and unresolved matches'),
    h('option', { value: 'all' }, 'All new parameters'),
    h('option', { value: 'same' }, `Already identical (${stats.same})`),
    h('option', { value: 'target-only' }, `Target-only, kept (${stats.targetOnly})`),
    h('option', { value: 'unresolved' }, `Unavailable old values (${stats.unavailable})`),
    h('option', { value: 'selected' }, `Show selected parameters (${stats.selectedParameters})`),
    h('option', { value: 'attention' }, `Needs matching or readable values (${stats.attention})`));
    scope.value = mappingScope;
    pairingControls.set('mapping-scope', scope);
    const change = (work, focus) => {
      try {
        if (mappingScope !== 'all') for (const row of rows) heldMappingRows.add(row.id);
        view = work();
        preview = null;
        step = 'map';
        failed = false;
        message = '';
        render(focus);
      } catch (error) { failed = true; message = migrationMessage(error); render(focus); }
    };
    const options = {
      busy, candidates: candidateChoices, pairs: backendChoices, expanded: expandedRows,
      heldFields: heldMappingRows,
      showUnchanged: mappingScope === 'all' || mappingScope === 'same',
      register: (key, control) => decisionControls.set(key, control),
      onCandidate: (row, id) => {
        candidateChoices.set(row.id, id);
        change(() => session.decide(row.id, { kind: 'keep' }), `match:${row.id}`);
      },
      onImport: (row, candidate, checked) => change(() => session.decide(row.id, checked
        ? { kind: 'accept', candidateId: candidate.id, semanticReviewed: true } : { kind: 'keep' }), `import:${row.id}`),
      onPairDraft: (row, backend, id) => {
        backendChoices.set(`${row.id}:${backend.key}`, id);
        render(`pair:${row.id}:${backend.key}`);
      },
      onPair: (row, backend, id) => change(() => session.decideModel(row.id,
        { kind: 'pair', backendKey: backend.key, sourceKey: id, confirmed: true }), `pair:${row.id}:${backend.key}`),
      onClearPair: (row, backend) => {
        backendChoices.delete(`${row.id}:${backend.key}`);
        change(() => session.decideModel(row.id, { kind: 'clear-pair', backendKey: backend.key }), `pair:${row.id}:${backend.key}`);
      },
      onModelField: (row, backend, model, field, checked) => {
        heldMappingRows.add(`${row.id}:${model.key}:${field.key}`);
        change(() => session.decideModel(row.id, {
          kind: checked ? 'source' : 'keep', backendKey: backend.key, modelKey: model.key, field: field.key, reviewed: true,
        }), `${row.id}:${model.key}:${field.key}`);
      },
    };
    const renderValue = (row) => row.structured ? renderMigrationModels(row, options) : renderMigrationValue(row, options);
    const remaining = new Map(rows.map((row) => [row.id, row]));
    const sectionLinks = [];
    const sectionNodes = (view.sections || []).flatMap((section) => {
      const groups = section.groups.map((group) => ({
        label: group.label,
        rows: group.rowIds.flatMap((id) => {
          const row = remaining.get(id);
          if (!row) return [];
          remaining.delete(id);
          return [row];
        }),
      })).filter((group) => group.rows.length);
      if (!groups.length) return [];
      const key = `parameter-section:${section.id}`;
      const count = groups.reduce((total, group) => total + group.rows.length, 0);
      const node = disclosure([
        h('strong', {}, section.title),
        h('span', { class: 'hint' }, ` · ${quantity(count, 'parameter')}`),
      ], groups.map((group) => h('div', { class: 'migration-parameter-group' },
        group.label ? h('h4', {}, group.label) : null, group.rows.map(renderValue))), {
        className: 'migration-parameter-section',
        open: expandedRows.has(key) ? expandedRows.get(key) : true,
        ontoggle: (event) => expandedRows.set(key, event.target.open),
      });
      sectionLinks.push(action(section.label, () => {
        expandedRows.set(key, true);
        node.open = true;
        node.querySelector('summary')?.focus({ preventScroll: true });
        node.scrollIntoView?.({ block: 'start' });
      }, { key: `navigate-${key}`, className: 'btn-sm' }));
      return [node];
    });
    return h('section', { class: 'migration-mapping' },
      h('p', { class: 'hint' }, 'Compare the old source on the left with the current target on the right. Check only source values you want to import; unchecked target values stay unchanged.'),
      h('p', { class: 'hint' }, `${quantity(stats.same, 'identical parameter')} kept unchanged · ${quantity(stats.targetOnly, 'target-only parameter')} kept. Use All new parameters or Already identical to inspect them.`),
      unresolvedValues ? h('section', { class: 'migration-unresolved-summary' },
        h('p', { class: 'hint' }, `${quantity(stats.unavailable, 'old value')} unavailable; expressions are not runtime values and cannot be compared or imported.`),
        h('div', { class: 'catalog-form-actions' },
          action('Inspect unavailable values', () => { mappingScope = 'unresolved'; heldMappingRows.clear(); render('mapping-scope'); },
            { key: 'inspect-unresolved' }),
          action('Supply resolved parameter files', changeSource, { key: 'resolved-source' })),
        disclosure(`${quantity(unresolvedValues, 'parameter')}: values not resolved`, [
        h('p', {}, 'Some settings contain expressions or references rather than stored literal values. Migration does not evaluate functions, variables or environment-specific inputs, so it cannot compare their actual values.'),
        h('p', {}, 'Supply a literal .bicepparam or strict ARM deployment-parameters JSON file containing resolved old values. Preparing a replacement does not discard drafts until you confirm. Unselected target expressions are preserved; no .env, scripts or fallback values are evaluated.'),
      ], { open: false })) : null,
      h('div', { class: 'migration-values' }, field('migration-filter', 'Find a new parameter', search),
        field('migration-view', 'Show', scope, mappingScope === 'all' ? null
          : 'Edited rows stay visible. Refresh the view to apply this filter again.')),
      h('div', { class: 'catalog-form-actions' },
        action('Keep remaining values in this target', () => change(() => session.keepRemaining(), null), { key: 'keep-remaining' }),
        action('Discard choices for this target', () => change(() => session.discardChanges(), null),
          { key: 'discard-changes', disabled: !stats.selected }),
        action('Refresh view', () => { heldMappingRows.clear(); render('mapping-scope'); },
          { key: 'refresh-mapping-filter', disabled: !heldMappingRows.size })),
      !rows.length ? h('p', { class: 'empty' }, mappingScope === 'differences' && !filter
        ? `No importable differences in the readable old values. Matching values are already current.${stats.unavailable ? ` ${stats.unavailable} unavailable old values remain; inspect them or supply resolved parameter files above.` : ' Nothing needs importing in this target.'}`
        : 'No parameter names match this view. Choose All new parameters or clear the search to see more.') : null,
      sectionLinks.length > 1 ? h('nav', { class: 'migration-section-nav', 'aria-label': 'Target parameter sections' }, sectionLinks) : null,
      sectionNodes,
      [...remaining.values()].map(renderValue),
      disclosure('Not imported and matching details', [
        renderNameReports(view.pairs),
        h('p', { class: 'hint' }, 'Only actual assignments in the new file are targets. Old-only and template-only names are not added. Sensitive, unresolved and incompatible old values are never guessed.'),
      ]),
    );
  }

  function reviewRow(rowId, controlKey = null) {
    step = 'map';
    filter = '';
    mappingScope = 'all';
    heldMappingRows.clear();
    if (surface) expandedRows.set('target-preview:matching', true);
    if (rowId) {
      expandedRows.set(rowId, true);
      for (const section of view.sections || []) {
        if (section.groups.some((group) => group.rowIds.includes(rowId))) {
          expandedRows.set(`parameter-section:${section.id}`, true);
        }
      }
    }
    render(controlKey || rowId);
    if (rowId) (decisionControls.get(controlKey) || decisionControls.get(rowId))?.scrollIntoView?.({ block: 'center' });
  }

  function renderReview() {
    const report = preview.report;
    const summary = report.summary;
    const changed = report.rows.filter((row) => row.status === 'copy');
    const modelTotals = report.rows.reduce((total, row) => ({
      models: total.models + (row.structured?.summary?.models || 0),
      changed: total.changed + (row.structured?.summary?.changedModels || 0),
    }), { models: 0, changed: 0 });
    const changes = changed.flatMap((row) => row.structured
      ? row.structured.changes.map((change) => h('article', { class: 'migration-change-row' },
          h('strong', {}, `${change.backendId} / ${change.model} / ${change.label}`),
          h('div', { class: 'migration-values' },
            h('p', {}, 'Target before: ', h('code', {}, change.before)),
            h('p', {}, 'Target after import: ', h('code', {}, change.after))),
          h('small', { class: 'hint' }, `Source (old): ${change.source.backendId} / ${change.source.model} · ${change.source.file}`),
          action('Revise model choice', () => {
            expandedRows.set(`${row.id}:${change.backendKey}`, true);
            expandedRows.set(`${row.id}:${change.modelKey}`, true);
            reviewRow(row.id, `${row.id}:${change.modelKey}:${change.field}`);
          }, { key: `revise-${row.id}-${change.modelKey}-${change.field}` })))
      : [h('article', { class: 'migration-change-row' },
          h('strong', {}, row.name),
          h('div', { class: 'migration-values' },
            h('p', {}, 'Target before: ', h('code', {}, row.current.length > 120 ? `${row.current.slice(0, 117)}…` : row.current)),
            h('p', {}, 'Target after import: ', h('code', {}, row.final.length > 120 ? `${row.final.slice(0, 117)}…` : row.final))),
          h('small', { class: 'hint' }, 'Source (old): ',
            row.candidates.find((candidate) => candidate.id === row.decision.candidateId)?.source.file || 'Selected source'),
          action('Revise value', () => reviewRow(row.id), { key: `revise-${row.id}` }))]);
    return h('section', { class: 'migration-review' },
      h('p', { class: 'migration-summary' }, preview.changed ? `${quantity(summary.changeCount, 'change')} to import` : 'Nothing will change'),
      h('p', { class: 'hint' }, `${summary.retained} new parameters kept · ${summary.alreadyCurrentValues} selected values already same. Nothing has been copied.`),
      modelTotals.models ? h('p', { class: 'hint' },
        `${quantity(modelTotals.models - modelTotals.changed, 'new model')} unchanged. Only selected fields change within ${quantity(modelTotals.changed, 'model')}; new backend settings stay unchanged.`) : null,
      session.destination.remote ? h('p', { class: 'hint' }, 'Preview/export only. Download a manual draft or report; the remote repository will not be changed.') : null,
      !preview.changed ? h('p', {}, 'No value changes are selected. Keep the new environment as it is, revise your choices, or download the report.') : null,
      surface ? null : changes,
      report.blockers.length ? h('section', { class: 'migration-warning' },
        h('h4', {}, session.destination.remote ? 'Configuration checks' : 'Checks to resolve before local apply'),
        h('ul', {}, report.blockers.map((blocker, index) => h('li', {},
          blocker.name ? `${blocker.name}: ` : '', blocker.message,
          blocker.scope === 'retained-destination' ? ' This was retained from the new environment.' : '',
          blocker.rowId ? action(blocker.scope === 'selected-dependency' ? 'Revise dependent choice' : 'Review this value',
            () => reviewRow(blocker.rowId), { key: `blocker-${index}` }) : null)))) : null,
      report.unverified?.length ? disclosure(`${quantity(report.unverified.length, 'retained finding')} not certified for deployment`, [
        h('p', { class: 'hint' }, 'These pre-existing values or expressions are kept. They are not proof of deployment readiness, but do not block an unrelated safe patch. Selected changes and their required dependencies are checked separately.'),
        h('ul', {}, report.unverified.map((finding) => h('li', {}, finding.name ? `${finding.name}: ` : '', finding.message))),
      ]) : null,
      preview.changed ? disclosure('Selected-value diff', renderDiff(preview.before, preview.after).node) : null,
      disclosure('Not imported, retained values and technical details', [
        renderNameReports(report.pairs),
        h('ul', {}, report.rows.filter((row) => row.status !== 'copy').map((row) =>
          h('li', {}, `${row.name}: ${STATUS[row.status]}${row.structured ? ' · backend/model decisions retained' : ''}`))),
        h('pre', { class: 'migration-value' }, JSON.stringify(report.binding, null, 2)),
      ]),
      h('div', { class: 'catalog-form-actions' },
        action('Download report', () => exportFile('report'), { key: 'export-report' }),
        action('Download sanitized draft', () => exportFile('draft'), { key: 'export-draft' }),
        action('Review another file', chooseAnotherTarget, { key: 'another-target' })),
      h('p', { class: 'hint' }, 'The sanitized draft is a manual handoff, not deployment-ready certification: it omits comments and withheld values/references. Local apply instead preserves unselected destination content.'),
    );
  }

  function renderNameReports(pairs) {
    const names = (label, entries) => h('p', {},
      h('strong', {}, `${label}: `),
      entries === null ? 'Unknown - no usable donor schema was supplied.'
        : entries.length ? entries.map((name, index) => [index ? ', ' : '', h('code', {}, name)]) : 'None');
    return h('section', { class: 'migration-name-report', 'aria-label': 'Per-file parameter name report' },
      h('h4', {}, 'Parameter names by file pair'),
      pairs.map((pair) => h('section', { class: 'migration-name-pair' },
        h('dl', { class: 'catalog-summary' },
          summaryRow('Area', pair.area),
          summaryRow('Source file', h('code', {}, pair.source.file)),
          summaryRow('Current file', h('code', {}, pair.target.file))),
        names('Old-only parameters absent from this current target', pair.oldOnlyNames),
        disclosure(`Name comparison and provenance (${pair.matchedNames.length} current-name matches)`, [
          h('p', { class: 'hint' }, 'Name matches are not approved copies. Old-only names are reported, never copied. No donor assignment does not prove a new schema field; fields omitted from both files keep inherited defaults.'),
          h('p', { class: 'hint' }, 'Source: ', pair.source.label,
            pair.source.revision?.repository ? [
              pair.source.revision.refType === 'commit' ? '' : ` · ${pair.source.revision.refType}: ${pair.source.revision.ref}`,
              ` · pinned commit ${pair.source.revision.commit}`,
            ] : pair.source.revision?.snapshotId ? ' · prepared local source copy' : ' · read-only local files'),
          h('p', { class: 'hint' }, 'Target: ', `${pair.target.project} / ${pair.target.workspace} · `,
            pair.target.remote ? `${pair.target.location} · branch ${pair.target.branch}` : `${pair.target.folder} · ${pair.target.localBranchNote}`),
          names('Current-name matches (not approved copies)', pair.matchedNames),
          names('Current assignments without a paired donor assignment', pair.currentAssignmentsWithoutDonor),
          names('Inherited defaults omitted from both parameter files', pair.inheritedDefaultsWithoutDonor),
          names('Donor-supplied current schema fields omitted from the target file (explicit review required)', pair.donorSuppliedSchemaFieldsNotAssigned),
          names('Current schema names absent from the paired donor schema', pair.currentSchemaOnlyNames),
          names('Duplicate donor identifiers', pair.duplicateDonorNames),
          names('Ambiguous current declarations', pair.ambiguousCurrentNames),
        ]),
      )),
    );
  }

  function renderReportHistory() {
    if (!reportHistory.length) return null;
    return disclosure(`Reviewed per-file name reports (${reportHistory.length})`, [
      h('p', { class: 'hint' }, 'Historical snapshots only. These contain names, provenance, and statuses, not parameter values. They remain available until this wizard closes and do not authorize another write.'),
      action('Download all per-file name reports', () => run('Preparing historical name reports…', async () => {
        await download({
          name: 'citadel-migration-name-reports.json', type: 'application/json',
          text: JSON.stringify({ format: 'citadel-migration-name-report-history', version: 1, reports: reportHistory }, null, 2),
        });
        message = 'Historical name reports downloaded. No files were read or written by this download.';
      }), { key: 'export-history' }),
      reportHistory.map((report) => disclosure(`${report.pairs[0]?.area || 'Parameter file'} · ${report.destination.target} · ${report.status}`, [
        h('p', {}, `${report.summary.accepted} accepted · ${report.summary.unchanged} already current · ${report.summary.proposedEdits} proposed edits · ${report.summary.copied} copied to destination`),
        renderNameReports(report.pairs),
      ])),
    ], { className: 'migration-report-history' });
  }

  function run(label, work, { focusRow = null, scrollTop = null } = {}) {
    if (busy) return pending;
    busy = true;
    returnActionFocus = busyAction;
    failed = false;
    message = label;
    pending = (async () => {
      try {
        render();
        await work();
      }
      catch (error) {
        if (error?.name === 'AbortError') message = 'Selection cancelled. Nothing was written.';
        else {
          message = migrationMessage(error);
          if (error instanceof MigrationError && error.acquisitionIssues?.length) {
            message += ` ${error.acquisitionIssues.slice(0, 3).map((issue) => `${safeLabel(issue.file)}: ${safeLabel(issue.reason)}`).join(' ')}`;
          }
          if (error instanceof MigrationError && ['pending', 'review', 'target-stale', 'target-unavailable', 'snapshot-corrupt', 'snapshot-unavailable'].includes(error.code)) {
            preview = null;
            if (view && step === 'review') step = 'map';
          }
          failed = true;
        }
      } finally {
        busy = false;
        busyAction = null;
        render(focusRow);
        if (Number.isFinite(scrollTop) && body.parentElement) body.parentElement.scrollTop = scrollTop;
      }
    })();
    return pending;
  }

  function pick(kind) {
    return run('Choosing a read-only donor…', async () => {
      const generation = donorGeneration;
      const selection = kind === 'folder' ? await chooseDirectory() : await chooseFiles();
      const selected = new MigrationDonor(kind === 'folder' ? { folder: selection } : { files: selection });
      await selected.entries({ request: true });
      if (generation !== donorGeneration) throw new MigrationError('stale');
      await readSourceInventory(selected, generation);
    });
  }

  async function readSourceInventory(selected, generation) {
    message = 'Preparing old-source configuration for all three areas…';
    render();
    const prepared = selected.snapshot ? selected : await sourceSession.prepareSource(selected, {
      onProgress: ({ completed, total, phase }) => {
        if (generation !== donorGeneration) throw new MigrationError('stale');
        message = `${phase === 'storing' ? 'Storing private copy' : phase === 'verifying' ? 'Verifying complete copy' : 'Reading source configuration'}: ${completed} of ${total} files…`;
        render();
      },
    });
    preparedSources = await sourceSession.preparedSources();
    const inventory = await sourceSession.inventory(prepared);
    let currentTargets;
    try { currentTargets = await sourceSession.targets(); }
    catch (error) {
      if (error instanceof MigrationError && ['pending', 'closed'].includes(error.code)) throw error;
      throw new MigrationError('target-unavailable');
    }
    if (generation !== donorGeneration) throw new MigrationError('stale');
    if (donor && donor.id !== prepared.id && hasProposedChanges() && !await confirm({
      title: 'Replace the old source for all drafts?',
      message: 'The new offline copy is complete. Using it replaces pending choices in every area and target. Completed imports are unchanged. Keep the current source to retain all drafts.',
      confirmLabel: 'Use new source and clear drafts', cancelLabel: 'Keep current source and drafts',
    })) {
      returnToSource();
      return;
    }
    resetDonor();
    sourceReturn = null;
    donor = prepared;
    donorEntries = inventory.items;
    unassignedEntries = inventory.unassigned;
    otherEntries = inventory.otherFiles;
    additionalSources.clear();
    otherSourceId = '';
    donorRevision = prepared.provenance();
    donorExclusions = [...prepared.exclusions(), ...inventory.issues];
    targets = currentTargets;
    area = '';
    targetAlias = '';
    selectedIds = new Set();
    step = 'pair';
    const firstArea = MIGRATION_AREAS.find((item) => inventory.items.some((entry) => entry.area === item.id)) || MIGRATION_AREAS[0];
    selectArea(firstArea.id, { initial: true });
    message = inventory.issues.length
      ? `${inventory.issues.length} source file(s) need attention. See source reading issues below; no unsupported values were imported.`
      : '';
  }

  function exportFile(kind) {
    return run('Checking current target and prepared-copy integrity before download…', async () => {
      await download(await session.export(preview.id, kind));
      message = `Downloaded the sanitized ${kind}. No repository was written.`;
    });
  }

  const closeSession = () => {
    tokenInput.value = '';
    closed = true;
    for (const saved of areaReviews.values()) saved.session.close();
    areaReviews.clear();
    for (const saved of targetReviews.values()) {
      saved.session.close();
      saved.pairingOriginal?.session.close();
    }
    targetReviews.clear();
    session.close();
    sourceSession.close();
    donor = null;
    view = null;
    preview = null;
  };
  if (surface) {
    const nodes = [surface.workspace, surface.areas, surface.actions, surface.rail].filter(Boolean);
    const previous = nodes.map((node) => ({ node, children: [...(node.childNodes || node.children)] }));
    const mode = surface.shell.dataset.workspace;
    const rail = surface.shell.dataset.rail;
    const path = surface.breadcrumb?.textContent;
    const unload = (event) => {
      if (busy || hasProposedChanges()) { event.preventDefault(); event.returnValue = ''; }
    };
    const shortcut = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopImmediatePropagation();
        message = 'Use Review migration, then explicitly apply or export the selected values.';
        render();
      }
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('keydown', shortcut, true);
    surface.shell.dataset.workspace = 'migration';
    surface.shell.dataset.rail = 'off';
    surface.shell.classList.add('migration-mode');
    if (surface.rail) mount(surface.rail);
    mount(surface.workspace, body);
    mount(surface.actions, footer);
    dismiss = () => {
      closeSession();
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('keydown', shortcut, true);
      for (const { node, children } of previous) mount(node, children);
      surface.shell.dataset.workspace = mode;
      surface.shell.dataset.rail = rail;
      surface.shell.classList.remove('migration-mode');
      if (surface.breadcrumb) surface.breadcrumb.textContent = path;
      onExit();
    };
  } else show('Migrate Citadel Configuration', body, [footer], {
    preventDismiss: () => {
      if (allowDismiss) return false;
      if (busy) return true;
      if (connection || hasProposedChanges()) { requestClose(); return true; }
      return false;
    },
    onDismiss: closeSession,
  });
  render();
  await run('Loading prepared sources…', async () => { preparedSources = await sourceSession.preparedSources(); });
  return {
    get busy() { return busy; },
    get step() { return step; },
    get area() { return area; },
    get session() { return session; },
    whenIdle: () => pending,
    body,
    footer,
  };
}
