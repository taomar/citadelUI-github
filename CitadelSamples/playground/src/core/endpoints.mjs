/**
 * Endpoint derivation.
 *
 * The notebook computes gateway endpoints in three places (cells 20, 22, 29,
 * 31) with the same two rules, and prefers the authoritative `endpoint` the
 * deployment returned when it has one. Those rules live here once so the
 * builders and the tests cannot drift apart.
 *
 * Rule 1 — prefix. With `useAssetTypePathPrefix = true` (the publish-contract
 * default) tools are served under `mcp/` and agents under `agent/`.
 * Rule 2 — suffix. APIM appends `/mcp` to an API→MCP server (`mcp-from-api`)
 * but not to a native/remote MCP server (`mcp-existing`).
 */

import { ASSET_TYPE_PREFIX } from './types.mjs';

/** Strip trailing slashes so joins never produce `//`. */
export function trimTrailingSlash(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\/+$/, '');
}

/** Strip leading and trailing slashes from a path segment. */
export function trimSlashes(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function joinUrl(base, ...segments) {
  const head = trimTrailingSlash(base);
  const tail = segments
    .map((segment) => trimSlashes(String(segment ?? '')))
    .filter((segment) => segment.length > 0)
    .join('/');
  return tail ? `${head}/${tail}` : head;
}

/**
 * `mcp/weather-tool-mcp` when the prefix toggle is on, `weather-tool-mcp`
 * when it is off or the asset carries an explicit empty `pathPrefix`.
 */
export function prefixedPath(asset, { useAssetTypePathPrefix = true } = {}) {
  const path = trimSlashes(asset?.path ?? '');
  if (!useAssetTypePathPrefix) return path;
  if (asset && Object.prototype.hasOwnProperty.call(asset, 'pathPrefix')) {
    const explicit = trimSlashes(asset.pathPrefix ?? '');
    return explicit ? `${explicit}/${path}` : path;
  }
  const prefix = ASSET_TYPE_PREFIX[asset?.assetType] ?? '';
  return prefix ? `${prefix}/${path}` : path;
}

/**
 * Endpoint for an MCP tool server.
 *
 * `deployedEndpoint` is the value the publish deployment returned in
 * `publishedAssets[].endpoint`. The notebook prefers it, and so does this.
 */
export function mcpEndpoint(asset, { gatewayUrl, useAssetTypePathPrefix = true, deployedEndpoint = '' } = {}) {
  const authoritative = trimTrailingSlash(deployedEndpoint);
  if (authoritative) return authoritative;
  const base = joinUrl(gatewayUrl, prefixedPath(asset, { useAssetTypePathPrefix }));
  return asset?.assetType === 'mcp-from-api' ? `${base}/mcp` : base;
}

/**
 * Base endpoint for an A2A agent. The JSON-RPC endpoint is the base itself
 * (`jsonRpcPath: '/'`), and the agent card hangs off `agentCardPath`.
 */
export function agentEndpoint(asset, { gatewayUrl, useAssetTypePathPrefix = true, deployedPath = '' } = {}) {
  const path = trimSlashes(deployedPath);
  if (path) return joinUrl(gatewayUrl, path);
  return joinUrl(gatewayUrl, prefixedPath(asset, { useAssetTypePathPrefix }));
}

export function agentCardUrl(agentBase, agentCardPath = '/.well-known/agent.json') {
  return joinUrl(agentBase, agentCardPath);
}

/** Foundry data-plane base for a project (cell 8). */
export function foundryProjectBaseUrl({ accountName, projectName }) {
  return `https://${accountName}.services.ai.azure.com/api/projects/${projectName}`;
}

export function foundryAgentCardBackendUrl({ accountName, projectName, agentName }) {
  return `${foundryProjectBaseUrl({ accountName, projectName })}/agents/${agentName}/endpoint/protocols/a2a/agentCard/v1.0`;
}

export function foundryAgentJsonRpcBackendUrl({ accountName, projectName, agentName }) {
  return `${foundryProjectBaseUrl({ accountName, projectName })}/agents/${agentName}/endpoint/protocols/a2a`;
}

export function foundryAgentPatchUrl({ accountName, projectName, agentName }, apiVersion = 'v1') {
  return `${foundryProjectBaseUrl({ accountName, projectName })}/agents/${agentName}?api-version=${apiVersion}`;
}

/** ARM id of a Foundry project, as cell 10 composes it. */
export function foundryProjectResourceId({ accountResourceId, projectName }) {
  const account = trimTrailingSlash(accountResourceId);
  return account ? `${account}/projects/${projectName}` : '';
}

/** ARM id of the APIM service, used by the circuit-breaker `az rest` call. */
export function apimServiceResourceId({ subscriptionId, resourceGroupName, apimName }) {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ApiManagement/service/${apimName}`;
}

export function apimBackendResourceUri(
  { subscriptionId, resourceGroupName, apimName },
  backendId,
  apiVersion = '2024-06-01-preview',
) {
  const service = apimServiceResourceId({ subscriptionId, resourceGroupName, apimName });
  return `${service}/backends/${backendId}?api-version=${apiVersion}`;
}
