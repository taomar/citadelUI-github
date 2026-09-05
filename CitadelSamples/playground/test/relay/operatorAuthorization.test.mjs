import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkPlaygroundAppRegistration,
  parsePlaygroundAppRegistrationArgs,
} from '../../scripts/check-playground-app-registration.mjs';
import {
  HOSTED_AUTHORIZATION_CONFIGURATION_ERROR,
  readHostedAuthorizationPolicy,
  validateHostedAuthorizationPolicy,
  validateOperatorAppManifest,
  validateOperatorAssignments,
} from '../../src/relay/operatorAuthorization.mjs';

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const ROLE_ID = '22222222-2222-2222-2222-222222222222';
const PRINCIPAL_ID = '33333333-3333-3333-3333-333333333333';
const GROUP_ID = '44444444-4444-4444-4444-444444444444';

function manifest(overrides = {}) {
  return {
    appId: CLIENT_ID,
    appRoles: [
      {
        id: ROLE_ID,
        value: 'Citadel.Operator',
        displayName: 'Citadel Operator',
        description: 'Operate the hosted Citadel playground.',
        allowedMemberTypes: ['User'],
        isEnabled: true,
      },
    ],
    ...overrides,
  };
}

function assignments(overrides = {}) {
  return {
    value: [
      {
        appRoleId: ROLE_ID,
        principalId: PRINCIPAL_ID,
        principalType: 'User',
        ...overrides,
      },
    ],
  };
}

test('hosted authorization policy is exact, unique, and default-deny', () => {
  assert.deepEqual(
    validateHostedAuthorizationPolicy({
      requiredRole: 'Citadel.Operator',
      allowedPrincipalIds: [PRINCIPAL_ID],
      allowedGroupIds: [GROUP_ID],
    }),
    {
      requiredRole: 'Citadel.Operator',
      allowedPrincipalIds: [PRINCIPAL_ID],
      allowedGroupIds: [GROUP_ID],
    },
  );
  assert.throws(
    () => validateHostedAuthorizationPolicy(),
    (error) =>
      error.code === HOSTED_AUTHORIZATION_CONFIGURATION_ERROR &&
      /at least one required app role/.test(error.message),
  );
  assert.throws(
    () => validateHostedAuthorizationPolicy({ requiredRole: 'Citadel Operator' }),
    /exact app-role value/,
  );
});

test('hosted authorization policy reads deployment-owned JSON allowlists', () => {
  assert.deepEqual(
    readHostedAuthorizationPolicy({
      CITADEL_PLAYGROUND_OPERATOR_REQUIRED_APP_ROLE: 'Citadel.Operator',
      CITADEL_PLAYGROUND_OPERATOR_ALLOWED_PRINCIPAL_IDS: JSON.stringify([PRINCIPAL_ID]),
      CITADEL_PLAYGROUND_OPERATOR_ALLOWED_GROUP_IDS: JSON.stringify([GROUP_ID]),
    }),
    {
      requiredRole: 'Citadel.Operator',
      allowedPrincipalIds: [PRINCIPAL_ID],
      allowedGroupIds: [GROUP_ID],
    },
  );
  assert.throws(
    () =>
      readHostedAuthorizationPolicy({
        CITADEL_PLAYGROUND_OPERATOR_REQUIRED_APP_ROLE: '',
        CITADEL_PLAYGROUND_OPERATOR_ALLOWED_PRINCIPAL_IDS: '[]',
        CITADEL_PLAYGROUND_OPERATOR_ALLOWED_GROUP_IDS: '[]',
      }),
    /at least one required app role/,
  );
});

test('playground app registration requires one enabled Users/Groups app role', () => {
  assert.deepEqual(
    validateOperatorAppManifest(manifest(), {
      clientId: CLIENT_ID,
      requiredRole: 'Citadel.Operator',
    }),
    {
      clientId: CLIENT_ID,
      requiredRole: 'Citadel.Operator',
      roleId: ROLE_ID,
    },
  );
  for (const appRoles of [
    [],
    [{ ...manifest().appRoles[0], value: 'Other.Role' }],
    [{ ...manifest().appRoles[0], isEnabled: false }],
    [{ ...manifest().appRoles[0], allowedMemberTypes: ['Application'] }],
  ]) {
    assert.throws(
      () =>
        validateOperatorAppManifest(manifest({ appRoles }), {
          clientId: CLIENT_ID,
          requiredRole: 'Citadel.Operator',
        }),
      /app role|appRoles|enabled|Users\/Groups/,
    );
  }
});

test('direct group allowlists require group claims in the playground ID token', () => {
  assert.throws(
    () =>
      validateOperatorAppManifest(manifest(), {
        clientId: CLIENT_ID,
        requiredRole: 'Citadel.Operator',
        requireGroupClaims: true,
      }),
    /groupMembershipClaims/,
  );
  for (const groupMembershipClaims of ['SecurityGroup', 'All']) {
    assert.doesNotThrow(() =>
      validateOperatorAppManifest(manifest({ groupMembershipClaims }), {
        clientId: CLIENT_ID,
        requiredRole: 'Citadel.Operator',
        requireGroupClaims: true,
      }),
    );
  }
});

test('playground app-role assignment export requires an assigned User or Group', () => {
  assert.deepEqual(
    validateOperatorAssignments(assignments(), { roleId: ROLE_ID }),
    {
      assignmentCount: 1,
      principalTypes: ['User'],
    },
  );
  assert.deepEqual(
    validateOperatorAssignments(assignments({ principalType: 'Group' }), {
      roleId: ROLE_ID,
    }).principalTypes,
    ['Group'],
  );
  assert.throws(
    () =>
      validateOperatorAssignments(assignments({ appRoleId: GROUP_ID }), {
        roleId: ROLE_ID,
      }),
    /at least one User or Group/,
  );
  assert.throws(
    () =>
      validateOperatorAssignments(assignments({ principalType: 'ServicePrincipal' }), {
        roleId: ROLE_ID,
      }),
    /must target a User or Group/,
  );
});

test('the offline playground app checker validates definition and assignment exports without Graph access', async () => {
  const args = [
    '--manifest',
    '.\\playground-app.json',
    '--assignments',
    '.\\playground-app-role-assignments.json',
    '--client-id',
    CLIENT_ID,
    '--required-app-role',
    'Citadel.Operator',
  ];
  assert.deepEqual(
    parsePlaygroundAppRegistrationArgs(args),
    {
      manifest: '.\\playground-app.json',
      assignments: '.\\playground-app-role-assignments.json',
      clientId: CLIENT_ID,
      requiredRole: 'Citadel.Operator',
      allowedGroupIds: '[]',
    },
  );
  const paths = [];
  const result = await checkPlaygroundAppRegistration(args, {
    read: async (path) => {
      paths.push(path);
      return JSON.stringify(
        path.endsWith('playground-app.json') ? manifest() : assignments(),
      );
    },
  });
  assert.equal(result.assignmentCount, 1);
  assert.equal(paths.length, 2);
  assert.throws(
    () => parsePlaygroundAppRegistrationArgs([...args, '--extra', 'value']),
    /Unknown option/,
  );

  await assert.rejects(
    () =>
      checkPlaygroundAppRegistration(
        [...args, '--allowed-group-ids', JSON.stringify([GROUP_ID])],
        {
          read: async (path) =>
            JSON.stringify(path.endsWith('playground-app.json') ? manifest() : assignments()),
        },
      ),
    /groupMembershipClaims/,
  );

  const groupResult = await checkPlaygroundAppRegistration(
    [...args, '--allowed-group-ids', JSON.stringify([GROUP_ID])],
    {
      read: async (path) =>
        JSON.stringify(
          path.endsWith('playground-app.json')
            ? manifest({ groupMembershipClaims: 'SecurityGroup' })
            : assignments(),
        ),
    },
  );
  assert.equal(groupResult.groupAllowlistCount, 1);
});
