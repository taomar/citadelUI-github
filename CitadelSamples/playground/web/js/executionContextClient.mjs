const PROTOCOL_VERSION = 2;
const CONTEXT_STATES = new Set([
  'ready',
  'ready-to-attempt',
  'unavailable',
  'signed-out',
  'subscription-mismatch',
  'missing-key',
  'deferred',
]);
const LOGIN_STATES = new Set([
  'login-disabled',
  'starting',
  'waiting-system-ui',
  'verifying',
  'device-fallback-blocked',
  'status-unknown',
  'cancel-requested',
  'failed',
  'cancelled',
  'timed-out',
  'ready',
]);
const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildExecutionContextProjection({ sample, read, hasSecret }) {
  const descriptor = sampleExecutionContext(sample.id);
  const configuredSubscriptionId = configuredSubscriptionForSample(sample.id, {
    'hub.subscriptionId': read('hub.subscriptionId'),
    'keyVault.subscriptionId': read('keyVault.subscriptionId'),
  });
  return {
    sampleId: sample.id,
    configuredSubscriptionId,
    gateway:
      descriptor.kind === 'gateway-key'
        ? {
            keyPresent: hasSecret('gatewayAccess.apiKey'),
            headerName: String(read('gatewayAccess.subscriptionKeyHeader') ?? ''),
          }
        : null,
  };
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function string(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

function validateExecutionContext(payload) {
  const value = object(payload, 'Execution context');
  string(value.kind, 'Execution context kind');
  string(value.label, 'Execution context label');
  string(value.summary, 'Execution context summary');
  if (!CONTEXT_STATES.has(value.state)) throw new TypeError('Execution context state is unsupported.');
  if (typeof value.canExecute !== 'boolean') throw new TypeError('Execution context canExecute must be boolean.');
  if (value.signedInAccount != null) object(value.signedInAccount, 'Signed-in account');
  if (value.executionCredential != null) object(value.executionCredential, 'Execution credential');
  if (value.activeCliSubscription != null) object(value.activeCliSubscription, 'Active CLI subscription');
  if (value.intendedTarget != null) object(value.intendedTarget, 'Intended target');
  if (value.authorization != null) object(value.authorization, 'Authorization status');
  if (value.gateway != null) object(value.gateway, 'Execution context gateway');
  if (value.hostedRelay != null) object(value.hostedRelay, 'Execution context hosted relay');
  if (
    value.guarantees != null &&
    (typeof value.guarantees !== 'object' || Array.isArray(value.guarantees))
  ) {
    throw new TypeError('Execution context guarantees must be an object.');
  }
  return value;
}

function validateLogin(payload) {
  const value = object(payload, 'Azure login');
  string(value.id, 'Azure login id');
  if (!LOGIN_STATES.has(value.state)) throw new TypeError('Azure login state is unsupported.');
  if ('verificationUrl' in value || 'userCode' in value) {
    throw new TypeError('Azure login responses must not contain legacy device fields.');
  }
  if (value.message != null) string(value.message, 'Azure login message');
  if (value.accountChange != null && !['switched', 'unchanged', 'unverified'].includes(value.accountChange)) {
    throw new TypeError('Azure login account change is unsupported.');
  }
  return value;
}

function validateSubscription(payload) {
  const value = object(payload, 'Azure subscription');
  if (!SUBSCRIPTION_ID.test(string(value.id, 'Azure subscription id'))) {
    throw new TypeError('Azure subscription id must be a GUID.');
  }
  string(value.name, 'Azure subscription name');
  string(value.tenantId, 'Azure subscription tenant id');
  if (value.user != null) object(value.user, 'Azure subscription user');
  if (typeof value.isDefault !== 'boolean') throw new TypeError('Azure subscription isDefault must be boolean.');
  return value;
}

function validateCurrentAzureContext(payload) {
  const value = object(payload, 'Current Azure context');
  const account = object(value.signedInAccount, 'Current signed-in account');
  if (account.state !== 'signed-in') throw new TypeError('Current Azure account must be signed in.');
  string(account.principalName, 'Current Azure principal name');
  string(account.principalType, 'Current Azure principal type');
  string(account.tenantId, 'Current Azure tenant id');
  const subscription = object(value.activeCliSubscription, 'Current active CLI subscription');
  if (!SUBSCRIPTION_ID.test(string(subscription.id, 'Current active CLI subscription id'))) {
    throw new TypeError('Current active CLI subscription id must be a GUID.');
  }
  string(subscription.name, 'Current active CLI subscription name', { optional: true });
  string(subscription.tenantId, 'Current active CLI subscription tenant id');
  return value;
}

export function reconcileAzureContextCurrent(context, current, { sampleId = '' } = {}) {
  const prior = validateExecutionContext(context);
  if (!prior.kind.startsWith('azure-cli-')) return prior;
  const fresh = validateCurrentAzureContext(current);
  const intendedId =
    typeof prior.intendedTarget?.subscriptionId === 'string' ? prior.intendedTarget.subscriptionId : null;
  const matchesActive =
    intendedId === null
      ? null
      : intendedId.toLowerCase() === fresh.activeCliSubscription.id.toLowerCase();
  const mismatch = matchesActive === false;
  const diagnosticMismatch = mismatch && sampleId === 'azure-context-check';
  return {
    ...prior,
    state: mismatch ? 'subscription-mismatch' : 'ready-to-attempt',
    code: mismatch ? 'subscription-mismatch' : null,
    canExecute: !mismatch || diagnosticMismatch,
    summary: mismatch
      ? diagnosticMismatch
        ? 'The active Azure CLI subscription does not match the intended target. This read-only diagnostic may run to report the mismatch.'
        : 'The active Azure CLI subscription does not match the intended target.'
      : 'The Azure CLI account and active subscription were refreshed. Authorization has not been checked; this context is Ready to Attempt only.',
    signedInAccount: fresh.signedInAccount,
    executionCredential: prior.executionCredential
      ? {
          ...prior.executionCredential,
          principalName: fresh.signedInAccount.principalName,
          principalType: fresh.signedInAccount.principalType,
          tenantId: fresh.signedInAccount.tenantId,
        }
      : null,
    activeCliSubscription: fresh.activeCliSubscription,
    intendedTarget: prior.intendedTarget
      ? { ...prior.intendedTarget, matchesActive }
      : null,
  };
}

export function azureAuthCapabilityFromPayload(payload) {
  const auth = payload?.azureAuth;
  const systemLogin = auth?.systemLogin;
  const subscriptions = auth?.subscriptions;
  const allowed = systemLogin?.available === true;
  return Object.freeze({
    systemLoginAllowed: allowed,
    systemLoginState: allowed ? 'available' : 'login-disabled',
    loginId: typeof systemLogin?.loginId === 'string' ? systemLogin.loginId : 'azure-system-login',
    accountSwitchLabel: 'Switch Azure account',
    subscriptionsAvailable: subscriptions?.available === true,
    warning:
      typeof subscriptions?.warning === 'string'
        ? subscriptions.warning
        : 'Changing the active subscription updates the shared Azure CLI default for other terminals and tools on this machine.',
  });
}

async function responseJson(response, label) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (!response.ok) {
    const summary =
      typeof payload?.summary === 'string'
        ? payload.summary
        : typeof payload?.detail === 'string'
          ? payload.detail
          : `HTTP ${response.status}`;
    const code = typeof payload?.code === 'string' && payload.code ? ` (${payload.code})` : '';
    const error = new Error(`${label} failed: ${summary}${code}`);
    error.status = response.status;
    error.code = typeof payload?.code === 'string' ? payload.code : '';
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function createExecutionContextClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  async function post(path, body, { signal } = {}) {
    const response = await fetchImpl(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return responseJson(response, path);
  }

  return Object.freeze({
    async getContext({ sampleId, configuredSubscriptionId = null, gateway = null }, options = {}) {
      const body = {
        protocolVersion: PROTOCOL_VERSION,
        sampleId: string(sampleId, 'Sample id'),
        configuredSubscriptionId:
          configuredSubscriptionId == null ? null : string(configuredSubscriptionId, 'Configured subscription id'),
        gateway:
          gateway == null
            ? null
            : {
                keyPresent: Boolean(object(gateway, 'Gateway context').keyPresent),
                headerName: string(gateway.headerName, 'Gateway header name'),
              },
      };
      const payload = object(await post('/api/execution-context', body, options), 'Execution context response');
      return {
        ...validateExecutionContext(payload.context),
        futureHostedProcess: payload.futureHostedProcess ?? null,
      };
    },

    async startSystemAzureLogin(options = {}) {
      try {
        const payload = object(
          await post('/api/azure-auth/start', { protocolVersion: PROTOCOL_VERSION }, options),
          'Azure login response',
        );
        const login = validateLogin(payload.login);
        return { ...login, loginId: login.id, context: payload.context ?? null };
      } catch (error) {
        if (error?.payload?.login) {
          const login = validateLogin(error.payload.login);
          error.login = { ...login, loginId: login.id, context: error.payload.context ?? null };
        }
        throw error;
      }
    },

    async getSystemAzureLogin(loginId, options = {}) {
      const payload = object(
        await post(
          '/api/azure-auth/status',
          { protocolVersion: PROTOCOL_VERSION, loginId: string(loginId, 'Azure login id') },
          options,
        ),
        'Azure login response',
      );
      const login = validateLogin(payload.login);
      return { ...login, loginId: login.id, context: payload.context ?? null };
    },

    async cancelSystemAzureLogin(loginId, options = {}) {
      const payload = object(
        await post(
          '/api/azure-auth/cancel',
          { protocolVersion: PROTOCOL_VERSION, loginId: string(loginId, 'Azure login id') },
          options,
        ),
        'Azure login response',
      );
      const login = validateLogin(payload.login);
      return { ...login, loginId: login.id, context: payload.context ?? null };
    },

    async listAzureSubscriptions(options = {}) {
      const payload = object(
        await post('/api/azure-subscriptions/list', { protocolVersion: PROTOCOL_VERSION }, options),
        'Azure subscription response',
      );
      if (!Array.isArray(payload.subscriptions)) {
        throw new TypeError('Azure subscriptions must be an array.');
      }
      return {
        subscriptions: payload.subscriptions.map(validateSubscription),
        current: validateCurrentAzureContext(payload.current),
        warning: string(payload.warning, 'Azure subscription warning'),
      };
    },

    async activateAzureSubscription(subscriptionId, options = {}) {
      if (!SUBSCRIPTION_ID.test(string(subscriptionId, 'Azure subscription id'))) {
        throw new TypeError('Azure subscription id must be a GUID.');
      }
      const payload = object(
        await post(
          '/api/azure-subscriptions/activate',
          { protocolVersion: PROTOCOL_VERSION, subscriptionId },
          options,
        ),
        'Azure subscription response',
      );
      return {
        subscription: validateSubscription(payload.subscription),
        current: validateCurrentAzureContext(payload.current),
        warning: string(payload.warning, 'Azure subscription warning'),
      };
    },
  });
}
import {
  configuredSubscriptionForSample,
  sampleExecutionContext,
} from '../../src/core/executionContext.mjs';
