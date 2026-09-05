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
`relayLogicalRefMappings` are required policy input. They are serialized exactly
into the relay environment. `relayLogicalRefMappings` maps logical catalogue refs
to **secret names**, not values. The existing vault URI is supplied from its
resource, and the relay resolves values with its assigned identity at runtime.

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

The playground receives the private relay URL and token audience from Bicep,
plus `CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED=true`, the same tenant ID, and
`CITADEL_PLAYGROUND_RELAY_CLIENT_ID` for its assigned user-assigned identity. It
does not receive a relay token: it obtains one from its managed identity.

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

Both apps use 0.5 CPU, 1 GiB memory, 1--2 replicas, and HTTP probes. The
playground serves `/api/health`; the relay serves `/healthz` and `/readyz`.

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
