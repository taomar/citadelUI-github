/**
 * Lifecycle — cell 35.
 *
 * One destructive recipe. Its most useful output is not what it deletes but
 * what it names as left behind: the notebook's cleanup is partial, and the
 * residue is exactly the set of things that cost money or grant access.
 */

import { step, createExecutionPlan } from '../../core/plan.mjs';
import { conditional, guard, mandatory, optional } from '../requirements.mjs';
import { LINKS } from '../profiles.mjs';
import { buildPublishAssets, classifyContract } from './publish.mjs';

/** Machine forms of the two deletion switches, used by the contract below. */
const WHEN_DELETING_CONTRACT = { field: 'samples.cleanup.deleteAccessContract', equals: true };
const WHEN_DELETING_ASSETS = { field: 'samples.cleanup.deletePublishedAssets', equals: true };
const ANY_DELETION = { any: [WHEN_DELETING_CONTRACT, WHEN_DELETING_ASSETS] };

/** Everything the notebook's cleanup does not remove, and where it came from. */
export const CLEANUP_RESIDUE = Object.freeze([
  Object.freeze({
    id: 'weather-api',
    item: 'The `weather-api` source API',
    origin: 'Created by Prepare › Ensure the `weather-api` source API exists (cell 12).',
    consequence:
      'It stays on the gateway, subscription-protected, with its mock policy. Harmless but not free of clutter, and it keeps the custom key header configured.',
    removal: 'az apim api delete -g <rg> -n <apim> --api-id weather-api --yes',
    links: [LINKS.apimDeleteApi],
  }),
  Object.freeze({
    id: 'role-assignment',
    item: 'The Foundry role assignment for the APIM identity',
    origin: 'Created by Prepare › Grant the APIM identity Foundry access (cell 10).',
    consequence:
      'The gateway identity keeps standing data-plane access to the Foundry project after every published asset is gone. This is the residue that matters most.',
    removal: 'az role assignment delete --assignee-object-id <principalId> --role "<role>" --scope <projectScope>',
    links: [LINKS.azRoleAssignmentCreate],
  }),
  Object.freeze({
    id: 'a2a-enablement',
    item: 'The A2A protocol configuration on the Foundry agent',
    origin: 'Set by Prepare › Enable incoming A2A on the Foundry agent (cell 8).',
    consequence:
      'The agent keeps its rewritten agent card and its A2A endpoint enabled, reachable by anyone who can reach Foundry directly.',
    removal: 'PATCH the agent again with the previous agent card and protocol configuration. The original card is not saved anywhere.',
    links: [LINKS.foundryA2a],
  }),
  Object.freeze({
    id: 'kv-secrets',
    item: 'The Key Vault api-key and endpoint secrets',
    origin: 'Written by Publish and grant › Deploy the mixed access contract (cell 17).',
    consequence:
      'The shared key remains readable in the vault after the APIM subscription is deleted, so the secret outlives the credential it describes.',
    removal: 'az keyvault secret delete --vault-name <vault> --name <secret>, then purge if soft-delete is on.',
    links: [LINKS.azKeyVaultSecretShow],
  }),
  Object.freeze({
    id: 'contract-files',
    item: 'The generated contract files on disk',
    origin:
      'Written by the publish contract (cell 14) and the access contract (cell 17): two `main.bicepparam` files and one `ai-product-policy.xml`.',
    consequence: 'They stay in the source tree and will be committed unless removed, including the resolved subscription id.',
    removal: 'Delete the generated `contracts/<name>/<env>/` folders, or commit them deliberately.',
    links: [LINKS.bicepParamFiles],
  }),
  Object.freeze({
    id: 'telemetry',
    item: 'Application Insights usage metrics',
    origin: 'Emitted by the baseline policies on every call made by the Exercise and Policy recipes (cell 24 reads them).',
    consequence: 'Telemetry stays for the workspace retention period. It cannot be selectively removed.',
    removal: 'None. Retention is a workspace-level setting.',
    links: [LINKS.monitorIngestionTime],
  }),
  Object.freeze({
    id: 'deployment-history',
    item: 'Subscription-scope deployment history',
    origin: 'Created by both `az deployment sub create` calls (cells 15 and 17).',
    consequence:
      'Entries remain in the subscription`s deployment history and count against the 800-deployment limit until Azure prunes them.',
    removal: 'az deployment sub delete --name <deploymentName>',
    links: [LINKS.deploymentHistory],
  }),
]);

export const LIFECYCLE_SAMPLES = [
  {
    id: 'cleanup',
    group: 'lifecycle',
    title: 'Cleanup',
    shortTitle: 'Cleanup',
    summary: 'Remove the access contract and the published assets, and report exactly what is left behind.',
    purpose:
      'Undo what the run created, and be honest about what undoing does not reach. Both deletions are opt-in and default to off, so running this recipe with default settings deletes nothing and simply reports the state.',
    explanation: [
      'Two independent switches. `delete_access_contract` removes the APIM subscription and the product, which revokes the minted key. `delete_published_assets` removes each published API and the backends belonging to the remote MCP and A2A assets. Both default to off in the notebook, and both default to off here.',
      'Deletion order matters. The subscription is deleted before the product, and the product is deleted with `delete_subscriptions=True` as a belt-and-braces measure. Deleting the product first can leave an orphaned subscription that still authorises calls.',
      'The notebook`s cleanup has a structural gap worth knowing about before you rely on it: it references `client`, `rg`, `svc`, `sub_id` and `test_product_id`, all of which are defined only in cell 17. Running the cleanup cell in a kernel where the access contract cell never ran raises `NameError` rather than cleaning anything up.',
      'The larger gap is what it does not attempt. The source API, the Foundry role assignment, the agent`s A2A enablement, the Key Vault secrets, the generated files, the telemetry and the deployment history all survive. The role assignment in particular means the gateway identity keeps standing access to the Foundry project long after every asset is gone. Those items are listed below with the command that would actually remove each one.',
      'Each deletion is reported on its own. A single pass/fail roll-up would hide the common case where the product deletes cleanly and one API does not.',
    ],
    flow: [
      'Confirm the target gateway is not production.',
      'Optionally delete the APIM subscription, then the product, revoking the minted key.',
      'Optionally delete each published API, and the backends belonging to remote MCP and A2A assets.',
      'Report every deletion outcome independently.',
      'List everything that was not removed, with the command that would remove it.',
    ],
    prerequisites: [
      {
        id: 'know-what-exists',
        title: 'Know what the run actually created',
        detail: 'Cleanup targets names, so a mistyped product id silently deletes nothing while reporting success on the others.',
        howTo: 'Take the product id and subscription name from the access-contract outputs, and the asset names from the publish outputs.',
        links: [LINKS.apimProduct],
      },
      {
        id: 'contributor',
        title: 'API Management Service Contributor',
        detail: 'Deleting products, subscriptions, APIs and backends are management-plane writes.',
        howTo: 'Confirm your role at the APIM service scope.',
        links: [LINKS.apimDeleteApi],
      },
      {
        id: 'nothing-depends',
        title: 'Nothing else depends on the key or the assets',
        detail: 'Deleting the product revokes the shared key for every consumer holding it, not just for this run.',
        howTo: 'Check the product`s subscriptions in the APIM portal before deleting.',
        links: [LINKS.apimSubscriptions],
      },
    ],
    usesProfiles: ['hub', 'gatewayAccess', 'foundry', 'keyVault', 'policy'],
    fields: [
      {
        name: 'confirmNonProduction',
        label: 'This gateway is not production',
        type: 'boolean',
        classification: 'required',
        default: false,
        mustEqual: true,
        mustEqualMessage:
          'Confirm the target gateway is a non-production environment before generating a cleanup plan. Deleting a product revokes the key for every consumer holding it.',
        help: 'Deletion is not reversible from here. The product, its subscriptions and the published APIs are removed outright.',
        howToObtain: 'Only you can confirm this.',
        links: [LINKS.apimProduct],
        notebookRef: 'no notebook equivalent — the notebook deletes without confirmation',
      },
      {
        name: 'deleteAccessContract',
        label: 'Delete the access contract',
        type: 'boolean',
        classification: 'sample-default',
        default: false,
        help: 'Removes the APIM subscription and the product, revoking the minted api-key. Off by default, as in the notebook.',
        howToObtain: 'Fixed by the notebook (cell 35 `delete_access_contract = False`).',
        links: [LINKS.apimProduct],
        notebookRef: 'cell 35 `delete_access_contract`',
      },
      {
        name: 'deletePublishedAssets',
        label: 'Delete the published assets',
        type: 'boolean',
        classification: 'sample-default',
        default: false,
        help: 'Removes each published API and the backends belonging to the remote MCP and A2A assets. Off by default, as in the notebook.',
        howToObtain: 'Fixed by the notebook (cell 35 `delete_published_assets = False`).',
        links: [LINKS.apimDeleteApi],
        notebookRef: 'cell 35 `delete_published_assets`',
      },
      {
        name: 'deleteWeatherSourceApi',
        label: 'Also delete the `weather-api` source API',
        type: 'boolean',
        classification: 'sample-default',
        default: false,
        help: 'Beyond the notebook. The notebook creates `weather-api` in cell 12 and never removes it.',
        howToObtain: 'Turn on to close that gap. It does not affect the other published assets.',
        links: [LINKS.apimDeleteApi],
        notebookRef: 'gap — cell 12 creates it, cell 35 does not remove it',
      },
    ],
    configuration: [
      guard(
        'self:confirmNonProduction',
        'A hard precondition, checked before any deletion is composed. The executor re-checks it server-side and refuses the run when it is not true.',
      ),
      mandatory('hub.resourceGroupName', 'Named in the target summary and in every deletion this recipe can compose.'),
      mandatory('hub.apimName', 'The API Management service the product, subscription, APIs and backends would be deleted from.'),
      optional('self:deleteAccessContract', 'Whether the product and its subscription are deleted.', 'Falls back to off: nothing is deleted.'),
      optional('self:deletePublishedAssets', 'Whether the published APIs and their backends are deleted.', 'Falls back to off.'),
      optional('self:deleteWeatherSourceApi', 'Whether the `weather-api` source API is deleted.', 'Falls back to off, matching the notebook`s gap.'),
      conditional(
        'hub.subscriptionId',
        'Binds every deletion explicitly and supplies the first segment of each ARM resource URI.',
        'A deletion switch is on.',
        ANY_DELETION,
      ),
      conditional(
        'foundry.enableA2aAsset',
        'Decides whether an agent asset is in the delete set and whether the contract classified as MULTI.',
        'A deletion switch is on.',
        ANY_DELETION,
      ),
      conditional(
        'publish-assets:weatherToolName',
        'The API id deleted for the Weather tool.',
        'Delete the published assets is on.',
        WHEN_DELETING_ASSETS,
      ),
      conditional(
        'publish-assets:learnToolName',
        'The API id and backend id deleted for the Learn tool.',
        'Delete the published assets is on.',
        WHEN_DELETING_ASSETS,
      ),
      conditional(
        'publish-assets:agentAssetName',
        'The API id and backend id deleted for the agent.',
        'Delete the published assets is on.',
        WHEN_DELETING_ASSETS,
      ),
      conditional(
        'policy.candidateLlmApis',
        'Feeds the same classification the access contract used, so the product id deleted here is the one that was created.',
        'Delete the access contract is on.',
        WHEN_DELETING_CONTRACT,
      ),
      conditional(
        'policy.businessUnit',
        'First segment of the product id being deleted.',
        'Delete the access contract is on.',
        WHEN_DELETING_CONTRACT,
      ),
      conditional(
        'policy.useCaseName',
        'Second segment of the product id being deleted.',
        'Delete the access contract is on.',
        WHEN_DELETING_CONTRACT,
      ),
      conditional(
        'policy.environment',
        'Third segment of the product id being deleted.',
        'Delete the access contract is on.',
        WHEN_DELETING_CONTRACT,
      ),
      conditional(
        'access-contract-deploy:existingLlmApis',
        'Which LLM APIs the contract found. It changes the contract code and therefore the product id being deleted.',
        'Delete the access contract is on.',
        WHEN_DELETING_CONTRACT,
      ),
    ],
    runtime: {
      dependencies: ['azure-cli'],
      note: 'With every switch off the plan contains no deletion at all and only the residue report runs.',
    },
    risk: {
      level: 'destructive',
      effect:
        'Deletes an APIM product, its subscriptions and the published APIs and backends. Deleting the product revokes the shared api-key for every consumer holding it.',
      blastRadius:
        'Every consumer of the product, and every client calling the published assets. Deletion is immediate and not undone by re-running an earlier recipe.',
      reversibility:
        'Not reversible from here. Re-deploying the publish and access contracts recreates the assets, but the api-key is newly minted and every existing client must be updated.',
      acknowledgementPrompt:
        'This permanently deletes an API Management product, its subscriptions and the published APIs, revoking the shared api-key for every consumer holding it. Confirm this is a non-production environment and that nothing depends on these resources.',
    },
    sourceCells: [34, 35],
    sourceNote:
      'Cell 35 optionally deletes the subscription and product, then optionally deletes each published API and the backends for `mcp-existing` and `a2a` assets, catching and warning on every failure.',
    expectedResults: [
      {
        id: 'per-deletion',
        title: 'Every deletion is reported independently',
        assertion:
          'One outcome per target: subscription, product, each API and each backend. A partial failure is visible per item rather than folded into one result.',
        evidence: 'The per-step outcomes.',
        whenNotRun: 'Not run — nothing is deleted and nothing is claimed.',
      },
      {
        id: 'key-revoked',
        title: 'The key is revoked when the contract is deleted',
        assertion: 'After the product is deleted, a call presenting the old api-key returns 401.',
        evidence: 'A follow-up call with the old key.',
        whenNotRun: 'Not run — the key remains valid.',
      },
      {
        id: 'residue-listed',
        title: 'Everything left behind is named',
        assertion:
          'The seven residual items are listed with their origin and the command that would remove each one, whether or not any deletion ran.',
        evidence: 'The residue report.',
        whenNotRun: 'Still reported — the residue list does not depend on running anything.',
      },
      {
        id: 'defaults-delete-nothing',
        title: 'Default settings delete nothing',
        assertion: 'With both switches off, this recipe performs no deletion and simply reports state.',
        evidence: 'The generated plan holds no delete step.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'The notebook`s cleanup cell references `client`, `rg`, `svc`, `sub_id` and `test_product_id`, which are defined only in cell 17. Running it without having run the access-contract cell raises `NameError` instead of cleaning up.',
      'The notebook catches every exception and reports a warning, so a failed deletion reads as an inconvenience. This recipe reports each deletion independently and treats a failure as a failure.',
      'The notebook does not remove the `weather-api` it created in cell 12. This recipe offers an explicit opt-in and lists it as residue when the opt-in is off.',
      'The notebook does not remove the Foundry role assignment, the agent`s A2A enablement, the Key Vault secrets, the generated files, the telemetry or the deployment history, and does not mention them. This recipe lists all of them with removal commands.',
    ],
    notes: [
      'With both deletion switches off — the default — the generated plan contains no delete step at all. It still reports the residue, which is the part most worth reading.',
      'The residue list is static metadata, so it is accurate even when nothing has been run and no executor is attached.',
    ],
    build(ctx) {
      const subscriptionId = ctx.get('hub.subscriptionId');
      const rg = ctx.get('hub.resourceGroupName');
      const apim = ctx.get('hub.apimName');
      const assets = buildPublishAssets(ctx);
      const contract = classifyContract(ctx, assets);
      const steps = [
        step.assertion({
          id: 'confirm-target',
          title: 'Confirm the target is not production',
          detail: 'Checked before any deletion is composed.',
          assertion: {
            kind: 'guard',
            source: 'inputs.confirmNonProduction',
            expectations: [
              'The non-production confirmation is checked.',
              'The per-run acknowledgement has been given for this exact configuration.',
              `Target gateway: ${apim || '(not yet discovered)'} in ${rg || '(resource group not set)'}.`,
              `Access contract deletion: ${ctx.self('deleteAccessContract') ? 'ON' : 'off'}. Published asset deletion: ${ctx.self('deletePublishedAssets') ? 'ON' : 'off'}.`,
            ],
          },
          produces: ['confirmed'],
        }),
      ];

      if (ctx.self('deleteAccessContract')) {
        steps.push(
          step.cli({
            id: 'delete-subscription',
            title: `Delete the APIM subscription ${contract.subscriptionName}`,
            detail: 'Deleted before the product so no orphaned subscription can keep authorising calls.',
            command: {
              executable: 'az',
              args: [
                'rest',
                '--method',
                'delete',
                '--uri',
                `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ApiManagement/service/${apim}/subscriptions/${contract.subscriptionName}?api-version=2022-08-01`,
                '--subscription',
                subscriptionId,
                '--headers',
                'If-Match=*',
              ],
              note: 'Equivalent to the notebook`s `client.subscription.delete(..., if_match="*")`.',
            },
            produces: ['subscriptionDeleted'],
          }),
          step.cli({
            id: 'delete-product',
            title: `Delete the product ${contract.productId}`,
            detail: '`deleteSubscriptions=true` removes any subscription that survived the previous step.',
            command: {
              executable: 'az',
              args: [
                'apim',
                'product',
                'delete',
                '-g',
                rg,
                '-n',
                apim,
                '--product-id',
                contract.productId,
                '--delete-subscriptions',
                'true',
                '--subscription',
                subscriptionId,
                '--yes',
              ],
              note: 'Revokes the shared api-key for every consumer holding it.',
            },
            produces: ['productDeleted'],
          }),
        );
      }

      if (ctx.self('deletePublishedAssets')) {
        for (const [index, asset] of assets.entries()) {
          steps.push(
            step.cli({
              id: `delete-api-${index + 1}`,
              title: `Delete the API ${asset.name}`,
              detail: `Published as \`${asset.assetType}\`.`,
              command: {
                executable: 'az',
                args: [
                  'apim',
                  'api',
                  'delete',
                  '-g',
                  rg,
                  '-n',
                  apim,
                  '--api-id',
                  asset.name,
                  '--subscription',
                  subscriptionId,
                  '--yes',
                ],
              },
              produces: ['apiDeleted'],
            }),
          );
          if (asset.assetType === 'mcp-existing' || asset.assetType === 'a2a') {
            steps.push(
              step.cli({
                id: `delete-backend-${index + 1}`,
                title: `Delete the backend ${asset.name}-backend`,
                detail: 'Only `mcp-existing` and `a2a` assets create a backend of their own.',
                command: {
                  executable: 'az',
                  args: [
                    'rest',
                    '--method',
                    'delete',
                    '--uri',
                    `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ApiManagement/service/${apim}/backends/${asset.name}-backend?api-version=2022-08-01`,
                    '--subscription',
                    subscriptionId,
                    '--headers',
                    'If-Match=*',
                  ],
                  note: 'The notebook swallows failures here; this reports them.',
                },
                produces: ['backendDeleted'],
              }),
            );
          }
        }
      }

      if (ctx.self('deleteWeatherSourceApi')) {
        steps.push(
          step.cli({
            id: 'delete-source-api',
            title: 'Delete the `weather-api` source API',
            detail: 'Beyond the notebook: it creates this API in cell 12 and never removes it.',
            command: {
              executable: 'az',
              args: [
                'apim',
                'api',
                'delete',
                '-g',
                rg,
                '-n',
                apim,
                '--api-id',
                'weather-api',
                '--subscription',
                subscriptionId,
                '--yes',
              ],
            },
            produces: ['sourceApiDeleted'],
          }),
        );
      }

      const residue = CLEANUP_RESIDUE.filter(
        (item) => !(item.id === 'weather-api' && ctx.self('deleteWeatherSourceApi')),
      );

      steps.push(
        step.assertion({
          id: 'report-deletions',
          title: 'Report each deletion independently',
          detail: 'No single roll-up: a partial failure has to stay visible.',
          assertion: {
            kind: 'per-item',
            source: 'steps.*.deleted',
            expectations:
              steps.filter((planStep) => planStep.type === 'azure-cli').length > 0
                ? steps
                    .filter((planStep) => planStep.type === 'azure-cli')
                    .map((planStep) => `${planStep.title}: reported on its own.`)
                : ['Both deletion switches are off, so no deletion is attempted and none is claimed.'],
          },
          produces: ['deletionReport'],
        }),
        step.assertion({
          id: 'report-residue',
          title: 'List what cleanup does not remove',
          detail: 'Static metadata, so it is accurate even when nothing was run.',
          assertion: {
            kind: 'residue',
            source: 'catalogue.cleanupResidue',
            expectations: residue.map((item) => `${item.item} — ${item.origin} Remove with: ${item.removal}`),
            residue: residue.map((item) => ({ id: item.id, item: item.item, removal: item.removal })),
          },
          produces: ['residueReport'],
        }),
      );

      return createExecutionPlan({
        sampleId: 'cleanup',
        title: 'Cleanup',
        summary:
          ctx.self('deleteAccessContract') || ctx.self('deletePublishedAssets') || ctx.self('deleteWeatherSourceApi')
            ? 'Delete the selected resources and report both the deletions and the residue.'
            : 'Both deletion switches are off: nothing is deleted, and the residue is reported.',
        risk: ctx.risk,
        sourceCells: [34, 35],
        steps,
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },
];
