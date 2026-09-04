/**
 * Policy — cell 31.
 *
 * Two load-generating recipes that prove the access contract's product policy
 * branched on asset kind, by deliberately tripping the Tool and Agent
 * request-based rate limits.
 */

import { step, createExecutionPlan } from '../../core/plan.mjs';
import { agentEndpoint, mcpEndpoint } from '../../core/endpoints.mjs';
import { mcpHeaders, mcpPayload, initializeParams } from '../../core/mcp.mjs';
import { secretRef } from '../../core/secrets.mjs';
import { LINKS } from '../profiles.mjs';

const CONFIRM_FIELD = {
  name: 'confirmNonProduction',
  label: 'This gateway is not production',
  type: 'boolean',
  classification: 'required',
  default: false,
  mustEqual: true,
  mustEqualMessage:
    'Confirm the target gateway is a non-production environment before generating a burst plan. Bursting a shared gateway throttles other consumers on the same product.',
  help: 'A burst deliberately exhausts a rate limit. Every other caller on the same subscription counter is throttled while the window is open.',
  howToObtain: 'Only you can confirm this. It is not derived from anything.',
  links: [LINKS.apimRateLimitByKey],
  notebookRef: 'no notebook equivalent — the notebook bursts without confirmation',
};

const SHARED_NOTES = [
  'Throttled calls never reach the backend, so a burst does not multiply backend cost. It does consume the contract`s quota and it does throttle every other caller sharing the counter.',
  'The counter key is the APIM subscription id plus an asset-kind suffix, so the Tool and Agent limits are independent of each other.',
  'The rate limit renews every 60 seconds. Wait a full renewal period between runs, or the second run starts already throttled and proves nothing.',
];

export const POLICY_SAMPLES = [
  {
    id: 'tool-rate-limit-burst',
    group: 'policy',
    title: 'Tool rate-limit burst',
    shortTitle: 'Tool burst',
    summary: 'Send more MCP `initialize` calls than the tool limit allows and confirm the gateway returns 429.',
    purpose:
      'The `MULTI-` product applies different controls to different asset kinds. The only way to prove the Tool branch actually ran — rather than the LLM branch, or no branch at all — is to exceed the Tool limit and see a request-based 429 rather than a token-based one.',
    explanation: [
      'The product policy sets an `assetKind` variable with the `set-asset-kind` fragment and then branches. The Tool branch applies `rate-limit-by-key` with a per-minute call count and a counter keyed on the subscription id plus `:tool`. A 429 from a burst of plain requests is evidence that this branch, and not the LLM token limit, was applied.',
      'The burst sends the same `initialize` payload repeatedly, in parallel. The default is fifteen more calls than the limit allows, which is the notebook`s `TOOL_CALLS_PER_MIN + 15`, at a concurrency of ten. That margin exists because a few calls can land in the previous window.',
      'Nothing here asserts a precise number of 429s. Rate-limit counters are distributed and windows are wall-clock, so the stable property is "at least one call was throttled". A run with zero 429s means either the limit is higher than configured, the branch did not apply, or the window had already reset.',
      'Every call in the burst is billed and logged, and each one increments the contract quota. On a shared gateway the throttling is felt by every other consumer holding the same subscription key.',
    ],
    flow: [
      'Confirm the target gateway is not production.',
      'Compose one MCP `initialize` request against the tool endpoint.',
      'Send it N times with a fixed concurrency.',
      'Count the status codes and confirm at least one 429 came back.',
    ],
    prerequisites: [
      {
        id: 'contract-deployed',
        title: 'The access contract is deployed with the Tool branch',
        detail: 'Without the product policy there is no rate limit to trip and the burst simply succeeds.',
        howTo: 'Run Publish and grant › Deploy the mixed access contract.',
        links: [LINKS.apimRateLimitByKey],
      },
      {
        id: 'limit-matches',
        title: 'The configured limit matches the deployed one',
        detail: 'The burst size is derived from the Policy profile`s tool limit. If the deployed policy uses a different number the burst may be too small.',
        howTo: 'Check the deployed product policy in the APIM portal, or re-read the generated `ai-product-policy.xml`.',
        links: [LINKS.apimRateLimitByKey],
      },
      {
        id: 'quiet-window',
        title: 'A quiet rate-limit window',
        detail: 'Run at least 60 seconds after any other traffic on the same key, so the count starts from zero.',
        howTo: 'Wait a full renewal period between runs.',
        links: [LINKS.apimRateLimitByKey],
      },
    ],
    usesProfiles: ['hub', 'gatewayAccess', 'policy'],
    fields: [
      CONFIRM_FIELD,
      {
        name: 'assetPath',
        label: 'Tool path',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'weather-tool-mcp',
        help: 'Used when no deployed endpoint is recorded. The notebook bursts the first tool asset, which is the Weather Tool.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.apimMcp],
        notebookRef: 'cell 31 `tool_asset`',
      },
      {
        name: 'deployedEndpoint',
        label: 'Deployed endpoint (authoritative)',
        type: 'url',
        classification: 'derived',
        width: 'long',
        default: '',
        derivedFrom: 'Produced by Publish and grant › Publish the three assets.',
        help: 'The endpoint the deployment reported. When set it wins over the composed path.',
        howToObtain: 'Copy it from `publishedAssets[].endpoint`.',
        links: [LINKS.apimMcp],
        notebookRef: 'cell 31 `mcp_endpoint(tool_asset)`',
      },
      {
        name: 'requestCount',
        label: 'Requests to send',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 35,
        min: 2,
        max: 200,
        help: 'The notebook sends the tool limit plus 15. With the default limit of 20 calls per minute, that is 35.',
        howToObtain: 'Fixed by the notebook (cell 31 `TOOL_CALLS_PER_MIN + 15`).',
        links: [LINKS.apimRateLimitByKey],
        notebookRef: 'cell 31 `_burst(ep, hdr, body, TOOL_CALLS_PER_MIN + 15)`',
      },
      {
        name: 'concurrency',
        label: 'Concurrency',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 10,
        min: 1,
        max: 50,
        help: 'Parallel workers. The notebook uses a thread pool of ten.',
        howToObtain: 'Fixed by the notebook (cell 31 `ThreadPoolExecutor(max_workers=10)`).',
        links: [LINKS.apimRateLimitByKey],
        notebookRef: 'cell 31 `max_workers=10`',
      },
      {
        name: 'timeoutSeconds',
        label: 'Per-request timeout (seconds)',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 30,
        min: 1,
        max: 120,
        help: 'A request that times out is recorded as -1 by the notebook and is neither a success nor a 429.',
        howToObtain: 'Fixed by the notebook (cell 31 `timeout=30`).',
        links: [LINKS.apimRateLimitByKey],
        notebookRef: 'cell 31 `timeout=30`',
      },
    ],
    risk: {
      level: 'load-generating',
      effect:
        'Sends many requests in a short window and deliberately exhausts the tool rate limit. Every caller sharing the subscription counter is throttled until the window renews.',
      blastRadius:
        'Everyone holding the same contract key, for up to one renewal period. Quota consumption and usage telemetry are permanent.',
      reversibility:
        'The rate limit resets after 60 seconds. The quota consumption and the telemetry are not reversible.',
      acknowledgementPrompt:
        'This deliberately exhausts a live rate limit and throttles every caller sharing this contract key for up to a minute. Confirm you are targeting a non-production gateway.',
    },
    sourceCells: [30, 31],
    sourceNote:
      'Cell 31 bursts the first tool asset with `initialize` payloads and records `results["tool-rate-limit-429"]` when any call returned 429.',
    expectedResults: [
      {
        id: 'throttled',
        title: 'At least one call is throttled',
        assertion: 'At least one response carries HTTP 429. Zero 429s fails.',
        evidence: 'The status-code histogram.',
        whenNotRun: 'Not run — the Tool branch is unproven.',
      },
      {
        id: 'branch-proved',
        title: 'The Tool branch applied',
        assertion:
          'A request-based 429 with no token accounting shows the Tool branch ran, not the LLM branch`s `llm-token-limit`.',
        evidence: 'The 429 responses and the absence of token-limit headers.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'shape-sane',
        title: 'The result shape is plausible',
        assertion:
          'Roughly the configured limit succeeds and the remainder is throttled. Exact counts are not asserted: the counter is distributed and the window is wall-clock.',
        evidence: 'The status-code histogram.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'errors-visible',
        title: 'Transport errors are distinguished',
        assertion: 'A timeout or connection error is reported separately, not folded into "not throttled".',
        evidence: 'The error count.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'The notebook bursts a live gateway with no confirmation step. This recipe requires an explicit non-production confirmation and a per-run acknowledgement before a plan can be executed.',
      'The notebook reports zero 429s with a warning and records `False`. This recipe reports it as a failure and names the three likely causes.',
      'The notebook collapses transport errors into a status code of -1. This recipe counts them separately so a network failure is not mistaken for a successful unthrottled call.',
    ],
    notes: SHARED_NOTES,
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
      const limit = ctx.get('policy.toolCallsPerMinute');
      const count = ctx.self('requestCount');
      return createExecutionPlan({
        sampleId: 'tool-rate-limit-burst',
        title: 'Tool rate-limit burst',
        summary: `Send ${count} MCP initialize calls against a ${limit}/minute tool limit and require a 429.`,
        risk: ctx.risk,
        sourceCells: [30, 31],
        steps: [
          step.assertion({
            id: 'confirm-target',
            title: 'Confirm the target is not production',
            detail: 'Checked before any request is composed, not after.',
            assertion: {
              kind: 'guard',
              source: 'inputs.confirmNonProduction',
              expectations: [
                'The non-production confirmation is checked.',
                'The per-run acknowledgement has been given for this exact configuration.',
                `The gateway is ${ctx.get('hub.gatewayUrl') || '(not yet configured)'}.`,
              ],
            },
            produces: ['confirmed'],
          }),
          step.http({
            id: 'burst',
            title: `Send ${count} identical initialize requests`,
            detail: `Concurrency ${ctx.self('concurrency')}. Throttled calls never reach the backend.`,
            request: {
              method: 'POST',
              url: endpoint,
              headers: mcpHeaders({ apiKeyHeader }),
              body: mcpPayload({ id: 1, method: 'initialize', params: initializeParams({ clientInfo: { name: 'burst', version: '1.0' } }) }),
              repeat: {
                count,
                concurrency: ctx.self('concurrency'),
                timeoutSeconds: ctx.self('timeoutSeconds'),
                identical: true,
              },
              capture: { statusCodes: 'response.status[]', errors: 'transport.errors' },
            },
            produces: ['statusCodes', 'errors'],
          }),
          step.assertion({
            id: 'assert-throttled',
            title: 'Require at least one 429',
            detail: 'Exact counts are not asserted; the presence of throttling is.',
            assertion: {
              kind: 'rate-limit',
              source: '{{steps.burst.statusCodes}}',
              expectations: [
                'At least one response is HTTP 429.',
                `Roughly ${limit} calls succeed and the remainder are throttled; exact counts are not asserted.`,
                'A request-based 429 shows the Tool branch applied, not the LLM token limit.',
                'Zero 429s fails, and points at a different deployed limit, a branch that did not apply, or a window that had already reset.',
                'Transport errors are counted separately from throttled calls.',
              ],
              limitPerMinute: limit,
              requestCount: count,
              concurrency: ctx.self('concurrency'),
              endpoint,
            },
            produces: ['throttled'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'agent-rate-limit-burst',
    group: 'policy',
    title: 'Agent rate-limit burst',
    shortTitle: 'Agent burst',
    summary: 'Send more A2A `message/send` calls than the agent limit allows and confirm the gateway returns 429.',
    purpose:
      'The mirror image of the tool burst, against the Agent branch. Its limit is lower and its counter is separate, so tripping it proves the policy really is branching per asset kind rather than applying one shared limit to everything.',
    explanation: [
      'The Agent branch applies `rate-limit-by-key` with its own call count and a counter keyed on the subscription id plus `:agent`. Because the counters differ, exhausting the tool limit does not throttle the agent, and that independence is part of what this pair of recipes demonstrates.',
      'This burst is more expensive than the tool burst in one specific way: calls that are *not* throttled reach Foundry and run a real agent turn. The notebook`s default of the agent limit plus fifteen means roughly ten real inferences per run. Keep the count low and the target non-production.',
      'This cell sends an `A2A-Version: 1.0` header that cell 22 does not send for the same endpoint. That inconsistency is preserved here as an editable input rather than silently normalised, because which of the two is correct depends on the A2A version your Foundry agent serves.',
      'As with the tool burst, only the presence of a 429 is asserted. The distributed counter and the wall-clock window make exact counts unreliable.',
    ],
    flow: [
      'Confirm the target gateway is not production.',
      'Compose one A2A `message/send` request against the agent endpoint.',
      'Send it N times with a fixed concurrency.',
      'Count the status codes and confirm at least one 429 came back.',
    ],
    prerequisites: [
      {
        id: 'contract-deployed',
        title: 'The access contract is deployed with the Agent branch',
        detail: 'Without the product policy there is no agent rate limit to trip.',
        howTo: 'Run Publish and grant › Deploy the mixed access contract.',
        links: [LINKS.apimRateLimitByKey],
      },
      {
        id: 'agent-reachable',
        title: 'The agent answers through the gateway',
        detail: 'Unthrottled calls run real agent turns. If the agent is broken you get errors instead of 429s and learn nothing.',
        howTo: 'Run Exercise › A2A message/send once first.',
        links: [LINKS.foundryA2a],
      },
      {
        id: 'cost-awareness',
        title: 'Accepted inference cost',
        detail: 'Roughly the agent limit`s worth of real inferences run per burst.',
        howTo: 'Lower the request count if that is not acceptable, while keeping it above the limit.',
        links: [LINKS.apimRateLimitByKey],
      },
    ],
    usesProfiles: ['hub', 'gatewayAccess', 'foundry', 'policy'],
    fields: [
      CONFIRM_FIELD,
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
        notebookRef: 'cell 31 `agent_endpoint(...)`',
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
        notebookRef: 'cell 31 `agent_endpoint`',
      },
      {
        name: 'requestCount',
        label: 'Requests to send',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 25,
        min: 2,
        max: 200,
        help: 'The notebook sends the agent limit plus 15. With the default limit of 10 calls per minute, that is 25.',
        howToObtain: 'Fixed by the notebook (cell 31 `AGENT_CALLS_PER_MIN + 15`).',
        links: [LINKS.apimRateLimitByKey],
        notebookRef: 'cell 31 `_burst(agent_base, hdr, body, AGENT_CALLS_PER_MIN + 15)`',
      },
      {
        name: 'concurrency',
        label: 'Concurrency',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 10,
        min: 1,
        max: 50,
        help: 'Parallel workers. The notebook uses a thread pool of ten.',
        howToObtain: 'Fixed by the notebook (cell 31 `max_workers=10`).',
        links: [LINKS.apimRateLimitByKey],
        notebookRef: 'cell 31 `max_workers=10`',
      },
      {
        name: 'timeoutSeconds',
        label: 'Per-request timeout (seconds)',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 30,
        min: 1,
        max: 300,
        help: 'A real agent turn can exceed 30 seconds, so unthrottled calls in this burst may time out. That is a transport error, not a throttle.',
        howToObtain: 'Fixed by the notebook (cell 31 `timeout=30`).',
        links: [LINKS.apimRateLimitByKey],
        notebookRef: 'cell 31 `timeout=30`',
      },
      {
        name: 'messageText',
        label: 'Message text',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'ping',
        help: 'Deliberately short: unthrottled calls run a real agent turn, so a minimal prompt keeps the cost down.',
        howToObtain: 'Fixed by the notebook (cell 31).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 31 burst body text',
      },
      {
        name: 'messageId',
        label: 'Message id',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'burst',
        help: 'The same id on every request in the burst, as the notebook does.',
        howToObtain: 'Fixed by the notebook (cell 31 `"messageId": "burst"`).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 31 `messageId`',
      },
      {
        name: 'a2aVersionHeader',
        label: 'A2A-Version header',
        type: 'string',
        classification: 'sample-default',
        width: 'num',
        default: '1.0',
        help: 'Cell 31 sends this header; cell 22 does not, for the same endpoint. Which is correct depends on the A2A version your agent serves.',
        howToObtain: 'Fixed by the notebook (cell 31 `"A2A-Version": "1.0"`).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 31 `A2A-Version`',
      },
    ],
    risk: {
      level: 'load-generating',
      effect:
        'Sends many requests in a short window, deliberately exhausts the agent rate limit, and runs real agent inferences for the calls that are not throttled.',
      blastRadius:
        'Everyone holding the same contract key, for up to one renewal period, plus the inference cost of the unthrottled calls.',
      reversibility: 'The rate limit resets after 60 seconds. Inference cost, quota consumption and telemetry are not reversible.',
      acknowledgementPrompt:
        'This exhausts a live agent rate limit and runs real inferences for the calls that get through. Confirm you accept the cost and are targeting a non-production gateway.',
    },
    sourceCells: [30, 31],
    sourceNote:
      'Cell 31 bursts the agent endpoint with `message/send` payloads and records `results["agent-rate-limit-429"]` when any call returned 429.',
    expectedResults: [
      {
        id: 'throttled',
        title: 'At least one call is throttled',
        assertion: 'At least one response carries HTTP 429. Zero 429s fails.',
        evidence: 'The status-code histogram.',
        whenNotRun: 'Not run — the Agent branch is unproven.',
      },
      {
        id: 'branch-independent',
        title: 'The Agent counter is independent of the Tool counter',
        assertion:
          'The agent limit trips at its own, lower threshold even if the tool limit was exhausted moments earlier, because the counter keys differ.',
        evidence: 'Comparing the two bursts` histograms.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'errors-visible',
        title: 'Timeouts are distinguished from throttling',
        assertion:
          'An unthrottled call that exceeds the timeout is reported as a transport error, not as a successful or a throttled call.',
        evidence: 'The error count.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'The notebook bursts a live agent with no confirmation. This recipe requires an explicit non-production confirmation plus a per-run acknowledgement.',
      'The notebook sends `A2A-Version: 1.0` here but omits it in cell 22 for the same endpoint. The header is exposed as an input and the inconsistency is stated rather than resolved.',
      'The notebook records a -1 for any exception. This recipe counts transport errors separately, which matters here because a real agent turn can exceed the 30-second timeout.',
    ],
    notes: [
      ...SHARED_NOTES,
      'Unthrottled calls in this burst run real agent inferences. The tool burst does not have that property, because its unthrottled calls only reach a mock policy.',
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
      const limit = ctx.get('policy.agentCallsPerMinute');
      const count = ctx.self('requestCount');
      const headers = {
        'Content-Type': 'application/json',
        [apiKeyHeader]: secretRef('gatewayAccess.apiKey', { label: 'Access-contract api-key' }),
      };
      const versionHeader = ctx.self('a2aVersionHeader');
      if (versionHeader) headers['A2A-Version'] = versionHeader;
      return createExecutionPlan({
        sampleId: 'agent-rate-limit-burst',
        title: 'Agent rate-limit burst',
        summary: `Send ${count} A2A message/send calls against a ${limit}/minute agent limit and require a 429.`,
        risk: ctx.risk,
        sourceCells: [30, 31],
        steps: [
          step.assertion({
            id: 'confirm-target',
            title: 'Confirm the target is not production',
            detail: 'Checked before any request is composed, and before any real inference is paid for.',
            assertion: {
              kind: 'guard',
              source: 'inputs.confirmNonProduction',
              expectations: [
                'The non-production confirmation is checked.',
                'The per-run acknowledgement has been given for this exact configuration.',
                `Roughly ${limit} real agent inferences will run per burst.`,
              ],
            },
            produces: ['confirmed'],
          }),
          step.http({
            id: 'burst',
            title: `Send ${count} identical message/send requests`,
            detail: `Concurrency ${ctx.self('concurrency')}. Calls that are not throttled run a real agent turn.`,
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
                    parts: [{ kind: 'text', text: ctx.self('messageText') }],
                  },
                },
              },
              repeat: {
                count,
                concurrency: ctx.self('concurrency'),
                timeoutSeconds: ctx.self('timeoutSeconds'),
                identical: true,
              },
              capture: { statusCodes: 'response.status[]', errors: 'transport.errors' },
            },
            produces: ['statusCodes', 'errors'],
          }),
          step.assertion({
            id: 'assert-throttled',
            title: 'Require at least one 429',
            detail: 'The agent counter is separate from the tool counter, so this trips at its own threshold.',
            assertion: {
              kind: 'rate-limit',
              source: '{{steps.burst.statusCodes}}',
              expectations: [
                'At least one response is HTTP 429.',
                `Roughly ${limit} calls succeed and the remainder are throttled; exact counts are not asserted.`,
                'The agent counter key differs from the tool counter key, so the two limits are independent.',
                'Timeouts on unthrottled calls are transport errors, not throttling.',
                'Zero 429s fails.',
              ],
              limitPerMinute: limit,
              requestCount: count,
              concurrency: ctx.self('concurrency'),
              endpoint: base,
            },
            produces: ['throttled'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },
];
