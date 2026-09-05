/**
 * Exercise — cells 20, 22, 28 and 29.
 *
 * Six recipes that call the published assets through the gateway the way a
 * consumer would: two MCP handshakes, two A2A calls, one Agent Framework
 * client, and one direct tool invocation.
 */

import { step, createExecutionPlan } from '../../core/plan.mjs';
import { agentCardUrl, agentEndpoint, mcpEndpoint } from '../../core/endpoints.mjs';
import {
  mcpCallStep,
  mcpHandshakeExpectations,
  mcpInitializedStep,
  mcpInitializeStep,
} from '../../core/mcp.mjs';
import { secretRef } from '../../core/secrets.mjs';
import { conditional, generated, mandatory, optional, secret } from '../requirements.mjs';
import { LINKS } from '../profiles.mjs';

const FAHRENHEIT_CITIES = ['Seattle', 'New York City', 'Los Angeles'];

/** The api-key every gateway call in this group presents. */
const GATEWAY_KEY_NEED = secret(
  'gatewayAccess.apiKey',
  'Presented on every call. Without it the gateway answers 401 before the published asset is reached.',
);

/** Header/prefix conventions shared by every gateway call. */
const GATEWAY_CONVENTION_NEEDS = [
  optional(
    'gatewayAccess.subscriptionKeyHeader',
    'The header the contract key is sent in.',
    'Falls back to `api-key`, the gateway default the publish contract sets.',
  ),
  optional(
    'gatewayAccess.useAssetTypePathPrefix',
    'Decides whether the composed path carries the `mcp/` or `agent/` prefix.',
    'Falls back to on, and is ignored entirely once a deployed endpoint or path is recorded.',
  ),
];

function endpointFieldsFor({ pathDefault, assetType, label, docLink }) {
  return [
    {
      name: 'assetPath',
      label: `${label} path`,
      type: 'string',
      classification: 'sample-default',
      width: 'short',
      default: pathDefault,
      help:
        assetType === 'mcp-from-api'
          ? 'Used only when no deployed endpoint is recorded. An API→MCP server is served at `{gateway}/mcp/{path}/mcp`.'
          : 'Used only when no deployed endpoint is recorded. A native MCP server is served at `{gateway}/mcp/{path}` with no trailing `/mcp`.',
      howToObtain: 'Fixed by the notebook (cell 14). Must match the published asset`s `path`.',
      links: [docLink],
      notebookRef: 'cell 14 asset `path`',
    },
    {
      name: 'deployedEndpoint',
      label: 'Deployed endpoint (authoritative)',
      type: 'url',
      classification: 'derived',
      width: 'long',
      default: '',
      derivedFrom: 'Produced by Publish and grant › Publish the three assets (`publishedAssets[].endpoint`).',
      help: 'The endpoint the deployment reported. When set it wins over anything composed from the path, exactly as the notebook prefers it.',
      howToObtain: 'Copy it from the publish deployment`s `publishedAssets` output.',
      links: [LINKS.apimMcpOverview],
      notebookRef: 'cell 20 `published_by_name[...]["endpoint"]`',
    },
  ];
}

/**
 * What a tool-server call needs. The gateway URL is conditional rather than
 * mandatory because a recorded deployed endpoint replaces it outright — which
 * is exactly the rule `mcpEndpoint()` implements.
 */
function mcpEndpointNeeds({ sampleId, label, pathDefault, suffixNote }) {
  return [
    conditional(
      'hub.gatewayUrl',
      `Base the ${label} endpoint is composed from.`,
      'No deployed endpoint has been recorded for this asset.',
      { field: `samples.${sampleId}.deployedEndpoint`, blank: true },
    ),
    GATEWAY_KEY_NEED,
    ...GATEWAY_CONVENTION_NEEDS,
    optional('self:assetPath', `Path segment of the published ${label}.`, `Falls back to \`${pathDefault}\`. ${suffixNote}`),
    generated(
      'self:deployedEndpoint',
      'The endpoint the publish deployment reported. When set it replaces everything composed from the gateway URL and the path.',
      'Left blank the endpoint is composed from the gateway URL, the prefix toggle and the path.',
      'Produced by Publish and grant › Publish the three assets (`publishedAssets[].endpoint`).',
    ),
  ];
}

/** What an A2A call needs. The agent base is always composed from the gateway. */
function agentEndpointNeeds({ pathDefault }) {
  return [
    mandatory(
      'hub.gatewayUrl',
      'The agent endpoint is always the gateway host plus a path, so there is nothing to compose without it.',
    ),
    GATEWAY_KEY_NEED,
    ...GATEWAY_CONVENTION_NEEDS,
    optional('self:agentPath', 'Path segment of the published agent.', `Falls back to \`${pathDefault}\`.`),
    generated(
      'self:deployedPath',
      'The already-prefixed path the deployment reported. When set it replaces the composed path.',
      'Left blank the path is composed from the prefix toggle and the agent path.',
      'Produced by Publish and grant › Publish the three assets (`publishedAssets[].path`).',
    ),
  ];
}

function mcpDiscoveryPrerequisites(extra = []) {
  return [
    {
      id: 'assets-published',
      title: 'The asset is published',
      detail: 'The MCP server only exists once the publish contract has been deployed.',
      howTo: 'Run Publish and grant › Publish the three assets.',
      links: [LINKS.apimMcp],
    },
    {
      id: 'key-minted',
      title: 'An access-contract api-key',
      detail: 'The published tool requires a subscription. Without a key the gateway returns 401 before the MCP runtime is reached.',
      howTo: 'Run Publish and grant › Deploy the mixed access contract, then paste the key into the Gateway access profile.',
      links: [LINKS.apimSubscriptions],
    },
    ...extra,
  ];
}

const MCP_DEVIATIONS = [
  'The notebook sends `tools/list` or `tools/call` immediately after `initialize` and omits `MCP-Protocol-Version` on later requests. This recipe follows MCP 2025-06-18: it validates the negotiated version, sends `notifications/initialized`, and carries both session and protocol headers thereafter.',
  'The notebook treats an HTTP 2xx `tools/list` response as success without checking for a JSON-RPC `error` member. This recipe fails on an error member regardless of status.',
  'The notebook prints the tool names it received but does not assert against an expected set. This recipe asserts that at least one tool is returned, and names the tools it expects without turning a remote server`s inventory into a hard requirement.',
];

const MCP_NOTES = [
  'The `Accept` header lists both `application/json` and `text/event-stream`, so APIM may answer either way. Both are parsed.',
  'The JSON-RPC id is numeric. APIM`s MCP runtime rejects a string id such as a UUID with "Invalid JSON payload".',
  'Every request after `initialize` carries both `Mcp-Session-Id` and `MCP-Protocol-Version`; the mandatory `notifications/initialized` notification has no JSON-RPC id and is judged by its HTTP status.',
  'A browser cannot make this call against a different origin unless the gateway sends CORS headers permitting it and exposes the `Mcp-Session-Id` response header. That is why live execution is gated behind an executor rather than attempted with `fetch`.',
];

export const EXERCISE_SAMPLES = [
  {
    id: 'weather-mcp-discovery',
    group: 'exercise',
    title: 'Weather tool: MCP handshake and tools/list',
    shortTitle: 'Weather MCP discovery',
    summary: 'Open an MCP session against the API→MCP Weather Tool and list the tools it exposes.',
    purpose:
      'This is the first proof that an `mcp-from-api` asset actually works end to end: the gateway accepted the key, the MCP runtime answered the handshake, and the source API`s operations were projected into MCP tools.',
    explanation: [
      'An `mcp-from-api` server is generated by APIM from an existing API. Its endpoint carries a trailing `/mcp` on top of the asset-type prefix, so the full address is `{gateway}/mcp/{path}/mcp` — one `mcp` from the prefix and one from the runtime. That double segment is the single most common reason a handshake 404s.',
      'The handshake is three requests, not two. `initialize` negotiates the protocol version and returns an `Mcp-Session-Id` header; the client must acknowledge that session with `notifications/initialized` before `tools/list`. Both post-initialize requests carry the session id and negotiated protocol version.',
      'The tool inventory comes from the `operationNames` the publish contract exposed. With only `get-weather` published, exactly one tool should appear. More tools than expected means the contract exposed more operations than intended.',
    ],
    flow: [
      'POST `initialize` with protocol version `2025-06-18`, a numeric JSON-RPC id, and the contract key.',
      'Require the matching response to negotiate `2025-06-18` and return `Mcp-Session-Id`.',
      'POST `notifications/initialized` without an id, bound to that session and protocol version.',
      'POST `tools/list` with the session id, protocol version, and next numeric id.',
      'Confirm the response carries a JSON-RPC `result` and at least one tool.',
    ],
    prerequisites: mcpDiscoveryPrerequisites([
      {
        id: 'source-api-in-product',
        title: '`weather-api` is in the same product',
        detail:
          'Not needed for `tools/list`, but a `tools/call` fails later without it because the forwarded key would not authorise the internal hop.',
        howTo: 'The access contract adds forwarded source APIs to the product automatically.',
        links: [LINKS.apimProduct],
      },
    ]),
    usesProfiles: ['hub', 'gatewayAccess'],
    fields: endpointFieldsFor({
      pathDefault: 'weather-tool-mcp',
      assetType: 'mcp-from-api',
      label: 'Weather tool',
      docLink: LINKS.apimMcp,
    }),
    configuration: mcpEndpointNeeds({
      sampleId: 'weather-mcp-discovery',
      label: 'Weather tool',
      pathDefault: 'weather-tool-mcp',
      suffixNote: 'An API→MCP server is served at `{gateway}/mcp/{path}/mcp`.',
    }),
    runtime: {
      dependencies: ['gateway-network'],
      note: 'Three HTTPS requests to the gateway. No Azure CLI and no Python are needed.',
    },
    risk: {
      level: 'read-only',
      effect:
        'Opens an MCP session and lists tools. No resource is created or changed, though the calls count against the contract`s tool rate limit and appear in usage telemetry.',
      blastRadius: 'Three requests.',
      reversibility: 'Not applicable.',
    },
    sourceCells: [19, 20],
    sourceNote: 'Cell 20 defines `mcp_call` / `validate_mcp` and runs the handshake for every tool asset.',
    expectedResults: [
      {
        id: 'initialize-ok',
        title: 'The handshake succeeds',
        assertion: 'HTTP 2xx with a JSON-RPC `result`, negotiated protocol `2025-06-18`, and an `Mcp-Session-Id` response header, followed by an accepted `notifications/initialized` notification.',
        evidence: 'The initialize response status, headers and body.',
        whenNotRun: 'Not run — the tool`s reachability is unknown.',
      },
      {
        id: 'tools-listed',
        title: 'At least one tool is returned',
        assertion: '`result.tools` is a non-empty array of objects each carrying a `name`.',
        evidence: 'The tools/list result.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'expected-tool',
        title: 'The published operation appears as a tool',
        assertion: 'The tool list contains `get-weather`, matching the single operation the publish contract exposed.',
        evidence: 'The tool names.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: MCP_DEVIATIONS,
    notes: MCP_NOTES,
    build(ctx) {
      const endpoint = mcpEndpoint(
        { assetType: 'mcp-from-api', path: ctx.self('assetPath') },
        {
          gatewayUrl: ctx.get('hub.gatewayUrl'),
          useAssetTypePathPrefix: ctx.get('gatewayAccess.useAssetTypePathPrefix'),
          deployedEndpoint: ctx.self('deployedEndpoint'),
        },
      );
      const apiKeyHeader = ctx.get('gatewayAccess.subscriptionKeyHeader');
      return createExecutionPlan({
        sampleId: 'weather-mcp-discovery',
        title: 'Weather tool: MCP handshake and tools/list',
        summary: 'Initialize an MCP session against the API→MCP Weather Tool and list its tools.',
        risk: ctx.risk,
        sourceCells: [19, 20],
        steps: [
          mcpInitializeStep({ endpoint, apiKeyHeader, jsonRpcId: 1 }),
          mcpInitializedStep({ endpoint, apiKeyHeader }),
          mcpCallStep({
            id: 'tools-list',
            endpoint,
            apiKeyHeader,
            method: 'tools/list',
            params: {},
            jsonRpcId: 2,
            title: 'MCP tools/list',
            produces: ['status', 'result', 'toolNames'],
          }),
          step.assertion({
            id: 'assert-tools',
            title: 'Confirm the handshake and the tool inventory',
            detail: 'The session and protocol bindings plus the initialized notification make the tool request valid.',
            assertion: {
              kind: 'mcp-tools',
              source: '{{steps.tools-list.toolNames}}',
              expectations: [
                ...mcpHandshakeExpectations('Weather Tool'),
                '`tools/list` returns a non-empty `result.tools` array.',
                'The list contains `get-weather`.',
              ],
              endpoint,
            },
            produces: ['discovered'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'learn-mcp-discovery',
    group: 'exercise',
    title: 'Microsoft Learn tool: MCP handshake and tools/list',
    shortTitle: 'Learn MCP discovery',
    summary: 'Open an MCP session against the gateway-fronted Microsoft Learn MCP server and list its tools.',
    purpose:
      'Proves the second publishing shape works: an `mcp-existing` asset, where the gateway fronts a remote MCP server it did not generate. Success here also proves the backend and its circuit breaker were created, because the request has to traverse them.',
    explanation: [
      'A native MCP server keeps its own address space. The gateway adds the asset-type prefix but no trailing `/mcp`, so the endpoint is `{gateway}/mcp/{path}` — one segment shorter than the API→MCP form. Getting this wrong in either direction produces a 404 that looks like a publishing failure.',
      'The remote backend is Microsoft Learn`s public MCP endpoint, published with `authType: none` because it is unauthenticated. The gateway still requires the contract key, so the asset is protected even though its backend is not.',
      'The tool inventory belongs to the remote server, not to this contract. Asserting an exact list would make this recipe fail whenever Microsoft ships a new tool, so the hard assertion is "at least one tool", with the currently published documentation-search tools named as an informational expectation.',
    ],
    flow: [
      'POST `initialize` with protocol version `2025-06-18` and the contract key.',
      'Require the matching response to negotiate `2025-06-18` and return `Mcp-Session-Id`.',
      'POST `notifications/initialized` without an id on that session.',
      'POST `tools/list` with the session id and protocol version.',
      'Confirm a JSON-RPC `result` with a non-empty tool array.',
    ],
    prerequisites: mcpDiscoveryPrerequisites([
      {
        id: 'egress',
        title: 'Outbound access from the gateway to learn.microsoft.com',
        detail: 'The gateway calls the remote MCP server itself. A network-restricted APIM instance needs egress to `learn.microsoft.com`.',
        howTo: 'Check the gateway`s outbound rules or NSG, and the backend`s health in the APIM portal.',
        links: [LINKS.learnMcpServer],
      },
    ]),
    usesProfiles: ['hub', 'gatewayAccess'],
    fields: endpointFieldsFor({
      pathDefault: 'ms-learn-tool-mcp',
      assetType: 'mcp-existing',
      label: 'Learn tool',
      docLink: LINKS.learnMcpServer,
    }),
    configuration: mcpEndpointNeeds({
      sampleId: 'learn-mcp-discovery',
      label: 'Learn tool',
      pathDefault: 'ms-learn-tool-mcp',
      suffixNote: 'A native MCP server is served at `{gateway}/mcp/{path}` with no trailing `/mcp`.',
    }),
    runtime: {
      dependencies: ['gateway-network'],
      note: 'Three HTTPS requests to the gateway; the gateway itself reaches `learn.microsoft.com`, not this machine.',
    },
    risk: {
      level: 'read-only',
      effect: 'Opens an MCP session against a remote server through the gateway. Nothing is created or changed.',
      blastRadius: 'Three requests, one of which reaches a public Microsoft endpoint.',
      reversibility: 'Not applicable.',
    },
    sourceCells: [19, 20],
    sourceNote: 'Cell 20 runs the same `validate_mcp` handshake for every asset whose type is `mcp-from-api` or `mcp-existing`.',
    expectedResults: [
      {
        id: 'initialize-ok',
        title: 'The handshake succeeds through the gateway',
        assertion: 'HTTP 2xx with a JSON-RPC `result`, negotiated protocol `2025-06-18`, and an `Mcp-Session-Id` header, followed by an accepted `notifications/initialized` notification.',
        evidence: 'The initialize response.',
        whenNotRun: 'Not run — the remote tool`s reachability is unknown.',
      },
      {
        id: 'tools-listed',
        title: 'At least one tool is returned',
        assertion: '`result.tools` is a non-empty array.',
        evidence: 'The tools/list result.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'backend-traversed',
        title: 'The published backend was traversed',
        assertion:
          'A successful response implies the `ms-learn-tool-backend` backend exists and is reachable, which is the object the resiliency recipe inspects.',
        evidence: 'The successful round trip.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      ...MCP_DEVIATIONS,
      'The notebook prints whatever tool names come back. Because these belong to a remote Microsoft service and change over time, this recipe does not treat any specific name as required.',
    ],
    notes: [
      ...MCP_NOTES,
      'At the time of writing the Microsoft Learn MCP server publishes documentation search and fetch tools. Treat the exact names as informational.',
    ],
    build(ctx) {
      const endpoint = mcpEndpoint(
        { assetType: 'mcp-existing', path: ctx.self('assetPath') },
        {
          gatewayUrl: ctx.get('hub.gatewayUrl'),
          useAssetTypePathPrefix: ctx.get('gatewayAccess.useAssetTypePathPrefix'),
          deployedEndpoint: ctx.self('deployedEndpoint'),
        },
      );
      const apiKeyHeader = ctx.get('gatewayAccess.subscriptionKeyHeader');
      return createExecutionPlan({
        sampleId: 'learn-mcp-discovery',
        title: 'Microsoft Learn tool: MCP handshake and tools/list',
        summary: 'Initialize an MCP session against the gateway-fronted remote MCP server and list its tools.',
        risk: ctx.risk,
        sourceCells: [19, 20],
        steps: [
          mcpInitializeStep({ endpoint, apiKeyHeader, jsonRpcId: 1 }),
          mcpInitializedStep({ endpoint, apiKeyHeader }),
          mcpCallStep({
            id: 'tools-list',
            endpoint,
            apiKeyHeader,
            method: 'tools/list',
            params: {},
            jsonRpcId: 2,
            title: 'MCP tools/list',
            produces: ['status', 'result', 'toolNames'],
          }),
          step.assertion({
            id: 'assert-tools',
            title: 'Confirm the handshake and a non-empty inventory',
            detail: 'The remote server owns the inventory, so only its non-emptiness is required.',
            assertion: {
              kind: 'mcp-tools',
              source: '{{steps.tools-list.toolNames}}',
              expectations: [
                ...mcpHandshakeExpectations('Microsoft Learn Tool'),
                '`tools/list` returns a non-empty `result.tools` array.',
                'The exact tool names are informational: they belong to the remote Microsoft Learn MCP server.',
              ],
              endpoint,
            },
            produces: ['discovered'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'a2a-agent-card',
    group: 'exercise',
    title: 'A2A agent card',
    shortTitle: 'A2A card',
    summary: 'Fetch the agent card the gateway re-exposes at `/.well-known/agent.json`.',
    purpose:
      'An A2A client discovers an agent by reading its card. The publish contract rewrites the card`s transport URLs to the gateway, so this recipe proves both that the card is reachable and that a client following it will route through the gateway rather than calling Foundry directly.',
    explanation: [
      'The card lives at a well-known path relative to the agent base — `{gateway}/agent/{path}/.well-known/agent.json` with the asset-type prefix on. The gateway fetches it from the Foundry agent card backend and rewrites it before returning it.',
      'The rewrite is the point. If the card still advertised `…services.ai.azure.com…` transport URLs, an A2A client would resolve the card through the gateway and then send its actual messages straight to Foundry, bypassing the product policy, the rate limits and the usage telemetry entirely. Checking the transport URLs is therefore a security check, not a cosmetic one.',
      'The card endpoint is subscription-protected like the rest of the asset, so the contract key must be presented on the card fetch as well as on the JSON-RPC calls.',
    ],
    flow: [
      'GET `{agent base}/.well-known/agent.json` with the contract key in the configured header.',
      'Confirm HTTP 2xx and a JSON body.',
      'Confirm the card carries a name and a description.',
      'Confirm every transport URL in the card exactly matches the selected gateway origin and agent path.',
    ],
    prerequisites: [
      {
        id: 'a2a-published',
        title: 'The A2A asset is published',
        detail: 'The card path only exists once the publish contract created the agent API.',
        howTo: 'Run Publish and grant › Publish the three assets with the A2A asset enabled.',
        links: [LINKS.foundryA2a],
      },
      {
        id: 'key-minted',
        title: 'An access-contract api-key',
        detail: 'The A2A API is published with `subscriptionRequired: true`.',
        howTo: 'Run Publish and grant › Deploy the mixed access contract.',
        links: [LINKS.apimSubscriptions],
      },
    ],
    usesProfiles: ['hub', 'gatewayAccess', 'foundry'],
    fields: [
      {
        name: 'agentPath',
        label: 'Agent path',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'hr-chat-agent',
        help: 'Used when no deployed path is recorded. With the asset-type prefix on, the agent base is `{gateway}/agent/{path}`.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 14 asset 3 `path`',
      },
      {
        name: 'deployedPath',
        label: 'Deployed path (authoritative)',
        type: 'string',
        classification: 'derived',
        width: 'id',
        default: '',
        derivedFrom: 'Produced by Publish and grant › Publish the three assets (`publishedAssets[].path`).',
        help: 'The already-prefixed path the deployment reported. When set it wins over the composed path.',
        howToObtain: 'Copy it from the publish deployment`s `publishedAssets` output.',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 20 `agent_endpoint`',
      },
      {
        name: 'agentCardPath',
        label: 'Agent card path',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: '/.well-known/agent.json',
        help: 'Relative card path. A2A clients resolve it against the agent base URL.',
        howToObtain: 'Fixed by the notebook (cell 22).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 22 `card_url`',
      },
    ],
    configuration: [
      ...agentEndpointNeeds({ pathDefault: 'hr-chat-agent' }),
      optional('self:agentCardPath', 'Relative card path resolved against the agent base URL.', 'Falls back to `/.well-known/agent.json`.'),
    ],
    runtime: {
      dependencies: ['gateway-network'],
      note: 'A single authenticated GET against the gateway.',
    },
    risk: {
      level: 'read-only',
      effect: 'One GET. Nothing is created or changed, though it counts against the agent rate limit.',
      blastRadius: 'One request.',
      reversibility: 'Not applicable.',
    },
    sourceCells: [21, 22],
    sourceNote: 'Cell 22 fetches the card with the api-key and records `results["hr-chat-agent-card"]` from the status code alone.',
    expectedResults: [
      {
        id: 'card-reachable',
        title: 'The card is reachable',
        assertion: 'HTTP 2xx and a body that parses as JSON.',
        evidence: 'The response status and body.',
        whenNotRun: 'Not run — the card`s reachability is unknown.',
      },
      {
        id: 'card-shape',
        title: 'The card describes the agent',
        assertion: 'The card carries a `name` and a `description`, which is what an A2A client shows and what `A2AAgent` requires.',
        evidence: 'The parsed card.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'transport-rewritten',
        title: 'Transport URLs point at the gateway',
        assertion:
          'Every transport URL in the card has the exact scheme, host, port and agent path selected for this gateway run.',
        evidence: 'The card`s `url` and any additional interface URLs.',
        whenNotRun: 'Not run — bypass risk is unverified.',
      },
    ],
    deviations: [
      'The notebook records success from the status code alone and never inspects the card body. This recipe additionally requires every transport URL to match the exact gateway origin and selected agent path.',
    ],
    notes: [
      'A browser can only make this call cross-origin when the gateway returns permissive CORS headers. The card path is a plain GET, so it is the most likely of these recipes to work from a browser, but it is still not assumed.',
    ],
    build(ctx) {
      const base = agentEndpoint(
        { assetType: 'a2a', path: ctx.self('agentPath') },
        {
          gatewayUrl: ctx.get('hub.gatewayUrl'),
          useAssetTypePathPrefix: ctx.get('gatewayAccess.useAssetTypePathPrefix'),
          deployedPath: ctx.self('deployedPath'),
        },
      );
      const cardUrl = agentCardUrl(base, ctx.self('agentCardPath'));
      const apiKeyHeader = ctx.get('gatewayAccess.subscriptionKeyHeader');
      return createExecutionPlan({
        sampleId: 'a2a-agent-card',
        title: 'A2A agent card',
        summary: 'Fetch and inspect the agent card the gateway re-exposes.',
        risk: ctx.risk,
        sourceCells: [21, 22],
        steps: [
          step.http({
            id: 'get-card',
            title: 'GET the agent card',
            detail: 'The card path is subscription-protected like the rest of the asset.',
            request: {
              method: 'GET',
              url: cardUrl,
              headers: {
                [apiKeyHeader]: secretRef('gatewayAccess.apiKey', { label: 'Access-contract api-key' }),
                Accept: 'application/json',
              },
              capture: { status: 'response.status', card: 'response.json' },
              timeoutSeconds: 60,
            },
            produces: ['status', 'card'],
          }),
          step.assertion({
            id: 'assert-card',
            title: 'Confirm the card and its transport URLs',
            detail: 'Any alternate origin, port or path would let a client escape the selected gateway route.',
            assertion: {
              kind: 'a2a-card',
              source: '{{steps.get-card.card}}',
              expectations: [
                'HTTP status is 2xx.',
                'The body parses as JSON.',
                'The card carries `name` and `description`.',
                `Every transport URL has the exact origin and agent path of ${base || 'the selected gateway agent URL'}.`,
                'Alternate hosts, ports, user information, fragments and encoded path forms fail.',
              ],
              endpoint: cardUrl,
              expectedAgentUrl: base,
            },
            produces: ['cardOk'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'a2a-message-send',
    group: 'exercise',
    title: 'A2A message/send through the gateway',
    shortTitle: 'A2A message',
    summary: 'Send a JSON-RPC `message/send` that the gateway proxies to Foundry with its managed identity.',
    purpose:
      'This is the full A2A path: consumer key at the gateway, managed identity from the gateway to Foundry, and an agent response back. It is also the recipe where the notebook`s success criterion is weakest, because a JSON-RPC error arrives inside an HTTP 200.',
    explanation: [
      'The request is a JSON-RPC 2.0 call to the agent base URL with `jsonRpcPath: "/"`, so there is no extra path segment. The `params.message` object must carry `kind: "message"` — Foundry serves A2A v0.3 by default and rejects a message object without it.',
      'The JSON-RPC id must be numeric here for the same reason it must be numeric for MCP. The notebook hard-codes `1`; the `messageId` inside the message is a client-generated correlation id and the notebook uses a random UUID, which makes its request non-reproducible. This recipe exposes it as an input with a fixed default so the generated plan is stable.',
      'A JSON-RPC error is returned with HTTP 200. The notebook checks `rr.status_code < 300` and records a pass, so a response body of `{"jsonrpc":"2.0","id":1,"error":{"code":-32603,...}}` is counted as success. This recipe fails on any `error` member regardless of status, and reports the code and message.',
      'Header handling across the notebook is inconsistent: this cell sends only `Content-Type` and the api-key, while the burst cell also sends `A2A-Version: 1.0`. The version header is exposed here as an optional input, defaulting to the notebook`s behaviour for this cell.',
    ],
    flow: [
      'POST a JSON-RPC `message/send` to the agent base URL with the contract key.',
      'Confirm HTTP 2xx.',
      'Confirm the JSON-RPC body has a `result` and no `error`.',
      'Read the returned message or task from the result.',
    ],
    prerequisites: [
      {
        id: 'identity-granted',
        title: 'The APIM identity has the Foundry role',
        detail: 'The gateway authenticates to Foundry with its managed identity. Without the grant this call fails at the backend with 401 or 403.',
        howTo: 'Run Prepare › Grant the APIM identity Foundry access.',
        links: [LINKS.foundryRbac],
      },
      {
        id: 'a2a-enabled',
        title: 'A2A is enabled on the agent',
        detail: 'Foundry rejects A2A traffic for an agent whose `a2a` protocol configuration was never activated.',
        howTo: 'Run Prepare › Enable incoming A2A on the Foundry agent.',
        links: [LINKS.foundryA2a],
      },
      {
        id: 'key-minted',
        title: 'An access-contract api-key',
        detail:
          'The A2A API is published with `subscriptionRequired: true`, so the gateway rejects the call with 401 before it ever reaches Foundry if no key is presented.',
        howTo: 'Run Publish and grant › Deploy the mixed access contract.',
        links: [LINKS.apimSubscriptions],
      },
    ],
    usesProfiles: ['hub', 'gatewayAccess', 'foundry'],
    fields: [
      {
        name: 'agentPath',
        label: 'Agent path',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'hr-chat-agent',
        help: 'Used when no deployed path is recorded.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 14 asset 3 `path`',
      },
      {
        name: 'deployedPath',
        label: 'Deployed path (authoritative)',
        type: 'string',
        classification: 'derived',
        width: 'id',
        default: '',
        derivedFrom: 'Produced by Publish and grant › Publish the three assets.',
        help: 'The already-prefixed path the deployment reported.',
        howToObtain: 'Copy it from `publishedAssets[].path`.',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 20 `agent_endpoint`',
      },
      {
        name: 'question',
        label: 'Message text',
        type: 'multiline',
        classification: 'sample-default',
        width: 'long',
        default: 'What can you help me with?',
        help: 'The single text part sent in the message.',
        howToObtain: 'Fixed by the notebook (cell 22).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 22 message text',
      },
      {
        name: 'messageId',
        label: 'Message id',
        type: 'string',
        classification: 'sample-default',
        width: 'id',
        default: 'citadel-playground-message-01',
        help: 'Client-generated correlation id. The notebook uses a random UUID, which makes its request different on every run; a fixed value keeps the generated plan reproducible.',
        howToObtain: 'Any stable string. Use a UUID if you need per-request correlation in your own telemetry.',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 22 `str(uuid.uuid4())`',
      },
      {
        name: 'a2aVersionHeader',
        label: 'A2A-Version header',
        type: 'string',
        classification: 'sample-default',
        width: 'num',
        default: '',
        help: 'Left empty to match this notebook cell. The burst cell sends `1.0` for the same endpoint — that inconsistency is a known risk, not a rule.',
        howToObtain: 'Set `1.0` to match cell 31, or leave empty to match cell 22.',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 22 omits it; cell 31 sends `A2A-Version: 1.0`',
      },
    ],
    configuration: [
      ...agentEndpointNeeds({ pathDefault: 'hr-chat-agent' }),
      optional('self:question', 'The text sent as the message part.', 'Falls back to the notebook`s question.'),
      optional(
        'self:messageId',
        'The A2A `messageId` the agent sees on the inbound message.',
        'Falls back to a fixed id so the plan is reproducible; the notebook generates a UUID, which makes its request non-reproducible.',
      ),
      optional(
        'self:a2aVersionHeader',
        'The `A2A-Version` header, which this notebook cell omits and the burst cell sends.',
        'Left blank the header is not sent at all, matching cell 22.',
      ),
    ],
    runtime: {
      dependencies: ['gateway-network'],
      note: 'One JSON-RPC POST. The gateway, not this machine, authenticates to Foundry.',
    },
    risk: {
      level: 'read-only',
      requiresAcknowledgement: true,
      effect:
        'Sends one message to a live agent. No Azure resource changes, but the agent runs an inference and the call is billed and logged.',
      blastRadius: 'One agent invocation.',
      reversibility: 'Not applicable. The agent may retain the interaction in its own thread history.',
      acknowledgementPrompt:
        'Acknowledge that this sends a billed agent message that may remain in the agent thread history.',
    },
    sourceCells: [21, 22],
    sourceNote: 'Cell 22 posts `message/send` and records `results["hr-chat-agent-rpc"]` from the status code alone.',
    expectedResults: [
      {
        id: 'http-ok',
        title: 'HTTP 2xx',
        assertion: 'The gateway accepted the call and reached the backend.',
        evidence: 'The response status.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'no-jsonrpc-error',
        title: 'No JSON-RPC error member',
        assertion:
          'The body has a `result` and no `error`. An HTTP 200 carrying `error` is a failure here, and reports the JSON-RPC code and message.',
        evidence: 'The parsed JSON-RPC body.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'agent-response',
        title: 'The agent produced a response',
        assertion: 'The result carries a message or task, and any message part with `kind: "text"` holds non-empty text.',
        evidence: 'The JSON-RPC result.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'The notebook records this call as a pass whenever the HTTP status is below 300. A JSON-RPC error inside an HTTP 200 is therefore counted as success. This recipe treats it as a failure.',
      'The notebook reports a non-2xx as a warning rather than an error, so the summary can read as passing while the call did not work.',
      'The notebook generates the `messageId` with `uuid.uuid4()`. This recipe uses a fixed default so the plan is reproducible, and says so.',
    ],
    notes: [
      'Foundry serves A2A v0.3 by default, which requires `kind: "message"` inside `params.message`. Omitting it produces a JSON-RPC validation error rather than an HTTP error.',
      'The gateway, not the caller, authenticates to Foundry. A 401 or 403 in the JSON-RPC error is about the APIM identity`s role, not about the api-key.',
    ],
    build(ctx) {
      const base = agentEndpoint(
        { assetType: 'a2a', path: ctx.self('agentPath') },
        {
          gatewayUrl: ctx.get('hub.gatewayUrl'),
          useAssetTypePathPrefix: ctx.get('gatewayAccess.useAssetTypePathPrefix'),
          deployedPath: ctx.self('deployedPath'),
        },
      );
      const apiKeyHeader = ctx.get('gatewayAccess.subscriptionKeyHeader');
      const versionHeader = ctx.self('a2aVersionHeader');
      const headers = {
        'Content-Type': 'application/json',
        [apiKeyHeader]: secretRef('gatewayAccess.apiKey', { label: 'Access-contract api-key' }),
      };
      if (versionHeader) headers['A2A-Version'] = versionHeader;
      return createExecutionPlan({
        sampleId: 'a2a-message-send',
        title: 'A2A message/send through the gateway',
        summary: 'Send one JSON-RPC message to the published agent and judge the JSON-RPC body, not just the status.',
        risk: ctx.risk,
        sourceCells: [21, 22],
        steps: [
          step.http({
            id: 'message-send',
            title: 'POST message/send',
            detail: '`jsonRpcPath` is `/`, so the agent base URL is the JSON-RPC endpoint.',
            request: {
              method: 'POST',
              url: base,
              headers,
              body: {
                jsonrpc: '2.0',
                id: 1,
                method: 'message/send',
                params: {
                  message: {
                    kind: 'message',
                    role: 'user',
                    messageId: ctx.self('messageId'),
                    parts: [{ kind: 'text', text: ctx.self('question') }],
                  },
                },
              },
              capture: {
                status: 'response.status',
                result: 'response.jsonrpc.result',
                error: 'response.jsonrpc.error',
              },
              timeoutSeconds: 120,
            },
            produces: ['status', 'result', 'error'],
          }),
          step.assertion({
            id: 'assert-jsonrpc',
            title: 'Require a JSON-RPC result, not just a 2xx',
            detail: 'An HTTP 2xx with an `error` member is a failure.',
            assertion: {
              kind: 'jsonrpc',
              source: '{{steps.message-send.error}}',
              expectations: [
                'HTTP status is 2xx.',
                'The body has no `error` member. An HTTP 2xx carrying `error` fails, and the code and message are reported.',
                'The body has a `result`.',
                'Any text part in the result holds non-empty text.',
              ],
              endpoint: base,
            },
            produces: ['answered'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'agent-framework-hr-question',
    group: 'exercise',
    title: 'Agent Framework: ask the HR agent',
    shortTitle: 'Agent Framework question',
    summary: 'Resolve the published card with a real A2A client and ask an HR question through the gateway.',
    purpose:
      'The previous recipes prove the protocol works. This one proves the asset is usable by Microsoft Agent Framework without trusting card-selected destinations: the shipped wrapper validates the card, pins every request to the exact gateway agent route, and only then presents the contract key.',
    explanation: [
      'The client is given the server-derived gateway agent URL. A pinned HTTP transport fetches `/.well-known/agent.json`, rejects redirects, validates every advertised JSON-RPC interface against the exact scheme, host, port and agent path, and parses the card before constructing `A2AAgent`.',
      'The contract key is not a default client header. The transport adds it immediately before transmission, after revalidating each GET or POST destination, so a malicious card cannot send the key to another origin or path.',
      'This is a Python step. It needs `agent-framework` and `agent-framework-a2a` at matching versions, plus `httpx`, the `a2a` client package and `nest_asyncio` to run an event loop inside a notebook. There is no browser equivalent, so the default executor reports this recipe as blocked rather than attempting it.',
    ],
    flow: [
      'Derive the approved gateway origin and exact agent path from the server-built agent URL.',
      'Fetch the card without redirects through a transport that validates the card endpoint before adding the key.',
      'Validate every advertised JSON-RPC URL, then schema-parse the card before constructing `A2AAgent`.',
      'Run the question and join the text of the returned messages.',
      'Confirm the joined answer is non-empty and record the validated origin, path and transport URLs.',
    ],
    prerequisites: [
      {
        id: 'python-packages',
        title: 'Agent Framework packages installed and version-aligned',
        detail: '`agent-framework` and `agent-framework-a2a` must be installed together and kept at matching versions.',
        howTo: 'Run `pip install -U agent-framework agent-framework-a2a`, which also pulls the `a2a` client package.',
        links: [LINKS.agentFramework],
      },
      {
        id: 'card-rewritten',
        title: 'The card`s transport URLs point at the gateway',
        detail: 'Every interface must match the exact selected gateway origin and agent path; matching only the hostname is insufficient.',
        howTo: 'Run Exercise › A2A agent card first and check the exact-route assertion.',
        links: [LINKS.foundryA2a],
      },
      {
        id: 'agent-answers',
        title: 'The agent can answer the question',
        detail:
          'The prompt agent must have instructions or grounding that let it respond. An empty answer fails this recipe even though the transport worked.',
        howTo: 'Ask the same question in the Foundry portal playground first.',
        links: [LINKS.foundryA2a],
      },
    ],
    usesProfiles: ['hub', 'gatewayAccess', 'foundry'],
    fields: [
      {
        name: 'agentPath',
        label: 'Agent path',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'hr-chat-agent',
        help: 'Used when no deployed path is recorded.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 14 asset 3 `path`',
      },
      {
        name: 'deployedPath',
        label: 'Deployed path (authoritative)',
        type: 'string',
        classification: 'derived',
        width: 'id',
        default: '',
        derivedFrom: 'Produced by Publish and grant › Publish the three assets.',
        help: 'The already-prefixed path the deployment reported.',
        howToObtain: 'Copy it from `publishedAssets[].path`.',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 28 `agent_endpoint`',
      },
      {
        name: 'question',
        label: 'Question',
        type: 'multiline',
        classification: 'sample-default',
        width: 'long',
        default: 'What is our leave policy?',
        help: 'The question put to the HR agent.',
        howToObtain: 'Fixed by the notebook (cell 28).',
        links: [LINKS.agentFramework],
        notebookRef: 'cell 28 `ask_hr_agent("What is our leave policy?")`',
      },
      {
        name: 'timeoutSeconds',
        label: 'Client timeout (seconds)',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 120,
        min: 5,
        max: 600,
        help: 'HTTP client timeout. An agent turn can take tens of seconds.',
        howToObtain: 'Fixed by the notebook (cell 28 `httpx.AsyncClient(timeout=120.0)`).',
        links: [LINKS.agentFramework],
        notebookRef: 'cell 28 timeout',
      },
    ],
    configuration: [
      ...agentEndpointNeeds({ pathDefault: 'hr-chat-agent' }),
      optional('self:question', 'The question the agent is asked.', 'Falls back to the notebook`s question.'),
      optional(
        'self:timeoutSeconds',
        'HTTP client timeout for the card fetch and the agent turn.',
        'Falls back to 120 seconds, matching the notebook.',
      ),
    ],
    runtime: {
      dependencies: ['python', 'gateway-network'],
      python: {
        packages: ['agent-framework', 'agent-framework-a2a', 'httpx', 'nest_asyncio'],
        modules: ['httpx', 'nest_asyncio', 'a2a.client.card_resolver', 'agent_framework.a2a'],
        install: 'pip install -U agent-framework agent-framework-a2a httpx nest_asyncio',
      },
      note: 'The only recipe here whose client library, rather than this playground, makes the gateway calls.',
    },
    risk: {
      level: 'read-only',
      requiresAcknowledgement: true,
      effect: 'Runs one agent turn. No Azure resource changes; the inference is billed and logged.',
      blastRadius: 'One agent invocation plus one card fetch.',
      reversibility: 'Not applicable.',
      acknowledgementPrompt:
        'Acknowledge that this runs a billed agent inference and records the interaction in service telemetry.',
    },
    sourceCells: [27, 28],
    sourceNote:
      'Cell 28 uses `A2ACardResolver` and `A2AAgent` with an api-key-bearing httpx client. The shipped wrapper deliberately replaces that unsafe global header with an exact-route transport gate before recording the answer.',
    expectedResults: [
      {
        id: 'card-resolved',
        title: 'The card resolves through the gateway',
        assertion: 'The card fetch does not redirect, every advertised JSON-RPC URL matches the exact gateway agent route, and the card schema parses before `A2AAgent` is constructed.',
        evidence: 'The resolved card plus the validated expected origin, agent path and transport URLs.',
        whenNotRun: 'Not run — no Python runtime is attached.',
      },
      {
        id: 'answer-returned',
        title: 'The agent answers',
        assertion: 'The joined text of the returned messages is non-empty after trimming.',
        evidence: 'The response messages.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'through-gateway',
        title: 'Traffic went through the gateway',
        assertion:
          'The transport gate allowed only the exact gateway origin and selected agent path, so the call was subject to the product policy and appears in `a2a-usage` telemetry.',
        evidence: 'The exact expected origin and path, the validated card transport URLs, plus a matching increase in the A2A usage metric.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'The notebook catches every exception, prints an install hint and records a failure. This recipe reports the exception type and message rather than collapsing all causes into one.',
      'The notebook does not verify that the client actually traversed the gateway. This recipe states it as an expected result to be corroborated with the usage metric, and does not claim it from a successful answer alone.',
      'The notebook installs the api-key as a global httpx header before trusting the fetched card. The shipped wrapper instead validates the card and injects the key only at a transport boundary pinned to the exact gateway route.',
    ],
    notes: [
      'This is a `library` step. The shipped executor cannot run Python, so this recipe reports `blocked` until an adapter that supports `library` steps is attached.',
      '`nest_asyncio` is only needed because the notebook calls `asyncio.run` inside an already-running loop. Outside a notebook it can be dropped.',
    ],
    build(ctx) {
      const base = agentEndpoint(
        { assetType: 'a2a', path: ctx.self('agentPath') },
        {
          gatewayUrl: ctx.get('hub.gatewayUrl'),
          useAssetTypePathPrefix: ctx.get('gatewayAccess.useAssetTypePathPrefix'),
          deployedPath: ctx.self('deployedPath'),
        },
      );
      const apiKeyHeader = ctx.get('gatewayAccess.subscriptionKeyHeader');
      const timeout = ctx.self('timeoutSeconds');
      const code = [
        'import os',
        '',
        `agent_url = ${JSON.stringify(base)}`,
        `api_key_header = ${JSON.stringify(apiKeyHeader)}`,
        '# The shipped runtime/python/agent_framework_ask.py wrapper validates the card',
        '# and every outgoing URL before its transport adds this key to that request.',
        'api_key = os.environ["CITADEL_GATEWAY_ACCESS_API_KEY"]',
        `question = ${JSON.stringify(ctx.self('question'))}`,
        `timeout_seconds = ${timeout}`,
        '# The local executor invokes the registered shipped wrapper with these values;',
        '# generated code is never executed and the key is never a default client header.',
      ].join('\n');
      return createExecutionPlan({
        sampleId: 'agent-framework-hr-question',
        title: 'Agent Framework: ask the HR agent',
        summary: 'Validate the published card and answer a question with `A2AAgent` through a pinned transport.',
        risk: ctx.risk,
        sourceCells: [27, 28],
        steps: [
          step.library({
            id: 'ask-agent',
            title: 'Resolve the card and run the question',
            detail: 'The api-key is supplied through the environment and added only after each outgoing URL passes the wrapper`s exact-route validation.',
            library: {
              runtime: 'python>=3.10',
              packages: ['agent-framework', 'agent-framework-a2a', 'httpx', 'nest_asyncio'],
              install: 'pip install -U agent-framework agent-framework-a2a httpx nest_asyncio',
              entry: 'Pinned card fetch + validated A2AAgent.run',
              secretEnv: { CITADEL_GATEWAY_ACCESS_API_KEY: secretRef('gatewayAccess.apiKey') },
              code,
            },
            produces: ['answer', 'card'],
          }),
          step.assertion({
            id: 'assert-answer',
            title: 'Confirm a non-empty answer arrived through the gateway',
            detail: 'A non-empty answer proves the round trip; the usage metric proves it went through the gateway.',
            assertion: {
              kind: 'non-empty',
              source: '{{steps.ask-agent.answer}}',
              expectations: [
                'The card resolved without redirects and every transport URL matched the exact gateway origin and agent path.',
                'The joined answer text is non-empty after trimming.',
                'The wrapper recorded the exact validated origin, path and transport URLs, so the run is attributable to the contract.',
                'Corroborate with the `a2a-usage` metric rather than assuming the route from a successful answer.',
              ],
              endpoint: base,
            },
            produces: ['answered'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'weather-tools-call',
    group: 'exercise',
    title: 'Weather tool: direct tools/call',
    shortTitle: 'Weather tools/call',
    summary: 'Invoke `get-weather` through the gateway and check the payload the mock policy returns.',
    purpose:
      'A successful `tools/list` only proves the tool was projected. This recipe proves the whole chain works: the gateway authorises the caller, the MCP runtime forwards the call to the protected source API with the caller`s key injected into the custom header, and the source API`s mock policy answers.',
    explanation: [
      'Three requests again: `initialize` opens the session, `notifications/initialized` completes the handshake, then `tools/call` sends the tool name and arguments with both session and protocol headers. This is where the key-forwarding design is actually exercised — a failure here after a successful `tools/list` almost always means `weather-api` is not in the same product, so the forwarded key does not authorise the internal hop.',
      'The result arrives as MCP content blocks. The first block`s `text` holds the JSON document the mock policy produced, so it is parsed a second time to reach the fields.',
      'The mock policy has a branch worth asserting. Seattle, New York City and Los Angeles return `temperature_format: "Fahrenheit"`; every other city returns `"Celsius"`. Everything else in the payload is randomised — temperature, description, humidity and wind speed all change per call — so the assertions check field presence, types and the unit branch rather than values.',
    ],
    flow: [
      'POST `initialize`, validate protocol `2025-06-18`, and capture the session id.',
      'POST `notifications/initialized` without an id on that session.',
      'POST `tools/call` with `{ name, arguments }`, the session id, and the protocol version.',
      'Read `result.content[0].text` and parse it as JSON.',
      'Confirm the six expected fields are present and that the temperature unit matches the city.',
    ],
    prerequisites: [
      {
        id: 'source-in-product',
        title: '`weather-api` is in the same product as the tool',
        detail:
          'The forwarded key must authorise the internal hop to the protected source API. Without it, `tools/list` succeeds and `tools/call` fails.',
        howTo: 'The access contract adds forwarded source APIs automatically. Confirm the product`s API list includes `weather-api`.',
        links: [LINKS.apimProduct],
      },
      {
        id: 'forwarding-on',
        title: 'Key forwarding is enabled on the tool',
        detail: '`forwardSubscriptionKeyToSource: true` and a `sourceSubscriptionKeyHeaderName` matching the source API.',
        howTo: 'Both are set by the publish contract. The header must be the same custom name on both sides.',
        links: [LINKS.apimMcp],
      },
    ],
    usesProfiles: ['hub', 'gatewayAccess'],
    fields: [
      ...endpointFieldsFor({
        pathDefault: 'weather-tool-mcp',
        assetType: 'mcp-from-api',
        label: 'Weather tool',
        docLink: LINKS.apimMcp,
      }),
      {
        name: 'toolName',
        label: 'Tool name',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'get-weather',
        help: 'The MCP tool name, which matches the source API operation the publish contract exposed.',
        howToObtain: 'Fixed by the notebook (cell 29). Confirm it appears in `tools/list`.',
        links: [LINKS.apimMcp],
        notebookRef: 'cell 29 `call_mcp_tool(weather_asset, "get-weather", ...)`',
      },
      {
        name: 'city',
        label: 'City',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'London',
        help: 'The single argument. Seattle, New York City and Los Angeles return Fahrenheit; everything else returns Celsius.',
        howToObtain: 'Fixed by the notebook (cell 29 uses `London`). Any city string is accepted by the mock policy.',
        links: [LINKS.apimMcp],
        notebookRef: 'cell 29 `{"city": "London"}`',
      },
    ],
    configuration: [
      ...mcpEndpointNeeds({
        sampleId: 'weather-tools-call',
        label: 'Weather tool',
        pathDefault: 'weather-tool-mcp',
        suffixNote: 'An API→MCP server is served at `{gateway}/mcp/{path}/mcp`.',
      }),
      optional('self:toolName', 'The MCP tool invoked.', 'Falls back to `get-weather`, the single operation the contract exposed.'),
      optional(
        'self:city',
        'The one argument, and the value the unit assertion branches on.',
        'Falls back to `London`, which the mock policy answers in Celsius.',
      ),
    ],
    runtime: {
      dependencies: ['gateway-network'],
      note: 'Three HTTPS requests: `initialize`, `notifications/initialized`, then `tools/call` on the returned session.',
    },
    risk: {
      level: 'read-only',
      effect: 'Invokes a tool that returns synthetic data from a mock policy. No real backend is called and nothing is changed.',
      blastRadius: 'Three requests, counted against the tool rate limit.',
      reversibility: 'Not applicable.',
    },
    sourceCells: [29],
    sourceNote:
      'Cell 29 defines `call_mcp_tool`, invokes `get-weather` for London, prints the first content block and records `results["weather-tool-toolcall"]` from whether content was returned.',
    expectedResults: [
      {
        id: 'call-succeeds',
        title: 'The tool call returns content',
        assertion: 'HTTP 2xx, a JSON-RPC `result` with no `error`, and a non-empty `result.content` array.',
        evidence: 'The tools/call response.',
        whenNotRun: 'Not run — the forwarding path is unverified.',
      },
      {
        id: 'payload-fields',
        title: 'The payload carries the expected fields',
        assertion:
          '`result.content[0].text` parses as JSON holding `city`, `temperature`, `temperature_format`, `description`, `humidity` and `wind_speed`.',
        evidence: 'The parsed payload.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'unit-branch',
        title: 'The temperature unit matches the city',
        assertion:
          'Seattle, New York City and Los Angeles return `Fahrenheit`; every other city returns `Celsius`. This is the branch in the accelerator`s mock policy.',
        evidence: 'The `temperature_format` field.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'echoed-city',
        title: 'The city is echoed back',
        assertion: 'The `city` field equals the argument sent, confirming the argument reached the source API.',
        evidence: 'The `city` field.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'The notebook records success from `bool(content)` alone, so an error string returned as a content block would count as a pass. This recipe parses the payload and asserts the field set and the unit branch.',
      'The notebook falls back to `json.dumps(out)` when there is no content, printing whatever came back without changing the recorded result.',
    ],
    notes: [
      'Everything except `city` and `temperature_format` is randomised by the mock policy, so value assertions would be flaky by construction. Presence, type and the unit branch are the stable properties.',
      'A `tools/call` that fails with 401 after a successful `tools/list` points at product membership for `weather-api`, not at the MCP server.',
    ],
    build(ctx) {
      const endpoint = mcpEndpoint(
        { assetType: 'mcp-from-api', path: ctx.self('assetPath') },
        {
          gatewayUrl: ctx.get('hub.gatewayUrl'),
          useAssetTypePathPrefix: ctx.get('gatewayAccess.useAssetTypePathPrefix'),
          deployedEndpoint: ctx.self('deployedEndpoint'),
        },
      );
      const apiKeyHeader = ctx.get('gatewayAccess.subscriptionKeyHeader');
      const city = ctx.self('city');
      const expectedUnit = FAHRENHEIT_CITIES.some((name) => name.toLowerCase() === String(city).toLowerCase())
        ? 'Fahrenheit'
        : 'Celsius';
      return createExecutionPlan({
        sampleId: 'weather-tools-call',
        title: 'Weather tool: direct tools/call',
        summary: 'Open a session, invoke `get-weather`, and check the returned payload.',
        risk: ctx.risk,
        sourceCells: [29],
        steps: [
          mcpInitializeStep({ endpoint, apiKeyHeader, jsonRpcId: 1 }),
          mcpInitializedStep({ endpoint, apiKeyHeader }),
          mcpCallStep({
            id: 'tools-call',
            endpoint,
            apiKeyHeader,
            method: 'tools/call',
            params: { name: ctx.self('toolName'), arguments: { city } },
            jsonRpcId: 2,
            title: 'MCP tools/call',
            detail: 'The gateway injects the caller`s key into the source API`s custom header for the internal hop.',
            produces: ['status', 'result', 'content'],
          }),
          step.assertion({
            id: 'assert-weather',
            title: 'Parse the payload and check its shape',
            detail: 'Values are randomised by the mock policy, so presence, type and the unit branch are what is asserted.',
            assertion: {
              kind: 'weather-payload',
              source: '{{steps.tools-call.content}}',
              expectations: [
                '`result.content` is a non-empty array and `content[0].text` parses as JSON.',
                'The payload holds `city`, `temperature`, `temperature_format`, `description`, `humidity` and `wind_speed`.',
                `\`city\` equals "${city}".`,
                `\`temperature_format\` is "${expectedUnit}" for "${city}".`,
                '`temperature` and `wind_speed` are numbers; `humidity` is a number.',
                'Values other than `city` and `temperature_format` are randomised and are not asserted.',
              ],
              expectedFields: ['city', 'temperature', 'temperature_format', 'description', 'humidity', 'wind_speed'],
              expectedUnit,
              fahrenheitCities: FAHRENHEIT_CITIES,
              endpoint,
            },
            produces: ['payload'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },
];
