import { buildWorkbenchModel } from './models.mjs';

export const ACCOUNT_CONTROL_STATES = Object.freeze([
  'login-disabled',
  'signed-out',
  'starting',
  'waiting-system-ui',
  'verifying',
  'cancel-requested',
  'device-fallback-blocked',
  'status-unknown',
  'cancelled',
  'failed',
  'timed-out',
  'ready',
  'subscription-disabled',
  'subscription-mismatch',
]);

const ACCOUNT_CONTROL_STATE_SET = new Set(ACCOUNT_CONTROL_STATES);
const TERMINAL_ACCOUNT_STATES = new Set([
  'device-fallback-blocked',
  'status-unknown',
  'cancelled',
  'failed',
  'timed-out',
]);
const TARGET_PATH = /(subscriptionId|resourceGroupName|apimName|gatewayUrl|endpoint|keyVault|foundry|project)/i;

function safeText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function safeList(value, map) {
  return Array.isArray(value) ? value.map(map).filter(Boolean) : [];
}

function safeAccount(value) {
  if (!value || typeof value !== 'object') return null;
  const id = safeText(value.id);
  const name = safeText(value.name);
  if (!id || !name) return null;
  return Object.freeze({
    id,
    name,
    username: safeText(value.username),
    tenantId: safeText(value.tenantId),
    enabled: value.enabled === true,
  });
}

function safeSubscription(value) {
  if (!value || typeof value !== 'object') return null;
  const id = safeText(value.id);
  const name = safeText(value.name);
  if (!id || !name) return null;
  return Object.freeze({
    id,
    name,
    tenantId: safeText(value.tenantId),
    accountId: safeText(value.accountId),
    enabled: value.enabled === true,
  });
}

export function normalizeAccountControlState(value = {}) {
  const requestedState = safeText(value.state);
  const state = ACCOUNT_CONTROL_STATE_SET.has(requestedState) ? requestedState : 'login-disabled';
  const launchAdvertised =
    value.systemBrowserAzureLogin === true || value.launchMode === 'system-browser';
  const active = ['starting', 'waiting-system-ui', 'verifying', 'cancel-requested'].includes(state);
  const accounts = safeList(value.accounts, safeAccount);
  const subscriptions = safeList(value.subscriptions, safeSubscription);

  return Object.freeze({
    state,
    message:
      safeText(value.message) ||
      (state === 'login-disabled'
        ? 'Account switching is unavailable until the local server advertises a system-browser launch capability.'
        : ''),
    sessionId: safeText(value.sessionId),
    launchMode: launchAdvertised ? 'system-browser' : null,
    canLaunch: launchAdvertised && value.canLaunch === true && !active,
    canCancel: value.canCancel === true && active && Boolean(safeText(value.sessionId)),
    canVerify: value.canVerify === true && !active,
    canSetActive:
      value.canSetActive === true
      && ['ready', 'subscription-disabled', 'subscription-mismatch'].includes(state),
    canSelect: value.canSelect === true && !active,
    subscriptionsBusy: value.subscriptionsBusy === true,
    activeAccountId: safeText(value.activeAccountId),
    activeSubscriptionId: safeText(value.activeSubscriptionId),
    intendedSubscriptionId: safeText(value.intendedSubscriptionId),
    accounts,
    subscriptions,
    active,
    terminal: TERMINAL_ACCOUNT_STATES.has(state),
  });
}

function contextFrom(contextState) {
  return contextState?.status === 'ready' && contextState.context && typeof contextState.context === 'object'
    ? contextState.context
    : null;
}

function credentialLabel(context) {
  if (!context) return 'Not Reported';
  if (context.kind === 'gateway-key') return 'Memory-Only APIM Key';
  if (context.kind === 'hosted-delegated-user') return 'Server-Owned Delegated Azure User Token';
  if (context.kind === 'hosted-relay') return 'Managed Identity + Key Vault Mapping';
  if (context.kind === 'offline-python') return 'Local Parser; No Cloud Credential';
  return 'Citadel Private Azure CLI Session';
}

function humanLabel(context, account) {
  if (context?.kind === 'gateway-key') return 'Browser Session';
  if (context?.kind === 'hosted-relay') return 'Entra Caller';
  return (
    context?.signedInAccount?.principalName ||
    context?.authority?.principalName ||
    account.accounts.find((entry) => entry.id === account.activeAccountId)?.username ||
    account.accounts.find((entry) => entry.id === account.activeAccountId)?.name ||
    'Not Signed In'
  );
}

function runsAsLabel(context) {
  if (!context) return 'Not Reported';
  if (context.kind === 'gateway-key') return 'Gateway Caller';
  if (context.kind === 'hosted-relay') return 'Tenant-Scoped Managed Identity';
  if (context.kind === 'offline-python') return 'Local Python Parser';
  return (
    context.signedInAccount?.principalName ||
    context.authority?.principalName ||
    context.label ||
    'Local Azure CLI Principal'
  );
}

function authorizationModel(context, contextState, account) {
  const contextReady = context?.canExecute === true;
  const ready = contextReady;
  const proven = context?.authorization?.proven === true;
  return Object.freeze({
    ready,
    backendProven: proven,
    state: proven ? 'authorized' : ready ? 'ready-to-attempt' : 'blocked',
    label: proven
      ? context.authorization.label || 'Authorized to operate'
      : ready
        ? 'Ready to Attempt'
        : 'Not Ready',
    detail:
      context?.summary ||
      safeText(contextState?.message) ||
      account.message ||
      'Execution identity and target have not been verified.',
  });
}

export function buildDossierIdentityModel({ contextState = {}, accountControlState = {} } = {}) {
  const context = contextFrom(contextState);
  const account = normalizeAccountControlState(accountControlState);
  const isGateway = context?.kind === 'gateway-key';
  const isHosted = context?.kind === 'hosted-relay';
  const isAzure = context?.kind?.startsWith('azure-cli-') === true || context?.kind === 'hosted-delegated-user';
  const activeSubscription =
    context?.selectedSubscription ?? context?.activeCliSubscription ??
    (context?.subscription
      ? {
          id: context.subscription.activeId,
          name: context.subscription.activeName,
        }
      : null);
  const intendedTarget =
    context?.intendedTarget ??
    (context?.subscription
      ? {
          subscriptionId: context.subscription.configuredId,
          matchesActive: context.subscription.matches,
        }
      : null);
  const subscription =
    activeSubscription || intendedTarget
      ? {
          activeId: safeText(activeSubscription?.id),
          activeName: safeText(activeSubscription?.name),
          configuredId: safeText(intendedTarget?.subscriptionId),
          matches:
            intendedTarget?.matchesActive === true
              ? true
              : intendedTarget?.matchesActive === false
                ? false
                : null,
        }
      : null;
  const target =
    subscription?.configuredId ||
    subscription?.activeName ||
    subscription?.activeId ||
    (context?.gateway?.headerName ? `Gateway Header ${context.gateway.headerName}` : 'Not Reported');

  return Object.freeze({
    state: context?.state ?? (contextState?.status === 'loading' ? 'loading' : 'unavailable'),
    human: humanLabel(context, account),
    runsAs: runsAsLabel(context),
    credential: credentialLabel(context),
    target,
    tenantId: safeText(context?.signedInAccount?.tenantId || context?.authority?.tenantId),
    subscription: subscription
      ? Object.freeze({
          activeId: safeText(subscription.activeId),
          activeName: safeText(subscription.activeName),
          intendedId: safeText(subscription.configuredId),
          matches: subscription.matches === true ? true : subscription.matches === false ? false : null,
        })
      : null,
    authorization: authorizationModel(context, contextState, account),
    accountControl: Object.freeze({
      ...account,
      visible: isAzure && !isGateway && !isHosted,
    }),
    gateway: context?.gateway
      ? Object.freeze({
          keyPresent: context.gateway.keyPresent === true,
          headerName: safeText(context.gateway.headerName),
        })
      : null,
    chain: isHosted
      ? Object.freeze([
          'Entra Caller',
          'Playground Identity',
          'Relay Managed Identity',
          'Key Vault Mapping',
          'Target',
        ])
      : Object.freeze([]),
  });
}

function collectTargetFacts(configure) {
  return configure.groups
    .flatMap((group) => group.fields)
    .filter(
      (field) =>
        field.requirement !== 'secret' &&
        TARGET_PATH.test(field.path) &&
        field.value !== undefined &&
        field.value !== null &&
        field.value !== '',
    )
    .slice(0, 8)
    .map((field) =>
      Object.freeze({
        path: field.path,
        label: field.label,
        value: Array.isArray(field.value) ? field.value.join(', ') : String(field.value),
      }),
    );
}

function destructiveConfirmationText(risk, targetFacts) {
  if (risk?.level !== 'destructive') return '';
  const apim = targetFacts.find((entry) => /apimName$/i.test(entry.path));
  return apim?.value ? `DELETE ${apim.value}` : '';
}

function reviewFingerprint({ sampleId, identity, targetFacts, request }) {
  return JSON.stringify({
    sampleId,
    identity: {
      state: identity.state,
      human: identity.human,
      runsAs: identity.runsAs,
      target: identity.target,
      tenantId: identity.tenantId,
      subscription: identity.subscription,
    },
    targetFacts,
    operation: request.available ? request.fullText : null,
  });
}

function subscriptionLabel(identity) {
  if (!identity.subscription) return '';
  const active = [identity.subscription.activeName, identity.subscription.activeId].filter(Boolean).join(' · ');
  const intended = identity.subscription.intendedId;
  if (active && intended && intended !== identity.subscription.activeId) {
    return `${active} · intended ${intended}`;
  }
  return active || intended;
}

function targetModel(identity, targetFacts) {
  const fact = (pattern) => targetFacts.find((entry) => pattern.test(entry.path))?.value ?? '';
  const apimName = fact(/apimName$/i);
  const resourceGroup = fact(/resourceGroupName$/i);
  const exactFacts = targetFacts.map((entry) => `${entry.label}: ${entry.value}`);
  return Object.freeze({
    exact: exactFacts.join(' · ') || identity.target,
    apimName,
    resourceGroup,
    tenant: identity.tenantId,
    subscription: subscriptionLabel(identity),
    actionLabel: apimName,
    fingerprint: JSON.stringify(targetFacts),
  });
}

export function buildLedgerAction({
  blockingCount = 0,
  canAttempt = false,
  running = false,
  stage = 'configure',
  firstBlockerPath = '',
} = {}) {
  if (running) {
    return Object.freeze({ id: 'cancel', label: 'Cancel Run', target: 'output', disabled: false });
  }
  if (blockingCount > 0) {
    return Object.freeze({
      id: 'resolve',
      label: `Resolve ${blockingCount} Required Input${blockingCount === 1 ? '' : 's'}`,
      target: firstBlockerPath || 'inputs',
      disabled: false,
    });
  }
  if (stage === 'configure' || !canAttempt) {
    return Object.freeze({ id: 'review', label: 'Review Sample', target: 'review', disabled: false });
  }
  return Object.freeze({ id: 'run', label: 'Run Sample', target: 'output', disabled: false });
}

export function buildDossierModel({
  contextState = {},
  accountControlState = {},
  stage = 'configure',
  selectedSourceCellIndex = null,
  ...workbenchOptions
}) {
  const workbench = buildWorkbenchModel(workbenchOptions);
  const identity = buildDossierIdentityModel({ contextState, accountControlState });
  const canAttempt = workbench.canRun && identity.authorization.ready;
  const selectedCell =
    workbench.source.cells.find((cell) => cell.cellIndex === selectedSourceCellIndex) ??
    workbench.source.cells[0] ??
    null;
  const targetFacts = collectTargetFacts(workbench.configure);
  const target = targetModel(identity, targetFacts);
  const reviewed = ['review', 'run', 'result'].includes(stage);
  const canRunWithoutAcknowledgement =
    workbench.configure.satisfied &&
    workbench.request.available &&
    workbench.runtime.ready &&
    identity.authorization.ready;
  const runBlockedReason =
    workbench.runBlockedReason ||
    (identity.authorization.ready ? '' : identity.authorization.detail);
  const reviewDecision = Object.freeze({
    title: workbench.sample.title,
    shortTitle: workbench.sample.shortTitle,
    reviewed,
    running: workbench.response.running,
    canRun: canRunWithoutAcknowledgement,
    runAllowed: canRunWithoutAcknowledgement,
    runBlockedReason,
    requiredInputs: workbench.configure.blocking.map((entry) =>
      Object.freeze({
        ...entry,
        href: `#f-${entry.path.replace(/[^a-zA-Z0-9-]/g, '-')}`,
      }),
    ),
    requiredInputCount: workbench.configure.blockingCount,
    identity: Object.freeze({
      human: identity.human,
      execution: identity.runsAs,
      tenant: identity.tenantId,
      subscription: subscriptionLabel(identity),
      fingerprint: JSON.stringify({
        state: identity.state,
        human: identity.human,
        runsAs: identity.runsAs,
        tenantId: identity.tenantId,
        subscription: identity.subscription,
      }),
    }),
    target,
    targetFacts,
    authorization: Object.freeze({
      ready: identity.authorization.ready,
      backendProven: identity.authorization.backendProven,
      label: identity.authorization.label,
      summary: identity.authorization.detail,
    }),
    risk: workbench.sample.risk,
    request: workbench.request,
    operation: Object.freeze({
      summary: workbench.request.available
        ? `Review the exact generated operation for ${workbench.sample.shortTitle}.`
        : workbench.request.reason,
      text: workbench.request.available ? workbench.request.fullText : workbench.request.reason,
      steps: workbench.request.steps ?? [],
    }),
    acknowledgement: workbench.request.acknowledgement,
    effect: workbench.sample.risk.effect,
    blastRadius: workbench.sample.risk.blastRadius,
    reversibility: workbench.sample.risk.reversibility,
    deviations: workbench.request.deviations ?? [],
    placeholders: workbench.request.secretRefs ?? [],
    confirmationText: destructiveConfirmationText(workbench.sample.risk, targetFacts),
    confirmation: Object.freeze({
      requiredText: destructiveConfirmationText(workbench.sample.risk, targetFacts),
    }),
    inputFingerprint: '',
    fingerprint: '',
    canAttempt,
  });
  const fingerprint = reviewFingerprint({
    sampleId: workbench.sample.id,
    identity,
    targetFacts,
    request: workbench.request,
  });
  const action = buildLedgerAction({
    blockingCount: workbench.configure.blockingCount,
    canAttempt,
    running: workbench.response.running,
    stage,
    firstBlockerPath: workbench.configure.blocking[0]?.path,
  });
  const reviewModel = Object.freeze({
    ...reviewDecision,
    inputFingerprint: fingerprint,
    confirmationFingerprint: fingerprint,
    fingerprint,
  });

  return Object.freeze({
    ...workbench,
    stage,
    identity,
    canAttempt,
    targetFacts,
    sourceInspector: Object.freeze({
      ...workbench.source,
      selectedCellIndex: selectedCell?.cellIndex ?? null,
      selectedCell,
    }),
    reviewDecision: reviewModel,
    ledger: Object.freeze({ ...reviewModel, action }),
  });
}
