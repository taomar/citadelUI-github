/**
 * Citadel UI application shell.
 *
 * State model: the loaded document is never mutated locally. Edits accumulate as
 * path-addressed operations which are previewed server-side and then committed.
 * The browser and the file on disk therefore cannot drift, and the diff the user
 * approves is exactly the text that gets written.
 *
 * Navigation is built around the three areas that are edited in normal
 * operation. Every other parameter file in the repository stays reachable behind
 * a disclosure, so nothing is hidden -- it is just not competing for attention.
 *
 * The shell is three persistent panes plus a title block: areas rail, context
 * rail (contract list and/or section index), and the sheet. Save, discard and
 * the pending count live in the title block rather than in a header that
 * scrolls away, because the one thing a control plane must never lose is
 * whether there is unsaved work.
 */

import { api } from './api.mjs';
import { ensureOwnerSession } from './owner-gate.mjs';
import { h, mount, clear } from './dom.mjs';
import { preserveEditorFocus } from './editor-focus.mjs';
import { renderDiff } from './diff.mjs';
import { renderParamDocument, renderOutlineNav } from './paramview.mjs';
import { previewDocument, queueOperation } from './preview.mjs';
import { renderPolicy } from './policyview.mjs';
import { decoratePolicy } from './policynav.mjs';
import { classifyValidation, editableValue, validateDocument } from './validation.mjs';
import { APIM_SKUS, LOGIC_APPS_TEMPLATE } from './azuremeta.mjs';
import {
  activeWorkspace,
  attachEnvironment,
  attachLocalSourceEnvironment,
  attachGitHubEnvironment,
  assertSupportedScan,
  clearActiveWorkspace,
  commitActiveWorkspaceReconnect,
  ensureWorkspace,
  scanProvider,
  syncRegistryMetadata,
  localPathMatchesHandle,
  observeSetupContext,
  validateLocalPath,
  workspaceRegistry,
} from './workspace-context.mjs';
import { createGitHubPanel } from './github-setup.mjs';
import { describeWriteTarget } from './branch-target.mjs';
import { guardedHandler } from './single-flight.mjs';
import { githubSessions } from './github-session-manager.mjs';
import { BrowserDirectoryProvider } from './directory-provider.mjs';
import { environmentLocation, environmentSourceOf, isGitHubEnvironment } from './registry.mjs';
import { createProvider } from './source-factory.mjs';
import { historyEntry } from './history-entry.mjs';
import { createCompareSession } from './compare-session.mjs';
import { openMigrationWizard } from './migration-wizard.mjs';
import { openLocalSourceImport } from './local-source-import.mjs';
import { describeCreatedBranch, saveStatusLine } from './save-resolution.mjs';
import { refNameProblem } from '../../shared/git-refs.mjs';

/**
 * GitHub's compare view for the environment's working branch.
 *
 * Rendered as a link so the user's browser navigates to GitHub directly;
 * Citadel UI itself never opens an outbound connection for this.
 */
function pullRequestUrl(environment) {
  const source = environmentSourceOf(environment);
  const compare = `${encodeURIComponent(source.sourceBranch)}...${encodeURIComponent(source.workingBranch)}`;
  return `https://github.com/${source.fullName}/compare/${compare}?expand=1`;
}
import { createEnvironmentOperation } from './settings-operation.mjs';
import { createEnvironmentForm, createGitHubConnectionSummary, createWorkspaceSettingsView } from './workspace-settings-view.mjs';
import { setRawPolicyDraft } from './policy-edit-state.mjs';
import {
  captureContractEdits,
  clearEditorPending,
  editorPendingCount,
  restoreContractEdits,
} from './contract-edit-state.mjs';
import {
  choiceDialog,
  closeDialog,
  confirmDialog,
  dismissDialog,
  promptDialog,
  showDialog,
} from './dialog.mjs';

const state = {
  areas: [],
  area: null,
  catalog: null,
  contracts: null,
  contractId: null,
  contract: null,
  onboardedModels: [],
  accessTargets: null,
  policyVariables: [],
  throttleSpecs: null,
  semanticCacheSpec: null,
  contentSafetySpec: null,
  policyPreview: null,
  current: null,
  baselineValidation: [],
  operations: [],
  policyChanges: {},
  policyRaw: null,
  policyMode: 'guided',
  tab: 'params',
  open: new Map(),
  filter: '',
  showAll: false,
  status: null,
  projectLabel: 'Project',
};

const els = {};
const COMPACT_NAV = window.matchMedia('(max-width: 48rem)');
const pendingByDocument = new Map();

/* ------------------------------------------------------------------ status */

let statusTimer = null;
let pendingTicker = null;
let pendingSince = 0;

// A slow network and a hung app look identical if nothing on screen moves. Work
// that is waiting says so, and says so more loudly the longer it waits, so the
// user never has to guess whether Citadel is still trying.
const STILL_WORKING_AFTER_MS = 8000;

function setStatus(message, tone = 'info', sticky = false, pending = false) {
  state.status = message ? { message, tone, pending } : null;
  clearTimeout(statusTimer);
  clearTimeout(pendingTicker);
  if (message && pending) {
    pendingSince = Date.now();
    // Re-render once the wait stops being ordinary, so the toast can escalate
    // from "doing it" to "still doing it" without a timer that ticks forever.
    pendingTicker = setTimeout(renderStatus, STILL_WORKING_AFTER_MS);
  }
  // Transient notices must clear themselves. A toast that is only dismissed on
  // the success path stays pinned forever the moment anything throws.
  if (message && !sticky && tone !== 'error') {
    statusTimer = setTimeout(() => {
      state.status = null;
      renderStatus();
    }, 4000);
  }
  renderStatus();
}

function renderStatus() {
  if (!state.status) {
    els.status.hidden = true;
    els.status.removeAttribute('aria-busy');
    return;
  }
  const { message, tone, pending } = state.status;
  els.status.hidden = false;
  els.status.className = `status status-${tone}${pending ? ' status-pending' : ''}`;
  // Assistive tech is told the region is busy, not just sent new text.
  if (pending) els.status.setAttribute('aria-busy', 'true');
  else els.status.removeAttribute('aria-busy');
  const waited = pending && Date.now() - pendingSince >= STILL_WORKING_AFTER_MS;
  mount(
    els.status,
    h('span', { class: 'status-text' }, message),
    // Honest reassurance rather than a fake percentage: nothing here knows how
    // long GitHub will take, so it reports that it is still trying, not how far.
    waited ? h('span', { class: 'status-waiting' }, 'still working\u2026') : null,
    // Work in flight offers no dismiss control. Hiding the toast would leave the
    // operation running with nothing on screen to say so, which is exactly the
    // "did it break?" state this is here to prevent.
    pending
      ? null
      : h(
          'button',
          {
            class: 'status-x',
            type: 'button',
            'aria-label': 'Dismiss notification',
            onclick: () => setStatus(null),
          },
          '\u2715'
        )
  );
}

function currentWriteContext(file = state.current?.path || null, environment = null) {
  let workspace = null;
  try {
    workspace = activeWorkspace();
  } catch {
    // Setup has no active workspace yet.
  }
  const selected = environment || workspace?.environment || {};
  return {
    project: state.projectLabel || 'Project',
    environment: selected.label || 'Environment',
    file: file || 'No file selected',
    localPath: environmentLocation(selected),
    // Named, every time, before the save happens. A user should never have to
    // open GitHub to discover which branch received their edits — which is
    // exactly what an auto-created `citadel-ui/<uuid>` forced them to do.
    target: describeWriteTarget(environmentSourceOf(selected)),
  };
}

function writeContextNode(options = {}) {
  const source = options.source || currentWriteContext(options.file);
  const target = options.target || null;
  const row = (label, context) =>
    h(
      'div',
      { class: 'write-context-row' },
      h('strong', {}, label),
      h(
        'span',
        { class: 'write-context-breadcrumb' },
        h('span', {}, context.project),
        h('span', { 'aria-hidden': 'true' }, '\u203a'),
        h('span', {}, context.environment),
        h('span', { 'aria-hidden': 'true' }, '\u203a'),
        h('code', {}, context.file)
      ),
      context.target
        ? h(
            'span',
            { class: 'write-context-branch' },
            'Branch ',
            h('code', {}, context.target.branch),
            h('span', { class: 'write-context-origin' }, ` \u2014 ${context.target.text.split(' \u2014 ')[1] || ''}`)
          )
        : null,
      h('code', { class: 'write-context-local', title: context.localPath }, context.localPath)
    );
  return h(
    'section',
    { class: 'write-context', 'aria-label': target ? 'Source and target context' : 'Write context' },
    row(target ? 'Source' : 'Writing to', source),
    target ? row('Target', target) : null
  );
}

function formatTimestamp(raw) {
  const date = new Date(raw || '');
  if (Number.isNaN(date.getTime())) return h('span', { class: 'time-unknown' }, 'Time unavailable');
  const exact = date.toISOString();
  return h(
    'time',
    { datetime: exact, title: `${exact} (UTC)` },
    date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  );
}

const ACTION_LABELS = {
  'contract-create': 'Created contract',
  'history-restore': 'Restored prior revision',
  'environment-copy': 'Copied environment parameters',
  save: 'Saved changes',
  'policy-save': 'Saved policy',
};

function humanAction(transaction) {
  const action = transaction.action || transaction.targetLabel || 'change';
  return ACTION_LABELS[action] || String(action).replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function transactionTone(transaction) {
  const status = transaction.status || 'original';
  if (transaction.recoveryRequired || ['committing', 'reverting'].includes(status)) return 'warning';
  if (['failed', 'hash-mismatch', 'corrupt'].includes(status)) return 'danger';
  if (['committed', 'verified', 'rolled_back'].includes(status)) return 'success';
  if (['incompatible', 'degraded'].includes(status)) return 'degraded';
  return 'neutral';
}

/** Every async entry point runs through here so status can never stick. */
async function withStatus(message, fn) {
  // `pending` is what turns a static sentence into a live, animated one. Every
  // await in the product passes through this function, so nothing can wait
  // silently without someone deliberately bypassing it.
  setStatus(message, 'info', true, true);
  try {
    const result = await fn();
    setStatus(null);
    return result;
  } catch (err) {
    setStatus(err.message, 'error');
    return undefined;
  }
}

/* -------------------------------------------------------------- operations */

function pathKey(path) {
  return JSON.stringify(path);
}

function draftContainsSecureValue(operations = state.operations) {
  const definitions = state.current?.schema?.parameters || {};
  return operations.some((operation) => {
    const definition = definitions[operation.path?.[0]];
    return !definition || definition.secure;
  });
}

async function persistParameterDraft() {
  if (!state.current) return;
  const environmentId = activeWorkspace().environment.id;
  if (!state.operations.length || draftContainsSecureValue()) {
    await workspaceRegistry.removeDraft(environmentId, state.current.path);
    return;
  }
  await workspaceRegistry.saveDraft(
    environmentId,
    state.current.path,
    state.current.hash,
    state.operations
  );
}

async function restoreParameterDraft(document) {
  const draft = await workspaceRegistry.getDraft(activeWorkspace().environment.id, document.path);
  if (!draft) return [];
  if (draft.sourceHash !== document.hash) {
    await workspaceRegistry.removeDraft(activeWorkspace().environment.id, document.path);
    setStatus('A saved draft was discarded because the source changed outside Citadel UI.', 'info');
    return [];
  }
  return draft.operations || [];
}

function pushOperation(op) {
  state.operations = queueOperation(state.operations, op, state.current);
  persistParameterDraft().catch((error) => setStatus(error.message, 'error'));
  preserveEditorFocus(els.workspace, render);
}

function pushOperations(operations) {
  for (const operation of operations) {
    state.operations = queueOperation(state.operations, operation, state.current);
  }
  persistParameterDraft().catch((error) => setStatus(error.message, 'error'));
  preserveEditorFocus(els.workspace, render);
}

function dirtyParams() {
  return new Set(state.operations.map((o) => o.path && o.path[0]).filter(Boolean));
}

function currentValidation(doc = viewOf(state.current)) {
  return classifyValidation(validateDocument(doc), state.baselineValidation, dirtyParams());
}

function blockingValidation(doc = viewOf(state.current)) {
  return currentValidation(doc).filter((finding) => finding.severity === 'error');
}

/**
 * The document as the user has expressed it: server truth plus queued edits.
 *
 * Every render rebuilds its controls from the loaded document, but queued edits
 * do not reach that document until the save is confirmed. Rendering the server
 * copy directly would therefore discard uncommitted work on screen -- a typed
 * value would snap back, and an appended backend or model would never appear.
 * Routing every render through here keeps the form showing what the user has
 * done while the file and the server's copy stay untouched until commit.
 */
function viewOf(doc) {
  return doc ? previewDocument(doc, state.operations) : doc;
}

function hasPolicyEdits() {
  return Object.keys(state.policyChanges).length > 0 || state.policyRaw !== null;
}

function pendingCount() {
  let count = editorPendingCount(state);
  for (const pending of pendingByDocument.values()) {
    count += editorPendingCount(pending);
  }
  return count;
}

function pendingKey(path = state.current?.path, environmentId = activeWorkspace().environment.id) {
  return path ? `${environmentId}:${path}` : null;
}

async function stashCurrentPending() {
  if (!editorPendingCount(state) || !state.current) return;
  if (state.operations.length && !draftContainsSecureValue()) await persistParameterDraft();
  const snapshot = captureContractEdits(state);
  snapshot.environmentId = activeWorkspace().environment.id;
  snapshot.secureParameters = draftContainsSecureValue();
  pendingByDocument.set(pendingKey(), snapshot);
  clearEditorPending(state);
}

function restoreStashedPending() {
  const key = pendingKey();
  const snapshot = key && pendingByDocument.get(key);
  if (!snapshot) return;
  const conflicts = restoreContractEdits(state, snapshot);
  if (!conflicts.length) {
    pendingByDocument.delete(key);
  } else {
    setStatus(
      `Preserved edits could not be reapplied because source changed: ${conflicts.join(', ')}.`,
      'error'
    );
  }
}

function canPersistAllPending() {
  const snapshots = [
    {
      ...captureContractEdits(state),
      secureParameters: draftContainsSecureValue(),
    },
    ...pendingByDocument.values(),
  ];
  return snapshots.every(
    (snapshot) =>
      !snapshot.secureParameters &&
      !Object.keys(snapshot.policyChanges || {}).length &&
      snapshot.policyRaw === null
  );
}

async function discardAllPending() {
  const drafts = [];
  if (state.current?.path) {
    drafts.push(
      workspaceRegistry.removeDraft(activeWorkspace().environment.id, state.current.path)
    );
  }
  for (const snapshot of pendingByDocument.values()) {
    if (snapshot.parameterPath) {
      drafts.push(
        workspaceRegistry.removeDraft(snapshot.environmentId, snapshot.parameterPath)
      );
    }
  }
  await Promise.all(drafts);
  pendingByDocument.clear();
  clearEditorPending(state);
}

async function choosePendingNavigation({ allowPreserve = true, destination, leavesPage = false }) {
  if (!pendingCount()) return 'continue';
  const preserve = allowPreserve && (!leavesPage || canPersistAllPending());
  return choiceDialog({
    title: 'Unsaved changes',
    message: preserve
      ? `You have unsaved changes. Preserve them as browser drafts before ${destination}, discard them, or stay here.`
      : `You have unsaved changes that cannot be safely preserved through ${destination}. Discard them or stay here.`,
    context: writeContextNode(),
    choices: [
      { value: 'stay', label: 'Stay' },
      ...(preserve
        ? [{ value: 'preserve', label: 'Preserve & continue', primary: true }]
        : []),
      { value: 'discard', label: 'Discard & continue', tone: 'danger' },
    ],
  });
}

async function applyPendingNavigation(choice, { leavesPage = false } = {}) {
  if (!choice || choice === 'stay') return false;
  if (choice === 'discard') {
    await discardAllPending();
    return true;
  }
  if (choice === 'preserve') {
    await stashCurrentPending();
    if (leavesPage) pendingByDocument.clear();
    return true;
  }
  return choice === 'continue';
}

async function confirmPendingNavigation(options) {
  const choice = await choosePendingNavigation(options);
  return applyPendingNavigation(choice, options);
}

/* Pending edits live only in memory: a reload discards them with no warning,
   which is how a configured throttle block was lost once already. The browser
   owns the wording of the prompt; all we control is whether it appears. */
window.addEventListener('beforeunload', (event) => {
  if (pendingCount() === 0) return;
  event.preventDefault();
  event.returnValue = '';
  return '';
});

/* -------------------------------------------------------------- edit context */

function editContext(doc) {
  const dirty = dirtyParams();
  const params = new Map((doc.params || []).map((param) => [param.name, param]));
  const findings = currentValidation(doc);
  return {
    onChange: (path, value) => pushOperation({ op: 'set', path, value }),
    onAppend: (path, value) => pushOperation({ op: 'append', path, value }),
    onRemove: (path) => pushOperation({ op: 'remove', path }),
    // `set` rewrites an existing span, so a property the file does not yet
    // carry has to be created instead of assigned.
    onAddProperty: (path, key, value) => pushOperation({ op: 'addProperty', path, key, value }),
    rerender: () => render(),
    resolveEnv: () => null,
    schemaFor: (name) => {
      const schema = doc.schema;
      if (!schema || !schema.available) return null;
      const definition = schema.parameters[name] || null;
      if (!definition) return null;
      if (name === 'apimSkuUnits') {
        const selected = editableValue(params.get('apimSku') && params.get('apimSku').value);
        const bounds = APIM_SKUS[selected];
        return bounds ? { ...definition, minValue: bounds.min, maxValue: bounds.max } : definition;
      }
      if (name === 'logicAppsSkuCapacityUnits') {
        return { ...definition, minValue: LOGIC_APPS_TEMPLATE.min, maxValue: LOGIC_APPS_TEMPLATE.max };
      }
      return definition;
    },
    paramValue: (name) => editableValue(params.get(name) && params.get(name).value),
    findingsFor: (name) => findings.filter((finding) => finding.param === name),
    saveSubscriptionId: guardedHandler(async ({ environmentName, value, expectedHash }) => {
      const confirmed = await confirmDialog({
        title: 'Update Azure subscription ID?',
        message:
          `Replace only AZURE_SUBSCRIPTION_ID in .azure/${environmentName}/.env? ` +
          'Every other environment-file byte remains unchanged and never leaves the browser.',
        confirmLabel: 'Update subscription ID',
        context: writeContextNode({ file: `.azure/${environmentName}/.env` }),
      });
      if (!confirmed) return;
      const pendingEdits = captureContractEdits(state);
      const currentPath = state.current.path;
      const result = await withStatus('Saving subscription ID\u2026', () =>
        api.saveSubscriptionId(environmentName, value, expectedHash)
      );
      if (!result) return;
      await loadDocument(currentPath);
      const conflicts = restoreContractEdits(state, pendingEdits);
      render();
      if (conflicts.length) {
        setStatus(
          `Subscription ID was saved, but pending edits could not be restored because source changed: ${conflicts.join(', ')}.`,
          'error'
        );
        return;
      }
      setStatus(
        result.changed ? 'Azure subscription ID updated in the azd environment.' : 'Subscription ID is unchanged.',
        'ok'
      );
    }, { key: 'save-subscription-id' }),
    accessTargets: state.accessTargets,
    applyObject: (path, source, fields) => {
      const target = path.reduce((value, segment) => value && value[segment], Object.fromEntries(
        (doc.params || []).map((param) => [param.name, param.value])
      ));
      const operations = fields.map((field) =>
        target && Object.prototype.hasOwnProperty.call(target, field)
          ? { op: 'set', path: [...path, field], value: source[field] }
          : { op: 'addProperty', path, key: field, value: source[field] }
      );
      pushOperations(operations);
    },
    pendingFor: (name) => dirty.has(name),
    isOpen: (id, fallback) => (state.open.has(id) ? state.open.get(id) : fallback),
    setOpen: (id, value) => state.open.set(id, value),
  };
}

/* ------------------------------------------------------------------ sidebar */

function areaButton(area) {
  const active = state.area === area.id;
  return h(
    'button',
    { class: `area${active ? ' active' : ''}`, onclick: () => selectArea(area.id) },
    h('span', { class: 'area-title' }, area.title),
    h('span', { class: 'area-sub' }, area.subtitle)
  );
}

function matchesFilter(text) {
  return !state.filter || text.toLowerCase().includes(state.filter.toLowerCase());
}

function renderSidebar() {
  const areas = h('div', { class: 'areas' }, state.areas.map(areaButton));

  const catalog = state.catalog;
  const extras = catalog
    ? catalog.files.filter(
        (f) => !state.areas.some((a) => a.path === f.path) && matchesFilter(f.path)
      )
    : [];

  const all = h(
    'details',
    { class: 'all-deployments', open: state.showAll },
    h('summary', {}, `All parameter files (${catalog ? catalog.files.length : 0})`),
    h('input', {
      class: 'ctl ctl-sm',
      type: 'search',
      id: 'deployment-filter',
      name: 'deployment-filter',
      'aria-label': 'Filter parameter files',
      placeholder: 'Filter\u2026',
      value: state.filter,
      oninput: (e) => {
        state.filter = e.target.value;
        renderSidebar();
      },
    }),
    h(
      'div',
      { class: 'all-list' },
      extras.length
        ? extras.map((f) =>
            h(
              'button',
              {
                class: `nav-item${
                  state.area === 'other' && state.current && state.current.path === f.path
                    ? ' active'
                    : ''
                }`,
                onclick: () => openOther(f.path),
              },
              h('span', { class: 'nav-name' }, f.name),
              h('span', { class: 'nav-meta' }, f.path)
            )
          )
        : h('p', { class: 'empty' }, 'No matches.')
    )
  );
  all.addEventListener('toggle', () => {
    state.showAll = all.open;
  });

  const currentArea = state.areas.find((area) => area.id === state.area);
  mount(
    els.sidebar,
    h(
      'details',
      { class: 'area-disclosure', open: !COMPACT_NAV.matches },
      h(
        'summary',
        { class: 'area-disclosure-summary' },
        h('span', {}, 'Navigate'),
        h('strong', {}, currentArea?.title || 'Choose an area')
      ),
      h('div', { class: 'area-disclosure-body' }, areas, all)
    )
  );
}

/* ---------------------------------------------------------------- contracts */

function contractList() {
  const data = state.contracts;
  if (!data) return h('p', { class: 'empty' }, 'Loading contracts\u2026');

  return h(
    'div',
    { class: 'contract-list' },
    h(
      'header',
      { class: 'contract-list-head' },
      h('h3', {}, 'Contracts'),
      h('button', { class: 'btn btn-sm btn-primary', onclick: openCreateContract }, 'New')
    ),
    data.contracts.map((c) =>
      h(
        'button',
        {
          class: `contract-item${state.contractId === c.id ? ' active' : ''}${
            c.isTemplate ? ' contract-template' : ''
          }`,
          onclick: () => selectContract(c.id),
        },
        h('span', { class: 'contract-name', title: c.dir }, c.name),
        h(
          'span',
          { class: 'contract-meta' },
          c.isTemplate ? h('span', { class: 'chip chip-note' }, 'template') : null,
          h('span', { class: 'chip chip-count' }, `${c.paramCount}`),
          c.hasPolicy
            ? h('span', { class: 'chip chip-ok' }, 'policy')
            : h('span', { class: 'chip chip-warn' }, 'default')
        )
      )
    ),
    data.recoverable && data.recoverable.length
      ? h(
          'p',
          { class: 'hint hint-warn' },
          `${data.recoverable.length} missing \u2014 recover from the sheet.`
        )
      : null
  );
}

async function restoreContract(id) {
  const res = await withStatus('Restoring contract\u2026', () => api.restoreContract(id));
  if (!res) return;
  // Refreshing the list is a second round trip over the same network. Left
  // unwrapped it is a silent wait after the visible one has ended.
  state.contracts = await withStatus('Refreshing contracts\u2026', () => api.contracts());
  render();
  selectContract(id);
}

function openCreateContract() {
  const input = h('input', {
    id: 'new-contract-name',
    name: 'contractName',
    class: 'ctl',
    placeholder: 'hr-chatagent',
    autocomplete: 'off',
    required: true,
    autofocus: true,
  });
  const preview = h('p', { class: 'hint hint-preview' }, '');
  input.addEventListener('input', () => {
    const name = input.value.trim().toLowerCase();
    preview.textContent = name
      ? `Creates ${state.contracts.root}/${state.contracts.parent}/${name}/ containing main.bicepparam and ai-product-policy.xml`
      : '';
  });

  showModal(
    'New access contract',
    h(
      'div',
      {},
      h(
        'p',
        { class: 'hint' },
        'Copied from the module template and its default policy, with the module path and the policy reference rewired automatically.'
      ),
      writeContextNode({ file: `${state.contracts.root}/${state.contracts.parent}/<new contract>/main.bicepparam` }),
      h('label', { class: 'pol-label', for: 'new-contract-name' }, 'Contract name'),
      input,
      h(
        'p',
        { class: 'hint' },
        'Lowercase letters, digits and hyphens. The name feeds Azure resource names, so it is normalised to lowercase.'
      ),
      preview
    ),
    [
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn btn-primary',
          onclick: async () => {
            const name = input.value.trim();
            if (!name) return;
            const result = await withStatus('Creating\u2026', () => api.createContract({ name }));
            if (!result) return;
            closeModal();
            state.contracts = await withStatus('Refreshing contracts\u2026', () => api.contracts());
            await selectContract(result.id);
            setStatus(`Created ${result.dir}`, 'ok');
          },
        },
        'Create'
      ),
    ]
  );
  requestAnimationFrame(() => input.focus());
}

async function loadContract(id, preserved = null, preserveOptions = undefined) {
  const loaded = await withStatus('Loading contract\u2026', () =>
    Promise.all([api.contract(id), api.accessContractTargets()])
  );
  if (!loaded) return false;
  const [contract, accessTargets] = loaded;
  state.contractId = id;
  state.contract = contract;
  state.accessTargets = accessTargets;
  state.current = contract.param;
  state.baselineValidation = validateDocument(contract.param);
  state.operations = await restoreParameterDraft(contract.param);
  state.policyChanges = {};
  state.policyRaw = null;
  state.policyPreview = null;
  state.open = new Map();
  if (preserved) {
    const conflicts = restoreContractEdits(state, preserved, preserveOptions);
    if (conflicts.length) {
      setStatus(
        `Pending edits could not be reapplied because source changed: ${conflicts.join(', ')}.`,
        'error'
      );
    }
  } else {
    restoreStashedPending();
  }
  render();

  // The onboarded-model list only shapes a suggestion, so it is fetched after
  // the contract is on screen rather than made a precondition for showing it.
  if (!state.onboardedModels.length) {
    try {
      const [{ models }, specs] = await Promise.all([
        api.onboardedModels(),
        api.policyVariables(),
      ]);
      state.onboardedModels = models || [];
      state.policyVariables = specs.variables || [];
      state.throttleSpecs = specs.throttles || null;
      state.semanticCacheSpec = specs.semanticCache || null;
      state.contentSafetySpec = specs.contentSafety || null;
      render();
    } catch {
      state.onboardedModels = [];
    }
  }
  return true;
}

async function selectContract(id, options = {}) {
  if (!options.skipPendingCheck && state.contractId !== id) {
    const choice = await choosePendingNavigation({
      destination: `opening contract ${id}`,
    });
    if (!(await applyPendingNavigation(choice))) return;
  }
  await loadContract(id, options.preserved, options.preserveOptions);
}

/* ------------------------------------------------------------------- policy */

let policyPreviewToken = 0;

/**
 * Drop control entries whose payload has been emptied out.
 *
 * Adding a per-model limit and then removing it again leaves the entry present
 * but inert. Left in place the header would claim unsaved changes while the
 * diff showed none, which is exactly the kind of thing that makes the editor
 * feel untrustworthy.
 */
function pruneEmptyChanges(changes) {
  const kept = {};
  for (const [control, payload] of Object.entries(changes)) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      kept[control] = payload;
      continue;
    }
    const live = Object.entries(payload).filter(([, v]) => {
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === 'object') return Object.keys(v).length > 0;
      return v !== undefined;
    });
    if (live.length) kept[control] = Object.fromEntries(live);
  }
  return kept;
}

function foldPolicyChange(change) {
  const next = { ...state.policyChanges };
  if (change.control === 'allowedModels') next.allowedModels = change.value;
  else if (change.control === 'responseHeaders') next.responseHeaders = change.value;
  else if (change.control === 'tokenLimit') {
    const tl = { ...(next.tokenLimit || {}) };
    if (change.attribute) {
      tl.attributes = { ...(tl.attributes || {}), [change.attribute]: change.value };
    }
    if (change.enabled !== undefined) tl.enabled = change.enabled;
    next.tokenLimit = tl;
  } else if (
    change.control === 'tokenLimits' ||
    change.control === 'rateLimits' ||
    change.control === 'quotaLimits'
  ) {
    const key = change.control;
    const tl = { ...(next[key] || {}) };
    // Accumulated as lists so a second click does not overwrite the first: the
    // whole payload is replayed against the file on every preview and save.
    if (change.addModel && !(tl.addModels || []).includes(change.addModel)) {
      tl.addModels = [...(tl.addModels || []), change.addModel];
    }
    if (change.removeModel) {
      // Removing something this session added cancels the addition outright,
      // rather than queuing a removal for a branch the file never had.
      const pending = (tl.addModels || []).includes(change.removeModel);
      tl.addModels = (tl.addModels || []).filter((m) => m !== change.removeModel);
      if (!pending && !(tl.removeModels || []).includes(change.removeModel)) {
        tl.removeModels = [...(tl.removeModels || []), change.removeModel];
      }
    }
    if (change.perModel) {
      tl.perModel = { ...(tl.perModel || {}) };
      for (const [model, attrs] of Object.entries(change.perModel)) {
        tl.perModel[model] = { ...(tl.perModel[model] || {}), ...attrs };
      }
    }
    if (change.universal) tl.universal = { ...(tl.universal || {}), ...change.universal };
    next[key] = tl;
  } else if (change.control === 'variable') {
    next.variables = { ...(next.variables || {}), [change.key]: change.value };
  } else if (change.control === 'semanticCache') {
    const block = { ...(next.semanticCache || {}) };
    if (change.enable !== undefined) block.enable = change.enable;
    if (change.enabled !== undefined) block.enabled = change.enabled;
    if (change.lookup) block.lookup = { ...(block.lookup || {}), ...change.lookup };
    if (change.store) block.store = { ...(block.store || {}), ...change.store };
    if (change.varyBy) block.varyBy = { ...(block.varyBy || {}), ...change.varyBy };
    next.semanticCache = block;
  } else if (
    change.control === 'contentSafety' ||
    change.control === 'rateLimit' ||
    change.control === 'callQuota'
  ) {
    const block = { ...(next[change.control] || {}) };
    if (change.attributes) block.attributes = { ...(block.attributes || {}), ...change.attributes };
    if (change.categories) block.categories = { ...(block.categories || {}), ...change.categories };
    if (change.enable) block.enable = true;
    if (change.enabled !== undefined) block.enabled = change.enabled;
    if (change.addCategory) {
      const queued = (block.removeCategories || []).includes(change.addCategory);
      block.removeCategories = (block.removeCategories || []).filter((c) => c !== change.addCategory);
      if (!queued) block.addCategories = [...(block.addCategories || []), change.addCategory];
    }
    if (change.removeCategory) {
      const pending = (block.addCategories || []).includes(change.removeCategory);
      block.addCategories = (block.addCategories || []).filter((c) => c !== change.removeCategory);
      if (!pending) block.removeCategories = [...(block.removeCategories || []), change.removeCategory];
    }
    if (change.outputType) block.outputType = change.outputType;
    if (change.addBlocklist) {
      const queued = (block.removeBlocklists || []).includes(change.addBlocklist);
      block.removeBlocklists = (block.removeBlocklists || []).filter((b) => b !== change.addBlocklist);
      if (!queued) block.addBlocklists = [...(block.addBlocklists || []), change.addBlocklist];
    }
    if (change.removeBlocklist) {
      const pending = (block.addBlocklists || []).includes(change.removeBlocklist);
      block.addBlocklists = (block.addBlocklists || []).filter((b) => b !== change.removeBlocklist);
      if (!pending) block.removeBlocklists = [...(block.removeBlocklists || []), change.removeBlocklist];
    }
    next[change.control] = block;
  }
  state.policyChanges = pruneEmptyChanges(next);
  // Structured edits and hand-edited XML are mutually exclusive: mixing them
  // would splice spans computed against text the user has since rewritten.
  state.policyRaw = null;
  render();
  refreshPolicyPreview();
}

/**
 * Re-read the controls from the edited XML.
 *
 * The controls carry character spans into the policy text, so a pending change
 * cannot be projected onto them client-side the way a parameter edit can --
 * adding a per-model limit moves every span after it. The server already owns
 * the splice logic, so it re-parses the result and the screen renders that.
 */
async function refreshPolicyPreview() {
  const policy = state.contract && state.contract.policy;
  if (!policy) return;
  const token = ++policyPreviewToken;

  if (!Object.keys(state.policyChanges).length) {
    state.policyPreview = null;
    render();
    return;
  }

  try {
    const res = await api.previewPolicy(policy.path, state.policyChanges, policy.hash);
    if (token !== policyPreviewToken) return;
    state.policyPreview = { text: res.after, controls: res.controls };
  } catch (err) {
    if (token !== policyPreviewToken) return;
    state.policyPreview = null;
    setStatus(err.message, 'error');
  }
  render();
}

function policyContext() {
  return {
    policyMode: state.policyMode,
    /**
     * Guided and raw are two views of the same file, but only one direction is
     * lossless. Guided hands the previewed XML to the textarea, so nothing is
     * lost going that way. Coming back means dropping hand-written XML that has
     * no structured equivalent, so say so before it happens rather than after.
     */
    setPolicyMode: (mode) => {
      const losing = mode === 'guided' && state.policyRaw !== null;
      if (!losing) {
        state.policyMode = mode;
        render();
        return;
      }
      showModal(
        'Discard hand-edited XML?',
        h(
          'div',
          {},
          h(
            'p',
            { class: 'hint' },
            'The guided editor works from the file on disk. Switching back now discards the XML you typed here, because the form has no way to represent it.'
          )
        ),
        [
          h('button', { class: 'btn', onclick: closeModal }, 'Stay in Raw XML'),
          h(
            'button',
            {
              class: 'btn btn-primary',
              onclick: () => {
                state.policyRaw = null;
                state.policyMode = 'guided';
                closeModal();
                render();
              },
            },
            'Discard and switch'
          ),
        ]
      );
    },
    onPolicyChange: foldPolicyChange,
    policyVariables: state.policyVariables,
    throttleSpecs: state.throttleSpecs,
    semanticCacheSpec: state.semanticCacheSpec,
    contentSafetySpec: state.contentSafetySpec,
    onboardedModels: state.onboardedModels,
    onPolicyRaw: (text) => {
      setRawPolicyDraft(state, text, renderActions);
    },
  };
}

async function savePolicy() {
  const policy = state.contract && state.contract.policy;
  if (!policy) return;

  const raw = state.policyRaw;
  const payload = {
    path: policy.path,
    expectedHash: policy.hash,
    ...(raw !== null ? { text: raw } : { changes: state.policyChanges }),
  };

  const preview =
    raw !== null
      ? { before: policy.text, after: raw, changed: raw !== policy.text }
      : await withStatus('Preparing preview\u2026', () =>
          api.previewPolicy(policy.path, state.policyChanges, policy.hash)
        );
  if (!preview) return;
  if (!preview.changed) {
    setStatus('Nothing changed in the policy.', 'info');
    return;
  }

  const { node, stats } = renderDiff(preview.before, preview.after);
  showModal(
    'Review policy changes',
    h(
      'div',
      {},
      h('p', { class: 'hint' }, `${stats.added} added, ${stats.removed} removed in ${policy.name}.`),
      writeContextNode({ file: policy.path }),
      node
    ),
    [
      h('button', { class: 'btn', onclick: closeModal }, 'Back'),
      h(
        'button',
        {
          class: 'btn btn-primary',
          // Same guarantee as the parameter save: one click, one commit.
          // Keyed by the operation, so a rebuilt modal cannot hand out a fresh
          // lock while the previous policy save is still running.
          onclick: guardedHandler(async () => {
            const preserved = captureContractEdits(state);
            const result = await withStatus('Saving\u2026', () => api.savePolicy(payload));
            if (!result) return;
            closeModal();
            await loadContract(
              state.contractId,
              preserved,
              { parameters: true, policy: false }
            );
            setStatus(
              result.changed
                ? `Saved ${result.path}. Previous revision archived to ${result.archived}`
                : 'Nothing changed.',
              'ok'
            );
          }, { key: 'save-policy' }),
        },
        'Save policy'
      ),
    ]
  );
}

/* -------------------------------------------------------------- review/save */

async function openReview() {
  if (!state.operations.length) {
    setStatus('No pending changes.', 'info');
    return;
  }
  const findings = blockingValidation();
  if (findings.length) {
    setStatus(`Resolve ${findings.length} validation ${findings.length === 1 ? 'error' : 'errors'} before review.`, 'error');
    return;
  }
  const preview = await withStatus('Preparing preview\u2026', () =>
    api.preview(state.current.path, state.operations, state.current.hash)
  );
  if (!preview) return;

  const { node, stats } = renderDiff(preview.before, preview.after);
  showModal(
    'Review changes',
    h(
      'div',
      {},
      h(
        'p',
        { class: 'hint' },
        `${stats.added} added, ${stats.removed} removed. Comments and formatting outside these lines are preserved byte-for-byte.`
      ),
      writeContextNode(),
      node
    ),
    [
      h('button', { class: 'btn', onclick: closeModal }, 'Back'),
      // Guarded, not merely awaited. Two clicks on this button used to run two
      // saves from the same reviewed head, producing two commits with an
      // identical tree — one on the branch, one rescued onto a branch of its
      // own. The second click is dropped and the button says so.
      h(
        'button',
        {
          class: 'btn btn-primary',
          // Keyed by the operation, not by this button. A modal rebuild must not
          // hand out a fresh lock while the previous save is still in flight.
          onclick: guardedHandler(commitSave, { key: 'save-parameters' }),
        },
        'Save changes'
      ),
    ]
  );
}

async function commitSave() {
  const findings = blockingValidation();
  if (findings.length) {
    closeModal();
    setStatus('The document became invalid. Resolve validation errors before saving.', 'error');
    return;
  }
  const preserved = captureContractEdits(state);
  const result = await withStatus('Saving\u2026', () =>
    api.save(state.current.path, state.operations, state.current.hash)
  );
  if (!result) return;
  const source = environmentSourceOf(activeWorkspace().environment);
  const line = saveStatusLine(result, source);

  if (line.pending) {
    // The commit exists but is on no branch, and Citadel will not invent one.
    //
    // The draft is deliberately kept and the document is not reloaded. Under the
    // old auto-rescue this was safe, because the work had a home; now it does
    // not, so clearing the draft and reloading would show the branch's old
    // content with the user's edits apparently gone — the exact failure this
    // whole change exists to prevent. The commit SHA is the safety net for the
    // repository; the retained draft is the safety net for the editor.
    closeModal();
    setStatus(line.text, line.tone);
    await resolveUnsavedCommit(line.pending, source);
    return;
  }

  closeModal();
  state.operations = [];
  await workspaceRegistry.removeDraft(activeWorkspace().environment.id, state.current.path);
  if (state.area === 'access-contracts') {
    await loadContract(
      state.contractId,
      preserved,
      { parameters: false, policy: true }
    );
  }
  else await loadDocument(state.current.path);
  // A warning here always describes something the source could not confirm
  // *after* the write landed, so the save is reported as done and the caveat is
  // appended rather than replacing it with a failure.
  setStatus(line.text, line.tone);
}

/**
 * Ask what to do with a commit that has no branch.
 *
 * This is the decision that replaced automatic rescue. Nothing has been created
 * at this point and nothing will be unless the user names a branch here, so
 * dismissing the dialog is a legitimate answer — "leave it" — and their edits
 * are still in the editor.
 */
async function resolveUnsavedCommit(pending, source) {
  await new Promise((resolve) => {
    const name = h('input', {
      class: 'ctl',
      type: 'text',
      id: 'unsaved-branch-name',
      // Offered, not filled in. Citadel suggests; the user decides.
      placeholder: pending.suggestedBranch || 'branch name',
      'aria-label': 'Branch name for this commit',
    });
    const problem = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const done = () => {
      dismissDialog(true);
      resolve();
    };
    const create = guardedHandler(async () => {
      const chosen = String(name.value || '').trim() || pending.suggestedBranch || '';
      const reason = refNameProblem(chosen);
      if (reason) {
        problem.textContent = reason;
        problem.hidden = false;
        return;
      }
      const outcome = await withStatus('Creating the branch\u2026', () =>
        api.createCommitBranch(pending.commit, chosen)
      );
      if (!outcome) return;
      const created = describeCreatedBranch(outcome, source, pending.intendedBranch);
      dismissDialog(true);
      // Only now is the work on a branch, so only now is the draft safe to drop.
      state.operations = [];
      await workspaceRegistry.removeDraft(activeWorkspace().environment.id, state.current.path);
      setStatus(created.message, 'ok');
      resolve();
    });

    showDialog(
      pending.title,
      h(
        'div',
        { class: 'dialog-message' },
        h('p', {}, pending.message),
        h('label', { for: 'unsaved-branch-name' }, 'Branch name', name),
        problem,
        h(
          'p',
          { class: 'hint' },
          'Your edits stay in the editor either way. Nothing is created unless you name a branch here.'
        )
      ),
      [
        h('button', { class: 'btn', type: 'button', onclick: done }, 'Leave it for now'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: create }, 'Create branch'),
      ],
      { stack: true, onDismiss: () => resolve() }
    );
  });
}

/* --------------------------------------------------------------------- modal */

function showModal(title, body, actions) {
  showDialog(title, body, actions);
}

function closeModal() {
  closeDialog();
}

/* ----------------------------------------------------------------- rendering */

async function switchEnvironment(environment) {
  if (
    !(await confirmPendingNavigation({
      destination: `switching to ${environment.label}`,
      leavesPage: true,
    }))
  ) return;
  workspaceRegistry.setActive(environment.projectId, environment.id);
  location.reload();
}

/**
 * One history row, whichever source produced it. The reconciliation itself lives
 * in `history-entry.mjs` so it can be exercised without a DOM.
 */
async function openHistory() {
  const result = await withStatus('Loading history\u2026', () => api.history());
  if (!result) return;
  const transactions = Array.isArray(result) ? result : result.transactions || result.items || [];
  showModal(
    'Environment history',
    h(
      'div',
      { class: 'history-view' },
      writeContextNode(),
      h('p', { class: 'hint' }, 'Backups, journals, and redacted audit records are stored under the isolated Citadel data directory. Source values and content are not shown here.'),
      transactions.length
        ? h(
            'div',
            { class: 'history-list' },
            transactions.map((transaction) => {
              const entry = historyEntry(transaction);
              return h(
                'section',
                { class: `history-item history-${transactionTone(transaction)}` },
                h(
                  'div',
                  { class: 'history-summary' },
                  h('strong', {}, humanAction(transaction)),
                  h(
                    'span',
                    { class: `chip chip-${transactionTone(transaction)}` },
                    String(entry.status).replace(/_/g, ' ')
                  ),
                  formatTimestamp(entry.timestamp)
                ),
                h(
                  'code',
                  { class: 'history-files' },
                  entry.aliases.join(', ') || 'No file aliases recorded'
                ),
                h(
                  'details',
                  { class: 'technical-details' },
                  h('summary', {}, 'Technical details'),
                  h('code', {}, entry.id || 'No transaction ID')
                ),
                transaction.recoveryRequired ||
                transaction.status === 'committing' ||
                transaction.status === 'reverting'
                  ? h('button', {
                      class: 'btn btn-sm',
                      onclick: async () => {
                        const id = transaction.transactionId || transaction.id;
                        const inspection = await withStatus('Inspecting source hashes\u2026', () =>
                          api.inspectRecovery(id)
                        );
                        if (!inspection) return;
                        showModal(
                          'Recover transaction',
                          h(
                            'div',
                            { class: 'recovery-inspection' },
                            writeContextNode({
                              file:
                                (transaction.files || transaction.targets || [])
                                  .map((target) => target.alias)
                                  .join(', ') || state.current?.path,
                            }),
                            h('p', { class: 'hint' }, 'Current source is compared by SHA-256. Values and content are not shown.'),
                            inspection.files.map((file) =>
                              h(
                                'div',
                                { class: `compare-row recovery-${file.state}` },
                                h('code', {}, file.alias),
                                h(
                                  'span',
                                  {
                                    class: `chip chip-${
                                      ['final', 'verified'].includes(file.state)
                                        ? 'success'
                                        : ['failed', 'hash-mismatch'].includes(file.state)
                                          ? 'danger'
                                          : file.state === 'original'
                                            ? 'neutral'
                                            : 'warning'
                                    }`,
                                  },
                                  String(file.state).replace(/-/g, ' ')
                                )
                              )
                            )
                          ),
                          [
                            h('button', { class: 'btn', onclick: openHistory }, 'Back'),
                            h('button', {
                              class: 'btn',
                              onclick: async () => {
                                const result = await withStatus('Restoring verified backups\u2026', () =>
                                  api.recoverTransaction(id, 'rollback')
                                );
                                if (result) await openHistory();
                              },
                            }, transaction.status === 'reverting' ? 'Continue removal' : 'Roll back'),
                            h('button', {
                              class: 'btn btn-primary',
                              disabled: !inspection.canComplete,
                              onclick: async () => {
                                const result = await withStatus('Completing transaction\u2026', () =>
                                  api.recoverTransaction(id, 'complete')
                                );
                                if (result) await openHistory();
                              },
                            }, transaction.status === 'reverting' ? 'Confirm removed' : 'Complete')
                          ]
                        );
                      },
                    }, 'Recover')
                  : null
                ,
                entry.canUndo
                  ? h('button', {
                       class: 'btn btn-sm btn-danger-ghost',
                      onclick: async () => {
                        const creation = entry.isCreation;
                         if (
                           !(await confirmDialog({
                             title: creation ? 'Undo contract creation?' : 'Restore prior revision?',
                             message: creation
                               ? 'Remove the files created by this transaction? Every file must still match its committed hash.'
                               : 'Restore the prior bytes from this transaction? Current source will be backed up first.',
                             confirmLabel: creation ? 'Remove created files' : 'Back up and restore',
                             tone: 'danger',
                             context: writeContextNode({
                               file: entry.aliases.join(', ') || state.current?.path,
                             }),
                           }))
                         ) return;
                         const result = await withStatus('Backing up current source and restoring\u2026', () =>
                           api.restoreTransaction(entry.id)
                        );
                        if (!result) return;
                        closeModal();
                        if (creation) {
                          state.contracts = await withStatus('Refreshing contracts\u2026', () =>
                            api.contracts()
                          );
                          const fallback = state.contracts.contracts?.find((item) => item.isTemplate);
                          if (fallback) await selectContract(fallback.id);
                        } else if (state.current) {
                          await loadDocument(state.current.path);
                        }
                        setStatus(
                          creation
                            ? `Removed the committed contract creation ${result.transactionId}.`
                            : `Restored through new transaction ${result.transactionId}.`,
                          'ok'
                        );
                      },
                    }, entry.isCreation ? 'Undo creation' : 'Restore prior')
                  : null
              );
            })
          )
        : h('p', { class: 'empty' }, 'No transactions have been recorded for this environment.')
    ),
    [h('button', { class: 'btn', onclick: closeModal }, 'Close')]
  );
}

async function openEnvironmentCompare(environments) {
  if (!state.current?.path?.endsWith('.bicepparam')) {
    setStatus('Open a parameter file before comparing environments.', 'info');
    return;
  }
  const candidates = environments.filter((environment) => environment.id !== activeWorkspace().environment.id);
  if (!candidates.length) {
    setStatus('Attach another environment before comparing.', 'info');
    return;
  }
  const select = h(
    'select',
    { id: 'compare-environment', name: 'compareEnvironment', class: 'ctl' },
    candidates.map((environment) =>
      h(
        'option',
        { value: environment.id },
        `${environment.label} — ${environmentLocation(environment)}`
      )
    )
  );
  const results = h('div', { class: 'compare-results', 'aria-live': 'polite' });
  const selectedCount = h('strong', { class: 'compare-selected' }, '0 selected');
  const contextSlot = h('div', { class: 'compare-context' });
  const session = createCompareSession();
  const reviewButton = h(
    'button',
    {
      class: 'btn btn-primary',
      disabled: true,
      onclick: async () => {
        const names = [...results.querySelectorAll('input[data-copy]:checked')].map(
          (input) => input.value
        );
        if (!names.length) return;
        // The target is bound once, for the whole reviewed operation. Re-reading
        // the selector after an await would let a change made while the preview
        // loads redirect reviewed content at a different environment.
        const bound = session.review(select.value);
        if (!bound) return;
        const targetId = bound.targetId;
        const targetEnvironment = candidates.find((environment) => environment.id === targetId);
        select.disabled = true;
        const preview = await withStatus('Preparing target preview\u2026', () =>
          api.previewCopy(targetId, state.current.path, names, state.current.hash)
        );
        if (!preview) {
          session.release();
          select.disabled = false;
          return;
        }
        const { node, stats } = renderDiff(preview.before, preview.after);
        showModal(
          `Review copy to ${preview.targetLabel}`,
          h(
            'div',
            {},
            writeContextNode({
              source: currentWriteContext(),
              target: currentWriteContext(state.current.path, targetEnvironment),
            }),
            h('p', { class: 'hint' }, `${stats.added} added, ${stats.removed} removed in the target only.`),
            node
          ),
          [
            h('button', {
              class: 'btn',
              onclick: () => {
                session.release();
                openEnvironmentCompare(environments);
              },
            }, 'Back'),
            h('button', {
              class: 'btn btn-primary',
              onclick: async () => {
                const copied = await withStatus('Backing up and copying\u2026', () =>
                  api.copyParameters(
                    targetId,
                    state.current.path,
                    names,
                    preview.sourceHash,
                    preview.targetHash
                  )
                );
                if (!copied) return;
                session.release();
                closeModal();
                setStatus(`Copied ${names.length} parameters in transaction ${copied.transactionId}.`, 'ok');
              },
            }, 'Back up target & copy')
          ]
        );
      },
    },
    'Review selected copy'
  );
  const updateSelected = () => {
    const count = results.querySelectorAll('input[data-copy]:checked').length;
    selectedCount.textContent = `${count} selected`;
    reviewButton.disabled = count === 0 || session.locked;
  };
  const load = async () => {
    // A slower response for a target the user has since moved away from must not
    // paint over the newer one.
    const token = session.begin(select.value);
    const targetId = token.targetId;
    const comparison = await withStatus('Comparing\u2026', () =>
      api.compareEnvironment(targetId, state.current.path)
    );
    if (!comparison || session.isStale(token)) return;
    const secure = comparison.source.schema?.parameters || {};
    const differences = comparison.parameters.filter(
      (parameter) =>
        parameter.status === 'different' &&
        secure[parameter.name] &&
        !secure[parameter.name].secure
    );
    const deferred = comparison.parameters.filter(
      (parameter) => !differences.includes(parameter)
    );
    const targetEnvironment = candidates.find((environment) => environment.id === targetId);
    contextSlot.replaceChildren(
      writeContextNode({
        source: currentWriteContext(),
        target: currentWriteContext(state.current.path, targetEnvironment),
      })
    );
    const differenceRows = differences.map((parameter) =>
      h(
        'label',
        { class: 'compare-row compare-different', for: `compare-${parameter.name}` },
        h('input', {
          id: `compare-${parameter.name}`,
          name: 'compareParameter',
          type: 'checkbox',
          value: parameter.name,
          checked: true,
          dataset: { copy: 'true' },
          onchange: updateSelected,
        }),
        h('code', {}, parameter.name),
        h('span', { class: 'chip chip-brand' }, 'different')
      )
    );
    const selectAll = h('input', {
      id: 'compare-select-all',
      name: 'compareSelectAll',
      type: 'checkbox',
      checked: Boolean(differences.length),
      disabled: !differences.length,
      onchange: (event) => {
        for (const input of results.querySelectorAll('input[data-copy]')) {
          input.checked = event.target.checked;
        }
        updateSelected();
      },
    });
    const deferredRows = deferred.map((parameter) => {
      const definition = secure[parameter.name];
      const status = !definition
        ? 'incompatible'
        : definition.secure
          ? 'secure'
          : parameter.status;
      return h(
        'div',
        { class: `compare-row compare-${status}` },
        h('span', { class: 'compare-spacer', 'aria-hidden': 'true' }),
        h('code', {}, parameter.name),
        h('span', { class: `chip chip-${status === 'identical' ? 'neutral' : 'warning'}` }, status.replace(/-/g, ' '))
      );
    });
    results.replaceChildren(
      h(
        'div',
        { class: 'compare-toolbar' },
        h(
          'label',
          { for: 'compare-select-all' },
          selectAll,
          h('span', {}, 'Select all copyable differences')
        ),
        selectedCount
      ),
      differences.length
        ? h(
            'section',
            { class: 'compare-differences', 'aria-label': 'Copyable differences' },
            differenceRows
          )
        : h('p', { class: 'empty-state' }, 'No compatible non-secret differences are available to copy.'),
      deferredRows.length
        ? h(
            'details',
            { class: 'compare-deferred' },
            h('summary', {}, `Identical, secure, incompatible, or missing (${deferredRows.length})`),
            h('div', {}, deferredRows)
          )
        : null
    );
    updateSelected();
  };
  select.addEventListener('change', load);
  const body = h(
    'div',
    { class: 'compare-view' },
    h('p', { class: 'hint' }, 'Compare by parameter contract. Folder names are never used for matching. Secure values are not copied.'),
    h('label', { class: 'dialog-field', for: 'compare-environment' }, h('span', {}, 'Target environment'), select),
    contextSlot,
    results
  );
  showModal('Compare environments', body, [
    h('button', { class: 'btn', onclick: closeModal }, 'Close'),
    reviewButton,
  ]);
  await load();
}

/**
 * Ask which source a new environment comes from.
 *
 * A new local project can start from a source snapshot or existing files.
 */
async function chooseSourceKind({ title, message }) {
  const kind = await choiceDialog({
    title,
    message,
    choices: [
      { value: 'local-source', label: 'Create local from Citadel source', primary: true },
      { value: 'local', label: 'Attach existing local folder' },
      { value: 'github', label: 'GitHub repository' },
      { value: null, label: 'Cancel' },
    ],
  });
  return kind || null;
}

/**
 * Create a project whose first environment is a GitHub repository, using the
 * same repository and branch picker the settings panel uses.
 *
 * Attaching creates a branch on GitHub and writes registry records, so it has to
 * reach a terminal state before the dialog can answer. Cancel, the backdrop and
 * Escape are all refused while it is in flight: resolving `false` mid-attach
 * would tell the caller nothing was created while the attachment carried on and
 * created it.
 */
function attachGitHubProject({ projectLabel, environmentLabel }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let attaching = false;
    const notice = h('p', { class: 'operation-status' });
    const cancelButton = h('button', { class: 'btn', type: 'button' }, 'Cancel');

    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      dismissDialog(value);
      if (error) reject(error);
      else resolve(value);
    };
    // The single guard: while an attachment is in flight the dialog refuses to
    // be dismissed, and says why. `false` therefore always means "nothing was
    // created".
    const refuseWhileAttaching = () => {
      if (!attaching) return false;
      notice.className = 'operation-status';
      notice.textContent =
        'Attaching this repository. This cannot be cancelled until it finishes or rolls back.';
      return true;
    };
    cancelButton.addEventListener('click', () => {
      if (refuseWhileAttaching()) return;
      finish(false);
    });

    const panel = createGitHubPanel({
      onMessage: (text) => {
        if (attaching) return;
        notice.className = 'operation-status';
        notice.textContent = text;
      },
      onAttach: async (selection) => {
        attaching = true;
        cancelButton.disabled = true;
        try {
          await attachGitHubEnvironment({
            projectLabel,
            environmentLabel: environmentLabel || selection.repository.name,
            repositoryId: selection.repositoryId,
            sourceBranch: selection.sourceBranch,
            writeMode: selection.writeMode,
            activate: true,
          });
          attaching = false;
          finish(true);
        } catch (error) {
          // Terminal: the attachment rolled itself back, so the picker reopens
          // for a different repository or branch.
          attaching = false;
          cancelButton.disabled = false;
          notice.className = 'operation-status operation-error';
          notice.textContent = error.message;
          throw error;
        }
      },
    });

    showDialog(
      `Repository for ${projectLabel}`,
      h('div', { class: 'setup-source-panel' }, notice, panel.root),
      [cancelButton],
      // A dismissal while attaching is refused rather than answered, so `false`
      // always means "nothing was created".
      { stack: true, onDismiss: () => finish(false), preventDismiss: refuseWhileAttaching }
    );
    panel.restore().catch(() => {});
  });
}

async function openWorkspaceSettingsContent() {
  const context = activeWorkspace();
  const projects = await workspaceRegistry.listProjects();
  const project = projects.find((item) => item.id === context.projectId);
  const environments = await workspaceRegistry.listEnvironments(context.projectId);
  const draftCounts = new Map(
    await Promise.all(
      environments.map(async (environment) => [
        environment.id,
        await workspaceRegistry.countDrafts(environment.id),
      ])
    )
  );
  const settingsNotice = h('p', {
    class: 'operation-status',
    role: 'status',
    'aria-live': 'polite',
  });
  const environmentOperation = createEnvironmentOperation({
    setInlineStatus(message, tone) {
      settingsNotice.className = `operation-status operation-${tone}`;
      settingsNotice.textContent = message;
    },
    setGlobalStatus: setStatus,
  });
  const list = h('div', { class: 'environment-list' });
  const addDraftScope = `environment-${context.projectId}`;
  const addDraft = workspaceRegistry.profileDraft(addDraftScope) || {};
  const refresh = async () => {
    closeModal();
    await openWorkspaceSettings();
  };
  for (const environment of environments) {
    const current = environment.id === context.environment.id;
    const rowStatus = h('p', {
      class: 'operation-status',
      role: 'status',
      'aria-live': 'polite',
    });
    let row = null;
    const disabledState = new Map();
    const rowOperation = createEnvironmentOperation({
      setInlineStatus(message, tone) {
        rowStatus.className = `operation-status operation-${tone}`;
        rowStatus.textContent = message;
      },
      setGlobalStatus: setStatus,
      setBusy(busy) {
        row?.classList.toggle('is-busy', busy);
        for (const button of row?.querySelectorAll('button') || []) {
          if (busy) {
            disabledState.set(button, button.disabled);
            button.disabled = true;
          } else {
            button.disabled = disabledState.get(button) || false;
          }
        }
        if (!busy) disabledState.clear();
      },
    });
    row = h(
        'section',
        {
          class: `environment-card${current ? ' is-active' : ''}`,
          'aria-label': `${environment.label} environment`,
        },
        h(
          'div',
          { class: 'environment-summary' },
          h('strong', {}, environment.label),
          h(
            'button',
            {
              class: 'environment-path',
              type: 'button',
              title: environmentLocation(environment),
              'aria-label': `Copy source location for ${environment.label}: ${environmentLocation(environment)}`,
              onclick: () =>
                navigator.clipboard
                  .writeText(
                    environmentLocation(environment) === 'Local path not recorded'
                      ? ''
                      : environmentLocation(environment)
                  )
                  .then(() => {
                    rowStatus.className = 'operation-status operation-success';
                    rowStatus.textContent = 'Source location copied.';
                  })
                  .catch(() => {
                    rowStatus.className = 'operation-status operation-error';
                    rowStatus.textContent = 'Source location could not be copied. Select and copy it from the technical details.';
                  }),
            },
            h('code', {}, environmentLocation(environment))
          ),
          h(
            'span',
            { class: `chip chip-${environment.permission === 'granted' ? 'success' : 'warning'}` },
            environment.permission === 'granted' ? 'Access granted' : 'Reconnect required'
          ),
          h(
            'small',
            {},
            `${String(environment.compatibility || 'unavailable').replace(/-/g, ' ')} \u00b7 ${draftCounts.get(environment.id)} drafts`
          )
        ),
        h(
          'div',
          { class: 'environment-actions' },
          h('button', { class: 'btn btn-sm', disabled: current, onclick: () => switchEnvironment(environment) }, current ? 'Active' : 'Switch'),
          h('button', {
            class: 'btn btn-sm',
            onclick: rowOperation('Renaming environment\u2026', async (onRollback) => {
              const values = await promptDialog({
                title: 'Rename environment',
                fields: [{ name: 'label', label: 'Environment label', value: environment.label }],
                submitLabel: 'Rename',
                context: writeContextNode({ file: 'Environment profile' }),
              });
              const label = values?.label.trim();
              if (!label) return false;
              const snapshot = await workspaceRegistry.environmentSnapshot(environment.id);
              onRollback(() => workspaceRegistry.restoreEnvironmentSnapshot(snapshot));
              const updated = await workspaceRegistry.updateEnvironment(environment.id, { label });
              if (current) activeWorkspace().environment = updated;
              await syncRegistryMetadata();
              await refresh();
            }),
          }, 'Rename'),
          isGitHubEnvironment(environment)
            ? h(
                'a',
                {
                  class: 'btn btn-sm',
                  // A plain link: the browser opens GitHub directly and Citadel
                  // UI performs no outbound request for the pull request view.
                  href: pullRequestUrl(environment),
                  target: '_blank',
                  rel: 'noreferrer noopener',
                },
                'Open pull request'
              )
            : null,
          h('button', {
            class: 'btn btn-sm',
            hidden: isGitHubEnvironment(environment),
            onclick: rowOperation('Reconnecting environment\u2026', async (onRollback) => {
              const handle = await showDirectoryPicker({ mode: 'readwrite' });
              const values = await promptDialog({
                title: 'Reconnect environment',
                description: 'The Local path is display-only. The selected folder handle remains the file authority.',
                fields: [{
                  name: 'localPath',
                  label: 'Local path',
                  value: environment.localPath || '',
                  placeholder: 'C:\\source\\citadel or /home/user/citadel',
                }],
                submitLabel: 'Continue',
                context: writeContextNode({ file: 'Environment profile' }),
              });
              if (!values) return false;
              const localPath = validateLocalPath(values.localPath);
              if (
                !localPathMatchesHandle(localPath, handle.name) &&
                !(await confirmDialog({
                  title: 'Local path differs from folder',
                  message: `The Local path leaf does not match the selected folder "${handle.name}". The browser cannot verify this display-only path.`,
                  confirmLabel: 'Use this folder',
                  context: writeContextNode({ file: 'Environment profile' }),
                }))
              ) return false;
              const provider = new BrowserDirectoryProvider(handle);
              await provider.assertWritable({ request: true });
              const scan = await scanProvider(provider);
              assertSupportedScan(scan);
              const pendingChoice = current
                ? await choosePendingNavigation({
                    allowPreserve: false,
                    destination: `reconnecting ${environment.label} to another folder`,
                  })
                : 'continue';
              if (!pendingChoice || pendingChoice === 'stay') return false;
              const snapshot = current
                ? await workspaceRegistry.projectSnapshot(environment.projectId)
                : await workspaceRegistry.environmentSnapshot(environment.id);
              const uiPending = current ? captureContractEdits(state) : null;
              const storedPending = current
                ? new Map(
                    [...pendingByDocument].map(([key, value]) => [
                      key,
                      structuredClone(value),
                    ])
                  )
                : null;
              onRollback(async () => {
                if (current) {
                  await workspaceRegistry.restoreProjectSnapshot(snapshot);
                  pendingByDocument.clear();
                  for (const [key, value] of storedPending) {
                    pendingByDocument.set(key, value);
                  }
                  restoreContractEdits(state, uiPending);
                  render();
                } else {
                  await workspaceRegistry.restoreEnvironmentSnapshot(snapshot);
                }
              });
              if (current && pendingChoice === 'discard') await discardAllPending();
              await workspaceRegistry.reconnectEnvironment(environment.id, handle, localPath);
              const updated = await workspaceRegistry.updateEnvironment(environment.id, {
                permission: 'granted',
                compatibility: scan.compatibility,
                fingerprint: scan.fingerprint,
                localPath,
                lastScannedAt: scan.lastScannedAt,
              });
              if (current) {
                await commitActiveWorkspaceReconnect(
                  activeWorkspace(),
                  {
                    projectId: environment.projectId,
                    environment: updated,
                    handle,
                    provider,
                  },
                  () => syncRegistryMetadata()
                );
                workspaceRegistry.setActive(environment.projectId, environment.id);
                api.resetWorkspace();
                location.reload();
                return;
              }
              await syncRegistryMetadata();
              await refresh();
            }),
          }, environment.permission === 'granted' ? 'Reconnect' : 'Reconnect & grant access'),
          h('button', {
            class: 'btn btn-sm',
            onclick: rowOperation('Verifying access and compatibility\u2026', async (onRollback) => {
              const provider = await createProvider(environment, {
                getHandle: (id) => workspaceRegistry.getHandle(id),
              });
              await provider.assertWritable({ request: true });
              const scan = await scanProvider(provider);
              assertSupportedScan(scan);
              const snapshot = await workspaceRegistry.environmentSnapshot(environment.id);
              onRollback(() => workspaceRegistry.restoreEnvironmentSnapshot(snapshot));
              await workspaceRegistry.updateEnvironment(environment.id, {
                permission: 'granted',
                compatibility: scan.compatibility,
                fingerprint: scan.fingerprint,
                lastScannedAt: scan.lastScannedAt,
              });
              await syncRegistryMetadata();
              await refresh();
            }),
          }, 'Verify access'),
          h('button', {
            class: 'btn btn-sm btn-danger-ghost',
            disabled: current,
            onclick: rowOperation('Removing environment\u2026', async (onRollback) => {
              if (
                !(await confirmDialog({
                  title: 'Remove environment profile?',
                  message: `Remove the ${environment.label} profile? Repository files and history are not deleted.`,
                  confirmLabel: 'Remove profile',
                  tone: 'danger',
                  context: writeContextNode({ file: 'Environment profile' }),
                }))
              ) return false;
              const snapshot = await workspaceRegistry.environmentSnapshot(environment.id);
              onRollback(() => workspaceRegistry.restoreEnvironmentSnapshot(snapshot));
              await workspaceRegistry.removeEnvironment(environment.id);
              await syncRegistryMetadata({ removedEnvironmentIds: [environment.id] });
              await refresh();
            }),
          }, 'Remove profile')
        ),
        rowStatus
      );
    list.append(row);
  }
  const addLabel = h('input', {
    id: 'new-environment-label',
    name: 'newEnvironmentLabel',
    class: 'ctl',
    value: addDraft.environmentLabel || '',
    placeholder: 'Environment label',
    'aria-label': 'New environment label',
  });
  const addLocalPath = h('input', {
    id: 'new-environment-path',
    name: 'newEnvironmentPath',
    class: 'ctl',
    value: addDraft.localPath || '',
    placeholder: 'C:\\source\\citadel or /home/user/citadel',
    'aria-label': 'New environment Local path',
  });
  const persistAddDraft = () => {
    try {
      workspaceRegistry.saveProfileDraft(addDraftScope, {
        environmentLabel: addLabel.value,
        localPath: addLocalPath.value,
      });
      return true;
    } catch (error) {
      settingsNotice.className = 'operation-status operation-error';
      settingsNotice.textContent = `Environment fields could not be retained for reload: ${error.message}`;
      return false;
    }
  };
  addLabel.addEventListener('input', persistAddDraft);
  addLocalPath.addEventListener('input', persistAddDraft);
  const add = h('button', {
    class: 'btn btn-primary',
    onclick: environmentOperation('Adding environment\u2026', async () => {
      persistAddDraft();
      const label = addLabel.value.trim();
      if (!label) return;
      const localPath = validateLocalPath(addLocalPath.value);
      const handle = await showDirectoryPicker({ mode: 'readwrite' });
      if (
        !localPathMatchesHandle(localPath, handle.name) &&
        !(await confirmDialog({
          title: 'Local path differs from folder',
          message: `The Local path leaf does not match the selected folder "${handle.name}". The browser cannot verify this display-only path.`,
          confirmLabel: 'Use this folder',
          context: writeContextNode({ file: 'New environment profile' }),
        }))
      ) return;
      const provider = new BrowserDirectoryProvider(handle);
      await provider.assertWritable({ request: true });
      const scan = await scanProvider(provider);
      assertSupportedScan(scan);
      const duplicate = await workspaceRegistry.findSameHandle(handle);
      const allowDuplicate = duplicate
        ? await confirmDialog({
            title: 'Attach folder again?',
            message: `This folder is already attached as ${duplicate.label}. Attach it again as a separate logical context?`,
            confirmLabel: 'Attach separately',
            context: writeContextNode({ file: 'New environment profile' }),
          })
        : false;
      if (duplicate && !allowDuplicate) return;
      await attachEnvironment({
        project,
        environmentLabel: label,
        localPath,
        handle,
        provider,
        scan,
        allowDuplicate,
        activate: false,
      });
      if (!workspaceRegistry.clearProfileDraft(addDraftScope)) {
        setStatus('Environment saved, but its pending form cache could not be cleared.', 'error');
      }
      await refresh();
    }),
  }, 'Add environment');

  // GitHub source choice for an active workspace. Without this a local user can
  // never add a GitHub environment, and a GitHub user can never attach a second
  // repository, which is what makes GitHub-to-GitHub compare and copy reachable.
  const { root: addForm, chooseSource } = createEnvironmentForm({
    labelInput: addLabel,
    pathInput: addLocalPath,
    addButton: add,
    createGitHubPanel: () => {
      const githubPanel = createGitHubPanel({
        onMessage: (text) => {
          settingsNotice.className = 'operation-status';
          settingsNotice.textContent = text;
        },
        onAttach: environmentOperation('Attaching GitHub repository\u2026', async (selection) => {
          const label = addLabel.value.trim() || selection.repository.name;
          await attachGitHubEnvironment({
            project,
            environmentLabel: label,
            repositoryId: selection.repositoryId,
            sourceBranch: selection.sourceBranch,
            writeMode: selection.writeMode,
            activate: false,
          });
          workspaceRegistry.clearProfileDraft(addDraftScope);
          await refresh();
        }),
      });
      // Delegated to the shared manager, so a session another panel already
      // restored is adopted here rather than fetched again.
      githubPanel.restore().catch(() => {});
      return githubPanel.root;
    },
  });

  /**
   * GitHub connection state, reachable while a workspace is active.
   *
   * Disconnect must not be available only on the landing page: a user with an
   * attached environment still needs to end the credential session, and a
   * failed disconnect must be visible rather than silently assumed.
   */
  const githubConnection = h('div');
  const renderGitHubConnection = async () => {
    // Profile-backed accounts do not carry the legacy status route's
    // `connected` flag. A restored account is the manager's connection contract.
    const account = await githubSessions.restore();
    githubConnection.replaceChildren(
      createGitHubConnectionSummary(account, {
        connect: () => chooseSource('github'),
        disconnect: environmentOperation('Disconnecting GitHub\u2026', async () => {
              // Through the shared manager, so a connect still in flight is
              // superseded and revokes itself rather than quietly becoming the
              // active credential after the user signed out.
              const result = await githubSessions.disconnect();
              settingsNotice.className = 'operation-status operation-success';
              settingsNotice.textContent = result.alreadyAbsent
                ? 'That GitHub session had already expired.'
                : 'Disconnected from GitHub. The token was erased from server memory.';
              await renderGitHubConnection();
            }),
      })
    );
  };
  await renderGitHubConnection();
  const projectActions = h(
        'div',
        { class: 'project-actions' },
        h('button', {
          class: 'btn btn-sm',
          onclick: environmentOperation('Renaming project\u2026', async () => {
            const values = await promptDialog({
              title: 'Rename project',
              fields: [{ name: 'label', label: 'Project label', value: project?.label || '' }],
              submitLabel: 'Rename',
              context: writeContextNode({ file: 'Project profile' }),
            });
            const label = values?.label.trim();
            if (!label) return false;
            await workspaceRegistry.renameProject(context.projectId, label);
            state.projectLabel = label;
            await syncRegistryMetadata();
            await refresh();
          }),
        }, 'Rename project'),
        h('button', {
          class: 'btn btn-sm',
          onclick: environmentOperation('Creating project\u2026', async () => {
            const draftScope = 'new-project';
            const draft = workspaceRegistry.profileDraft(draftScope) || {};
            const kind = await chooseSourceKind({
              title: 'New project source',
              message:
                'Start a new local project from the public Citadel source, attach an existing local folder, or choose a GitHub repository. Local options do not need a GitHub token.',
            });
            if (!kind) return false;
            if (kind === 'local-source') {
              if (!(await confirmPendingNavigation({
                destination: 'opening the new local project', leavesPage: true,
              }))) return false;
              const imported = await openLocalSourceImport({
                stack: true,
                projectLabel: draft.projectLabel || '',
                environmentLabel: draft.environmentLabel || 'Development',
                localPath: draft.localPath || '',
                folderName: draft.folderName || '',
                environmentFieldLabel: 'First environment label',
                scan: scanProvider,
                attach: attachLocalSourceEnvironment,
                onDraft: ({ projectLabel, environmentLabel, localPath, folderName }) =>
                  workspaceRegistry.saveProfileDraft(draftScope, { projectLabel, environmentLabel, localPath, folderName }),
              });
              if (!imported) return false;
              if (!workspaceRegistry.clearProfileDraft(draftScope)) {
                setStatus('Project saved, but its pending form cache could not be cleared.', 'error');
              }
              location.reload();
              return;
            }
            const fields = [
              { name: 'label', label: 'Project label', value: draft.projectLabel || '' },
              {
                name: 'environmentLabel',
                label: 'First environment label',
                value: draft.environmentLabel || 'Development',
              },
            ];
            if (kind === 'local') {
              fields.push({
                name: 'localPath',
                label: 'Local path',
                value: draft.localPath || '',
                placeholder: 'C:\\source\\citadel or /home/user/citadel',
                hint: 'Display only; the browser folder handle remains authoritative.',
              });
            }
            const values = await promptDialog({
              title: 'New project',
              description:
                kind === 'local'
                  ? 'Create the project and its first environment, then choose the exact Citadel repository folder.'
                  : 'Create the project and its first environment, then choose the repository and branch.',
              fields,
              submitLabel: kind === 'local' ? 'Choose folder' : 'Choose repository',
              context: kind === 'local'
                ? h('p', { class: 'hint' }, 'New local project. Only the folder you choose will be attached; the current workspace and GitHub repository are not changed.')
                : writeContextNode({ file: 'New project profile' }),
            });
            if (!values) return false;
            const label = values.label.trim();
            const environmentLabel = values.environmentLabel.trim();
            if (!label || !environmentLabel) return;
            workspaceRegistry.saveProfileDraft(draftScope, {
              projectLabel: values.label,
              environmentLabel: values.environmentLabel,
              localPath: values.localPath || '',
            });
            if (kind === 'github') {
              const attached = await attachGitHubProject({ projectLabel: label, environmentLabel });
              if (!attached) return false;
              if (!workspaceRegistry.clearProfileDraft(draftScope)) {
                setStatus('Project saved, but its pending form cache could not be cleared.', 'error');
              }
              location.reload();
              return;
            }
            const localPath = validateLocalPath(values.localPath);
            const handle = await showDirectoryPicker({ mode: 'readwrite' });
            if (
              !localPathMatchesHandle(localPath, handle.name) &&
              !(await confirmDialog({
                title: 'Local path differs from folder',
                message: `The Local path leaf does not match the selected folder "${handle.name}". The browser cannot verify this display-only path.`,
                confirmLabel: 'Use this folder',
                context: h('p', { class: 'hint' }, `New local project: ${label} / ${environmentLabel}. Selected folder: ${handle.name}.`),
              }))
            ) return false;
            const provider = new BrowserDirectoryProvider(handle);
            await provider.assertWritable({ request: true });
            const scan = await scanProvider(provider);
            assertSupportedScan(scan);
            await attachEnvironment({
              projectLabel: label,
              environmentLabel,
              localPath,
              handle,
              provider,
              scan,
            });
            if (!workspaceRegistry.clearProfileDraft(draftScope)) {
              setStatus('Project saved, but its pending form cache could not be cleared.', 'error');
            }
            location.reload();
          }),
        }, 'New project'),
        h('button', {
          class: 'btn btn-sm btn-danger-ghost',
          disabled: projects.length === 1,
          onclick: environmentOperation('Removing project\u2026', async (onRollback) => {
            if (
              !(await confirmDialog({
                title: 'Remove project profile?',
                message: `Remove project ${project?.label}? Repository files and durable history are not deleted.`,
                confirmLabel: 'Remove project',
                tone: 'danger',
                context: writeContextNode({ file: 'Project profile' }),
              }))
            ) return false;
            const pendingChoice = await choosePendingNavigation({
              allowPreserve: false,
              destination: `removing project ${project?.label}`,
            });
            if (!pendingChoice || pendingChoice === 'stay') return false;
            const snapshot = await workspaceRegistry.projectSnapshot(context.projectId);
            const uiPending = captureContractEdits(state);
            const storedPending = new Map(
              [...pendingByDocument].map(([key, value]) => [
                key,
                structuredClone(value),
              ])
            );
            onRollback(async () => {
              await workspaceRegistry.restoreProjectSnapshot(snapshot);
              pendingByDocument.clear();
              for (const [key, value] of storedPending) {
                pendingByDocument.set(key, value);
              }
              restoreContractEdits(state, uiPending);
              render();
            });
            if (pendingChoice === 'discard') await discardAllPending();
            await workspaceRegistry.removeProject(context.projectId);
            await syncRegistryMetadata({ removedProjectIds: [context.projectId] });
            const fallback = projects.find((item) => item.id !== context.projectId);
            const fallbackEnvironments = fallback ? await workspaceRegistry.listEnvironments(fallback.id) : [];
            if (fallback && fallbackEnvironments[0]) {
              workspaceRegistry.setActive(fallback.id, fallbackEnvironments[0].id);
            }
            location.reload();
          }),
        }, 'Remove project')
  );
  showModal(
    'Projects and environments',
    createWorkspaceSettingsView({
      projectLabel: project?.label || 'Project',
      projectActions,
      notice: settingsNotice,
      connection: githubConnection,
      environments: list,
      environmentCount: environments.length,
      addForm,
      tools: [
        h('button', { class: 'btn', onclick: () => openEnvironmentCompare(environments) }, 'Compare & copy'),
        h('button', { class: 'btn', onclick: openHistory }, 'History'),
      ],
    }),
    [h('button', { class: 'btn', onclick: closeModal }, 'Close')]
  );
}

async function openWorkspaceSettings() {
  await withStatus('Loading settings\u2026', openWorkspaceSettingsContent);
}

async function openParameterMigration() {
  // Migration is separate from editor drafts. Do not discard or silently stash
  // either tab's edits just because the operator opened a wizard.
  if (pendingCount()) {
    setStatus('Save or discard existing editor changes before opening Migrate Citadel Configuration (Experimental). Your edits have been kept.', 'error');
    return;
  }
  const context = activeWorkspace();
  await openMigrationWizard({
    surface: {
      shell: els.shell, workspace: els.workspace, areas: els.sidebar, actions: els.tbActions,
      rail: els.contextRail, breadcrumb: els.repoPath,
    },
    onExit: () => render(),
    session: api.createMigrationSession({
      projectLabel: state.projectLabel,
      pendingEdits: () => pendingCount() > 0,
    }),
    onApplied: async (result) => {
      // A late completion belongs to its captured workspace, never to whichever
      // workspace happens to be active now. Do not refresh over new editor work.
      let current;
      try { current = activeWorkspace(); } catch { return; }
      if (current !== context || pendingCount()) return;
      api.resetWorkspace();
      if (state.current?.path === result.target) {
        const stillCurrent = () => {
          try {
            return activeWorkspace() === context && !pendingCount() && state.current?.path === result.target;
          } catch { return false; }
        };
        const document = await api.deployment(result.target);
        if (!stillCurrent()) return;
        const draft = await workspaceRegistry.getDraft(context.environment.id, result.target);
        if (draft || !stillCurrent()) return;
        // Refresh only this loaded document; do not clear any pending map,
        // restore/delete drafts, reset the policy tab, or replace another view.
        state.current = document;
        state.baselineValidation = validateDocument(document);
        if (state.contract?.param?.path === result.target) {
          state.contract = { ...state.contract, param: document };
        }
        render();
      }
      setStatus('Reviewed local migration applied. Previous destination bytes are available in Settings > History.', 'ok');
    },
  });
}

/**
 * Global actions.
 *
 * These sit in the title block, outside every scroll container, because unsaved
 * work is the state a control plane must never let out of sight. The count is
 * always present -- "no pending changes" is information, not the absence of it,
 * and a control that only appears when it matters teaches nobody where it is.
 */
function renderActions() {
  let workspace = null;
  try { workspace = activeWorkspace(); } catch { /* Preserve setup/catalog flow. */ }
  const migration = workspace
    ? h('button', {
      class: 'btn btn-ghost', type: 'button',
      onclick: guardedHandler(openParameterMigration, { key: 'open-parameter-migration' }),
    }, 'Migrate Citadel Configuration (Experimental)')
    : null;
  if (!state.current) {
    mount(
      els.tbActions,
      h(
        'div',
        { class: 'tb-command-set' },
        migration,
        h('button', { class: 'btn', onclick: openWorkspaceSettings }, 'Settings')
      )
    );
    return;
  }
  const pending = pendingCount();
  const policyTab = state.tab === 'policy';

  // Pending work is counted globally because unsaved edits must never be
  // hidden, but each tab can only save its own file. When the two disagree the
  // button says where the work actually is and goes there, rather than sitting
  // inert next to a count that claims there is something to save.
  const savableHere = policyTab ? hasPolicyEdits() : state.operations.length > 0;
  const validation = policyTab ? [] : currentValidation();
  const blocking = validation.filter((finding) => finding.severity === 'error');
  const warnings = validation.filter((finding) => finding.severity === 'warning');
  const elsewhere = pending > 0 && !savableHere;
  const target = policyTab ? 'params' : 'policy';
  const targetLabel = policyTab ? 'parameters' : 'policy';
  const pendingLabel = pending
    ? `${pending} unsaved ${pending === 1 ? 'change' : 'changes'}`
    : 'no pending changes';
  const validationLabel = blocking.length
    ? `${blocking.length} blocking ${blocking.length === 1 ? 'error' : 'errors'}${
        warnings.length
          ? ` · ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`
          : ''
      }`
    : warnings.length
      ? `${warnings.length} validation ${warnings.length === 1 ? 'warning' : 'warnings'}`
      : '';

  const settings = h(
    'button',
    { class: 'btn btn-ghost', onclick: openWorkspaceSettings },
    'Settings'
  );
  const discard = h(
    'button',
    {
      class: 'btn',
      disabled: !pending,
      onclick: async () => {
        try {
          await discardAllPending();
          render();
        } catch (error) {
          setStatus(error.message, 'error');
        }
      },
    },
    'Discard'
  );
  const primary = elsewhere
    ? h(
        'button',
        {
          class: 'btn',
          title: `The unsaved changes are on the ${targetLabel} tab`,
          onclick: () => {
            state.tab = target;
            render();
          },
        },
        `Review on ${targetLabel}\u2026`
      )
    : policyTab
      ? h(
          'button',
          { class: 'btn btn-primary', disabled: !savableHere, onclick: savePolicy },
          'Review & save policy'
        )
      : h(
          'button',
          {
            class: 'btn btn-primary',
            disabled: !savableHere || blocking.length > 0,
            title: blocking.length ? 'Resolve blocking validation errors before review' : '',
            onclick: openReview,
          },
          'Review & save'
        );

  mount(
    els.tbActions,
    h(
      'div',
      { class: 'tb-status-group' },
      h(
        'span',
        {
          class:
            `tb-pending${pending ? ' is-dirty' : ''}` +
            `${blocking.length ? ' has-errors' : warnings.length ? ' has-warnings' : ''}`,
        },
        validationLabel ? `${pendingLabel} · ${validationLabel}` : pendingLabel
      )
    ),
    h('div', { class: 'tb-command-set' }, migration, settings, discard, primary)
  );
}

/**
 * Context the masthead shows while no workspace is active yet.
 *
 * The setup screen used to leave the placeholder crumbs and "Path not recorded"
 * in place, so a user who had connected GitHub and picked a repository still saw
 * nothing about what they had chosen. Setup publishes its state here instead, and
 * an active workspace overrides it.
 */
let setupContext = null;

export function setSetupContext(context) {
  setupContext = context ? { ...context } : null;
  updateHeaderContext();
}

/**
 * The source line beneath the breadcrumb.
 *
 * It earns its row only when it says something the path above does not. On the
 * catalogue both lines degrade to the same connection sentence — the path falls
 * back to "Connected as <account>" and so does the source — so the frame spent a
 * whole row stating one fact twice, beneath a "Repository" label that was not
 * describing a repository. Suppressed, the frame collapses to a single row,
 * which is the density the sheet below is drawn at.
 */
function setSourceLine({ text, label, copyable = false, hint = null }) {
  const value = String(text || '').trim();
  const redundant = !value || value === els.repoPath.textContent;
  // `[hidden]` alone loses to the element's own `display`, so the stylesheet
  // carries a matching rule rather than this reaching in to set display.
  els.localPathCopy.hidden = redundant;
  if (redundant) return;
  if (els.localPathLabel) els.localPathLabel.textContent = label;
  els.localPath.textContent = value;
  els.localPathCopy.title = hint || value;
  els.localPathCopy.setAttribute('aria-label', hint || `Source: ${value}`);
  els.localPathCopy.disabled = !copyable;
}

function updateHeaderContext() {
  let workspace = null;
  try {
    workspace = activeWorkspace();
  } catch {
    // No active workspace: the setup screen's own context is used instead.
  }
  if (!workspace && setupContext) {
    const { projectLabel, environmentLabel, repository, branch, account, sourceKind, location: stated } =
      setupContext;
    els.projectName.textContent = projectLabel || 'Project';
    els.environmentName.textContent = environmentLabel || 'Environment';
    const target = repository ? (branch ? `${repository} @ ${branch}` : repository) : null;
    const detail = stated || target || (account ? `Connected as ${account}` : 'Not attached');
    els.repoPath.textContent = detail;
    els.repoPath.title = detail;
    // In GitHub mode the source is a repository, never a filesystem path, so
    // "Path not recorded" would be both wrong and alarming. The catalogue has no
    // source at all yet and states its own line, because neither a repository
    // nor a local path is the truth on that screen.
    const location =
      stated ||
      (sourceKind === 'github'
        ? target || (account ? `Connected as ${account}` : 'GitHub not connected')
        : 'Local path not recorded');
    setSourceLine({
      text: location,
      label: sourceKind === 'github' ? 'Repository' : 'Folder',
      copyable: false,
    });
    return;
  }
  const environment = workspace?.environment || {};
  const overviewPath =
    state.area === 'access-contracts' && state.contracts
      ? `${state.contracts.root}/${state.contracts.parent}/`
      : null;
  els.projectName.textContent = state.projectLabel || 'Project';
  els.environmentName.textContent = environment.label || 'Environment';
  els.repoPath.textContent = state.current?.path || overviewPath || 'No file selected';
  els.repoPath.title = state.current?.path || overviewPath || 'No file selected';
  const location = environmentLocation(environment);
  const recorded = location !== 'Local path not recorded';
  // A GitHub source is an identifier, not a path the clipboard helps with.
  const isGitHub = isGitHubEnvironment(environment);
  setSourceLine({
    text: location,
    label: isGitHub ? 'Repository' : 'Folder',
    copyable: recorded && !isGitHub,
    hint: recorded ? (isGitHub ? location : `Copy source location: ${location}`) : 'Local path not recorded',
  });
}

/**
 * The sheet's masthead: what this file is, where it lives, and its tabs.
 *
 * Deliberately short -- two rows -- because every pixel it takes is a parameter
 * the user cannot see. Callers place it in `.sheet-sticky` with any section tabs
 * that must remain attached beneath it.
 */
function sheetStrip(title, doc, tabs, extraMeta) {
  const meta = (doc && doc.meta) || {};
  return h(
    'header',
    { class: 'sheet-strip' },
    h(
      'div',
      { class: 'strip-top' },
      h('h2', { class: 'strip-title' }, title),
      doc ? h('code', { class: 'strip-path', title: doc.path }, doc.path) : null,
      h(
        'div',
        { class: 'strip-meta' },
        extraMeta || null,
        doc && doc.schema && doc.schema.available
          ? h('span', { class: 'chip chip-ok' }, 'schema')
          : h('span', { class: 'chip chip-warn' }, 'no schema')
      )
    ),
    tabs ? h('div', { class: 'strip-tabs' }, tabBar(tabs)) : null
  );
}

/**
 * The context rail: contract list and/or section index.
 *
 * Persistent rather than stacked above the content, so a ninety-seven parameter
 * file starts at its first parameter instead of below a wall of links, and so
 * position is still legible after scrolling. The rail collapses out entirely
 * when there is nothing worth pinning -- an empty pane is a worse answer than
 * no pane.
 */
function railDoc() {
  if (state.contract) return viewOf(state.contract.param);
  return viewOf(state.current);
}

/**
 * Where the section index lives.
 *
 * A parameter row costs about 640px: an identifier that does not wrap plus a
 * control at the width its value needs. Two of those side by side is the whole
 * point of the datasheet -- it is what turns twenty-two visible records into
 * forty-four -- and two of those plus the gutter needs about 1310px of sheet.
 * Below roughly 1600px of window, keeping a 214px section rail costs exactly
 * the column it was helping you navigate. So the index moves: same nav, same
 * state, rendered once, as a strip above the sheet instead of a rail beside it.
 */
const SECTIONS_IN_RAIL = window.matchMedia('(min-width: 100rem)');
SECTIONS_IN_RAIL.addEventListener('change', () => render());
COMPACT_NAV.addEventListener('change', () => render());

function renderContextRail() {
  const area = state.areas.find((a) => a.id === state.area) || null;
  const blocks = [];

  if (area && area.kind === 'contracts' && state.contract) {
    blocks.push(h('div', { class: 'rail-block' }, contractList()));
    const policyNav = state.tab === 'policy' ? els.workspace.querySelector('.policy .pnav') : null;
    if (policyNav) {
      policyNav.parentElement.classList.add('policy-nav-external');
      blocks.push(h('div', { class: 'rail-block rail-block-grow rail-policy' }, policyNav));
    }
  }

  const doc = railDoc();
  const sections = (doc && doc.outline && doc.outline.sections) || [];
  if (
    doc &&
    state.tab === 'params' &&
    sections.length >= 3 &&
    (SECTIONS_IN_RAIL.matches || COMPACT_NAV.matches)
  ) {
    const nav = renderOutlineNav(doc, editContext(doc), markCurrentSection);
    if (nav) {
      blocks.push(
        h(
          'div',
          { class: 'rail-block rail-block-grow' },
          h(
            'div',
            { class: 'rail-head' },
            h('span', {}, 'Sections'),
            h('span', { class: 'rail-count' }, `${sections.length}`)
          ),
          nav
        )
      );
    }
  }

  if (!blocks.length) {
    els.shell.dataset.rail = 'off';
    clear(els.contextRail);
    return;
  }

  els.shell.dataset.rail = 'on';
  mount(
    els.contextRail,
    h(
      'details',
      { class: 'context-disclosure', open: !COMPACT_NAV.matches },
      h(
        'summary',
        { class: 'context-disclosure-summary' },
        state.contract ? `Contract: ${state.contract.name}` : 'Page sections'
      ),
      h('div', { class: 'context-disclosure-body' }, blocks)
    )
  );
}

/**
 * Keep the rail's current-section marker honest while the sheet scrolls.
 *
 * A cheap geometric read on scroll beats IntersectionObserver here: sections are
 * collapsible, so the observed set changes constantly and re-registering
 * observers on every toggle costs more than measuring on demand.
 */
function markCurrentSection(requestedId = null) {
  const links = [
    ...els.contextRail.querySelectorAll('.outline-link'),
    ...els.workspace.querySelectorAll('.outline-link'),
  ];
  if (!links.length) return;
  const sticky = els.workspace.querySelector('.sheet-sticky');
  const line =
    (sticky
      ? sticky.getBoundingClientRect().bottom
      : els.workspace.getBoundingClientRect().top + 96) +
    32;
  let current = requestedId
    ? links.find((link) => link.dataset.section === requestedId) || links[0]
    : links[0];
  if (!requestedId) {
    for (const link of links) {
      const sec = document.getElementById(`section-${link.dataset.section}`);
      if (sec && sec.getBoundingClientRect().top <= line) current = link;
    }
  }
  for (const link of links) {
    const selected = link === current;
    link.classList.toggle('current', selected);
    if (selected) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
  const tabList = current.closest('.outline-tabs .outline-list');
  if (tabList) {
    const item = current.getBoundingClientRect();
    const viewport = tabList.getBoundingClientRect();
    const delta = item.left < viewport.left
      ? item.left - viewport.left
      : item.right > viewport.right
        ? item.right - viewport.right
        : 0;
    if (delta) {
      // This runs during vertical scroll. An immediate correction avoids
      // composing a queue of horizontal smooth-scroll animations.
      tabList.scrollBy({ left: delta, behavior: 'auto' });
    }
  }
}

function tabBar(tabs) {
  return h(
    'nav',
    { class: 'tabs' },
    tabs.map(([id, label]) =>
      h(
        'button',
        {
          class: `tab${state.tab === id ? ' active' : ''}`,
          onclick: () => {
            state.tab = id;
            render();
          },
        },
        label
      )
    )
  );
}

function renderWorkspace() {
  const area = state.areas.find((a) => a.id === state.area) || null;
  if (area && area.kind === 'contracts') return renderContractsArea(area);

  const doc = viewOf(state.current);
  if (!doc) {
    mount(
      els.workspace,
      h(
        'div',
        { class: 'welcome' },
        h('h2', {}, 'Bicep parameters, as a control plane'),
        h(
          'p',
          {},
          'Citadel reads the parameter files already in this repository, renders them as forms, and writes your changes back with every comment intact. Nothing leaves this machine and nothing deploys.'
        ),
        h(
          'ul',
          { class: 'welcome-list' },
          h(
            'li',
            {},
            h('strong', {}, 'Main deployment'),
            ' \u2014 the core Azure infrastructure configuration.'
          ),
          h(
            'li',
            {},
            h('strong', {}, 'LLM onboarding'),
            ' \u2014 register providers and models onto the gateway.'
          ),
          h(
            'li',
            {},
            h('strong', {}, 'Access contracts'),
            ' \u2014 per-product parameters and their APIM policy.'
          )
        ),
        h('p', { class: 'hint' }, 'Choose an area in the left rail to begin.')
      )
    );
    return;
  }

  const meta = doc.meta || {};
  const tabs = [
    ['params', `Parameters (${doc.params.length + (doc.subscription ? 1 : 0)})`],
    ['raw', 'Raw file'],
  ].filter(Boolean);

  const body =
    state.tab === 'raw'
      ? h('pre', { class: 'raw' }, doc.text)
      : renderParamDocument(doc, editContext(doc));

  const sectionTabs =
    state.tab === 'params' && !SECTIONS_IN_RAIL.matches && !COMPACT_NAV.matches
      ? renderOutlineNav(doc, editContext(doc), markCurrentSection, 'tabs')
      : null;

  mount(
    els.workspace,
    h(
      'div',
      { class: 'sheetwrap' },
      h(
        'div',
        { class: 'sheet-sticky' },
        sheetStrip(area ? area.title : doc.path, doc, tabs),
        sectionTabs
      ),
      area && area.blurb ? h('p', { class: 'sheet-blurb' }, area.blurb) : null,
      h('div', { class: 'sheet-body' }, body)
    )
  );
}

/**
 * Data recovery, at the size of the stakes.
 *
 * This panel exists because contracts have gone missing from disk and the app
 * keeps a copy of the last save. It is the only screen in the product that can
 * give a user their work back, and it used to be four small buttons and a
 * 12px sentence at 4.17:1 in a 214px rail -- literally the weakest element on
 * screen. It is now the first thing on the sheet, full width, with the ink
 * token that clears AA on the wash and one outlined action per contract.
 */
function recoveryBanner() {
  const data = state.contracts;
  const list = (data && data.recoverable) || [];
  if (!list.length) return null;

  return h(
    'section',
    { class: 'recover', role: 'alert' },
    h(
      'div',
      { class: 'recover-head' },
      h(
        'h2',
        { class: 'recover-title' },
        `${list.length} contract${list.length === 1 ? ' is' : 's are'} missing from disk`
      ),
      h(
        'p',
        { class: 'recover-lede' },
        'A copy of each was kept the last time it was saved. Restoring writes the folder back to ',
        h('code', {}, `${data.root}/${data.parent}/`),
        ' with its parameter file and its policy.'
      )
    ),
    h(
      'ul',
      { class: 'recover-list' },
      list.map((r) => {
        const name = r.id.replace(/^contracts\//, '');
        return h(
          'li',
          { class: 'recover-item' },
          h('span', { class: 'recover-name' }, name),
          h('span', { class: 'recover-when' }, savedWhen(r)),
          h(
            'button',
            { class: 'btn btn-sm btn-recover', onclick: () => restoreContract(r.id) },
            'Restore'
          )
        );
      })
    )
  );
}

/** The snapshot's own timestamp when the server sends one; silence otherwise. */
function savedWhen(entry) {
  const raw = entry.savedAt || entry.mtime || entry.modified || null;
  if (!raw) return 'copy kept at last save';
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return 'copy kept at last save';
  return `saved ${when.toLocaleString()}`;
}

/**
 * The landing view for the contracts area.
 *
 * A list of names in a rail plus an empty pane answered none of the questions
 * an operator actually arrives with -- which contracts exist, what each one
 * allows, whether its policy is its own or the default. The overview states
 * them in one table, and picking a row opens the contract.
 */
function contractsOverview(area) {
  const data = state.contracts || { contracts: [] };
  const rows = data.contracts || [];

  return h(
    'div',
    { class: 'sheetwrap' },
    h(
      'div',
      { class: 'sheet-sticky' },
      h(
        'header',
        { class: 'sheet-strip' },
        h(
          'div',
          { class: 'strip-top' },
          h('h2', { class: 'strip-title' }, area.title),
          h('code', { class: 'strip-path' }, `${data.root}/${data.parent}/`),
          h(
            'div',
            { class: 'strip-meta' },
            h(
              'button',
              { class: 'btn btn-primary btn-sm', onclick: openCreateContract },
              'New contract'
            )
          )
        )
      )
    ),
    area.blurb ? h('p', { class: 'sheet-blurb' }, area.blurb) : null,
    h(
      'div',
      { class: 'sheet-body' },
      recoveryBanner(),
      rows.length
        ? h(
            'div',
            {
              class: 'table-scroller',
              role: 'region',
              'aria-label': 'Access contracts',
              tabindex: '0',
            },
            h(
              'table',
              { class: 'otable' },
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', { class: 'otable-name' }, 'Contract'),
                  h('th', {}, 'Parameters'),
                  h('th', {}, 'Policy'),
                  h('th', {}, 'Folder')
                )
              ),
              h(
                'tbody',
                {},
                rows.map((c) =>
                  h(
                    'tr',
                    {
                      class: `otable-row${c.isTemplate ? ' otable-template' : ''}`,
                      tabindex: '0',
                      role: 'link',
                      onclick: () => selectContract(c.id),
                      onkeydown: (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          selectContract(c.id);
                        }
                      },
                    },
                    h(
                      'td',
                      { class: 'otable-name' },
                      h('span', { class: 'otable-link' }, c.name),
                      c.isTemplate ? h('span', { class: 'chip chip-note' }, 'template') : null
                    ),
                    h('td', { class: 'otable-num' }, String(c.paramCount)),
                    h(
                      'td',
                      {},
                      c.hasPolicy
                        ? h('span', { class: 'chip chip-success' }, 'own policy')
                        : h('span', { class: 'chip chip-neutral' }, 'default')
                    ),
                    h('td', { class: 'otable-path' }, h('code', {}, c.dir))
                  )
                )
              )
            )
          )
        : h('p', { class: 'hint' }, 'No contracts yet. Create one to begin.')
    )
  );
}

function renderContractsArea(area) {
  const contract = state.contract;

  if (!contract) {
    mount(els.workspace, contractsOverview(area));
    return;
  }

  const doc = viewOf(contract.param);
  const tabs = [
    ['params', `Parameters (${doc.params.length})`],
    ['policy', contract.policy ? 'Policy' : 'Policy (default)'],
    ['raw', 'Raw file'],
  ];

  const body =
    state.tab === 'policy'
      ? decoratePolicy(
          renderPolicy(
            state.policyRaw !== null
              ? { ...contract.policy, text: state.policyRaw }
              : state.policyPreview
              ? { ...contract.policy, text: state.policyPreview.text, controls: state.policyPreview.controls }
              : contract.policy,
            policyContext()
          ),
          {
            isOpen: (id, fallback) => (state.open.has(id) ? state.open.get(id) : fallback),
            setOpen: (id, value) => state.open.set(id, value),
          }
        )
      : state.tab === 'raw'
        ? h('pre', { class: 'raw' }, doc.text)
        : renderParamDocument(doc, editContext(doc));

  mount(
    els.workspace,
    h(
      'div',
      { class: 'sheetwrap' },
      h(
        'div',
        { class: 'sheet-sticky' },
        sheetStrip(
          contract.name,
          doc,
          tabs,
          contract.isTemplate ? h('span', { class: 'chip chip-note' }, 'template') : null
        )
      ),
      contract.isTemplate
        ? h(
            'p',
            { class: 'banner banner-warn' },
            'This is the template every new contract is copied from. Editing it changes the starting point for future contracts.'
          )
        : null,
      h('div', { class: 'sheet-body' }, body)
    )
  );
}

/**
 * Repaint the workspace.
 *
 * Refuses to run while the setup screen owns `#workspace`. `render()` is called
 * from breakpoint listeners, so a viewport change used to paint the empty
 * workspace over the catalogue — leaving a screen with no controls and a
 * promise, inside `ensureWorkspace`, that could never resolve. The header is
 * still refreshed, because the setup screen publishes its own context and that
 * remains correct.
 */
function render() {
  if (els.shell.dataset.workspace === 'migration') return;
  if (els.shell.dataset.workspace !== 'active') {
    updateHeaderContext();
    return;
  }
  updateHeaderContext();
  renderSidebar();
  renderActions();
  renderWorkspace();
  renderContextRail();
  markCurrentSection();
}

/* ------------------------------------------------------------------ loading */

async function loadDocument(path) {
  const doc = await withStatus('Loading\u2026', () => api.deployment(path));
  if (!doc) return;
  state.current = doc;
  state.baselineValidation = validateDocument(doc);
  state.operations = await restoreParameterDraft(doc);
  state.policyChanges = {};
  state.policyRaw = null;
  state.policyPreview = null;
  restoreStashedPending();
  state.open = new Map();
  if (state.tab === 'policy') state.tab = 'params';
  render();
}

async function selectArea(id) {
  const area = state.areas.find((a) => a.id === id);
  if (!area) return;
  if (state.area === id) return;
  if (
    !(await confirmPendingNavigation({
      destination: `opening ${area.title}`,
    }))
  ) return;
  state.area = id;
  state.tab = 'params';
  state.contract = null;
  state.contractId = null;
  state.accessTargets = null;

  if (area.kind === 'contracts') {
    state.current = null;
    render();
    const data = await withStatus('Loading contracts\u2026', () => api.contracts());
    if (!data) return;
    state.contracts = data;
    render();
    return;
  }
  await loadDocument(area.path);
}

async function openOther(path) {
  if (state.current?.path === path) return;
  if (
    !(await confirmPendingNavigation({
      destination: `opening ${path}`,
    }))
  ) return;
  state.area = 'other';
  state.contract = null;
  state.tab = 'params';
  await loadDocument(path);
}

let wired = false;

/**
 * Shell-level navigation.
 *
 * The brand is a real `<a href="/">` so it behaves correctly for middle-click,
 * copy-link and no-JS. Left-clicking it, though, must not reload the document:
 * a reload discards every panel subscribed to the shared GitHub credential and,
 * when startup then failed, left the masthead standing over an empty sheet. It
 * is intercepted and turned into an in-app return to setup, with a history entry
 * so Back is meaningful.
 */
function wireShellNavigation() {
  const brand = document.querySelector('.tb-brand');
  brand?.addEventListener('click', async (event) => {
    // Modified clicks belong to the browser, not to us.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // The history entry is pushed only once the user has actually agreed to
    // leave, so a refused navigation changes nothing at all.
    if (!(await returnToSetup())) return;
    if (history.state?.view !== 'setup') {
      history.pushState({ view: 'setup' }, '', '/');
    }
  });

  // Back and Forward must render a valid state rather than leaving whatever the
  // previous view happened to have put in the sheet.
  window.addEventListener('popstate', (event) => {
    const view = event.state?.view;
    if (view === 'setup' || view === undefined) {
      returnToSetup();
    }
  });

  if (!history.state) history.replaceState({ view: 'setup' }, '', location.pathname);
}

async function init() {
  els.shell = document.querySelector('.shell');
  els.sidebar = document.getElementById('sidebar');
  els.contextRail = document.getElementById('context-rail');
  els.tbActions = document.getElementById('tb-actions');
  els.projectName = document.getElementById('project-name');
  els.environmentName = document.getElementById('environment-name');
  els.repoPath = document.getElementById('repo-path');
  els.localPath = document.getElementById('local-path');
  els.localPathLabel = document.getElementById('local-path-label');
  els.localPathCopy = document.getElementById('local-path-copy');
  els.workspace = document.getElementById('workspace');
  els.status = document.getElementById('status');
  els.modal = document.getElementById('modal');
  // `init` runs again when the user returns to setup, so anything bound to a
  // node that outlives a view must be bound exactly once.
  if (!wired) {
    wired = true;
    wireShellNavigation();
    // The setup screen owns what the masthead should say before a workspace
    // exists; the header is owned here.
    observeSetupContext((context) => setSetupContext(context));
    els.localPathCopy.addEventListener('click', async () => {
      const path = activeWorkspace().environment.localPath;
      if (!path) return;
      try {
        await navigator.clipboard.writeText(path);
        setStatus('Full Local path copied.', 'ok');
      } catch {
        setStatus('Local path could not be copied. Select it from Settings instead.', 'error');
      }
    });

    // Position feedback has to survive scrolling, so the rail marker is refreshed
    // from the sheet's own scroll rather than from renders.
    let ticking = false;
    els.workspace.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          markCurrentSection();
        });
      },
      { passive: true }
    );
  }

  try {
    els.shell.dataset.workspace = 'setup';
    // No status yet: `ensureWorkspace` waits for the catalogue, and the catalogue
    // is a screen the user is reading, not a wait. Announcing "Opening workspace"
    // here left a pending toast escalating to "still working" for as long as they
    // browsed — the exact false alarm this feature exists to prevent.
    const workspace = await ensureWorkspace();
    els.shell.dataset.workspace = 'active';
    // From here it really is loading, and every step is a network round trip.
    setStatus('Opening workspace\u2026', 'info', true, true);
    const health = await api.health();
    const projects = await workspaceRegistry.listProjects();
    state.projectLabel =
      projects.find((project) => project.id === workspace.projectId)?.label || 'Project';

    setStatus('Reading Citadel sources\u2026', 'info', true, true);
    const [focus, catalog] = await Promise.all([api.focus(), api.deployments()]);
    state.areas = focus.areas;
    state.catalog = catalog;

    render();
    setStatus('Checking history\u2026', 'info', true, true);
    const history = await api.history();
    // Cleared here rather than at the end, so the recovery notice below is not
    // immediately overwritten by dismissing this one.
    setStatus(null);
    const recovery = (history.transactions || []).filter(
      (transaction) =>
        transaction.recoveryRequired ||
        transaction.status === 'committing' ||
        transaction.status === 'reverting'
    );
    if (recovery.length) {
      setStatus(
        `${recovery.length} transaction${recovery.length === 1 ? '' : 's'} require recovery. Open Settings > History before making another change.`,
        'error',
        true
      );
    }
    if (state.areas.length) {
      await selectArea(state.areas[0].id);
    } else {
      const generic = state.catalog.files.find((file) => !file.parseError);
      if (generic) await openOther(generic.path);
    }

  } catch (err) {
    setStatus(err.message, 'error');
    renderStartupRecovery(err);
  }
}

/**
 * Never leave the sheet empty.
 *
 * Startup can fail for reasons that are entirely ordinary — a GitHub session
 * that did not survive a container restart, a repository that was renamed, a
 * local folder whose handle was not retained, an active environment id that no
 * longer exists. Reporting those only in the status bar left the masthead
 * standing over a blank page with nothing to click, which reads as a crash.
 *
 * This renders the failure where the user is looking, with the actions that
 * actually resolve it. It is a recovery boundary rather than a catch per call
 * site, so a failure nobody anticipated still lands somewhere actionable.
 */
function renderStartupRecovery(error) {
  if (!els.workspace) return;
  const message = String(error?.message || 'Citadel UI could not open the last workspace.');
  const actions = h('div', { class: 'setup-actions' });
  actions.append(
    h(
      'button',
      { class: 'btn btn-primary', type: 'button', onclick: () => returnToSetup() },
      'Return to setup'
    ),
    h(
      'button',
      { class: 'btn', type: 'button', onclick: () => location.reload() },
      'Reload Citadel UI'
    )
  );
  els.workspace.replaceChildren(
    h(
      'section',
      { class: 'workspace-setup', role: 'region', 'aria-label': 'Recovery' },
      h('h1', {}, 'Citadel UI could not open this workspace'),
      h('p', { class: 'field-error', role: 'alert' }, message),
      h(
        'p',
        { class: 'hint' },
        'Your saved projects and environments are unchanged. GitHub credentials are held only in server memory, so a restart requires reconnecting.'
      ),
      actions
    )
  );
  els.shell.dataset.workspace = 'setup';
  els.workspace.focus?.();
}

/**
 * Leave the active workspace and return to a deterministic setup state.
 *
 * In-app rather than a document load: a hard navigation throws away the
 * credential the server still holds and every panel subscribed to it, and it was
 * what left the brand link showing a masthead over an empty sheet.
 */
async function returnToSetup() {
  try {
    // The only navigation entry point that used to be a real document load, and
    // so the only one that relied on `beforeunload` to protect unsaved work.
    // Policy edits live in memory alone, so leaving without asking loses them
    // silently.
    if (!(await confirmPendingNavigation({ destination: 'the setup screen' }))) return false;
    clearActiveWorkspace();
    state.areas = [];
    state.catalog = null;
    state.current = null;
    // `selectArea` early-returns when the requested area is already selected, so
    // a stale `state.area` would make the next environment open to an empty
    // sheet with that area highlighted and unclickable.
    state.area = null;
    state.contractId = null;
    setSetupContext(null);
    els.shell.dataset.workspace = 'setup';
    els.sidebar?.replaceChildren();
    els.contextRail?.replaceChildren();
    updateHeaderContext();
    await init();
    return true;
  } catch (error) {
    renderStartupRecovery(error);
    return true;
  }
}

// Nothing starts until this browser holds a session token, and the only way to
// hold one is to create the owner account or sign in as it.
ensureOwnerSession().then(() => init());
