/**
 * Exact-schema requests for protected notebook source and offline validation.
 *
 * The route selects a catalogue recipe. The validation body carries only the
 * protocol version. Neither request can provide source code, a parameter value,
 * a command, a path, a URL, a secret, or any other execution instruction.
 */

import { EXECUTION_PROTOCOL_VERSION } from '../core/types.mjs';
import { RequestRefused } from './runRequest.mjs';

const VALIDATION_MEMBERS = Object.freeze(new Set(['protocolVersion']));

export function validateSourceSampleId(sampleId, catalogue) {
  if (typeof sampleId !== 'string' || !catalogue.byId.has(sampleId)) {
    throw new RequestRefused(`"${sampleId}" is not a sample in this catalogue.`, {
      code: 'unknown-sample',
      status: 404,
    });
  }
  return Object.freeze({ sample: catalogue.byId.get(sampleId) });
}

export function validateCodeValidationRequest(sampleId, payload, catalogue) {
  const { sample } = validateSourceSampleId(sampleId, catalogue);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestRefused('The request body must be a JSON object.');
  }
  for (const member of Object.keys(payload)) {
    if (!VALIDATION_MEMBERS.has(member)) {
      throw new RequestRefused(
        `The request carries "${member}". Offline source validation accepts only the protocol version; source and execution instructions are server-owned.`,
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
  return Object.freeze({ sample });
}
