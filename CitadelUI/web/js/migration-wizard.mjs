import { h, mount } from './dom.mjs';
import { showDialog, dismissDialog, confirmDialog } from './dialog.mjs';
import { renderDiff } from './diff.mjs';
import { MigrationDonor } from './migration-donor.mjs';
import { inspectPublicDonorRepository, PublicGitHubMigrationDonor } from './migration-public-donor.mjs';
import { MIGRATION_AREAS } from './migration-session.mjs';
import { MigrationError, migrationMessage, safeLabel } from '../../shared/migration-input.mjs';
import { MIGRATION_CATEGORIES } from '../../shared/parameter-migration.mjs';

const STATUS = Object.freeze({
  copy: 'Accepted replacement',
  'accepted-unchanged': 'Accepted value already current — no edit',
  keep: 'Destination deliberately retained',
  'unreviewed-retain': 'Unreviewed — destination retained',
  'retain-current': 'Current value / inherited default retained',
  'not-copied': 'Not copied',
});
const ORIGIN = Object.freeze({
  'destination-file': 'current file',
  'template-default': 'current template default',
  'not-supplied': 'not supplied',
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

function provenance(candidate) {
  return `${candidate.source.file} · declaration ${candidate.source.occurrence} · ${candidate.source.format}`;
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
}) {
  const body = h('div', { class: 'catalog-dialog migration-body' });
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
  let donorRevision = null;
  let donorExclusions = [];
  let donorGeneration = 0;
  let repositoryInfo = null;
  const githubForm = { repository: '', refType: 'branch', ref: '' };
  const sourceControls = new Map();
  let selectedIds = new Set();
  let area = '';
  let targetAlias = '';
  let view = null;
  let preview = null;
  let result = null;
  let filter = '';
  const reportHistory = [];
  const decisionControls = new Map();
  const pairingControls = new Map();
  const expandedRows = new Map();
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
  }

  function resetDonor() {
    resetPlan();
    donorGeneration += 1;
    donor = null;
    donorRevision = null;
    donorEntries = [];
    donorExclusions = [];
    selectedIds = new Set();
  }

  function changeSource() {
    sourceKind = donorRevision ? 'github' : '';
    resetDonor();
    step = 'donor';
    message = 'Changing the source discards the current pairing and decisions. Earlier name reports are kept.';
    render();
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
    tokenInput.value = '';
    if (!connection) {
      allowDismiss = true;
      dismiss();
      return;
    }
    return run('Erasing the source connection…', async () => {
      await connection.disconnect();
      allowDismiss = true;
      dismiss();
    });
  }

  function leaveGitHub() {
    tokenInput.value = '';
    return run('Closing the GitHub source…', async () => {
      if (connection) await connection.disconnect();
      resetDonor();
      repositoryInfo = null;
      sourceKind = '';
      message = '';
    });
  }

  function chooseAnotherTarget() {
    resetPlan();
    selectedIds = new Set();
    targetAlias = '';
    step = 'pair';
    message = 'Choose another existing current file and pair its donor explicitly. Earlier name reports remain available below.';
    render();
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

  function render(focusRow = null) {
    if (closed) return;
    const screen = `${step}:${sourceKind}:${accessMode}:${Boolean(connection?.connected)}`;
    const focusedAction = document.activeElement?.dataset?.action;
    actionControls.clear();
    decisionControls.clear();
    pairingControls.clear();
    const selectedTarget = view?.target || targets.find((target) => target.alias === targetAlias);
    const heading = h('h3', { tabindex: -1 }, {
      donor: sourceKind === 'github' ? 'GitHub source' : 'Choose a source',
      pair: 'Pair parameter files',
      map: 'Review parameter values',
      review: 'Review local changes',
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
      : step === 'map' ? renderMapping()
        : step === 'review' ? renderReview()
          : h('section', { class: 'migration-result' },
            h('p', {}, `${result.copied} reviewed parameter replacement${result.copied === 1 ? '' : 's'} applied to the displayed local destination.`),
            h('p', {}, 'Transaction receipt: ', h('code', {}, safeLabel(result.transactionId))),
            h('p', {}, 'The donor was not written. Previous destination bytes are backed up through the normal transaction history; use Settings > History for undo/recovery.'),
            h('p', { class: 'hint' }, 'No deployment ran. Review remaining semantic/reference items separately before using this configuration.'),
          );
    const steps = ['donor', 'pair', 'map', 'review'];
    const position = step === 'done' ? steps.length : steps.indexOf(step);
    mount(body,
      h('ol', { class: 'catalog-steps', 'aria-label': 'Migration progress' },
        ['Source', 'Files', 'Mapping', 'Review'].map((label, index) =>
          h('li', {
            class: `catalog-step${index === position ? ' catalog-step-current' : index < position ? ' catalog-step-done' : ''}`,
            'aria-current': index === position ? 'step' : null,
          }, label))),
      contextNode(session.destination, selectedTarget),
      donor ? h('section', { class: 'migration-context', 'aria-label': 'Read-only donor' },
        h('dl', { class: 'catalog-summary' },
          summaryRow('Read-only source', h('code', {}, safeLabel(donorRevision?.repository || donor.label))),
          donorRevision ? summaryRow(donorRevision.refType === 'commit' ? 'Commit' : donorRevision.refType === 'tag' ? 'Tag' : 'Branch',
            h('code', {}, donorRevision.refType === 'commit' ? donorRevision.commit : safeLabel(donorRevision.ref))) : null),
        donorRevision ? h('details', {},
          h('summary', { class: 'hint' }, 'Source revision details'),
          h('div', { class: 'migration-detail-body hint' },
            h('p', {}, donor.kind === 'authenticated-github'
              ? 'GitHub donor — authenticated, read-only'
              : 'Public GitHub donor — anonymous, read-only'),
            h('p', {}, `Repository ID: ${donorRevision.repositoryId} · ${donorRevision.refType}: ${donorRevision.refType === 'commit' ? donorRevision.commit : safeLabel(donorRevision.ref)}`),
            h('p', {}, 'Pinned commit: ', h('code', {}, donorRevision.commit)),
            h('p', {}, 'Pinned tree: ', h('code', {}, donorRevision.treeSha)))) : null,
      ) : null,
      h('p', { class: session.destination.remote ? 'migration-warning' : 'hint' },
        session.destination.remote
          ? 'Preview / local export only. Applying migration to a remote repository is disabled, regardless of its normal write permissions.'
          : 'The source stays read-only. Only reviewed changes can be applied to this local destination.'),
      heading, notice, content, renderReportHistory(),
    );
    const actions = [
      action(step === 'done' ? 'Close' : 'Cancel', requestClose, { key: 'close' }),
    ];
    if (step === 'donor' && sourceKind === 'github') {
      actions.push(
        action('Back', leaveGitHub, { key: 'source-options' }),
        accessMode !== 'public' && !connection?.connected
          ? action(accessMode === 'saved' ? 'Use source connection' : 'Connect source', connectSource,
            { primary: true, disabled: accessMode === 'saved' && !profileId, key: 'connect-source' })
          : action('Read GitHub source', connectGitHub, { primary: true, key: 'read-github' }),
      );
    } else if (step === 'pair') {
      actions.push(action('Change source', changeSource, { key: 'change-source' }));
      actions.push(action('Inspect mapping', () => run('Reading selected files and current schema…', async () => {
        view = await session.plan({ donor, sourceIds: [...selectedIds], targetAlias });
        preview = null;
        step = 'map';
        message = 'Nothing has been copied. Review each value before accepting it, or keep the destination.';
      }), { primary: true, disabled: !donor || !selectedIds.size || !targetAlias, key: 'map' }));
    } else if (step === 'map') {
      actions.push(
        action('Change file pairing', () => { resetPlan(); step = 'pair'; message = 'Changing the pair discards all migration decisions.'; render(); }, { key: 'pair' }),
        action('Preview draft & report', () => run('Rechecking donor, target, schema, and workspace…', async () => {
          preview = await session.preview();
          rememberReport();
          step = 'review';
          message = 'This is a sanitized value diff, not deployment certification. Original destination comments and untouched expressions are preserved by local apply.';
        }), { primary: true, key: 'preview' }),
      );
    } else if (step === 'review') {
      actions.push(
        action('Back to mapping', () => { step = 'map'; render(); }, { key: 'back' }),
      );
      if (!session.destination.remote) {
        actions.push(action('Review & apply locally', () => run('Awaiting explicit local-apply confirmation…', async () => {
          const agreed = await confirm({
            title: 'Apply reviewed migration locally?',
            message: `Apply ${preview.report.summary.proposedEdits} accepted replacements to this ONE local file? Confirm that you reviewed the mapping, semantic changes, retained defaults, and unresolved report items. A verified destination backup is required before writing. This is not a deployment.`,
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
      }
    } else if (step === 'done') {
      actions.push(action('Review another file', chooseAnotherTarget, { key: 'another-target' }));
    }
    mount(footer, actions);
    if (focusRow) (decisionControls.get(focusRow) || pairingControls.get(focusRow) || sourceControls.get(focusRow))?.focus();
    else if (renderedScreen !== screen) requestAnimationFrame(() => {
      heading.focus({ preventScroll: true });
      if (body.parentElement) body.parentElement.scrollTop = 0;
    });
    else if (!busy) actionControls.get(returnActionFocus || focusedAction)?.focus({ preventScroll: true });
    if (!busy) returnActionFocus = null;
    renderedScreen = screen;
  }

  function renderSourceChoice() {
    if (sourceKind === 'github') return renderGitHubSetup();
    const choice = (label, hint, handler, key, disabled = false) =>
      action([h('strong', {}, label), h('span', { class: 'hint' }, hint)], handler,
        { key, disabled, className: 'catalog-choice-option' });
    return h('div', { class: 'catalog-form' },
      h('p', { class: 'hint' }, 'Choose the older configuration to read. It will not be attached as an editable workspace.'),
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
        h('p', { class: 'hint' }, 'Folders expose only .bicepparam and referenced .bicep templates within the normal safe scope. Explicit files also support strict ARM deploymentParameters JSON. Select optional .bicep files for donor @secure metadata.'),
        h('p', { class: 'hint' }, 'Local folders use currently checked-out files, not another Git branch. No host path is sent to the server. Scripts are not accepted or executed.'),
      ]),
    );
  }

  function renderPairing() {
    const areaSelect = h('select', {
      disabled: busy, 'aria-label': 'Migration area',
      onchange: (event) => {
        area = event.target.value;
        targetAlias = '';
        selectedIds = new Set();
        resetPlan();
        message = 'Choose the correct existing current file in this area; no target or contract is inferred.';
        render('migration-area');
      },
    }, h('option', { value: '' }, 'All migration areas'),
    MIGRATION_AREAS.map((entry) => h('option', { value: entry.id }, entry.label)));
    areaSelect.value = area;
    pairingControls.set('migration-area', areaSelect);
    const areaTargets = targets.filter((target) => !area || target.area === area);
    const select = h('select', {
      value: targetAlias, disabled: busy, 'aria-label': 'Destination parameter file',
      onchange: (event) => {
        targetAlias = event.target.value;
        selectedIds = new Set();
        resetPlan();
        message = 'The destination is explicit; filenames help you pair inputs, not infer versions.';
        render('migration-target');
      },
    }, h('option', { value: '' }, 'Choose ONE current destination file…'),
    areaTargets.map((target) => h('option', { value: target.alias },
      `${target.kind}: ${target.label}${target.state !== 'available' ? ' — unresolved template/syntax' : ''}`)));
    // Assign after options exist; browsers otherwise reset a select's value.
    select.value = targetAlias;
    pairingControls.set('migration-target', select);
    const leaf = targetAlias.split('/').at(-1);
    const parameters = donorEntries.filter((entry) => entry.format !== 'bicep').sort((left, right) =>
      Number(right.alias.split('/').at(-1) === leaf) - Number(left.alias.split('/').at(-1) === leaf) ||
      left.alias.localeCompare(right.alias));
    return h('div', { class: 'migration-pairing' },
      h('p', { class: 'hint' }, 'Choose one current destination file, then explicitly select its older source file(s). No pairing is selected automatically.'),
      field('migration-area', 'Migration area', areaSelect),
      field('migration-target', 'Current destination file', select),
      !areaTargets.length && !busy ? h('p', { class: 'migration-warning' }, 'No existing destination .bicepparam files were found for this area. No legacy target or contract instance will be invented.') : null,
      donor ? h('fieldset', { class: 'migration-sources' },
        h('legend', {}, 'Source parameter files'),
        h('p', { class: 'hint' }, 'Same filenames appear first. Only checked files contribute candidates; names are never merged across other files. Select at most 16.'),
        parameters.length ? parameters.map((entry) => {
          const checkbox = h('input', {
            class: 'ctl-check', name: 'migration-source-file',
            type: 'checkbox', checked: selectedIds.has(entry.id), disabled: busy,
            dataset: { sourceId: entry.id },
            onchange: (event) => {
              if (event.target.checked) selectedIds.add(entry.id);
              else selectedIds.delete(entry.id);
              resetPlan();
              render(entry.id);
            },
          });
          pairingControls.set(entry.id, checkbox);
          return h('label', { class: 'migration-source' }, checkbox,
            h('span', {}, h('code', {}, safeLabel(entry.alias)), h('span', { class: 'hint' },
              ` · ${entry.format}`,
              donor.kind === 'local-files' ? ` · selection ${entry.id.replace('file-', '')}` : '',
              entry.alias.split('/').at(-1) === leaf ? ' · same filename' : '')));
        }) : h('p', {}, 'No supported parameter files were found. Choose another source folder or parameter file. Older sources do not need to pass current workspace compatibility.'),
      ) : null,
      donorExclusions.length ? disclosure(`${donorExclusions.length} source entries excluded by safety limits or scope`, [
        h('ul', {}, donorExclusions.slice(0, 50).map((entry) => h('li', {}, `${entry.file}: ${entry.reason}`))),
        donorExclusions.length > 50 ? h('p', { class: 'hint' }, 'Showing the first 50 exclusions.') : null,
      ]) : null,
      disclosure('Migration areas and file scope', [
        h('p', { class: 'hint' }, 'Deployment, both Upgrade files, LLM Onboarding, and Access Contracts are separate targets. For Access Contracts, choose the root template or the correct existing instance; base contracts, modules, and policies are not targets.'),
        h('p', { class: 'hint' }, 'Parameter migration never copies policy XML, executes scripts, or resolves file-loading expressions.'),
      ]),
    );
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
            resetDonor();
            repositoryInfo = null;
            await connection.disconnect();
            message = 'Source connection erased. Choose a connection or paste a new source token.';
          }), { key: 'disconnect-source' })));
    } else if (accessMode === 'saved') {
      const chooser = h('select', {
        disabled: busy, 'aria-label': 'Saved source connection',
        onchange: (event) => {
          profileId = event.target.value;
          resetDonor();
          repositoryInfo = null;
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
      return h('div', { class: 'catalog-form' },
        field('migration-github-access', 'GitHub access', access), credentialFields);
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
    return h('div', { class: 'catalog-form' },
    field('migration-github-access', 'GitHub access', access),
    credentialFields,
    accessMode === 'public' ? h('p', { class: 'hint' },
      'Anonymous reads use no saved credentials. For a private source, select a saved connection or personal access token above.') : null,
    repositoryField('repository', 'Source repository URL or owner/repo', 'https://github.com/owner/repo…',
      'Use the repository root. Enter the branch or tag separately, not a /tree/ URL.'),
    h('div', { class: 'migration-values' },
      field('migration-github-ref-type', 'Ref type', type),
      repositoryField('ref', 'Source branch, tag, or full commit SHA', 'Enter an explicit ref…')),
    repositoryInfo ? h('p', { class: 'hint' },
      `${safeLabel(repositoryInfo.fullName)} · default branch: ${safeLabel(repositoryInfo.defaultBranch || 'not reported')} (not selected automatically)`) : null,
    h('div', { class: 'catalog-form-actions' },
      action('Find repository', () => run('Checking source repository access…', async () => {
        const generation = donorGeneration;
        const repository = accessMode === 'public'
          ? await inspectPublicDonorRepository(githubForm.repository, publicRequest)
          : await connection.inspectRepository(githubForm.repository);
        if (generation !== donorGeneration) throw new MigrationError(accessMode === 'public' ? 'public-stale' : 'private-stale');
        repositoryInfo = repository;
        message = 'Repository found. Choose an explicit branch, tag, or full commit SHA before reading.';
      }), { key: 'find-repository' })),
    disclosure('Snapshot and access details', [
      h('p', { class: 'hint' }, 'A branch or tag is pinned to a commit and rechecked before review, export, and apply. A full commit SHA selects historical content. Invalid input never falls back to the default branch.'),
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
      resetDonor();
      repositoryInfo = null;
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
      resetDonor();
      repositoryInfo = null;
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
    if (key === 'repository') repositoryInfo = null;
    if (donorRevision) {
      resetDonor();
      step = 'donor';
      sourceKind = 'github';
      message = 'Source repository/ref changed. Read the GitHub source again; previous proposals were discarded.';
      render();
      const input = sourceControls.get(key);
      input?.focus();
      if (cursor !== null) input?.setSelectionRange?.(cursor, cursor);
    }
  }

  function connectGitHub() {
    return run('Resolving the source ref and reading its pinned tree…', async () => {
      resetDonor();
      const generation = donorGeneration;
      const selection = { ...githubForm, repositoryId: repositoryInfo?.id ?? null };
      const selected = accessMode === 'public'
        ? new PublicGitHubMigrationDonor({ ...selection, request: publicRequest })
        : connection.createDonor(selection);
      const entries = await selected.entries();
      if (generation !== donorGeneration) throw new MigrationError(accessMode === 'public' ? 'public-stale' : 'private-stale');
      donor = selected;
      donorEntries = entries;
      donorRevision = selected.provenance();
      donorExclusions = selected.exclusions();
      step = 'pair';
      message = 'Source snapshot pinned. Pair its parameter files with one current destination. Nothing has been copied.';
    });
  }

  function renderMapping() {
    const rows = view.rows.filter((row) => !filter || row.name.toLowerCase().includes(filter.toLowerCase()));
    const search = h('input', {
      type: 'search', value: filter, disabled: busy, autocomplete: 'off', spellcheck: false,
      'aria-label': 'Filter parameter names', placeholder: 'Parameter name…',
      onchange: (event) => { filter = event.target.value; render('filter'); },
    });
    pairingControls.set('filter', search);
    return h('section', { class: 'migration-mapping' },
      renderNameReports(view.pairs),
      field('migration-filter', 'Filter parameter names', search),
      h('p', { class: 'hint' }, 'Only exact current names match, using Bicep’s case-insensitive identifiers. Accepting a value confirms its semantic review. Unsupported, dynamic, sensitive, and type-unsafe values cannot be accepted.'),
      h('div', { class: 'catalog-form-actions' },
        action('Keep all remaining current values', () => {
          try {
            view = session.keepRemaining();
            failed = false;
            message = 'All remaining destination values/defaults were deliberately retained.';
            render();
          } catch (error) { failed = true; message = migrationMessage(error); render(); }
        }, { key: 'keep-remaining' })),
      !rows.length ? h('p', { class: 'empty' }, 'No parameter names match. Clear the filter to see all values.') : null,
      rows.map((row) => {
        const choices = row.removed ? null : h('select', {
          disabled: busy, 'aria-label': `Decision for ${row.name}`, dataset: { decision: row.id },
          onchange: (event) => {
            try {
              const value = event.target.value;
              view = session.decide(row.id, value.startsWith('accept:')
                ? { kind: 'accept', candidateId: value.slice(7), semanticReviewed: true }
                : { kind: value });
              preview = null;
              failed = false;
              message = 'Decision retained in memory only. Preview rechecks all file and schema fingerprints.';
              render(row.id);
            } catch (error) { failed = true; message = migrationMessage(error); render(row.id); }
          },
        },
        h('option', { value: 'pending' }, row.candidates.length ? 'Not reviewed — leave destination unchanged' : 'Retain current value / inherited template default'),
        h('option', { value: 'keep' }, 'Keep destination — deliberate decision'),
        row.candidates.map((candidate) => h('option', { value: `accept:${candidate.id}`, disabled: !candidate.eligible },
          candidate.eligible
            ? `Accept ${provenance(candidate)} — semantics reviewed`
            : `Cannot accept ${provenance(candidate)} — ${MIGRATION_CATEGORIES[candidate.category]}`)));
        if (choices) {
          choices.value = row.decision.kind === 'accept' ? `accept:${row.decision.candidateId}` : row.decision.kind;
          decisionControls.set(row.id, choices);
        }
        return disclosure([
          h('span', {}, h('code', {}, row.name), h('span', { class: 'hint' }, ` — ${STATUS[row.status]}`)),
          h('span', { class: 'migration-categories' }, row.categories.map((category) =>
            h('span', { class: 'chip' }, MIGRATION_CATEGORIES[category]))),
        ], [
          h('div', { class: 'migration-values' },
            h('section', {}, h('h4', {}, `Destination (${ORIGIN[row.currentOrigin] || 'not supplied'})`),
              h('pre', { class: 'migration-value' }, row.current)),
            row.candidates.length ? row.candidates.map((candidate) =>
              h('section', {},
                h('h4', {}, `Donor: ${provenance(candidate)}`),
                h('pre', { class: 'migration-value' }, candidate.value),
                h('p', { class: 'hint' }, candidate.donorSchema === 'not-available'
                  ? 'No donor schema available. Sensitive-name/nested-material screening is conservative, not a secret-discovery guarantee.'
                  : candidate.donorSchema === 'unsupported'
                    ? 'The supplied donor template could not be understood. Its unknown sensitivity prevents copying values.'
                    : 'Donor metadata inspected. The current template is the validation authority.'),
                candidate.problems.length ? h('ul', {}, candidate.problems.map((problem) => h('li', {}, problem))) : null,
              )) : h('p', {}, 'No selected donor supplies this field. Its current value or template default is retained.')),
          h('p', { class: 'hint' }, row.guidance.description),
          row.guidance.type ? h('p', { class: 'hint' },
            `Current type: ${row.guidance.type} · ${row.guidance.known ? 'supported structural checks' : 'UNKNOWN schema'} · ${row.guidance.required ? 'required' : 'has template default'}`,
            row.guidance.allowedValues ? ` · Allowed: ${JSON.stringify(row.guidance.allowedValues)}` : '',
            ['minLength', 'maxLength', 'minValue', 'maxValue'].filter((key) => row.guidance[key] !== undefined)
              .map((key) => ` · ${key}: ${row.guidance[key]}`).join('')) : null,
          h('p', { class: 'hint' }, row.guidance.validation),
          choices ? field(`migration-decision-${row.id}`, `Reviewed decision for ${row.name}`, choices)
            : h('p', {}, 'Reported only. A removed/unrecognized donor field does not block safe unrelated changes.'),
        ], {
          open: expandedRows.has(row.id) ? expandedRows.get(row.id) : row.candidates.some((candidate) => candidate.eligible),
          ontoggle: (event) => { expandedRows.set(row.id, event.target.open); },
        });
      }),
      disclosure('Matching and retained defaults', [
        h('p', { class: 'hint' }, 'Destination casing, using, comments, and current defaults are preserved. There are no fuzzy renames, coercions, or legacy semantic translations. Unknown source sensitivity cannot be inferred from a release number.'),
      ]),
    );
  }

  function renderReview() {
    const report = preview.report;
    const summary = report.summary;
    const { node } = renderDiff(preview.before, preview.after);
    return h('section', { class: 'migration-review' },
      h('p', { class: 'migration-summary' }, `${summary.proposedEdits} proposed edits · ${summary.copied} copied to destination`),
      h('p', { class: 'hint' }, `${report.classification.matched} name matches · ${summary.accepted} accepted (${summary.unchanged} already current) · ${summary.retained} retained · ${summary.removed} removed/unrecognized · ${summary.unresolved} unresolved · ${summary.unreviewed} unreviewed`),
      h('p', { class: 'migration-warning' }, 'Not deployment-ready certification. Sample-based parsing and mapping do not establish legacy semantic equivalence. Output handoffs, authentication/model changes, and resource dependencies require manual review.'),
      report.blockers.length ? h('section', { class: 'migration-warning' },
        h('h4', {}, 'Local apply is blocked'),
        h('ul', {}, report.blockers.map((blocker) => h('li', {}, blocker.name ? `${blocker.name}: ` : '', blocker.message)))) : null,
      !preview.changed ? h('p', {}, 'No byte changes are proposed. You can still export the sanitized report.') : null,
      h('h4', {}, 'Sanitized value diff'),
      node,
      renderNameReports(report.pairs),
      disclosure('Retained and unresolved report entries',
        h('ul', {}, report.rows.filter((row) => row.status !== 'copy').map((row) =>
          h('li', {}, `${row.name}: ${STATUS[row.status]} — ${row.categories.map((category) => MIGRATION_CATEGORIES[category]).join('; ')}`)))),
      disclosure('Bound source / target / schema fingerprints',
        h('pre', { class: 'migration-value' }, JSON.stringify(report.binding, null, 2))),
      h('div', { class: 'catalog-form-actions' },
        action('Download report', () => exportFile('report'), { key: 'export-report' }),
        action('Download sanitized draft', () => exportFile('draft'), { key: 'export-draft' }),
        action('Review another file', chooseAnotherTarget, { key: 'another-target' })),
      h('p', { class: 'hint' }, 'Exports recheck the selected files. The sanitized draft omits comments, sensitive values, and expressions/references: it is a manual handoff, not a deployment-ready file. Local apply preserves untouched destination content rather than writing this export.'),
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
            pair.source.revision ? [
              pair.source.revision.refType === 'commit' ? '' : ` · ${pair.source.revision.refType}: ${pair.source.revision.ref}`,
              ` · pinned commit ${pair.source.revision.commit}`,
            ] : ' · read-only local files'),
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

  function run(label, work) {
    if (busy) return pending;
    busy = true;
    returnActionFocus = busyAction;
    failed = false;
    message = label;
    render();
    pending = (async () => {
      try { await work(); }
      catch (error) {
        if (error?.name === 'AbortError') message = 'Selection cancelled. Nothing was written.';
        else {
          message = migrationMessage(error);
          const remoteError = error instanceof MigrationError && /^(?:public|private)-/.test(error.code);
          if (error instanceof MigrationError && (['stale', 'pending', 'review'].includes(error.code) || remoteError)) {
            resetPlan();
            step = donor ? 'pair' : 'donor';
            if (remoteError) {
              tokenInput.value = '';
              resetDonor();
              sourceKind = 'github';
              step = 'donor';
              if (error.code !== 'private-disconnect') {
                message += ' Correct the source access or ref, then read the GitHub source again.';
              }
            }
            failed = true;
          }
        }
      } finally {
        busy = false;
        busyAction = null;
        render();
      }
    })();
    return pending;
  }

  function pick(kind) {
    return run('Choosing a read-only donor…', async () => {
      resetPlan();
      const generation = ++donorGeneration;
      const selection = kind === 'folder' ? await chooseDirectory() : await chooseFiles();
      const selected = new MigrationDonor(kind === 'folder' ? { folder: selection } : { files: selection });
      const entries = await selected.entries({ request: true });
      if (generation !== donorGeneration) throw new MigrationError('stale');
      donor = selected;
      donorEntries = entries;
      donorRevision = null;
      donorExclusions = [];
      selectedIds = new Set();
      step = 'pair';
      message = 'Select the donor parameter file(s) and one actual current target. Donor contents have not been copied.';
    });
  }

  function exportFile(kind) {
    return run('Rechecking all inputs before local download…', async () => {
      await download(await session.export(preview.id, kind));
      message = `Downloaded the sanitized ${kind}. No repository was written.`;
    });
  }

  show('Migrate Citadel Configuration', body, [footer], {
    preventDismiss: () => {
      if (allowDismiss) return false;
      if (busy) return true;
      if (connection) { requestClose(); return true; }
      return false;
    },
    onDismiss: () => {
      tokenInput.value = '';
      closed = true;
      session.close();
      donor = null;
      view = null;
      preview = null;
    },
  });
  await run('Finding current Deployment, Upgrade, LLM Onboarding, and Access Contracts files…', async () => {
    targets = await session.targets();
    message = '';
  });
  return {
    get busy() { return busy; },
    get step() { return step; },
    whenIdle: () => pending,
    body,
    footer,
  };
}
