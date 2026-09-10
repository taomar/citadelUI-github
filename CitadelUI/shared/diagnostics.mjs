/**
 * The complete diagnostic vocabulary. No message, stack, URL, input, label or
 * credential field exists. Keep additions here explicit and privacy-reviewable.
 */
export const DIAGNOSTICS_ENDPOINT = '/api/diagnostics';
export const DIAGNOSTICS_LIMITS = Object.freeze({
  durationMs: 30 * 60 * 1000,
  records: 400,
  eventBytes: 128 * 1024,
  bodyBytes: 16 * 1024,
  batchEvents: 20,
  clientQueueEvents: 40,
  eventsPerMinute: 600,
  ingestRequestsPerMinute: 120,
  readRequestsPerMinute: 240,
  downloadRequestsPerMinute: 12,
  controlRequestsPerMinute: 30,
  pollMs: 5000,
  flushMs: 1000,
  clientLeaseMs: 15000,
});

export const DIAGNOSTIC_CODES = Object.freeze([
  'UNKNOWN', 'HTTP_ERROR', 'NETWORK_ERROR', 'INTERNAL_ERROR', 'SERVER_BUSY',
  'INVALID_HOST', 'INVALID_FETCH_SITE', 'INVALID_ORIGIN', 'INVALID_SESSION',
  'METHOD_NOT_ALLOWED', 'ROUTE_NOT_FOUND', 'STATIC_NOT_FOUND', 'REQUEST_ABORTED',
  'BODY_TOO_LARGE', 'JSON_REQUIRED', 'INVALID_JSON', 'INVALID_CONTENT',
  'INVALID_PATH', 'FORBIDDEN_PATH', 'INVALID_ALIAS', 'EXCLUDED_ALIAS',
  'UNSUPPORTED_ALIAS', 'INVALID_ID', 'INVALID_HASH', 'INVALID_SIZE',
  'MISSING_QUERY', 'MISSING_ENVIRONMENT', 'INVALID_FILES', 'INVALID_CHANGES',
  'ENVIRONMENT_LEASED', 'LEASE_LOST', 'INVALID_TRANSACTION_STATE',
  'TRANSACTION_NOT_FOUND', 'BACKUP_NOT_FOUND', 'BACKUPS_INCOMPLETE',
  'BACKUP_VERIFICATION_FAILED', 'DURABLE_BACKUP_VERIFICATION_FAILED',
  'STALE_ORIGINAL_HASH', 'STALE_MANIFEST_HASH', 'FINAL_RECEIPT_FAILED',
  'ROLLBACK_RECEIPT_FAILED', 'INVALID_TRANSACTION_TOKEN', 'EXPIRED_TRANSACTION_TOKEN',
  'INVALID_AUTHORIZATION_TOKEN', 'EXPIRED_AUTHORIZATION_TOKEN',
  'OWNER_ALREADY_CLAIMED', 'OWNER_UNAVAILABLE', 'INVALID_CREDENTIALS',
  'INVALID_USERNAME', 'INVALID_PASSWORD',
  'GITHUB_RATE_LIMITED', 'GITHUB_RESPONSE_TOO_LARGE', 'GITHUB_REDIRECT',
  'GITHUB_TIMEOUT', 'GITHUB_UNREACHABLE', 'GITHUB_REQUEST_FAILED',
  'GITHUB_INVALID_RESPONSE', 'GITHUB_CANCELLED', 'GITHUB_SESSION_EXPIRED',
  'INDETERMINATE_SAVE', 'SAVE_NOT_APPLIED', 'STALE_HEAD',
  'UNKNOWN_CONNECTION', 'UNKNOWN_ENVIRONMENT', 'NOT_GITHUB_ENVIRONMENT',
  'LOCAL_IMPORT_EXPIRED', 'LOCAL_IMPORT_READ_FAILED', 'PUBLIC_DONOR_RATE_LIMIT',
  'PUBLIC_DONOR_READ_FAILED', 'ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EMFILE',
]);

export const DIAGNOSTIC_EXCEPTIONS = Object.freeze([
  'UnknownError', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError',
  'RangeError', 'URIError', 'EvalError', 'AggregateError', 'AbortError',
  'NotAllowedError', 'NotFoundError', 'NotReadableError', 'InvalidStateError',
  'QuotaExceededError', 'SecurityError', 'DataCloneError', 'ConstraintError',
  'TransactionInactiveError', 'TimeoutError', 'MigrationError', 'TerraformExportError',
]);

export const DIAGNOSTIC_OPERATIONS = Object.freeze({
  'api.health': 'Application health request',
  'api.owner': 'Owner sign-in request',
  'api.registry': 'Workspace metadata request',
  'api.activity': 'Workspace activity request',
  'api.bicep.parse': 'Bicep parameter parsing',
  'api.bicep.preview': 'Bicep parameter preview',
  'api.policy': 'Policy request',
  'api.transactions': 'Local save or recovery request',
  'api.snapshots': 'Prepared migration source request',
  'api.github.sessions': 'GitHub session request',
  'api.github.connections': 'GitHub connection request',
  'api.github.repos': 'GitHub repository request',
  'api.github.workspaces': 'GitHub workspace request',
  'api.github.attachments': 'GitHub attachment request',
  'api.github.repository-creations': 'GitHub repository creation request',
  'api.github.local-imports': 'Local source preparation request',
  'api.github.migration-source': 'Migration source connection request',
  'api.github.public-donor': 'Public migration source request',
  'api.other': 'Application request',
  'asset': 'Application asset request',
  'app.action': 'Application action',
  'app.status': 'Application error notice',
  'app.startup': 'Workspace startup',
  'app.migration': 'Configuration migration',
  'app.terraform-export': 'Terraform export',
  'app.local-import': 'Local source import',
  'app.workspace': 'Workspace operation',
  'client.uncaught': 'Uncaught browser error',
  'client.rejection': 'Unhandled browser rejection',
});

// Only packaged modules, never repository source or a path discovered at runtime.
export const DIAGNOSTIC_MODULES = Object.freeze([
  'activity', 'api', 'app', 'azuremeta', 'branch-target', 'cidr', 'compare-session',
  'contract-edit-state', 'dialog', 'diff', 'directory-provider', 'docblocks', 'dom',
  'editor-focus', 'explain', 'fields', 'github-connections', 'github-coordinator',
  'github-provider', 'github-selection', 'github-session-manager', 'github-session',
  'github-setup', 'history-entry', 'llmschema', 'llmview', 'local-api',
  'local-source-client', 'local-source-copy', 'local-source-import', 'migration-donor',
  'migration-github-connection', 'migration-public-donor', 'migration-session',
  'migration-snapshot', 'migration-target-preview', 'migration-validation',
  'migration-value-view', 'migration-wizard', 'mutation-coordinator', 'owner-gate',
  'paramview', 'picker', 'policy-edit-state', 'policynav', 'policyview', 'preview',
  'registry', 'repository-progress', 'save-resolution', 'settings-operation',
  'single-flight', 'source-factory', 'stage-progress', 'subscription-env',
  'terraform-export-controls', 'terraform-export-session', 'terraform-export-view',
  'transaction-client', 'validation', 'workspace-catalog', 'workspace-context',
  'workspace-service', 'workspace-settings-view',
].map((name) => `/js/${name}.mjs`).concat([
  'bicepparam/edit', 'bicepparam/lexer', 'bicepparam/parser', 'bicepparam/serialize',
  'citadel-core', 'doclayer', 'git-refs', 'llm-value-migration', 'local-path',
  'migration-github-auth', 'migration-input', 'migration-public-github',
  'migration-schema', 'migration-snapshot', 'migration-source-scope',
  'parameter-migration', 'policy', 'repository-snapshot', 'repository-source',
  'source-plan', 'source-scope', 'subscription-env', 'terraform-contract',
  'terraform-export', 'terraform-literals', 'zip',
].map((name) => `/shared/${name}.mjs`)));

export const DIAGNOSTIC_SUMMARIES = Object.freeze({
  request: 'An application request failed.',
  handled: 'An application action reported an error.',
  uncaught: 'A browser error reached the window boundary.',
  'unhandled-rejection': 'A browser promise rejected without a handler.',
});

export const DIAGNOSTIC_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export const DIAGNOSTIC_RESOURCES = Object.freeze([
  ...DIAGNOSTIC_MODULES,
  '/', '/index.html', '/css/app.css', '/css/components.css', '/css/terraform-export.css',
  '/favicon.ico', '/.well-known/appspecific/com.chrome.devtools.json',
  '/api/health', '/api/owner', '/api/owner/claim', '/api/owner/session',
  '/api/registry', '/api/activity', '/api/content/bicepparam/parse', '/api/content/bicepparam/preview',
  '/api/core/policy/specs', '/api/core/policy/read', '/api/core/policy/apply',
  '/api/transactions', '/api/transactions/prepare', '/api/transactions/:transactionId',
  '/api/transactions/:transactionId/backups/:fileId',
  ...['authorize', 'recover', 'restore-token', 'revert', 'committing', 'receipt', 'fail', 'abandon', 'rollback', 'lease']
    .map((action) => `/api/transactions/:transactionId/${action}`),
  '/api/migration-sources', '/api/migration-sources/:sourceId',
  '/api/migration-sources/:sourceId/files/:fileId', '/api/migration-sources/:sourceId/complete', '/api/migration-sources/:sourceId/delete',
  '/api/github/sessions', '/api/github/sessions/:sessionId',
  '/api/github/connections', '/api/github/connections/:connectionId',
  ...['reconnect', 'resume', 'rename', 'persistence', 'disconnect']
    .map((action) => `/api/github/connections/:connectionId/${action}`),
  '/api/github/repos', '/api/github/repos/:repositoryId',
  '/api/github/repos/:repositoryId/branches', '/api/github/repos/:repositoryId/compatibility',
  '/api/github/attachments', '/api/github/attachments/status', '/api/github/attachments/abandon',
  ...['tree', 'blob', 'history', 'commits', 'subscription', 'commit-branches', 'reverts']
    .map((action) => `/api/github/workspaces/:environmentId/${action}`),
  '/api/github/repository-creations', '/api/github/repository-creations/:operationId',
  ...['start', 'resume', 'pause'].map((action) => `/api/github/repository-creations/:operationId/${action}`),
]);

const codeSet = new Set(DIAGNOSTIC_CODES);
const exceptionSet = new Set(DIAGNOSTIC_EXCEPTIONS);
const moduleSet = new Set(DIAGNOSTIC_MODULES);
const methodSet = new Set(DIAGNOSTIC_METHODS);
const resourceSet = new Set(DIAGNOSTIC_RESOURCES);
const resourcePatterns = DIAGNOSTIC_RESOURCES.filter((resource) => resource.includes('/:')).map((resource) => ({
  resource,
  pattern: new RegExp(`^${resource.split('/').map((part) => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`),
}));
const clientCategories = new Set(['request', 'handled', 'uncaught', 'unhandled-rejection']);
const CLIENT_KEYS = ['category', 'operation', 'code', 'status', 'exception', 'module', 'line', 'column', 'method', 'resource'];
const COUNT_KEYS = ['received', 'stored', 'deduplicated', 'omitted', 'omittedByRate', 'omittedByCapacity', 'clientQueueOmitted', 'rejectedBatches', 'eventBytes'];
const CAPTURE_KEYS = ['id', 'startedAt', 'deadlineAt', 'stoppedAt', 'stopObservedAt', 'stopReason', 'active', 'remainingMs'];
const EVENT_KEYS = [...CLIENT_KEYS, 'source', 'id', 'firstAt', 'lastAt', 'occurrences', 'correlationId'];

export const safeDiagnosticCode = (value) => codeSet.has(value) ? value : 'UNKNOWN';
export const safeDiagnosticExceptionName = (value) => exceptionSet.has(value) ? value : 'UnknownError';
export const safeDiagnosticStatus = (value) => Number.isInteger(value) && value >= 400 && value <= 599 ? value : null;
export const safeDiagnosticMethod = (value) => methodSet.has(value) ? value : null;
export const safeDiagnosticOperation = (value) => typeof value === 'string' && Object.hasOwn(DIAGNOSTIC_OPERATIONS, value) ? value : 'app.action';
const coordinate = (value, max) => Number.isInteger(value) && value >= 1 && value <= max ? value : null;
export const isDiagnosticId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const isDiagnosticPath = (path) => typeof path === 'string' &&
  (path === DIAGNOSTICS_ENDPOINT || path.startsWith(`${DIAGNOSTICS_ENDPOINT}/`));

function errorField(error, key) {
  // Hostile objects/getters are not allowed to break the original error path.
  // No object, message or stack is retained, even on this fallback.
  try {
    return error !== null && (typeof error === 'object' || typeof error === 'function') ? error[key] : undefined;
  } catch {
    return undefined;
  }
}

export function diagnosticException(error) {
  return safeDiagnosticExceptionName(errorField(error, 'name'));
}

export function diagnosticRoute(path) {
  if (typeof path !== 'string') return 'api.other';
  // Inspect, never retain, the URL. Queries and all dynamic identifiers are
  // discarded before a caller receives a code-owned operation.
  const pathname = path.split(/[?#]/, 1)[0];
  if (pathname === '/api/health') return 'api.health';
  if (pathname === '/api/registry') return 'api.registry';
  if (pathname === '/api/activity') return 'api.activity';
  if (pathname === '/api/content/bicepparam/parse') return 'api.bicep.parse';
  if (pathname === '/api/content/bicepparam/preview') return 'api.bicep.preview';
  const groups = [
    ['/api/owner', 'api.owner'], ['/api/core/policy', 'api.policy'],
    ['/api/transactions', 'api.transactions'], ['/api/migration-sources', 'api.snapshots'],
    ...Object.keys(DIAGNOSTIC_OPERATIONS).filter((key) => key.startsWith('api.github.'))
      .map((key) => [`/api/github/${key.slice('api.github.'.length)}`, key]),
  ];
  for (const [prefix, operation] of groups) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return operation;
  }
  return pathname.startsWith('/api') ? 'api.other' : 'asset';
}

export function diagnosticResource(path) {
  if (typeof path !== 'string') return null;
  const pathname = path.split(/[?#]/, 1)[0];
  if (resourceSet.has(pathname)) return pathname;
  return resourcePatterns.find(({ pattern }) => pattern.test(pathname))?.resource || null;
}

export function diagnosticLocation(filename, origin, line, column) {
  if (typeof filename !== 'string' || filename.length > 256 || typeof origin !== 'string') return {};
  try {
    const url = new URL(filename);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
        !moduleSet.has(url.pathname) || filename !== `${origin}${url.pathname}`) return {};
    return { module: url.pathname, line: coordinate(line, 100000), column: coordinate(column, 10000) };
  } catch {
    return {};
  }
}

export function clientDiagnostic(error, operation = 'app.action', category = 'handled', context = {}) {
  const module = moduleSet.has(context.module) ? context.module : null;
  return {
    category: clientCategories.has(category) ? category : 'handled',
    operation: safeDiagnosticOperation(operation),
    code: safeDiagnosticCode(errorField(error, 'code')),
    status: safeDiagnosticStatus(context.status ?? errorField(error, 'status')),
    exception: diagnosticException(error),
    module,
    line: module ? coordinate(context.line, 100000) : null,
    column: module ? coordinate(context.column, 10000) : null,
    method: safeDiagnosticMethod(context.method),
    resource: resourceSet.has(context.resource) ? context.resource : null,
  };
}

export function exactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}

export function validClientDiagnostic(value) {
  return exactKeys(value, CLIENT_KEYS) && clientCategories.has(value.category) &&
    typeof value.operation === 'string' && Object.hasOwn(DIAGNOSTIC_OPERATIONS, value.operation) && codeSet.has(value.code) &&
    (value.status === null || safeDiagnosticStatus(value.status) === value.status) &&
    exceptionSet.has(value.exception) &&
    (value.method === null || methodSet.has(value.method)) &&
    (value.resource === null || resourceSet.has(value.resource)) &&
    (value.module === null || moduleSet.has(value.module)) &&
    (value.line === null || coordinate(value.line, 100000) === value.line) &&
    (value.column === null || coordinate(value.column, 10000) === value.column) &&
    (value.module !== null || (value.line === null && value.column === null));
}

export function copyClientDiagnostic(value) {
  if (!validClientDiagnostic(value)) throw new Error('Invalid diagnostic record.');
  return Object.fromEntries(CLIENT_KEYS.map((key) => [key, value[key]]));
}

const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const date = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

export function validDiagnosticState(state) {
  if (!exactKeys(state, ['capture', 'counts']) || !exactKeys(state.counts, COUNT_KEYS) ||
      !COUNT_KEYS.every((key) => integer(state.counts[key]))) return false;
  if (state.counts.stored > DIAGNOSTICS_LIMITS.records || state.counts.eventBytes > DIAGNOSTICS_LIMITS.eventBytes) return false;
  const capture = state.capture;
  if (capture === null) return state.counts.received === 0 && state.counts.stored === 0;
  if (!exactKeys(capture, CAPTURE_KEYS) || !isDiagnosticId(capture.id) ||
      !date(capture.startedAt) || !date(capture.deadlineAt) ||
      Date.parse(capture.deadlineAt) - Date.parse(capture.startedAt) !== DIAGNOSTICS_LIMITS.durationMs ||
      !integer(capture.remainingMs, DIAGNOSTICS_LIMITS.durationMs) ||
      typeof capture.active !== 'boolean') return false;
  return capture.active
    ? capture.stoppedAt === null && capture.stopObservedAt === null && capture.stopReason === null
    : date(capture.stoppedAt) && date(capture.stopObservedAt) && ['manual', 'expired'].includes(capture.stopReason) && capture.remainingMs === 0;
}

export function copyDiagnosticState(state) {
  if (!validDiagnosticState(state)) throw new Error('Invalid diagnostic state.');
  return {
    capture: state.capture === null ? null : Object.fromEntries(CAPTURE_KEYS.map((key) => [key, state.capture[key]])),
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, state.counts[key]])),
  };
}

export function copyDiagnosticReport(report) {
  if (!exactKeys(report, ['schemaVersion', 'application', 'scope', 'kind', 'limits', 'capture', 'counts', 'events']) ||
      report.schemaVersion !== 1 || report.application !== 'citadel-ui' || report.scope !== 'server-instance' ||
      !['empty', 'snapshot', 'final'].includes(report.kind) ||
      !exactKeys(report.limits, Object.keys(DIAGNOSTICS_LIMITS)) ||
      !Object.keys(DIAGNOSTICS_LIMITS).every((key) => report.limits[key] === DIAGNOSTICS_LIMITS[key]) ||
      !Array.isArray(report.events) || report.events.length > DIAGNOSTICS_LIMITS.records) {
    throw new Error('Invalid diagnostic report.');
  }
  const state = copyDiagnosticState({ capture: report.capture, counts: report.counts });
  if (report.kind !== (!state.capture ? 'empty' : state.capture.active ? 'snapshot' : 'final') ||
      report.events.length !== state.counts.stored) throw new Error('Invalid diagnostic report.');
  const events = report.events.map((event) => {
    if (!exactKeys(event, EVENT_KEYS) || !['client', 'server'].includes(event.source) ||
        !integer(event.id, DIAGNOSTICS_LIMITS.records) || event.id < 1 ||
        !date(event.firstAt) || !date(event.lastAt) ||
        !integer(event.occurrences) || event.occurrences < 1 ||
        (event.source === 'client' ? event.correlationId !== null : !isDiagnosticId(event.correlationId))) {
      throw new Error('Invalid diagnostic record.');
    }
    const fields = copyClientDiagnostic(Object.fromEntries(CLIENT_KEYS.map((key) => [key, event[key]])));
    return { ...fields, ...Object.fromEntries(EVENT_KEYS.slice(CLIENT_KEYS.length).map((key) => [key, event[key]])) };
  });
  if (new TextEncoder().encode(JSON.stringify(events)).byteLength !== state.counts.eventBytes) {
    throw new Error('Invalid diagnostic byte count.');
  }
  return {
    schemaVersion: 1, application: 'citadel-ui', scope: 'server-instance', kind: report.kind,
    limits: { ...DIAGNOSTICS_LIMITS }, ...state, events,
  };
}

export function diagnosticFilename(report) {
  const safe = copyDiagnosticReport(report);
  return safe.capture
    ? `citadel-debug-${safe.capture.startedAt.replace(/[-:.]/g, '')}-${safe.capture.id.slice(0, 8)}.json`
    : 'citadel-debug-empty.json';
}
