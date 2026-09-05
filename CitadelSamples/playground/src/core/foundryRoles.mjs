/**
 * Reviewed Foundry role definitions used by the APIM identity grant recipe.
 *
 * The imported accelerator still calls the broader role `Azure AI User`.
 * Microsoft renamed it to `Foundry User` without changing its role definition
 * id, so the selection stays source-compatible while commands bind by id.
 */
export const FOUNDRY_ROLE_DEFINITIONS = Object.freeze([
  Object.freeze({
    selection: 'Foundry Agent Consumer',
    label: 'Foundry Agent Consumer (least privilege)',
    roleDefinitionName: 'Foundry Agent Consumer',
    acceptedRoleDefinitionNames: Object.freeze(['Foundry Agent Consumer']),
    roleDefinitionId: 'eed3b665-ab3a-47b6-8f48-c9382fb1dad6',
  }),
  Object.freeze({
    selection: 'Azure AI User',
    label: 'Foundry User (formerly Azure AI User; broader data-plane access)',
    roleDefinitionName: 'Foundry User',
    acceptedRoleDefinitionNames: Object.freeze(['Foundry User', 'Azure AI User']),
    roleDefinitionId: '53ca6127-db72-4b80-b1b0-d745d6d5456d',
  }),
]);

const ROLE_BY_SELECTION = new Map(FOUNDRY_ROLE_DEFINITIONS.map((role) => [role.selection, role]));
const APPROVED_ROLE_DEFINITION_IDS = new Set(FOUNDRY_ROLE_DEFINITIONS.map((role) => role.roleDefinitionId));

export const FOUNDRY_ROLE_OPTIONS = Object.freeze(
  FOUNDRY_ROLE_DEFINITIONS.map((role) => Object.freeze({ value: role.selection, label: role.label })),
);

export function foundryRoleDefinition(selection) {
  const role = ROLE_BY_SELECTION.get(selection);
  if (!role) throw new TypeError(`Unsupported Foundry role selection "${selection}".`);
  return role;
}

export function isApprovedFoundryRoleDefinitionId(value) {
  return APPROVED_ROLE_DEFINITION_IDS.has(String(value).toLowerCase());
}

export function normaliseRoleDefinitionId(value) {
  return String(value ?? '').trim().split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '';
}
