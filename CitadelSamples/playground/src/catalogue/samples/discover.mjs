/**
 * Discover — cells 4 and 6.
 *
 * Two read-only recipes that establish which subscription and which gateway
 * every later recipe will act on.
 */

import { step, createExecutionPlan } from '../../core/plan.mjs';
import { mandatory, optional } from '../requirements.mjs';
import { LINKS } from '../profiles.mjs';

export const DISCOVER_SAMPLES = [
  {
    id: 'azure-context-check',
    group: 'discover',
    title: 'Azure context check',
    shortTitle: 'Azure context',
    summary: 'Confirm the Citadel private Azure CLI session is signed in and pointed at the subscription this run expects.',
    purpose:
      'Every other recipe in this catalogue either deploys at subscription scope or reads management-plane resources. Those commands are bound explicitly to the Hub profile subscription, while this recipe separately confirms that the signed-in principal and active context are the ones the operator expects.',
    explanation: [
      'The notebook calls `az account show` and prints the signed-in user and the active subscription id. When `subscription_id` was left as `REPLACE`, it adopts whatever the CLI is using; when the two differ, it prints a warning telling you to run `az account set`.',
      'That warning is the only guard the notebook has. The playground additionally passes the validated Hub profile subscription to every later management command, so an active-context mismatch cannot silently retarget those operations. Treat the mismatch as a stop anyway: it can still reveal an unintended principal or tenant.',
      'This recipe stays read-only. It reports the mismatch and shows you the exact `az account set` command, but it does not change your CLI context for you, because doing so silently would defeat the purpose of the check.',
    ],
    flow: [
      'Read the active Azure CLI account with `az account show`.',
      'Report the signed-in user, the active subscription id and the active tenant.',
      'Compare the active subscription id with the Subscription ID in the Hub profile.',
      'Pass when they match; report the `az account set` remediation when they do not.',
    ],
    prerequisites: [
      {
        id: 'cli-installed',
        title: 'Azure CLI installed',
        detail: 'Version 2.60 or newer. Older versions lack some of the `az apim` and `az monitor app-insights` behaviour later recipes rely on.',
        howTo: 'Install from the Microsoft installation guide, then run `az version` to confirm.',
        links: [{ label: 'Install the Azure CLI', href: 'https://learn.microsoft.com/en-us/cli/azure/install-azure-cli' }],
      },
      {
        id: 'signed-in',
        title: 'Signed in',
        detail: 'An interactive or service-principal sign-in with access to the hub subscription.',
        howTo: 'Start the playground with system sign-in enabled, then use **Sign in with Microsoft** for this launch.',
        links: [LINKS.azLogin],
      },
    ],
    usesProfiles: ['hub'],
    fields: [],
    configuration: [
      mandatory(
        'hub.subscriptionId',
        'The value the active CLI subscription is compared with. Without it there is nothing to check against and the recipe cannot report a mismatch.',
      ),
    ],
    runtime: {
      dependencies: ['azure-cli'],
      note: 'Reads this launch-private Azure CLI profile only. No network call to Azure is made by this recipe.',
    },
    risk: {
      level: 'read-only',
      effect: 'Reads the Citadel private Azure CLI profile. Nothing in Azure is created, changed or deleted.',
      blastRadius: 'None.',
      reversibility: 'Not applicable.',
    },
    sourceCells: [3, 4],
    sourceNote: 'Cell 4 runs `az account show`, adopts the active subscription when the configured one is unset, and warns on a mismatch.',
    expectedResults: [
      {
        id: 'account-readable',
        title: 'The CLI reports an account',
        assertion: '`az account show` exits 0 and returns JSON containing `id`, `name` and `user.name`.',
        evidence: 'The command output.',
        whenNotRun: 'Not run — sign-in state is unknown.',
      },
      {
        id: 'subscription-matches',
        title: 'Active subscription matches the Hub profile',
        assertion: 'The `id` returned equals the Subscription ID in the Hub profile.',
        evidence: 'Comparison of the two values.',
        whenNotRun: 'Not run — the mismatch check is inconclusive.',
      },
    ],
    deviations: [
      'The notebook adopts the active subscription when the configured one is blank. This recipe requires the Hub profile to be filled in first, so a mismatch is always reported rather than quietly absorbed.',
    ],
    notes: [
      'Later management commands pass `--subscription` explicitly. This check still proves which principal and tenant the CLI will use before those commands run.',
    ],
    build(ctx) {
      const subscriptionId = ctx.get('hub.subscriptionId');
      return createExecutionPlan({
        sampleId: 'azure-context-check',
        title: 'Azure context check',
        summary: 'Read the active Azure CLI context and compare it with the Hub profile.',
        risk: ctx.risk,
        sourceCells: [3, 4],
        steps: [
          step.cli({
            id: 'account-show',
            title: 'Read the active Azure CLI account',
            detail: 'Mirrors the notebook`s `utils.run("az account show")`.',
            command: {
              executable: 'az',
              args: ['account', 'show', '-o', 'json'],
            },
            produces: ['subscriptionId', 'subscriptionName', 'userName', 'tenantId'],
          }),
          step.assertion({
            id: 'assert-context',
            title: 'Compare the active subscription with the Hub profile',
            detail: 'A mismatch is a stop, not a note: subscription-scoped deployments follow the CLI context.',
            assertion: {
              kind: 'equals',
              source: '{{steps.account-show.subscriptionId}}',
              expected: subscriptionId,
              expectations: [
                '`az account show` exited 0 and returned a JSON object.',
                `The active subscription id equals ${subscriptionId || '(the Hub profile subscription id)'}.`,
                'The signed-in principal is the one you intend to deploy with.',
              ],
              remediation: `az account set --subscription ${subscriptionId || '<subscriptionId>'}`,
            },
            produces: ['contextOk'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'apim-discovery',
    group: 'discover',
    title: 'API Management discovery',
    shortTitle: 'APIM discovery',
    summary: 'Find the API Management service in the hub resource group and capture its gateway URL.',
    purpose:
      'The gateway URL is the base for every published asset endpoint, and the APIM service name is named by every management call in this catalogue. This recipe resolves both, and refuses to guess when the resource group holds more than one service.',
    explanation: [
      'The notebook constructs `APIMClientTool(governance_hub_resource_group)` and calls `initialize()`, which discovers the deployed instance and exposes `apim_resource_name` and `apim_resource_gateway_url`.',
      'That helper resolves a single instance from the resource group. If a resource group happens to hold two API Management services — a hub and a spoke, or a service left over from an earlier deployment — silently taking the first one would point every later recipe at the wrong gateway, and every failure after that would look like a publishing problem rather than a targeting problem.',
      'This recipe therefore lists the services first and stops when the count is not exactly one, asking you to name the service explicitly. Only then does it read the gateway URL. Use the custom domain if your hub has one, because the endpoints the publish contract returns follow the gateway host APIM reports.',
    ],
    flow: [
      'List every API Management service in the hub resource group.',
      'Stop and ask for an explicit name when the list holds zero or more than one service.',
      'Read the chosen service`s gateway URL, SKU and location.',
      'Record the service name and gateway URL into the Hub profile for later recipes.',
    ],
    prerequisites: [
      {
        id: 'reader-on-rg',
        title: 'Reader on the hub resource group',
        detail: 'Listing and showing API Management services needs read access on the resource group.',
        howTo: 'Confirm with `az apim list -g <rg> -o table`. An empty list with exit code 0 means the group has no APIM, not that you lack access.',
        links: [LINKS.azApimList],
      },
      {
        id: 'hub-deployed',
        title: 'The Citadel Governance Hub is deployed',
        detail: 'The catalogue assumes an existing hub: API Management, Application Insights, Cosmos DB and the usage Logic Apps.',
        howTo: 'Deploy the accelerator first, or point the Hub profile at an existing deployment.',
        links: [LINKS.azdEnv],
      },
    ],
    usesProfiles: ['hub'],
    fields: [
      {
        name: 'apimNameOverride',
        label: 'API Management service name (explicit)',
        type: 'string',
        classification: 'sample-default',
        width: 'id',
        default: '',
        help: 'Leave empty only when the resource group holds exactly one API Management service. When discovery finds several, this recipe stops and asks you to name one here rather than choosing for you.',
        howToObtain: 'Run `az apim list -g <rg> --query "[].name" -o tsv` and pick the hub instance.',
        links: [LINKS.azApimList],
        notebookRef: 'no notebook equivalent — the notebook`s helper resolves a single instance implicitly',
      },
    ],
    configuration: [
      mandatory('hub.subscriptionId', 'Binds both API Management reads to the validated Hub profile subscription.'),
      mandatory('hub.resourceGroupName', 'The resource group whose API Management services are listed and chosen from.'),
      optional(
        'self:apimNameOverride',
        'Names the service explicitly when the group holds more than one.',
        'Left blank, discovery must return exactly one candidate; zero or several stop the recipe rather than picking for you.',
      ),
    ],
    runtime: {
      dependencies: ['azure-cli'],
      note: 'Two management-plane reads: `az apim list` then `az apim show`.',
    },
    risk: {
      level: 'read-only',
      effect: 'Lists and reads API Management services. Nothing is created, changed or deleted.',
      blastRadius: 'None.',
      reversibility: 'Not applicable.',
    },
    sourceCells: [5, 6],
    sourceNote: 'Cell 6 initialises `APIMClientTool` and prints `apim_resource_name` and `apim_resource_gateway_url`.',
    expectedResults: [
      {
        id: 'exactly-one',
        title: 'Exactly one service is selected',
        assertion:
          'The listing returns exactly one service, or the explicit name field matches one of the services returned. Zero services fails; several services without an explicit name fails.',
        evidence: 'The `az apim list` output.',
        whenNotRun: 'Not run — the target gateway is unknown.',
      },
      {
        id: 'gateway-url',
        title: 'A gateway URL is captured',
        assertion: '`gatewayUrl` is an https URL, and it becomes the base for every published endpoint.',
        evidence: 'The `az apim show` output.',
        whenNotRun: 'Not run — endpoints cannot be derived.',
      },
    ],
    deviations: [
      'The notebook`s `APIMClientTool.initialize()` resolves one instance from the resource group without reporting how many candidates it saw. This recipe lists first and refuses to select silently when the count is not one.',
    ],
    notes: [
      'If the hub uses a custom domain, the gateway URL reported here is the one the publish contract will echo back in `publishedAssets[].endpoint`. Prefer the deployment-reported endpoint over anything you compose by hand.',
    ],
    build(ctx) {
      const subscriptionId = ctx.get('hub.subscriptionId');
      const resourceGroup = ctx.get('hub.resourceGroupName');
      const explicitName = ctx.self('apimNameOverride');
      return createExecutionPlan({
        sampleId: 'apim-discovery',
        title: 'API Management discovery',
        summary: 'List API Management services in the hub resource group, choose one deliberately, and read its gateway URL.',
        risk: ctx.risk,
        sourceCells: [5, 6],
        steps: [
          step.cli({
            id: 'list-services',
            title: 'List API Management services in the resource group',
            detail: 'Establishes the candidate set before anything is selected.',
            command: {
              executable: 'az',
              args: [
                'apim',
                'list',
                '-g',
                resourceGroup,
                '--query',
                '[].{name:name, gatewayUrl:gatewayUrl, sku:sku.name, location:location}',
                '--subscription',
                subscriptionId,
                '-o',
                'json',
              ],
            },
            produces: ['services', 'serviceCount'],
          }),
          step.assertion({
            id: 'select-service',
            title: 'Select exactly one service',
            detail:
              'Zero candidates fails. Several candidates fail unless an explicit name was supplied. The first entry is never adopted by default.',
            assertion: {
              kind: 'selection',
              source: '{{steps.list-services.services}}',
              expectations: [
                'The candidate list is not empty.',
                explicitName
                  ? `The explicit name "${explicitName}" appears in the candidate list.`
                  : 'The candidate list holds exactly one service; otherwise supply an explicit name and re-run.',
              ],
              selected: explicitName || '(the single candidate)',
              configurationPath: 'hub.apimName',
            },
            produces: ['apimName'],
          }),
          step.cli({
            id: 'show-service',
            title: 'Read the selected service',
            detail: 'Captures the gateway URL, SKU and location for the Hub profile.',
            command: {
              executable: 'az',
              args: [
                'apim',
                'show',
                '-g',
                resourceGroup,
                '-n',
                explicitName || '{{steps.select-service.apimName}}',
                '--query',
                '{name:name, gatewayUrl:gatewayUrl, sku:sku.name, location:location, publicIPs:publicIpAddresses}',
                '--subscription',
                subscriptionId,
                '-o',
                'json',
              ],
            },
            produces: ['apimName', 'gatewayUrl', 'sku'],
          }),
          step.assertion({
            id: 'assert-gateway',
            title: 'Record the gateway URL',
            detail: 'Writes the discovered values back into the Hub profile so later recipes can derive endpoints.',
            assertion: {
              kind: 'shape',
              source: '{{steps.show-service.gatewayUrl}}',
              expectations: [
                'The gateway URL starts with `https://`.',
                'The SKU is recorded, because the Consumption tier does not support backend circuit breakers.',
              ],
            },
            produces: ['gatewayUrl'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },
];
