/**
 * Prepare — cells 8, 10 and 12.
 *
 * Three state-changing recipes that make the Foundry agent, the APIM identity
 * and the sample source API ready before the publish contract is deployed.
 */

import { step, createExecutionPlan } from '../../core/plan.mjs';
import {
  foundryAgentCardBackendUrl,
  foundryAgentJsonRpcBackendUrl,
  foundryAgentPatchUrl,
  foundryProjectResourceId,
} from '../../core/endpoints.mjs';
import { generated, mandatory, optional } from '../requirements.mjs';
import { LINKS } from '../profiles.mjs';

export const PREPARE_SAMPLES = [
  {
    id: 'foundry-enable-a2a',
    group: 'prepare',
    title: 'Enable incoming A2A on the Foundry agent',
    shortTitle: 'Enable Foundry A2A',
    summary: 'PATCH the Foundry prompt agent so it exposes an agent card and accepts A2A JSON-RPC.',
    purpose:
      'A Foundry prompt agent speaks the responses protocol out of the box, but its agent-to-agent endpoint is off until you activate it. Without this step the publish contract has no A2A backend to point at, and every A2A recipe further down the catalogue fails at the backend rather than at the gateway.',
    explanation: [
      'The activation is a single `PATCH` against the agent`s management surface with two things in the body: an `agent_card` describing the agent to A2A clients, and an `agent_endpoint.protocol_configuration` that lists both `responses` and `a2a`. Listing `responses` as well matters — sending only `a2a` turns the responses protocol off.',
      'Authentication is a bearer token for the `https://ai.azure.com` audience, which is the Foundry data-plane audience, not the ARM audience. `az account get-access-token --resource https://ai.azure.com` produces it, and the caller needs the Foundry User role on the project.',
      'Two URLs fall out of a successful PATCH and are needed by the publish contract: the agent card backend `…/agents/<agent>/endpoint/protocols/a2a/agentCard/v1.0`, and the JSON-RPC backend `…/agents/<agent>/endpoint/protocols/a2a`. The publish contract puts APIM in front of both.',
      'Read the deviation note below before running this. The notebook as published sends a literal `******` as its Authorization header, so the PATCH it performs would be rejected. This recipe sends a real bearer token.',
    ],
    flow: [
      'Verify the configured Foundry account exists in the validated Hub subscription.',
      'Acquire a bearer token for the `https://ai.azure.com` audience.',
      'PATCH `…/agents/<agent>?api-version=v1` with the agent card and a protocol configuration listing both `responses` and `a2a`.',
      'Confirm the response status is below 300.',
      'Record the agent card backend URL and the A2A JSON-RPC backend URL for the publish contract.',
    ],
    prerequisites: [
      {
        id: 'existing-agent',
        title: 'An existing Foundry prompt agent',
        detail: 'This recipe republishes an agent; it never creates one. The agent must already exist in the target project.',
        howTo:
          'Create one in the Foundry portal, or run the accelerator`s `citadel-agent-frameworks-tests.ipynb`, then put its name in the Foundry profile.',
        links: [LINKS.foundryA2a],
      },
      {
        id: 'foundry-user',
        title: 'Foundry User on the project',
        detail: 'The PATCH is a data-plane write against the project. Reader access is not enough.',
        howTo: 'Assign the Foundry User (or a role that includes agent write) at project scope.',
        links: [LINKS.foundryRbac],
      },
      {
        id: 'token-audience',
        title: 'A token for the Foundry audience',
        detail: 'The audience is `https://ai.azure.com`. An ARM token (`https://management.azure.com`) is rejected.',
        howTo: 'Run `az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv`.',
        links: [LINKS.azLogin],
      },
    ],
    usesProfiles: ['foundry'],
    fields: [
      {
        name: 'agentDescription',
        label: 'Agent card description',
        type: 'string',
        classification: 'sample-default',
        width: 'long',
        default: 'HR Chat Agent published via the AI Hub Gateway (A2A).',
        help: 'Description written into the published agent card. A2A clients show it when they resolve the card.',
        howToObtain: 'Fixed by the notebook (cell 8).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 8 `agent_card.description`',
      },
      {
        name: 'agentVersion',
        label: 'Agent card version',
        type: 'string',
        classification: 'sample-default',
        width: 'num',
        default: '1.0',
        help: 'Version string in the agent card. Independent of the A2A protocol version.',
        howToObtain: 'Fixed by the notebook (cell 8).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 8 `agent_card.version`',
      },
      {
        name: 'skillId',
        label: 'Skill id',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'general-qa',
        help: 'Identifier of the single skill advertised in the agent card.',
        howToObtain: 'Fixed by the notebook (cell 8).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 8 `agent_card.skills[0].id`',
      },
      {
        name: 'skillName',
        label: 'Skill name',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'General Q&A',
        help: 'Human-readable skill name in the agent card.',
        howToObtain: 'Fixed by the notebook (cell 8).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 8 `agent_card.skills[0].name`',
      },
      {
        name: 'skillDescription',
        label: 'Skill description',
        type: 'string',
        classification: 'sample-default',
        width: 'long',
        default: 'Answers HR policy questions',
        help: 'Skill description in the agent card.',
        howToObtain: 'Fixed by the notebook (cell 8).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 8 `agent_card.skills[0].description`',
      },
      {
        name: 'apiVersion',
        label: 'Foundry API version',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'v1',
        help: 'The `api-version` query value on the agent PATCH.',
        howToObtain: 'Fixed by the notebook (cell 8).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 8 `?api-version=v1`',
      },
    ],
    configuration: [
      mandatory('hub.subscriptionId', 'Binds the token request to the validated Hub profile subscription and tenant.'),
      mandatory('foundry.accountName', 'First segment of the Foundry data-plane host the PATCH is sent to.'),
      mandatory('foundry.projectName', 'Names the project in the agent URL; the PATCH cannot be addressed without it.'),
      mandatory('foundry.agentName', 'The agent being changed. This recipe never creates one.'),
      optional('self:apiVersion', 'The `api-version` on the agent PATCH.', 'Falls back to `v1`, the version the notebook pins.'),
      optional('self:agentDescription', 'Written into the published agent card.', 'Falls back to the notebook`s description.'),
      optional('self:agentVersion', 'Card version advertised to A2A clients.', 'Falls back to `1.0`.'),
      optional('self:skillId', 'Skill id inside the agent card.', 'Falls back to `general-qa`.'),
      optional('self:skillName', 'Skill display name inside the agent card.', 'Falls back to `General Q&A`.'),
      optional('self:skillDescription', 'Skill description inside the agent card.', 'Falls back to the notebook`s text.'),
    ],
    runtime: {
      dependencies: ['azure-cli', 'foundry-network'],
      note: '`az account get-access-token` mints the data-plane token; the PATCH then goes straight to the Foundry host, not through the gateway.',
    },
    risk: {
      level: 'state-changing',
      effect:
        'Overwrites the agent card and the protocol configuration of a live Foundry agent. Any A2A client already resolving that card sees the new description, version and skills.',
      blastRadius: 'One agent in one Foundry project.',
      reversibility:
        'Re-runnable, but the previous agent card is not saved anywhere by this recipe. Capture the current card first if it matters.',
      acknowledgementPrompt:
        'This PATCH overwrites the agent card and protocol configuration of a live Foundry agent. Confirm you are targeting a non-production agent you are allowed to change.',
    },
    sourceCells: [7, 8],
    sourceNote: 'Cell 8 acquires an `https://ai.azure.com` token and PATCHes the agent with an agent card and `a2a` protocol configuration.',
    expectedResults: [
      {
        id: 'patch-accepted',
        title: 'The PATCH is accepted',
        assertion:
          'HTTP status is below 300, and the response body reflects the agent card and protocol configuration that were sent.',
        evidence: 'The response status and body.',
        whenNotRun: 'Not run — A2A activation state is unknown.',
      },
      {
        id: 'backends-derived',
        title: 'Both A2A backend URLs are derived',
        assertion:
          'The agent card backend ends with `/endpoint/protocols/a2a/agentCard/v1.0` and the JSON-RPC backend ends with `/endpoint/protocols/a2a`.',
        evidence: 'The two URLs composed from the Foundry profile.',
        whenNotRun: 'Not run — the publish contract has no A2A backend to reference.',
      },
      {
        id: 'responses-preserved',
        title: 'The responses protocol is still configured',
        assertion:
          'The body lists both `responses` and `a2a` under `protocol_configuration`, so enabling A2A does not disable the responses protocol.',
        evidence: 'The request body.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'The notebook as published sends `"Authorization": f"******"` — a redaction artefact left in the source. Run verbatim, its PATCH would be rejected with 401. This recipe sends `Bearer <token>` from the preceding token step and never writes the token into the preview.',
      'The notebook prints the response body`s first 400 characters on failure. This recipe treats any status of 300 or above as a failure and does not truncate the diagnosis.',
    ],
    notes: [
      'Skipped entirely when `Publish the A2A asset` is off in the Foundry profile, exactly as the notebook skips it when `enable_a2a_asset = False`.',
      'The token step is marked as producing a credential. It is bound into the request by reference, so no token value ever reaches the preview or the clipboard.',
    ],
    build(ctx) {
      const accountName = ctx.get('foundry.accountName');
      const projectName = ctx.get('foundry.projectName');
      const agentName = ctx.get('foundry.agentName');
      const coords = { accountName, projectName, agentName };
      const apiVersion = ctx.self('apiVersion');
      return createExecutionPlan({
        sampleId: 'foundry-enable-a2a',
        title: 'Enable incoming A2A on the Foundry agent',
        summary: 'Verify the Foundry account target, acquire a data-plane token, and PATCH the agent to expose an A2A endpoint.',
        risk: ctx.risk,
        sourceCells: [7, 8],
        steps: [
          step.cli({
            id: 'find-account',
            title: 'Verify the Foundry account subscription',
            detail: 'Looks up the configured account name only inside the validated Hub subscription.',
            command: {
              executable: 'az',
              args: [
                'cognitiveservices',
                'account',
                'list',
                '--query',
                `[?name=='${accountName}'].id`,
                '--subscription',
                ctx.get('hub.subscriptionId'),
                '-o',
                'tsv',
              ],
            },
            produces: ['accountResourceId'],
          }),
          step.assertion({
            id: 'assert-account',
            title: 'Confirm the Foundry account target',
            detail: 'Stops before minting a bearer token unless exactly one matching account exists in the Hub subscription.',
            assertion: {
              kind: 'shape',
              source: '{{steps.find-account.accountResourceId}}',
              expectations: [
                `Exactly one Foundry account named \`${accountName}\` exists in the Hub subscription.`,
                'No token is minted and no PATCH is sent when the account is absent.',
              ],
            },
            produces: ['accountResourceId'],
          }),
          step.cli({
            id: 'acquire-token',
            title: 'Acquire a Foundry data-plane token',
            detail: 'Audience `https://ai.azure.com`. The value is bound by reference and never printed.',
            command: {
              executable: 'az',
              args: [
                'account',
                'get-access-token',
                '--resource',
                'https://ai.azure.com',
                '--subscription',
                ctx.get('hub.subscriptionId'),
                '--query',
                'accessToken',
                '-o',
                'tsv',
              ],
              note: 'Output is a credential. Capture it into a shell variable rather than echoing it.',
              producesCredential: true,
            },
            produces: ['accessToken'],
          }),
          step.http({
            id: 'patch-agent',
            title: 'PATCH the agent to enable A2A',
            detail: 'Sets the agent card and lists both `responses` and `a2a` protocols.',
            request: {
              method: 'PATCH',
              url: foundryAgentPatchUrl(coords, apiVersion),
              headers: {
                Authorization: 'Bearer {{steps.acquire-token.accessToken}}',
                'Content-Type': 'application/json',
              },
              body: {
                agent_card: {
                  description: ctx.self('agentDescription'),
                  version: ctx.self('agentVersion'),
                  skills: [
                    {
                      id: ctx.self('skillId'),
                      name: ctx.self('skillName'),
                      description: ctx.self('skillDescription'),
                    },
                  ],
                },
                agent_endpoint: {
                  protocol_configuration: { responses: {}, a2a: {} },
                },
              },
              capture: { status: 'response.status', body: 'response.body' },
              timeoutSeconds: 60,
            },
            produces: ['status', 'body'],
          }),
          step.assertion({
            id: 'assert-enabled',
            title: 'Confirm activation and derive the backend URLs',
            detail: 'Both URLs are handed to the publish contract as `agentCardBackendUrl` and `backend.url`.',
            assertion: {
              kind: 'http-status',
              source: '{{steps.patch-agent.status}}',
              expectations: [
                'Status is below 300.',
                `Agent card backend is ${foundryAgentCardBackendUrl(coords)}`,
                `A2A JSON-RPC backend is ${foundryAgentJsonRpcBackendUrl(coords)}`,
                'The response body confirms `a2a` is present in the protocol configuration.',
              ],
            },
            produces: ['a2aCardBackendUrl', 'a2aJsonRpcBackendUrl'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'apim-foundry-grant',
    group: 'prepare',
    title: 'Grant the APIM identity Foundry access',
    shortTitle: 'Grant APIM identity',
    summary: 'Give API Management`s managed identity a data-plane role on the Foundry project so the A2A backend needs no keys.',
    purpose:
      'The published A2A backend authenticates to Foundry with API Management`s managed identity against the `https://ai.azure.com` audience. Without a data-plane role on the project, every gateway-routed A2A call returns 401 or 403 from Foundry even though the gateway itself is configured correctly.',
    explanation: [
      'Three things happen in order. First the APIM identity is discovered, preferring a user-assigned identity over the system-assigned one, because a user-assigned identity can be shared and pre-granted. Second the Foundry project`s ARM id is composed, which is the account id plus `/projects/<project>` — the account may live in a different resource group from the hub, so it is looked up by name across the subscription. Third the role is assigned at project scope.',
      'The client id matters as much as the principal id. The principal id receives the role; the client id is passed to the publish contract as `managedIdentityClientId` so the generated backend embeds managed-identity auth using that specific identity. Leaving it empty makes the backend fall back to the system-assigned identity, which is only correct if that is the identity you granted.',
      '`Foundry Agent Consumer` is the least-privilege choice and is the notebook`s default. `Azure AI User` is broader. Assigning either requires Owner or User Access Administrator on the project scope; a failure here is very often a permissions failure, not a wrong role name.',
      'Role assignment is eventually consistent. A grant made seconds before a deployment can still be invisible to the data plane for a short time, so a 403 immediately after this recipe is not proof that the grant failed.',
    ],
    flow: [
      'Read the API Management identity block.',
      'Prefer a user-assigned identity; fall back to the system-assigned principal id.',
      'Look up the Foundry account`s ARM id by name and append `/projects/<project>`.',
      'Create the role assignment at project scope for the identity`s object id.',
      'Record the client id for the publish contract`s `managedIdentityClientId`.',
    ],
    prerequisites: [
      {
        id: 'apim-identity',
        title: 'API Management has a managed identity',
        detail: 'Either a user-assigned identity attached to the service, or the system-assigned identity enabled.',
        howTo: 'Check with `az apim show -g <rg> -n <apim> --query identity -o json`. Enable one in the portal or with `az apim update` if the block is null.',
        links: [LINKS.apimManagedIdentity],
      },
      {
        id: 'uaa-on-project',
        title: 'Owner or User Access Administrator on the Foundry project',
        detail: 'Creating a role assignment is itself a privileged operation.',
        howTo: 'Check your own assignments with `az role assignment list --assignee <you> --scope <projectId> -o table`.',
        links: [LINKS.azRoleAssignmentCreate],
      },
      {
        id: 'role-available',
        title: 'The role name exists in your tenant',
        detail: '`Foundry Agent Consumer` and `Azure AI User` are built-in, but availability tracks service rollout.',
        howTo: 'List candidates with `az role definition list --query "[?contains(roleName, \'Foundry\')].roleName" -o tsv`.',
        links: [LINKS.foundryRbac],
      },
    ],
    usesProfiles: ['hub', 'foundry'],
    fields: [
      {
        name: 'principalType',
        label: 'Assignee principal type',
        type: 'enum',
        classification: 'sample-default',
        default: 'ServicePrincipal',
        options: [{ value: 'ServicePrincipal', label: 'ServicePrincipal (managed identity)' }],
        help: 'A managed identity is a service principal. Passing the type explicitly avoids a replication race where the object id is not yet visible to Microsoft Entra ID.',
        howToObtain: 'Fixed by the notebook (cell 10).',
        links: [LINKS.azRoleAssignmentCreate],
        notebookRef: 'cell 10 `--assignee-principal-type ServicePrincipal`',
      },
    ],
    configuration: [
      mandatory('hub.subscriptionId', 'Binds every Azure management command in this recipe to the Hub profile subscription.'),
      mandatory('hub.resourceGroupName', 'Scopes the `az apim show` that reads the managed identity block.'),
      mandatory('hub.apimName', 'The API Management service whose identity is granted the Foundry role.'),
      mandatory('foundry.accountName', 'Looked up by name to resolve the account resource id the project scope is built from.'),
      mandatory('foundry.projectName', 'The role is assigned at `<accountId>/projects/<project>`, not at account scope.'),
      optional('foundry.role', 'The built-in data-plane role granted.', 'Falls back to `Foundry Agent Consumer`, the least-privilege option.'),
      generated(
        'foundry.apimIdentityPrincipalId',
        'The object id the assignment is made for.',
        'Left blank, the plan binds it from the identity step at run time instead of hard-coding it.',
        'Produced by this recipe`s own identity step, or by a previous run.',
      ),
      generated(
        'foundry.apimIdentityClientId',
        'Pins the selected user-assigned identity in the later publish contract.',
        'Left blank for a system-assigned identity, or populated from the identity-selection step.',
        'Produced by this recipe`s own identity step, or by a previous run.',
      ),
      generated(
        'foundry.accountResourceId',
        'Composes the project scope without a lookup.',
        'Left blank, the plan binds the scope from the account-lookup step at run time.',
        'Produced by this recipe`s account lookup.',
      ),
      optional(
        'self:principalType',
        'Passed to `--assignee-principal-type` so Entra ID replication delay is not mistaken for a missing principal.',
        'Falls back to `ServicePrincipal`, which is what a managed identity is.',
      ),
    ],
    runtime: {
      dependencies: ['azure-cli'],
      note: 'Four management-plane calls. Creating the assignment needs Owner or User Access Administrator at the project scope.',
    },
    risk: {
      level: 'state-changing',
      effect: 'Creates a role assignment granting a managed identity data-plane access to a Foundry project.',
      blastRadius:
        'One identity gains access to one project. Anything already able to call through that gateway inherits the identity`s reach.',
      reversibility: 'Reversible with `az role assignment delete` at the same scope. This catalogue`s cleanup recipe does not remove it.',
      acknowledgementPrompt:
        'This grants a managed identity standing data-plane access to a Foundry project. Confirm the project is a non-production project you are allowed to grant on.',
    },
    sourceCells: [9, 10],
    sourceNote:
      'Cell 10 reads the APIM identity, resolves the Foundry project id, and creates the role assignment; failures are reported as warnings.',
    expectedResults: [
      {
        id: 'identity-resolved',
        title: 'An APIM identity is resolved',
        assertion:
          'Either a user-assigned identity with both `clientId` and `principalId`, or a system-assigned `principalId`. An empty identity block fails.',
        evidence: 'The `az apim show --query identity` output.',
        whenNotRun: 'Not run — no identity is known, so the grant cannot be made.',
      },
      {
        id: 'project-scope',
        title: 'The project scope resolves',
        assertion: 'The Foundry account id is found by name and the scope ends with `/projects/<project>`.',
        evidence: 'The `az cognitiveservices account list` output.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'role-assigned',
        title: 'The role assignment exists',
        assertion:
          'The assignment is created, or already exists. `az role assignment create` is idempotent in effect: an existing identical assignment is not an error condition for this recipe.',
        evidence: 'The created assignment id, or the pre-existing assignment.',
        whenNotRun: 'Not run — A2A calls through the gateway will fail at Foundry.',
      },
    ],
    deviations: [
      'The notebook treats a failed role assignment as a warning and continues. This recipe reports it as a failure, because every later A2A recipe depends on it.',
      'The notebook does not verify the assignment after creating it. This recipe adds a read-back listing at the same scope so an "already exists" outcome is distinguishable from a silent failure.',
    ],
    notes: [
      'Role assignments are eventually consistent. Allow a minute before concluding that a 403 from a gateway-routed A2A call means the grant did not land.',
      'The client id is only meaningful for a user-assigned identity. With a system-assigned identity, leave `managedIdentityClientId` empty in the publish contract.',
    ],
    build(ctx) {
      const resourceGroup = ctx.get('hub.resourceGroupName');
      const apimName = ctx.get('hub.apimName');
      const accountName = ctx.get('foundry.accountName');
      const projectName = ctx.get('foundry.projectName');
      const role = ctx.get('foundry.role');
      const accountResourceId = ctx.get('foundry.accountResourceId');
      const principalId = ctx.get('foundry.apimIdentityPrincipalId');
      const subscriptionId = ctx.get('hub.subscriptionId');
      const knownScope = foundryProjectResourceId({ accountResourceId, projectName });
      const scope = knownScope || '{{steps.compose-scope.projectScope}}';
      return createExecutionPlan({
        sampleId: 'apim-foundry-grant',
        title: 'Grant the APIM identity Foundry access',
        summary: 'Discover the APIM managed identity, resolve the Foundry project scope, and assign the data-plane role.',
        risk: ctx.risk,
        sourceCells: [9, 10],
        steps: [
          step.cli({
            id: 'read-identity',
            title: 'Read the API Management identity block',
            detail: 'A user-assigned identity is preferred because its client id can be pinned in the publish contract.',
            command: {
              executable: 'az',
              args: [
                'apim',
                'show',
                '-g',
                resourceGroup,
                '-n',
                apimName,
                '--query',
                'identity',
                '--subscription',
                subscriptionId,
                '-o',
                'json',
              ],
            },
            produces: ['identity'],
          }),
          step.assertion({
            id: 'choose-identity',
            title: 'Choose the identity to grant',
            detail: 'User-assigned first, system-assigned as the fallback, and neither is a failure rather than a default.',
            assertion: {
              kind: 'identity-selection',
              source: '{{steps.read-identity.identity}}',
              selectedPrincipalId: principalId,
              selectedClientId: ctx.get('foundry.apimIdentityClientId'),
              expectations: [
                'If `userAssignedIdentities` is non-empty, take the first entry`s `clientId` and `principalId`.',
                'Otherwise take the top-level `principalId` and leave the client id empty.',
                'An identity block that is null or has neither shape fails.',
              ],
            },
            produces: ['principalId', 'clientId'],
          }),
          step.cli({
            id: 'find-account',
            title: 'Resolve the Foundry account resource id',
            detail: 'Looked up by name across the subscription, because the account may sit outside the hub resource group.',
            command: {
              executable: 'az',
              args: [
                'cognitiveservices',
                'account',
                'list',
                '--query',
                `[?name=='${accountName}'].id`,
                '--subscription',
                subscriptionId,
                '-o',
                'tsv',
              ],
            },
            produces: ['accountResourceId'],
          }),
          step.assertion({
            id: 'compose-scope',
            title: 'Compose the project scope',
            detail: 'Role assignment happens at project scope, not account scope.',
            assertion: {
              kind: 'shape',
              source: '{{steps.find-account.accountResourceId}}',
              outputSuffix: `/projects/${projectName}`,
              expectations: [
                'Exactly one account id is returned for the configured account name.',
                `The scope is <accountId>/projects/${projectName || '<project>'}.`,
              ],
            },
            produces: ['projectScope'],
          }),
          step.cli({
            id: 'assign-role',
            title: 'Create the role assignment',
            detail: 'Grants the APIM identity the chosen Foundry role at project scope.',
            command: {
              executable: 'az',
              args: [
                'role',
                'assignment',
                'create',
                '--assignee-object-id',
                principalId || '{{steps.choose-identity.principalId}}',
                '--assignee-principal-type',
                ctx.self('principalType'),
                '--role',
                role,
                '--scope',
                scope,
                '--subscription',
                subscriptionId,
                '-o',
                'json',
              ],
              note: 'Requires Owner or User Access Administrator at the scope. An identical existing assignment is reported as a conflict, not a new grant.',
            },
            produces: ['assignmentId'],
          }),
          step.cli({
            id: 'verify-assignment',
            title: 'Read the assignment back',
            detail:
              'Distinguishes "already existed" from "silently failed", which the notebook cannot do because it only inspects the create call.',
            command: {
              executable: 'az',
              args: [
                'role',
                'assignment',
                'list',
                '--assignee',
                principalId || '{{steps.choose-identity.principalId}}',
                '--scope',
                scope,
                '--query',
                '[].{role:roleDefinitionName, scope:scope}',
                '--subscription',
                subscriptionId,
                '-o',
                'json',
              ],
            },
            produces: ['assignments'],
          }),
          step.assertion({
            id: 'assert-grant',
            title: 'Confirm the grant',
            detail: 'The identity`s client id is recorded for the publish contract.',
            assertion: {
              kind: 'role-assignment',
              source: '{{steps.verify-assignment.assignments}}',
              expectedRole: role,
              expectedScope: scope,
              expectations: [
                `An assignment with role "${role}" exists at the project scope.`,
                'The client id is recorded for `managedIdentityClientId` when a user-assigned identity was used.',
              ],
            },
            produces: ['granted'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'weather-api-ensure',
    group: 'prepare',
    title: 'Ensure the `weather-api` source API exists',
    shortTitle: 'Ensure Weather API',
    summary: 'Create or update the subscription-protected `weather-api` that the Weather Tool is published from.',
    purpose:
      'The Weather Tool is published with `assetType = mcp-from-api`, which turns an existing APIM API into an MCP server. The accelerator only deploys `weather-api` when `isMCPSampleDeployed = true`, so on most hubs it is missing — and a missing source API makes the whole publish-contract deployment fail.',
    explanation: [
      'The API is created from the accelerator`s own spec and mock policy, so no real weather backend is ever called. The policy returns synthetic JSON directly from the inbound section with `return-response`, which is why `service_url` can be a placeholder.',
      'The security shape is the interesting part. The API is created subscription-protected, but it reads its key from the custom header `x-mcp-sub-key` instead of the standard `api-key` / `Ocp-Apim-Subscription-Key` pair. When an `mcp-from-api` server forwards a `tools/call` to its source API internally, APIM strips the standard subscription headers before that hop; a non-standard header survives. The Weather Tool is then published with `forwardSubscriptionKeyToSource: true`, so the MCP policy injects the caller`s contract key into `x-mcp-sub-key`.',
      'The result is that one contract key reaches both the MCP tool and the raw API, and a direct call to `/weather` with no key returns 401 rather than anonymous data. The access contract adds `weather-api` to the same product so a single key authorises both surfaces.',
      'The operation named `get-weather` must exist after the upsert, because the publish contract references it by name in `operationNames`. The notebook lists operations and reports the result, and so does this recipe.',
    ],
    flow: [
      'Read the accelerator`s `openapi.json` and `policy.xml` for the weather sample.',
      'Create or update the API `weather-api` at path `weather`, subscription-required, with the subscription key read from the custom header and query name.',
      'Apply the mock policy as raw XML so the API answers without a backend.',
      'List the API`s operations and confirm `get-weather` is present.',
    ],
    prerequisites: [
      {
        id: 'sample-files',
        title: 'The accelerator sample files are on disk',
        detail:
          'Both `bicep/infra/modules/apim/sample/weather/openapi.json` and `.../policy.xml` are read verbatim. The notebook resolves them relative to `validation/`.',
        howTo: 'Clone the accelerator repository and run from a working directory where those relative paths resolve.',
        links: [LINKS.apimImportOpenApi],
      },
      {
        id: 'python-sdk',
        title: 'The Python management SDK',
        detail:
          '`azure-mgmt-apimanagement` is required. The Azure CLI cannot set a custom `subscriptionKeyParameterNames` header and query name on import, which is the whole point of this step.',
        howTo: 'Install with `pip install azure-mgmt-apimanagement azure-identity`, and sign in so `DefaultAzureCredential` resolves.',
        links: [LINKS.apimPythonSdk],
      },
      {
        id: 'apim-contributor',
        title: 'API Management Service Contributor',
        detail: 'Creating an API and setting an API-scoped policy are management-plane writes.',
        howTo: 'Confirm with `az role assignment list --scope <apimServiceId> --assignee <you> -o table`.',
        links: [LINKS.apimManagedIdentity],
      },
    ],
    usesProfiles: ['hub', 'gatewayAccess'],
    fields: [
      {
        name: 'apiId',
        label: 'API id',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'weather-api',
        help: 'APIM API name. The publish contract references it as `sourceApiName`, so changing it here means changing it there too.',
        howToObtain: 'Fixed by the notebook (cell 12).',
        links: [LINKS.apimImportOpenApi],
        notebookRef: 'cell 12 `weather_api_id`',
      },
      {
        name: 'apiPath',
        label: 'API path',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'weather',
        help: 'URL suffix the API is served under, so the raw API sits at `{gateway}/weather`.',
        howToObtain: 'Fixed by the notebook (cell 12).',
        links: [LINKS.apimImportOpenApi],
        notebookRef: 'cell 12 `path="weather"`',
      },
      {
        name: 'displayName',
        label: 'Display name',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'Weather API',
        help: 'Shown in the APIM portal and in the developer portal.',
        howToObtain: 'Fixed by the notebook (cell 12).',
        links: [LINKS.apimImportOpenApi],
        notebookRef: 'cell 12 `display_name`',
      },
      {
        name: 'operationName',
        label: 'Required operation',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'get-weather',
        help: 'The operation the publish contract exposes as an MCP tool. Its absence is a hard failure.',
        howToObtain: 'Fixed by the accelerator`s `openapi.json` (`operationId: get-weather`).',
        links: [LINKS.apimMcp],
        notebookRef: 'cell 12 operation check',
      },
      {
        name: 'specPath',
        label: 'OpenAPI spec path',
        type: 'string',
        classification: 'sample-default',
        width: 'long',
        default: 'runtime/accelerator/modules/apim/sample/weather/openapi.json',
        help: 'Relative path the notebook reads the spec from. The default is the vendored copy inside `CitadelSamples`.',
        howToObtain: 'Fixed by the notebook (cell 12 `_spec_path`), repointed at `runtime/accelerator`.',
        links: [LINKS.apimImportOpenApi],
        notebookRef: 'cell 12 `_spec_path`',
      },
      {
        name: 'policyPath',
        label: 'Mock policy path',
        type: 'string',
        classification: 'sample-default',
        width: 'long',
        default: 'runtime/accelerator/modules/apim/sample/weather/policy.xml',
        help: 'Relative path the notebook reads the mock policy from. The default is the vendored copy inside `CitadelSamples`.',
        howToObtain: 'Fixed by the notebook (cell 12 `_policy_path`), repointed at `runtime/accelerator`.',
        links: [LINKS.apimImportOpenApi],
        notebookRef: 'cell 12 `_policy_path`',
      },
    ],
    configuration: [
      mandatory('hub.subscriptionId', 'Selects the Azure subscription used to construct the API Management SDK client.'),
      mandatory('hub.resourceGroupName', 'Names the resource group in the management SDK call that upserts the API.'),
      mandatory('hub.apimName', 'The API Management service the `weather-api` is created on.'),
      optional(
        'gatewayAccess.weatherSourceKeyHeader',
        'Set as both the header and query subscription-key name so the forwarded key survives the internal tools/call hop.',
        'Falls back to `x-mcp-sub-key`, which is what the publish contract forwards.',
      ),
      optional('self:apiId', 'The API id created or overwritten.', 'Falls back to `weather-api`, the id the publish contract references.'),
      optional('self:apiPath', 'Gateway path the API is served at.', 'Falls back to `weather`.'),
      optional('self:displayName', 'Display name shown in the portal.', 'Falls back to `Weather API`.'),
      optional('self:operationName', 'The operation whose presence is asserted afterwards.', 'Falls back to `get-weather`.'),
      optional(
        'self:specPath',
        'OpenAPI document imported as the API definition.',
        'Falls back to the vendored copy under `runtime/accelerator`, which ships with this playground.',
      ),
      optional(
        'self:policyPath',
        'Mock-response policy applied at API scope so no real weather backend is called.',
        'Falls back to the vendored copy under `runtime/accelerator`.',
      ),
    ],
    runtime: {
      dependencies: ['azure-cli', 'python', 'accelerator'],
      python: {
        packages: ['azure-mgmt-apimanagement', 'azure-identity'],
        modules: ['azure.mgmt.apimanagement', 'azure.identity'],
        install: 'pip install azure-mgmt-apimanagement azure-identity',
      },
      note: 'The custom subscription-key header cannot be set through `az apim api import`, so the Python management SDK is required.',
    },
    risk: {
      level: 'state-changing',
      effect:
        'Creates or overwrites the `weather-api` API and replaces its API-scoped policy. An existing API with the same id is overwritten, not merged.',
      blastRadius: 'One API on the gateway, plus anything already calling `{gateway}/weather`.',
      reversibility: 'Removable with `az apim api delete`. The catalogue`s cleanup recipe does not remove it.',
      acknowledgementPrompt:
        'This creates or overwrites `weather-api` and replaces its policy on a live gateway. Confirm the gateway is a non-production gateway you are allowed to change.',
    },
    sourceCells: [11, 12],
    sourceNote:
      'Cell 12 upserts the API with a custom subscription key header, applies the mock policy as raw XML, and lists operations to confirm `get-weather` exists.',
    expectedResults: [
      {
        id: 'api-upserted',
        title: 'The API exists at the expected path',
        assertion: '`weather-api` exists, is served at path `weather`, is https-only and requires a subscription.',
        evidence: 'The create-or-update result.',
        whenNotRun: 'Not run — the publish contract will fail if the source API is missing.',
      },
      {
        id: 'custom-key-header',
        title: 'The key is read from the custom header',
        assertion:
          '`subscriptionKeyParameterNames.header` and `.query` are both the configured custom name, so the forwarded key survives the internal tools/call hop.',
        evidence: 'The API`s `subscriptionKeyParameterNames`.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'operation-present',
        title: '`get-weather` is present',
        assertion: 'The API operation list contains `get-weather`.',
        evidence: 'The operation listing.',
        whenNotRun: 'Not run — the publish contract`s `operationNames` reference would not resolve.',
      },
      {
        id: 'no-anonymous-access',
        title: 'Direct anonymous access is refused',
        assertion:
          'A GET to `{gateway}/weather?city=London` with no key returns 401. This is the point of keeping the API subscription-protected.',
        evidence: 'A manual unauthenticated call.',
        whenNotRun: 'Not run — this recipe does not perform the negative check itself.',
      },
    ],
    deviations: [
      'The notebook prints the operation list with a success marker but does not stop when `get-weather` is missing. This recipe treats a missing operation as a failure.',
      'The negative check — that an unauthenticated call returns 401 — is stated as an expected result but is not executed by any notebook cell, so no recipe here claims to have proved it.',
    ],
    notes: [
      'The mock policy returns Fahrenheit for Seattle, New York City and Los Angeles, and Celsius for everything else. That branch is what the Weather tools/call recipe asserts against.',
      'This is a Python-SDK step. The default executor cannot run `library` steps, so it will report `blocked` rather than pretending to have run.',
    ],
    build(ctx) {
      const resourceGroup = ctx.get('hub.resourceGroupName');
      const apimName = ctx.get('hub.apimName');
      const apiId = ctx.self('apiId');
      const apiPath = ctx.self('apiPath');
      const displayName = ctx.self('displayName');
      const keyHeader = ctx.get('gatewayAccess.weatherSourceKeyHeader');
      const specPath = ctx.self('specPath');
      const policyPath = ctx.self('policyPath');
      const operationName = ctx.self('operationName');
      const code = [
        'from azure.mgmt.apimanagement.models import (',
        '    ApiCreateOrUpdateParameter, PolicyContract, SubscriptionKeyParameterNamesContract)',
        '',
        `_rg, _svc = ${JSON.stringify(resourceGroup)}, ${JSON.stringify(apimName)}`,
        `weather_api_id = ${JSON.stringify(apiId)}`,
        `weather_source_key_header = ${JSON.stringify(keyHeader)}`,
        '',
        `with open(${JSON.stringify(specPath)}, "r", encoding="utf-8") as f:`,
        '    _spec = f.read()',
        `with open(${JSON.stringify(policyPath)}, "r", encoding="utf-8") as f:`,
        '    _policy = f.read()',
        '',
        '_client.api.begin_create_or_update(_rg, _svc, weather_api_id, ApiCreateOrUpdateParameter(',
        `    path=${JSON.stringify(apiPath)},`,
        `    display_name=${JSON.stringify(displayName)},`,
        '    description="Weather API for getting dynamic weather information for a given location.",',
        '    format="openapi+json",',
        '    value=_spec,',
        '    protocols=["https"],',
        '    subscription_required=True,',
        '    subscription_key_parameter_names=SubscriptionKeyParameterNamesContract(',
        '        header=weather_source_key_header, query=weather_source_key_header),',
        '    service_url="https://to-be-replaced-by-policy",',
        ')).result()',
        '',
        '_client.api_policy.create_or_update(_rg, _svc, weather_api_id, "policy",',
        '                                    PolicyContract(value=_policy, format="rawxml"))',
      ].join('\n');
      return createExecutionPlan({
        sampleId: 'weather-api-ensure',
        title: 'Ensure the `weather-api` source API exists',
        summary: 'Upsert the subscription-protected weather API and its mock policy, then confirm `get-weather` exists.',
        risk: ctx.risk,
        sourceCells: [11, 12],
        steps: [
          step.library({
            id: 'upsert-api',
            title: 'Create or update `weather-api` with the mock policy',
            detail: 'Uses the Python management SDK because the custom subscription key header cannot be set through `az apim api import`.',
            library: {
              runtime: 'python>=3.10',
              packages: ['azure-mgmt-apimanagement', 'azure-identity'],
              install: 'pip install azure-mgmt-apimanagement azure-identity',
              entry: 'ApiManagementClient.api.begin_create_or_update + api_policy.create_or_update',
              code,
            },
            produces: ['apiId'],
          }),
          step.library({
            id: 'list-operations',
            title: 'List the API`s operations',
            detail: 'The publish contract references the operation by name, so its presence is not optional.',
            library: {
              runtime: 'python>=3.10',
              packages: ['azure-mgmt-apimanagement'],
              entry: 'ApiManagementClient.api_operation.list_by_api',
              code: `_ops = [o.name for o in _client.api_operation.list_by_api(_rg, _svc, ${JSON.stringify(apiId)})]\nprint(_ops)`,
            },
            produces: ['operationNames'],
          }),
          step.assertion({
            id: 'assert-operation',
            title: `Confirm \`${operationName}\` is present`,
            detail: 'Missing operation is a hard failure, not a warning.',
            assertion: {
              kind: 'contains',
              source: '{{steps.list-operations.operationNames}}',
              expected: operationName,
              expectations: [
                `The operation list contains \`${operationName}\`.`,
                `The API requires a subscription and reads its key from \`${keyHeader}\`.`,
              ],
            },
            produces: ['ready'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },
];
