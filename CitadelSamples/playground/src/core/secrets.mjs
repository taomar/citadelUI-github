/**
 * Secret handling and redaction.
 *
 * The strongest guarantee available here is structural: a generated plan never
 * contains a secret *value* in the first place. Wherever the notebook would
 * interpolate `api_key`, a plan carries a `SecretRef` — an inert object naming
 * the field — and the preview renders it as a shell/environment placeholder.
 *
 * `redact()` is therefore a second line of defence rather than the mechanism,
 * and `assertNoSecretValues()` is the assertion the tests run over every plan
 * and every preview.
 */

const SECRET_REF_BRAND = '@secretRef';

/**
 * Create an inert reference to a secret field.
 *
 * @param {string} ref  dotted path of the secret, e.g. `gatewayAccess.apiKey`
 * @param {{label?: string, envVar?: string}} [options]
 */
export function secretRef(ref, options = {}) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new TypeError('secretRef(ref) requires a non-empty string');
  }
  return Object.freeze({
    kind: SECRET_REF_BRAND,
    ref,
    label: options.label ?? ref,
    envVar: options.envVar ?? refToEnvVar(ref),
  });
}

export function isSecretRef(value) {
  return Boolean(value) && typeof value === 'object' && value.kind === SECRET_REF_BRAND;
}

/** `gatewayAccess.apiKey` -> `CITADEL_GATEWAY_ACCESS_API_KEY`. */
export function refToEnvVar(ref) {
  const upper = String(ref)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.\-\s]+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .toUpperCase();
  return `CITADEL_${upper}`;
}

/** Placeholder written into copy-safe previews. Never a real value. */
export function secretPlaceholder(ref) {
  return `\${${isSecretRef(ref) ? ref.envVar : refToEnvVar(ref)}}`;
}

export const REDACTED = '••••••••';

/**
 * Replace every occurrence of every known secret value with `REDACTED`, and
 * render any `SecretRef` as its placeholder.
 *
 * @param {unknown} value          structure to redact
 * @param {Record<string,string>} secrets  ref -> live value (memory only)
 */
export function redact(value, secrets = {}) {
  const values = Object.values(secrets ?? {}).filter(
    (candidate) => typeof candidate === 'string' && candidate.length > 0,
  );
  return redactDeep(value, values);
}

function redactDeep(value, secretValues) {
  if (isSecretRef(value)) return secretPlaceholder(value);
  if (typeof value === 'string') return redactString(value, secretValues);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secretValues));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactDeep(item, secretValues);
    }
    return out;
  }
  return value;
}

function redactString(text, secretValues = []) {
  let out = String(text);
  for (const secret of secretValues) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Throw when any live secret value appears anywhere in `value`.
 * Used by tests and by the copy action before text reaches the clipboard.
 */
export function assertNoSecretValues(value, secrets = {}, context = 'value') {
  const offenders = findSecretValues(value, secrets);
  if (offenders.length > 0) {
    throw new Error(`${context} contains secret value(s) for: ${offenders.join(', ')}`);
  }
  return true;
}

export function findSecretValues(value, secrets = {}) {
  const serialized = stringifyForScan(value);
  const offenders = [];
  for (const [ref, secret] of Object.entries(secrets ?? {})) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    if (serialized.includes(secret)) offenders.push(ref);
  }
  return offenders;
}

function stringifyForScan(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, (_key, item) => (isSecretRef(item) ? secretPlaceholder(item) : item)) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Collect every distinct secret reference used anywhere in a structure, in
 * first-seen order. Plans expose this as `plan.secretRefs`.
 */
export function collectSecretRefs(value, seen = new Map()) {
  if (isSecretRef(value)) {
    if (!seen.has(value.ref)) seen.set(value.ref, value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectSecretRefs(item, seen);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectSecretRefs(item, seen);
  }
  return [...seen.values()];
}

/**
 * Resolve secret references to live values. This is the ONLY function allowed
 * to put a secret value into an outgoing structure, and nothing in the browser
 * calls it — it exists for a future executor that runs outside the browser.
 */
export function resolveSecretRefs(value, secrets = {}) {
  if (isSecretRef(value)) {
    const resolved = secrets?.[value.ref];
    if (typeof resolved !== 'string' || resolved.length === 0) {
      throw new Error(`Missing secret value for ${value.ref}`);
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveSecretRefs(item, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveSecretRefs(item, secrets);
    return out;
  }
  return value;
}
