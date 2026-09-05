const PROTOCOL_VERSION = 2;
const CONTEXT_STATES = new Set([
  'ready',
  'unavailable',
  'signed-out',
  'subscription-mismatch',
  'missing-key',
  'deferred',
]);
const LOGIN_STATES = new Set([
  'starting',
  'waiting-for-user',
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
]);

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
  if (value.authority != null) object(value.authority, 'Execution context authority');
  if (value.subscription != null) object(value.subscription, 'Execution context subscription');
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
  if (value.verificationUrl != null) string(value.verificationUrl, 'Azure login verification URL');
  if (value.userCode != null) string(value.userCode, 'Azure login user code');
  if (value.message != null) string(value.message, 'Azure login message');
  return value;
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

    async startAzureLogin(options = {}) {
      try {
        const payload = object(
          await post('/api/azure-login/start', { protocolVersion: PROTOCOL_VERSION }, options),
          'Azure login response',
        );
        const login = validateLogin(payload.login);
        return { ...login, loginId: login.id, context: payload.context ?? null };
      } catch (error) {
        if (error?.code === 'login-in-progress' && error.payload?.login) {
          const login = validateLogin(error.payload.login);
          error.login = { ...login, loginId: login.id, context: error.payload.context ?? null };
        }
        throw error;
      }
    },

    async getAzureLogin(loginId, options = {}) {
      const payload = object(
        await post(
          '/api/azure-login/status',
          { protocolVersion: PROTOCOL_VERSION, loginId: string(loginId, 'Azure login id') },
          options,
        ),
        'Azure login response',
      );
      const login = validateLogin(payload.login);
      return { ...login, loginId: login.id, context: payload.context ?? null };
    },

    async cancelAzureLogin(loginId, options = {}) {
      const payload = object(
        await post(
          '/api/azure-login/cancel',
          { protocolVersion: PROTOCOL_VERSION, loginId: string(loginId, 'Azure login id') },
          options,
        ),
        'Azure login response',
      );
      const login = validateLogin(payload.login);
      return { ...login, loginId: login.id, context: payload.context ?? null };
    },
  });
}
import {
  configuredSubscriptionForSample,
  sampleExecutionContext,
} from '../../src/core/executionContext.mjs';
