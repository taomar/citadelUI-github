/**
 * Local execution identity, system Azure sign-in, and subscription selection.
 *
 * Browser requests carry only fixed protocol fields and server-issued IDs.
 * Every Azure CLI executable, argument, environment override, timeout, and
 * output bound is owned here.
 */

import {
  FUTURE_HOSTED_PROCESS_CONTEXT,
  authorizationNotChecked,
  guarantees,
  hostedRelayContext,
  isAzureCliContext,
  sampleExecutionContext,
  unavailableSampleContext,
} from '../core/executionContext.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../core/types.mjs';
import { createRedactor } from './redaction.mjs';
import { RequestRefused } from './runRequest.mjs';
import { realTransports } from './transports.mjs';

const ACCOUNT_QUERY = '{id:id,name:name,tenantId:tenantId,user:{name:user.name,type:user.type},isDefault:isDefault,state:state}';
const SUBSCRIPTION_QUERY = '[].{id:id,name:name,tenantId:tenantId,user:user,isDefault:isDefault,state:state}';
export const ACCOUNT_SHOW_ARGS = Object.freeze(['account', 'show', '--query', ACCOUNT_QUERY, '-o', 'json']);
export const ACCOUNT_LIST_ARGS = Object.freeze(['account', 'list', '--query', SUBSCRIPTION_QUERY, '-o', 'json']);
export const SYSTEM_AZURE_LOGIN_ARGS = Object.freeze(['login']);
export const SYSTEM_AZURE_LOGIN_ENV = Object.freeze({
  AZURE_CORE_LOGIN_EXPERIENCE_V2: 'off',
  AZURE_CORE_NO_COLOR: 'true',
  AZURE_CORE_OUTPUT: 'none',
});
export const SYSTEM_AZURE_LOGIN_ID = 'azure-system-login';
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const CONTEXT_REQUEST_KEYS = Object.freeze([
  'protocolVersion',
  'sampleId',
  'configuredSubscriptionId',
  'gateway',
]);
const LOGIN_START_KEYS = Object.freeze(['protocolVersion']);
const LOGIN_TARGET_KEYS = Object.freeze(['protocolVersion', 'loginId']);
const SUBSCRIPTION_LIST_KEYS = Object.freeze(['protocolVersion']);
const SUBSCRIPTION_ACTIVATE_KEYS = Object.freeze(['protocolVersion', 'subscriptionId']);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_LOGIN_STATES = new Set([
  'starting',
  'waiting-system-ui',
  'verifying',
  'cancel-requested',
]);
const TERMINAL_LOGIN_STATES = new Set([
  'login-disabled',
  'device-fallback-blocked',
  'status-unknown',
  'cancelled',
  'failed',
  'timed-out',
  'ready',
]);
const DEVICE_FALLBACK_MARKERS = Object.freeze(
  [
    'aka.ms/devicelogin',
    'microsoft.com/devicelogin',
    '/oauth2/deviceauth',
    '/oauth2/devicecode',
    '/oauth2/v2.0/deviceauth',
    '/oauth2/v2.0/devicecode',
    'use a web browser to open',
    'enter code',
    'enter the code',
    'enter the displayed code',
  ].map((marker) =>
    Object.freeze({
      marker,
      failure: Object.freeze(markerFailureTable(marker)),
    }),
  ),
);
const SUBSCRIPTION_WARNING =
  'Changing the active subscription affects only this Citadel playground launch.';

export function validateExecutionContextRequest(payload, catalogue) {
  exactObject(payload, CONTEXT_REQUEST_KEYS, 'execution-context');
  requireProtocol(payload.protocolVersion);
  if (typeof payload.sampleId !== 'string' || !catalogue.byId.has(payload.sampleId)) {
    throw new RequestRefused(`"${payload.sampleId}" is not a sample in this catalogue.`, { code: 'unknown-sample' });
  }
  if (
    payload.configuredSubscriptionId !== null &&
    (typeof payload.configuredSubscriptionId !== 'string' ||
      payload.configuredSubscriptionId.length > 128 ||
      payload.configuredSubscriptionId.includes('\0'))
  ) {
    throw new RequestRefused('`configuredSubscriptionId` must be a bounded string or null.');
  }
  if (payload.gateway !== null) {
    exactObject(payload.gateway, ['keyPresent', 'headerName'], 'gateway');
    if (typeof payload.gateway.keyPresent !== 'boolean') {
      throw new RequestRefused('`gateway.keyPresent` must be a boolean.');
    }
    if (typeof payload.gateway.headerName !== 'string' || !HEADER_NAME.test(payload.gateway.headerName)) {
      throw new RequestRefused('`gateway.headerName` must be a valid HTTP header name.');
    }
  }

  const descriptor = sampleExecutionContext(payload.sampleId);
  if (descriptor.kind !== 'gateway-key' && payload.gateway !== null) {
    throw new RequestRefused('This sample does not accept a gateway-key projection.', {
      code: 'unexpected-gateway-projection',
    });
  }

  return Object.freeze({
    sampleId: payload.sampleId,
    configuredSubscriptionId: normaliseOptional(payload.configuredSubscriptionId),
    gateway: payload.gateway
      ? Object.freeze({ keyPresent: payload.gateway.keyPresent, headerName: payload.gateway.headerName })
      : null,
  });
}

export function validateLoginStartRequest(payload) {
  exactObject(payload, LOGIN_START_KEYS, 'Azure system login start');
  requireProtocol(payload.protocolVersion);
}

export function validateLoginTargetRequest(payload) {
  exactObject(payload, LOGIN_TARGET_KEYS, 'Azure system login');
  requireProtocol(payload.protocolVersion);
  if (payload.loginId !== SYSTEM_AZURE_LOGIN_ID) {
    throw new RequestRefused('The fixed Azure system login ID is required.', { code: 'invalid-login-id' });
  }
  return payload.loginId;
}

export function validateSubscriptionListRequest(payload) {
  exactObject(payload, SUBSCRIPTION_LIST_KEYS, 'Azure subscription list');
  requireProtocol(payload.protocolVersion);
}

export function validateSubscriptionActivateRequest(payload) {
  exactObject(payload, SUBSCRIPTION_ACTIVATE_KEYS, 'Azure subscription activation');
  requireProtocol(payload.protocolVersion);
  if (typeof payload.subscriptionId !== 'string' || !GUID.test(payload.subscriptionId)) {
    throw new RequestRefused('`subscriptionId` must be one GUID.', { code: 'invalid-subscription-id' });
  }
  return payload.subscriptionId.toLowerCase();
}

export function createExecutionContextManager({
  playgroundRoot,
  mode = 'preview',
  relay = Object.freeze({ enabled: false }),
  transports = realTransports(),
  allowSystemAzureLogin = false,
  loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof playgroundRoot !== 'string' || playgroundRoot === '') {
    throw new Error('The execution-context manager requires the playground root.');
  }
  if (!Number.isInteger(loginTimeoutMs) || loginTimeoutMs < 1000 || loginTimeoutMs > 15 * 60 * 1000) {
    throw new Error('The Azure login timeout must be between 1 second and 15 minutes.');
  }

  const systemLoginAllowed = mode === 'execute' && allowSystemAzureLogin === true;
  let login = null;
  let activeRunLeases = 0;
  let subscriptionMutationInFlight = false;
  let subscriptionOperation = null;
  const subscriptionReads = new Set();
  let closed = false;

  async function describe(payload, catalogue, { signal, operatorAuthorization } = {}) {
    const request = validateExecutionContextRequest(payload, catalogue);
    return responseFor(
      request.sampleId,
      await contextFor(request, { useRelay: true, signal, operatorAuthorization }),
    );
  }

  async function forRun({
    sampleId,
    configuredSubscriptionId = null,
    gateway = null,
    reviewedIdentity = null,
  }, { signal } = {}) {
    const context = await contextFor(
      {
        sampleId,
        configuredSubscriptionId: normaliseOptional(configuredSubscriptionId),
        gateway,
      },
      { useRelay: false, signal },
    );
    if (!context.canExecute) {
      throw new RequestRefused(context.summary, { status: 409, code: context.code ?? 'execution-context-unavailable' });
    }
    if (isAzureCliContext(context.kind)) requireReviewedIdentity(context, reviewedIdentity);
    return context;
  }

  async function contextFor(
    { sampleId, configuredSubscriptionId, gateway },
    { useRelay, signal, operatorAuthorization },
  ) {
    const descriptor = sampleExecutionContext(sampleId);
    if (useRelay && relay.enabled) {
      return hostedRelayContext({
        available: relay.allowedSampleIds?.includes(sampleId) === true,
        hosted: relay.hosted === true,
        authorized: relay.hosted === true ? operatorAuthorization?.ok === true : null,
      });
    }
    if (mode !== 'execute') return unavailableSampleContext(descriptor);
    if (descriptor.kind === 'gateway-key') return gatewayContext(descriptor, gateway);

    if (!isAzureCliContext(descriptor.kind)) {
      throw new Error(`Unsupported execution-context kind "${descriptor.kind}".`);
    }
    const account = await readAzureCliAccount({ signal });
    return azureContext(sampleId, descriptor, account, configuredSubscriptionId, {
      systemLoginAllowed,
    });
  }

  async function readAzureCliAccount({ signal } = {}) {
    let result;
    try {
      result = await transports.spawn({
        executable: 'az',
        args: [...ACCOUNT_SHOW_ARGS],
        cwd: playgroundRoot,
        signal,
        timeoutMs: 30_000,
        maxOutputBytes: 32 * 1024,
        allowedExecutables: ['az'],
      });
    } catch {
      return Object.freeze({ signedIn: false, code: signal?.aborted ? 'azure-cli-cancelled' : 'azure-cli-unavailable' });
    }
    if (result.timedOut) return Object.freeze({ signedIn: false, code: 'azure-cli-timeout' });
    if (result.aborted || signal?.aborted) return Object.freeze({ signedIn: false, code: 'azure-cli-cancelled' });
    if (result.code !== 0) {
      return Object.freeze({
        signedIn: false,
        code: result.spawnFailed || azureCliUnavailable(result) ? 'azure-cli-unavailable' : 'signed-out',
      });
    }
    let data;
    try {
      data = JSON.parse(String(result.stdout ?? '').trim());
    } catch {
      return Object.freeze({ signedIn: false, code: 'account-context-invalid' });
    }
    return parseAccount(data);
  }

  function startSystemLogin() {
    requireSystemAzureControls();
    requireOpenForMutation();
    if (login?.inFlight) {
      throw new RequestRefused('An Azure CLI system sign-in is already in progress.', {
        status: 409,
        code: 'login-in-progress',
      });
    }
    if (subscriptionMutationInFlight) {
      throw new RequestRefused('Azure CLI subscription activation is already in progress.', {
        status: 409,
        code: 'subscription-activation-in-progress',
      });
    }
    if (subscriptionReads.size > 0) {
      throw new RequestRefused('Azure CLI subscription status is being refreshed.', {
        status: 409,
        code: 'subscription-read-in-progress',
      });
    }
    requireNoActiveRuns();
    const startedAt = now();
    const record = {
      id: SYSTEM_AZURE_LOGIN_ID,
      state: 'starting',
      code: null,
      message: 'Preparing Azure CLI system sign-in.',
      accountChange: 'unverified',
      startedAt,
      updatedAt: startedAt,
      expiresAt: startedAt + loginTimeoutMs,
      controller: new AbortController(),
      verificationController: null,
      context: null,
      inFlight: true,
      cancelRequested: false,
      deviceFallbackDetected: false,
    };
    login = record;
    record.promise = runSystemLogin(record).finally(() => {
      record.inFlight = false;
    });
    return loginResponse(record);
  }

  function statusSystemLogin(loginId) {
    requireSystemAzureControls();
    return loginResponse(requireLogin(loginId));
  }

  function currentSystemLogin() {
    requireSystemAzureControls();
    return login?.inFlight ? loginResponse(login) : null;
  }

  function cancelSystemLogin(loginId) {
    requireSystemAzureControls();
    const record = requireLogin(loginId);
    if (record.inFlight && ACTIVE_LOGIN_STATES.has(record.state)) {
      record.cancelRequested = true;
      updateLogin(record, {
        state: 'cancel-requested',
        code: 'cancel-requested',
        message: 'Cancellation requested. Azure CLI account status is being rechecked.',
      });
      record.controller.abort();
    }
    return loginResponse(record);
  }

  async function runSystemLogin(record) {
    const before = await readAzureCliAccount({ signal: record.controller.signal });
    if (login !== record) return;
    if (record.cancelRequested) {
      await finishCancelledLogin(record, before);
      return;
    }

    updateLogin(record, {
      state: 'waiting-system-ui',
      code: null,
      message: 'Complete sign-in in the Windows account dialog or your system browser.',
    });

    const fallbackDetectors = Object.freeze({
      stdout: createDeviceFallbackDetector(),
      stderr: createDeviceFallbackDetector(),
    });
    const onOutput = ({ stream, text }) => {
      if (login !== record || record.deviceFallbackDetected || record.cancelRequested) return;
      const detector = fallbackDetectors[stream];
      if (!detector?.observe(text)) return;
      record.deviceFallbackDetected = true;
      updateLogin(record, {
        state: 'device-fallback-blocked',
        code: 'device-fallback-blocked',
        message:
          'Azure CLI attempted a device-code fallback, which is unavailable because this launch never exposes its private CLI session to a terminal.',
      });
      record.controller.abort();
    };

    let result;
    try {
      result = await transports.spawn({
        executable: 'az',
        args: [...SYSTEM_AZURE_LOGIN_ARGS],
        cwd: playgroundRoot,
        env: { ...SYSTEM_AZURE_LOGIN_ENV },
        signal: record.controller.signal,
        timeoutMs: loginTimeoutMs,
        maxOutputBytes: 64 * 1024,
        allowedExecutables: ['az'],
        onOutput,
        captureOutput: false,
        environmentProfile: 'system-browser',
      });
    } catch {
      if (record.deviceFallbackDetected) return;
      if (record.cancelRequested) {
        await finishCancelledLogin(record, before);
        return;
      }
      updateLogin(record, {
        state: 'failed',
        code: 'login-failed',
        message: 'Azure CLI system sign-in could not be started.',
      });
      return;
    } finally {
      fallbackDetectors.stdout.clear();
      fallbackDetectors.stderr.clear();
    }

    if (login !== record || record.deviceFallbackDetected) return;
    if (result.timedOut && !record.cancelRequested) {
      updateLogin(record, {
        state: 'timed-out',
        code: 'login-timeout',
        message: 'Azure CLI system sign-in timed out.',
      });
      return;
    }

    updateLogin(record, {
      state: 'verifying',
      code: null,
      message: record.cancelRequested
        ? 'Cancellation requested. Checking whether sign-in completed first.'
        : 'Azure CLI returned. Verifying the signed-in account.',
    });
    const after = await verifyLoginAccount(record);
    if (login !== record) return;
    const accountChange = compareAccounts(before, after);
    record.accountChange = accountChange;

    if (record.cancelRequested) {
      if (after.signedIn && (result.code === 0 || accountChange === 'switched')) {
        finishReadyLogin(record, after, accountChange);
      } else if (!after.signedIn && after.code !== 'signed-out') {
        finishUnknownLogin(record, after.code, accountChange);
      } else {
        updateLogin(record, {
          state: 'cancelled',
          code: 'login-cancelled',
          message: 'Azure CLI system sign-in was cancelled.',
          context: after.signedIn ? safeLoginContext(after) : null,
        });
      }
      return;
    }

    if (after.signedIn && (result.code === 0 || accountChange === 'switched')) {
      finishReadyLogin(record, after, accountChange);
      return;
    }
    if (result.code === 0) {
      finishUnknownLogin(record, after.code, accountChange);
      return;
    }
    updateLogin(record, {
      state: 'failed',
      code: result.spawnFailed || azureCliUnavailable(result) ? 'azure-cli-unavailable' : 'login-failed',
      message:
        result.spawnFailed || azureCliUnavailable(result)
          ? 'Azure CLI is not available, so system sign-in could not start.'
          : 'Azure CLI system sign-in failed. This launch cannot fall back to a terminal because its private CLI session is not exposed.',
    });
  }

  async function finishCancelledLogin(record, before) {
    updateLogin(record, {
      state: 'verifying',
      code: null,
      message: 'Cancellation requested. Checking whether sign-in completed first.',
    });
    const after = await verifyLoginAccount(record);
    if (login !== record) return;
    const accountChange = compareAccounts(before, after);
    record.accountChange = accountChange;
    if (after.signedIn && accountChange === 'switched') {
      finishReadyLogin(record, after, accountChange);
      return;
    }
    if (!after.signedIn && after.code !== 'signed-out') {
      finishUnknownLogin(record, after.code, accountChange);
      return;
    }
    updateLogin(record, {
      state: 'cancelled',
      code: 'login-cancelled',
      message: 'Azure CLI system sign-in was cancelled.',
      context: after.signedIn ? safeLoginContext(after) : null,
    });
  }

  function finishReadyLogin(record, account, accountChange) {
    record.context = safeLoginContext(account);
    updateLogin(record, {
      state: 'ready',
      code: null,
      message:
        accountChange === 'switched'
          ? 'Azure CLI system sign-in completed and the signed-in account changed.'
          : accountChange === 'unchanged'
            ? 'Azure CLI system sign-in completed; the signed-in account is unchanged.'
            : 'Azure CLI system sign-in completed; the account change could not be verified.',
    });
  }

  function finishUnknownLogin(record, code, accountChange) {
    updateLogin(record, {
      state: 'status-unknown',
      code: 'status-unknown',
      message: loginRefreshFailureMessage(code),
      context: null,
      accountChange,
    });
  }

  async function listSubscriptions({ signal } = {}) {
    requireSystemAzureControls();
    requireOpenForMutation();
    const operation = beginSubscriptionRead();
    const unlinkSignal = linkAbortSignal(signal, operation.controller);
    operation.promise = listSubscriptionsUnlocked({ signal: operation.controller.signal });
    try {
      return await operation.promise;
    } finally {
      unlinkSignal();
      subscriptionReads.delete(operation);
    }
  }

  async function listSubscriptionsUnlocked({ signal }) {
    const current = await requireVerifiedAccount({ signal });
    const inventory = await readSubscriptionInventory(current, { signal });
    return Object.freeze({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      subscriptions: Object.freeze(
        inventory.records
          .filter((entry) => entry.enabled && entry.contextCompatible && entry.safe)
          .map((entry) => entry.projection),
      ),
      current: safeLoginContext(current),
      warning: SUBSCRIPTION_WARNING,
    });
  }

  async function activateSubscription(subscriptionId, { signal } = {}) {
    requireSystemAzureControls();
    requireOpenForMutation();
    const releaseMutation = beginSubscriptionMutation();
    const operation = {
      controller: new AbortController(),
      promise: null,
    };
    const unlinkSignal = linkAbortSignal(signal, operation.controller);
    subscriptionOperation = operation;
    operation.promise = activateSubscriptionUnlocked(subscriptionId, {
      signal: operation.controller.signal,
    });
    try {
      return await operation.promise;
    } finally {
      unlinkSignal();
      if (subscriptionOperation === operation) subscriptionOperation = null;
      releaseMutation();
    }
  }

  async function activateSubscriptionUnlocked(subscriptionId, { signal }) {
    const requestedId = normaliseGuid(subscriptionId);
    if (!requestedId) {
      throw new RequestRefused('`subscriptionId` must be one GUID.', { code: 'invalid-subscription-id' });
    }

    const before = await requireVerifiedAccount({ signal });
    const inventory = await readSubscriptionInventory(before, { signal });
    const target = inventory.records.find((entry) => entry.id === requestedId);
    if (!target) {
      throw new RequestRefused('That subscription is no longer available in the refreshed Azure CLI list.', {
        status: 409,
        code: 'subscription-not-available',
      });
    }
    if (!target.enabled) {
      throw new RequestRefused('That Azure subscription is not Enabled.', {
        status: 409,
        code: 'subscription-disabled',
      });
    }
    if (!target.safe) {
      throw new RequestRefused('That Azure subscription record is malformed.', {
        status: 409,
        code: 'subscription-record-invalid',
      });
    }
    if (!sameTenant(before, target.account)) {
      throw new RequestRefused('That subscription belongs to a different Azure tenant.', {
        status: 409,
        code: 'subscription-tenant-mismatch',
      });
    }
    if (!samePrincipal(before, target.account)) {
      throw new RequestRefused('That subscription belongs to a different Azure CLI principal context.', {
        status: 409,
        code: 'subscription-principal-mismatch',
      });
    }

    const setResult = await spawnAzure(
      [
        'account',
        'set',
        '--subscription',
        target.projection.id,
      ],
      { signal },
    );
    if (setResult.timedOut) {
      throw new RequestRefused('Setting the Azure CLI subscription timed out.', {
        status: 504,
        code: 'subscription-set-timeout',
      });
    }
    if (setResult.aborted || setResult.code !== 0) {
      throw new RequestRefused('The Azure CLI subscription could not be changed.', {
        status: 409,
        code: 'subscription-set-failed',
      });
    }

    const after = await readAzureCliAccount({ signal });
    if (!after.signedIn) {
      throw new RequestRefused('The Azure CLI subscription changed, but account status could not be verified.', {
        status: 409,
        code: 'status-unknown',
      });
    }
    if (normaliseGuid(after.activeId) !== requestedId) {
      throw new RequestRefused('Azure CLI did not activate the requested subscription.', {
        status: 409,
        code: 'subscription-readback-mismatch',
      });
    }
    if (!sameTenant(before, after) || !samePrincipal(before, after)) {
      throw new RequestRefused('The Azure CLI principal or tenant changed during subscription activation.', {
        status: 409,
        code: 'subscription-context-changed',
      });
    }
    if (after.subscriptionState !== 'Enabled') {
      throw new RequestRefused('The activated Azure CLI subscription is not Enabled.', {
        status: 409,
        code: 'subscription-readback-disabled',
      });
    }
    if (after.isDefault !== true) {
      throw new RequestRefused('Azure CLI did not make the requested subscription the active default.', {
        status: 409,
        code: 'subscription-readback-mismatch',
      });
    }

    return Object.freeze({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      subscription: Object.freeze({
        id: after.activeId,
        name: after.activeName,
        tenantId: after.tenantId,
        user: Object.freeze({
          name: after.principalName,
          type: after.principalType,
        }),
        isDefault: after.isDefault,
      }),
      current: safeLoginContext(after),
      warning: SUBSCRIPTION_WARNING,
    });
  }

  async function requireVerifiedAccount({ signal } = {}) {
    const account = await readAzureCliAccount({ signal });
    if (account.signedIn && account.principalName && account.principalType && account.tenantId) return account;
    if (account.code === 'signed-out') {
      throw new RequestRefused('Sign in to Azure CLI before managing subscriptions.', {
        status: 409,
        code: 'signed-out',
      });
    }
    throw new RequestRefused('Azure CLI account status could not be verified.', {
      status: 409,
      code: 'status-unknown',
    });
  }

  async function readSubscriptionInventory(current, { signal } = {}) {
    const result = await spawnAzure([...ACCOUNT_LIST_ARGS], { maxOutputBytes: 1024 * 1024, signal });
    if (result.timedOut) {
      throw new RequestRefused('The Azure CLI subscription list timed out.', {
        status: 504,
        code: 'subscription-list-timeout',
      });
    }
    if (result.aborted || result.code !== 0) {
      throw new RequestRefused('The Azure CLI subscription list could not be read.', {
        status: 409,
        code: 'subscription-list-failed',
      });
    }
    let data;
    try {
      data = JSON.parse(String(result.stdout ?? '').trim());
    } catch {
      throw new RequestRefused('The Azure CLI subscription list response was invalid.', {
        status: 409,
        code: 'subscription-list-invalid',
      });
    }
    if (!Array.isArray(data) || data.length > 500) {
      throw new RequestRefused('The Azure CLI subscription list response was invalid.', {
        status: 409,
        code: 'subscription-list-invalid',
      });
    }
    return {
      records: data.map((entry) => subscriptionRecord(entry, current)),
    };
  }

  async function spawnAzure(args, { maxOutputBytes = 32 * 1024, signal } = {}) {
    try {
      return await transports.spawn({
        executable: 'az',
        args,
        cwd: playgroundRoot,
        timeoutMs: 30_000,
        maxOutputBytes,
        allowedExecutables: ['az'],
        signal,
      });
    } catch {
      throw new RequestRefused('Azure CLI could not be started.', {
        status: 409,
        code: 'azure-cli-unavailable',
      });
    }
  }

  function updateLogin(record, updates) {
    Object.assign(record, updates, { updatedAt: now() });
  }

  function requireLogin(loginId) {
    if (!login || login.id !== loginId) {
      throw new RequestRefused('That Azure system login is not available.', { status: 404, code: 'unknown-login' });
    }
    return login;
  }

  function requireSystemAzureControls() {
    if (systemLoginAllowed) return;
    throw new RequestRefused(
      'System Azure sign-in and subscription switching are disabled for this launch. Restart with `--allow-system-azure-login`; the private CLI session is not exposed to terminals.',
      {
        status: 409,
        code: 'login-disabled',
      },
    );
  }

  function acquireRunLease() {
    requireOpenForMutation();
    if (login?.inFlight || subscriptionMutationInFlight) {
      throw new RequestRefused(
        'Azure sign-in or subscription switching is in progress. Wait for it to finish before starting a run.',
        {
          status: 409,
          code: 'azure-identity-mutation-in-progress',
        },
      );
    }
    activeRunLeases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeRunLeases -= 1;
    };
  }

  function beginSubscriptionMutation() {
    if (login?.inFlight) {
      throw new RequestRefused('Azure system sign-in is in progress.', {
        status: 409,
        code: 'login-in-progress',
      });
    }
    if (subscriptionMutationInFlight) {
      throw new RequestRefused('Azure CLI subscription activation is already in progress.', {
        status: 409,
        code: 'subscription-activation-in-progress',
      });
    }
    if (subscriptionReads.size > 0) {
      throw new RequestRefused('Azure CLI subscription status is being refreshed.', {
        status: 409,
        code: 'subscription-read-in-progress',
      });
    }
    requireNoActiveRuns();
    subscriptionMutationInFlight = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscriptionMutationInFlight = false;
    };
  }

  function requireNoActiveRuns() {
    if (activeRunLeases === 0) return;
    throw new RequestRefused(
      'A run is in progress. Wait for it to finish or cancel it before changing the Azure CLI identity.',
      {
        status: 409,
        code: 'run-in-progress',
      },
    );
  }

  function beginSubscriptionRead() {
    if (login?.inFlight || subscriptionMutationInFlight) {
      throw new RequestRefused(
        'Azure sign-in or subscription switching is in progress. Wait for it to finish before refreshing subscriptions.',
        {
          status: 409,
          code: 'azure-identity-mutation-in-progress',
        },
      );
    }
    const operation = {
      controller: new AbortController(),
      promise: null,
    };
    subscriptionReads.add(operation);
    return operation;
  }

  function linkAbortSignal(signal, controller) {
    if (!signal) return () => {};
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }

  function requireReviewedIdentity(context, reviewedIdentity) {
    if (!reviewedIdentity) {
      throw new RequestRefused('Refresh and review the Azure execution identity before running.', {
        status: 409,
        code: 'reviewed-identity-required',
      });
    }
    const current = {
      principalName: context.signedInAccount?.principalName,
      principalType: context.signedInAccount?.principalType,
      tenantId: context.signedInAccount?.tenantId,
      subscriptionId: context.activeCliSubscription?.id?.toLowerCase(),
    };
    if (
      reviewedIdentity.principalName !== current.principalName
      || reviewedIdentity.principalType !== current.principalType
      || reviewedIdentity.tenantId !== current.tenantId
      || reviewedIdentity.subscriptionId?.toLowerCase() !== current.subscriptionId
    ) {
      throw new RequestRefused('The Azure CLI identity changed after review. Refresh and review it again.', {
        status: 409,
        code: 'reviewed-identity-changed',
      });
    }
  }

  async function verifyRunIdentity(reviewedIdentity, { signal } = {}) {
    const account = await requireVerifiedAccount({ signal });
    const current = Object.freeze({
      principalName: account.principalName,
      principalType: account.principalType,
      tenantId: account.tenantId,
      subscriptionId: account.activeId.toLowerCase(),
    });
    if (
      !reviewedIdentity
      || reviewedIdentity.principalName !== current.principalName
      || reviewedIdentity.principalType !== current.principalType
      || reviewedIdentity.tenantId !== current.tenantId
      || reviewedIdentity.subscriptionId?.toLowerCase() !== current.subscriptionId
      || account.subscriptionState !== 'Enabled'
    ) {
      throw new RequestRefused(
        'The Citadel private Azure CLI identity changed after review. The next Azure effect was blocked.',
        {
          status: 409,
          code: 'reviewed-identity-changed',
        },
      );
    }
    return current;
  }

  async function verifyLoginAccount(record) {
    if (closed) return Object.freeze({ signedIn: false, code: 'azure-cli-cancelled' });
    const controller = new AbortController();
    record.verificationController = controller;
    try {
      return await readAzureCliAccount({ signal: controller.signal });
    } finally {
      if (record.verificationController === controller) record.verificationController = null;
    }
  }

  function requireOpenForMutation() {
    if (!closed) return;
    throw new RequestRefused('The execution identity manager is shutting down.', {
      status: 409,
      code: 'identity-manager-closed',
    });
  }

  async function cancelAll() {
    closed = true;
    const drains = [];
    if (login?.inFlight && ACTIVE_LOGIN_STATES.has(login.state)) {
      login.cancelRequested = true;
      updateLogin(login, {
        state: 'cancel-requested',
        code: 'cancel-requested',
        message: 'Cancellation requested. Azure CLI account status is being rechecked.',
      });
      login.controller.abort();
    }
    login?.verificationController?.abort();
    if (login?.inFlight) drains.push(login.promise);
    if (subscriptionOperation?.promise) {
      subscriptionOperation.controller.abort();
      drains.push(subscriptionOperation.promise);
    }
    for (const operation of subscriptionReads) {
      operation.controller.abort();
      if (operation.promise) drains.push(operation.promise);
    }
    await Promise.allSettled(drains);
  }

  return Object.freeze({
    describe,
    forRun,
    readAzureCliAccount,
    startSystemLogin,
    currentSystemLogin,
    statusSystemLogin,
    cancelSystemLogin,
    listSubscriptions,
    activateSubscription,
    acquireRunLease,
    verifyRunIdentity,
    cancelAll,
  });
}

function responseFor(sampleId, context) {
  return Object.freeze({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sampleId,
    context,
    futureHostedProcess: FUTURE_HOSTED_PROCESS_CONTEXT,
  });
}

function azureContext(sampleId, descriptor, account, configuredSubscriptionId, { systemLoginAllowed }) {
  const configuredId = normaliseOptional(configuredSubscriptionId);
  const activeId = account.signedIn ? account.activeId : null;
  const matches = account.signedIn && configuredId ? activeId.toLowerCase() === configuredId.toLowerCase() : null;
  const subscriptionEnabled = account.signedIn && account.subscriptionState === 'Enabled';
  const unavailable = !account.signedIn && account.code !== 'signed-out';
  const state = unavailable
    ? 'unavailable'
    : !account.signedIn
      ? 'signed-out'
      : !subscriptionEnabled
        ? 'subscription-disabled'
        : matches === false
          ? 'subscription-mismatch'
          : 'ready-to-attempt';
  const code = !account.signedIn
    ? account.code
    : !subscriptionEnabled
      ? 'subscription-disabled'
      : matches === false
        ? 'subscription-mismatch'
        : null;
  const diagnosticMismatch = sampleId === 'azure-context-check' && state === 'subscription-mismatch';
  const summary =
    account.code === 'azure-cli-timeout'
      ? 'The Azure CLI account probe timed out. No sign-in state was inferred; retry the context check.'
      : account.code === 'azure-cli-cancelled'
        ? 'The Azure CLI account probe was cancelled. No sign-in state was inferred.'
        : account.code === 'azure-cli-unavailable'
          ? 'The Azure CLI is not available on this machine. Install it before running this sample.'
          : account.code === 'account-context-invalid'
            ? 'The Azure CLI account response was invalid. No sign-in state was inferred.'
            : state === 'signed-out'
              ? systemLoginAllowed
                ? 'This Citadel private Azure CLI session is signed out. Use Sign in with Microsoft for this launch.'
                : 'This Citadel private Azure CLI session is signed out. Restart with system sign-in enabled; terminal authentication is intentionally unavailable.'
              : state === 'subscription-mismatch'
                ? diagnosticMismatch
                  ? 'The active Azure CLI subscription does not match the intended target. This read-only diagnostic may run to report the mismatch.'
                  : 'The active Azure CLI subscription does not match the intended target.'
                : state === 'subscription-disabled'
                  ? 'The active Azure CLI subscription is not Enabled. Select an enabled subscription before running this sample.'
                : `${descriptor.summary} Authorization has not been checked; this context is Ready to Attempt only.`;
  return Object.freeze({
    kind: descriptor.kind,
    label: descriptor.label,
    summary,
    state,
    code,
    canExecute: state === 'ready-to-attempt' || diagnosticMismatch,
    signedInAccount: accountProjection(account),
    executionCredential: Object.freeze({
      type: descriptor.authorityType,
      source: 'azure-cli',
      principalName: account.signedIn ? account.principalName : null,
      principalType: account.signedIn ? account.principalType : null,
      tenantId: account.signedIn ? account.tenantId : null,
    }),
    activeCliSubscription: account.signedIn
      ? Object.freeze({
          id: account.activeId,
          name: account.activeName,
          tenantId: account.tenantId,
          state: account.subscriptionState,
        })
      : null,
    intendedTarget: Object.freeze({
      subscriptionId: configuredId,
      matchesActive: matches,
    }),
    authorization: authorizationNotChecked(),
    gateway: null,
    hostedRelay: null,
    guarantees: guarantees({ privateAzureCliCache: true }),
  });
}

function gatewayContext(descriptor, gateway) {
  const keyPresent = gateway?.keyPresent === true;
  const headerName = typeof gateway?.headerName === 'string' && HEADER_NAME.test(gateway.headerName) ? gateway.headerName : '';
  const ready = keyPresent && headerName !== '';
  return Object.freeze({
    kind: descriptor.kind,
    label: descriptor.label,
    summary: ready
      ? `${descriptor.summary} Authorization has not been checked; this context is Ready to Attempt only.`
      : 'The memory-only API Management subscription key and its configured header name are required.',
    state: ready ? 'ready-to-attempt' : 'missing-key',
    code: ready ? null : 'missing-gateway-key',
    canExecute: ready,
    signedInAccount: null,
    executionCredential: Object.freeze({
      type: descriptor.authorityType,
      source: 'browser-memory',
      principalName: null,
      principalType: null,
      tenantId: null,
    }),
    activeCliSubscription: null,
    intendedTarget: null,
    authorization: authorizationNotChecked(),
    gateway: Object.freeze({ keyPresent, headerName }),
    hostedRelay: null,
    guarantees: guarantees(),
  });
}

function safeLoginContext(account) {
  return Object.freeze({
    signedInAccount: accountProjection(account),
    activeCliSubscription: account.signedIn
      ? Object.freeze({
          id: account.activeId,
          name: account.activeName,
          tenantId: account.tenantId,
          state: account.subscriptionState,
        })
      : null,
  });
}

function accountProjection(account) {
  return Object.freeze({
    state: account.signedIn ? 'signed-in' : account.code === 'signed-out' ? 'signed-out' : 'status-unknown',
    principalName: account.signedIn ? account.principalName : null,
    principalType: account.signedIn ? account.principalType : null,
    tenantId: account.signedIn ? account.tenantId : null,
  });
}

function parseAccount(data) {
  const activeId = normaliseGuid(data?.id);
  const principalName = safeText(data?.user?.name, 256);
  const principalType = safePrincipalType(data?.user?.type);
  const tenantId = safeText(data?.tenantId, 128);
  const subscriptionState = safeText(data?.state, 32);
  if (!activeId || !principalName || !principalType || !tenantId || !subscriptionState) {
    return Object.freeze({ signedIn: false, code: 'account-context-invalid' });
  }
  return Object.freeze({
    signedIn: true,
    principalName,
    principalType,
    tenantId,
    activeId,
    activeName: safeText(data?.name, 256) || null,
    subscriptionState,
    isDefault: data?.isDefault === true,
  });
}

function subscriptionRecord(data, current) {
  const id = normaliseGuid(data?.id);
  const account = Object.freeze({
    principalName: safeText(data?.user?.name, 256) || null,
    principalType: safePrincipalType(data?.user?.type),
    tenantId: safeText(data?.tenantId, 128) || null,
  });
  const name = safeText(data?.name, 256);
  const enabled = data?.state === 'Enabled';
  const safe = Boolean(
    id &&
      name &&
      account.principalName &&
      account.principalType &&
      account.tenantId &&
      typeof data?.isDefault === 'boolean',
  );
  return Object.freeze({
    id,
    enabled,
    safe,
    account,
    contextCompatible: sameTenant(current, account) && samePrincipal(current, account),
    projection: safe
      ? Object.freeze({
          id,
          name,
          tenantId: account.tenantId,
          user: Object.freeze({
            name: account.principalName,
            type: account.principalType,
          }),
          isDefault: data.isDefault,
        })
      : null,
  });
}

function compareAccounts(before, after) {
  if (before?.code === 'signed-out' && after?.signedIn) return 'switched';
  if (!before?.signedIn || !after?.signedIn) return 'unverified';
  if (
    !before.principalName ||
    !before.principalType ||
    !before.tenantId ||
    !after.principalName ||
    !after.principalType ||
    !after.tenantId
  ) {
    return 'unverified';
  }
  return sameTenant(before, after) && samePrincipal(before, after) ? 'unchanged' : 'switched';
}

function sameTenant(left, right) {
  return (
    typeof left?.tenantId === 'string' &&
    typeof right?.tenantId === 'string' &&
    left.tenantId.toLowerCase() === right.tenantId.toLowerCase()
  );
}

function samePrincipal(left, right) {
  return (
    typeof left?.principalName === 'string' &&
    typeof right?.principalName === 'string' &&
    left.principalName.toLowerCase() === right.principalName.toLowerCase() &&
    left.principalType === right.principalType
  );
}

function loginRefreshFailureMessage(code) {
  if (code === 'azure-cli-timeout') {
    return 'Azure CLI returned from sign-in, but refreshing this private session timed out. Retry system sign-in or refresh the status.';
  }
  if (code === 'azure-cli-unavailable') {
    return 'Azure CLI returned from sign-in, but this private session could not read account status. Retry system sign-in.';
  }
  return 'Azure CLI returned from sign-in, but this private session could not verify the signed-in account. Retry system sign-in.';
}

function loginResponse(record) {
  if (!ACTIVE_LOGIN_STATES.has(record.state) && !TERMINAL_LOGIN_STATES.has(record.state)) {
    throw new Error(`Unsupported Azure system login state "${record.state}".`);
  }
  return Object.freeze({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    login: Object.freeze({
      id: record.id,
      state: record.state,
      code: record.code,
      message: record.message,
      accountChange: record.accountChange,
      startedAt: new Date(record.startedAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    }),
    context: record.context,
  });
}

export function containsDeviceFallback(text) {
  return createDeviceFallbackDetector().observe(text);
}

function createDeviceFallbackDetector() {
  const positions = new Uint16Array(DEVICE_FALLBACK_MARKERS.length);
  return Object.freeze({
    observe(text) {
      for (const rawCharacter of String(text ?? '')) {
        const character = rawCharacter.toLowerCase();
        for (let index = 0; index < DEVICE_FALLBACK_MARKERS.length; index += 1) {
          const { marker, failure } = DEVICE_FALLBACK_MARKERS[index];
          let position = positions[index];
          while (position > 0 && marker[position] !== character) position = failure[position - 1];
          if (marker[position] === character) position += 1;
          if (position === marker.length) return true;
          positions[index] = position;
        }
      }
      return false;
    },
    clear() {
      positions.fill(0);
    },
  });
}

function markerFailureTable(marker) {
  const failure = new Array(marker.length).fill(0);
  for (let index = 1, prefix = 0; index < marker.length; index += 1) {
    while (prefix > 0 && marker[index] !== marker[prefix]) prefix = failure[prefix - 1];
    if (marker[index] === marker[prefix]) prefix += 1;
    failure[index] = prefix;
  }
  return failure;
}

function exactObject(payload, keys, label) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestRefused(`The ${label} request body must be a JSON object.`);
  }
  const actual = Object.keys(payload).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RequestRefused(`The ${label} request accepts exactly: ${keys.join(', ')}.`, {
      code: 'forbidden-member',
    });
  }
}

function requireProtocol(protocolVersion) {
  if (protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    throw new RequestRefused(
      `Unsupported protocol version ${protocolVersion}. This server speaks version ${EXECUTION_PROTOCOL_VERSION}.`,
      { code: 'protocol-version' },
    );
  }
}

function safeText(value, limit) {
  if (typeof value !== 'string') return '';
  return createRedactor().text(value).replace(/[\0-\x1F\x7F]/g, '').trim().slice(0, limit);
}

function safePrincipalType(value) {
  const normalised = safeText(value, 64).toLowerCase();
  if (normalised === 'user') return 'user';
  if (normalised === 'serviceprincipal' || normalised === 'service-principal') return 'service-principal';
  if (normalised === 'managedidentity' || normalised === 'managed-identity') return 'managed-identity';
  return null;
}

function normaliseOptional(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normaliseGuid(value) {
  return typeof value === 'string' && GUID.test(value) ? value.toLowerCase() : null;
}

function azureCliUnavailable(result) {
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  return (
    result?.code === 9009 ||
    /\bENOENT\b|azure cli was not found|az was not found|no such file|not recognized as an internal or external command|app execution aliases/i.test(
      output,
    )
  );
}
