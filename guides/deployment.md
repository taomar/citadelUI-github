# Deployment guide

Citadel Control Plane runs as a single container. It can run on your machine, or
on Azure Container Apps. The two do not differ in behaviour; they differ in who
can reach the container and where its state lives.

The application never contacts Azure at runtime. Deploying it does not deploy the
gateway it edits.

---

## What gets deployed on Azure

`azd up` provisions seven resources into one resource group:

| Resource | Purpose |
| --- | --- |
| Container Apps environment | Runs the container |
| Container app | The application itself, one replica maximum |
| Container registry | Holds the image, built here rather than on your machine |
| Storage account | Azure Files share mounted at `/data` |
| Key Vault | Holds the key that encrypts stored GitHub credentials |
| User-assigned managed identity | Pulls the image and reads the vault secret |
| Log Analytics workspace | Container logs |

The application keeps session state in memory and writes to `/data`, so it is
capped at one replica. A second replica would be a second writer and a second
session store.

---

## Prerequisites

- An Azure subscription and permission to create the resources above.
- [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd)
  and the Azure CLI, both signed in.
- No Docker daemon. The image is built in the container registry.

---

## Deploy to Azure

Run from `CitadelUI/`, not the repository root — the root belongs to the gateway
platform this application edits.

```
cd CitadelUI
azd env new citadel-prod --subscription <subscription-id> --location westeurope
azd env set ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH true
azd up
```

Provisioning takes roughly fifteen minutes, most of it the Container Apps
environment. When it finishes, `azd` prints the application URL.

The resource group is named `rg-<env-name>` unless you set `AZURE_RESOURCE_GROUP`
yourself. It is created and tagged before provisioning begins, because that tag is
what permits the storage account the shared-key access the file share needs.

Every resource name derives from a hash of the subscription, environment name and
region, so a new environment name is all that is needed to stand up a second,
parallel deployment.

---

## Choosing where it is reachable from

This is the most consequential deployment decision. There are four positions, and
the first is the one to use when the gateway itself is private.

| Position | How | Who can reach it |
| --- | --- | --- |
| Inside the gateway VNet | `AZURE_INFRASTRUCTURE_SUBNET_ID=<subnet resource id>` | Only the VNet, and whatever is peered, VPN- or ExpressRoute-connected to it. No public endpoint exists. |
| Public, owner sign-in | `ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH=true` | Anyone can load the sign-in page; only the owner can use it. |
| Public, Entra in front | `entraAuthClientId` | Only members of your tenant reach the application at all. |
| Environment only | Set none of the above | Nothing outside the Container Apps environment. The application still runs. |

Nothing here is public by default. Ingress is external only because someone decided
it should be, never as a side effect of another setting.

### Deploying inside the Citadel AI Hub Gateway VNet

This is the private topology. The Container Apps environment is placed in a subnet
of a VNet you already have — typically the one the gateway itself is deployed into
— and gets an internal load balancer with **no public endpoint at all**. The
application is then reached at a private address from inside that network: a jump
box, a peered network, a VPN or ExpressRoute connection.

```
cd CitadelUI
azd env new citadel-private --subscription <subscription-id> --location westeurope
azd env set AZURE_INFRASTRUCTURE_SUBNET_ID "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<subnet>"
azd up
```

**The deployment does not create any network resources.** It does not create the
VNet, the subnet, the route table, the NSG or any peering. It joins a subnet you
already own, and it will refuse to deploy rather than work around a subnet that is
not suitable. The subnet must:

- already exist, in the same region as the deployment;
- be delegated to `Microsoft.App/environments`;
- be at least a `/27`, and be otherwise empty.

Get the resource id of an existing subnet with:

```
az network vnet subnet show \
  --resource-group <rg> --vnet-name <vnet> --name <subnet> \
  --query id -o tsv
```

When this is set it overrides the two public options. There is no internet-facing
load balancer for a public ingress to be published on, so `entraAuthClientId` and
`ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH` no longer affect reachability. The owner
sign-in still applies — network privacy and authentication are separate controls,
and the application does not drop one because it has the other.

The deployment reports which of the three it ended up on in
`SERVICE_CITADELUI_NETWORK`: `vnet`, `internet`, or `environment`.

### Putting Entra in front of a public deployment

Provision once without a client id, take the `AZURE_AUTH_REDIRECT_URI` value from
the outputs, register it as the reply URL on an Entra application, then set the
client id and provision again. That reply URL is deliberately the address the
application will have once published, which is not the address it has before then.

### Claiming a public deployment

The owner sign-in position is a real control — an anonymous visitor is issued no
session token and every data route refuses one — but it is weaker than Entra or a
private network, because the claim window stays open until someone claims the
container. Claim it as soon as it is deployed.

---

## Deployment options

| Setting | Default | Effect |
| --- | --- | --- |
| `AZURE_INFRASTRUCTURE_SUBNET_ID` | empty | Places the Container Apps environment in an **existing** subnet, with no public endpoint. No network resources are created. Overrides the two public options. |
| `ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH` | `false` | Publishes the application behind its own owner sign-in. |
| `entraAuthClientId` | empty | Puts Container Apps built-in Entra authentication in front, and publishes it. |
| `entraAuthClientSecret` | empty | Needed only if your registration is a confidential web client. A SPA-style registration wants no secret. |
| `persistData` | `true` | Mounts Azure Files at `/data`. See below. |
| `AZURE_KEY_VAULT_NAME` | empty | Reuses an existing vault instead of creating one. Reuse provisions no vault, only a role assignment on the one you named. |
| `AZURE_KEY_VAULT_RESOURCE_GROUP` | empty | Where that existing vault lives, if not in this group. |
| `credentialSecretName` | `citadel-credential-key` | Name of the secret holding the credential encryption key. |
| `AZURE_RESOURCE_GROUP` | `rg-<env-name>` | Target group, created and tagged before provisioning. |
| `AZURE_LOCATION` | — | Region. Nothing in the design depends on it. |

### Persistence is not optional in practice

`/data` is required to boot, not merely to persist. A container without the mount
exits immediately, which presents as a crash rather than a storage problem.

With `persistData` off the application runs but forgets everything on restart, on
scale to zero, and on every new revision — including the owner account, which means
the deployment becomes claimable again each time it starts.

### The credential key

Stored GitHub connections are encrypted with a key read from Key Vault at startup.
The deployment does not create that secret: generating key material inside a
deployment would place it in the deployment history in plain text.

Until you create it the application works normally, but GitHub connections last
only for the current session. The interface says so rather than failing later.

---

## Run it locally

```
cd CitadelUI
Copy-Item container.env.example container.env
.\scripts\start.ps1
```

Open <http://127.0.0.1:4173>.

The port is fixed. Retained directory handles are bound to the exact origin, so
changing the port makes the browser forget which folders you granted. If the port
is occupied, stop the process using it rather than changing ports.

Requirements are Docker with Compose, and Microsoft Edge or Google Chrome — the
File System Access API is what grants the browser access to a repository folder.

| Local setting | Purpose |
| --- | --- |
| `CITADEL_DATA_PATH` | Host directory bound to `/data`. Defaults to `./.data`. |
| `CITADEL_ALLOWED_HOST` | Exact `Host` header to accept. No scheme, no trailing slash. |
| `CITADEL_ALLOWED_ORIGIN` | Exact `Origin` to accept on state-changing requests. |
| `CITADEL_IMAGE` | Image tag to run, if not building locally. |

`scripts\status.ps1`, `scripts\logs.ps1` and `scripts\stop.ps1` cover local
operation.

---

## Updating and removing

Ship a code change to an existing deployment:

```
cd CitadelUI
azd deploy
```

Rebuild infrastructure without redeploying the image with `azd provision`. Remove
everything with:

```
azd down --force --purge
```

`--purge` matters. Without it the Key Vault is left soft-deleted and its name stays
reserved.

---

## Troubleshooting

**The container starts and immediately exits.**
`/data` is not mounted, or not writable by the container user. The application
requires it to boot.

**Every request returns 421.**
The `Host` header does not match what the server was told to expect. Check
`CITADEL_ALLOWED_HOST`: no scheme, no trailing slash, and no port unless the
browser sends one. Container Apps terminates TLS on 443 and browsers omit the
default port, so adding `:443` rejects every request including the health probes.

**Saves fail with 403.**
The browser's `Origin` does not match `CITADEL_ALLOWED_ORIGIN`. Usually a scheme
mismatch after moving from a local `http` address to a deployed `https` one.

**The file share mount is refused with `mount error(13)`.**
Subscription policy is denying the storage account shared-key access. The resource
group needs its exemption tag before the account is created. The deployment applies
the tag and reads it back, so this is reported rather than silent.

**The image fails to push with a 401.**
The image is built in the registry, not locally, precisely to avoid this. Confirm
`remoteBuild: true` is still set under `docker:` in `azure.yaml`.

**The VNet deployment is rejected before anything is created.**
The subnet is not suitable, and the deployment refuses rather than working around
it. Check it is in the same region, delegated to `Microsoft.App/environments`, at
least a `/27`, and not already in use by something else. The deployment never
creates or modifies network resources, so all of this has to be true beforehand.

**The application deployed privately but nothing can reach it.**
That is the topology working. There is no public endpoint. Reach it from inside
the VNet, or from a network peered, VPN- or ExpressRoute-connected to it. Confirm
which topology you got by reading `SERVICE_CITADELUI_NETWORK` from
`azd env get-values`.

**It asks to create an owner again after every restart.**
`/data` is ephemeral. The owner record lives there.

**The owner password is lost.**
There is no reset and no second account, by design. Recovering access means
redeploying with fresh state.

**GitHub connections disappear when the browser is closed.**
No credential key is mounted, so connections are held in memory only. Create the
Key Vault secret named by `credentialSecretName`.
