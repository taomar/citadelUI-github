/**
 * Local execution identity and Azure CLI device-code login.
 *
 * The browser supplies only a sample id and safe configuration facts. Commands
 * and arguments are fixed here. Account probes and login share the hardened
 * process transport: no shell, bounded output, timeout, cancellation, and no
 * token projection.
 */

import {
  FUTURE_HOSTED_PROCESS_CONTEXT,
  guarantees,
  hostedRelayContext,
  isAzureCliContext,
  sampleExecutionContext,
  unavailableSampleContext,
} from '../core/executionContext.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../core/types.mjs';
import { clip, createRedactor } from './redaction.mjs';
import { RequestRefused } from './runRequest.mjs';
import { realTransports } from './transports.mjs';

const ACCOUNT_QUERY = '{id:id,name:name,tenantId:tenantId,user:{name:user.name,type:user.type}}';
export const ACCOUNT_SHOW_ARGS = Object.freeze(['account', 'show', '--query', ACCOUNT_QUERY, '-o', 'json']);
export const DEVICE_CODE_LOGIN_ARGS = Object.freeze(['login', '--use-device-code']);
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const CONTEXT_REQUEST_KEYS = Object.freeze([
  'protocolVersion',
  'sampleId',
  'configuredSubscriptionId',
  'gateway',
]);
const LOGIN_START_KEYS = Object.freeze(['protocolVersion']);
const LOGIN_TARGET_KEYS = Object.freeze(['protocolVersion', 'loginId']);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const LOGIN_ID = /^azure-login-\d{4,}$/;
const ACTIVE_LOGIN_STATES = new Set(['starting', 'waiting-for-user']);
const DEVICE_URL_HOSTS = new Set([
  'aka.ms',
  'login.microsoftonline.com',
  'microsoft.com',
  'microsoftonline.com',
  'www.microsoft.com',
]);

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
  exactObject(payload, LOGIN_START_KEYS, 'Azure login start');
  requireProtocol(payload.protocolVersion);
}

export function validateLoginTargetRequest(payload) {
  exactObject(payload, LOGIN_TARGET_KEYS, 'Azure login');
  requireProtocol(payload.protocolVersion);
  if (typeof payload.loginId !== 'string' || !LOGIN_ID.test(payload.loginId)) {
    throw new RequestRefused('A valid `loginId` is required.', { code: 'invalid-login-id' });
  }
  return payload.loginId;
}

export function createExecutionContextManager({
  playgroundRoot,
  mode = 'preview',
  relay = Object.freeze({ enabled: false }),
  transports = realTransports(),
  loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof playgroundRoot !== 'string' || playgroundRoot === '') {
    throw new Error('The execution-context manager requires the playground root.');
  }
  if (!Number.isInteger(loginTimeoutMs) || loginTimeoutMs < 1000 || loginTimeoutMs > 15 * 60 * 1000) {
    throw new Error('The Azure login timeout must be between 1 second and 15 minutes.');
  }

  let loginSequence = 0;
  let login = null;

  async function describe(payload, catalogue, { signal } = {}) {
    const request = validateExecutionContextRequest(payload, catalogue);
    return responseFor(request.sampleId, await contextFor(request, { useRelay: true, signal }));
  }

  async function forRun({ sampleId, configuredSubscriptionId = null, gateway = null }, { signal } = {}) {
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
    return context;
  }

  async function contextFor({ sampleId, configuredSubscriptionId, gateway }, { useRelay, signal }) {
    const descriptor = sampleExecutionContext(sampleId);
    if (useRelay && relay.enabled) {
      return hostedRelayContext({ available: relay.allowedSampleIds?.includes(sampleId) === true });
    }
    if (mode !== 'execute') return unavailableSampleContext(descriptor);
    if (descriptor.kind === 'gateway-key') return gatewayContext(descriptor, gateway);

    if (!isAzureCliContext(descriptor.kind)) {
      throw new Error(`Unsupported execution-context kind "${descriptor.kind}".`);
    }
    const account = await readAzureCliAccount({ signal });
    return azureContext(sampleId, descriptor, account, configuredSubscriptionId);
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
    const activeId = safeText(data?.id, 128);
    if (!activeId) return Object.freeze({ signedIn: false, code: 'signed-out' });
    return Object.freeze({
      signedIn: true,
      principalName: safeText(data?.user?.name, 256) || null,
      principalType: safePrincipalType(data?.user?.type),
      tenantId: safeText(data?.tenantId, 128) || null,
      activeId,
      activeName: safeText(data?.name, 256) || null,
    });
  }

  function startLogin() {
    requireLocalExecuteMode();
    if (login?.inFlight) {
      throw new RequestRefused('An Azure CLI device-code login is already in progress.', {
        status: 409,
        code: 'login-in-progress',
      });
    }
    loginSequence += 1;
    const startedAt = now();
    const record = {
      id: `azure-login-${String(loginSequence).padStart(4, '0')}`,
      state: 'starting',
      code: null,
      verificationUrl: null,
      userCode: null,
      message: 'Starting Azure CLI device-code sign-in.',
      startedAt,
      updatedAt: startedAt,
      expiresAt: startedAt + loginTimeoutMs,
      controller: new AbortController(),
      context: null,
      output: '',
      inFlight: true,
    };
    login = record;
    record.promise = runLogin(record).finally(() => {
      record.inFlight = false;
    });
    return loginResponse(record);
  }

  function statusLogin(loginId) {
    requireLocalExecuteMode();
    return loginResponse(requireLogin(loginId));
  }

  function currentLogin() {
    requireLocalExecuteMode();
    return login?.inFlight ? loginResponse(login) : null;
  }

  function cancelLogin(loginId) {
    requireLocalExecuteMode();
    const record = requireLogin(loginId);
    if (ACTIVE_LOGIN_STATES.has(record.state)) {
      updateLogin(record, {
        state: 'cancelled',
        code: 'login-cancelled',
        message: 'Azure CLI device-code sign-in was cancelled.',
      });
      record.controller.abort();
    }
    return loginResponse(record);
  }

  async function runLogin(record) {
    const redactor = createRedactor();
    const onOutput = ({ text }) => {
      if (login !== record || !ACTIVE_LOGIN_STATES.has(record.state)) return;
      record.output = clip(`${record.output}${redactor.text(text)}`, 16 * 1024).text;
      const device = parseDeviceInstruction(record.output);
      if (device.verificationUrl) record.verificationUrl = device.verificationUrl;
      if (device.userCode) record.userCode = device.userCode;
      if (record.verificationUrl || record.userCode) {
        updateLogin(record, {
          state: 'waiting-for-user',
          message:
            record.verificationUrl && record.userCode
              ? `Open ${record.verificationUrl} and enter code ${record.userCode}.`
              : 'Complete sign-in using the Azure CLI device-code instructions.',
        });
      }
    };

    let result;
    try {
      result = await transports.spawn({
        executable: 'az',
        args: [...DEVICE_CODE_LOGIN_ARGS],
        cwd: playgroundRoot,
        signal: record.controller.signal,
        timeoutMs: loginTimeoutMs,
        maxOutputBytes: 64 * 1024,
        allowedExecutables: ['az'],
        onOutput,
      });
    } catch {
      updateLogin(record, {
        state: record.controller.signal.aborted ? 'cancelled' : 'failed',
        code: record.controller.signal.aborted ? 'login-cancelled' : 'login-failed',
        message: record.controller.signal.aborted
          ? 'Azure CLI device-code sign-in was cancelled.'
          : 'Azure CLI device-code sign-in could not be started.',
      });
      return;
    }

    if (record.controller.signal.aborted || result.aborted) {
      updateLogin(record, {
        state: 'cancelled',
        code: 'login-cancelled',
        message: 'Azure CLI device-code sign-in was cancelled.',
      });
      return;
    }
    if (result.timedOut) {
      updateLogin(record, {
        state: 'timed-out',
        code: 'login-timeout',
        message: 'Azure CLI device-code sign-in timed out.',
      });
      return;
    }
    if (result.code !== 0) {
      updateLogin(record, {
        state: 'failed',
        code: 'login-failed',
        message:
          result.spawnFailed || azureCliUnavailable(result)
            ? 'Azure CLI is not available, so device-code sign-in could not start.'
            : 'Azure CLI device-code sign-in failed.',
      });
      return;
    }

    const account = await readAzureCliAccount({ signal: record.controller.signal });
    if (login !== record || record.controller.signal.aborted || record.state === 'cancelled') return;
    if (!account.signedIn) {
      updateLogin(record, {
        state: 'failed',
        code: 'login-failed',
        message: loginRefreshFailureMessage(account.code),
      });
      return;
    }
    record.context = safeLoginContext(account);
    updateLogin(record, {
      state: 'succeeded',
      code: null,
      message: 'Azure CLI device-code sign-in succeeded.',
    });
  }

  function updateLogin(record, updates) {
    Object.assign(record, updates, { updatedAt: now() });
  }

  function requireLogin(loginId) {
    if (!login || login.id !== loginId) {
      throw new RequestRefused('That Azure login is not available.', { status: 404, code: 'unknown-login' });
    }
    return login;
  }

  function requireLocalExecuteMode() {
    if (mode !== 'execute') {
      throw new RequestRefused('Azure CLI sign-in is available only from the loopback execute server.', {
        status: 501,
        code: 'preview-unavailable',
      });
    }
  }

  function cancelAll() {
    if (login?.inFlight && ACTIVE_LOGIN_STATES.has(login.state)) {
      updateLogin(login, {
        state: 'cancelled',
        code: 'login-cancelled',
        message: 'Azure CLI device-code sign-in was cancelled.',
      });
      login.controller.abort();
    }
  }

  return Object.freeze({
    describe,
    forRun,
    readAzureCliAccount,
    startLogin,
    currentLogin,
    statusLogin,
    cancelLogin,
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

function azureContext(sampleId, descriptor, account, configuredSubscriptionId) {
  const configuredId = normaliseOptional(configuredSubscriptionId);
  const activeId = account.signedIn ? account.activeId : null;
  const matches = account.signedIn && configuredId ? activeId.toLowerCase() === configuredId.toLowerCase() : null;
  const unavailable = !account.signedIn && account.code !== 'signed-out';
  const state = unavailable ? 'unavailable' : !account.signedIn ? 'signed-out' : matches === false ? 'subscription-mismatch' : 'ready';
  const code = !account.signedIn ? account.code : matches === false ? 'subscription-mismatch' : null;
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
      ? 'No signed-in Azure CLI account is available. Sign in explicitly before running this sample.'
      : state === 'subscription-mismatch'
        ? diagnosticMismatch
          ? 'The active Azure CLI subscription does not match the configured sample subscription. This read-only diagnostic may run to report the mismatch.'
          : 'The active Azure CLI subscription does not match the configured sample subscription.'
        : descriptor.summary;
  return Object.freeze({
    kind: descriptor.kind,
    label: descriptor.label,
    summary,
    state,
    code,
    canExecute: state === 'ready' || diagnosticMismatch,
    authority: Object.freeze({
      type: descriptor.authorityType,
      principalName: account.signedIn ? account.principalName : null,
      principalType: account.signedIn ? account.principalType : null,
      tenantId: account.signedIn ? account.tenantId : null,
    }),
    subscription: Object.freeze({
      activeId,
      activeName: account.signedIn ? account.activeName : null,
      configuredId,
      matches,
    }),
    gateway: null,
    hostedRelay: null,
    guarantees: guarantees(),
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
      ? descriptor.summary
      : 'The memory-only API Management subscription key and its configured header name are required.',
    state: ready ? 'ready' : 'missing-key',
    code: ready ? null : 'missing-gateway-key',
    canExecute: ready,
    authority: Object.freeze({
      type: descriptor.authorityType,
      principalName: null,
      principalType: null,
      tenantId: null,
    }),
    subscription: Object.freeze({
      activeId: null,
      activeName: null,
      configuredId: null,
      matches: null,
    }),
    gateway: Object.freeze({ keyPresent, headerName }),
    hostedRelay: null,
    guarantees: guarantees(),
  });
}

function safeLoginContext(account) {
  return Object.freeze({
    principalName: account.principalName,
    principalType: account.principalType,
    tenantId: account.tenantId,
    subscription: Object.freeze({
      activeId: account.activeId,
      activeName: account.activeName,
    }),
  });
}

function loginRefreshFailureMessage(code) {
  if (code === 'azure-cli-timeout') {
    return 'Azure CLI sign-in completed, but refreshing the active account timed out.';
  }
  if (code === 'azure-cli-cancelled') {
    return 'Azure CLI sign-in completed, but refreshing the active account was cancelled.';
  }
  if (code === 'azure-cli-unavailable') {
    return 'Azure CLI sign-in completed, but the active account could not be read.';
  }
  return 'Azure CLI completed login but no active account could be read.';
}

function loginResponse(record) {
  return Object.freeze({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    login: Object.freeze({
      id: record.id,
      state: record.state,
      code: record.code,
      verificationUrl: record.verificationUrl,
      userCode: record.userCode,
      message: record.message,
      startedAt: new Date(record.startedAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    }),
    context: record.context,
  });
}

function parseDeviceInstruction(text) {
  const source = String(text ?? '');
  let verificationUrl = null;
  for (const match of source.matchAll(/https:\/\/[^\s"'<>]+/gi)) {
    const candidate = match[0].replace(/[),.;]+$/, '');
    try {
      const parsed = new URL(candidate);
      if (
        parsed.protocol === 'https:' &&
        DEVICE_URL_HOSTS.has(parsed.hostname.toLowerCase()) &&
        /device|login/i.test(`${parsed.pathname}${parsed.search}`)
      ) {
        verificationUrl = parsed.toString();
        break;
      }
    } catch {
      verificationUrl = null;
    }
  }
  const codeMatch = /\bcode\s+([A-Z0-9]{4,}(?:-[A-Z0-9]{2,})*)\b/i.exec(source);
  const userCode = codeMatch && /^[A-Z0-9-]{8,32}$/i.test(codeMatch[1]) ? codeMatch[1].toUpperCase() : null;
  return { verificationUrl, userCode };
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
  return normalised ? 'unknown' : null;
}

function normaliseOptional(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
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
