import { CATALOGUE, acknowledgementFor, buildSamplePlan, fieldByPath } from '../../src/catalogue/index.mjs';
import { probeFromCapabilityPayload } from '../../src/core/capability.mjs';
import { createPlaygroundState } from '../../src/core/state.mjs';
import { createRelayExecutor, createUnavailableExecutor, runPlan } from '../../src/core/executor.mjs';
import { assertNoSecretValues } from '../../src/core/secrets.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../../src/core/types.mjs';
import { isAzureCliContext, sampleExecutionContext } from '../../src/core/executionContext.mjs';
import {
  buildDirectoryModel,
  buildExecutionEnvironmentModel,
} from '../../src/view/models.mjs';
import { createRunProgress, reduceRunProgress } from '../../src/view/runProgress.mjs';
import { buildDossierModel } from '../../src/view/dossierModels.mjs';
import { claimBrowserSession, consumeBootstrapCapability } from './sessionAuth.mjs';
import {
  azureAuthCapabilityFromPayload,
  buildExecutionContextProjection,
  createExecutionContextClient,
  reconcileAzureContextCurrent,
} from './executionContextClient.mjs';
import { createLocalExecutorClient } from './localClient.mjs';
import { createHostedExecutorClient, hostedPost, sessionFetch, setHostedCapabilities } from './hostedClient.mjs';
import { consumeHostedResume, saveHostedResume } from './hostedResume.mjs';
import { renderShell } from './render/shell.mjs';
import {
  captureFocus,
  configureFieldControlId,
  renderConfigure,
  renderSourceInspector,
  restoreFocus,
} from './render/configure.mjs';
import {
  createDestructiveConfirmationController,
  renderOperationDisclosure,
  renderReview,
} from './render/review.mjs';
import { renderOutput } from './render/output.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ACCOUNT_BUSY_STATES = new Set(['starting', 'waiting-system-ui', 'verifying', 'cancel-requested']);
const TEST_SUBSCRIPTION_ID = '00000000-1111-2222-3333-444444444444';
const SERVER_RESOLVED_CREDENTIAL = 'server-resolved-credential';
const WIZARD_STEP_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'account-target', title: 'Account & target' }),
  Object.freeze({ id: 'required-inputs', title: 'Required inputs' }),
  Object.freeze({ id: 'credentials-options', title: 'Credentials & options' }),
  Object.freeze({ id: 'review-approve', title: 'Confirm & run' }),
  Object.freeze({ id: 'run-result', title: 'Run & result' }),
]);
const recipeIds = CATALOGUE.samples.map((sample) => sample.id);
const sampleById = new Map(CATALOGUE.samples.map((sample) => [sample.id, sample]));
const app = document.getElementById('app');
const sourceDialog = document.getElementById('source-inspector');
const provenanceDialog = document.getElementById('provenance-drawer');
const diagnosticsDialog = document.getElementById('diagnostics-drawer');
const destructiveHost = document.getElementById('destructive-dialog-host');
const destructiveController = createDestructiveConfirmationController(destructiveHost);
const executionContextClient = createExecutionContextClient({ fetchImpl: sessionFetch });
const playgroundState = createPlaygroundState({ catalogue: CATALOGUE });

const state = {
  sample: sampleById.get(recipeIds[0]),
  sourceBundle: { status: 'loading' },
  sourceValidation: { status: 'not-run', available: false },
  sourceCellIndex: null,
  wrapSource: false,
  capabilities: null,
  executionContext: null,
  accountUi: null,
  azureSubscriptions: { status: 'idle', subscriptions: [], message: '' },
  selectedSubscriptionId: '',
  selfTests: null,
  progress: null,
  activeRunId: null,
  outputView: 'transcript',
  autoFollow: true,
  directoryOpen: window.innerWidth >= 1200,
  directoryModal: window.innerWidth < 1200,
  directoryQuery: '',
  directoryGroupId: null,
  stage: 'configure',
  wizardStep: 'account-target',
  completedWizardSteps: new Set(),
  completedWizardStepsByRecipe: new Map(),
  cancelling: false,
  testExecutor: null,
  testContext: null,
  sessionClaimError: '',
  lastRevealedRunId: null,
  sourceRequest: 0,
  sourceValidationRequest: 0,
  contextRequest: 0,
  contextFingerprint: null,
  contextRefreshTimer: null,
  destructiveArmed: false,
  runGeneration: 0,
  activeRunToken: null,
  renderPending: false,
  activeEditingPath: null,
  pendingFocusId: '',
  runtimeProbe: { mode: 'preview' },
  executor: createUnavailableExecutor(),
  executorCapability: createUnavailableExecutor().describeCapability(),
};
state.completedWizardStepsByRecipe.set(state.sample.id, state.completedWizardSteps);

let appReady = false;
let dialogReturnFocus = null;
let azureLoginPollTimer = null;
let azureLoginController = null;
let azureLoginGeneration = 0;
let azureLoginCancelRequested = false;
let azureSubscriptionController = null;
let azureSubscriptionGeneration = 0;
let historyNavigationGeneration = 0;

function replace(container, children) {
  container.replaceChildren(...children.filter(Boolean));
}

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name === 'text') element.textContent = value;
    else if (name.startsWith('on') && typeof value === 'function') {
      element.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  const entries = Array.isArray(children) ? children : [children];
  for (const child of entries.filter(Boolean)) {
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function hasActiveTextEntry() {
  const element = document.activeElement;
  if (!state.activeEditingPath || !element || !app?.contains(element)) return false;
  const path = element.closest('[data-parameter-path]')?.dataset.parameterPath;
  if (path !== state.activeEditingPath) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLInputElement
    && !['button', 'checkbox', 'radio', 'range', 'submit'].includes(element.type);
}

function announce(message) {
  const live = document.getElementById('live');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => {
    live.textContent = message;
  });
}

function safeMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

const WIZARD_HISTORY_INDEX_KEY = '__citadelWizardIndex';
let wizardHistoryIndex = Number.isSafeInteger(history.state?.[WIZARD_HISTORY_INDEX_KEY])
  ? history.state[WIZARD_HISTORY_INDEX_KEY]
  : 0;
let restoringWizardHistory = false;

function decodeWizardStep(hash) {
  if (!hash.startsWith('#step=')) return null;
  try {
    return decodeURIComponent(hash.slice('#step='.length));
  } catch {
    return null;
  }
}

function readWizardUrl() {
  const url = new URL(location.href);
  const requestedRecipe = url.searchParams.get('recipe');
  const recipeId = sampleById.has(requestedRecipe) ? requestedRecipe : recipeIds[0];
  const decodedStep = decodeWizardStep(url.hash);
  const requestedStep = decodedStep
    ? decodedStep
    : url.hash === '#stage=review'
      ? 'review-approve'
      : ['#stage=run', '#stage=result'].includes(url.hash)
        ? 'run-result'
        : 'account-target';
  const stepId = WIZARD_STEP_DEFINITIONS.some((step) => step.id === requestedStep)
    ? requestedStep
    : 'account-target';
  const runId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(url.searchParams.get('run') ?? '')
    ? url.searchParams.get('run')
    : null;
  return { recipeId, stepId, runId };
}

function writeWizardUrl({ replaceHistory = false } = {}) {
  const url = new URL(location.href);
  const testExecutor = url.searchParams.has('testExecutor');
  url.search = '';
  url.searchParams.set('recipe', state.sample.id);
  if (testExecutor && isTestExecutorAllowed()) url.searchParams.set('testExecutor', '');
  if (state.activeRunId) url.searchParams.set('run', state.activeRunId);
  url.hash = `step=${encodeURIComponent(state.wizardStep)}`;
  if (!replaceHistory) wizardHistoryIndex += 1;
  history[replaceHistory ? 'replaceState' : 'pushState'](
    { [WIZARD_HISTORY_INDEX_KEY]: wizardHistoryIndex },
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function restoreRejectedHistoryNavigation(event) {
  const targetIndex = Number.isSafeInteger(event.state?.[WIZARD_HISTORY_INDEX_KEY])
    ? event.state[WIZARD_HISTORY_INDEX_KEY]
    : wizardHistoryIndex;
  const delta = wizardHistoryIndex - targetIndex;
  if (delta !== 0 && typeof history.go === 'function') {
    restoringWizardHistory = true;
    history.go(delta);
    return;
  }
  writeWizardUrl({ replaceHistory: true });
}

function applyWizardRun(runId) {
  if (runId === state.activeRunId) return;
  state.activeRunId = runId;
  if (state.progress?.meta?.runId !== runId) {
    state.progress = null;
    state.lastRevealedRunId = null;
    state.completedWizardSteps.delete('run-result');
  }
}

async function selectRecipeFromUi(id) {
  if (!sampleById.has(id) || id === state.sample.id) return false;
  if (state.progress?.state === 'running') {
    announce('Cancel the active run before changing recipes.');
    return false;
  }
  if (state.azureSubscriptions.status === 'activating') {
    announce('Wait for Azure subscription activation to finish before changing recipes.');
    return false;
  }
  if (
    playgroundState.hasUnsavedChanges
    && !window.confirm('Change recipes and discard unsaved input changes? Credentials are never persisted.')
  ) {
    return false;
  }
  const navigationGeneration = ++historyNavigationGeneration;
  await selectSample(id);
  if (navigationGeneration !== historyNavigationGeneration) return false;
  writeWizardUrl();
  return true;
}

function inputFingerprint() {
  return JSON.stringify(playgroundState.toPersistable());
}

function executionContextFingerprint(contextState) {
  const context = contextState?.context ?? null;
  if (!context) return '';
  return JSON.stringify({
    kind: context.kind,
    state: context.state,
    canExecute: context.canExecute,
    signedInAccount: context.signedInAccount ?? null,
    executionCredential: context.executionCredential ?? null,
    activeCliSubscription: context.activeCliSubscription ?? null,
    selectedSubscription: context.selectedSubscription ?? null,
    contextVersion: context.contextVersion ?? null,
    intendedTarget: context.intendedTarget ?? null,
    authorization: context.authorization ?? null,
    authority: context.authority ?? null,
    subscription: context.subscription ?? null,
    gateway: context.gateway ?? null,
    hostedRelay: context.hostedRelay ?? null,
  });
}

function updateContextFingerprint(contextState) {
  const nextFingerprint = executionContextFingerprint(contextState);
  if (state.contextFingerprint && nextFingerprint !== state.contextFingerprint) {
    invalidateApproval({ returnToReview: true });
  }
  state.contextFingerprint = nextFingerprint || null;
}

function invalidateApproval({ returnToReview = false } = {}) {
  playgroundState.setAcknowledged(state.sample.id, false);
  state.completedWizardSteps.delete('review-approve');
  state.completedWizardSteps.delete('run-result');
  state.destructiveArmed = false;
  destructiveController.destroy();
  if (
    returnToReview
    && state.progress?.state !== 'running'
    && ['review-approve', 'run-result'].includes(state.wizardStep)
  ) {
    state.wizardStep = 'review-approve';
    updateDossierStage();
    writeWizardUrl({ replaceHistory: true });
  }
}

function isTestExecutorAllowed() {
  return LOOPBACK_HOSTS.has(location.hostname) && new URLSearchParams(location.search).has('testExecutor');
}

function effectiveContext() {
  return state.testExecutor ? state.testContext : state.executionContext;
}

function effectiveExecutorCapability() {
  return state.testExecutor
    ? state.testExecutor.describeCapability()
    : state.executorCapability;
}

function accountControlState(contextState) {
  const descriptor = sampleExecutionContext(state.sample.id);
  if (!isAzureCliContext(descriptor.kind)) return {};
  const capability = azureAuthCapabilityFromPayload(state.capabilities);
  const context = contextState?.status === 'ready' ? contextState.context : null;
  const signedIn = context?.signedInAccount?.state === 'signed-in' || Boolean(context?.authority?.principalName);
  const principal = signedIn
    ? {
        principalName: context?.signedInAccount?.principalName || context?.authority?.principalName,
        principalType: context?.signedInAccount?.principalType || context?.authority?.principalType || 'user',
        tenantId: context?.signedInAccount?.tenantId || context?.authority?.tenantId,
      }
    : null;
  const accountId = principal
    ? `${principal.principalType}:${principal.tenantId}:${principal.principalName}`
    : '';
  const login = state.accountUi?.login ?? null;
  const loginState = state.accountUi?.state;
  const contextStateName =
    context?.state === 'ready-to-attempt'
      ? 'ready'
      : context?.state === 'subscription-disabled'
        ? 'subscription-disabled'
      : context?.state === 'subscription-mismatch'
        ? 'subscription-mismatch'
        : context?.state === 'signed-out'
          ? 'signed-out'
          : 'status-unknown';
  const controlState = loginState || contextStateName;
  const loginBusy = ACCOUNT_BUSY_STATES.has(controlState);
  const subscriptionsBusy = ['loading', 'activating'].includes(state.azureSubscriptions.status);
  const activeSubscriptionId =
    context?.activeCliSubscription?.id ?? context?.subscription?.activeId ?? '';
  const selectedSubscriptionId =
    state.selectedSubscriptionId ||
    context?.intendedTarget?.subscriptionId ||
    context?.subscription?.configuredId ||
    activeSubscriptionId;
  const subscriptions = state.azureSubscriptions.subscriptions.map((subscription) => ({
    id: subscription.id,
    name: subscription.name,
    tenantId: subscription.tenantId,
    accountId,
    enabled: true,
  }));
  return {
    state: controlState,
    message: state.accountUi?.message || state.azureSubscriptions.message || context?.summary || '',
    systemBrowserAzureLogin: capability.systemLoginAllowed,
    launchMode: capability.systemLoginAllowed ? 'system-browser' : null,
    sessionId: login?.loginId ?? capability.loginId,
    canLaunch:
      capability.systemLoginAllowed &&
      !loginBusy &&
      !subscriptionsBusy &&
      state.progress?.state !== 'running',
    canCancel: loginBusy && Boolean(login?.loginId),
    canVerify: !loginBusy && !subscriptionsBusy,
    canSetActive:
      capability.subscriptionsAvailable &&
      state.azureSubscriptions.status === 'ready' &&
      Boolean(selectedSubscriptionId) &&
      selectedSubscriptionId.toLowerCase() !== activeSubscriptionId.toLowerCase(),
    canSelect: !loginBusy && !subscriptionsBusy,
    subscriptionsBusy,
    activeAccountId: accountId,
    activeSubscriptionId,
    intendedSubscriptionId:
      context?.intendedTarget?.subscriptionId ?? context?.subscription?.configuredId ?? '',
    accounts: principal
      ? [
          {
            id: accountId,
            name: principal.principalName,
            username: principal.principalName,
            tenantId: principal.tenantId,
            enabled: true,
          },
        ]
      : [],
    subscriptions,
  };
}

function currentModels() {
  const context = effectiveContext();
  const capability = effectiveExecutorCapability();
  const runtimeProbe = state.testExecutor
    ? {
        mode: 'execute',
        azureCli: { available: true, version: 'test' },
        python: { available: true, version: 'test', modules: {} },
        accelerator: { available: true, files: 1 },
      }
    : state.runtimeProbe;
  const dossier = buildDossierModel({
    sample: state.sample,
    read: readCurrentValue,
    hasSecret: hasCurrentSecret,
    isTouched: (path) => playgroundState.isTouched(path),
    secrets: playgroundState.secretValues(),
    acknowledged: playgroundState.isAcknowledged(state.sample.id),
    result: state.progress,
    running: state.progress?.state === 'running',
    runId: state.activeRunId,
    capability,
    runtimeProbe,
    sourceState: state.sourceBundle,
    sourceValidationState: state.sourceValidation,
    contextState: context,
    accountControlState: accountControlState(context),
    stage: state.stage,
    selectedSourceCellIndex: state.sourceCellIndex,
  });
  const directory = buildDirectoryModel({
    query: state.directoryQuery,
    selectedSampleId: state.sample.id,
    read: (path) => playgroundState.read(path),
    hasSecret: (path) => playgroundState.hasSecret(path),
    runtimeProbe,
  });
  return {
    capabilities: state.capabilities,
    context,
    guide: dossier.guide,
    configure: dossier.configure,
    environment: buildExecutionEnvironmentModel(capability),
    directory,
    dossier,
  };
}

function activeAccount(accountControl) {
  return accountControl.accounts?.find((account) => account.id === accountControl.activeAccountId) ?? null;
}

function shellIdentity(models) {
  if (state.capabilities?.auth?.mode === 'bff') {
    return { kind: 'hosted-bff', auth: state.capabilities.auth,
      supported: state.capabilities.hosted.supportedSampleIds.includes(state.sample.id),
      management: ['azure-context-check', 'apim-discovery'].includes(state.sample.id),
      subscriptions: state.hostedSubscriptions ?? [], selectedSubscriptionId: state.selectedSubscriptionId,
      busy: state.hostedBusy === true || !appReady, message: state.hostedMessage ?? '' };
  }
  const identity = models.dossier.identity;
  const contextKind = models.context?.context?.kind;
  const expectedKind = sampleExecutionContext(state.sample.id).kind;
  const projectedContext = buildExecutionContextProjection({
    sample: state.sample,
    read: (path) => playgroundState.read(path),
    hasSecret: (path) => playgroundState.hasSecret(path),
  });
  const gatewayRecipe = projectedContext.gateway != null;
  const accountControl = identity.accountControl;
  const account = activeAccount(accountControl);
  const activeSubscription =
    accountControl.subscriptions?.find((subscription) => subscription.id === accountControl.activeSubscriptionId)
    ?? (models.context?.context?.activeCliSubscription
      ? {
          id: models.context.context.activeCliSubscription.id,
          label:
            models.context.context.activeCliSubscription.name ||
            models.context.context.activeCliSubscription.id,
        }
      : null)
    ?? (models.context?.context?.subscription?.activeId
      ? {
          id: models.context.context.subscription.activeId,
          label:
            models.context.context.subscription.activeName ||
            models.context.context.subscription.activeId,
        }
      : null)
    ?? null;
  const isUnclaimed = models.capabilities?.sessionAuth?.state === 'unclaimed';
  const accountState = state.accountUi?.state ?? accountControl.state;
  const accountMessage = state.accountUi?.message ?? accountControl.message;
  const selectedSubscriptionId =
    state.selectedSubscriptionId
    || accountControl.intendedSubscriptionId
    || accountControl.activeSubscriptionId
    || '';
  const base = {
    kind:
      contextKind === 'hosted-relay'
        ? 'hosted-relay'
        : gatewayRecipe || contextKind === 'gateway-key'
          ? 'gateway-key'
          : (isAzureCliContext(contextKind) || isAzureCliContext(expectedKind)) && !isUnclaimed
            ? 'local-operator'
            : contextKind === 'offline-python'
              ? 'offline-python'
              : 'unavailable',
    state: accountState,
    account: account
      ? {
          name: account.name || account.username,
          username: account.username,
          tenant: account.tenantId,
        }
      : null,
    systemBrowser: { available: accountControl.launchMode === 'system-browser' },
    launchCapability: accountControl.launchMode,
    canSignIn: accountControl.canLaunch && !ACCOUNT_BUSY_STATES.has(accountState),
    canVerify: accountControl.canVerify && !ACCOUNT_BUSY_STATES.has(accountState),
    canSetActive: accountControl.canSetActive && !ACCOUNT_BUSY_STATES.has(accountState),
    canCancel: accountControl.canCancel,
    subscriptionBusy: accountControl.subscriptionsBusy,
    canSelectSubscription: accountControl.canSelect,
    subscriptions: accountControl.subscriptions,
    selectedSubscriptionId,
    activeSubscription,
    message: accountMessage,
    statusImportant: state.accountUi != null,
    keyPresent: identity.gateway?.keyPresent ?? projectedContext.gateway?.keyPresent,
    headerName: identity.gateway?.headerName ?? projectedContext.gateway?.headerName,
    canManage: true,
  };
  if (
    !isUnclaimed
    && base.kind === 'local-operator'
    && accountControl.launchMode !== 'system-browser'
  ) {
    base.terminalFallback = {
      available: false,
      message:
        'This private Azure CLI session is not exposed to terminals. Restart with system sign-in enabled to authenticate this launch.',
    };
  }
  return base;
}

function shellExecution(models) {
  const identity = models.dossier.identity;
  const hosted = models.context?.context?.hostedRelay;
  const gateway = wizardIdentityKind() === 'gateway';
  const endpoints = [...new Set((models.dossier.request.plan?.steps ?? [])
    .map((step) => step.request?.url ?? step.assertion?.endpoint)
    .filter((endpoint) => typeof endpoint === 'string' && endpoint.length > 0))];
  const exactTarget = gateway || hosted
    ? endpoints.join('\n') || 'Complete the connection to resolve the exact endpoint.'
    : models.dossier.reviewDecision.target.exact;
  const subscriptionValue = gateway || hosted
    ? 'Not applicable'
    : identity.subscription
      ? [identity.subscription.activeName, identity.subscription.activeId].filter(Boolean).join(' — ')
      : 'Not reported';
  return {
    human: { value: identity.human },
    runsAs: { value: identity.runsAs, credential: identity.credential },
    activeSubscription: {
      value: subscriptionValue,
      detail: hosted
        ? 'Hosted relay gateway runs do not use this browser session`s Azure account or subscription.'
        : gateway
        ? 'Gateway recipes do not use Azure account or subscription controls.'
        : state.capabilities?.auth?.mode === 'bff'
          ? 'Explicitly selected for this delegated-user application session; no CLI context is used.'
        : identity.targetSubscriptionMismatch
          ? 'The private Azure CLI subscription and intended target do not match.'
          : 'Citadel private Azure CLI subscription; the intended target remains separate.',
    },
    target: {
      value: exactTarget,
      detail: 'The exact intended target for this attempt.',
    },
    authorization: {
      readyToAttempt: identity.authorization.ready,
      state: identity.authorization.state,
    },
    hosted: hosted
      ? {
          entraCaller: identity.human,
          playgroundIdentity: 'Hosted playground identity',
          relayIdentity: hosted.relayIdentity,
          keyReference: hosted.keySource,
          target: exactTarget,
        }
      : null,
  };
}

function scrollTargetIntoWorkspace(target, { block = 'nearest' } = {}) {
  const workspace = document.getElementById('run-dossier');
  if (!workspace || !target || !workspace.contains(target)) return false;
  const workspaceRect = workspace.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const style = getComputedStyle(workspace);
  const paddingStart = Number.parseFloat(style.scrollPaddingBlockStart) || 0;
  const paddingEnd = Number.parseFloat(style.scrollPaddingBlockEnd) || 0;
  const visibleStart = workspaceRect.top + paddingStart;
  const visibleEnd = workspaceRect.bottom - paddingEnd;
  let delta = 0;
  if (block === 'start') {
    delta = targetRect.top - visibleStart;
  } else if (block === 'center') {
    delta =
      targetRect.top
      + targetRect.height / 2
      - (visibleStart + Math.max(0, visibleEnd - visibleStart) / 2);
  } else if (targetRect.top < visibleStart) {
    delta = targetRect.top - visibleStart;
  } else if (targetRect.bottom > visibleEnd) {
    delta = targetRect.bottom - visibleEnd;
  }
  if (Math.abs(delta) > 0.5) workspace.scrollTop += delta;
  return true;
}

function focusWorkspaceTarget(target, options) {
  if (!target) return false;
  target.focus({ preventScroll: true });
  return scrollTargetIntoWorkspace(target, options);
}

function focusPath(path) {
  const control = document.getElementById(configureFieldControlId(path));
  if (!control) return false;
  const advanced = control.closest('details');
  if (advanced) advanced.open = true;
  return focusWorkspaceTarget(control, { block: 'center' });
}

function download(name, text, mediaType = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    announce('Copied to the clipboard.');
  } catch (error) {
    announce(safeMessage(error, 'Clipboard access was not available.'));
  }
}

function showDialog(dialog, opener = document.activeElement) {
  dialogReturnFocus = opener?.focus ? opener : null;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => dialog.querySelector('button, [href], input, select, textarea, [tabindex="0"]')?.focus());
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

for (const dialog of [sourceDialog, provenanceDialog, diagnosticsDialog]) {
  dialog.addEventListener('close', () => {
    const target = dialogReturnFocus;
    dialogReturnFocus = null;
    target?.focus?.();
  });
}

function renderSourceDialog() {
  const models = currentModels();
  renderSourceInspector(sourceDialog, models.dossier.source, models.dossier.sourceValidation, {
    selectedCellIndex: state.sourceCellIndex,
    wrapSource: state.wrapSource,
    onSelectCell(index) {
      state.sourceCellIndex = index;
      renderSourceDialog();
    },
    onToggleWrap(next) {
      state.wrapSource = next;
      renderSourceDialog();
    },
    onRetry: loadSource,
    onValidate: validateSource,
    onDownload: download,
    onClose: () => closeDialog(sourceDialog),
  });
}

function openSourceInspector() {
  renderSourceDialog();
  showDialog(sourceDialog);
}

function drawerHeader(title, eyebrow, dialog) {
  return node('header', { class: 'evidence-drawer-header' }, [
    node('div', {}, [
      node('p', { class: 'review-eyebrow', text: eyebrow }),
      node('h2', { text: title }),
    ]),
    node('button', {
      type: 'button',
      class: 'btn btn-sm',
      text: 'Close',
      onclick: () => closeDialog(dialog),
    }),
  ]);
}

function openProvenance() {
  const notebook = CATALOGUE.sourceNotebook;
  const source = state.sourceBundle;
  const guide = currentModels().guide;
  replace(provenanceDialog, [
    drawerHeader('Guide & provenance', 'Recipe evidence', provenanceDialog),
    node('div', { class: 'evidence-drawer-body' }, [
      node('section', { class: 'drawer-guide' }, [
        node('h3', { text: 'Purpose' }),
        node('p', { text: guide.purpose || guide.summary }),
        node('h3', { text: 'Prerequisites' }),
        guide.prerequisites.length
          ? node('ul', {}, guide.prerequisites.map((item) => node('li', { text: item.title })))
          : node('p', { text: 'No recipe-specific prerequisites are declared.' }),
      ]),
      node('dl', { class: 'evidence-facts' }, [
        node('div', {}, [node('dt', { text: 'Notebook' }), node('dd', { text: notebook.fileName })]),
        node('div', {}, [node('dt', { text: 'Notebook cells' }), node('dd', { text: notebook.cellCount })]),
        node('div', {}, [
          node('dt', { text: 'Source state' }),
          node('dd', { text: source.status === 'ready' ? 'Protected source loaded' : source.message || source.status }),
        ]),
        node('div', {}, [
          node('dt', { text: 'Source validation' }),
          node('dd', { text: state.sourceValidation.message || state.sourceValidation.state }),
        ]),
      ]),
      node('details', {}, [
        node('summary', { text: 'Full notebook digest' }),
        node('code', { class: 'drawer-digest', text: notebook.sha256, translate: 'no' }),
      ]),
      node('button', {
        type: 'button',
        class: 'btn',
        text: 'Inspect cited source',
        onclick: () => {
          closeDialog(provenanceDialog);
          openSourceInspector();
        },
      }),
    ]),
  ]);
  showDialog(provenanceDialog);
}

function openDiagnostics() {
  const capabilities = state.capabilities;
  const context = effectiveContext();
  const checks = state.selfTests?.checks ?? [];
  replace(diagnosticsDialog, [
    drawerHeader('Diagnostics', 'Local capability', diagnosticsDialog),
    node('div', { class: 'evidence-drawer-body' }, [
      state.sessionClaimError
        ? node('p', { class: 'drawer-alert', role: 'alert', text: state.sessionClaimError })
        : null,
      node('dl', { class: 'evidence-facts' }, [
        node('div', {}, [
          node('dt', { text: 'Browser session' }),
          node('dd', { text: capabilities?.sessionAuth?.message || 'Not reported' }),
        ]),
        node('div', {}, [
          node('dt', { text: 'Executor' }),
          node('dd', { text: capabilities?.executor?.reason || capabilities?.executor?.kind || 'Not reported' }),
        ]),
        node('div', {}, [
          node('dt', { text: 'Execution context' }),
          node('dd', { text: context?.message || context?.context?.summary || context?.context?.state || 'Not reported' }),
        ]),
      ]),
      checks.length
        ? node('ul', { class: 'diagnostic-list' }, checks.map((check) =>
            node('li', {
              'data-state': check.passed === true || check.ok === true ? 'pass' : 'fail',
              text: `${check.passed === true || check.ok === true ? 'Pass' : 'Fail'} — ${check.label ?? check.name ?? check.id ?? 'Unnamed check'}`,
            }),
          ))
        : node('p', { text: 'Offline diagnostics are unavailable for this browser session.' }),
      capabilities?.azureAuth?.systemLogin?.available !== true
        && capabilities?.auth?.mode !== 'bff'
        && capabilities?.sessionAuth?.state !== 'unclaimed'
        ? node('div', { class: 'terminal-handoff' }, [
            node('h3', { text: 'Private Azure sign-in unavailable' }),
            node('p', {
              text:
                'This launch never exposes its private Azure CLI session to a terminal. Restart with system sign-in enabled to authenticate it.',
            }),
          ])
        : null,
    ]),
  ]);
  showDialog(diagnosticsDialog);
}

function shellModel(models) {
  const running = state.progress?.state === 'running';
  return {
    recipe: {
      id: state.sample.id,
      title: state.sample.shortTitle,
      group: state.sample.group,
    },
    runner: {
      label: models.environment.label,
      tone: effectiveExecutorCapability().canExecute ? 'success' : 'warning',
      mode: models.environment.mode,
    },
    operatorAuthorization: models.capabilities?.operatorAuthorization ?? null,
    notebook: {
      verified: models.dossier.source.state === 'ready',
      label: models.dossier.source.state === 'ready' ? 'Notebook verified' : 'Notebook verification pending',
    },
    identity: shellIdentity(models),
    execution: shellExecution(models),
    stage: state.stage,
    directoryOpen: state.directoryOpen,
    directoryModal: state.directoryModal,
    directory: {
      ...models.directory,
      openGroupId: state.directoryGroupId,
      groups: models.directory.groups.map((group) => ({
        ...group,
        samples: group.samples.map((sample) => ({ ...sample, disabled: running })),
      })),
    },
  };
}

function declaredArtifactPaths(request) {
  return (request?.plan?.steps ?? [])
    .filter((step) => step.type === 'artifact' && typeof step.artifact?.path === 'string')
    .map((step) => step.artifact.path);
}

function authorizedArtifactPaths(response) {
  return (response?.meta?.artifacts ?? [])
    .map((artifact) => typeof artifact === 'string' ? artifact : artifact?.path)
    .filter((path) => typeof path === 'string');
}

function fieldsForWizardStep(configure, stepId) {
  const identityKind = wizardIdentityKind();
  const serverManagedCredential = (field) =>
    identityKind === 'hosted' && field.path === 'gatewayAccess.apiKey';
  const identityField = (field) => {
    if (identityKind === 'gateway') {
      return /(^gatewayAccess\.|gatewayUrl$|deployedEndpoint$|subscriptionKeyHeader$)/i.test(field.path);
    }
    if (identityKind === 'azure') {
      return /^(hub\.(subscriptionId|resourceGroupName|apimName|location)|keyVault\.subscriptionId)$/i.test(field.path);
    }
    return false;
  };
  const required = (field) =>
    field.requirement === 'mandatory'
    || (field.requirement === 'conditional' && field.conditionActive === true);
  const predicate =
    stepId === 'account-target'
      ? identityField
      : stepId === 'required-inputs'
        ? (field) => required(field) && !identityField(field)
        : (field) => !required(field) && !identityField(field);
  const groups = configure.groups
    .map((group) => ({
      ...group,
      fields: group.fields.filter((field) => !serverManagedCredential(field) && predicate(field)),
    }))
    .filter((group) => group.fields.length > 0);
  const paths = new Set(groups.flatMap((group) => group.fields.map((field) => field.path)));
  const blocking = configure.blocking.filter((field) => paths.has(field.path));
  const invalid = groups
    .flatMap((group) => group.fields)
    .filter((field) => field.errors.length > 0);
  return {
    ...configure,
    groups,
    blocking,
    blockingCount: blocking.length,
    invalid,
    invalidCount: invalid.length,
    errorCount: invalid.length,
    satisfied: blocking.length === 0 && invalid.length === 0,
  };
}

function wizardIdentityKind() {
  const liveKind = effectiveContext()?.context?.kind;
  if (liveKind === 'hosted-relay') return 'hosted';
  if (liveKind === 'offline-python') return null;
  const descriptor = sampleExecutionContext(state.sample.id);
  if (descriptor.kind === 'gateway-key') return 'gateway';
  if (isAzureCliContext(descriptor.kind)) return 'azure';
  return null;
}

function identityStepTitle() {
  return {
    azure: 'Azure account & target',
    gateway: 'Gateway connection',
    hosted: 'Hosted execution context',
  }[wizardIdentityKind()] ?? '';
}

function wizardSteps(models) {
  const required = fieldsForWizardStep(models.configure, 'required-inputs');
  const options = fieldsForWizardStep(models.configure, 'credentials-options');
  const identityKind = wizardIdentityKind();
  const definitions = WIZARD_STEP_DEFINITIONS
    .filter((step) => step.id !== 'account-target' || identityKind)
    .filter((step) => step.id !== 'required-inputs' || required.groups.length > 0)
    .filter((step) => step.id !== 'credentials-options' || options.groups.length > 0)
    .filter(
      (step) =>
        step.id !== 'review-approve'
        || models.dossier.reviewDecision.acknowledgement?.required === true,
    )
    .map((step) => step.id === 'account-target' ? { ...step, title: identityStepTitle() } : step);
  if (
    state.wizardStep === 'run-result'
    && !state.progress
    && models.dossier.reviewDecision.acknowledgement?.required !== true
    && models.dossier.ledger.canRun !== true
  ) {
    state.wizardStep = definitions[0].id;
  }
  if (!definitions.some((step) => step.id === state.wizardStep)) {
    state.wizardStep = definitions[0].id;
  }
  return definitions.map((step, index) => ({
    ...step,
    completed: state.completedWizardSteps.has(step.id),
    enabled:
      step.id === state.wizardStep
      || (state.progress?.state !== 'running' && state.completedWizardSteps.has(step.id)),
  }));
}

function wizardDescription(stepId) {
  if (stepId === 'account-target') {
    return {
      azure: 'Verify the local Azure CLI account, active subscription, intended target, and execution credential path.',
      gateway: 'Confirm the gateway endpoint, header, and memory-only API Management key. Azure login is not used.',
      hosted: 'Confirm the Entra requester, managed identity, target policy, and hosted relay boundary.',
    }[wizardIdentityKind()] ?? '';
  }
  return {
    'required-inputs': 'Supply only the values that block this recipe now.',
    'credentials-options': 'Add ephemeral credentials, then review defaults, generated values, and advanced options.',
    'review-approve': 'Confirm the target and impact. Open the exact operation only if you need it.',
    'run-result': 'Follow the attempt, cancel if needed, and inspect transcript, evidence, and artifacts.',
  }[stepId] ?? '';
}

function updateDossierStage() {
  state.stage =
    state.wizardStep === 'review-approve'
      ? 'review'
      : state.wizardStep === 'run-result'
        ? state.progress?.state === 'running'
          ? 'run'
          : 'result'
        : 'configure';
}

function producerRecipeId(field) {
  const normalize = (value) => String(value)
    .replace(/\bapi management\b/gi, 'apim')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const tail = String(field.producedBy ?? '')
    .replace(/^Produced by\s+/i, '')
    .replace(/\s*\(cell\s+\d+\)\.?$/i, '')
    .split('›')
    .at(-1)
    ?.trim();
  if (!tail) return null;
  return CATALOGUE.samples.find((sample) =>
    [sample.shortTitle, sample.title].some((label) => normalize(label) === normalize(tail)),
  )?.id ?? null;
}

function renderWizardHeading(container, steps) {
  const currentIndex = steps.findIndex((step) => step.id === state.wizardStep);
  const current = steps[currentIndex] ?? steps[0];
  container.append(
    node('header', { class: 'wizard-heading' }, [
      node('h1', { id: 'wizard-step-title', tabindex: '-1', text: state.sample.shortTitle }),
      node('p', {
        class: 'wizard-step-summary',
        text: ['review-approve', 'run-result'].includes(current.id)
          ? wizardDescription(current.id)
          : state.sample.summary,
      }),
    ]),
  );
}

function renderWizardStepNav(container, steps) {
  const labels = {
    'account-target': { azure: 'Account & target', gateway: 'Connection', hosted: 'Execution context' }[wizardIdentityKind()],
    'required-inputs': 'Inputs',
    'credentials-options': 'Options',
    'review-approve': 'Confirm & run',
    'run-result': 'Run & result',
  };
  container.append(node('nav', { class: 'wizard-step-nav', 'aria-label': 'Recipe setup steps' }, [
    node('div', { class: 'dossier-stage-progress visually-hidden' }, [
      node('span', { text: `Step ${steps.findIndex((step) => step.id === state.wizardStep) + 1} of ${steps.length}` }),
    ]),
    node('ol', {}, steps.map((step, index) =>
      node('li', {}, [
        node('button', {
          id: `wizard-step-${step.id}`,
          type: 'button',
          class: 'wizard-step-link',
          disabled: step.enabled === false,
          'aria-current': step.id === state.wizardStep ? 'step' : undefined,
          'aria-label': `${index + 1}. ${step.title}${step.completed ? ' (completed)' : ''}`,
          'data-step-id': step.id,
          'data-completed': step.completed ? 'true' : undefined,
          onclick: () => navigateWizardStep(step.id),
        }, [
          node('span', { class: 'wizard-step-index', text: String(index + 1) }),
          node('span', { text: labels[step.id] ?? step.title }),
        ]),
      ]),
    )),
  ]));
}

function renderWizardContext(container, models, shell) {
  if (state.capabilities?.auth?.mode === 'bff' && state.wizardStep === 'account-target') {
    if (shell.identitySurface) container.append(shell.identitySurface);
    return;
  }
  const kind = wizardIdentityKind();
  if (kind === 'azure' && state.wizardStep === 'account-target') {
    if (shell.identitySurface) container.append(shell.identitySurface);
    return;
  }
  if (!kind || (kind === 'gateway' && state.wizardStep === 'account-target')) return;
  const identity = shellIdentity(models);
  const execution = shellExecution(models);
  const operator = models.capabilities?.operatorAuthorization;
  container.append(node('section', { class: 'task-target', 'aria-label': 'Target and execution context' }, [
    node('div', { class: 'task-target-heading' }, [
      node('span', { text: 'Intended target' }),
      state.wizardStep !== 'account-target' ? node('button', {
        id: 'wizard-edit-context',
        type: 'button',
        class: 'task-context-edit',
        text: kind === 'gateway' ? 'Edit connection' : 'Edit account & target',
        onclick: () => {
          navigateWizardStep('account-target', { force: true });
          if (kind === 'gateway') requestAnimationFrame(() => focusPath('gatewayAccess.apiKey'));
        },
      }) : null,
    ]),
    node('code', { class: 'task-target-exact', text: execution.target.value, translate: 'no' }),
    kind === 'gateway' ? node('p', { class: 'task-credential' }, [
      `${identity.keyPresent ? 'Key present in memory' : 'Key missing'} · `,
      node('code', { text: identity.headerName, translate: 'no' }),
    ]) : node('p', { text: `${execution.human.value} · ${execution.runsAs.value}` }),
    kind === 'azure' ? node('p', { text: `Active subscription: ${execution.activeSubscription.value}` }) : null,
    kind === 'hosted' && operator?.required === true ? node('p', {
      text: `${operator.signedIn ? 'Signed in' : 'Not signed in'} · ${operator.authorized ? 'Authorized to operate' : 'Not authorized to operate'}`,
    }) : null,
    node('p', {
      class: 'task-authorization',
      text: kind === 'gateway'
        ? 'Key excluded from exports. Gateway authorization is unverified; the target decides whether to accept the request.'
        : models.dossier.reviewDecision.authorization.summary,
    }),
  ]));
}

function openDestructiveConfirmation(trigger, model) {
  const approvedFingerprint = model.confirmationFingerprint;
  state.destructiveArmed = true;
  destructiveController.render(model, {
    onConfirm() {
      if (currentModels().dossier.reviewDecision.confirmationFingerprint !== approvedFingerprint) {
        invalidateApproval({ returnToReview: true });
        announce('The run context changed. Review the operation again before running.');
        render();
        return;
      }
      state.destructiveArmed = false;
      startRun({ confirmed: true });
    },
    onCancel() {
      state.destructiveArmed = false;
    },
  });
  destructiveController.open(trigger);
}

function navigateWizardStep(stepId, { replaceHistory = false, force = false } = {}) {
  if (state.progress?.state === 'running' && stepId !== 'run-result') {
    announce('Cancel the active run before leaving Run & result.');
    return false;
  }
  const models = currentModels();
  const steps = wizardSteps(models);
  const target = steps.find((step) => step.id === stepId);
  if (!target || (!force && !target.enabled)) return false;
  state.wizardStep = target.id;
  updateDossierStage();
  writeWizardUrl({ replaceHistory });
  render();
  requestAnimationFrame(() => {
    const heading = document.getElementById('wizard-step-title');
    focusWorkspaceTarget(heading, { block: 'start' });
  });
  return true;
}

function continueWizard(models, steps) {
  const currentIndex = steps.findIndex((step) => step.id === state.wizardStep);
  const current = steps[currentIndex];
  if (!current) return;
  if (current.id === 'review-approve') return;
  const configure = ['account-target', 'required-inputs', 'credentials-options'].includes(current.id)
    ? fieldsForWizardStep(models.configure, current.id)
    : null;
  if (configure && (configure.blockingCount > 0 || configure.invalidCount > 0)) {
    const blockingPaths = new Set(configure.blocking.map((field) => field.path));
    const first = configure.groups
      .flatMap((group) => group.fields)
      .find((field) => blockingPaths.has(field.path) || field.errors.length > 0);
    playgroundState.markTouched(first.path);
    render();
    requestAnimationFrame(() => focusPath(first.path));
    const issueCount = configure.blockingCount + configure.invalidCount;
    announce(`${issueCount} input${issueCount === 1 ? '' : 's'} still need attention.`);
    return;
  }
  state.completedWizardSteps.add(current.id);
  const next = steps[currentIndex + 1];
  if (next) navigateWizardStep(next.id, { force: true });
}

function rememberCurrentWizardStep() {
  if (!state.sample || !state.wizardStep) return;
  if (state.wizardStep === 'review-approve') {
    state.completedWizardSteps.add(state.wizardStep);
    return;
  }
  if (state.wizardStep === 'run-result') {
    if (state.progress && state.progress.state !== 'running') {
      state.completedWizardSteps.add(state.wizardStep);
    }
    return;
  }
  const models = currentModels();
  if (fieldsForWizardStep(models.configure, state.wizardStep).satisfied) {
    state.completedWizardSteps.add(state.wizardStep);
  }
}

function renderWizardActions(container, models, steps) {
  const currentIndex = steps.findIndex((step) => step.id === state.wizardStep);
  const current = steps[currentIndex];
  const running = state.progress?.state === 'running';
  const bar = node('div', {
    id: 'wizard-action-bar',
    class: 'wizard-action-bar dossier-action-bar',
    'data-dossier-action-bar': 'true',
    'data-dossier-inline-action': 'true',
  });
  if (currentIndex > 0 && !running) {
    bar.append(node('button', {
      id: 'wizard-action-back',
      type: 'button',
      class: 'btn wizard-back',
      text: 'Back',
      onclick: () => navigateWizardStep(steps[currentIndex - 1].id, { force: true }),
    }));
  }
  const target = models.dossier.reviewDecision.target.actionLabel;
  const requiresConfirmation =
    models.dossier.reviewDecision.acknowledgement?.required === true;
  const next = steps[currentIndex + 1];
  if (current.id === 'review-approve') {
    const destructive =
      requiresConfirmation
      && models.dossier.reviewDecision.risk?.level === 'destructive';
    const acknowledgement = models.dossier.reviewDecision.acknowledgement ?? {};
    const acknowledgementMissing =
      !destructive && acknowledgement.required === true && acknowledgement.satisfied !== true;
    const primary = node('button', {
      id: 'wizard-action-run',
      type: 'button',
      class: 'btn btn-primary wizard-primary',
      disabled: models.dossier.ledger.canRun !== true || acknowledgementMissing,
      text: `Run Sample${target ? ` on ${target}` : ''}`,
      onclick: () =>
        destructive
          ? openDestructiveConfirmation(primary, models.dossier.reviewDecision)
          : startRun(),
    });
    if (acknowledgementMissing) {
      bar.append(node('button', {
        id: 'wizard-action-acknowledge',
        type: 'button',
        class: 'wizard-action-gate',
        text: 'Acknowledge Impact to Enable Run',
        onclick: () => focusWorkspaceTarget(
          document.querySelector('[data-acknowledgement="true"]'),
          { block: 'center' },
        ),
      }));
    } else if (models.dossier.ledger.canRun !== true && models.dossier.reviewDecision.runBlockedReason) {
      bar.append(node('p', {
        class: 'wizard-action-reason',
        text: models.dossier.reviewDecision.runBlockedReason,
      }));
    }
    bar.append(primary);
  } else if (current.id === 'run-result') {
    if (running) {
      const canCancel = typeof state.executor?.cancel === 'function';
      bar.append(node('button', {
        id: 'wizard-action-cancel',
        type: 'button',
        class: 'btn wizard-primary',
        disabled: !canCancel || state.cancelling,
        text: state.cancelling ? 'Cancelling…' : canCancel ? 'Cancel Run' : 'Cancellation Unavailable',
        onclick: canCancel ? cancelRun : undefined,
      }));
    } else if (!state.progress && !requiresConfirmation) {
      if (models.dossier.ledger.canRun !== true && models.dossier.reviewDecision.runBlockedReason) {
        bar.append(node('p', {
          class: 'wizard-action-reason',
          text: models.dossier.reviewDecision.runBlockedReason,
        }));
      }
      bar.append(node('button', {
        id: 'wizard-action-run',
        type: 'button',
        class: 'btn btn-primary wizard-primary',
        disabled: models.dossier.ledger.canRun !== true,
        text: 'Run Check',
        onclick: startRun,
      }));
    } else {
      const recommended = models.directory.flat.find((sample) => sample.recommendedNext);
      bar.append(node('button', {
        id: 'wizard-action-next',
        type: 'button',
        class: 'btn btn-primary wizard-primary',
        text: recommended
          ? `Next: ${recommended.title}`
          : !requiresConfirmation
            ? 'Run Check Again'
            : 'Review This Recipe',
        onclick: () => {
          if (recommended) selectRecipeFromUi(recommended.id);
          else if (!requiresConfirmation) startRun();
          else navigateWizardStep('review-approve', { force: true });
        },
      }));
    }
  } else {
    const directReadOnlyRun =
      !requiresConfirmation
      && next?.id === 'run-result';
    if (
      directReadOnlyRun
      && models.dossier.ledger.canRun !== true
      && models.dossier.reviewDecision.runBlockedReason
    ) {
      bar.append(node('p', {
        class: 'wizard-action-reason',
        text: models.dossier.reviewDecision.runBlockedReason,
      }));
    }
    bar.append(node('button', {
      id: directReadOnlyRun ? 'wizard-action-run' : 'wizard-action-continue',
      type: 'button',
      class: 'btn btn-primary wizard-primary',
      disabled: directReadOnlyRun && models.dossier.ledger.canRun !== true,
      text: directReadOnlyRun
        ? 'Run Check'
        : next?.id === 'review-approve'
          ? 'Review Sample'
          : next
            ? `Next: ${next.title}`
            : 'Continue',
      onclick: directReadOnlyRun ? startRun : () => continueWizard(models, steps),
    }));
  }
  const reason = bar.querySelector('.wizard-action-reason, .wizard-action-gate');
  if (reason) bar.append(reason);
  container.append(bar);
}

function render() {
  if (!state.sample || !app) return;
  app.inert = state.capabilities?.auth?.mode === 'bff' && !appReady;
  app.setAttribute('aria-busy', app.inert ? 'true' : 'false');
  if (hasActiveTextEntry()) {
    state.renderPending = true;
    return;
  }
  state.renderPending = false;
  const priorWorkspace = document.getElementById('run-dossier');
  const priorRecipeId = document.querySelector('.dossier-current-id')?.textContent?.trim() ?? '';
  const priorWizardStep = document.querySelector('[data-wizard-step]')?.dataset.wizardStep ?? '';
  const preserveWorkspace =
    priorRecipeId === state.sample.id
    && priorWizardStep === state.wizardStep;
  const priorWorkspaceScrollTop = preserveWorkspace ? priorWorkspace?.scrollTop ?? 0 : 0;
  const openDisclosures = new Set(preserveWorkspace
    ? [...priorWorkspace.querySelectorAll('details[open][data-disclosure-key]')].map((item) => item.dataset.disclosureKey)
    : []);
  // A delayed blur must not override a control the user has focused since then.
  const focusSnapshot = captureFocus(app) ?? (document.activeElement === document.body && state.pendingFocusId
    ? { id: state.pendingFocusId, value: null, selection: null }
    : null);
  state.pendingFocusId = '';
  const models = currentModels();
  const steps = wizardSteps(models);
  updateDossierStage();
  const shell = renderShell({
    container: app,
    model: {
      ...shellModel(models),
      wizard: {
        currentStep: state.wizardStep,
        steps,
      },
    },
    onIdentity() {
      if (state.wizardStep !== 'account-target') {
        navigateWizardStep('account-target', { force: true });
        requestAnimationFrame(() => focusPath('gatewayAccess.apiKey'));
        return;
      }
      focusPath('gatewayAccess.apiKey');
    },
    onIdentityToggle: () => {},
    onIdentitySignIn: () => state.capabilities?.auth?.mode === 'bff' ? beginHostedSignIn('signin') : startSystemBrowserLogin(),
    onIdentitySignOut: signOutHosted,
    onIdentityConnectAzure: () => beginHostedSignIn('azure'),
    onIdentityRetry: () => hostedAction(async () => { await fetchCapabilities(); await refreshExecutionContext(); }),
    onIdentitySubscriptionChange(id) {
      state.selectedSubscriptionId = id;
      render();
    },
    onIdentityVerify: () => state.capabilities?.auth?.mode === 'bff' ? refreshHostedSubscriptions() : verifySystemBrowserLogin(),
    onIdentitySetActive: (id) => state.capabilities?.auth?.mode === 'bff' ? selectHostedSubscription(id) : setActiveSubscription(id),
    onIdentityCancel: () => state.capabilities?.auth?.mode === 'bff' ? cancelHostedSignIn() : cancelSystemBrowserLogin(),
    onIdentityTerminalFallback: openDiagnostics,
    onDirectoryToggle(open) {
      state.directoryOpen = open;
      if (open) state.directoryGroupId = state.sample.group;
      render();
    },
    onDirectoryGroupChange(groupId) {
      state.directoryGroupId = groupId;
    },
    onRecipeSelect(id) {
      selectRecipeFromUi(id);
    },
    onDirectoryQuery(query) {
      state.directoryQuery = query;
      render();
    },
    onStageChange(stepId) {
      navigateWizardStep(stepId);
    },
    onOpenProvenance: openProvenance,
    onOpenDiagnostics: openDiagnostics,
  });

  const wizard = node('section', {
    class: 'recipe-wizard',
    'aria-labelledby': 'wizard-step-title',
    'data-wizard-step': state.wizardStep,
  });
  const wizardMain = node('div', { class: 'wizard-main' });
  renderWizardHeading(wizardMain, steps);
  renderWizardStepNav(wizardMain, steps);
  const stepHost = node('div', { class: 'wizard-step-content' });
  wizardMain.append(stepHost);
  wizard.append(wizardMain);
  shell.dossier.append(wizard);

  const configureCallbacks = {
    onChange: changeInput,
    onBlur(path, nextFocusId) {
      if (state.activeEditingPath === path) state.activeEditingPath = null;
      state.pendingFocusId = nextFocusId;
      playgroundState.markTouched(path);
      clearTimeout(state.contextRefreshTimer);
      state.contextRefreshTimer = setTimeout(async () => {
        render();
        await refreshExecutionContext();
      }, 0);
    },
    onCopy: copyText,
    onDownload: download,
    onOpenSource: openSourceInspector,
    onFocusField: focusPath,
    onOpenProducer(field) {
      const recipeId = producerRecipeId(field);
      if (recipeId) selectRecipeFromUi(recipeId);
    },
    onFocusFirstBlocker: () => {},
  };
  const configurationStepIds = steps
    .map((step) => step.id)
    .filter((stepId) => ['account-target', 'required-inputs', 'credentials-options'].includes(stepId));
  const showConfigurationExports = configurationStepIds.at(-1) === state.wizardStep;
  const showReadOnlyOperation =
    showConfigurationExports
    && models.dossier.reviewDecision.acknowledgement?.required !== true;
  const actionHost = node('div', { class: 'task-action-host' });
  renderWizardActions(actionHost, models, steps);
  if (configurationStepIds.includes(state.wizardStep)) {
    renderWizardContext(stepHost, models, shell);
    const formHost = node('div', { class: 'task-form' });
    stepHost.append(formHost);
    renderConfigure(formHost, {
      guide: models.guide,
      configure: fieldsForWizardStep(models.configure, state.wizardStep),
      source: models.dossier.source,
      sourceValidation: models.dossier.sourceValidation,
      mode: state.wizardStep,
      showExports: showConfigurationExports,
      action: actionHost,
    }, configureCallbacks);
  } else if (state.wizardStep === 'review-approve') {
    renderReview(stepHost, models.dossier.reviewDecision, {
      compact: true,
      exactTarget: shellExecution(models).target.value,
      action: actionHost,
      onAcknowledge(value) {
        playgroundState.setAcknowledged(state.sample.id, value);
        render();
      },
    });
  } else {
    renderOutput(stepHost, models.dossier.response, {
      activeRunId: state.activeRunId,
      activeView: state.outputView,
      autoFollow: state.autoFollow,
      declaredArtifactPaths: declaredArtifactPaths(models.dossier.request),
      authorizedArtifactPaths: authorizedArtifactPaths(state.progress),
      secretValues: playgroundState.secretValues(),
      azureContacted: state.progress?.meta?.azureContacted,
      liveEvidence: state.progress?.meta?.liveEvidence,
      stream: { partial: state.progress?.state === 'running' },
      onViewChange(view) {
        state.outputView = view;
        render();
      },
      onAutoFollowChange(enabled) {
        state.autoFollow = enabled;
        render();
      },
      onRevealOutput({ runId }) {
        if (state.lastRevealedRunId === runId) return;
        state.lastRevealedRunId = runId;
        scrollTargetIntoWorkspace(document.getElementById('dossier-output'), { block: 'start' });
      },
      onFollowTranscript({ log }) {
        log.scrollTop = log.scrollHeight;
      },
    });
  }
  if (state.wizardStep === 'run-result') stepHost.append(actionHost);
  stepHost.append(shell.contextBar);
  if (showReadOnlyOperation) stepHost.append(renderOperationDisclosure(models.dossier.reviewDecision));
  stepHost.append(node('details', { class: 'task-support', 'data-disclosure-key': 'source-help' }, [
    node('summary', { id: 'wizard-support-toggle', text: 'Protected source & help' }),
    node('div', { class: 'configure-actions' }, [
      node('button', { id: 'wizard-support-source', type: 'button', class: 'btn', text: 'Inspect protected source', onclick: openSourceInspector }),
      node('button', { id: 'wizard-support-guide', type: 'button', class: 'btn', text: 'Guide & provenance', onclick: openProvenance }),
      node('button', { id: 'wizard-support-diagnostics', type: 'button', class: 'btn', text: 'Diagnostics', onclick: openDiagnostics }),
    ]),
  ]));
  for (const disclosure of shell.dossier.querySelectorAll('details[data-disclosure-key]')) {
    if (openDisclosures.has(disclosure.dataset.disclosureKey)) disclosure.open = true;
  }
  if (preserveWorkspace) {
    shell.dossier.scrollTop = Math.min(
      priorWorkspaceScrollTop,
      Math.max(0, shell.dossier.scrollHeight - shell.dossier.clientHeight),
    );
  }

  if (state.destructiveArmed) {
    const approvedFingerprint = models.dossier.reviewDecision.confirmationFingerprint;
    destructiveController.render(models.dossier.reviewDecision, {
      onConfirm() {
        if (currentModels().dossier.reviewDecision.confirmationFingerprint !== approvedFingerprint) {
          invalidateApproval({ returnToReview: true });
          announce('The run context changed. Review the operation again before running.');
          render();
          return;
        }
        state.destructiveArmed = false;
        startRun({ confirmed: true });
      },
      onCancel() {
        state.destructiveArmed = false;
      },
    });
  }

  if (focusSnapshot) {
    const target = document.getElementById(focusSnapshot.id);
    if (target && !target.closest('#recipe-directory')
      && (document.activeElement === document.body || document.activeElement === target)) {
      // Restore before a second same-step render can capture an unfocused body.
      restoreFocus(app, focusSnapshot);
      if (shell.dossier.contains(target) && !preserveWorkspace) scrollTargetIntoWorkspace(target);
    }
  }
  if (sourceDialog.open) renderSourceDialog();
}

function changeInput(path, value, { commit = false } = {}) {
  const field = fieldByPath(path);
  playgroundState.set(path, value, field);
  state.activeEditingPath = commit ? null : path;
  invalidateApproval({ returnToReview: true });
  if (commit) {
    render();
    clearTimeout(state.contextRefreshTimer);
    state.contextRefreshTimer = setTimeout(refreshExecutionContext, 250);
  }
}

async function loadSource() {
  const requestId = ++state.sourceRequest;
  state.sourceValidationRequest += 1;
  state.sourceBundle = { status: 'loading' };
  state.sourceValidation = { status: 'not-run', available: false };
  render();
  try {
    const response = await fetch(`/api/source/${encodeURIComponent(state.sample.id)}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`Protected source request failed with HTTP ${response.status}.`);
    const bundle = await response.json();
    if (requestId !== state.sourceRequest) return;
    state.sourceBundle = { status: 'ready', payload: bundle };
    state.sourceCellIndex = bundle.cells?.[0]?.cellIndex ?? null;
  } catch (error) {
    if (requestId !== state.sourceRequest) return;
    state.sourceBundle = { status: 'error', message: safeMessage(error, 'Protected source could not be loaded.') };
  }
  render();
  if (state.capabilities?.sourceValidation?.available === true) await validateSource();
}

async function validateSource() {
  const requestId = ++state.sourceValidationRequest;
  const sampleId = state.sample.id;
  if (state.capabilities?.sourceValidation?.available !== true) {
    state.sourceValidation = {
      status: 'not-run',
      available: false,
      message: 'Local protected-source validation is unavailable for this browser session.',
    };
    render();
    return;
  }
  state.sourceValidation = { status: 'loading', available: true };
  render();
  try {
    const response = await fetch(`/api/source/${encodeURIComponent(sampleId)}/validate`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.summary || `Protected-source validation failed with HTTP ${response.status}.`);
    if (requestId !== state.sourceValidationRequest || state.sample.id !== sampleId) return;
    if (result.sampleId && result.sampleId !== sampleId) {
      throw new Error('Protected-source validation returned evidence for a different recipe.');
    }
    state.sourceValidation = { status: 'ready', available: true, result };
  } catch (error) {
    if (requestId !== state.sourceValidationRequest || state.sample.id !== sampleId) return;
    state.sourceValidation = {
      status: 'error',
      available: true,
      message: safeMessage(error, 'Protected-source validation failed.'),
    };
  }
  render();
}

async function fetchCapabilities() {
  try {
    const response = await fetch('/api/capabilities', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Capability probe failed with HTTP ${response.status}.`);
    state.capabilities = await response.json();
    setHostedCapabilities(state.capabilities);
    state.runtimeProbe = {
      mode: state.capabilities.mode ?? 'preview',
      ...probeFromCapabilityPayload(state.capabilities, CATALOGUE.byId),
      ...(state.capabilities.hosted ? { hosted: state.capabilities.hosted } : {}),
    };
    if (state.capabilities.executor?.kind === 'hosted-bff') {
      state.executor = createHostedExecutorClient({
        capability: state.capabilities.executor,
        contextVersion: () => effectiveContext()?.context?.contextVersion ?? state.capabilities.auth.contextVersion,
      });
    } else if (state.capabilities.executor?.kind === 'local' && state.capabilities.executor.canExecute) {
      state.executor = createLocalExecutorClient({
        allowedSampleIds: recipeIds,
        supportedStepTypes: state.capabilities.executor.supportedStepTypes ?? [],
      });
    } else if (state.capabilities.executor?.kind === 'relay' && state.capabilities.executor.canExecute) {
      state.executor = createRelayExecutor({
        allowedSampleIds: state.capabilities.executor.allowedSampleIds ?? [],
        endpoint: state.capabilities.executor.endpoint ?? '/api/execute',
        supportedStepTypes: state.capabilities.executor.supportedStepTypes ?? ['http'],
      });
    } else {
      state.executor = createUnavailableExecutor({ reason: state.capabilities.executor?.reason });
    }
    state.executorCapability = state.executor.describeCapability();
  } catch (error) {
    const hosted = state.capabilities?.auth?.mode === 'bff' || document.documentElement.dataset.citadelHosted === 'true';
    const previousHosted = state.capabilities?.hosted;
    setHostedCapabilities(null);
    state.capabilities = {
      executor: {
        id: 'unavailable',
        kind: 'unavailable',
        canExecute: false,
        supportedStepTypes: [],
        reason: safeMessage(error, 'Execution capability is unavailable.'),
      },
      executionContext: { available: false, endpoint: null, login: { available: false } },
      sourceValidation: { available: false, endpoint: null },
      selfTest: { available: false, endpoint: null },
      sessionAuth: { required: true, state: 'unclaimed', claimEndpoint: null, message: 'Secure browser session unavailable.' },
    };
    if (hosted) {
      state.capabilities.auth = { mode: 'bff', available: false, signedIn: false, authorized: false, recovering: true,
        issues: [state.capabilities.executor.reason] };
      state.capabilities.hosted = previousHosted ?? { supportedSampleIds: [], allowedSampleIds: [] };
      Object.assign(state.capabilities.executor, { id: 'hosted-bff', kind: 'hosted-bff', allowedSampleIds: [] });
      setHostedCapabilities(state.capabilities);
    }
    state.runtimeProbe = hosted ? { mode: 'hosted', hosted: state.capabilities.hosted } : { mode: 'preview' };
    state.executor = hosted
      ? createHostedExecutorClient({ capability: state.capabilities.executor, contextVersion: () => 0 })
      : createUnavailableExecutor({ reason: state.capabilities.executor.reason });
    state.executorCapability = state.executor.describeCapability();
  }
}

async function refreshExecutionContext({ refreshSubscriptions = false } = {}) {
  if (state.testExecutor) {
    render();
    return;
  }
  if (state.accountUi?.operation === 'login' && ACCOUNT_BUSY_STATES.has(state.accountUi.state)) {
    invalidateExecutionIdentity('Execution identity must be refreshed after Azure sign-in finishes.');
    render();
    return;
  }
  const priorFingerprint = state.contextFingerprint;
  const requestId = ++state.contextRequest;
  state.executionContext = {
    status: 'loading',
    message: 'Checking execution identity.',
  };
  render();
  const request = buildExecutionContextProjection({
    sample: state.sample,
    read: (path) => playgroundState.read(path),
    hasSecret: (path) => playgroundState.hasSecret(path),
  });
  let response;
  if (state.capabilities?.executionContext?.endpoint) {
    try {
      response = { status: 'ready', context: await executionContextClient.getContext(request) };
    } catch (error) {
      response = {
        status: 'unavailable',
        message: safeMessage(error, 'Execution identity could not be checked.'),
      };
    }
  } else {
    response = {
      status: 'unavailable',
      message: state.capabilities?.executor?.reason || 'Execution identity is unavailable for this browser session.',
    };
  }
  if (requestId !== state.contextRequest) return;
  state.executionContext = response;
  if (priorFingerprint !== state.contextFingerprint) return;
  updateContextFingerprint(response);
  const activeId = response?.context?.activeCliSubscription?.id;
  if (activeId && !state.selectedSubscriptionId) state.selectedSubscriptionId = activeId;
  render();
  if (
    refreshSubscriptions &&
    response?.context?.signedInAccount?.state === 'signed-in' &&
    azureAuthCapabilityFromPayload(state.capabilities).subscriptionsAvailable
  ) {
    await refreshAzureSubscriptions();
  }
}

async function runDiagnostics() {
  if (state.capabilities?.selfTest?.available !== true) {
    state.selfTests = null;
    return;
  }
  try {
    const response = await fetch(state.capabilities.selfTest.endpoint ?? '/api/self-test', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.summary || `Offline diagnostics failed with HTTP ${response.status}.`);
    state.selfTests = payload;
  } catch (error) {
    state.selfTests = {
      ok: false,
      checks: [{ label: safeMessage(error, 'Offline diagnostics failed.'), passed: false }],
    };
  }
  render();
}

async function selectSample(id) {
  const sample = sampleById.get(id) ?? sampleById.get(recipeIds[0]);
  if (state.sample?.id !== sample.id) rememberCurrentWizardStep();
  state.sample = sample;
  playgroundState.selectSample(sample.id);
  playgroundState.setAcknowledged(sample.id, false);
  playgroundState.markInputsHandled();
  state.progress = null;
  state.activeRunId = null;
  state.activeRunToken = null;
  state.contextFingerprint = null;
  state.directoryQuery = '';
  state.directoryGroupId = sample.group;
  state.selectedSubscriptionId = '';
  state.destructiveArmed = false;
  state.lastRevealedRunId = null;
  state.wizardStep = 'account-target';
  state.completedWizardSteps =
    state.completedWizardStepsByRecipe.get(sample.id) ?? new Set();
  state.completedWizardSteps.delete('run-result');
  state.completedWizardStepsByRecipe.set(sample.id, state.completedWizardSteps);
  updateDossierStage();
  if (window.innerWidth < 1200) state.directoryOpen = false;
  render();
  await Promise.allSettled([loadSource(), refreshExecutionContext({ refreshSubscriptions: true })]);
}

async function startSystemBrowserLogin() {
  const models = currentModels();
  const control = models.dossier.identity.accountControl;
  if (!control.canLaunch || control.launchMode !== 'system-browser') return;
  invalidateApproval({ returnToReview: true });
  invalidateExecutionIdentity('Execution identity must be refreshed after Azure sign-in finishes.');
  clearTimeout(azureLoginPollTimer);
  azureLoginController?.abort();
  azureSubscriptionController?.abort();
  azureSubscriptionGeneration += 1;
  const controller = new AbortController();
  azureLoginController = controller;
  const generation = ++azureLoginGeneration;
  azureLoginCancelRequested = false;
  state.azureSubscriptions = { status: 'idle', subscriptions: [], message: '' };
  state.accountUi = {
    state: 'starting',
    message: control.accounts?.length ? 'Opening Microsoft account switching in the system browser.' : 'Opening Microsoft sign-in in the system browser.',
    login: null,
    operation: 'login',
  };
  render();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const login = await executionContextClient.startSystemAzureLogin({ signal: controller.signal });
    if (generation !== azureLoginGeneration) return;
    if (azureLoginCancelRequested) {
      state.accountUi = { state: login.state, message: login.message, login };
      await cancelSystemBrowserLogin();
      return;
    }
    await applySystemAzureLogin(login, generation);
  } catch (error) {
    if (generation !== azureLoginGeneration) return;
    if (error?.code === 'login-in-progress' && error.login) {
      await applySystemAzureLogin(error.login, generation);
      return;
    }
    state.accountUi = {
      state: 'failed',
      message: safeMessage(error, 'Microsoft sign-in could not be started.'),
      login: null,
      operation: 'login',
    };
    render();
  } finally {
    clearTimeout(timeout);
    if (azureLoginController === controller) azureLoginController = null;
  }
}

async function applySystemAzureLogin(login, generation = azureLoginGeneration) {
  if (generation !== azureLoginGeneration) return;
  clearTimeout(azureLoginPollTimer);
  state.accountUi = {
    state: login.state,
    message: login.message || 'Azure system sign-in status was updated.',
    login,
    operation: 'login',
  };
  render();
  if (ACCOUNT_BUSY_STATES.has(login.state)) {
    azureLoginPollTimer = setTimeout(() => pollSystemAzureLogin(generation), 2_000);
    return;
  }
  if (login.state === 'ready') {
    await refreshExecutionContext({ refreshSubscriptions: true });
    if (state.accountUi?.login === login) state.accountUi = null;
    render();
    return;
  }
  if (login.state === 'cancelled') {
    await refreshExecutionContext({ refreshSubscriptions: true });
    if (state.accountUi?.login === login) state.accountUi = null;
    render();
  }
}

async function pollSystemAzureLogin(generation = azureLoginGeneration) {
  if (generation !== azureLoginGeneration) return;
  const loginId = state.accountUi?.login?.loginId;
  if (!loginId) return;
  azureLoginController?.abort();
  const controller = new AbortController();
  azureLoginController = controller;
  try {
    const login = await executionContextClient.getSystemAzureLogin(loginId, { signal: controller.signal });
    await applySystemAzureLogin(login, generation);
  } catch (error) {
    if (generation !== azureLoginGeneration) return;
    state.accountUi = {
      state: 'status-unknown',
      message: safeMessage(error, 'Azure sign-in status could not be refreshed.'),
      login: state.accountUi?.login ?? null,
      operation: 'login',
    };
    render();
  } finally {
    if (azureLoginController === controller) azureLoginController = null;
  }
}

async function verifySystemBrowserLogin() {
  invalidateApproval({ returnToReview: true });
  state.accountUi = {
    state: 'verifying',
    message: 'Refreshing the Azure CLI account and subscriptions.',
    login: null,
    operation: 'refresh',
  };
  render();
  try {
    await refreshExecutionContext({ refreshSubscriptions: true });
    state.accountUi = null;
    render();
  } catch (error) {
    state.accountUi = {
      state: 'failed',
      message: safeMessage(error, 'Azure account verification failed.'),
      login: null,
      operation: 'refresh',
    };
    render();
  }
}

async function cancelSystemBrowserLogin() {
  invalidateApproval({ returnToReview: true });
  clearTimeout(azureLoginPollTimer);
  const loginId =
    state.accountUi?.login?.loginId ??
    azureAuthCapabilityFromPayload(state.capabilities).loginId;
  if (!state.accountUi?.login) azureLoginCancelRequested = true;
  azureLoginController?.abort();
  const controller = new AbortController();
  azureLoginController = controller;
  const generation = ++azureLoginGeneration;
  state.accountUi = {
    ...state.accountUi,
    state: 'cancel-requested',
    message: 'Cancellation requested. Azure CLI account status is being rechecked.',
    operation: 'login',
  };
  render();
  try {
    const login = await executionContextClient.cancelSystemAzureLogin(loginId, {
      signal: controller.signal,
    });
    await applySystemAzureLogin(login, generation);
  } catch (error) {
    state.accountUi = {
      state: 'failed',
      message: safeMessage(error, 'Sign-in cancellation failed.'),
      login: state.accountUi?.login ?? null,
      operation: 'login',
    };
    render();
  } finally {
    if (azureLoginController === controller) azureLoginController = null;
  }
}

async function setActiveSubscription(subscriptionId) {
  if (!subscriptionId || state.azureSubscriptions.status !== 'ready') return;
  invalidateApproval({ returnToReview: true });
  invalidateExecutionIdentity('Execution identity must be refreshed after the Azure subscription changes.');
  azureSubscriptionController?.abort();
  const controller = new AbortController();
  azureSubscriptionController = controller;
  const generation = ++azureSubscriptionGeneration;
  state.azureSubscriptions = {
    ...state.azureSubscriptions,
    status: 'activating',
    message: 'Changing and verifying this launch-private Azure CLI subscription.',
  };
  render();
  try {
    const response = await executionContextClient.activateAzureSubscription(subscriptionId, {
      signal: controller.signal,
    });
    if (generation !== azureSubscriptionGeneration) return;
    state.selectedSubscriptionId = response.current.activeCliSubscription.id;
    state.azureSubscriptions = {
      ...state.azureSubscriptions,
      status: 'ready',
      message: response.warning,
    };
    await refreshExecutionContext();
    await refreshAzureSubscriptions();
  } catch (error) {
    if (generation !== azureSubscriptionGeneration) return;
    state.azureSubscriptions = {
      ...state.azureSubscriptions,
      status: 'error',
      message: safeMessage(error, 'This launch-private Azure CLI subscription could not be changed.'),
    };
    await refreshExecutionContext();
    render();
  } finally {
    if (azureSubscriptionController === controller) azureSubscriptionController = null;
  }
}

async function refreshAzureSubscriptions() {
  const capability = azureAuthCapabilityFromPayload(state.capabilities);
  if (!capability.subscriptionsAvailable || state.azureSubscriptions.status === 'activating') return;
  azureSubscriptionController?.abort();
  const controller = new AbortController();
  azureSubscriptionController = controller;
  const generation = ++azureSubscriptionGeneration;
  state.azureSubscriptions = {
    ...state.azureSubscriptions,
    status: 'loading',
    message: 'Refreshing enabled Azure subscriptions.',
  };
  render();
  try {
    const response = await executionContextClient.listAzureSubscriptions({ signal: controller.signal });
    if (generation !== azureSubscriptionGeneration) return;
    state.azureSubscriptions = {
      status: 'ready',
      subscriptions: response.subscriptions,
      message:
        response.subscriptions.length > 0
          ? `${response.subscriptions.length} enabled subscription${response.subscriptions.length === 1 ? '' : 's'} available.`
          : 'No enabled subscriptions are available for the current Azure CLI account and tenant.',
    };
    const selectedCandidates = [
      state.selectedSubscriptionId,
      state.executionContext?.context?.intendedTarget?.subscriptionId,
      response.current.activeCliSubscription.id,
    ].filter((id) => typeof id === 'string');
    const selectedSubscription = response.subscriptions.find((subscription) =>
      selectedCandidates.some((id) => id.toLowerCase() === subscription.id.toLowerCase()));
    state.selectedSubscriptionId = selectedSubscription?.id ?? response.subscriptions[0]?.id ?? '';
    if (state.executionContext?.status === 'ready') {
      state.executionContext = {
        ...state.executionContext,
        context: reconcileAzureContextCurrent(state.executionContext.context, response.current, {
          sampleId: state.sample.id,
        }),
      };
      updateContextFingerprint(state.executionContext);
    }
  } catch (error) {
    if (generation !== azureSubscriptionGeneration) return;
    state.azureSubscriptions = {
      status: 'error',
      subscriptions: [],
      message: safeMessage(error, 'Azure subscriptions could not be refreshed.'),
    };
  } finally {
    if (azureSubscriptionController === controller) azureSubscriptionController = null;
  }
  render();
}

function invalidateExecutionIdentity(message) {
  clearTimeout(state.contextRefreshTimer);
  state.contextRequest += 1;
  state.contextFingerprint = null;
  state.executionContext = { status: 'unavailable', message };
}

function publicInputsFor(sample) {
  const inputs = {};
  for (const entry of sample.configurationEntries) {
    if (entry.secret) continue;
    const value = playgroundState.read(entry.path);
    if (value !== undefined) inputs[entry.path] = value;
  }
  return inputs;
}

function secretsFor(sample) {
  const secrets = {};
  for (const entry of sample.configurationEntries) {
    if (!entry.secret) continue;
    const value = playgroundState.read(entry.path);
    if (typeof value === 'string' && value.length > 0) secrets[entry.path] = value;
  }
  return secrets;
}

function applyRunProgress(runToken, sampleId, event) {
  if (state.activeRunToken !== runToken) return;
  if (!event || typeof event !== 'object') return;
  const eventSampleId = event.sampleId ?? event.result?.sampleId;
  const eventRunId = event.runId ?? event.result?.meta?.runId;
  if (eventSampleId && eventSampleId !== sampleId) {
    announce('A progress update was hidden because it belonged to a different recipe.');
    return;
  }
  if (state.activeRunId && eventRunId && eventRunId !== state.activeRunId) {
    announce('A progress update was hidden because it belonged to a different run.');
    return;
  }
  try {
    assertNoSecretValues(event, playgroundState.secretValues(), 'Execution progress');
  } catch {
    announce('A progress update was hidden because it contained a credential.');
    return;
  }
  state.progress = reduceRunProgress(
    state.progress
      ?? createRunProgress({
        sampleId,
        mode: state.runtimeProbe.mode,
        executorKind: effectiveExecutorCapability().kind,
      }),
    event,
  );
  state.activeRunId = state.progress.meta?.runId ?? state.activeRunId;
  render();
}

function applyUpdates(result) {
  for (const [path, value] of Object.entries(result.configurationUpdates ?? {})) {
    const field = fieldByPath(path);
    if (field) playgroundState.set(path, value, field);
  }
  for (const [path, value] of Object.entries(result.secretUpdates ?? {})) {
    const field = fieldByPath(path);
    if (field) playgroundState.set(path, value, field);
  }
}

function hasCurrentSecret(path) {
  if (playgroundState.hasSecret(path)) return true;
  return (
    path === 'gatewayAccess.apiKey'
    && effectiveContext()?.status === 'ready'
    && effectiveContext()?.context?.kind === 'hosted-relay'
    && effectiveContext()?.context?.canExecute === true
  );
}

function readCurrentValue(path) {
  return hasCurrentSecret(path) && !playgroundState.hasSecret(path)
    ? SERVER_RESOLVED_CREDENTIAL
    : playgroundState.read(path);
}

function reviewedAzureIdentity() {
  const context = effectiveContext()?.context;
  if (!context?.kind?.startsWith('azure-cli-')) return null;
  const account = context.signedInAccount;
  const subscription = context.activeCliSubscription;
  if (
    account?.state !== 'signed-in'
    || !account.principalName
    || !account.principalType
    || !account.tenantId
    || !subscription?.id
  ) {
    return null;
  }
  return {
    principalName: account.principalName,
    principalType: account.principalType,
    tenantId: account.tenantId,
    subscriptionId: subscription.id,
  };
}

async function startRun({ confirmed = false } = {}) {
  const models = currentModels();
  const { ledger, reviewDecision } = models.dossier;
  if (state.progress?.state === 'running') return;
  const requiresDestructiveConfirmation =
    reviewDecision.acknowledgement?.required === true
    && reviewDecision.risk?.level === 'destructive';
  if (requiresDestructiveConfirmation && !confirmed) return;
  if (confirmed) playgroundState.setAcknowledged(state.sample.id, true);
  const acknowledged = playgroundState.isAcknowledged(state.sample.id);
  const runSample = state.sample;
  const acknowledgement = acknowledgementFor(runSample, acknowledged, readCurrentValue);
  if (acknowledgement.required && !acknowledgement.satisfied) {
    announce('Acknowledge the effect before running this recipe.');
    return;
  }
  const runToken = ++state.runGeneration;
  const runInputs = publicInputsFor(runSample);
  const runSecrets = secretsFor(runSample);
  const built = buildSamplePlan(runSample, readCurrentValue);
  const validation = built.validation;
  const plan = state.capabilities?.auth?.mode === 'bff' ? models.dossier.reviewDecision.request.plan : built.plan;
  if (!plan || !ledger.canRun) return;
  if (
    acknowledgement.required !== true
    && ['account-target', 'required-inputs', 'credentials-options'].includes(state.wizardStep)
    && fieldsForWizardStep(models.configure, state.wizardStep).satisfied
  ) {
    state.completedWizardSteps.add(state.wizardStep);
  }
  state.completedWizardSteps.add('review-approve');
  state.wizardStep = 'run-result';
  state.stage = 'run';
  state.progress = createRunProgress({
    sampleId: runSample.id,
    mode: state.runtimeProbe.mode,
    executorKind: effectiveExecutorCapability().kind,
  });
  state.activeRunId = null;
  state.activeRunToken = runToken;
  state.outputView = 'transcript';
  state.cancelling = false;
  playgroundState.markInputsHandled();
  state.destructiveArmed = false;
  writeWizardUrl();
  render();
  scrollTargetIntoWorkspace(document.getElementById('dossier-output'), { block: 'start' });
  announce(`Running ${runSample.shortTitle}.`);
  try {
    const result = await runPlan(state.executor, plan, {
      sampleId: runSample.id,
      inputs: runInputs,
      secrets: runSecrets,
      acknowledgement,
      acknowledgementPayload: acknowledged ? { accepted: true, sampleId: runSample.id } : null,
      reviewedIdentity: reviewedAzureIdentity(),
      validation,
      onProgress: (event) => applyRunProgress(runToken, runSample.id, event),
    });
    if (state.activeRunToken !== runToken) return;
    if (result.sampleId && result.sampleId !== runSample.id) {
      throw new Error('The runner returned a result for a different recipe.');
    }
    if (state.activeRunId && result.meta?.runId && result.meta.runId !== state.activeRunId) {
      throw new Error('The runner returned a result for a different run.');
    }
    playgroundState.consumeAcknowledgement(runSample.id);
    applyUpdates(result);
    const progress = reduceRunProgress(state.progress, { type: 'result', result });
    state.activeRunId = result.meta?.runId ?? progress.meta?.runId ?? state.activeRunId;
    state.progress = {
      ...result,
      meta: {
        ...(result.meta ?? {}),
        runId: state.activeRunId,
        workspace: result.meta?.workspace ?? progress.meta?.workspace,
        evidenceClass: progress.meta?.evidenceClass,
      },
    };
    state.stage = 'result';
    state.completedWizardSteps.add('run-result');
    writeWizardUrl({ replaceHistory: true });
    announce(state.progress?.summary || `${runSample.shortTitle} completed.`);
  } catch (error) {
    if (state.activeRunToken !== runToken) return;
    playgroundState.consumeAcknowledgement(runSample.id);
    state.progress = {
      state: 'failed',
      sampleId: runSample.id,
      summary: 'The run could not complete.',
      detail: safeMessage(error, 'The runner returned an unknown failure.'),
      steps: state.progress?.steps ?? [],
      assertions: [],
      configurationUpdates: {},
      secretUpdates: {},
      meta: {
        runId: state.activeRunId,
        evidenceClass: state.progress?.meta?.evidenceClass,
      },
    };
    state.stage = 'result';
    state.completedWizardSteps.add('run-result');
    writeWizardUrl({ replaceHistory: true });
    announce('The run failed. Review the result evidence.');
  } finally {
    if (state.activeRunToken === runToken) state.activeRunToken = null;
    state.cancelling = false;
    if (state.capabilities?.auth?.mode === 'bff') {
      await fetchCapabilities();
      await refreshExecutionContext();
    }
    render();
  }
}

async function cancelRun() {
  if (state.progress?.state !== 'running' || state.cancelling) return;
  state.cancelling = true;
  render();
  try {
    if (typeof state.executor.cancel !== 'function') {
      throw new Error('This runner did not advertise cancellation.');
    }
    const result = await state.executor.cancel();
    if (result?.cancelled !== true) {
      state.cancelling = false;
      announce(result?.reason || 'The active run could not be cancelled.');
      render();
      return;
    }
    announce('Cancelling the active run.');
  } catch (error) {
    state.cancelling = false;
    announce(safeMessage(error, 'The run could not be cancelled.'));
    render();
  }
}

function installTestHooks() {
  if (!isTestExecutorAllowed()) return;
  globalThis.__citadelTestHooks = Object.freeze({
    installExecutor(executor) {
      if (!executor || typeof executor.execute !== 'function') {
        throw new TypeError('A loopback dossier test executor must define execute().');
      }
      state.testExecutor = executor;
      state.executor = executor;
      state.executorCapability = executor.describeCapability();
      state.testContext = {
        status: 'ready',
        context: {
          kind: 'azure-cli',
          label: 'Loopback test identity',
          state: 'ready',
          code: 'test-only',
          canExecute: true,
          summary: 'Loopback acceptance identity',
          authority: {
            type: 'test',
            principalName: 'acceptance@example.test',
            principalType: 'test',
            tenantId: 'acceptance-tenant',
          },
          subscription: {
            activeId: TEST_SUBSCRIPTION_ID,
            activeName: 'Acceptance subscription',
            configuredId: TEST_SUBSCRIPTION_ID,
            matches: true,
          },
          gateway: null,
          hostedRelay: null,
          guarantees: ['Available only on loopback with the explicit test flag.'],
        },
      };
      updateContextFingerprint(state.testContext);
      render();
    },
    installContext(context, status = 'ready') {
      state.testContext =
        status === 'ready'
          ? {
              status: 'ready',
              context: {
                ...context,
                canExecute: context?.canExecute === true,
              },
            }
          : {
              status,
              message: 'The test execution context is unavailable.',
            };
      updateContextFingerprint(state.testContext);
      render();
    },
    setValue(path, value) {
      changeInput(path, value, { commit: true });
    },
    selectRecipe(id) {
      return selectRecipeFromUi(id);
    },
    snapshot() {
      return currentModels().dossier;
    },
  });
}

async function boot() {
  const signinFailed = new URL(window.location.href).searchParams.get('signin') === 'failed';
  try {
    const capability = consumeBootstrapCapability();
    if (capability) {
      const claim = await claimBrowserSession({
        descriptor: {
          required: true,
          state: 'unclaimed',
          claimEndpoint: '/api/session/claim',
        },
        capability,
      });
      if (!claim.claimed) throw new Error('The secure browser capability was rejected or expired.');
    }
  } catch (error) {
    state.sessionClaimError = safeMessage(error, 'The secure browser capability could not be claimed.');
  }
  await fetchCapabilities();
  const initial = readWizardUrl();
  let resumed = null;
  if (state.capabilities?.auth?.mode === 'bff') {
    try { resumed = consumeHostedResume({ storage: window.sessionStorage, catalogue: CATALOGUE }); }
    catch (error) { state.hostedMessage = safeMessage(error, 'The non-secret draft could not be restored.'); }
    if (resumed) initial.recipeId = resumed.recipeId;
    if (signinFailed) state.hostedMessage = 'Microsoft sign-in was cancelled, denied or expired. Try again from this application.';
  }
  await selectSample(initial.recipeId);
  if (resumed) {
    for (const [path, value] of Object.entries(resumed.inputs)) playgroundState.set(path, value, fieldByPath(path));
    initial.stepId = 'account-target';
    state.hostedMessage = signinFailed ? state.hostedMessage : 'Non-secret inputs restored. Re-enter any gateway key; credentials are never saved.';
    await refreshExecutionContext();
  }
  applyWizardRun(initial.runId);
  state.wizardStep = initial.stepId;
  wizardSteps(currentModels());
  updateDossierStage();
  writeWizardUrl({ replaceHistory: true });
  appReady = true;
  installTestHooks();
  await runDiagnostics();
  render();
}

async function hostedAction(operation) {
  if (state.hostedBusy) return;
  state.hostedBusy = true;
  state.hostedMessage = '';
  invalidateApproval({ returnToReview: true });
  render();
  try { await operation(); }
  catch (error) {
    state.hostedMessage = safeMessage(error, 'The application action could not complete.');
    if ([401, 403, 503].includes(error.status)) {
      await fetchCapabilities();
      invalidateExecutionIdentity('Refresh the application session before continuing.');
    }
  } finally {
    state.hostedBusy = false;
    render();
  }
}

function saveSignInDraft() {
  const inputs = publicInputsFor(state.sample);
  assertNoSecretValues(inputs, playgroundState.secretValues(), 'Sign-in resume draft');
  saveHostedResume({ storage: window.sessionStorage, sample: state.sample, inputs });
}

async function beginHostedSignIn(purpose) {
  return hostedAction(async () => {
    saveSignInDraft();
    const result = await hostedPost('/api/auth/start', { purpose });
    if (new URL(result.url).protocol !== 'https:') throw new Error('Sign-in requires HTTPS.');
    playgroundState.markInputsHandled();
    window.location.assign(result.url);
  });
}

async function signOutHosted() {
  return hostedAction(async () => {
    saveSignInDraft();
    for (const path of Object.keys(playgroundState.secretValues())) playgroundState.set(path, '', fieldByPath(path));
    const result = await hostedPost('/api/auth/logout', {});
    if (result.url !== '/' && new URL(result.url).protocol !== 'https:') throw new Error('Sign-out requires HTTPS.');
    playgroundState.markInputsHandled();
    window.location.assign(result.url);
  });
}

async function cancelHostedSignIn() {
  return hostedAction(async () => {
    await hostedPost('/api/auth/cancel', {});
    await fetchCapabilities();
    await refreshExecutionContext();
    state.hostedMessage = 'Pending sign-in cancelled. Sign in again from this application.';
  });
}

async function refreshHostedSubscriptions() {
  return hostedAction(async () => {
    const result = await hostedPost('/api/hosted/subscriptions', {});
    state.hostedSubscriptions = result.subscriptions;
    state.hostedMessage = result.subscriptions.length ? 'Choose a subscription, then use it explicitly.' : 'No enabled subscription matches this account and the deployment target policy.';
  });
}

async function selectHostedSubscription(id) {
  return hostedAction(async () => {
    const result = await hostedPost('/api/hosted/subscription', { subscriptionId: id });
    state.selectedSubscriptionId = result.subscription.id;
    playgroundState.set('hub.subscriptionId', result.subscription.id, fieldByPath('hub.subscriptionId'));
    await fetchCapabilities();
    await refreshExecutionContext();
    state.hostedMessage = 'Subscription selected for this application session only.';
  });
}

window.addEventListener('focus', async () => {
  if (!appReady || state.capabilities?.auth?.mode !== 'bff' || state.hostedBusy) return;
  const previous = JSON.stringify(state.capabilities.auth);
  await fetchCapabilities();
  if (previous !== JSON.stringify(state.capabilities.auth)) {
    invalidateApproval({ returnToReview: true });
    await refreshExecutionContext();
    render();
  }
});

window.addEventListener('popstate', async (event) => {
  if (!appReady) return;
  if (restoringWizardHistory) {
    restoringWizardHistory = false;
    return;
  }
  const navigationGeneration = ++historyNavigationGeneration;
  const next = readWizardUrl();
  if (state.progress?.state === 'running') {
    restoreRejectedHistoryNavigation(event);
    announce('Cancel the active run before leaving Run & result.');
    return;
  }
  if (state.azureSubscriptions.status === 'activating') {
    restoreRejectedHistoryNavigation(event);
    announce('Wait for Azure subscription activation to finish before navigating history.');
    return;
  }
  if (
    next.recipeId !== state.sample.id
    && playgroundState.hasUnsavedChanges
    && !window.confirm('Change recipes and discard unsaved input changes? Credentials are never persisted.')
  ) {
    restoreRejectedHistoryNavigation(event);
    return;
  }
  wizardHistoryIndex = Number.isSafeInteger(event.state?.[WIZARD_HISTORY_INDEX_KEY])
    ? event.state[WIZARD_HISTORY_INDEX_KEY]
    : wizardHistoryIndex;
  if (next.recipeId !== state.sample.id) await selectSample(next.recipeId);
  if (navigationGeneration !== historyNavigationGeneration) return;
  applyWizardRun(next.runId);
  if (!navigateWizardStep(next.stepId, { replaceHistory: true })) {
    writeWizardUrl({ replaceHistory: true });
    render();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!playgroundState.hasUnsavedChanges) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener('resize', () => {
  const directoryModal = window.innerWidth < 1200;
  if (directoryModal === state.directoryModal) return;
  state.directoryModal = directoryModal;
  state.directoryOpen = !directoryModal;
  render();
});

boot().catch((error) => {
  replace(app, [
    node('main', { class: 'fatal-state' }, [
      node('h1', { text: 'Citadel Publish Playground could not start' }),
      node('p', { role: 'alert', text: safeMessage(error, 'An unknown startup failure occurred.') }),
    ]),
  ]);
});
