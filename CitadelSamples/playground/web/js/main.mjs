/**
 * Application bootstrap.
 *
 * Owns: state, capability discovery, tab keyboard behaviour, re-render, the
 * guarded run/cancel actions, and the configuration exports. Everything it
 * renders comes from a pure view model, so the decisions this file makes are
 * about the DOM only.
 */

import { CATALOGUE, acknowledgementFor, buildSamplePlan, fieldByPath, getSample } from '../../src/catalogue/index.mjs';
import { probeFromCapabilityPayload } from '../../src/core/capability.mjs';
import { createPlaygroundState } from '../../src/core/state.mjs';
import { createRelayExecutor, createUnavailableExecutor, runPlan } from '../../src/core/executor.mjs';
import {
  LOCAL_SESSION_BOOTSTRAP_HEADER,
  LOCAL_SESSION_CLAIM_PATH,
  LOCAL_SESSION_PROTOCOL_VERSION,
} from '../../src/core/localSession.mjs';
import { assertNoSecretValues } from '../../src/core/secrets.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../../src/core/types.mjs';
import {
  buildDirectoryModel,
  buildExecutionEnvironmentModel,
  buildExecutionIdentityModel,
  buildWorkbenchModel,
} from '../../src/view/models.mjs';
import { createRunProgress, reduceRunProgress } from '../../src/view/runProgress.mjs';
import {
  azureAuthCapabilityFromPayload,
  buildExecutionContextProjection,
  createExecutionContextClient,
  reconcileAzureContextCurrent,
} from './executionContextClient.mjs';
import { createLocalExecutorClient } from './localClient.mjs';
import { chip, el, replace } from './render/dom.mjs';
import { renderDirectory, renderSampleSelect } from './render/directory.mjs';
import { renderGuide, renderRequest, renderResponse, renderSource } from './render/panels.mjs';

const TABS = ['code', 'guide', 'request', 'response'];
const TEST_EXECUTOR_ENABLED =
  location.hostname === '127.0.0.1' && new URLSearchParams(location.search).has('testExecutor');

function takeBootstrapCapability() {
  const parameters = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : '');
  if (!parameters.has('bootstrap')) return null;
  const capability = parameters.get('bootstrap');
  parameters.delete('bootstrap');
  const remaining = parameters.toString();
  history.replaceState(null, '', `${location.pathname}${location.search}${remaining ? `#${remaining}` : ''}`);
  return capability;
}

let pendingBootstrapCapability = takeBootstrapCapability();

const nodes = {
  sourceFile: document.getElementById('source-file'),
  sourceHash: document.getElementById('source-hash'),
  capability: document.getElementById('capability'),
  capabilityLabel: document.getElementById('capability-label'),
  directoryGroups: document.getElementById('directory-groups'),
  directoryCount: document.getElementById('directory-count'),
  directorySearch: document.getElementById('directory-search'),
  directoryToggle: document.getElementById('directory-toggle'),
  sampleSelect: document.getElementById('sample-select'),
  title: document.getElementById('sample-title'),
  meta: document.getElementById('sample-meta'),
  summary: document.getElementById('sample-summary'),
  tablist: document.getElementById('tablist'),
  panels: {
    guide: document.getElementById('panel-guide'),
    code: document.getElementById('panel-code'),
    request: document.getElementById('panel-request'),
    response: document.getElementById('panel-response'),
  },
  live: document.getElementById('live'),
  selfTestRun: document.getElementById('self-test-run'),
  selfTestStatus: document.getElementById('self-test-status'),
  selfTestSummary: document.getElementById('self-test-summary'),
  selfTestChecks: document.getElementById('self-test-checks'),
};

const state = createPlaygroundState({ catalogue: CATALOGUE });
const executionContextClient = createExecutionContextClient();

let executor = createUnavailableExecutor();
let capability = executor.describeCapability();
/** Per-dependency probe results from the server. Empty means "preview only". */
let runtimeProbe = { mode: 'preview' };
let capabilitySummary = null;
let sourceValidationAvailable = false;
let executionContextAvailable = false;
let selfTestAvailable = true;
let localSessionAuth = { required: false, state: 'not-required', message: '' };
const results = new Map();
const sourceStates = new Map();
const sourceValidationStates = new Map();
let running = false;
let runningSampleId = null;
let sourceRequest = null;
let sourceRequestVersion = 0;
let validationRequest = null;
let validationRequestVersion = 0;
let executionContextState = TEST_EXECUTOR_ENABLED
  ? { status: 'unavailable', message: 'Execution identity awaits the loopback-only test executor.' }
  : { status: 'loading' };
let executionContextRequestVersion = 0;
let executionContextTimer = null;
let executionContextController = null;
let azureLoginState = { status: 'idle' };
let azureAuthCapability = azureAuthCapabilityFromPayload(null);
let azureSubscriptionsState = { status: 'idle', subscriptions: [], selectedId: '', message: '' };
let azureLoginPollTimer = null;
let azureLoginController = null;
let azureLoginGeneration = 0;
let azureLoginCancelRequested = false;
let azureSubscriptionsController = null;
let azureSubscriptionsGeneration = 0;
let sourceWrap = false;
let testExecutionContextOverride = TEST_EXECUTOR_ENABLED;
let secretInputInProgress = false;

function announce(message) {
  nodes.live.textContent = message;
}

function refreshExecutionContext() {
  announce('Checking execution identity…');
  if (executionContextAvailable || testExecutionContextOverride) loadExecutionContext();
  else probeCapability();
}

/* ------------------------------------------------------ capability probe */

async function claimLocalSession() {
  const capabilityValue = pendingBootstrapCapability;
  pendingBootstrapCapability = null;
  if (!capabilityValue) return;
  try {
    await fetch(LOCAL_SESSION_CLAIM_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [LOCAL_SESSION_BOOTSTRAP_HEADER]: capabilityValue,
      },
      body: JSON.stringify({ protocolVersion: LOCAL_SESSION_PROTOCOL_VERSION }),
    });
  } catch {
    // The capability probe below reports the authoritative claimed state.
  }
}

async function probeCapability() {
  try {
    const response = await fetch('/api/capabilities', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Capability probe failed with HTTP ${response.status}.`);
    const payload = await response.json();
    localSessionAuth = payload.sessionAuth ?? { required: false, state: 'not-required', message: '' };
    runtimeProbe = {
      mode: payload.mode ?? 'preview',
      ...probeFromCapabilityPayload(payload, CATALOGUE.byId),
    };
    capabilitySummary = payload.capability ?? null;
    sourceValidationAvailable = payload.sourceValidation?.available === true;
    executionContextAvailable = typeof payload.executionContext?.endpoint === 'string';
    azureAuthCapability = azureAuthCapabilityFromPayload(payload);
    selfTestAvailable = payload.selfTest?.available === true;
    if (payload.executor?.kind === 'local' && payload.executor.canExecute) {
      executor = createLocalExecutorClient({
        allowedSampleIds: CATALOGUE.samples.map((sample) => sample.id),
        supportedStepTypes: payload.executor.supportedStepTypes ?? [],
      });
    } else if (payload.executor?.kind === 'relay' && payload.executor.canExecute) {
      executor = createRelayExecutor({
        // The relay only ever runs a fixed, server-reported subset. Falling
        // back to the full catalogue here would let the UI offer a "run"
        // affordance for samples the relay will always refuse.
        allowedSampleIds: payload.executor.allowedSampleIds ?? [],
        endpoint: '/api/execute',
        supportedStepTypes: payload.executor.supportedStepTypes ?? ['http'],
      });
    } else {
      executor = createUnavailableExecutor({ reason: payload?.executor?.reason });
    }
    capability = executor.describeCapability();
    if (localSessionAuth.required && localSessionAuth.state !== 'claimed' && !testExecutionContextOverride) {
      executionContextState = {
        status: 'unavailable',
        message: localSessionAuth.message || 'Open the secure launch URL shown in the terminal.',
      };
    } else if (executionContextAvailable && !testExecutionContextOverride) {
      loadExecutionContext();
    } else if (!testExecutionContextOverride) {
      executionContextState = {
        status: 'unavailable',
        message:
          'Execution identity is not available from this server. Start the playground with npm run start:execute, then refresh.',
      };
    }
  } catch {
    // Keep the unavailable executor. A failed probe must never be read as
    // "execution is available".
    capability = executor.describeCapability();
    if (!testExecutionContextOverride) {
      executionContextState = {
        status: 'unavailable',
        message: 'Execution identity could not be checked. Retry the capability check before approving a run.',
      };
    }
  }
  renderCapability();
  render();
}

function renderCapability() {
  if (localSessionAuth.required && localSessionAuth.state !== 'claimed') {
    nodes.capability.dataset.canExecute = 'false';
    nodes.capability.dataset.executionMode = 'unclaimed';
    nodes.capabilityLabel.textContent = 'Secure launch required';
    nodes.capability.title = localSessionAuth.message || 'Open the secure launch URL shown in the terminal.';
    return;
  }
  const environment = buildExecutionEnvironmentModel(capability);
  nodes.capability.dataset.canExecute = capability.canExecute ? 'true' : 'false';
  nodes.capability.dataset.executionMode = environment.mode;
  nodes.capabilityLabel.textContent = environment.label;
  nodes.capability.title = capabilitySummary?.detail ?? environment.detail ?? capability.reason ?? '';
}

/* --------------------------------------------------- execution identity */

function executionContextRequest(sample) {
  return buildExecutionContextProjection({
    sample,
    read: (path) => state.read(path),
    hasSecret: (path) => state.hasSecret(path),
  });
}

function executionContextFingerprint(sample) {
  return JSON.stringify(executionContextRequest(sample));
}

function executionIdentityIsCurrent(sample, identity) {
  const loginState = azureLoginState.login?.state;
  if (
    azureLoginState.status === 'starting' ||
    ['starting', 'waiting-system-ui', 'verifying', 'cancel-requested'].includes(loginState)
  ) {
    return false;
  }
  if (testExecutionContextOverride) return identity.canExecute === true;
  if (!executionContextAvailable) return true;
  return (
    identity.canExecute === true &&
    executionContextState.status === 'ready' &&
    executionContextState.fingerprint === executionContextFingerprint(sample)
  );
}

async function loadExecutionContext(sampleId = state.selectedSampleId) {
  if (!executionContextAvailable && !testExecutionContextOverride) {
    executionContextState = {
      status: 'unavailable',
      message:
        'Execution identity is not available from this server. Start the playground with npm run start:execute, then refresh.',
    };
    render();
    return;
  }
  executionContextController?.abort();
  const controller = new AbortController();
  executionContextController = controller;
  const version = ++executionContextRequestVersion;
  const sample = getSample(sampleId);
  const request = executionContextRequest(sample);
  const fingerprint = JSON.stringify(request);
  executionContextState = { status: 'loading', fingerprint };
  render();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  try {
    const context = await executionContextClient.getContext(request, { signal: controller.signal });
    if (version !== executionContextRequestVersion || state.selectedSampleId !== sampleId) return;
    executionContextState = { status: 'ready', context, fingerprint };
  } catch (error) {
    if (version !== executionContextRequestVersion || state.selectedSampleId !== sampleId) return;
    executionContextState = {
      status: 'unavailable',
      message:
        timedOut
          ? 'Execution identity check timed out. Retry before approving a run.'
          : error?.status === 404
          ? 'Execution identity is unavailable in preview mode. Start with npm run start:execute to inspect or sign in.'
          : 'Execution identity could not be checked. Retry before approving a run.',
    };
  } finally {
    clearTimeout(timeout);
    if (executionContextController === controller) executionContextController = null;
  }
  render();
  announce(
    executionContextState.status === 'ready'
      ? `${executionContextState.context.label}: ${executionContextState.context.summary}`
      : executionContextState.message,
  );
}

function scheduleExecutionContext() {
  if (testExecutionContextOverride || !executionContextAvailable) return;
  clearTimeout(executionContextTimer);
  executionContextController?.abort();
  executionContextRequestVersion += 1;
  executionContextState = {
    status: 'stale',
    message: 'Execution identity is being rechecked for the changed subscription or gateway settings.',
  };
  executionContextTimer = setTimeout(() => loadExecutionContext(), 250);
}

function invalidateExecutionContext(message) {
  clearTimeout(executionContextTimer);
  executionContextController?.abort();
  executionContextRequestVersion += 1;
  executionContextState = { status: 'stale', message };
}

function applyAzureLogin(login) {
  const focusedId = document.activeElement?.id ?? '';
  azureLoginState = { status: 'ready', login };
  render();
  clearTimeout(azureLoginPollTimer);
  if (login.state === 'ready') {
    if (focusedId === 'cancel-system-azure-login') {
      requestAnimationFrame(() => document.getElementById('refresh-azure-cli-status')?.focus());
    }
    azureSubscriptionsState = { status: 'idle', subscriptions: [], selectedId: '', message: '' };
    announce('Azure sign-in completed. Refreshing execution identity.');
    loadExecutionContext();
    return;
  }
  if (!['starting', 'waiting-system-ui', 'verifying', 'cancel-requested'].includes(login.state)) {
    if (focusedId === 'cancel-system-azure-login') {
      requestAnimationFrame(() => {
        const target =
          document.getElementById('cancel-system-azure-login') ??
          document.getElementById('start-system-azure-login');
        target?.focus();
      });
    }
    announce(login.message || `Azure sign-in ${login.state}.`);
    return;
  }
  announce(login.message || 'Azure system sign-in is waiting for the system account UI.');
  const generation = azureLoginGeneration;
  azureLoginPollTimer = setTimeout(() => pollAzureLogin(generation), 2_000);
}

async function loginRequest(action, generation, timeoutMs = 10_000) {
  azureLoginController?.abort();
  const controller = new AbortController();
  azureLoginController = controller;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await action(controller.signal);
    if (generation !== azureLoginGeneration) return null;
    return result;
  } finally {
    clearTimeout(timeout);
    if (azureLoginController === controller) azureLoginController = null;
  }
}

async function startSystemAzureLogin() {
  clearTimeout(azureLoginPollTimer);
  azureLoginController?.abort();
  azureSubscriptionsController?.abort();
  azureSubscriptionsGeneration += 1;
  const generation = ++azureLoginGeneration;
  azureLoginCancelRequested = false;
  invalidateExecutionContext('Execution identity must be refreshed after Azure sign-in finishes.');
  azureLoginState = { status: 'starting' };
  azureSubscriptionsState = { status: 'idle', subscriptions: [], selectedId: '', message: '' };
  render();
  requestAnimationFrame(() => document.getElementById('cancel-system-azure-login')?.focus());
  announce('Starting Azure system sign-in…');
  try {
    const login = await loginRequest(
      (signal) => executionContextClient.startSystemAzureLogin({ signal }),
      generation,
      15_000,
    );
    if (login && azureLoginCancelRequested) {
      azureLoginState = { status: 'ready', login };
      await cancelSystemAzureLogin('Azure sign-in cancelled.');
    } else if (login) {
      applyAzureLogin(login);
    }
  } catch (error) {
    if (generation !== azureLoginGeneration) return;
    if (error?.code === 'login-in-progress' && error.login) {
      if (azureLoginCancelRequested) {
        azureLoginState = { status: 'ready', login: error.login };
        await cancelSystemAzureLogin('Azure sign-in cancelled.');
      } else {
        applyAzureLogin(error.login);
      }
      return;
    }
    azureLoginState = {
      status: 'error',
      message:
        'Azure sign-in start could not be confirmed. Refresh the execution identity or retry sign-in; cancellation is unavailable until the server returns a current login ID.',
    };
    render();
    requestAnimationFrame(() => {
      const target =
        document.getElementById('start-system-azure-login') ??
        document.getElementById('refresh-azure-cli-status');
      target?.focus();
    });
    announce(azureLoginState.message);
  }
}

async function pollAzureLogin(generation = azureLoginGeneration) {
  if (generation !== azureLoginGeneration) return;
  const loginId = azureLoginState.login?.loginId;
  if (!loginId) return;
  try {
    const login = await loginRequest(
      (signal) => executionContextClient.getSystemAzureLogin(loginId, { signal }),
      generation,
      10_000,
    );
    if (login && login.loginId === loginId) applyAzureLogin(login);
  } catch {
    if (generation !== azureLoginGeneration) return;
    azureLoginState = {
      status: 'ready',
      login: {
        ...azureLoginState.login,
        state: 'status-unknown',
        message: 'Azure sign-in status could not be refreshed. Run `az account show` in a terminal, then Refresh Azure CLI Status.',
      },
    };
    render();
    announce(azureLoginState.login.message);
  }
}

async function cancelSystemAzureLogin(message = 'Azure sign-in cancelled.') {
  const loginId = azureLoginState.login?.loginId ?? azureAuthCapability.loginId;
  clearTimeout(azureLoginPollTimer);
  if (!loginId) {
    azureLoginCancelRequested = true;
    azureLoginState = {
      status: 'starting',
      message: 'Cancellation requested. Waiting for the server login ID.',
    };
    render();
    requestAnimationFrame(() => document.getElementById('cancel-system-azure-login')?.focus());
    announce(azureLoginState.message);
    return;
  }
  azureLoginController?.abort();
  const generation = ++azureLoginGeneration;
  try {
    const login = await loginRequest(
      (signal) => executionContextClient.cancelSystemAzureLogin(loginId, { signal }),
      generation,
    );
    if (login && login.loginId === loginId) applyAzureLogin({ ...login, message: login.message || message });
  } catch {
    if (generation !== azureLoginGeneration) return;
    azureLoginState = {
      status: 'ready',
      login: {
        ...azureLoginState.login,
        loginId,
        state: 'status-unknown',
        message: 'Azure sign-in cancellation could not be confirmed. Retry the cancellation.',
      },
    };
    render();
    announce(azureLoginState.login.message);
  }
}

async function loadAzureSubscriptions() {
  if (!azureAuthCapability.subscriptionsAvailable || azureSubscriptionsState.status === 'activating') return;
  azureSubscriptionsController?.abort();
  const controller = new AbortController();
  azureSubscriptionsController = controller;
  const generation = ++azureSubscriptionsGeneration;
  azureSubscriptionsState = {
    ...azureSubscriptionsState,
    status: 'loading',
    message: '',
  };
  render();
  try {
    const result = await executionContextClient.listAzureSubscriptions({ signal: controller.signal });
    if (generation !== azureSubscriptionsGeneration) return;
    if (executionContextState.status === 'ready') {
      executionContextState = {
        ...executionContextState,
        context: reconcileAzureContextCurrent(executionContextState.context, result.current, {
          sampleId: state.selectedSampleId,
        }),
      };
    }
    const currentId = result.current.activeCliSubscription.id;
    const defaultId = result.subscriptions.find((subscription) => subscription.isDefault)?.id ?? '';
    const cachedId = executionContextState.context?.activeCliSubscription?.id ?? '';
    const selectedId =
      [currentId, defaultId, cachedId]
        .map((candidate) =>
          result.subscriptions.find(
            (subscription) => subscription.id.toLowerCase() === String(candidate).toLowerCase(),
          )?.id,
        )
        .find(Boolean) ??
      result.subscriptions[0]?.id ??
      '';
    azureSubscriptionsState = {
      status: 'ready',
      subscriptions: result.subscriptions,
      selectedId,
      message:
        result.subscriptions.length > 0
          ? `${result.subscriptions.length} enabled subscription${result.subscriptions.length === 1 ? '' : 's'} available.`
          : 'No enabled subscriptions are available for the current Azure CLI account and tenant.',
    };
  } catch (error) {
    if (generation !== azureSubscriptionsGeneration) return;
    azureSubscriptionsState = {
      status: 'error',
      subscriptions: [],
      selectedId: '',
      message: error?.message ?? 'Azure subscriptions could not be loaded.',
    };
  } finally {
    if (azureSubscriptionsController === controller) azureSubscriptionsController = null;
  }
  render();
  announce(azureSubscriptionsState.message);
}

function selectAzureSubscription(subscriptionId) {
  if (azureSubscriptionsState.status !== 'ready') return;
  azureSubscriptionsState = { ...azureSubscriptionsState, selectedId: subscriptionId };
  render();
}

async function activateAzureSubscription() {
  const subscriptionId = azureSubscriptionsState.selectedId;
  if (!subscriptionId || azureSubscriptionsState.status !== 'ready') return;
  azureSubscriptionsController?.abort();
  const controller = new AbortController();
  azureSubscriptionsController = controller;
  const generation = ++azureSubscriptionsGeneration;
  invalidateExecutionContext('Execution identity must be refreshed after the Azure subscription changes.');
  azureSubscriptionsState = {
    ...azureSubscriptionsState,
    status: 'activating',
    message: 'Changing the shared Azure CLI default subscription.',
  };
  render();
  try {
    await executionContextClient.activateAzureSubscription(subscriptionId, { signal: controller.signal });
    if (generation !== azureSubscriptionsGeneration) return;
    azureSubscriptionsState = {
      ...azureSubscriptionsState,
      status: 'ready',
      message: 'Azure CLI subscription changed and verified.',
    };
    await loadExecutionContext();
    await loadAzureSubscriptions();
  } catch (error) {
    if (generation !== azureSubscriptionsGeneration) return;
    azureSubscriptionsState = {
      ...azureSubscriptionsState,
      status: 'error',
      message: error?.message ?? 'Azure CLI subscription could not be changed.',
    };
    await loadExecutionContext();
    render();
    announce(azureSubscriptionsState.message);
  } finally {
    if (azureSubscriptionsController === controller) azureSubscriptionsController = null;
  }
}

/* ----------------------------------------------------- protected source */

async function loadProtectedSource(sampleId = state.selectedSampleId) {
  sourceRequest?.controller.abort();
  const version = ++sourceRequestVersion;
  const controller = new AbortController();
  sourceRequest = { sampleId, version, controller };
  sourceStates.set(sampleId, { status: 'loading' });
  render();

  try {
    const response = await fetch(`/api/source/${encodeURIComponent(sampleId)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (version !== sourceRequestVersion || state.selectedSampleId !== sampleId) return;
    if (!response.ok) {
      sourceStates.set(sampleId, {
        status: 'error',
        message: `The protected source could not be loaded (HTTP ${response.status}).`,
      });
    } else {
      const payload = await response.json();
      if (version !== sourceRequestVersion || state.selectedSampleId !== sampleId) return;
      sourceStates.set(sampleId, { status: 'ready', payload });
    }
  } catch (error) {
    if (error?.name === 'AbortError' || version !== sourceRequestVersion || state.selectedSampleId !== sampleId) return;
    sourceStates.set(sampleId, {
      status: 'error',
      message: 'The protected source could not be loaded. Check that the playground server is available.',
    });
  }
  if (version !== sourceRequestVersion || state.selectedSampleId !== sampleId) return;
  render();
}

async function validateProtectedSource() {
  const sampleId = state.selectedSampleId;
  if (!sourceValidationAvailable) {
    announce('Offline Python validation requires the loopback execute server.');
    return;
  }
  if (sourceStates.get(sampleId)?.status !== 'ready') {
    announce('Load the protected source before validating it.');
    return;
  }
  validationRequest?.controller.abort();
  const version = ++validationRequestVersion;
  const controller = new AbortController();
  validationRequest = { sampleId, version, controller };
  sourceValidationStates.set(sampleId, { status: 'loading' });
  render();
  announce('Validating protected Python cells offline. No source is executed.');

  try {
    const response = await fetch(`/api/source/${encodeURIComponent(sampleId)}/validate`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
      signal: controller.signal,
    });
    if (version !== validationRequestVersion || state.selectedSampleId !== sampleId) return;
    if (!response.ok) {
      sourceValidationStates.set(sampleId, {
        status: 'error',
        message: `Offline source validation could not be completed (HTTP ${response.status}).`,
      });
    } else {
      const result = await response.json();
      if (version !== validationRequestVersion || state.selectedSampleId !== sampleId) return;
      sourceValidationStates.set(sampleId, { status: 'ready', result });
    }
  } catch (error) {
    if (error?.name === 'AbortError' || version !== validationRequestVersion || state.selectedSampleId !== sampleId) return;
    sourceValidationStates.set(sampleId, {
      status: 'error',
      message: 'Offline source validation could not reach the playground server.',
    });
  }
  if (version !== validationRequestVersion || state.selectedSampleId !== sampleId) return;
  validationRequest = null;
  render();
  const outcome = sourceValidationStates.get(sampleId);
  announce(outcome.status === 'ready' ? 'Offline source validation finished.' : outcome.message);
}

function openParameterField(path) {
  state.setActiveTab('code');
  requestAnimationFrame(() => document.getElementById(`f-${path.replace(/[^a-zA-Z0-9-]/g, '-')}`)?.focus());
}

function openReview() {
  state.setActiveTab('request');
  requestAnimationFrame(() => document.getElementById('tab-request')?.focus());
}

function toggleSourceWrap() {
  sourceWrap = !sourceWrap;
  render();
}

function toggleDirectory() {
  const collapsed = document.querySelector('.shell')?.dataset.directoryCollapsed === 'true';
  const next = !collapsed;
  document.querySelector('.shell').dataset.directoryCollapsed = String(next);
  nodes.directoryToggle.textContent = next ? 'Recipes' : 'Hide';
  nodes.directoryToggle.setAttribute('aria-label', next ? 'Expand recipe navigator' : 'Collapse recipe navigator');
  nodes.directoryToggle.setAttribute('aria-expanded', String(!next));
}

function setParameter(path, value) {
  const field = fieldByPath(path);
  secretInputInProgress = field?.classification === 'secret';
  try {
    state.set(path, value, field);
  } finally {
    secretInputInProgress = false;
  }
}

function commitParameter(path) {
  if (fieldByPath(path)?.classification === 'secret') {
    scheduleExecutionContext();
    render();
    return;
  }
  state.markTouched(path);
}

/* ------------------------------------------------------------ self-test */

/**
 * A fixed, local demonstration of this checkout: no Azure credential, no
 * network call, and — because `azureContacted`/`liveEvidence` are always
 * `false` — a result that can never be read as live evidence. This state is
 * intentionally separate from `results` (which holds real recipe runs) so
 * the two can never be confused in the UI.
 */
let selfTest = { state: 'idle' };

const SELF_TEST_CHIP = {
  idle: ['Not run', 'neutral'],
  running: ['Running…', 'neutral'],
  passed: ['Passed — offline only', 'success'],
  failed: ['Failed — offline only', 'danger'],
  blocked: ['Blocked', 'warning'],
  error: ['Error', 'danger'],
};

function renderSelfTest() {
  const [label, tone] = SELF_TEST_CHIP[selfTest.state] ?? SELF_TEST_CHIP.idle;
  replace(nodes.selfTestStatus, [chip(label, tone)]);
  nodes.selfTestRun.disabled = !selfTestAvailable || selfTest.state === 'running';
  nodes.selfTestSummary.textContent = selfTest.summary ?? '';
  replace(
    nodes.selfTestChecks,
    (selfTest.checks ?? []).map((check) =>
      el('li', { class: 'mh-selftest-check' }, [
        el('div', { class: 'mh-selftest-check-head' }, [
          chip(check.passed ? 'Pass' : 'Fail', check.passed ? 'success' : 'danger'),
          el('span', { class: 'mh-selftest-check-label', text: check.label }),
        ]),
        el('div', { class: 'mh-selftest-check-detail', text: check.detail }),
      ]),
    ),
  );
}

/**
 * Run the offline self-test through the real `/api/self-test` route. This is
 * never faked and never uses the browser smoke driver's test-hook seam: the
 * whole point is that it is safe to run for real, always, with zero setup.
 */
async function runSelfTestCheck() {
  if (selfTest.state === 'running') return;
  if (!selfTestAvailable) {
    announce(localSessionAuth.message || 'Open the secure launch URL shown in the terminal.');
    return;
  }
  selfTest = { state: 'running' };
  renderSelfTest();
  try {
    const response = await fetch('/api/self-test', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    const payload = await response.json();
    selfTest = {
      state: response.ok ? payload.state : (payload.state ?? 'error'),
      summary: payload.summary ?? '',
      checks: payload.checks ?? [],
    };
  } catch (error) {
    selfTest = { state: 'error', summary: `The self-test request failed: ${error.message}`, checks: [] };
  }
  renderSelfTest();
  announce(`Offline self-test ${selfTest.state}. ${selfTest.summary ?? ''}`);
}

/* ---------------------------------------------------------------- tabs */

function renderTabs(model) {
  replace(
    nodes.tablist,
    model.tabs.map((tab) =>
      el(
        'button',
        {
          type: 'button',
          class: 'tab',
          role: 'tab',
          id: `tab-${tab.id}`,
          'aria-selected': tab.id === model.activeTab ? 'true' : 'false',
          'aria-controls': `panel-${tab.id}`,
          tabindex: tab.id === model.activeTab ? '0' : '-1',
          onclick: () => state.setActiveTab(tab.id),
          onkeydown: onTabKeydown,
        },
        [
          tab.label,
          tab.id === 'code' && tab.count > 0 ? chip(String(tab.count), 'warning', { mono: true }) : null,
          tab.id === 'response' && tab.state !== 'not-run' ? chip(tab.state, 'neutral', { mono: true }) : null,
        ],
      ),
    ),
  );
  for (const id of TABS) {
    nodes.panels[id].hidden = id !== model.activeTab;
  }
}

function onTabKeydown(event) {
  // Roving tabindex with automatic activation: move relative to the tab the
  // key was pressed on, not to whatever happens to be active in the model.
  const fromId = event.currentTarget?.id?.replace(/^tab-/, '');
  const index = TABS.indexOf(fromId);
  if (index < 0) return;
  let next = null;
  if (event.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length];
  else if (event.key === 'ArrowLeft') next = TABS[(index - 1 + TABS.length) % TABS.length];
  else if (event.key === 'Home') next = TABS[0];
  else if (event.key === 'End') next = TABS[TABS.length - 1];
  if (!next) return;
  event.preventDefault();
  state.setActiveTab(next);
  document.getElementById(`tab-${next}`)?.focus();
}

/* ------------------------------------------------------------ actions */

async function copyText(text) {
  // Neither the plan nor the configuration document holds a secret value, and
  // this re-checks before the clipboard ever sees the string.
  try {
    assertNoSecretValues(text, state.secretValues(), 'Copied text');
  } catch {
    announce('Copy refused: the text contained a credential.');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    announce('Copied. Credentials are placeholders, not values.');
  } catch {
    announce('Copy failed. Select the text and copy it manually.');
  }
}

function downloadText(fileName, text, mimeType) {
  try {
    assertNoSecretValues(text, state.secretValues(), 'Downloaded file');
  } catch {
    announce('Download refused: the file contained a credential.');
    return;
  }
  const blob = new Blob([text], { type: `${mimeType}; charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: fileName });
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  announce(`${fileName} downloaded. It carries placeholders, never a credential.`);
}

/** The catalogue-shaped public inputs for one sample. Never a secret. */
function publicInputsFor(sample) {
  const inputs = {};
  for (const entry of sample.configurationEntries) {
    if (entry.secret) continue;
    const value = state.read(entry.path);
    if (value !== undefined) inputs[entry.path] = value;
  }
  return inputs;
}

/** The transient secrets this sample declares, and only those. */
function secretsFor(sample) {
  const secrets = {};
  for (const entry of sample.configurationEntries) {
    if (!entry.secret) continue;
    const value = state.read(entry.path);
    if (typeof value === 'string' && value.length > 0) secrets[entry.path] = value;
  }
  return secrets;
}

async function runSelected() {
  const sample = getSample(state.selectedSampleId);
  const identity = buildExecutionIdentityModel({
    sampleId: sample.id,
    contextState: executionContextState,
    loginState: azureLoginState,
    azureAuthCapability,
    subscriptionsState: azureSubscriptionsState,
    runInFlight: running,
  });
  if (!executionIdentityIsCurrent(sample, identity)) {
    announce(`Not run: ${identity.summary}`);
    render();
    return;
  }
  const acknowledged = state.isAcknowledged(sample.id);
  const { plan, validation } = buildSamplePlan(sample, (path) => state.read(path));
  if (!plan) {
    announce('Not run: required values are missing.');
    render();
    return;
  }
  running = true;
  runningSampleId = sample.id;
  results.set(
    sample.id,
    createRunProgress({
      sampleId: sample.id,
      mode: runtimeProbe.mode,
      executorKind: capability.kind,
    }),
  );
  state.setActiveTab('response');
  announce(`Running ${sample.title}…`);
  const result = await runPlan(executor, plan, {
    sampleId: sample.id,
    inputs: publicInputsFor(sample),
    secrets: secretsFor(sample),
    acknowledgement: acknowledgementFor(sample, acknowledged),
    acknowledgementPayload: acknowledged ? { accepted: true, sampleId: sample.id } : null,
    validation,
    onProgress: (event) => applyRunProgress(sample, event),
  });
  // Consent is per run, so it is spent whether or not the run got anywhere.
  state.consumeAcknowledgement(sample.id);
  applyUpdates(result);
  const progress = reduceRunProgress(results.get(sample.id), { type: 'result', result });
  const displayedResult = Object.freeze({
    ...result,
    meta: Object.freeze({
      ...(result.meta ?? {}),
      runId: result.meta?.runId ?? progress.meta.runId,
      workspace: result.meta?.workspace ?? progress.meta.workspace,
      evidenceClass: progress.meta.evidenceClass,
    }),
  });
  results.set(sample.id, displayedResult);
  running = false;
  runningSampleId = null;
  render();
  announce(`${sample.title}: ${result.summary}`);
}

function applyRunProgress(sample, event) {
  if (!event || typeof event !== 'object') return;
  try {
    assertNoSecretValues(event, state.secretValues(), 'Execution progress');
  } catch {
    announce('A progress update was hidden because it contained a credential.');
    return;
  }
  const current =
    results.get(sample.id) ??
    createRunProgress({
      sampleId: sample.id,
      mode: runtimeProbe.mode,
      executorKind: capability.kind,
    });
  const next = reduceRunProgress(current, event);
  results.set(sample.id, next);
  render();
}

/**
 * Apply what the run discovered.
 *
 * Public values fill in the generated fields later recipes need. A returned
 * credential goes straight into the in-memory secret store and is never
 * rendered, persisted, or logged.
 */
function applyUpdates(result) {
  for (const [path, value] of Object.entries(result.configurationUpdates ?? {})) {
    if (fieldByPath(path)) state.set(path, value, fieldByPath(path));
  }
  for (const [path, value] of Object.entries(result.secretUpdates ?? {})) {
    if (fieldByPath(path)) state.set(path, value, fieldByPath(path));
  }
}

async function cancelRun() {
  if (!running) return;
  announce('Cancelling…');
  await executor.cancel?.();
}

/* ------------------------------------------------------------- render */

function render() {
  const focusedId = document.activeElement?.id ?? '';
  const focusedParameter = document.activeElement?.closest?.('[data-parameter-path]')?.dataset.parameterPath;
  const activeControl = focusedId ? document.activeElement : null;
  const activeSecretValue = activeControl?.type === 'password' ? activeControl.value : null;
  const selection =
    activeControl && typeof activeControl.selectionStart === 'number'
      ? { start: activeControl.selectionStart, end: activeControl.selectionEnd }
      : null;
  const priorPane = document.getElementById('code-parameters');
  const paneState = priorPane ? { open: priorPane.open, scrollTop: priorPane.scrollTop } : null;
  const disclosureState = new Map(
    [...document.querySelectorAll('#panel-code details[data-disclosure-key]')].map((details) => [
      details.dataset.disclosureKey,
      details.open,
    ]),
  );

  const directory = buildDirectoryModel({
    query: state.directoryQuery,
    selectedSampleId: state.selectedSampleId,
  });
  renderDirectory({
    container: nodes.directoryGroups,
    countNode: nodes.directoryCount,
    model: directory,
    onSelect: (id) => state.selectSample(id),
  });
  renderSampleSelect({
    select: nodes.sampleSelect,
    model: buildDirectoryModel({ selectedSampleId: state.selectedSampleId }),
    selectedId: state.selectedSampleId,
    onSelect: (id) => state.selectSample(id),
  });

  const sample = getSample(state.selectedSampleId);
  const executionIdentity = buildExecutionIdentityModel({
    sampleId: sample.id,
    contextState: executionContextState,
    loginState: azureLoginState,
    azureAuthCapability,
    subscriptionsState: azureSubscriptionsState,
    runInFlight: running,
  });
  const identityCurrent = executionIdentityIsCurrent(sample, executionIdentity);
  const model = buildWorkbenchModel({
    sample,
    read: (path) => state.read(path),
    hasSecret: (path) => state.hasSecret(path),
    isTouched: (path) => state.isTouched(path),
    secrets: {},
    activeTab: state.activeTab,
    acknowledged: state.isAcknowledged(sample.id),
    result: results.get(sample.id) ?? null,
    running: running && runningSampleId === sample.id,
    runId: results.get(sample.id)?.meta?.runId ?? null,
    capability,
    runtimeProbe,
    sourceState: sourceStates.get(sample.id) ?? { status: 'loading' },
    sourceValidationState: {
      ...(sourceValidationStates.get(sample.id) ?? { status: 'not-run' }),
      available: sourceValidationAvailable,
    },
  });

  nodes.title.textContent = model.sample.title;
  nodes.summary.textContent = model.sample.summary;
  replace(nodes.meta, [
    chip(model.sample.groupTitle, 'neutral'),
    chip(model.sample.risk.badge.label, model.sample.risk.badge.tone),
    chip(`cell ${model.sample.sourceCells.join(', ')}`, 'cloud', { mono: true }),
  ]);

  renderTabs(model);
  renderGuide(nodes.panels.guide, model.guide);
  renderSource(nodes.panels.code, model.source, model.sourceValidation, model.configure, executionIdentity, {
    onRetry: () => loadProtectedSource(sample.id),
    onConfigure: openParameterField,
    onValidate: validateProtectedSource,
    onChange: setParameter,
    onBlur: commitParameter,
    onCopy: copyText,
    onDownload: downloadText,
    onReview: openReview,
    onRefreshIdentity: refreshExecutionContext,
    onSignIn: startSystemAzureLogin,
    onCancelLogin: cancelSystemAzureLogin,
    onRefreshSubscriptions: loadAzureSubscriptions,
    onSelectSubscription: selectAzureSubscription,
    onActivateSubscription: activateAzureSubscription,
    wrapSource: sourceWrap,
    onToggleWrap: toggleSourceWrap,
  });
  renderRequest(nodes.panels.request, model.request, {
    onCopy: copyText,
    canRun:
      model.canRun &&
      identityCurrent &&
      !running,
    runBlockedReason:
      !identityCurrent
        ? executionIdentity.summary
        : model.runBlockedReason,
    acknowledged: state.isAcknowledged(sample.id),
    onAcknowledge: (checked) => state.setAcknowledged(sample.id, checked),
    onRun: runSelected,
    onCancel: cancelRun,
    running,
    runtime: model.runtime,
    environment: model.environment,
  });
  renderResponse(nodes.panels.response, model.response);

  const nextPane = document.getElementById('code-parameters');
  if (nextPane && paneState) {
    nextPane.open = paneState.open;
    nextPane.scrollTop = paneState.scrollTop;
  }
  for (const details of document.querySelectorAll('#panel-code details[data-disclosure-key]')) {
    if (disclosureState.has(details.dataset.disclosureKey)) {
      details.open = disclosureState.get(details.dataset.disclosureKey);
    }
  }
  const nextFocused =
    (focusedId && document.getElementById(focusedId)) ||
    (focusedParameter && document.getElementById(`f-${focusedParameter.replace(/[^a-zA-Z0-9-]/g, '-')}`));
  if (nextFocused) {
    if (activeSecretValue !== null && nextFocused.type === 'password') {
      nextFocused.value = activeSecretValue;
    }
    nextFocused.focus({ preventScroll: true });
    if (selection && typeof nextFocused.setSelectionRange === 'function') {
      nextFocused.setSelectionRange(selection.start, selection.end);
    }
  }
}

/* ---------------------------------------------------------------- boot */
nodes.sourceFile.textContent = CATALOGUE.sourceNotebook.fileName;
nodes.sourceHash.textContent = `sha256 ${CATALOGUE.sourceNotebook.sha256}`;
nodes.directorySearch.addEventListener('input', (event) => state.setDirectoryQuery(event.target.value));
nodes.directoryToggle.addEventListener('click', toggleDirectory);
nodes.selfTestRun.addEventListener('click', runSelfTestCheck);

state.subscribe((reason) => {
  if (reason === 'selection' && validationRequest) {
    const abortedSampleId = validationRequest.sampleId;
    validationRequest.controller.abort();
    validationRequest = null;
    validationRequestVersion += 1;
    sourceValidationStates.set(abortedSampleId, { status: 'not-run' });
  }
  if (reason === 'value' && secretInputInProgress) return;
  if (reason === 'value') scheduleExecutionContext();
  render();
  if (reason === 'selection') {
    sourceRequest?.controller.abort();
    announce(`${getSample(state.selectedSampleId).title} selected.`);
    loadProtectedSource(state.selectedSampleId);
    if (executionContextAvailable && !testExecutionContextOverride) loadExecutionContext(state.selectedSampleId);
  }
});

renderCapability();
renderSelfTest();
render();
loadProtectedSource(state.selectedSampleId);
void (async () => {
  await claimLocalSession();
  await probeCapability();
})();

/*
 * A seam for the browser smoke driver.
 *
 * Real execution needs a live Azure environment, which the test suite must
 * never touch, so the driver installs a fake executor instead. The seam exists
 * only when the page is opened from loopback WITH an explicit `?testExecutor`
 * flag, so a normal session — and any deployed copy — never has it. A "fake
 * success" is therefore not reachable in production.
 */
if (TEST_EXECUTOR_ENABLED) {
  globalThis.__citadelTestHooks = Object.freeze({
    installExecutor(fake) {
      executor = fake;
      capability = fake.describeCapability();
      capabilitySummary = {
        label: 'Local execution ready (test executor)',
        detail: 'A test executor is installed for this page only. Nothing reaches Azure.',
      };
      runtimeProbe = {
        mode: 'execute',
        azureCli: { available: true, version: 'test' },
        python: { available: true, version: 'test', modules: {} },
        accelerator: { available: true, files: 1 },
      };
      clearTimeout(executionContextTimer);
      testExecutionContextOverride = true;
      executionContextRequestVersion += 1;
      executionContextState = {
        status: 'ready',
        context: {
          kind: 'azure-cli',
          label: 'Loopback test identity',
          summary: 'A loopback-only test identity is attached. It cannot contact Azure.',
          state: 'ready-to-attempt',
          code: 'test-only',
          canExecute: true,
          signedInAccount: {
            state: 'signed-in',
            principalName: 'Loopback test executor',
            principalType: 'test',
            tenantId: '',
          },
          executionCredential: {
            type: 'test',
            source: 'loopback-test',
            principalName: 'Loopback test executor',
            principalType: 'test',
            tenantId: '',
          },
          activeCliSubscription: null,
          intendedTarget: null,
          authorization: { state: 'not-checked', label: 'Authorization Not Checked' },
          gateway: null,
          hostedRelay: null,
          guarantees: ['Available only on loopback with the explicit test flag.'],
          futureHostedProcess: null,
        },
      };
      renderCapability();
      render();
    },
    setValue: (path, value) => state.set(path, value, fieldByPath(path)),
    setExecutionContext(context) {
      clearTimeout(executionContextTimer);
      testExecutionContextOverride = true;
      executionContextRequestVersion += 1;
      executionContextState = { status: 'ready', context };
      render();
    },
    setAdvertisedExecutionContext(context) {
      clearTimeout(executionContextTimer);
      testExecutionContextOverride = false;
      executionContextAvailable = true;
      executionContextRequestVersion += 1;
      executionContextState = {
        status: 'ready',
        context,
        fingerprint: executionContextFingerprint(getSample(state.selectedSampleId)),
      };
      render();
    },
    setAzureLogin(login) {
      azureLoginState = { status: 'ready', login };
      render();
    },
    setAzureAuthCapability(capability) {
      azureAuthCapability = { ...azureAuthCapability, ...capability };
      render();
    },
    setAzureSubscriptions(subscriptionsState) {
      azureSubscriptionsState = { ...azureSubscriptionsState, ...subscriptionsState };
      render();
    },
    startSystemAzureLogin,
    cancelSystemAzureLogin,
    loadAzureSubscriptions,
    refreshExecutionContext,
    validateProtectedSource,
    isRunning: () => running,
  });
}
