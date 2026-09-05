#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeManifestText } from './check-relay-app-registration.mjs';
import {
  validateHostedAuthorizationPolicy,
  validateOperatorAppManifest,
  validateOperatorAssignments,
} from '../src/relay/operatorAuthorization.mjs';

const OPTION_NAMES = Object.freeze({
  '--manifest': 'manifest',
  '--assignments': 'assignments',
  '--client-id': 'clientId',
  '--required-app-role': 'requiredRole',
  '--allowed-group-ids': 'allowedGroupIds',
});

const REQUIRED_OPTIONS = new Set(['manifest', 'assignments', 'clientId', 'requiredRole']);

export function parsePlaygroundAppRegistrationArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const key = OPTION_NAMES[option];
    if (!key) throw new TypeError(`Unknown option "${option ?? ''}".`);
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new TypeError(`Option ${option} may be supplied only once.`);
    }
    const value = args[index + 1];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new TypeError(`Option ${option} requires a value.`);
    }
    values[key] = value;
  }
  for (const [option, key] of Object.entries(OPTION_NAMES)) {
    if (REQUIRED_OPTIONS.has(key) && !Object.prototype.hasOwnProperty.call(values, key)) {
      throw new TypeError(`Missing required option ${option}.`);
    }
  }
  return { ...values, allowedGroupIds: values.allowedGroupIds ?? '[]' };
}

function parseJsonFile(content, label) {
  try {
    return JSON.parse(decodeManifestText(content));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError(`${label} must be valid JSON.`);
    throw error;
  }
}

export async function checkPlaygroundAppRegistration(args, { read = readFile } = {}) {
  const options = parsePlaygroundAppRegistrationArgs(args);
  let allowedGroupIds;
  try {
    allowedGroupIds = JSON.parse(options.allowedGroupIds);
  } catch {
    throw new TypeError('--allowed-group-ids must be a valid JSON array.');
  }
  const policy = validateHostedAuthorizationPolicy({
    requiredRole: options.requiredRole,
    allowedGroupIds,
  });
  const [manifestContent, assignmentsContent] = await Promise.all([
    read(resolve(options.manifest)),
    read(resolve(options.assignments)),
  ]);
  const role = validateOperatorAppManifest(
    parseJsonFile(manifestContent, 'The playground app-registration manifest'),
    {
      clientId: options.clientId,
      requiredRole: options.requiredRole,
      requireGroupClaims: policy.allowedGroupIds.length > 0,
    },
  );
  const assignments = validateOperatorAssignments(
    parseJsonFile(assignmentsContent, 'The playground app-role assignment export'),
    { roleId: role.roleId },
  );
  return Object.freeze({
    ...role,
    ...assignments,
    groupAllowlistCount: policy.allowedGroupIds.length,
  });
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const result = await checkPlaygroundAppRegistration(process.argv.slice(2));
    process.stdout.write(
      `playground app-registration preflight: ok - ${result.requiredRole}, ${result.assignmentCount} assignment(s), ${result.groupAllowlistCount} direct group allowlist(s)\n`,
    );
  } catch (error) {
    process.stderr.write(
      `playground app-registration preflight: failed - ${error?.message ?? String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
