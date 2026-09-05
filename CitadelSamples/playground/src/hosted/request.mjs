import { RequestRefused, validateRunRequest } from '../server/runRequest.mjs';
import { canonicalInputDigest } from '../relay/acknowledgement.mjs';

export const FLOW_VERSION = 1;
export const HASH = /^[a-f0-9]{64}$/;
export const HANDLE = /^[\w-]{20,64}$/;
export const refuse = (message, code = 'staged-request-refused', status = 409) => {
  throw new RequestRefused(message, { code, status });
};
export const digest = (value) => canonicalInputDigest({ sampleId: 'hosted-staged-v1', inputs: value });

export function exact(value, fields, required = fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !fields.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    refuse('Invalid staged request shape.', 'invalid-request', 400);
  }
}

export function envelope(payload, fields, optional = []) {
  const base = ['protocolVersion', 'hostedFlowVersion'];
  exact(payload, [...base, ...fields, ...optional], [...base, ...fields]);
  if (payload.protocolVersion !== 2 || payload.hostedFlowVersion !== FLOW_VERSION) {
    refuse('Unsupported staged protocol.', 'protocol-version', 400);
  }
  if (Object.hasOwn(payload, 'contextVersion') && (!Number.isSafeInteger(payload.contextVersion) || payload.contextVersion < 0)) {
    refuse('Invalid context version.', 'invalid-request', 400);
  }
  for (const field of ['resolutionId', 'runId', 'runNonce', 'consentIntentId']) {
    if (Object.hasOwn(payload, field) && !HANDLE.test(payload[field])) refuse('Invalid operation handle.', 'invalid-request', 400);
  }
  for (const field of ['reviewDigest', 'targetDigest']) {
    if (Object.hasOwn(payload, field) && !HASH.test(payload[field])) refuse('Invalid digest.', 'invalid-request', 400);
  }
  return payload;
}

export function bindings(value, sample) {
  if (value === undefined) return {};
  const fields = sample.configurationEntries.filter((entry) => entry.secret).map((entry) => entry.path);
  exact(value, fields, []);
  for (const binding of Object.values(value)) {
    exact(binding, ['slotId', 'generation']);
    if (!HANDLE.test(binding.slotId) || !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
      refuse('Invalid credential binding.', 'invalid-secret-binding', 400);
    }
  }
  return value;
}

export function resolveRequest(payload, catalogue) {
  envelope(payload, ['sampleId', 'inputs', 'contextVersion'], ['secrets', 'secretBindings']);
  const request = validateRunRequest(payload, catalogue, { phase: 'resolve' });
  const secretBindings = bindings(payload.secretBindings, request.sample);
  if (Object.keys(secretBindings).some((field) => Object.hasOwn(request.secrets, field))) {
    refuse('Choose either an entered key or a server binding, not both.', 'ambiguous-credential', 400);
  }
  return { ...request, secretBindings };
}

export function immutable(value) {
  const copy = structuredClone(value);
  function freeze(item) {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
    return item;
  }
  return freeze(copy);
}

export function canonicalTargets(targets, { allowEmpty = false } = {}) {
  if (!Array.isArray(targets) || (!allowEmpty && !targets.length) || targets.length > 16) refuse('A bounded resolved target is required.', 'invalid-target');
  return targets.map((target) => {
    exact(target, ['resourceId', 'origin']);
    const url = new URL(target.origin);
    if (typeof target.resourceId !== 'string' || target.resourceId.length > 1024
      || (target.resourceId && !/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[\w.()-]+\/providers\/[A-Za-z.]+\/[\w./()-]+$/i.test(target.resourceId))
      || url.protocol !== 'https:' || url.origin !== target.origin || url.username || url.password) {
      refuse('Invalid resolved resource identity.', 'invalid-target');
    }
    return { resourceId: target.resourceId.toLowerCase(), origin: url.origin };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function targetKeys(targets) {
  return [...new Set(canonicalTargets(targets, { allowEmpty: true }).flatMap(({ resourceId, origin }) => {
    // Lock the owning APIM service/account, not a session, key hash, or caller contract label.
    const parent = resourceId.match(/^(.*\/providers\/(?:microsoft\.apimanagement\/service|microsoft\.cognitiveservices\/accounts)\/[^/]+)/)?.[1];
    return [digest({ origin }), ...(resourceId ? [digest({ resource: parent ?? resourceId })] : [])];
  }))].sort();
}
