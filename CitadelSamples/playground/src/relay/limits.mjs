const KiB = 1024;
const MiB = 1024 * KiB;

function field(environmentName, defaultValue, minimum, maximum) {
  return Object.freeze({ environmentName, defaultValue, minimum, maximum });
}

export const HOSTED_RELAY_LIMIT_SCHEMA = Object.freeze({
  bodyLimitBytes: field('CITADEL_RELAY_BODY_LIMIT_BYTES', 256 * KiB, 1024, MiB),
  runTimeoutMs: field('CITADEL_RELAY_RUN_TIMEOUT_MS', 60_000, 1000, 5 * 60_000),
  requestTimeoutMs: field('CITADEL_RELAY_HTTP_TIMEOUT_MS', 10_000, 100, 60_000),
  maxRequestsPerRun: field('CITADEL_RELAY_MAX_REQUESTS_PER_RUN', 12, 1, 64),
  maxConcurrentRequests: field('CITADEL_RELAY_MAX_CONCURRENT_REQUESTS', 4, 1, 32),
});

export const DEFAULT_RELAY_SERVER_LIMITS = Object.freeze({
  bodyLimitBytes: HOSTED_RELAY_LIMIT_SCHEMA.bodyLimitBytes.defaultValue,
  runTimeoutMs: HOSTED_RELAY_LIMIT_SCHEMA.runTimeoutMs.defaultValue,
  maxConcurrentRequests: HOSTED_RELAY_LIMIT_SCHEMA.maxConcurrentRequests.defaultValue,
});

export const DEFAULT_RELAY_EXECUTOR_LIMITS = Object.freeze({
  stepTimeoutMs: 30_000,
  runTimeoutMs: HOSTED_RELAY_LIMIT_SCHEMA.runTimeoutMs.defaultValue,
  maxOutputBytes: 256 * KiB,
  maxResponseBytes: 512 * KiB,
  maxBurstRequests: 20,
  maxRequestsPerRun: 20,
  maxConcurrency: HOSTED_RELAY_LIMIT_SCHEMA.maxConcurrentRequests.defaultValue,
});

const RELAY_SERVER_LIMIT_SCHEMA = Object.freeze({
  bodyLimitBytes: field(null, DEFAULT_RELAY_SERVER_LIMITS.bodyLimitBytes, 1, HOSTED_RELAY_LIMIT_SCHEMA.bodyLimitBytes.maximum),
  runTimeoutMs: field(null, DEFAULT_RELAY_SERVER_LIMITS.runTimeoutMs, 1, HOSTED_RELAY_LIMIT_SCHEMA.runTimeoutMs.maximum),
  maxConcurrentRequests: HOSTED_RELAY_LIMIT_SCHEMA.maxConcurrentRequests,
});

const RELAY_EXECUTOR_LIMIT_SCHEMA = Object.freeze({
  stepTimeoutMs: field(null, DEFAULT_RELAY_EXECUTOR_LIMITS.stepTimeoutMs, 1, HOSTED_RELAY_LIMIT_SCHEMA.requestTimeoutMs.maximum),
  runTimeoutMs: field(null, DEFAULT_RELAY_EXECUTOR_LIMITS.runTimeoutMs, 1, HOSTED_RELAY_LIMIT_SCHEMA.runTimeoutMs.maximum),
  maxOutputBytes: field(null, DEFAULT_RELAY_EXECUTOR_LIMITS.maxOutputBytes, 1, MiB),
  maxResponseBytes: field(null, DEFAULT_RELAY_EXECUTOR_LIMITS.maxResponseBytes, 1, MiB),
  maxBurstRequests: field(null, DEFAULT_RELAY_EXECUTOR_LIMITS.maxBurstRequests, 1, HOSTED_RELAY_LIMIT_SCHEMA.maxRequestsPerRun.maximum),
  maxRequestsPerRun: field(null, DEFAULT_RELAY_EXECUTOR_LIMITS.maxRequestsPerRun, 1, HOSTED_RELAY_LIMIT_SCHEMA.maxRequestsPerRun.maximum),
  maxConcurrency: field(null, DEFAULT_RELAY_EXECUTOR_LIMITS.maxConcurrency, 1, HOSTED_RELAY_LIMIT_SCHEMA.maxConcurrentRequests.maximum),
});

function validateExactIntegerLimits(overrides, schema, label) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const unknown = Object.keys(overrides).filter((name) => !Object.hasOwn(schema, name));
  if (unknown.length > 0) throw new TypeError(`Unknown ${label.toLowerCase()} key "${unknown[0]}".`);

  const limits = {};
  for (const [name, specification] of Object.entries(schema)) {
    const value = overrides[name] ?? specification.defaultValue;
    if (!Number.isInteger(value) || value < specification.minimum || value > specification.maximum) {
      throw new RangeError(
        `${label} "${name}" must be an integer between ${specification.minimum} and ${specification.maximum}.`,
      );
    }
    limits[name] = value;
  }
  return Object.freeze(limits);
}

export function validateHostedRelayLimits(overrides = {}) {
  const limits = validateExactIntegerLimits(overrides, HOSTED_RELAY_LIMIT_SCHEMA, 'Hosted relay limit');
  if (limits.requestTimeoutMs > limits.runTimeoutMs) {
    throw new RangeError('Hosted relay limit "requestTimeoutMs" must not exceed "runTimeoutMs".');
  }
  return limits;
}

export function readHostedRelayLimits(env = process.env) {
  const configured = {};
  for (const [name, specification] of Object.entries(HOSTED_RELAY_LIMIT_SCHEMA)) {
    const raw = env[specification.environmentName];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
      throw new TypeError(`${specification.environmentName} must be an unsigned base-10 integer.`);
    }
    configured[name] = Number(raw);
  }
  return validateHostedRelayLimits(configured);
}

export function relayServerLimitsFromHosted(limits) {
  const hosted = validateHostedRelayLimits(limits);
  return validateRelayServerLimits({
    bodyLimitBytes: hosted.bodyLimitBytes,
    runTimeoutMs: hosted.runTimeoutMs,
    maxConcurrentRequests: hosted.maxConcurrentRequests,
  });
}

export function relayExecutorLimitsFromHosted(limits) {
  const hosted = validateHostedRelayLimits(limits);
  return validateRelayExecutorLimits({
    stepTimeoutMs: hosted.requestTimeoutMs,
    runTimeoutMs: hosted.runTimeoutMs,
    maxBurstRequests: hosted.maxRequestsPerRun,
    maxRequestsPerRun: hosted.maxRequestsPerRun,
    maxConcurrency: hosted.maxConcurrentRequests,
  });
}

export function validateRelayServerLimits(overrides = {}) {
  return validateExactIntegerLimits(overrides, RELAY_SERVER_LIMIT_SCHEMA, 'Relay server limit');
}

export function validateRelayExecutorLimits(overrides = {}) {
  const limits = validateExactIntegerLimits(overrides, RELAY_EXECUTOR_LIMIT_SCHEMA, 'Relay executor limit');
  if (limits.stepTimeoutMs > limits.runTimeoutMs) {
    throw new RangeError('Relay executor limit "stepTimeoutMs" must not exceed "runTimeoutMs".');
  }
  return limits;
}
