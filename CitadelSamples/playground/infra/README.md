# Container Apps deployment contract

`main.bicep` deploys two separately identified Container Apps into an existing
managed environment, registry, and Key Vault in the same resource group:

| App | Ingress | Identity and authorization |
| --- | --- | --- |
| `citadel-playground` | Public (`external: true`) | Container Apps Entra auth requires sign-in. Its user-assigned identity gets only `AcrPull` and requests short-lived tokens for the relay. |
| `citadel-relay` | Internal (`external: false`) | Container Apps Entra auth accepts only the configured relay audience. Its separate user-assigned identity gets `AcrPull` and Key Vault Secrets User on the configured vault. |

The relay never receives a static shared token. The playground acquires a
managed-identity token for `relayTokenAudience`; the relay's Entra middleware
validates it before the process reads the trusted principal header and permits
only the playground identity's exact principal ID.

## Required parameters

Provide a real parameter file outside source control. `main.bicepparam` is a
non-deployable shape example only: angle-bracket values must be replaced.

`relayAllowedOrigins`, `relayAllowedSampleIds`, `relayRequestPolicy`, and
`relayLogicalRefMappings` are required policy input. The same serialized
`relayAllowedSampleIds` array is passed to both the playground and relay; neither
process defaults an enabled relay to every structurally eligible catalogue item.
Unknown, duplicate, malformed, or relay-ineligible IDs fail startup. An explicit
empty array disables all relay samples.

`relayRequestPolicy` must be generated or checked against the catalogue plan, not
copied from an older endpoint shape. The example authorizes the canonical
`weather-mcp-discovery` plan: `mcp-initialize`, the id-less
`mcp-initialized` notification, and `tools-list`, all at
`/mcp/weather-tool-mcp/mcp` with the secret-bearing `api-key` header.
`relayLogicalRefMappings` maps logical catalogue refs to **secret names**, not
values. The existing vault URI is supplied from its resource, and the relay
resolves values with its assigned identity at runtime.

The Entra applications and application ID URI must already exist. Configure the
relay application to expose `relayTokenAudience` and allow the playground
identity to request it. Container Apps authentication is the trusted proxy
boundary for both apps; never set `CITADEL_PLAYGROUND_EXECUTE_TOKEN`,
`CITADEL_PLAYGROUND_RELAY_TOKEN`, or
`CITADEL_PLAYGROUND_RELAY_AUTH_MODE=static-token` in this deployment.

## Exact container environment

The Bicep is the deployment authority. The hosted relay rejects startup unless
`CITADEL_RELAY_ENTRA_AUTHENTICATED=true` and requires:

| Relay variable | Source |
| --- | --- |
| `CITADEL_RELAY_TENANT_ID` | `entraTenantId` |
| `CITADEL_RELAY_ALLOWED_PRINCIPAL_ID` | Playground managed identity principal ID |
| `CITADEL_RELAY_MANAGED_IDENTITY_CLIENT_ID` | Relay managed identity client ID |
| `CITADEL_RELAY_KEY_VAULT_URI` | Existing Key Vault |
| `CITADEL_RELAY_ALLOWED_ORIGINS` | `relayAllowedOrigins` JSON |
| `CITADEL_RELAY_ALLOWED_SAMPLE_IDS` | `relayAllowedSampleIds` JSON |
| `CITADEL_RELAY_REQUEST_POLICY` | `relayRequestPolicy` JSON |
| `CITADEL_RELAY_SECRET_MAPPINGS` | `relaySecretMappings` JSON |
| `CITADEL_RELAY_BODY_LIMIT_BYTES` | `relayBodyLimitBytes` |
| `CITADEL_RELAY_RUN_TIMEOUT_MS` | `relayRunTimeoutMs` |
| `CITADEL_RELAY_HTTP_TIMEOUT_MS` | `relayRequestTimeoutMs` |
| `CITADEL_RELAY_MAX_REQUESTS_PER_RUN` | `relayMaxRequestsPerRun` |
| `CITADEL_RELAY_MAX_CONCURRENT_REQUESTS` | `relayMaxConcurrentRequests` |

The relay accepts only the exact hosted limit keys represented above. Startup
rejects malformed integers, unknown programmatic limit keys, values outside the
Bicep ranges, or a manually supplied request timeout longer than the run timeout.
Bicep caps the effective request timeout at the configured run timeout so an
otherwise valid parameter pair cannot create a crash-looping revision. The
request-count ceiling covers both ordinary HTTP steps and bounded bursts; a step
that would cross the remaining budget fails before it sends another request. The
concurrency value limits both burst workers and globally admitted `/execute`
requests; excess requests fail closed with HTTP 429 before authentication, body
parsing, secret resolution, or network execution.

The playground receives the private relay URL and token audience from Bicep,
plus `CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED=true`, the same tenant ID,
`CITADEL_PLAYGROUND_RELAY_CLIENT_ID` for its assigned user-assigned identity, and
the same serialized `relayAllowedSampleIds` value the relay receives. It does not
receive a relay token: it obtains one from its managed identity.

Bicep also sets `CITADEL_PLAYGROUND_PUBLIC_ORIGIN` to
`https://<playground-name>.<managed-environment-default-domain>`, derived from the
existing Container Apps environment. Every state-changing JSON route requires
that exact HTTPS `Origin` on a non-loopback bind. Scheme, host, and port changes
are rejected, and forwarded host/protocol headers are never trusted. Loopback
development continues to accept its configured HTTP loopback origins.

Container Apps injects the following variables into each container because the
Bicep assigns a managed identity. They are runtime platform values and must not
be copied into or overridden by the Bicep container `env` list:

| Platform variable | Contract |
| --- | --- |
| `IDENTITY_ENDPOINT` | Local HTTP token endpoint. The secure default accepts `localhost`, IPv4 `127/8`, or `::1` with the `/msi/token` path. |
| `IDENTITY_HEADER` | Secret request header sent only as `X-IDENTITY-HEADER` to that local endpoint. |

The pair must be wholly present and valid. Partial or malformed injection fails
startup rather than falling back to VM IMDS. When both values are absent, the
same provider uses the fixed VM IMDS endpoint with only `Metadata: true`; the
Container Apps identity header is never sent to IMDS, the relay, or Key Vault.
Each app reads its own injected pair and uses its own configured user-assigned
client ID, so identity endpoint/header values never cross the app boundary.
Microsoft documents the value only as a local URL. The accepted hosts and path
match the current Container Apps endpoint shape but were not live-deployment
tested here. A future platform-local shape requires an explicit code-level
validator override; deployment environment values cannot broaden the default to
an arbitrary remote URL.

Both apps use 0.5 CPU, 1 GiB memory and HTTP probes. The playground uses 1--2
replicas. The relay scale block fixes each active revision at exactly one replica
because direct `/execute` nonce consumption and admission are process-local.
Horizontal scale-out is prohibited until one actually shared atomic adapter backs
both controls; configuring two independent in-memory stores is not shared
durability. Revision transitions and process restarts replace that local state,
so rollout operators must drain the acknowledgement validity window and treat
cross-restart replay protection as unproven until the same shared adapter exists.
The playground serves `/api/health`; the relay serves `/healthz` and `/readyz`.

## Offline validation

From `CitadelSamples/playground`:

```powershell
az bicep build --file infra/main.bicep
az bicep lint --file infra/main.bicep
npm run verify
```

The Bicep is statically validated only. A first deployment still must confirm
the target Container Apps auth API behavior, internal relay DNS/TLS reachability,
Entra app registration consent, and role-assignment propagation.
