#!/usr/bin/env node
/**
 * The playground server.
 *
 * Two modes, and the difference is deliberate and visible:
 *
 *   npm start              preview only. Serves the application, answers the
 *                          capability probe, and executes nothing. `/api/run`
 *                          returns 501.
 *   npm run start:execute  attaches the local executor. Samples can really run.
 *
 * Security posture:
 *   * binds loopback; local execution is REFUSED on any other host
 *   * serves only `web/` and `src/`, with paths resolved and re-checked
 *   * sends a restrictive CSP with no inline script and no remote origins
 *   * loopback state-changing endpoints require a per-launch browser session,
 *     same-origin, a JSON content type and a bounded body
 *   * the browser never sends a plan, a command, a URL or a path — the server
 *     rebuilds all of them from its own catalogue
 *   * the relay URL and token are never disclosed to browser code
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSamplePlan, CATALOGUE, requirementsFor } from './src/catalogue/index.mjs';
import { summariseCapability } from './src/core/capability.mjs';
import { offlinePythonContext } from './src/core/executionContext.mjs';
import { EXECUTION_PROTOCOL_VERSION } from './src/core/types.mjs';
import { createRunManager } from './src/server/runManager.mjs';
import { RequestRefused } from './src/server/runRequest.mjs';
import { realTransports, spawnProcess } from './src/server/transports.mjs';
import { createPrivateAzureCliContext } from './src/server/azureCliContext.mjs';
import {
  createExecutionContextManager,
  validateLoginStartRequest,
  validateLoginTargetRequest,
  validateSubscriptionActivateRequest,
  validateSubscriptionListRequest,
} from './src/server/executionContextManager.mjs';
import { createCodeValidationManager, CODE_VALIDATION_SCENARIO } from './src/server/codeValidation.mjs';
import { validateSourceSampleId } from './src/server/recipeRequest.mjs';
import { readSampleSource, SourceViewError } from './src/server/sourceView.mjs';
import {
  createManagedIdentityCredentialProvider,
  createStaticTokenCredentialProvider,
} from './src/relay/relayCredential.mjs';
import {
  authenticatePrincipal,
  createContainerAppsEntraAuthenticator,
  createDenyAllAuthenticator,
  createSharedSecretAuthenticator,
} from './src/relay/principalAuth.mjs';
import {
  HostedAuthorizationConfigurationError,
  hostedAuthorizationConfigurationError,
  readHostedAuthorizationPolicy,
  validateHostedAuthorizationPolicy,
} from './src/relay/operatorAuthorization.mjs';
import { parseRelayAllowedSampleIds, rebuildRelayPlan, validateExecuteRequest } from './src/relay/requestSchema.mjs';
import { mintAcknowledgement, planRequestUrls } from './src/relay/acknowledgement.mjs';
import { raceAbortSignal } from './src/relay/deadline.mjs';
import {
  readRelayTokenContract,
  relayTokenConfigurationError,
  RelayTokenConfigurationError,
  validateRelayTokenContract,
} from './src/relay/tokenContract.mjs';
import { runSelfTest, SELF_TEST_SCENARIO, validateSelfTestRequest } from './src/server/selfTest.mjs';
import {
  createLocalSessionAuth,
  LOCAL_SESSION_BOOTSTRAP_HEADER,
  LOCAL_SESSION_CLAIM_PATH,
} from './src/server/localSessionAuth.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SERVED_ROOTS = ['web', 'src'].map((dir) => resolve(ROOT, dir));

const HOST = process.env.CITADEL_PLAYGROUND_HOST ?? '127.0.0.1';
const PYTHON = process.env.CITADEL_PLAYGROUND_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const DEFAULT_PLAYGROUND_RELAY_TIMEOUT_MS = 75_000;
const MAX_PLAYGROUND_RELAY_TIMEOUT_MS = 6 * 60_000;

/** Only these hosts may attach the local executor. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).replace(/^\[|\]$/g, ''));
}

export function resolvePlaygroundPort(host, configuredPort) {
  return Number(configuredPort ?? (isLoopbackHost(host) ? 0 : 4173));
}

function validatePlaygroundRelayTimeoutMs(value = DEFAULT_PLAYGROUND_RELAY_TIMEOUT_MS) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PLAYGROUND_RELAY_TIMEOUT_MS) {
    throw new RangeError(
      `Playground relay timeout must be an integer between 1 and ${MAX_PLAYGROUND_RELAY_TIMEOUT_MS}.`,
    );
  }
  return value;
}

function readPlaygroundRelayTimeoutMs(env) {
  const raw = env.CITADEL_PLAYGROUND_RELAY_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_PLAYGROUND_RELAY_TIMEOUT_MS;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new TypeError('CITADEL_PLAYGROUND_RELAY_TIMEOUT_MS must be an unsigned base-10 integer.');
  }
  return validatePlaygroundRelayTimeoutMs(Number(raw));
}

const PORT = resolvePlaygroundPort(HOST, process.env.CITADEL_PLAYGROUND_PORT);

/** Parse one canonical HTTPS origin; paths, credentials, query, and fragments are never trusted. */
export function parseTrustedPublicOrigin(rawValue, { name = 'CITADEL_PLAYGROUND_PUBLIC_ORIGIN' } = {}) {
  if (rawValue === undefined) return null;
  if (typeof rawValue !== 'string' || rawValue === '' || rawValue.trim() !== rawValue) {
    throw new TypeError(`${name} must be one exact HTTPS origin.`);
  }
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new TypeError(`${name} must be one exact HTTPS origin.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== rawValue
  ) {
    throw new TypeError(`${name} must be one canonical HTTPS origin with no path, credentials, query, or fragment.`);
  }
  return parsed.origin;
}

/**
 * Relay configuration. The URL and every credential are read here and never
 * sent to the browser: the browser only ever posts to the same-origin
 * `/api/execute`, and only the fixed shape `validateExecuteRequest` accepts.
 *
 * Three independent identity concepts are involved here, and they must not
 * be confused with one another:
 *   - `credentialProvider`  what THIS server presents TO the relay
 *     (`relayCredential.mjs`). Managed identity by default; a static token is
 *     opt-in only, for development or a relay not yet wired to a real
 *     identity provider.
 *   - `callerPrincipal`/`tenant`   the identity and tenant the RELAY'S OWN
 *     authenticator/tenant-policy resolves FOR THAT SAME credential. This is
 *     an operator-coordinated pairing, fixed for the lifetime of this
 *     deployment: whoever configures the relay's tenant policy for this
 *     proxy's credential must set these to the exact same values, or every
 *     forwarded acknowledgement fails the relay's own caller/tenant binding
 *     check. Never derived from a browser caller — a single proxy has one
 *     outbound identity to the relay, no matter how many browser sessions
 *     use it.
 *   - `authenticator`       what a CALLER of THIS server's `/api/execute`
 *     must present, when this server itself is bound to a non-loopback host
 *     (`principalAuth.mjs`). Loopback callers reach this layer only after the
 *     per-launch browser session has authenticated them. This is unrelated to
 *     the two identities above — it is about who may ask THIS proxy to run
 *     something, not about how this proxy identifies itself to the relay.
 *
 * `createPlaygroundServer({ relay })` can override this wholesale, so tests
 * never need to touch `process.env` or reach a real network.
 */
export function buildRelayConfig(env = process.env) {
  const url = env.CITADEL_PLAYGROUND_RELAY_URL ?? '';
  const trustedEntraProxy = env.CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED === 'true';
  if (url === '') {
    if (trustedEntraProxy) {
      throw new RelayTokenConfigurationError(
        'CITADEL_PLAYGROUND_RELAY_URL must be configured for the hosted playground.',
      );
    }
    return Object.freeze({ enabled: false });
  }

  const authMode = env.CITADEL_PLAYGROUND_RELAY_AUTH_MODE ?? 'managed-identity';
  if (trustedEntraProxy && authMode !== 'managed-identity') {
    throw new RelayTokenConfigurationError(
      'CITADEL_PLAYGROUND_RELAY_AUTH_MODE must be exactly managed-identity for the hosted playground.',
    );
  }
  const tokenContract = trustedEntraProxy
    ? readRelayTokenContract(env, {
        cloud: 'CITADEL_PLAYGROUND_AZURE_CLOUD',
        version: 'CITADEL_PLAYGROUND_RELAY_TOKEN_VERSION',
        issuer: 'CITADEL_PLAYGROUND_RELAY_TOKEN_ISSUER',
        resource: 'CITADEL_PLAYGROUND_RELAY_RESOURCE',
        audience: 'CITADEL_PLAYGROUND_RELAY_AUDIENCE',
        tenantId: 'CITADEL_PLAYGROUND_RELAY_TENANT',
        clientId: 'CITADEL_PLAYGROUND_RELAY_ENTRA_CLIENT_ID',
      })
    : null;
  if (
    tokenContract &&
    env.CITADEL_PLAYGROUND_ENTRA_TENANT_ID !== tokenContract.tenantId
  ) {
    throw new RelayTokenConfigurationError(
      'CITADEL_PLAYGROUND_ENTRA_TENANT_ID must exactly match CITADEL_PLAYGROUND_RELAY_TENANT.',
    );
  }
  const operatorAuthorizationPolicy = trustedEntraProxy
    ? readHostedAuthorizationPolicy(env)
    : null;
  const credentialProvider =
    authMode === 'static-token'
      ? createStaticTokenCredentialProvider({ token: env.CITADEL_PLAYGROUND_RELAY_TOKEN ?? '' })
      : createManagedIdentityCredentialProvider({
          resource: tokenContract?.resource ?? env.CITADEL_PLAYGROUND_RELAY_RESOURCE ?? url,
          clientId: env.CITADEL_PLAYGROUND_RELAY_CLIENT_ID || undefined,
          environment: env,
        });

  const executeToken = env.CITADEL_PLAYGROUND_EXECUTE_TOKEN ?? '';
  if (
    authMode === 'managed-identity' &&
    trustedEntraProxy &&
    (typeof env.CITADEL_PLAYGROUND_RELAY_CLIENT_ID !== 'string' ||
      env.CITADEL_PLAYGROUND_RELAY_CLIENT_ID.trim() === '')
  ) {
    throw new TypeError('CITADEL_PLAYGROUND_RELAY_CLIENT_ID must be configured for the hosted playground identity.');
  }
  // Fail closed: a non-loopback bind with nothing configured refuses every
  // `/api/execute` caller rather than accepting them all.
  const authenticator = trustedEntraProxy
    ? createContainerAppsEntraAuthenticator({
        tenantId: tokenContract.tenantId,
        clientId: env.CITADEL_PLAYGROUND_ENTRA_CLIENT_ID,
        ...operatorAuthorizationPolicy,
      })
    : executeToken
      ? createSharedSecretAuthenticator({ token: executeToken })
      : createDenyAllAuthenticator();

  // Fixed, operator-configured identity this proxy presents to the relay's
  // OWN tenant-policy check — see the doc comment above. Never blank: a
  // relay that now requires a non-empty caller/tenant on every binding would
  // otherwise reject every forwarded request outright.
  const callerPrincipal = env.CITADEL_PLAYGROUND_RELAY_CALLER_PRINCIPAL || 'citadel-playground-proxy';
  const tenant = tokenContract?.tenantId ?? (env.CITADEL_PLAYGROUND_RELAY_TENANT || 'default-tenant');
  const allowedSampleIds = parseRelayAllowedSampleIds(
    env.CITADEL_PLAYGROUND_RELAY_ALLOWED_SAMPLE_IDS,
    CATALOGUE,
    { buildSamplePlan, requirementsFor },
    { name: 'CITADEL_PLAYGROUND_RELAY_ALLOWED_SAMPLE_IDS' },
  );

  return Object.freeze({
    enabled: true,
    url,
    fetchImpl: null,
    credentialProvider,
    authenticator,
    allowedSampleIds,
    callerPrincipal,
    tenant,
    timeoutMs: readPlaygroundRelayTimeoutMs(env),
    hosted: trustedEntraProxy,
    tokenContract,
    operatorAuthorizationPolicy,
  });
}

function buildDefaultRelayConfig(env = process.env) {
  try {
    return buildRelayConfig(env);
  } catch (error) {
    if (
      !(error instanceof RelayTokenConfigurationError) &&
      !(error instanceof HostedAuthorizationConfigurationError)
    ) {
      throw error;
    }
    return Object.freeze({
      enabled: true,
      hosted: true,
      allowedSampleIds: Object.freeze([]),
      configurationError:
        error instanceof RelayTokenConfigurationError
          ? relayTokenConfigurationError(error)
          : hostedAuthorizationConfigurationError(error),
    });
  }
}

const DEFAULT_RELAY_CONFIG = buildDefaultRelayConfig();
const DEFAULT_PUBLIC_ORIGIN = parseTrustedPublicOrigin(process.env.CITADEL_PLAYGROUND_PUBLIC_ORIGIN);

const MIME = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
  }),
);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cache-Control': 'no-store',
  };
}

/**
 * Resolve a request path to a file inside an allowed root, or null.
 * Exported so a test can assert traversal attempts are refused.
 */
export function resolveServedPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const requested = decoded === '/' ? '/web/index.html' : decoded;
  if (requested.includes('\0')) return null;
  const candidate = resolve(ROOT, `.${normalize(requested)}`);
  const allowed = SERVED_ROOTS.some((root) => candidate === root || candidate.startsWith(root + sep));
  return allowed ? candidate : null;
}

/* ----------------------------------------------------- runtime capability */

/**
 * Probe the runtimes the samples declare, once at startup.
 *
 * Nothing here contacts Azure or the user's gateway: `az version` and a Python
 * import check are local. Reachability of a customer endpoint is deliberately
 * NOT probed, because making that call is not something the playground has
 * consent to do before the user presses Run.
 */
export async function probeRuntimes({ mode, python = PYTHON, spawn = spawnProcess, root = ROOT } = {}) {
  if (mode !== 'execute') return { mode };
  const modules = [...new Set(CATALOGUE.samples.flatMap((sample) => sample.runtime?.python?.modules ?? []))];

  const [azureCli, py, accelerator] = await Promise.all([
    spawn({ executable: 'az', args: ['version', '-o', 'json'], cwd: root, timeoutMs: 30_000 })
      .then((result) =>
        result.code === 0
          ? { available: true, version: cliVersion(result.stdout) }
          : { available: false, reason: cliReason(result) },
      )
      .catch((error) => ({ available: false, reason: String(error?.message ?? error) })),
    probePython(python, modules, spawn, root),
    countAccelerator(root),
  ]);

  return { mode, azureCli, python: py, accelerator };
}

async function probePython(python, modules, spawn, root) {
  const probeSource = [
    'import json,sys,importlib.util',
    `mods=${JSON.stringify(modules)}`,
    'def present(name):',
    '    try:',
    '        return importlib.util.find_spec(name) is not None',
    '    except (ImportError, ModuleNotFoundError):',
    '        return False',
    'print(json.dumps({"version":sys.version.split()[0],"modules":{m:present(m) for m in mods}}))',
  ].join('\n');
  try {
    const result = await spawn({
      executable: python,
      args: ['-c', probeSource],
      cwd: root,
      timeoutMs: 30_000,
      allowedExecutables: [python],
    });
    if (result.code !== 0) {
      return {
        available: false,
        reason: `No usable Python interpreter at \`${python}\`. Install Python 3.10 or newer; nothing is installed for you.`,
      };
    }
    const payload = JSON.parse(result.stdout.trim().split('\n').pop());
    return { available: true, version: payload.version, modules: payload.modules };
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) };
  }
}

async function countAccelerator(root) {
  try {
    const base = resolve(root, 'runtime', 'accelerator');
    let files = 0;
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(resolve(dir, entry.name));
        else files += 1;
      }
    };
    await walk(base);
    return files > 0 ? { available: true, files } : { available: false, reason: 'The vendored bundle is empty.' };
  } catch {
    return { available: false, reason: 'The vendored bundle under `runtime/accelerator` is missing.' };
  }
}

function cliVersion(text) {
  try {
    return JSON.parse(text)['azure-cli'] ?? 'available';
  } catch {
    return String(text ?? '').split('\n')[0].trim() || 'available';
  }
}

function cliReason(result) {
  return result.spawnFailed
    ? 'The Azure CLI was not found on PATH. Install it, then restart the playground.'
    : `\`az version\` exited ${result.code}. Repair the Azure CLI installation and restart the playground.`;
}

/** What the browser is told about execution capability. No secrets, ever. */
export function capabilitiesPayload({
  mode = 'preview',
  probe = {},
  relay = DEFAULT_RELAY_CONFIG,
  allowSystemAzureLogin = false,
  sessionAuth = { required: false, state: 'not-required', claimEndpoint: null, message: '' },
  operatorAuthorization = {
    required: false,
    signedIn: false,
    authorized: true,
    state: 'not-required',
    message: '',
  },
} = {}) {
  const capability = summariseCapability(CATALOGUE.samples, { ...probe, mode });
  const relayStatus = relayConfigurationStatus(relay);
  const sessionReady = sessionAuth.required !== true || sessionAuth.state === 'claimed';
  const operatorReady = operatorAuthorization.required !== true || operatorAuthorization.authorized === true;
  const azureControlsAvailable =
    mode === 'execute' &&
    allowSystemAzureLogin === true &&
    sessionReady &&
    operatorReady &&
    relay.enabled !== true;
  const secureLaunchMessage = sessionAuth.message || 'Open the secure launch URL shown in the terminal.';
  return {
    status: relayStatus.ok ? 'ok' : 'error',
    ...(relayStatus.ok ? {} : { code: relayStatus.code, detail: relayStatus.detail }),
    application: 'citadel-publish-playground',
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    mode,
    capability,
    executor: !relayStatus.ok
      ? {
          kind: 'unavailable',
          canExecute: false,
          endpoint: null,
          supportedStepTypes: [],
          reason: relayStatus.detail,
        }
      : !sessionReady
      ? {
          kind: 'unavailable',
          canExecute: false,
          endpoint: null,
          supportedStepTypes: [],
          reason: secureLaunchMessage,
        }
      : !operatorReady
        ? {
            kind: 'unavailable',
            canExecute: false,
            endpoint: null,
            supportedStepTypes: [],
            reason: operatorAuthorization.message || 'This signed-in account is not authorized to operate the hosted playground.',
          }
      : relay.enabled
        ? {
            kind: 'relay',
            canExecute: relay.allowedSampleIds.length > 0,
            endpoint: '/api/execute',
            supportedStepTypes: ['http', 'assertion'],
            // The exact sample ids the relay will run — never a claim wider
            // than reality. A caller has no way to widen this from the wire.
            allowedSampleIds: [...relay.allowedSampleIds],
            reason:
              relay.allowedSampleIds.length > 0
                ? 'An approved relay is configured on the local server. It executes a fixed, explicitly allow-listed set of read-only catalogue samples.'
                : 'The relay is configured, but this deployment enables no catalogue samples.',
          }
        : mode === 'execute'
          ? {
              kind: 'local',
              canExecute: true,
              endpoint: '/api/run',
              supportedStepTypes: ['artifact', 'azure-cli', 'http', 'library', 'assertion'],
              reason: capability.detail,
            }
          : {
              kind: 'unavailable',
              canExecute: false,
              endpoint: null,
              supportedStepTypes: [],
              reason:
                'No execution runtime is attached. Plans are generated and previewed only; nothing is sent anywhere. Start with `npm run start:execute` to attach the local executor.',
            },
    sessionAuth,
    operatorAuthorization,
    // Presence only. The URL and every credential are never disclosed.
    relayConfigured: relay.enabled,
    // Always available, in every mode: it never depends on Azure CLI, Python,
    // a relay, or an operator credential — see `src/server/selfTest.mjs`.
    selfTest: Object.freeze({
      endpoint: '/api/self-test',
      available: sessionReady && operatorReady,
      scenario: SELF_TEST_SCENARIO,
    }),
    protectedSource: Object.freeze({
      endpointTemplate: '/api/source/{sampleId}',
      available: true,
      editable: false,
      source: 'imported-notebook',
    }),
    sourceValidation: Object.freeze({
      endpointTemplate: '/api/source/{sampleId}/validate',
      available: mode === 'execute' && sessionReady && operatorReady,
      scenario: CODE_VALIDATION_SCENARIO,
      mode: 'offline-local',
      validation: 'python-compile-only',
      sourceExecuted: false,
      azureContacted: false,
      networkContacted: false,
      liveEvidence: false,
      executionIdentity: 'local-python-parser',
    }),
    executionContext: Object.freeze({
      endpoint: sessionReady && operatorReady ? '/api/execution-context' : null,
    }),
    azureAuth: Object.freeze({
      systemLogin: Object.freeze({
        available: azureControlsAvailable,
        state: azureControlsAvailable ? 'available' : 'login-disabled',
        loginId: 'azure-system-login',
        startEndpoint: azureControlsAvailable ? '/api/azure-auth/start' : null,
        statusEndpoint: azureControlsAvailable ? '/api/azure-auth/status' : null,
        cancelEndpoint: azureControlsAvailable ? '/api/azure-auth/cancel' : null,
      }),
      subscriptions: Object.freeze({
        available: azureControlsAvailable,
        listEndpoint: azureControlsAvailable ? '/api/azure-subscriptions/list' : null,
        activateEndpoint: azureControlsAvailable ? '/api/azure-subscriptions/activate' : null,
        warning: 'Changing the active subscription affects only this Citadel playground launch.',
      }),
    }),
  };
}

export function relayConfigurationStatus(relay) {
  if (relay?.hosted !== true) return Object.freeze({ ok: true });
  if (relay.configurationError) return Object.freeze({ ok: false, ...relay.configurationError });
  try {
    if (!relay.enabled) {
      throw new RelayTokenConfigurationError(
        'CITADEL_PLAYGROUND_RELAY_URL must be configured for the hosted playground.',
      );
    }
    validateRelayTokenContract(relay.tokenContract);
    validateHostedAuthorizationPolicy(relay.operatorAuthorizationPolicy);
    if (relay.authenticator?.mode !== 'container-apps-entra') {
      throw new HostedAuthorizationConfigurationError(
        'the hosted playground must use the Container Apps Entra authenticator.',
      );
    }
    return Object.freeze({ ok: true });
  } catch (error) {
    if (error instanceof RelayTokenConfigurationError) {
      return Object.freeze({ ok: false, ...relayTokenConfigurationError(error) });
    }
    if (error instanceof HostedAuthorizationConfigurationError) {
      return Object.freeze({ ok: false, ...hostedAuthorizationConfigurationError(error) });
    }
    throw error;
  }
}

function send(response, status, headers, body) {
  response.writeHead(status, headers);
  response.end(body);
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  send(response, status, { ...securityHeaders('application/json; charset=utf-8'), ...headers }, body);
}

async function readBody(request, limitBytes = 256 * 1024, limitLabel = '256 KB') {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new RequestRefused(`The request body is larger than the ${limitLabel} limit.`, { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function monitorClientDisconnect(request, response, { signal, timeoutMs } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => {
    if (!response.writableEnded) controller.abort();
  };
  const timer = timeoutMs == null
    ? null
    : setTimeout(() => {
        timedOut = true;
        abort();
      }, validatePlaygroundRelayTimeoutMs(timeoutMs));
  request.once('aborted', abort);
  response.once('close', abort);
  request.socket?.once('close', abort);
  signal?.addEventListener('abort', abort, { once: true });
  if (request.aborted || response.destroyed || request.socket?.destroyed || signal?.aborted) controller.abort();
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      request.off('aborted', abort);
      response.off('close', abort);
      request.socket?.off('close', abort);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function finishStoppedRelayRequest(request, response, lifetime) {
  if (!lifetime.signal.aborted) return false;
  if (lifetime.timedOut && !response.destroyed && !response.writableEnded) {
    response.once('finish', () => request.destroy());
    sendJson(response, 504, {
      state: 'failed',
      summary: 'The relay request exceeded the playground time limit.',
      code: 'relay-timeout',
    }, { Connection: 'close' });
  }
  return true;
}

/**
 * Same-origin guard for every state-changing call.
 *
 * `Sec-Fetch-Site` is the primary check where the browser sends it; `Origin` is
 * the fallback. A cross-site page therefore cannot drive this API even though
 * it is bound to loopback, and requiring a JSON content type keeps it out of
 * reach of a simple form post.
 */
export function checkStateChangingRequest(
  request,
  {
    port = PORT,
    host = HOST,
    browserHost = null,
    publicOrigin = DEFAULT_PUBLIC_ORIGIN,
    requireOrigin = false,
  } = {},
) {
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, message: `Refused a ${site} request. This API is same-origin only.` };
  }
  const origin = request.headers.origin;
  if (isLoopbackHost(host)) {
    if (requireOrigin && !origin) {
      return { ok: false, status: 403, message: 'Refused a request without an Origin header.' };
    }
    const effectivePort = request.socket?.localPort ?? port;
    const expected = new Set(
      browserHost
        ? [httpOrigin(browserHost, effectivePort)]
        : [
            httpOrigin(host, effectivePort),
            httpOrigin('localhost', effectivePort),
            httpOrigin('127.0.0.1', effectivePort),
          ],
    );
    if (publicOrigin) expected.add(publicOrigin);
    if (origin && !expected.has(origin)) {
      return { ok: false, status: 403, message: `Refused a request from origin ${origin}.` };
    }
  } else {
    if (!publicOrigin) {
      return { ok: false, status: 403, message: 'Refused a state-changing request because no trusted public origin is configured.' };
    }
    if (origin !== publicOrigin) {
      return { ok: false, status: 403, message: `Refused a request from origin ${origin ?? '(missing)'}.` };
    }
  }
  const contentType = String(request.headers['content-type'] ?? '');
  if (!contentType.startsWith('application/json')) {
    return { ok: false, status: 415, message: 'This endpoint accepts application/json only.' };
  }
  return { ok: true };
}

function isPrivilegedLocalPath(path) {
  return path.startsWith('/api/') && path !== LOCAL_SESSION_CLAIM_PATH;
}

function requireLocalSession(request, response, localSessionAuth) {
  if (!localSessionAuth) return true;
  const authorization = localSessionAuth.authorize(request);
  if (authorization.ok) return true;
  sendJson(response, authorization.status, {
    state: 'blocked',
    summary: authorization.message,
    code: authorization.code,
  });
  return false;
}

function hostedAuthorizationDescriptor(result) {
  if (result?.ok) {
    return Object.freeze({
      required: true,
      signedIn: true,
      authorized: true,
      state: 'authorized',
      message: 'Signed in. Authorized to operate.',
    });
  }
  if (result?.authenticated === true || result?.status === 403) {
    return Object.freeze({
      required: true,
      signedIn: true,
      authorized: false,
      state: 'signed-in-not-authorized',
      message: 'Signed in. Not authorized to operate.',
    });
  }
  return Object.freeze({
    required: true,
    signedIn: false,
    authorized: false,
    state: 'not-signed-in',
    message: 'Not signed in. Hosted operator authorization is required.',
  });
}

async function authenticateHostedOperator(request, relay) {
  const status = relayConfigurationStatus(relay);
  if (!status.ok) {
    return {
      ok: false,
      status: 503,
      configurationError: status,
      descriptor: Object.freeze({
        required: true,
        signedIn: false,
        authorized: false,
        state: 'configuration-error',
        message: 'Hosted operator authorization is not configured.',
      }),
    };
  }
  const result = await relay.authenticator.authenticate(request);
  return { ...result, descriptor: hostedAuthorizationDescriptor(result) };
}

function sendHostedAuthorizationFailure(response, authorization) {
  if (authorization.configurationError) {
    sendJson(response, 503, {
      state: 'blocked',
      summary: 'Hosted operator authorization configuration is invalid.',
      ...authorization.configurationError,
    });
    return;
  }
  const status = authorization.status ?? 401;
  sendJson(response, status, {
    state: 'blocked',
    summary:
      status === 403
        ? 'Signed in, but not authorized to operate.'
        : status === 431
          ? 'The authentication context is too large.'
          : 'The caller could not be authenticated.',
    code:
      status === 403
        ? 'hosted-operator-not-authorized'
        : status === 431
          ? 'authentication-header-too-large'
          : 'unauthenticated',
  });
}

async function handleSessionClaim(request, response, { localSessionAuth, port, host, browserHost, publicOrigin }) {
  if (!localSessionAuth) {
    send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
    return;
  }
  const guard = checkStateChangingRequest(request, {
    port,
    host,
    browserHost,
    publicOrigin,
    requireOrigin: true,
  });
  if (!guard.ok) {
    sendJson(response, guard.status, { state: 'blocked', summary: guard.message, code: 'claim-refused' });
    return;
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers['content-type'] ?? ''))) {
    sendJson(response, 415, {
      state: 'blocked',
      summary: 'The local session claim accepts application/json only.',
      code: 'invalid-claim',
    });
    return;
  }
  if (request.headers['content-encoding']) {
    sendJson(response, 415, {
      state: 'blocked',
      summary: 'The local session claim does not accept content encoding.',
      code: 'invalid-claim',
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(request, 1024, '1 KB'));
  } catch (error) {
    const status = error instanceof RequestRefused ? error.status : 400;
    sendJson(response, status, {
      state: 'blocked',
      summary: status === 413 ? error.message : 'The local session claim is invalid.',
      code: 'invalid-claim',
    });
    return;
  }

  const result = localSessionAuth.claim({
    request,
    payload,
    capability: request.headers[LOCAL_SESSION_BOOTSTRAP_HEADER.toLowerCase()],
  });
  if (!result.ok) {
    sendJson(response, result.status, { state: 'blocked', summary: result.message, code: result.code });
    return;
  }
  send(response, 204, { ...securityHeaders('application/json; charset=utf-8'), 'Set-Cookie': result.cookie }, '');
}

function httpOrigin(host, port) {
  const hostname = String(host).replace(/^\[|\]$/g, '');
  const url = new URL('http://localhost');
  url.hostname = hostname.includes(':') ? `[${hostname}]` : hostname;
  url.port = String(port);
  return url.origin;
}

async function handleExecute(
  request,
  response,
  { port, host, browserHost, publicOrigin, relay, authorizedCaller = null },
) {
  const lifetime = monitorClientDisconnect(request, response, {
    timeoutMs: relay.timeoutMs ?? DEFAULT_PLAYGROUND_RELAY_TIMEOUT_MS,
  });
  try {
    await forwardRelayExecute(request, response, {
      port,
      host,
      browserHost,
      publicOrigin,
      relay,
      authorizedCaller,
      lifetime,
    });
  } finally {
    lifetime.dispose();
  }
}

async function forwardRelayExecute(
  request,
  response,
  { port, host, browserHost, publicOrigin, relay, authorizedCaller = null, lifetime },
) {
  const guard = checkStateChangingRequest(request, {
    port,
    host,
    browserHost,
    publicOrigin,
    requireOrigin: isLoopbackHost(host),
  });
  if (!guard.ok) {
    sendJson(response, guard.status, { state: 'blocked', summary: guard.message });
    return;
  }
  if (!relay.enabled) {
    sendJson(response, 501, {
      state: 'blocked',
      summary: 'Not run — no relay is configured on this server.',
      detail:
        'Set CITADEL_PLAYGROUND_RELAY_URL to attach an approved execution relay, or start the server with `npm run start:execute` to use the local executor instead.',
    });
    return;
  }
  const relayStatus = relayConfigurationStatus(relay);
  if (!relayStatus.ok) {
    sendJson(response, 503, {
      state: 'blocked',
      summary: 'Not run - hosted relay authentication configuration is invalid.',
      code: relayStatus.code,
      detail: relayStatus.detail,
    });
    return;
  }

  // The router has already authenticated loopback callers with the per-launch
  // browser session. A non-loopback bind must present a principal the configured
  // authenticator accepts; nothing here fails open.
  let auth = authorizedCaller;
  if (!auth) {
    try {
      auth = await raceAbortSignal(
        authenticatePrincipal(request, {
          isLoopbackHost,
          host,
          authenticator: relay.authenticator ?? createDenyAllAuthenticator(),
        }),
        lifetime.signal,
      );
    } catch (error) {
      if (finishStoppedRelayRequest(request, response, lifetime)) return;
      throw error;
    }
  }
  if (!auth.ok) {
    sendHostedAuthorizationFailure(response, auth);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await raceAbortSignal(readBody(request), lifetime.signal));
  } catch (error) {
    if (finishStoppedRelayRequest(request, response, lifetime)) return;
    const status = error instanceof RequestRefused ? error.status : 400;
    sendJson(response, status, { state: 'blocked', summary: error?.message ?? 'Malformed request body.' });
    return;
  }

  // Exact-schema validation against the server's OWN catalogue and the
  // relay's own allow-list. The browser cannot smuggle a plan, a URL, a
  // header set or an out-of-list sample through this endpoint — only the
  // canonical, server-validated shape below is ever forwarded.
  let sample;
  let inputs;
  let secretRefs;
  let acknowledgement;
  try {
    ({ sample, inputs, secretRefs, acknowledgement } = validateExecuteRequest(payload, CATALOGUE, {
      relayAllowedSampleIds: relay.allowedSampleIds,
    }));
  } catch (error) {
    if (error instanceof RequestRefused) {
      sendJson(response, error.status, { state: 'blocked', summary: error.message, code: error.code });
      return;
    }
    sendJson(response, 400, { state: 'failed', summary: 'Malformed request body.' });
    return;
  }

  // The local proxy — never the browser — mints the acknowledgement the
  // relay's own `verifyAcknowledgement` re-checks, on every forwarded
  // request regardless of whether this particular sample required a
  // user-facing risk prompt. It is bound to exactly the request about to be
  // forwarded: the server-validated sample id, the server-validated inputs
  // (never whatever the browser happened to send), the destination
  // origin(s) THIS PROXY'S OWN REBUILT PLAN will actually contact, and that
  // sample's current risk description — so a captured acknowledgement
  // cannot be replayed against a different sample, a different destination,
  // different inputs, or a stale risk disclosure. `caller`/`tenant` name the
  // fixed, operator-configured identity the RELAY'S OWN
  // authenticator/tenant-policy resolves for THIS proxy's credential (see
  // `buildRelayConfig`'s doc comment) — never `auth.principal` above, which
  // is a browser-facing identity for an entirely different hop and has no
  // bearing on what the relay authorizes for this proxy. `acknowledgement`
  // here is the browser's own consent flag for the local risk prompt
  // (irrelevant to relay-eligible samples today, since only
  // `risk.level === 'read-only'` samples are ever relay-allowed) and is not
  // forwarded — the relay only trusts what this proxy just minted, never
  // what the browser asserted.
  //
  // The destination is derived from a PLAN THIS PROXY REBUILDS ITSELF —
  // never from `inputs['hub.gatewayUrl']` directly — because a sample whose
  // `deployedEndpoint` is set contacts that authoritative endpoint instead
  // (see `mcpEndpoint()` in `src/core/endpoints.mjs`); reading the raw
  // gateway-URL input would bind the acknowledgement to an origin the plan
  // will never actually contact. The relay rebuilds the identical plan from
  // the identical catalogue and validated inputs and independently derives
  // the same request-URL set — this proxy never tells it what to expect.
  //
  // The acknowledgement binds to the EXACT literal request URL(s), not
  // merely their origin(s): the relay's own per-tenant request policy
  // (`requestPolicy.mjs`) authorizes a sample/step by its exact URL and
  // secret-bearing header name, precisely because an allowed ORIGIN alone
  // cannot distinguish a legitimate route from a caller-controlled path or
  // renamed header on that same origin. Binding the acknowledgement one
  // level coarser than that policy would let it silently cover requests the
  // policy itself would refuse.
  void acknowledgement;
  let plan;
  try {
    ({ plan } = rebuildRelayPlan({ sample, inputs }, CATALOGUE, { buildSamplePlan, requirementsFor }));
  } catch (error) {
    if (error instanceof RequestRefused) {
      sendJson(response, error.status, { state: 'blocked', summary: error.message, code: error.code });
      return;
    }
    sendJson(response, 502, { state: 'failed', summary: 'Not run — could not reconstruct this sample\u2019s execution plan.' });
    return;
  }
  // Sorted so a sample whose plan legitimately touches more than one request
  // URL binds deterministically to its full set, regardless of step order —
  // never to one arbitrarily chosen member of it.
  const requestUrls = [...planRequestUrls(plan)].sort();
  if (requestUrls.length === 0) {
    sendJson(response, 502, {
      state: 'failed',
      summary: 'Not run — this sample has no resolvable gateway destination to bind the acknowledgement to.',
    });
    return;
  }
  const target = requestUrls.length === 1 ? requestUrls[0] : requestUrls;

  let forwarded;
  try {
    forwarded = {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sampleId: sample.id,
      inputs,
      secretRefs,
      acknowledgement: mintAcknowledgement({
        sampleId: sample.id,
        inputs,
        secretRefs,
        target,
        riskText: sample.risk?.effect ?? '',
        caller: relay.callerPrincipal,
        tenant: relay.tenant,
      }),
    };
  } catch (error) {
    void error;
    sendJson(response, 502, {
      state: 'failed',
      summary: 'Not run — could not mint a bound acknowledgement for this request.',
    });
    return;
  }

  let authorization;
  try {
    authorization = await raceAbortSignal(
      relay.credentialProvider.getAuthorizationHeader({ signal: lifetime.signal }),
      lifetime.signal,
    );
  } catch (error) {
    if (finishStoppedRelayRequest(request, response, lifetime)) return;
    void error;
    sendJson(response, 502, {
      state: 'failed',
      summary: 'Could not obtain a credential for the relay.',
    });
    return;
  }

  try {
    const doFetch = relay.fetchImpl ?? fetch;
    const upstream = await raceAbortSignal(
      doFetch(relay.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: authorization,
        },
        body: JSON.stringify(forwarded),
        signal: lifetime.signal,
      }),
      lifetime.signal,
    );
    const text = await raceAbortSignal(upstream.text(), lifetime.signal);
    if (finishStoppedRelayRequest(request, response, lifetime)) return;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      sendJson(response, 502, {
        state: 'inconclusive',
        summary: 'The relay answered with something that is not JSON.',
        detail: 'Treating an unrecognised relay response as inconclusive rather than as a pass.',
      });
      return;
    }
    sendJson(response, upstream.ok ? 200 : 502, parsed);
  } catch (error) {
    if (finishStoppedRelayRequest(request, response, lifetime)) return;
    void error;
    sendJson(response, 502, {
      state: 'failed',
      summary: 'The relay could not be reached.',
    });
  }
}

async function handleStatic(request, response) {
  const filePath = resolveServedPath(request.url ?? '/');
  if (!filePath) {
    send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
      return;
    }
    const body = await readFile(filePath);
    const contentType = MIME.get(extname(filePath)) ?? 'application/octet-stream';
    send(response, 200, securityHeaders(contentType), body);
  } catch {
    send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
  }
}

async function handleRun(request, response, { mode, manager, port, host, browserHost, publicOrigin, shutdownSignal }) {
  const guard = checkStateChangingRequest(request, {
    port,
    host,
    browserHost,
    publicOrigin,
    requireOrigin: isLoopbackHost(host),
  });
  if (!guard.ok) {
    sendJson(response, guard.status, { state: 'blocked', summary: guard.message });
    return;
  }
  if (mode !== 'execute' || !manager) {
    sendJson(response, 501, {
      state: 'blocked',
      summary: 'Not run — this server was started in preview mode.',
      detail:
        'Restart with `npm run start:execute` (or `node server.mjs --execute`) to attach the local executor. Preview mode generates and inspects plans and executes nothing.',
    });
    return;
  }
  const disconnect = monitorClientDisconnect(request, response, { signal: shutdownSignal });
  try {
    let payload;
    try {
      payload = JSON.parse(await readBody(request));
    } catch (error) {
      if (disconnect.signal.aborted && response.destroyed) return;
      const status = error instanceof RequestRefused ? error.status : 400;
      sendJson(response, status, { state: 'failed', summary: error?.message ?? 'Malformed request body.' });
      return;
    }
    let started = false;
    const wantsStream = String(request.headers.accept ?? '').includes('application/x-ndjson');
    const writeEvent = (event) => {
      if (started && !response.destroyed && !response.writableEnded) {
        response.write(`${JSON.stringify(event)}\n`);
      }
    };
    if (disconnect.signal.aborted) {
      throw new RequestRefused('The run request was cancelled before execution started.', {
        status: 409,
        code: 'run-cancelled',
      });
    }
    const result = await manager.start(payload, {
      onStart: ({ runId, sampleId, workspace, executionContext }) => {
        response.writeHead(200, {
          ...securityHeaders(wantsStream ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8'),
          'X-Citadel-Run-Id': runId,
        });
        response.flushHeaders();
        started = true;
        if (wantsStream) writeEvent({ type: 'run-start', runId, sampleId, workspace, executionContext });
      },
      onProgress: wantsStream ? writeEvent : undefined,
      signal: disconnect.signal,
    });
    if (started && wantsStream) {
      writeEvent({ type: 'result', result });
      response.end();
    } else if (started) response.end(JSON.stringify(result));
    else sendJson(response, 200, result);
  } catch (error) {
    if (disconnect.signal.aborted && response.destroyed) return;
    if (response.headersSent) {
      const failed = {
        state: 'failed',
        summary: 'The run stopped after it started but before it could report a result.',
      };
      if (String(request.headers.accept ?? '').includes('application/x-ndjson')) {
        response.end(`${JSON.stringify({ type: 'result', result: failed })}\n`);
      } else {
        response.end(JSON.stringify(failed));
      }

      return;
    }
    if (error instanceof RequestRefused) {
      sendJson(response, error.status, { state: 'blocked', summary: error.message, code: error.code });
      return;
    }
    // Deliberately terse: a stack trace could carry a path or a value.
    sendJson(response, 500, { state: 'failed', summary: 'The run could not be started.' });
  } finally {
    disconnect.dispose();
  }
}

async function handleExecutionContext(
  request,
  response,
  { manager, port, host, browserHost, publicOrigin, authorizedCaller = null },
) {
  const guard = checkStateChangingRequest(request, {
    port,
    host,
    browserHost,
    publicOrigin,
    requireOrigin: isLoopbackHost(host),
  });
  if (!guard.ok) {
    sendJson(response, guard.status, { state: 'blocked', summary: guard.message });
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnClose = () => {
    if (!response.writableEnded) abort();
  };
  request.once('aborted', abort);
  response.once('close', abortOnClose);
  try {
    const payload = JSON.parse(await readBody(request, 16 * 1024));
    sendJson(
      response,
      200,
      await manager.describe(payload, CATALOGUE, {
        signal: controller.signal,
        operatorAuthorization: authorizedCaller,
      }),
    );
  } catch (error) {
    if (controller.signal.aborted && response.destroyed) return;
    if (error instanceof RequestRefused) {
      sendJson(response, error.status, { state: 'blocked', summary: error.message, code: error.code });
      return;
    }
    sendJson(response, 500, { state: 'failed', summary: 'The execution context could not be read.' });
  } finally {
    request.off('aborted', abort);
    response.off('close', abortOnClose);
  }
}

async function handleAzureLogin(request, response, { action, manager, port, host, browserHost, publicOrigin }) {
  const guard = checkStateChangingRequest(request, {
    port,
    host,
    browserHost,
    publicOrigin,
    requireOrigin: isLoopbackHost(host),
  });
  if (!guard.ok) {
    sendJson(response, guard.status, { state: 'blocked', summary: guard.message });
    return;
  }
  let startedLoginId = null;
  const cancelDisconnectedStart = () => {
    if (action !== 'start' || !startedLoginId || response.writableEnded) return;
    try {
      manager.cancelSystemLogin(startedLoginId);
    } catch {
      // The login may already have reached a terminal state.
    }
  };
  request.once('aborted', cancelDisconnectedStart);
  response.once('close', cancelDisconnectedStart);
  try {
    const payload = JSON.parse(await readBody(request, 4096));
    let result;
    if (action === 'start') {
      validateLoginStartRequest(payload);
      result = manager.startSystemLogin();
      startedLoginId = result.login.id;
    } else {
      const loginId = validateLoginTargetRequest(payload);
      result =
        action === 'status'
          ? manager.statusSystemLogin(loginId)
          : manager.cancelSystemLogin(loginId);
    }
    sendJson(response, action === 'start' ? 202 : 200, result);
  } catch (error) {
    if (error instanceof RequestRefused) {
      const current =
        error.code === 'login-in-progress' && typeof manager.currentSystemLogin === 'function'
          ? manager.currentSystemLogin()
          : null;
      sendJson(response, error.status, {
        state: 'blocked',
        summary: error.message,
        code: error.code,
        ...(error.code === 'login-disabled'
          ? {
              login: {
                id: 'azure-system-login',
                state: 'login-disabled',
                code: 'login-disabled',
                message: error.message,
                accountChange: 'unverified',
              },
              context: null,
            }
          : {}),
        ...(current ?? {}),
      });
      return;
    }
    sendJson(response, 500, { state: 'failed', summary: 'The Azure CLI login request could not be completed.' });
  } finally {
    request.off('aborted', cancelDisconnectedStart);
    response.off('close', cancelDisconnectedStart);
  }
}

async function handleAzureSubscriptions(request, response, { action, manager, port, host, browserHost, publicOrigin }) {
  const guard = checkStateChangingRequest(request, {
    port,
    host,
    browserHost,
    publicOrigin,
    requireOrigin: isLoopbackHost(host),
  });
  if (!guard.ok) {
    sendJson(response, guard.status, { state: 'blocked', summary: guard.message });
    return;
  }
  const disconnect = monitorClientDisconnect(request, response);
  try {
    const payload = JSON.parse(await readBody(request, 4096));
    let result;
    if (action === 'list') {
      validateSubscriptionListRequest(payload);
      result = await manager.listSubscriptions({ signal: disconnect.signal });
    } else {
      const subscriptionId = validateSubscriptionActivateRequest(payload);
      result = await manager.activateSubscription(subscriptionId, { signal: disconnect.signal });
    }
    if (response.destroyed) return;
    sendJson(response, 200, result);
  } catch (error) {
    if (disconnect.signal.aborted && response.destroyed) return;
    if (error instanceof RequestRefused) {
      sendJson(response, error.status, {
        state: 'blocked',
        summary: error.message,
        code: error.code,
      });
      return;
    }
    sendJson(response, 500, {
      state: 'failed',
      summary: 'The Azure CLI subscription request could not be completed.',
    });
  } finally {
    disconnect.dispose();
  }
}

async function handleCancel(request, response, { manager, port, host, browserHost, publicOrigin }) {
  const guard = checkStateChangingRequest(request, {
    port,
    host,
    browserHost,
    publicOrigin,
    requireOrigin: isLoopbackHost(host),
  });
  if (!guard.ok) {
    sendJson(response, guard.status, { cancelled: false, reason: guard.message });
    return;
  }
  if (!manager) {
    sendJson(response, 501, { cancelled: false, reason: 'Nothing can be running in preview mode.' });
    return;
  }
  let payload = {};
  try {
    payload = JSON.parse(await readBody(request, 4096));
  } catch {
    sendJson(response, 400, { cancelled: false, reason: 'Malformed request body.' });
    return;
  }
  if (typeof payload.runId !== 'string' || !/^[a-z0-9-]{1,72}$/.test(payload.runId)) {
    sendJson(response, 400, { cancelled: false, reason: 'A runId is required.' });
    return;
  }
  sendJson(response, 200, manager.cancel(payload.runId));
}

/**
 * Offline self-test: server-authoritative, zero-setup, no Azure and no
 * network side effect. Available in both preview and operator mode, and
 * guarded exactly like every other state-changing endpoint even though it
 * changes nothing, so it cannot be triggered from a cross-site page.
 */
async function handleSelfTest(request, response, { mode, port, host, browserHost, publicOrigin }) {
  const guard = checkStateChangingRequest(request, {
    port,
    host,
    browserHost,
    publicOrigin,
    requireOrigin: isLoopbackHost(host),
  });
  if (!guard.ok) {
    sendJson(response, guard.status, {
      scenario: SELF_TEST_SCENARIO,
      state: 'blocked',
      summary: guard.message,
      azureContacted: false,
      liveEvidence: false,
    });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(request, 4096));
  } catch (error) {
    const status = error instanceof RequestRefused ? error.status : 400;
    sendJson(response, status, {
      scenario: SELF_TEST_SCENARIO,
      state: 'failed',
      summary: error?.message ?? 'Malformed request body.',
      azureContacted: false,
      liveEvidence: false,
    });
    return;
  }
  try {
    validateSelfTestRequest(payload);
  } catch (error) {
    if (error instanceof RequestRefused) {
      sendJson(response, error.status, {
        scenario: SELF_TEST_SCENARIO,
        state: 'blocked',
        summary: error.message,
        code: error.code,
        azureContacted: false,
        liveEvidence: false,
      });
      return;
    }
    sendJson(response, 400, {
      scenario: SELF_TEST_SCENARIO,
      state: 'failed',
      summary: 'Malformed request body.',
      azureContacted: false,
      liveEvidence: false,
    });
    return;
  }
  const result = await runSelfTest({
    playgroundRoot: ROOT,
    catalogue: CATALOGUE,
    mode,
    checkStateChangingRequest,
    port,
    host,
    publicOrigin,
  });
  sendJson(response, 200, result);
}

async function handleProtectedSource(response, sampleId) {
  try {
    const { sample } = validateSourceSampleId(sampleId, CATALOGUE);
    sendJson(response, 200, await readSampleSource({ playgroundRoot: ROOT, sample }));
  } catch (error) {
    if (error instanceof RequestRefused) {
      sendJson(response, error.status, { state: 'blocked', summary: error.message, code: error.code });
      return;
    }
    if (error instanceof SourceViewError) {
      sendJson(response, 409, { state: 'failed', summary: error.message, code: error.code });
      return;
    }
    sendJson(response, 500, { state: 'failed', summary: 'The protected source could not be read.' });
  }
}

async function handleSourceValidation(request, response, {
  mode,
  manager,
  sampleId,
  port,
  host,
  browserHost,
  publicOrigin,
}) {
  const guard = checkStateChangingRequest(request, {
    port,
    host,
    browserHost,
    publicOrigin,
    requireOrigin: isLoopbackHost(host),
  });
  if (!guard.ok) {
    sendJson(response, guard.status, {
      scenario: CODE_VALIDATION_SCENARIO,
      state: 'blocked',
      summary: guard.message,
      sourceExecuted: false,
      azureContacted: false,
      networkContacted: false,
      liveEvidence: false,
    });
    return;
  }
  if (mode !== 'execute' || !manager) {
    sendJson(response, 501, {
      scenario: CODE_VALIDATION_SCENARIO,
      state: 'blocked',
      summary: 'Offline Python validation is available only from the loopback execute server.',
      mode: 'offline-local',
      validation: 'python-compile-only',
      sourceExecuted: false,
      azureContacted: false,
      networkContacted: false,
      liveEvidence: false,
    });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(request, 4096));
  } catch (error) {
    const status = error instanceof RequestRefused ? error.status : 400;
    sendJson(response, status, {
      scenario: CODE_VALIDATION_SCENARIO,
      state: 'failed',
      summary: error?.message ?? 'Malformed request body.',
      sourceExecuted: false,
      azureContacted: false,
      networkContacted: false,
      liveEvidence: false,
    });
    return;
  }
  let startedRunId = null;
  let completed = false;
  let disconnected = false;
  let cancelRequested = false;
  const cancelDisconnectedRun = () => {
    disconnected = true;
    if (completed || cancelRequested || !startedRunId) return;
    cancelRequested = true;
    manager.cancel(startedRunId);
  };
  request.once('aborted', cancelDisconnectedRun);
  response.once('close', cancelDisconnectedRun);
  try {
    const result = await manager.start(sampleId, payload, {
      onStart: ({ runId }) => {
        startedRunId = runId;
        if (disconnected) cancelDisconnectedRun();
      },
    });
    completed = true;
    if (response.destroyed) return;
    sendJson(response, 200, {
      ...result,
      executionContext: offlinePythonContext({ available: result.state !== 'blocked' }),
    });
  } catch (error) {
    if (disconnected && response.destroyed) return;
    if (error instanceof RequestRefused) {
      sendJson(response, error.status, {
        scenario: CODE_VALIDATION_SCENARIO,
        state: 'blocked',
        summary: error.message,
        code: error.code,
        sourceExecuted: false,
        azureContacted: false,
        networkContacted: false,
        liveEvidence: false,
      });
      return;
    }
    sendJson(response, 500, {
      scenario: CODE_VALIDATION_SCENARIO,
      state: 'failed',
      summary: 'Offline Python validation could not be started.',
      sourceExecuted: false,
      azureContacted: false,
      networkContacted: false,
      liveEvidence: false,
    });
  } finally {
    request.off('aborted', cancelDisconnectedRun);
    response.off('close', cancelDisconnectedRun);
  }
}

function decodeSampleId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

/**
 * @param {object} options
 * @param {'preview'|'execute'} [options.mode]
 * @param {object} [options.runManager]   injected for tests
 * @param {object} [options.probe]        injected for tests
 * @param {object} [options.relay]        injected relay config for tests (see buildRelayConfig)
 * @param {string|null} [options.publicOrigin] exact hosted HTTPS browser origin
 * @param {string} [options.testBootstrapCapability] deterministic test-only bootstrap
 * @param {object} [options.processTransports] injected local process transports
 * @param {Function} [options.privateAzureCliContextFactory] injected context factory
 */
export function createPlaygroundServer({
  mode = 'preview',
  runManager = null,
  codeValidationManager = null,
  executionContextManager = null,
  probe = {},
  port = PORT,
  host = HOST,
  relay = DEFAULT_RELAY_CONFIG,
  publicOrigin = DEFAULT_PUBLIC_ORIGIN,
  testBootstrapCapability,
  secureSessionCookie = false,
  allowSystemAzureLogin = false,
  processTransports = null,
  privateAzureCliContextFactory = createPrivateAzureCliContext,
} = {}) {
  publicOrigin =
    publicOrigin === null
      ? null
      : parseTrustedPublicOrigin(publicOrigin, { name: 'createPlaygroundServer publicOrigin' });
  const localSessionAuth = isLoopbackHost(host)
    ? createLocalSessionAuth({
        bootstrapCapability: testBootstrapCapability,
        browserHost: testBootstrapCapability == null ? undefined : String(host).replace(/^\[|\]$/g, ''),
        secureCookie: secureSessionCookie,
      })
    : null;
  const browserHost = localSessionAuth?.browserHost ?? null;
  const localExecutionEnabled = mode === 'execute' && relay.enabled !== true;
  const ownsPrivateAzureCliContext =
    localExecutionEnabled && isLoopbackHost(host);
  let privateAzureCliContext = null;
  let localProcessTransports;
  let identityManager;
  let manager;
  let validationManager;
  try {
    privateAzureCliContext = ownsPrivateAzureCliContext
      ? privateAzureCliContextFactory()
      : null;
    localProcessTransports = privateAzureCliContext
      ? privateAzureCliContext.bindTransports(processTransports ?? realTransports())
      : (processTransports ?? realTransports());
    identityManager =
      executionContextManager ??
      createExecutionContextManager({
        playgroundRoot: ROOT,
        mode: localExecutionEnabled && isLoopbackHost(host) ? 'execute' : 'preview',
        relay,
        allowSystemAzureLogin:
          allowSystemAzureLogin === true &&
          localExecutionEnabled &&
          isLoopbackHost(host) &&
          relay.enabled !== true,
        transports: localProcessTransports,
      });
    manager =
      localExecutionEnabled
        ? (runManager ??
          createRunManager({
            playgroundRoot: ROOT,
            transports: localProcessTransports,
            pythonExecutable: PYTHON,
            executionContextManager: identityManager,
          }))
        : runManager;
    validationManager =
      localExecutionEnabled
        ? (codeValidationManager ?? createCodeValidationManager({ playgroundRoot: ROOT, pythonExecutable: PYTHON }))
        : codeValidationManager;
  } catch (error) {
    try {
      Promise.resolve(privateAzureCliContext?.close()).catch(() => {});
    } catch {
      /* the original construction failure remains the useful startup error */
    }
    throw error;
  }
  let runtimeProbe = probe;
  const shutdownController = new AbortController();

  const server = createServer(async (request, response) => {
    try {
      const requestTarget = request.url ?? '/';
      const path = requestTarget.split('?')[0];

      if (path === LOCAL_SESSION_CLAIM_PATH || path.startsWith(`${LOCAL_SESSION_CLAIM_PATH}/`)) {
        if (requestTarget !== LOCAL_SESSION_CLAIM_PATH) {
          send(response, 404, securityHeaders('text/plain; charset=utf-8'), 'Not found');
          return;
        }
        if (request.method !== 'POST') {
          sendJson(response, 405, { state: 'blocked', summary: 'Use POST.', code: 'method-not-allowed' });
          return;
        }
        await handleSessionClaim(request, response, {
          localSessionAuth,
          port,
          host,
          browserHost,
          publicOrigin,
        });
        return;
      }

      if (path === '/api/live') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { status: 'error', detail: 'Use GET.' });
          return;
        }
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (path === '/api/health' || path === '/api/capabilities') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { status: 'error', detail: 'Use GET.' });
          return;
        }
        const operatorAuthorization =
          path === '/api/capabilities' && relay.hosted === true
            ? (await authenticateHostedOperator(request, relay)).descriptor
            : relay.hosted === true
              ? Object.freeze({
                  required: true,
                  signedIn: false,
                  authorized: false,
                  state: 'not-evaluated',
                  message: 'Hosted operator authorization is configured and evaluated on caller requests.',
                })
              : undefined;
        const payload = capabilitiesPayload({
          mode,
          probe: runtimeProbe,
          relay,
          allowSystemAzureLogin:
            allowSystemAzureLogin === true &&
            mode === 'execute' &&
            isLoopbackHost(host) &&
            relay.enabled !== true,
          sessionAuth:
            localSessionAuth?.describe(request) ??
            Object.freeze({
              required: false,
              state: 'not-required',
              claimEndpoint: null,
              message: '',
            }),
          ...(operatorAuthorization ? { operatorAuthorization } : {}),
        });
        sendJson(response, payload.status === 'ok' ? 200 : 503, payload);
        return;
      }

      if (request.method === 'POST' && isPrivilegedLocalPath(path)) {
        if (!requireLocalSession(request, response, localSessionAuth)) return;
      }

      let authorizedCaller = null;
      if (
        request.method === 'POST' &&
        isPrivilegedLocalPath(path) &&
        relay.hosted === true &&
        !isLoopbackHost(host)
      ) {
        const guard = checkStateChangingRequest(request, {
          port,
          host,
          browserHost,
          publicOrigin,
          requireOrigin: false,
        });
        if (!guard.ok) {
          sendJson(response, guard.status, { state: 'blocked', summary: guard.message });
          return;
        }
        authorizedCaller = await authenticateHostedOperator(request, relay);
        if (!authorizedCaller.ok) {
          sendHostedAuthorizationFailure(response, authorizedCaller);
          return;
        }
      }

      if (path === '/api/run') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { state: 'failed', summary: 'Use POST.' });
          return;
        }
        await handleRun(request, response, {
          mode: localExecutionEnabled ? 'execute' : 'preview',
          manager,
          port,
          host,
          browserHost,
          publicOrigin,
          shutdownSignal: shutdownController.signal,
        });
        return;
      }

      if (path === '/api/run/cancel') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { cancelled: false, reason: 'Use POST.' });
          return;
        }
        await handleCancel(request, response, { manager, port, host, browserHost, publicOrigin });
        return;
      }

      if (path === '/api/execution-context') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { state: 'failed', summary: 'Use POST.' });
          return;
        }
        await handleExecutionContext(request, response, {
          manager: identityManager,
          port,
          host,
          browserHost,
          publicOrigin,
          authorizedCaller,
        });
        return;
      }

      const loginRoute = /^\/api\/azure-auth\/(start|status|cancel)$/.exec(path);
      if (loginRoute) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { state: 'failed', summary: 'Use POST.' });
          return;
        }
        await handleAzureLogin(request, response, {
          action: loginRoute[1],
          manager: identityManager,
          port,
          host,
          browserHost,
          publicOrigin,
        });
        return;
      }

      if (/^\/api\/azure-login\/(?:start|status|cancel)$/.test(path)) {
        sendJson(response, 410, {
          state: 'gone',
          summary: 'The former Azure login API is no longer available. Use the system-login capability advertised by `/api/capabilities`.',
          code: 'legacy-login-gone',
        });
        return;
      }

      const subscriptionRoute = /^\/api\/azure-subscriptions\/(list|activate)$/.exec(path);
      if (subscriptionRoute) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { state: 'failed', summary: 'Use POST.' });
          return;
        }
        await handleAzureSubscriptions(request, response, {
          action: subscriptionRoute[1],
          manager: identityManager,
          port,
          host,
          browserHost,
          publicOrigin,
        });
        return;
      }

      if (path === '/api/execute') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { state: 'failed', summary: 'Use POST.' });
          return;
        }
        await handleExecute(request, response, {
          port,
          host,
          browserHost,
          publicOrigin,
          relay,
          authorizedCaller,
        });
        return;
      }

      if (path === '/api/self-test') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { state: 'failed', summary: 'Use POST.' });
          return;
        }
        await handleSelfTest(request, response, {
          mode,
          port: request.socket?.localPort ?? port,
          host,
          browserHost,
          publicOrigin,
        });
        return;
      }

      const validationRoute = /^\/api\/source\/([^/]+)\/validate$/.exec(path);
      if (validationRoute) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { state: 'failed', summary: 'Use POST.' });
          return;
        }
        await handleSourceValidation(request, response, {
          mode: localExecutionEnabled ? 'execute' : 'preview',
          manager: validationManager,
          sampleId: decodeSampleId(validationRoute[1]),
          port,
          host,
          browserHost,
          publicOrigin,
        });
        return;
      }

      const sourceRoute = /^\/api\/source\/([^/]+)$/.exec(path);
      if (sourceRoute) {
        if (request.method !== 'GET') {
          sendJson(response, 405, { state: 'failed', summary: 'Use GET.' });
          return;
        }
        await handleProtectedSource(response, decodeSampleId(sourceRoute[1]));
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        send(response, 405, securityHeaders('text/plain; charset=utf-8'), 'Method not allowed');
        return;
      }
      await handleStatic(request, response);
    } catch (error) {
      // A defensive last resort: nothing above is expected to throw (every
      // handler already catches its own risky calls — credential
      // acquisition, the relay fetch, the local executor), but an unforeseen
      // failure anywhere in this chain must still answer the socket rather
      // than leave the caller hanging or crash the process with an
      // unhandled rejection. The client never sees `error.message` — it
      // could carry a path, a stack frame or other internal detail.
      void error;
      try {
        if (!response.headersSent) {
          sendJson(response, 500, { state: 'failed', summary: 'Not run — an unexpected server error occurred.' });
        } else {
          response.end();
        }
      } catch {
        response.destroy?.();
      }
    }
  });

  server.setProbe = (next) => {
    runtimeProbe = next;
  };
  server.runManager = manager;
  server.codeValidationManager = validationManager;
  server.executionContextManager = identityManager;
  server.localSessionAuth = localSessionAuth;
  server.localExecutionEnabled = localExecutionEnabled;
  server.probeRuntimes = (options = {}) =>
    probeRuntimes({
      mode: localExecutionEnabled ? 'execute' : 'preview',
      python: PYTHON,
      root: ROOT,
      ...options,
      spawn: localProcessTransports.spawn,
    });
  const close = server.close.bind(server);
  let shutdown = null;
  server.close = (callback) => {
    if (!shutdown) {
      shutdownController.abort();
      let shutdownError = null;
      const recordShutdownError = (error) => {
        if (!shutdownError) shutdownError = error;
      };
      const drains = [
        cancelAndDrain(manager),
        cancelAndDrain(validationManager),
        cancelAndDrain(identityManager),
      ].map((drain) => drain.catch(recordShutdownError));
      const serverClosed = new Promise((resolveClosed) => {
        close((error) => {
          if (error) recordShutdownError(error);
          resolveClosed();
        });
      });
      shutdown = Promise.all([serverClosed, ...drains]).then(async () => {
        try {
          await privateAzureCliContext?.close();
        } catch (error) {
          recordShutdownError(error);
        }
        return shutdownError;
      });
    }
    if (typeof callback === 'function') shutdown.then((error) => callback(error));
    return server;
  };
  return server;
}

/* ------------------------------------------------------------------- boot */

function cancelAndDrain(manager) {
  const drain = typeof manager?.cancelAndDrain === 'function' ? manager.cancelAndDrain : manager?.cancelAll;
  if (typeof drain !== 'function') return Promise.resolve();
  try {
    return Promise.resolve(drain.call(manager));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function createSignalShutdownHandler(server, { exit = (code) => process.exit(code) } = {}) {
  let stopping = false;
  return () => {
    if (stopping) return;
    stopping = true;
    server.close((error) => exit(error ? 1 : 0));
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const wantsExecution = process.argv.includes('--execute');
  const allowSystemAzureLogin = process.argv.includes('--allow-system-azure-login');
  if (wantsExecution && !isLoopbackHost(HOST)) {
    process.stderr.write(
      `Refusing to attach the local executor on ${HOST}. Local execution spawns processes and writes files, so it is allowed only when the server is bound to loopback.\n` +
        'Unset CITADEL_PLAYGROUND_HOST, or use the external relay seam for a remote deployment.\n',
    );
    process.exit(1);
  }
  const mode = wantsExecution ? 'execute' : 'preview';
  const server = createPlaygroundServer({ mode, allowSystemAzureLogin });
  server.listen(PORT, HOST, async () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : PORT;
    const origin = httpOrigin(HOST, actualPort);
    process.stdout.write(
      server.localSessionAuth
        ? `Citadel Publish Playground secure launch URL: ${server.localSessionAuth.launchUrl(origin)}\n`
        : `Citadel Publish Playground: ${origin}/\n`,
    );
    if (server.localSessionAuth) {
      process.stdout.write('The plain URL is preview-only until this browser claims the launch capability.\n');
    }
    process.stdout.write(`Mode: ${mode}\n`);
    if (server.localExecutionEnabled) {
      process.stdout.write('Probing local runtimes…\n');
      const probe = await server.probeRuntimes();
      server.setProbe(probe);
      const { capability } = capabilitiesPayload({ mode, probe, relay: DEFAULT_RELAY_CONFIG });
      process.stdout.write(`Local execution: ${capability.label} (${capability.ready}/${capability.total} samples ready)\n`);
      process.stdout.write('Risk gates still apply. Nothing runs without a fresh acknowledgement.\n');
      process.stdout.write(
        allowSystemAzureLogin
          ? 'System Azure sign-in and subscription switching: enabled for this secure browser launch.\n'
          : 'System Azure sign-in and subscription switching: disabled. Add --allow-system-azure-login to opt in for this launch.\n',
      );
    } else if (mode !== 'execute') {
      process.stdout.write('Preview only — plans are generated and inspected, and nothing is executed.\n');
      process.stdout.write('Run `npm run start:execute` to attach the local executor.\n');
    }
    if (DEFAULT_RELAY_CONFIG.enabled) {
      const relayStatus = relayConfigurationStatus(DEFAULT_RELAY_CONFIG);
      process.stdout.write(
        relayStatus.ok
          ? `Execution relay: ${DEFAULT_RELAY_CONFIG.url}\n`
          : `Execution relay unavailable: ${relayStatus.detail}\n`,
      );
    }
  });
  const shutdown = createSignalShutdownHandler(server);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, shutdown);
  }
}

export { PORT, HOST, DEFAULT_RELAY_CONFIG };
