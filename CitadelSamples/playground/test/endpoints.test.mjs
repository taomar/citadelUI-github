/**
 * Endpoint derivation.
 *
 * The prefix rule and the suffix rule are the two things most easily got
 * wrong, and getting either wrong produces a 404 that looks like a publishing
 * failure rather than an addressing one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  agentCardUrl,
  agentEndpoint,
  apimBackendResourceUri,
  apimServiceResourceId,
  foundryAgentCardBackendUrl,
  foundryAgentJsonRpcBackendUrl,
  foundryAgentPatchUrl,
  foundryProjectBaseUrl,
  foundryProjectResourceId,
  joinUrl,
  mcpEndpoint,
  prefixedPath,
  trimSlashes,
  trimTrailingSlash,
} from '../src/core/endpoints.mjs';

const GATEWAY = 'https://apim-citadel.azure-api.net';

const WEATHER = { assetType: 'mcp-from-api', path: 'weather-tool-mcp', name: 'weather-tool' };
const LEARN = { assetType: 'mcp-existing', path: 'ms-learn-tool-mcp', name: 'ms-learn-tool' };
const AGENT = { assetType: 'a2a', path: 'hr-chat-agent', name: 'hr-chat-agent' };

test('the asset-type prefix is applied per type when the toggle is on', () => {
  assert.equal(prefixedPath(WEATHER), 'mcp/weather-tool-mcp');
  assert.equal(prefixedPath(LEARN), 'mcp/ms-learn-tool-mcp');
  assert.equal(prefixedPath(AGENT), 'agent/hr-chat-agent');
});

test('the prefix is dropped when the toggle is off', () => {
  const off = { useAssetTypePathPrefix: false };
  assert.equal(prefixedPath(WEATHER, off), 'weather-tool-mcp');
  assert.equal(prefixedPath(LEARN, off), 'ms-learn-tool-mcp');
  assert.equal(prefixedPath(AGENT, off), 'hr-chat-agent');
});

test('an explicit per-asset pathPrefix overrides the asset-type default', () => {
  assert.equal(prefixedPath({ ...WEATHER, pathPrefix: '' }), 'weather-tool-mcp');
  assert.equal(prefixedPath({ ...WEATHER, pathPrefix: 'tools' }), 'tools/weather-tool-mcp');
});

test('only an API to MCP server carries the trailing /mcp suffix', () => {
  assert.equal(mcpEndpoint(WEATHER, { gatewayUrl: GATEWAY }), `${GATEWAY}/mcp/weather-tool-mcp/mcp`);
  assert.equal(mcpEndpoint(LEARN, { gatewayUrl: GATEWAY }), `${GATEWAY}/mcp/ms-learn-tool-mcp`);
});

test('the prefix and suffix rules combine correctly with the toggle off', () => {
  const off = { gatewayUrl: GATEWAY, useAssetTypePathPrefix: false };
  assert.equal(mcpEndpoint(WEATHER, off), `${GATEWAY}/weather-tool-mcp/mcp`);
  assert.equal(mcpEndpoint(LEARN, off), `${GATEWAY}/ms-learn-tool-mcp`);
});

test('a deployment-reported endpoint always wins over a composed one', () => {
  const reported = 'https://custom.contoso.com/mcp/weather-tool-mcp/mcp';
  assert.equal(mcpEndpoint(WEATHER, { gatewayUrl: GATEWAY, deployedEndpoint: reported }), reported);
  assert.equal(
    mcpEndpoint(WEATHER, { gatewayUrl: GATEWAY, deployedEndpoint: `${reported}/` }),
    reported,
    'a trailing slash on the reported endpoint is normalised away',
  );
});

test('the agent base uses the agent prefix and the card hangs off it', () => {
  const base = agentEndpoint(AGENT, { gatewayUrl: GATEWAY });
  assert.equal(base, `${GATEWAY}/agent/hr-chat-agent`);
  assert.equal(agentCardUrl(base), `${GATEWAY}/agent/hr-chat-agent/.well-known/agent.json`);
  assert.equal(agentCardUrl(base, 'custom/card.json'), `${GATEWAY}/agent/hr-chat-agent/custom/card.json`);
});

test('a deployment-reported agent path is already prefixed and is used as-is', () => {
  assert.equal(
    agentEndpoint(AGENT, { gatewayUrl: GATEWAY, deployedPath: 'agent/hr-chat-agent' }),
    `${GATEWAY}/agent/hr-chat-agent`,
  );
  assert.equal(
    agentEndpoint(AGENT, { gatewayUrl: GATEWAY, deployedPath: '/agent/hr-chat-agent/' }),
    `${GATEWAY}/agent/hr-chat-agent`,
  );
});

test('joins never produce a double slash, however the parts are punctuated', () => {
  assert.equal(joinUrl('https://x.test/', '/a/', '/b'), 'https://x.test/a/b');
  assert.equal(joinUrl('https://x.test', '', 'b'), 'https://x.test/b');
  assert.equal(joinUrl('https://x.test/'), 'https://x.test');
  assert.equal(trimTrailingSlash('https://x.test///'), 'https://x.test');
  assert.equal(trimSlashes('///a///'), 'a');
});

test('Foundry data-plane URLs follow the documented shapes', () => {
  const coords = { accountName: 'aif-x', projectName: 'proj-y', agentName: 'HR-ChatAgent' };
  assert.equal(foundryProjectBaseUrl(coords), 'https://aif-x.services.ai.azure.com/api/projects/proj-y');
  assert.equal(
    foundryAgentCardBackendUrl(coords),
    'https://aif-x.services.ai.azure.com/api/projects/proj-y/agents/HR-ChatAgent/endpoint/protocols/a2a/agentCard/v1.0',
  );
  assert.equal(
    foundryAgentJsonRpcBackendUrl(coords),
    'https://aif-x.services.ai.azure.com/api/projects/proj-y/agents/HR-ChatAgent/endpoint/protocols/a2a',
  );
  assert.equal(
    foundryAgentPatchUrl(coords),
    'https://aif-x.services.ai.azure.com/api/projects/proj-y/agents/HR-ChatAgent?api-version=v1',
  );
});

test('the Foundry project scope is the account id plus /projects/<project>', () => {
  const accountResourceId = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aif-x';
  assert.equal(foundryProjectResourceId({ accountResourceId, projectName: 'proj-y' }), `${accountResourceId}/projects/proj-y`);
  assert.equal(foundryProjectResourceId({ accountResourceId: '', projectName: 'proj-y' }), '');
});

test('APIM resource ids and backend URIs are composed correctly', () => {
  const coords = { subscriptionId: 'sub', resourceGroupName: 'rg', apimName: 'apim' };
  assert.equal(
    apimServiceResourceId(coords),
    '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim',
  );
  assert.equal(
    apimBackendResourceUri(coords, 'ms-learn-tool-backend'),
    '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim/backends/ms-learn-tool-backend?api-version=2024-06-01-preview',
  );
});
