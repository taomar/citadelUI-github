#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRelayAppRegistrationManifest } from '../src/relay/tokenContract.mjs';

const OPTION_NAMES = Object.freeze({
  '--manifest': 'manifest',
  '--tenant-id': 'tenantId',
  '--client-id': 'clientId',
  '--resource': 'resource',
  '--audience': 'audience',
  '--issuer': 'issuer',
});

export function parseRelayAppRegistrationArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const key = OPTION_NAMES[option];
    if (!key) throw new TypeError(`Unknown option "${option ?? ''}".`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new TypeError(`Option ${option} may be supplied only once.`);
    const value = args[index + 1];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new TypeError(`Option ${option} requires a value.`);
    }
    values[key] = value;
  }
  for (const [option, key] of Object.entries(OPTION_NAMES)) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new TypeError(`Missing required option ${option}.`);
  }
  return values;
}

export async function checkRelayAppRegistration(args, { read = readFile } = {}) {
  const options = parseRelayAppRegistrationArgs(args);
  let manifest;
  try {
    manifest = JSON.parse(decodeManifestText(await read(resolve(options.manifest))));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError('The relay app-registration manifest must be valid JSON.');
    throw error;
  }
  return validateRelayAppRegistrationManifest(manifest, {
    version: 2,
    issuer: options.issuer,
    resource: options.resource,
    audience: options.audience,
    tenantId: options.tenantId,
    clientId: options.clientId,
  });
}

export function decodeManifestText(content) {
  if (typeof content === 'string') return content.replace(/^\uFEFF/, '');
  if (!Buffer.isBuffer(content)) throw new TypeError('The relay app-registration manifest must be readable as text.');
  if (content[0] === 0xff && content[1] === 0xfe) {
    return content.subarray(2).toString('utf16le').replace(/^\uFEFF/, '');
  }
  if (content[0] === 0xfe && content[1] === 0xff) {
    const source = content.subarray(2);
    if (source.length % 2 !== 0) throw new TypeError('The relay app-registration manifest has invalid UTF-16BE content.');
    const swapped = Buffer.alloc(source.length);
    for (let index = 0; index < source.length; index += 2) {
      swapped[index] = source[index + 1];
      swapped[index + 1] = source[index];
    }
    return swapped.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return content.toString('utf8').replace(/^\uFEFF/, '');
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const contract = await checkRelayAppRegistration(process.argv.slice(2));
    process.stdout.write(
      `relay app-registration preflight: ok - v${contract.version}, ${contract.tenantId}, ${contract.audience}\n`,
    );
  } catch (error) {
    process.stderr.write(`relay app-registration preflight: failed - ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
