# Container Apps deployment contract

`main.bicep` deploys two separately identified Container Apps into an existing
managed environment, registry, and Key Vault in the same resource group:

| App | Ingress | Identity and authorization |
| --- | --- | --- |
| `citadel-playground` | Public (`external: true`) | Container Apps Entra auth validates the exact tenant and client audience. The server then requires `Citadel.Operator` or an explicit deployment-owned principal/group allowlist. Its user-assigned identity gets only `AcrPull` and requests short-lived tokens for the relay. |
| `citadel-relay` | Internal (`external: false`) | Container Apps Entra auth accepts only the configured relay audience, calling application, and playground managed-identity principal. Its separate user-assigned identity gets `AcrPull` and Key Vault Secrets User on the configured vault. |

The relay never receives a static shared token. The playground requests a
managed-identity token for `relayTokenResource` (`api://<relay-app-id>`). A v2
access token carries the relay application's client-ID GUID in `aud`, so the
relay's Entra middleware validates `relayEntraClientId`, not the resource URI,
before the process reads the trusted principal header and permits only the
playground identity's exact principal ID.

## Required parameters

Provide a real parameter file outside source control. `main.bicepparam` is a
non-deployable shape example only: angle-bracket values must be replaced.

`hostedOperatorRequiredAppRole` defaults to the exact app-role value
`Citadel.Operator`. `hostedOperatorAllowedPrincipalIds` and
`hostedOperatorAllowedGroupIds` default to empty arrays and are optional
break-glass or constrained-deployment alternatives. The server authorizes a
caller only when the trusted Easy Auth principal has the required role, an
allowed object ID, or an allowed group ID. Tenant membership by itself is never
enough. Empty role plus empty allowlists is a configuration error, so readiness
returns 503 and every privileged POST fails closed.

`hostedOperatorPlatformAllowedPrincipalIds` and
`hostedOperatorPlatformAllowedGroupIds` are separate, optional constrained-mode
lists. When either is nonempty, Bicep writes them to Easy Auth
`defaultAuthorizationPolicy.allowedPrincipals`, so that outer gate must pass
before the server evaluates its role-or-allowlist policy. Leave both empty when
app-role, principal, and group membership are alternatives. The internal relay separately uses
`allowedApplications` and `allowedPrincipals` so only the playground managed
identity can reach it. Easy Auth cannot enforce the `roles` claim directly; the
playground server's app-role check is mandatory.

`azureCloud` is required and accepts only `AzureCloud`, `AzureUSGovernment`, or
`AzureChinaCloud`. It is not a free-form endpoint switch. The Bicep carries the
same fixed profile table as the relay and passes both the selected profile and
the actual `environment().name`/`environment().resourceManager` values. Relay
startup requires the complete tuple to match before it constructs the managed
identity Key Vault provider.

| Profile | Entra authority | ARM endpoint | Key Vault token resource | Vault DNS suffix |
| --- | --- | --- | --- | --- |
| `AzureCloud` | `https://login.microsoftonline.com` | `https://management.azure.com/` | `https://vault.azure.net` | `.vault.azure.net` |
| `AzureUSGovernment` | `https://login.microsoftonline.us` | `https://management.usgovcloudapi.net/` | `https://vault.usgovcloudapi.net` | `.vault.usgovcloudapi.net` |
| `AzureChinaCloud` | `https://login.chinacloudapi.cn` | `https://management.chinacloudapi.cn` | `https://vault.azure.cn` | `.vault.azure.cn` |

Microsoft Cloud Germany closed on October 29, 2021. `AzureGermanCloud`,
`login.microsoftonline.de`, and the retired German Key Vault endpoints are
rejected rather than represented as a deployable profile.

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

The Entra applications and application ID URI must already exist; this ARM
template cannot provision or inspect Microsoft Graph application objects.
Before deployment, define the operator role on the **playground** app
registration:

1. In **Microsoft Entra admin center > App registrations**, open the application
   whose client ID is `playgroundEntraClientId`.
2. Open **App roles > Create app role**.
3. Set **Display name** to `Citadel Operator`, **Allowed member types** to
   `Users/Groups`, **Value** to `Citadel.Operator`, **Description** to
   `Operate the hosted Citadel Publish Playground`, and enable the role.
4. In **Enterprise applications**, open the service principal for the same
   application, select **Users and groups > Add user/group**, choose each
   operator user or security group, and assign **Citadel Operator**.
5. Sign out and back in after assignment so Microsoft Entra issues a fresh ID
   token containing `roles: ["Citadel.Operator"]`.

The role belongs on the playground application because it is included in the ID
token used for interactive sign-in. Assigning a tenant directory role, Azure RBAC
role, or a role on the relay application does not satisfy this policy.

Direct group authorization through `hostedOperatorAllowedGroupIds` or
`hostedOperatorPlatformAllowedGroupIds` also requires the playground registration
to emit group claims. In **Token configuration**, add a groups claim to the ID token and select **Security groups** (manifest
`groupMembershipClaims: "SecurityGroup"`) or **All groups**. Group-overage tokens
do not carry direct group IDs and therefore fail closed; for operators with large
group memberships, assign `Citadel.Operator` to the group instead and leave the
direct group allowlist empty.

The relay resource application must expose the exact
`relayTokenResource` value `api://<relayEntraClientId>` and its manifest must
contain the numeric value:

```json
{
  "api": {
    "requestedAccessTokenVersion": 2
  }
}
```

`null`, an omitted value, or `1` is invalid: managed identity then receives a v1
access token while the Container Apps verifier is pinned to the exact
tenant-specific v2 issuer. `relayRequestedAccessTokenVersion` is therefore a
required Bicep parameter whose only accepted value is `2`; it declares the
validated external prerequisite rather than silently assuming it.

Export the relay application object to a local JSON file, then run the offline
preflight before deployment. The checker makes no Azure or Graph call:

```powershell
npm run check:relay-app -- --manifest .\relay-app-registration.json `
  --cloud 'AzureCloud' `
  --tenant-id '<tenant-id>' `
  --client-id '<relay-app-id>' `
  --resource 'api://<relay-app-id>' `
  --audience '<relay-app-id>' `
  --issuer 'https://login.microsoftonline.com/<tenant-id>/v2.0'
```

The preflight rejects a missing/default/v1 requested token version, a different
app ID or identifier URI, non-lowercase or malformed GUIDs, a resource/audience
mix-up, a retired or unknown cloud, and any issuer that is not the selected
cloud's exact tenant-specific `/v2.0` issuer. The checker accepts UTF-8 with or
without a BOM and the UTF-16 JSON files commonly written by Windows PowerShell.
After it passes, allow the playground identity to request the exposed API.
Container Apps authentication is the trusted signature/JWKS boundary for both
apps; never set
`CITADEL_PLAYGROUND_EXECUTE_TOKEN`,
`CITADEL_PLAYGROUND_RELAY_TOKEN`, or
`CITADEL_PLAYGROUND_RELAY_AUTH_MODE=static-token` in this deployment.

Export the playground application and its service principal's app-role
assignments, then validate both offline:

```powershell
az ad app show --id '<playground-app-id>' > .\playground-app-registration.json
$servicePrincipalId = az ad sp show --id '<playground-app-id>' --query id -o tsv
az rest --method get `
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$servicePrincipalId/appRoleAssignedTo" `
  > .\playground-app-role-assignments.json

npm run check:playground-app -- `
  --manifest .\playground-app-registration.json `
  --assignments .\playground-app-role-assignments.json `
  --client-id '<playground-app-id>' `
  --required-app-role 'Citadel.Operator' `
  --allowed-group-ids '[]'
```

This preflight makes no Azure or Graph call itself. It requires one enabled
`Citadel.Operator` role that accepts Users/Groups and at least one matching User
or Group assignment. Pass one JSON array containing every direct group ID configured in
`hostedOperatorAllowedGroupIds` or `hostedOperatorPlatformAllowedGroupIds`; when
it is nonempty, the checker also requires `groupMembershipClaims` to be
`SecurityGroup` or `All`. It reports counts and types only, never principal IDs.

## Exact container environment

The Bicep is the deployment authority. The hosted relay rejects startup unless
`CITADEL_RELAY_ENTRA_AUTHENTICATED=true` and requires:

| Relay variable | Source |
| --- | --- |
| `CITADEL_RELAY_AZURE_CLOUD` | Required `azureCloud` profile |
| `CITADEL_RELAY_ARM_CLOUD` | Actual `environment().name`; must equal the selected profile |
| `CITADEL_RELAY_ARM_ENDPOINT` | Actual `environment().resourceManager`; must equal the selected profile |
| `CITADEL_RELAY_KEY_VAULT_RESOURCE` | Fixed profile value; startup compares it with the code-owned table |
| `CITADEL_RELAY_KEY_VAULT_DNS_SUFFIX` | Fixed profile value; startup compares it with the code-owned table |
| `CITADEL_RELAY_TENANT_ID` | `entraTenantId` |
| `CITADEL_RELAY_TOKEN_VERSION` | `relayRequestedAccessTokenVersion` (must be `2`) |
| `CITADEL_RELAY_TOKEN_ISSUER` | Exact tenant-specific v2 issuer derived by Bicep |
| `CITADEL_RELAY_TOKEN_RESOURCE` | `relayTokenResource` (`api://<relayEntraClientId>`) requested from managed identity |
| `CITADEL_RELAY_TOKEN_AUDIENCE` | `relayEntraClientId`, the GUID carried in a v2 token's `aud` claim |
| `CITADEL_RELAY_ENTRA_CLIENT_ID` | `relayEntraClientId` |
| `CITADEL_RELAY_ALLOWED_PRINCIPAL_ID` | Playground managed identity principal ID |
| `CITADEL_RELAY_MANAGED_IDENTITY_CLIENT_ID` | Relay managed identity client ID |
| `CITADEL_RELAY_KEY_VAULT_URI` | Existing Key Vault; must be one unadorned HTTPS host under the selected profile suffix |
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

The playground receives the private relay URL plus the selected Azure cloud,
same v2 token version, issuer, audience, relay app client ID, and tenant contract
from Bicep. It also receives `CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED=true`,
`CITADEL_PLAYGROUND_RELAY_CLIENT_ID` for its assigned user-assigned identity, and
the same serialized `relayAllowedSampleIds` value the relay receives. Its
`CITADEL_PLAYGROUND_RELAY_TIMEOUT_MS` budget is the relay run budget plus 15
seconds for request validation and managed-identity credential acquisition. It
does not receive a relay token: it obtains one from its managed identity.

The hosted operator policy is passed separately:

| Playground variable | Source |
| --- | --- |
| `CITADEL_PLAYGROUND_ENTRA_TENANT_ID` | `entraTenantId` |
| `CITADEL_PLAYGROUND_ENTRA_CLIENT_ID` | `playgroundEntraClientId`, the exact interactive token audience |
| `CITADEL_PLAYGROUND_OPERATOR_REQUIRED_APP_ROLE` | `hostedOperatorRequiredAppRole` |
| `CITADEL_PLAYGROUND_OPERATOR_ALLOWED_PRINCIPAL_IDS` | `hostedOperatorAllowedPrincipalIds` JSON |
| `CITADEL_PLAYGROUND_OPERATOR_ALLOWED_GROUP_IDS` | `hostedOperatorAllowedGroupIds` JSON |

The process trusts `X-MS-CLIENT-PRINCIPAL` only when
`CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED=true` selects the hosted Easy Auth mode.
Microsoft documents that external requests cannot set the identity headers Easy
Auth injects. Local and static-token modes never derive authorization from these
headers. The parser bounds the header, requires one unambiguous tenant,
audience, and object ID, rejects malformed or duplicate claims, and returns only
the safe principal/tenant plus the configured role match. Names, email
addresses, raw group membership, and unrelated claims are not returned to the
browser.

Both processes validate the selected cloud against the issuer before relay use.
The relay additionally validates the actual ARM cloud and endpoint, fixed Key
Vault audience and suffix, and configured vault host before any managed-identity
token request. The Key Vault audience is selected only from the code-owned cloud
table; it is never derived from a caller or vault URL. An incomplete or
inconsistent hosted configuration disables execution, reports
`relay-token-configuration-invalid` or
`hosted-authorization-configuration-invalid` through capability/health with HTTP
503, and never falls back to v1, tenant membership, a different issuer, a
different tenant, or a different audience.

Every hosted privileged POST route applies the same exact-origin check and
operator authorization before route-specific behavior. `/api/execute` cannot
request a managed-identity token or call the relay before that gate passes.
`/api/capabilities` exposes only `Signed in` and `Authorized to operate` state,
not the principal ID or claims.

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

Both apps use 0.5 CPU, 1 GiB memory and HTTP probes. Process-liveness endpoints
(`/api/live` and `/livez`) remain 200 while the Node process can answer, so a
static configuration error does not create a restart loop. Configuration health
and readiness (`/api/health`, `/healthz`, and `/readyz`) return 503 until the
v2 token contract and hosted operator policy are valid. The playground uses
1--2 replicas. The relay scale
block fixes each active revision at exactly one replica
because direct `/execute` nonce consumption and admission are process-local.
Horizontal scale-out is prohibited until one actually shared atomic adapter backs
both controls; configuring two independent in-memory stores is not shared
durability. Revision transitions and process restarts replace that local state,
so rollout operators must drain the acknowledgement validity window and treat
cross-restart replay protection as unproven until the same shared adapter exists.
The playground serves `/api/live` and `/api/health`; the relay serves `/livez`,
`/healthz`, and `/readyz`.

## Offline validation

From `CitadelSamples/playground`:

```powershell
az bicep build --file infra/main.bicep
az bicep lint --file infra/main.bicep
npm run verify
```

The Bicep and app-registration manifest are statically validated only. A first
deployment still must confirm the target Container Apps auth API behavior,
managed identity actually receiving a v2 token for the resource app, internal
relay DNS/TLS reachability, Entra app registration consent, and role-assignment
propagation.
