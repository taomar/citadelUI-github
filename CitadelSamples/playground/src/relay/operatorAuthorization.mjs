/**
 * Deployment-owned hosted operator authorization policy.
 *
 * Container Apps Easy Auth validates the token and removes caller-supplied
 * identity headers before the request reaches the container. This module
 * validates the narrower application entitlement that the process enforces.
 */

export const DEFAULT_HOSTED_OPERATOR_APP_ROLE = 'Citadel.Operator';
export const HOSTED_AUTHORIZATION_CONFIGURATION_ERROR = 'hosted-authorization-configuration-invalid';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,119}$/;

export class HostedAuthorizationConfigurationError extends TypeError {
  constructor(message) {
    super(`Hosted operator authorization configuration error: ${message}`);
    this.name = 'HostedAuthorizationConfigurationError';
    this.code = HOSTED_AUTHORIZATION_CONFIGURATION_ERROR;
  }
}

function fail(message) {
  throw new HostedAuthorizationConfigurationError(message);
}

function canonicalGuid(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || !GUID_PATTERN.test(value)) {
    fail(`${label} must be a canonical lowercase Microsoft Entra object GUID.`);
  }
  return value;
}

function optionalRole(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.trim() !== value || !ROLE_PATTERN.test(value)) {
    fail(`${label} must be an exact app-role value of 1 to 120 safe characters.`);
  }
  return value;
}

function canonicalGuidList(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be a JSON array of Microsoft Entra object GUIDs.`);
  const seen = new Set();
  return Object.freeze(
    value.map((entry, index) => {
      const guid = canonicalGuid(entry, `${label}[${index}]`);
      if (seen.has(guid)) fail(`${label} must not contain duplicate object GUIDs.`);
      seen.add(guid);
      return guid;
    }),
  );
}

function readOptionalJsonArray(environment, name) {
  const raw = environment[name];
  if (raw === undefined || raw === '') return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${name} must be valid JSON.`);
  }
  return value;
}

export function validateHostedAuthorizationPolicy({
  requiredRole = '',
  allowedPrincipalIds = [],
  allowedGroupIds = [],
} = {}) {
  const role = optionalRole(requiredRole, 'required hosted operator app role');
  const principals = canonicalGuidList(allowedPrincipalIds, 'allowed hosted operator principal IDs');
  const groups = canonicalGuidList(allowedGroupIds, 'allowed hosted operator group IDs');
  if (!role && principals.length === 0 && groups.length === 0) {
    fail('at least one required app role, allowed principal ID, or allowed group ID must be configured.');
  }
  return Object.freeze({
    requiredRole: role,
    allowedPrincipalIds: principals,
    allowedGroupIds: groups,
  });
}

export function readHostedAuthorizationPolicy(
  environment,
  {
    requiredRole = 'CITADEL_PLAYGROUND_OPERATOR_REQUIRED_APP_ROLE',
    allowedPrincipalIds = 'CITADEL_PLAYGROUND_OPERATOR_ALLOWED_PRINCIPAL_IDS',
    allowedGroupIds = 'CITADEL_PLAYGROUND_OPERATOR_ALLOWED_GROUP_IDS',
  } = {},
) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('the hosted application environment must be an object.');
  }
  return validateHostedAuthorizationPolicy({
    requiredRole: environment[requiredRole] ?? '',
    allowedPrincipalIds: readOptionalJsonArray(environment, allowedPrincipalIds),
    allowedGroupIds: readOptionalJsonArray(environment, allowedGroupIds),
  });
}

export function validateOperatorAppManifest(
  manifest,
  {
    clientId,
    requiredRole = DEFAULT_HOSTED_OPERATOR_APP_ROLE,
    requireGroupClaims = false,
  } = {},
) {
  const expectedClientId = canonicalGuid(clientId, 'playground app client ID');
  const expectedRole = optionalRole(requiredRole, 'required hosted operator app role');
  if (!expectedRole) fail('the required hosted operator app role must not be empty.');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('the playground app-registration manifest must be one JSON object.');
  }
  if (manifest.appId !== expectedClientId) {
    fail(`manifest appId must be exactly ${expectedClientId}.`);
  }
  if (!Array.isArray(manifest.appRoles)) {
    fail('manifest appRoles must define the hosted operator app role.');
  }
  const matches = manifest.appRoles.filter((role) => role?.value === expectedRole);
  if (matches.length !== 1) {
    fail(`manifest appRoles must contain exactly one role with value ${expectedRole}.`);
  }
  const role = matches[0];
  if (role.isEnabled !== true) fail(`the ${expectedRole} app role must be enabled.`);
  if (!Array.isArray(role.allowedMemberTypes) || !role.allowedMemberTypes.includes('User')) {
    fail(`the ${expectedRole} app role must allow Users/Groups assignments.`);
  }
  if (
    requireGroupClaims === true &&
    manifest.groupMembershipClaims !== 'SecurityGroup' &&
    manifest.groupMembershipClaims !== 'All'
  ) {
    fail(
      'direct hosted operator group allowlists require manifest groupMembershipClaims to be SecurityGroup or All.',
    );
  }
  return Object.freeze({
    clientId: expectedClientId,
    requiredRole: expectedRole,
    roleId: canonicalGuid(role.id, `${expectedRole} app role ID`),
  });
}

export function validateOperatorAssignments(assignments, { roleId } = {}) {
  const expectedRoleId = canonicalGuid(roleId, 'hosted operator app role ID');
  const values = Array.isArray(assignments) ? assignments : assignments?.value;
  if (!Array.isArray(values)) {
    fail('the app-role assignment export must be an array or a Microsoft Graph response with a value array.');
  }
  const acceptedPrincipalTypes = new Set(['User', 'Group']);
  const matches = [];
  for (const [index, assignment] of values.entries()) {
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
      fail(`app-role assignment ${index} must be an object.`);
    }
    if (assignment.appRoleId !== expectedRoleId) continue;
    const principalType = assignment.principalType;
    if (!acceptedPrincipalTypes.has(principalType)) {
      fail(`assignment ${index} for the hosted operator role must target a User or Group.`);
    }
    canonicalGuid(assignment.principalId, `app-role assignment ${index} principalId`);
    matches.push(principalType);
  }
  if (matches.length === 0) {
    fail('at least one User or Group must be assigned to the hosted operator app role.');
  }
  return Object.freeze({
    assignmentCount: matches.length,
    principalTypes: Object.freeze([...new Set(matches)].sort()),
  });
}

export function hostedAuthorizationConfigurationError(error) {
  if (!(error instanceof HostedAuthorizationConfigurationError)) throw error;
  return Object.freeze({ code: error.code, detail: error.message });
}
