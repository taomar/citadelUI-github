/**
 * Request validation and plan reconstruction.
 *
 * The browser sends four things and nothing else:
 *
 *   { protocolVersion, sampleId, inputs, secrets, acknowledgement }
 *
 * It cannot send a plan, a command, a URL, a header set, a file path, an
 * executable, or a script. Anything resembling one is rejected here by name, so
 * a future client bug cannot quietly turn this endpoint into a command runner.
 *
 * What the server does instead: look the sample up in ITS OWN catalogue, coerce
 * and validate each declared input, re-check the requirement manifest and the
 * risk gate, then call the catalogue's own builder. The plan that executes is
 * always the one the server built.
 */

import { EXECUTION_PROTOCOL_VERSION } from '../core/types.mjs';
import { coerceValue } from '../core/validation.mjs';

export const MAX_INPUT_KEYS = 80;
export const MAX_STRING_LENGTH = 4096;
export const MAX_LIST_ITEMS = 64;

export class RequestRefused extends Error {
  constructor(message, { status = 400, code = 'invalid-request' } = {}) {
    super(message);
    this.name = 'RequestRefused';
    this.status = status;
    this.code = code;
  }
}

/** Members that must never appear: each would be an instruction, not a value. */
const FORBIDDEN_MEMBERS = Object.freeze([
  'plan',
  'steps',
  'command',
  'commands',
  'executable',
  'args',
  'argv',
  'url',
  'uri',
  'endpoint',
  'headers',
  'script',
  'code',
  'path',
  'paths',
  'file',
  'cwd',
  'env',
  'shell',
]);

/**
 * Validate the wire request against the server's catalogue.
 *
 * @param {unknown} payload
 * @param {object} catalogue
 * @returns {{ sample, inputs, secrets, acknowledgement }}
 */
export function validateRunRequest(payload, catalogue) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestRefused('The request body must be a JSON object.');
  }
  for (const member of FORBIDDEN_MEMBERS) {
    if (Object.prototype.hasOwnProperty.call(payload, member)) {
      throw new RequestRefused(
        `The request carries "${member}". The browser never supplies commands, URLs, headers, paths or scripts; the server rebuilds all of them from its own catalogue.`,
        { code: 'forbidden-member' },
      );
    }
  }
  if (payload.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    throw new RequestRefused(
      `Unsupported protocol version ${payload.protocolVersion}. This server speaks version ${EXECUTION_PROTOCOL_VERSION}.`,
      { code: 'protocol-version' },
    );
  }
  if (typeof payload.sampleId !== 'string' || !catalogue.byId.has(payload.sampleId)) {
    throw new RequestRefused(`"${payload.sampleId}" is not a sample in this catalogue.`, { code: 'unknown-sample' });
  }
  const sample = catalogue.byId.get(payload.sampleId);

  const rawInputs = payload.inputs ?? {};
  if (typeof rawInputs !== 'object' || Array.isArray(rawInputs)) {
    throw new RequestRefused('`inputs` must be an object keyed by catalogue field path.');
  }
  const inputKeys = Object.keys(rawInputs);
  if (inputKeys.length > MAX_INPUT_KEYS) {
    throw new RequestRefused(`\`inputs\` carries ${inputKeys.length} keys; the limit is ${MAX_INPUT_KEYS}.`);
  }

  // Only the keys THIS sample declares are accepted. An input for a field the
  // sample does not use is a rejection, not something to ignore quietly.
  const declared = new Map(sample.configurationEntries.map((entry) => [entry.path, entry]));
  const inputs = {};
  for (const [path, value] of Object.entries(rawInputs)) {
    const entry = declared.get(path);
    if (!entry) {
      throw new RequestRefused(`"${path}" is not an input of sample "${sample.id}".`, { code: 'unknown-input' });
    }
    if (entry.secret) {
      throw new RequestRefused(`"${path}" is a secret and must be sent in \`secrets\`, never in \`inputs\`.`, {
        code: 'secret-in-inputs',
      });
    }
    inputs[path] = checkedValue(entry, value);
  }

  const rawSecrets = payload.secrets ?? {};
  if (typeof rawSecrets !== 'object' || Array.isArray(rawSecrets)) {
    throw new RequestRefused('`secrets` must be an object keyed by catalogue field path.');
  }
  const allowedSecrets = new Set(sample.configurationEntries.filter((entry) => entry.secret).map((entry) => entry.path));
  const secrets = {};
  for (const [path, value] of Object.entries(rawSecrets)) {
    if (!allowedSecrets.has(path)) {
      throw new RequestRefused(`"${path}" is not a secret this sample uses.`, { code: 'unknown-secret' });
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_LENGTH) {
      throw new RequestRefused(`The value for "${path}" is not a plausible credential string.`);
    }
    secrets[path] = value;
  }

  const acknowledgement = payload.acknowledgement ?? null;
  if (sample.risk.requiresAcknowledgement) {
    if (!acknowledgement || acknowledgement.accepted !== true || acknowledgement.sampleId !== sample.id) {
      throw new RequestRefused(
        `"${sample.title}" is ${sample.risk.level}. A fresh acknowledgement naming this sample is required before it will run.`,
        { code: 'acknowledgement-required', status: 409 },
      );
    }
  }

  return { sample, inputs, secrets, acknowledgement };
}

function checkedValue(entry, value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      throw new RequestRefused(`The value for "${entry.path}" exceeds ${MAX_STRING_LENGTH} characters.`);
    }
    if (value.includes('\0')) throw new RequestRefused(`The value for "${entry.path}" contains a NUL byte.`);
    return value;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new RequestRefused(`The value for "${entry.path}" is not a finite number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ITEMS) {
      throw new RequestRefused(`The list for "${entry.path}" holds ${value.length} items; the limit is ${MAX_LIST_ITEMS}.`);
    }
    return value.map((item) => {
      if (typeof item !== 'string') throw new RequestRefused(`"${entry.path}" must be a list of strings.`);
      if (item.length > MAX_STRING_LENGTH) throw new RequestRefused(`An item in "${entry.path}" is too long.`);
      return item;
    });
  }
  throw new RequestRefused(`The value for "${entry.path}" has an unsupported type.`);
}

/**
 * Rebuild the plan from the server's catalogue.
 *
 * The reader deliberately falls back to the catalogue's declared default for
 * anything the browser did not send, so a client that omits an optional value
 * gets the documented behaviour rather than an empty string.
 */
export function rebuildPlan({ sample, inputs, secrets }, catalogue, { buildSamplePlan, requirementsFor }) {
  const read = (path) => {
    if (Object.prototype.hasOwnProperty.call(secrets, path)) return secrets[path];
    if (Object.prototype.hasOwnProperty.call(inputs, path)) return inputs[path];
    return catalogue.defaultValues[path];
  };

  const manifest = requirementsFor(sample, read, {
    hasSecret: (path) => typeof secrets[path] === 'string' && secrets[path].length > 0,
  });
  if (!manifest.satisfied) {
    throw new RequestRefused(
      `The configuration is incomplete: ${manifest.blocking.map((entry) => entry.label).join(', ')}.`,
      { code: 'incomplete-configuration' },
    );
  }

  const { plan, validation } = buildSamplePlan(sample, read);
  if (!plan) {
    throw new RequestRefused(
      `The configuration did not validate: ${validation.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message)
        .join(' ')}`,
      { code: 'invalid-configuration' },
    );
  }
  // The coerced, defaulted view every registry entry reads from.
  const resolvedInputs = {};
  for (const entry of sample.configurationEntries) {
    if (entry.secret) continue;
    const field = { type: entry.type };
    const value = coerceValue(field, read(entry.path));
    resolvedInputs[entry.path] = value === undefined || value === '' ? catalogue.defaultValues[entry.path] : value;
  }
  return { plan, manifest, resolvedInputs };
}
