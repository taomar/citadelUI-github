# Deploy Citadel UI

Configure the UI in
[`CitadelUI/infra/main.bicepparam`](../CitadelUI/infra/main.bicepparam), then deploy
with azd. No large PowerShell configuration block is needed.

**Citadel UI only:** use `main`, not a sample branch. Run commands from
`CitadelUI`; the repository-root `azure.yaml` belongs to the gateway.

| Scenario | Instructions |
| --- | --- |
| New Azure resources, public or private VNet | [Fresh deployment](#fresh-azure-deployment) |
| Existing resources or a mixture of existing and new | [Resource reuse](#deploy-on-an-existing-subnet-and-resources) |
| Local Docker | [PowerShell](#local-deployment---powershell) or [Bash](#local-deployment---bash) |
| Update an already configured UI | [Image-only update](#redeploy-an-existing-citadel-ui-container-app) |

**Live status:** fresh public deployment and repeat `azd up` passed in West
Europe, preserving the owner, stored state and exact Key Vault key version.
The native parameter-file workflow and image-only script also passed live checks.
Protected-resource reuse passed private DNS, HTTP/sign-in, Azure Files, Key Vault
and private log-query checks, repeated after redeployment. The eight shared
resource configuration snapshots were unchanged. Fresh private mode has not
been tested live.

## Prerequisites

Azure deployment needs Git, PowerShell 7.4+, Azure CLI and Azure Developer CLI
1.33+. Use a dedicated UI resource group and an account permitted to create
resources and their role assignments. Reused resources must be in the selected
subscription; the region must match the subnet/Container Apps environment.

The Key Vault provisioning identity needs secret-list permission and permission
to create a key when absent. The app identity only reads it. The automatic
postprovision hook preserves an existing enabled credential key; it never
rotates that key or prints it.

The existing resource-group hook applies `SecurityControl=Ignore` for the
originating tenant's shared-key storage exception. Obtain your organization's
approval; this tag is not a universal Azure exemption. Shared-resource firewalls
are never relaxed by reuse.

## Fresh Azure deployment

Clone and create an azd environment:

```powershell
git clone --branch main --single-branch https://github.com/taomar/citadelUI-github.git
cd .\citadelUI-github\CitadelUI
az login
azd config set auth.useAzCliAuth true
azd env new citadel-new --subscription '<subscription-id>' --location '<azure-region>'
```

Open **`infra/main.bicepparam`** and replace the two network assignments with
the values you want:

```bicep
// Public endpoint with Citadel UI owner sign-in.
param privateDeployment = false
param allowPublicIngressWithoutAuth = true
```

For a **private VNet**, use `privateDeployment = true` and
`allowPublicIngressWithoutAuth = false`. That creates a VNet, dedicated subnet,
internal Container Apps environment and private DNS. The default network is
`10.240.0.0/16`, with subnet `10.240.0.0/23`; client VPN/peering is operator-owned.

Deploy:

```powershell
azd up
azd env get-value SERVICE_CITADELUI_URI
```

On a public deployment, open the URL and **claim the owner immediately**:
the first visitor owns a new container. There is no password reset.

## Deploy on an existing subnet and resources

Clone and create a separate azd environment:

```powershell
git clone --branch main --single-branch https://github.com/taomar/citadelUI-github.git
cd .\citadelUI-github\CitadelUI
az login
azd config set auth.useAzCliAuth true
azd env new citadel-existing --subscription '<subscription-id>' --location '<resource-region>'
```

Edit **`infra/main.bicepparam` directly**. Replace only the assignments you need.
For example, reuse an existing private environment, registry and vault:

```bicep
param privateDeployment = true
param allowPublicIngressWithoutAuth = false
param existingContainerAppsEnvironmentName = 'my-container-apps-environment'
param existingContainerAppsEnvironmentResourceGroup = 'my-platform-rg'
param infrastructureSubnetId = ''
param existingLogAnalyticsWorkspaceName = ''
param existingLogAnalyticsWorkspaceResourceGroup = ''
param existingContainerRegistryName = 'myregistry'
param existingContainerRegistryResourceGroup = 'my-registry-rg'
param keyVaultName = 'my-key-vault'
param keyVaultResourceGroup = 'my-vault-rg'
param credentialSecretName = 'citadel-credential-key'
```

The same file contains the storage account, file share, managed identity and
workspace parameters. **Set an existing-resource name to `''` to create the
generated default.** A nonempty name must already exist. An empty resource-group
parameter means the UI group.

| Network choice | Parameters |
| --- | --- |
| New environment on an existing subnet | Set `infrastructureSubnetId`; clear the existing-environment name/group |
| Existing environment | Set its name/group; leave subnet and workspace selectors empty because the environment owns them |

A subnet for a new environment must be unused, in the same region, delegated
to `Microsoft.App/environments`, and IPv4 `/27` or larger. Its DNS and client
connectivity must be prepared by the network owner. A reused environment keeps
its existing network, DNS and logging.

Deploy using the checked-in scripts, which handle registry permissions:

```powershell
azd provision
.\scripts\deploy-image.ps1
azd env get-value SERVICE_CITADELUI_URI
```

**How the file reaches azd:** azd reads `main.bicepparam` natively. The preprovision
hook also imports evaluated, nonsecret inputs into the selected environment so
preflight and Bicep agree. The existing `readEnvironmentVariable(...)` expressions
are compatibility defaults; replace them with literals to override saved values.
Leave the azd-managed context/image assignments at the bottom unchanged.
Do not put passwords, tokens or key material in the parameter file.
Review the file when switching environments: literal overrides apply to the
environment currently selected in azd.

**Keep existing data:** select the original storage account/share and original
Key Vault/credential-secret name. A blank share name creates a new share, not
adoption of an old one. Never run two UI instances against one data share.

### Fully protected resources need pre-staging

Naming a resource does not create its private endpoints. Pre-stage Premium ACR,
Key Vault, storage/share, the internal Container Apps environment, monitoring,
private endpoints and DNS. Disable public data-plane access before testing reuse.
The provisioning/build host must be inside that network.

Direct Container Apps logging to Log Analytics through customer Private Link is
[unsupported](https://learn.microsoft.com/azure/container-apps/log-options#limitations).
Use `azure-monitor` plus diagnostic settings: Microsoft privately delivers logs;
public workspace ingestion/query remain disabled, and queries use AMPLS private
endpoints. The delivery channel does not traverse your own private endpoint.

Private ACR requires an in-network build/push host; ordinary azd remote build is
not sufficient. Build/push there and pass the resulting reference to
`deploy-image.ps1 -ImageReference '<registry>/<image>@sha256:<digest>'`.
Do not open a service firewall to make deployment pass.

For an isolated test platform, the checked-in staging script creates these
prerequisites and a temporary private build/test VM. **Citadel UI still runs in
Container Apps, not on this VM.** An existing connected workstation or private CI
runner can replace this test VM. Choose an available x64 VM size and keep
artifacts outside the checkout. Both group names must use `rg-citadel-protected-`:

```powershell
.\scripts\protected-stage.ps1 `
  -EnvironmentName protected-demo -SubscriptionId '<subscription-id>' -Location '<azure-region>' `
  -PlatformResourceGroup rg-citadel-protected-platform `
  -UiResourceGroup rg-citadel-protected-ui `
  -SshPublicKeyPath '<path-to-your-public-key.pub>' `
  -OutputDirectory '<private-directory-outside-the-checkout>' `
  -RunnerVmSize '<available-x64-vm-size>'
```

Without `-Execute`, this only compiles locally. Add `-Execute -Preview` to prepare
the two dedicated groups and run Azure what-if; add `-Execute` without `-Preview`
to create the billable platform. The script prints a `contract.json` path after
successful staging.

After reviewing the staged platform, transfer the current UI source privately
and deploy from its runner:

```powershell
.\scripts\protected-transfer.ps1 `
  -ContractPath '<printed-contract.json-path>' `
  -OutputDirectory '<private-directory-outside-the-checkout>' `
  -Execute -Deploy
```

The runner uses its managed identity, your `main.bicepparam` environment defaults,
private DNS, a local Docker build/push, and azd deployment of an immutable image.
Literal parameter overrides that disagree with the staged contract are rejected.
It receives no public IP or inbound SSH access. Outbound HTTPS through NAT is
still required for Azure/platform and signed package/image sources; this is not
an air-gapped design. This path passed live application, private log-query and
retained-state acceptance in West Europe.

Source transfers require LF shell line endings; the UI's Git attributes preserve
them on checkout, and the transfer fails locally if it finds CRLF shell files.
The noninteractive runner sets its own private `HOME` for azd/tool configuration.

The staging template preserves Azure platform DNS/metadata connectivity without
invalid `Allow` rules for the special `AzurePlatformDNS`/`AzurePlatformIMDS` tags.
Its Key Vault enables purge protection: after cleanup, the deleted vault's name
remains reserved for its seven-day recovery period.

## Local deployment - PowerShell

Requires Docker Desktop/Engine 29+ with Compose and Edge or Chrome.
No Azure account is needed; Windows PowerShell 5.1 or PowerShell 7 works.

```powershell
git clone --branch main --single-branch https://github.com/taomar/citadelUI-github.git
cd .\citadelUI-github\CitadelUI
if (-not (Test-Path container.env)) { Copy-Item container.env.example container.env }
.\scripts\start.ps1
```

Open <http://127.0.0.1:4173>. Use `.\scripts\logs.ps1` for logs and
`.\scripts\stop.ps1` to stop.

## Local deployment - Bash

Requires Docker Desktop/Engine 29+ with Compose, Bash and Edge or Chrome.

```bash
set -euo pipefail
git clone --branch main --single-branch https://github.com/taomar/citadelUI-github.git
cd citadelUI-github/CitadelUI
if [ ! -f container.env ]; then cp container.env.example container.env; fi
if [ "$(uname -s)" = "Linux" ]; then
  sudo install -d -m 0700 -o 10001 -g 10001 .data
fi
bash scripts/start.sh
```

Open <http://127.0.0.1:4173>. Use
`docker compose --env-file container.env logs --tail 200 --follow app` for logs
and `docker compose --env-file container.env down` to stop.

Keep port **4173** because browser folder permissions are origin-bound.
Data defaults to `CitadelUI/.data`; stopping retains it. If you change
`CITADEL_DATA_PATH` in `container.env`, prepare that directory instead; Linux
requires UID/GID `10001:10001` (adjust for rootless Docker).

For either local path, create the owner account in the browser, then follow
[Add a GitHub token](./using-the-control-plane.md#add-a-github-token) to connect a
repository. Tokens are entered in the UI, not in `container.env`. A credential
key is optional: the default local deployment supports session-only connections
without one; only encrypted persistence is disabled.

## Redeploy an existing Citadel UI container app

From `CitadelUI`, select the original environment, then update only its image:

```powershell
azd env select '<original-environment-name>'
.\scripts\deploy-image.ps1
```

On a new checkout, use `azd env refresh '<original-environment-name>'` to recover
the deployment's environment first. The script preserves mounts, identity,
network and owner state, and records the image for later reprovisioning.
Do not create a new environment to update an existing app.

Review ownership before `azd down`. Never delete or purge shared resources or
their resource groups to remove this UI.
