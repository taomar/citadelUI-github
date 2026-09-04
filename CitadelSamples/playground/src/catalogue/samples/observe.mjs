/**
 * Observe — cells 24 and 26.
 *
 * Two read-only recipes: one confirms usage telemetry reached Application
 * Insights, one confirms the published backends carry a circuit breaker.
 */

import { step, createExecutionPlan } from '../../core/plan.mjs';
import { apimBackendResourceUri } from '../../core/endpoints.mjs';
import { generated, mandatory, optional } from '../requirements.mjs';
import { LINKS } from '../profiles.mjs';

export const OBSERVE_SAMPLES = [
  {
    id: 'usage-metrics',
    group: 'observe',
    title: 'Usage metrics in Application Insights',
    shortTitle: 'Usage metrics',
    summary: 'Query `McpRequests` and `A2ARequests` custom metrics to confirm the gateway emitted usage telemetry.',
    purpose:
      'Publishing an asset is only half of governance; the other half is knowing it was used. The baseline policies emit a custom metric on every inbound call, and this recipe confirms those metrics actually landed for the calls the Exercise recipes made.',
    explanation: [
      'Two metrics matter: `McpRequests` in the `mcp-usage` namespace and `A2ARequests` in the `a2a-usage` namespace. They are emitted by the baseline policies attached to the published assets, so their absence means either no calls were made or the baseline policy did not run.',
      'The notebook`s query has no time filter. On a hub that has been running for weeks that returns cumulative totals, which cannot distinguish "my calls landed" from "someone else called this last month". This recipe adds an explicit lookback window so the result is about this run.',
      'Ingestion is not instant. Application Insights custom metrics typically appear within a few minutes, and the notebook says as much: an empty result immediately after a call is inconclusive, not a failure. This recipe reports it that way instead of as a pass or a fail.',
      'The Application Insights component is discovered from the hub resource group. The notebook prefers a component whose name contains `apim` and otherwise takes the first one it finds. Taking the first of several is a guess, so the component name is exposed here as an input you can pin.',
    ],
    flow: [
      'List Application Insights components in the hub resource group.',
      'Choose the component — the pinned name if given, otherwise the one whose name contains `apim`.',
      'Run a KQL query over `customMetrics`, filtered to the lookback window and to the two metric names.',
      'Report per-metric totals by deployment name, or report `inconclusive` when the window is empty.',
    ],
    prerequisites: [
      {
        id: 'calls-made',
        title: 'Some calls were actually made',
        detail: 'There is nothing to find unless an Exercise or Policy recipe ran inside the lookback window.',
        howTo: 'Run one of the MCP or A2A recipes first, then wait a few minutes.',
        links: [LINKS.appInsightsCustomMetrics],
      },
      {
        id: 'app-insights-reader',
        title: 'Read access to the Application Insights component',
        detail: 'Monitoring Reader on the component or its resource group is enough to run the query.',
        howTo: 'Confirm with `az monitor app-insights component show --app <name> -g <rg>`.',
        links: [LINKS.appInsightsQuery],
      },
      {
        id: 'cli-extension',
        title: 'The `application-insights` CLI extension',
        detail: '`az monitor app-insights query` lives in an extension that the CLI installs on first use.',
        howTo: 'Run `az extension add --name application-insights`, or accept the prompt on first run.',
        links: [LINKS.appInsightsQuery],
      },
    ],
    usesProfiles: ['hub'],
    fields: [
      {
        name: 'appInsightsName',
        label: 'Application Insights component',
        type: 'string',
        classification: 'derived',
        width: 'id',
        default: '',
        derivedFrom: 'Discovered by the first step of this recipe.',
        help: 'Pin the component here when the hub resource group holds several. Left empty, the recipe prefers a name containing `apim` and reports the ambiguity rather than silently taking the first.',
        howToObtain: 'Run `az resource list -g <rg> --resource-type Microsoft.Insights/components --query "[].name" -o tsv`.',
        links: [LINKS.appInsightsQuery],
        notebookRef: 'cell 24 `app_insights_name`',
      },
      {
        name: 'lookbackMinutes',
        label: 'Lookback window (minutes)',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 30,
        min: 1,
        max: 10080,
        help: 'Restricts the query to this run. The notebook has no time filter at all, so its totals are cumulative over the retention period.',
        howToObtain: 'Choose a window that covers your Exercise calls plus ingestion delay. 30 minutes is a reasonable default.',
        links: [LINKS.kqlAgo],
        notebookRef: 'no notebook equivalent — added because the notebook query is unbounded',
      },
      {
        name: 'metricNames',
        label: 'Metric names',
        type: 'string-list',
        classification: 'sample-default',
        width: 'long',
        default: ['McpRequests', 'A2ARequests'],
        help: 'The custom metrics the baseline policies emit for tools and agents.',
        howToObtain: 'Fixed by the notebook (cell 24).',
        links: [LINKS.appInsightsCustomMetrics],
        notebookRef: 'cell 24 KQL `name in (...)`',
      },
      {
        name: 'ingestionDelayMinutes',
        label: 'Assumed ingestion delay (minutes)',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 5,
        min: 0,
        max: 60,
        help: 'How long to allow before an empty result means anything. Below this, an empty window is inconclusive rather than a failure.',
        howToObtain: 'Azure Monitor documents typical end-to-end ingestion latency; a few minutes is normal.',
        links: [LINKS.monitorIngestionTime],
        notebookRef: 'cell 24 "allow a few minutes after the calls and re-run this cell"',
      },
    ],
    configuration: [
      mandatory('hub.subscriptionId', 'Binds both Application Insights management reads to the Hub profile subscription.'),
      mandatory('hub.resourceGroupName', 'Scopes both the component listing and the Application Insights query.'),
      generated(
        'self:appInsightsName',
        'Pins one Application Insights component instead of choosing.',
        'Left blank the recipe selects the single candidate, or the one whose name contains `apim`, and reports ambiguity rather than taking the first.',
        'Produced by this recipe`s own component listing.',
      ),
      optional('self:lookbackMinutes', 'Bounds the KQL query with `ago(Nm)` so the result describes this run.', 'Falls back to 30 minutes.'),
      optional('self:metricNames', 'The custom metrics the query filters on.', 'Falls back to `McpRequests` and `A2ARequests`.'),
      optional(
        'self:ingestionDelayMinutes',
        'Separates "too early to tell" from "genuinely absent".',
        'Falls back to 5 minutes, inside which an empty window is inconclusive rather than a failure.',
      ),
    ],
    runtime: {
      dependencies: ['azure-cli'],
      note: 'The query step needs the `application-insights` CLI extension, which `az` installs on first use.',
    },
    risk: {
      level: 'read-only',
      effect: 'Lists resources and runs a read-only KQL query.',
      blastRadius: 'None.',
      reversibility: 'Not applicable.',
    },
    sourceCells: [23, 24],
    sourceNote:
      'Cell 24 finds an Application Insights component, runs an unbounded `customMetrics` query for the two metric names, and warns when no rows come back.',
    expectedResults: [
      {
        id: 'component-found',
        title: 'A component is selected deliberately',
        assertion:
          'Exactly one component is found, or the pinned name matches one of several. Several components with no pinned name is reported as ambiguous.',
        evidence: 'The `az resource list` output.',
        whenNotRun: 'Not run — telemetry cannot be queried.',
      },
      {
        id: 'metrics-present',
        title: 'Both metrics appear in the window',
        assertion:
          '`McpRequests` appears after any MCP recipe ran, and `A2ARequests` appears after any A2A recipe ran, both within the lookback window.',
        evidence: 'The query rows: metric name, deployment name and summed value.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'empty-is-inconclusive',
        title: 'An empty window is inconclusive',
        assertion:
          'Zero rows within the assumed ingestion delay is reported as inconclusive, not as a failure and never as a pass.',
        evidence: 'The empty result set plus the elapsed time since the calls.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'The notebook`s KQL has no time filter, so it reports cumulative totals over the whole retention period. This recipe adds `where timestamp > ago(Nm)` so the answer is about this run.',
      'The notebook takes the first Application Insights component when none is named `*apim*`. This recipe reports that as ambiguous and asks for a pinned name.',
      'The notebook prints a warning for an empty result. This recipe distinguishes inconclusive (inside the ingestion delay) from failed (well past it).',
    ],
    notes: [
      'The metric namespaces are `mcp-usage` and `a2a-usage`. The query filters on the metric names rather than the namespaces, exactly as the notebook does.',
      'The `deploymentName` custom dimension is what separates one asset from another in the summary.',
    ],
    build(ctx) {
      const resourceGroup = ctx.get('hub.resourceGroupName');
      const subscriptionId = ctx.get('hub.subscriptionId');
      const lookback = ctx.self('lookbackMinutes');
      const names = (ctx.self('metricNames') ?? []).map((name) => `'${name}'`).join(',');
      const pinned = ctx.self('appInsightsName');
      const kql = [
        'customMetrics',
        `| where timestamp > ago(${lookback}m)`,
        `| where name in (${names})`,
        "| summarize count=sum(valueSum) by name, tostring(customDimensions['deploymentName'])",
        '| order by name asc',
      ].join(' ');
      return createExecutionPlan({
        sampleId: 'usage-metrics',
        title: 'Usage metrics in Application Insights',
        summary: 'Find the hub`s Application Insights component and query the usage metrics for this run.',
        risk: ctx.risk,
        sourceCells: [23, 24],
        steps: [
          step.cli({
            id: 'list-components',
            title: 'List Application Insights components',
            detail: 'Establishes the candidate set before one is chosen.',
            command: {
              executable: 'az',
              args: [
                'resource',
                'list',
                '-g',
                resourceGroup,
                '--resource-type',
                'Microsoft.Insights/components',
                '--query',
                '[].name',
                '--subscription',
                subscriptionId,
                '-o',
                'json',
              ],
            },
            produces: ['components'],
          }),
          step.assertion({
            id: 'select-component',
            title: 'Choose the component',
            detail: 'Prefers a name containing `apim`; several candidates with no clear winner is ambiguous, not a default.',
            assertion: {
              kind: 'selection',
              source: '{{steps.list-components.components}}',
              expectations: [
                pinned ? `The pinned component "${pinned}" is in the list.` : 'Exactly one candidate, or exactly one whose name contains `apim`.',
                'Several candidates with no pinned name and no `apim` match is reported as ambiguous rather than resolved by position.',
              ],
              selected: pinned || '(the apim component, or the single candidate)',
              preferContains: 'apim',
              configurationPath: 'samples.usage-metrics.appInsightsName',
            },
            produces: ['appInsightsName'],
          }),
          step.cli({
            id: 'query-metrics',
            title: 'Query the usage metrics',
            detail: `Bounded to the last ${lookback} minutes so the result describes this run.`,
            command: {
              executable: 'az',
              args: [
                'monitor',
                'app-insights',
                'query',
                '--app',
                pinned || '{{steps.select-component.appInsightsName}}',
                '-g',
                resourceGroup,
                '--analytics-query',
                kql,
                '--subscription',
                subscriptionId,
                '-o',
                'json',
              ],
              note: 'Needs the `application-insights` CLI extension.',
            },
            produces: ['rows'],
          }),
          step.assertion({
            id: 'assert-metrics',
            title: 'Interpret the rows',
            detail: 'An empty window inside the ingestion delay is inconclusive.',
            assertion: {
              kind: 'metrics',
              source: '{{steps.query-metrics.rows}}',
              expectations: [
                `Rows exist for the metrics ${(ctx.self('metricNames') ?? []).join(' and ')} within the last ${lookback} minutes.`,
                'Each row reports the metric name, the asset`s deployment name and the summed value.',
                `Zero rows within ${ctx.self('ingestionDelayMinutes')} minutes of the calls is inconclusive; zero rows well past that is a failure.`,
                'Zero rows is never reported as a pass.',
              ],
              lookbackMinutes: lookback,
              ingestionDelayMinutes: ctx.self('ingestionDelayMinutes'),
            },
            produces: ['metricsSeen'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'circuit-breaker-check',
    group: 'observe',
    title: 'Circuit breaker on the published backend',
    shortTitle: 'Circuit breaker',
    summary: 'Read the remote MCP backend and confirm a native circuit breaker rule is attached.',
    purpose:
      'A gateway in front of a remote dependency is only an improvement if it protects callers when that dependency degrades. The publish contract attaches a native circuit breaker to each backend it creates, and this recipe reads it back to prove it is really there.',
    explanation: [
      'The breaker is a property of the APIM backend object, not a policy. It is read through the management API at a preview api-version, which is why the notebook uses `az rest` rather than a typed `az apim` command.',
      'A rule has three parts: a failure condition (how many failures, over what interval, for which status codes), a trip duration, and whether `Retry-After` from the backend is honoured. The defaults the contract applies are 3 failures in `PT5M`, tripping for `PT1M`, counting 429 and the 500–503 range, and accepting `Retry-After`.',
      'Backend circuit breakers are not available on the API Management Consumption tier. On Consumption this recipe fails against a real absence, and that is the correct result — the SKU recorded by the discovery recipe is what tells you whether to expect one.',
      'The notebook only inspects backends belonging to `mcp-existing` assets, even though its own heading says it confirms the remote MCP *and* A2A assets. The A2A backend is therefore never checked. This recipe offers an opt-in for it and says clearly that including it goes beyond what the notebook does.',
    ],
    flow: [
      'Compose the backend resource URI for each remote asset, `<apim service id>/backends/<asset>-backend`.',
      'GET it with `az rest` at the preview api-version.',
      'Read `properties.circuitBreaker.rules[0]`.',
      'Compare the failure count, interval, trip duration, status-code ranges and `Retry-After` handling with the expected defaults.',
    ],
    prerequisites: [
      {
        id: 'assets-published',
        title: 'The assets are published with circuit breakers configured',
        detail: 'The breaker only exists if the publish contract was deployed with `configureCircuitBreaker = true`.',
        howTo: 'Run Publish and grant › Publish the three assets with that toggle on.',
        links: [LINKS.apimCircuitBreaker],
      },
      {
        id: 'not-consumption',
        title: 'The gateway is not on the Consumption tier',
        detail: 'Backend circuit breakers are unavailable on Consumption, so this check cannot pass there.',
        howTo: 'The discovery recipe records the SKU. Check it before treating a failure here as a bug.',
        links: [LINKS.apimTiers],
      },
      {
        id: 'management-read',
        title: 'Management-plane read on the APIM service',
        detail: '`az rest` calls ARM directly, so Reader on the service is required.',
        howTo: 'Confirm with `az apim show -g <rg> -n <apim> --query id -o tsv`.',
        links: [LINKS.azRest],
      },
    ],
    usesProfiles: ['hub'],
    fields: [
      {
        name: 'backendAssetNames',
        label: 'Assets to check',
        type: 'string-list',
        classification: 'sample-default',
        width: 'long',
        default: ['ms-learn-tool'],
        help: 'One backend is checked per name, as `<name>-backend`. The notebook checks only `mcp-existing` assets, which is this default.',
        howToObtain: 'Fixed by the notebook (cell 26). Add `hr-chat-agent` to also check the A2A backend.',
        links: [LINKS.apimCircuitBreaker],
        notebookRef: 'cell 26 loop over `mcp-existing` assets',
      },
      {
        name: 'includeAgentBackend',
        label: 'Also check the A2A backend',
        type: 'boolean',
        classification: 'sample-default',
        default: false,
        help: 'Off by default to match the notebook. Cell 25`s heading claims the A2A backend is checked; cell 26 does not check it.',
        howToObtain: 'Turn on to close that gap. It adds `hr-chat-agent-backend` to the checks.',
        links: [LINKS.apimCircuitBreaker],
        notebookRef: 'gap between cell 25 heading and cell 26 code',
      },
      {
        name: 'apiVersion',
        label: 'Management API version',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: '2024-06-01-preview',
        help: 'Circuit breaker configuration is exposed on a preview api-version.',
        howToObtain: 'Fixed by the notebook (cell 26).',
        links: [LINKS.apimCircuitBreaker],
        notebookRef: 'cell 26 `?api-version=2024-06-01-preview`',
      },
      {
        name: 'expectedFailureCount',
        label: 'Expected failure count',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 3,
        min: 1,
        help: 'Failures required inside the interval before the breaker trips.',
        howToObtain: 'The publish contract`s default. Compare with what the backend actually reports.',
        links: [LINKS.apimCircuitBreaker],
        notebookRef: 'cell 26 `failureCondition.count`',
      },
      {
        name: 'expectedFailureInterval',
        label: 'Expected failure interval',
        type: 'string',
        classification: 'sample-default',
        width: 'num',
        default: 'PT5M',
        help: 'ISO 8601 duration the failures are counted over.',
        howToObtain: 'The publish contract`s default.',
        links: [LINKS.apimCircuitBreaker],
        notebookRef: 'cell 26 `failureCondition.interval`',
      },
      {
        name: 'expectedTripDuration',
        label: 'Expected trip duration',
        type: 'string',
        classification: 'sample-default',
        width: 'num',
        default: 'PT1M',
        help: 'How long the breaker stays open once tripped.',
        howToObtain: 'The publish contract`s default.',
        links: [LINKS.apimCircuitBreaker],
        notebookRef: 'cell 26 `rule.tripDuration`',
      },
      {
        name: 'expectedStatusCodes',
        label: 'Expected status codes',
        type: 'string-list',
        classification: 'sample-default',
        width: 'short',
        default: ['429', '500-503'],
        help: 'Status codes counted as failures: throttling plus the server-error range.',
        howToObtain: 'The publish contract`s default. Reported as `statusCodeRanges` on the rule.',
        links: [LINKS.apimCircuitBreaker],
        notebookRef: 'publish-contract circuit breaker defaults',
      },
      {
        name: 'expectRetryAfter',
        label: 'Expect Retry-After to be honoured',
        type: 'boolean',
        classification: 'sample-default',
        default: true,
        help: 'When on, the backend`s `Retry-After` header governs how long the breaker stays open.',
        howToObtain: 'The publish contract`s default, reported as `acceptRetryAfter`.',
        links: [LINKS.apimCircuitBreaker],
        notebookRef: 'publish-contract circuit breaker defaults',
      },
    ],
    configuration: [
      mandatory('hub.subscriptionId', 'First segment of the backend resource id each `az rest` call targets.'),
      mandatory('hub.resourceGroupName', 'Second segment of the backend resource id.'),
      mandatory('hub.apimName', 'Names the API Management service whose backends are read.'),
      optional('self:backendAssetNames', 'Which published assets` backends are inspected.', 'Falls back to `ms-learn-tool`, the only `mcp-existing` asset the notebook checks.'),
      optional('self:includeAgentBackend', 'Adds the A2A backend, which the notebook`s loop never reaches.', 'Falls back to off, matching the notebook`s actual behaviour rather than its heading.'),
      optional('self:apiVersion', 'The management API version on the backend GET.', 'Falls back to `2024-06-01-preview`, as the notebook uses.'),
      optional('self:expectedFailureCount', 'Expected `failureCondition.count`.', 'Falls back to 3, the publish contract`s default.'),
      optional('self:expectedFailureInterval', 'Expected `failureCondition.interval`.', 'Falls back to `PT5M`.'),
      optional('self:expectedTripDuration', 'Expected `tripDuration`.', 'Falls back to `PT1M`.'),
      optional('self:expectedStatusCodes', 'Expected status-code ranges in the failure condition.', 'Falls back to 429 and 500–503.'),
      optional('self:expectRetryAfter', 'Whether `acceptRetryAfter` is expected to be true.', 'Falls back to true, the contract default.'),
    ],
    runtime: {
      dependencies: ['azure-cli'],
      note: 'One `az rest` GET per backend. A Consumption-tier gateway reports unsupported rather than misconfigured.',
    },
    risk: {
      level: 'read-only',
      effect: 'One management-plane GET per backend.',
      blastRadius: 'None.',
      reversibility: 'Not applicable.',
    },
    sourceCells: [25, 26],
    sourceNote:
      'Cell 26 loops over `mcp-existing` assets, GETs each backend with `az rest`, and prints the first rule`s failure count, interval and trip duration.',
    expectedResults: [
      {
        id: 'backend-exists',
        title: 'The backend exists',
        assertion: 'The GET returns 200 for `<asset>-backend`.',
        evidence: 'The `az rest` response.',
        whenNotRun: 'Not run — the backend`s configuration is unknown.',
      },
      {
        id: 'breaker-attached',
        title: 'A circuit breaker rule is attached',
        assertion: '`properties.circuitBreaker.rules` is a non-empty array.',
        evidence: 'The backend properties.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'breaker-defaults',
        title: 'The rule matches the expected defaults',
        assertion:
          'Failure count 3 over `PT5M`, trip duration `PT1M`, status codes 429 and 500–503, and `Retry-After` honoured — or a deliberate, recorded difference.',
        evidence: 'The rule`s `failureCondition`, `tripDuration` and `acceptRetryAfter`.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'consumption-note',
        title: 'Consumption tier is reported as unsupported',
        assertion:
          'On the Consumption tier the absence of a breaker is reported as unsupported-by-SKU, not as a misconfiguration.',
        evidence: 'The SKU recorded by the discovery recipe.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'Cell 25`s heading says the remote MCP *and* A2A assets are confirmed, but cell 26 only iterates `mcp-existing` assets, so the A2A backend is never checked. This recipe exposes an opt-in and states that turning it on goes beyond the notebook.',
      'The notebook reports a missing breaker as a warning. This recipe reports it as a failure, unless the SKU is Consumption, where it is reported as unsupported.',
      'The notebook prints only the first rule`s count, interval and trip duration. This recipe also compares the status-code ranges and `Retry-After` handling.',
    ],
    notes: [
      'A backend is created for `mcp-existing` and `a2a` assets. An `mcp-from-api` asset reuses the source API and so has no backend of its own to inspect.',
    ],
    build(ctx) {
      const coordinates = {
        subscriptionId: ctx.get('hub.subscriptionId'),
        resourceGroupName: ctx.get('hub.resourceGroupName'),
        apimName: ctx.get('hub.apimName'),
      };
      const names = [...(ctx.self('backendAssetNames') ?? [])];
      if (ctx.self('includeAgentBackend') && !names.includes('hr-chat-agent')) names.push('hr-chat-agent');
      const apiVersion = ctx.self('apiVersion');
      const steps = names.map((name, index) =>
        step.cli({
          id: `read-backend-${index + 1}`,
          title: `Read the ${name}-backend configuration`,
          detail: 'Circuit breaker configuration lives on the backend object, not in a policy.',
          command: {
            executable: 'az',
            args: [
              'rest',
              '--method',
              'get',
              '--uri',
              apimBackendResourceUri(coordinates, `${name}-backend`, apiVersion),
              '--subscription',
              coordinates.subscriptionId,
              '-o',
              'json',
            ],
          },
          produces: ['backend', 'circuitBreaker'],
        }),
      );
      steps.push(
        step.assertion({
          id: 'assert-breakers',
          title: 'Compare each rule with the expected defaults',
          detail: 'A missing breaker on a supported SKU is a failure; on Consumption it is unsupported.',
          assertion: {
            kind: 'circuit-breaker',
            source: '{{steps.read-backend-1.circuitBreaker}}',
            expectations: [
              ...names.map((name) => `\`${name}-backend\` exists and carries a non-empty \`circuitBreaker.rules\`.`),
              `Failure count is ${ctx.self('expectedFailureCount')} over ${ctx.self('expectedFailureInterval')}.`,
              `Trip duration is ${ctx.self('expectedTripDuration')}.`,
              `Status code ranges cover ${(ctx.self('expectedStatusCodes') ?? []).join(' and ')}.`,
              ctx.self('expectRetryAfter')
                ? '`acceptRetryAfter` is true, so the backend`s `Retry-After` governs the open period.'
                : '`acceptRetryAfter` is false.',
              'On the API Management Consumption tier this is reported as unsupported-by-SKU rather than as a misconfiguration.',
            ],
            expected: {
              failureCount: ctx.self('expectedFailureCount'),
              failureInterval: ctx.self('expectedFailureInterval'),
              tripDuration: ctx.self('expectedTripDuration'),
              statusCodes: ctx.self('expectedStatusCodes'),
              acceptRetryAfter: ctx.self('expectRetryAfter'),
            },
            backends: names.map((name) => `${name}-backend`),
          },
          produces: ['breakersOk'],
        }),
      );
      return createExecutionPlan({
        sampleId: 'circuit-breaker-check',
        title: 'Circuit breaker on the published backend',
        summary: 'Read each remote backend and compare its circuit breaker rule with the expected defaults.',
        risk: ctx.risk,
        sourceCells: [25, 26],
        steps,
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },
];
