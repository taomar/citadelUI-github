# Using Citadel Control Plane

Citadel Control Plane edits the configuration of a Citadel AI Hub Gateway
repository. It reads the banner comments those files already carry and renders
them as guidance, so the explanation beside a field is the repository's own.

Nothing is written until you review and save, and every save is a verified
transaction.

---

## First run

A new container has no owner. The first person to open it creates the account,
and it is the only account that container will ever have.

![Create the owner account](../docs/images/01-first-run-owner.png)

There is no second user and no password reset. Signing in is what issues the
session token every other request uses, so reaching the URL is not on its own
enough to use the application.

---

## Workspaces

A workspace is one Citadel repository. It can be a folder on this machine, or a
GitHub repository on a branch you choose. Attached workspaces are listed and open
in one click.

![Citadel workspaces](../docs/images/03-workspaces.png)

Adding one is a guided sequence. Nothing is read until the repository is confirmed
to carry the capabilities the editors need — an incomplete tree is rejected by
name rather than half-opened.

![Add workspace](../docs/images/04-add-workspace.png)

A **local folder** is granted through the browser's folder picker; the handle stays
in the browser profile, because it cannot be moved into a container. A **GitHub
repository** needs a fine-grained token with Contents read and write, limited to
the repositories it should reach. Saves become one commit on a working branch.

![GitHub connection](../docs/images/05-github-connection.png)

### Add a GitHub token

Choose **Add workspace** (or **Add your first workspace**), then **GitHub
repository**. If connections already exist, choose **Add a new connection**.
Enter a **New connection name** first to enable the **GitHub token** field, paste
your fine-grained personal access token, and select **Continue**. Choose a
repository and explicitly select its branch, such as `main`.

**Token help** beside the token label expands inline creation steps and a link
to GitHub, without clearing your entries. It is available before you name the
connection and when replacing a token through **Reconnect**.

Create the token in GitHub's **Settings > Developer settings > Personal access
tokens > Fine-grained tokens**. Select the intended resource owner and
**Only select repositories**, with **Contents: Read and write**.
**Metadata: Read-only** is included automatically. Classic tokens and the OAuth
token returned by `gh auth token` are not accepted.

Leave other permissions unset: Pull requests, Actions, Workflows and
administration permissions are not needed. Contents read-only cannot create
branches or save edits; Citadel does not offer a read-only workspace mode.
If the organization requires approval, a pending token can only read public
resources until an organization owner approves it.

Enter the token only in the UI, not in `container.env`, a Compose file, or an Azure
parameter file. Local-folder workspaces do not need a GitHub token.

The default local deployment has no credential key mounted. This disables only
**Persist this connection on this device (encrypted)**, not token entry or
GitHub access. Session-only connections work normally; after a container restart,
use **Reconnect** on the saved connection and supply a token for the same account.

---

## The three areas

Everything the gateway is operated through falls into three areas, shown down the
left. Every other parameter file in the repository stays reachable under **All
parameter files**.

| Area | Edits | Answers |
| --- | --- | --- |
| Azure Deployment | `bicep/infra/main.bicepparam` | How the hub itself is built |
| LLM Onboarding | `llm-backend-onboarding/main.bicepparam` | Which models sit behind the gateway |
| Access Contracts | One folder per contract | Who may use them, and under what limits |

---

## Azure Deployment

The hub's own parameters, grouped into the sections the file already declares:
Basics, Features, Resources, Networking, Inference logs, Compute and Accelerator.

### Feature flags turn capabilities on and off

Each flag decides whether a capability is deployed at all. Turning one off does not
merely hide it — the resources behind it are not created, and the parameters that
belong only to it stop being asked for.

![Feature flags](../docs/images/10-deployment-features.png)

The flags are grouped by what they affect: gateway APIs such as model inference,
document intelligence and realtime; data, safety and governance such as AI Search,
managed Redis, PII redaction and API Center; identity and observability such as
Entra authentication and Application Insights dashboards; and network topology.

A disabled capability hides only the inputs proven exclusive to it by the Bicep
module graph. Shared settings, and any unsaved edits that depend on them, stay
visible rather than vanishing with unsaved work inside them.

### Networking understands the address plan

Address fields are checked when you leave the control, against Azure's own rules
rather than a regular expression.

![Networking parameters](../docs/images/11-deployment-networking.png)

Each prefix reports what it actually buys — `64 total addresses · 59 usable after
Azure reserves the first four and last address` — so an undersized subnet is
visible before deployment rather than after it.

Subnets are checked against one another. An overlap is named precisely, on both
fields involved, and blocks the save:

![Overlapping subnets](../docs/images/12-vnet-overlap.png)

The header keeps a running count of blocking errors, and **Review & save** stays
disabled while any remain. The same checks cover malformed and non-canonical
CIDRs, ranges Azure prohibits, subnets that fall outside the VNet, unsupported
prefix sizes, and insufficient capacity for the services and private endpoints
that must fit inside them.

---

## LLM Onboarding

Everything about the models behind the gateway: the API Management instance they
are registered on, the managed identity used to reach them, the backends
themselves, circuit breaking, session affinity and model aliases.

![LLM onboarding](../docs/images/20-llm-onboarding.png)

`llmBackendConfig` is an untyped array in Bicep, which means the compiler cannot
help you and neither can a generic form. It gets a purpose-built editor instead.

![LLM backends](../docs/images/21-llm-backends.png)

Each backend names its provider, endpoint and authentication mode. The editor
knows the default authentication mode for each provider type, shows the derived
default, lets you override it, and asks for a named value or Key Vault URI only
when the chosen mode actually needs one. Plain-text secrets are flagged.

Priority and weight control routing between backends. Adding a model offers the
models known to work with that provider, rather than requiring the exact string
from memory.

---

## Access Contracts

One contract is one use case: a product, its subscriptions, and the API Management
policy that constrains it. Each is a folder holding a parameter file and its own
policy document, created from a template and then edited independently.

![Access contracts](../docs/images/30-access-contracts.png)

Opening one gives its parameters, its policy, and the raw file.

![Contract parameters](../docs/images/31-contract-parameters.png)

### Editing the policy

The policy is API Management XML. The editor presents it as the blocks it is
actually made of, each of which can be switched on or off, with the raw XML always
one click away.

![Contract policy](../docs/images/32-contract-policy.png)

Scope, allowed models, token limits, request rate limits, quotas, content safety,
semantic caching, authentication, PII handling, alerting, response headers and
policy fragments each appear as a block. The header shows how many are active.

The editor checks the policy against the rest of the repository, not just against
itself. A model allowed here that has not been onboarded in LLM Onboarding is
flagged by name — a mistake that would otherwise surface as a runtime rejection
long after the deployment succeeded.

---

## Reviewing and saving

Edits accumulate as pending changes. The header shows how many there are and
whether anything blocks the save.

**Review & save** shows what will be written before it is written. On confirmation
the browser backs up every target, writes, verifies the resulting hashes, and
restores from the verified backup bytes if any part fails. A failed multi-file
write leaves the repository as it was.

For a GitHub workspace, a save becomes one commit on a working branch you choose.
For a local folder it is written through the same verified transaction directly to
disk.

**Discard** abandons every pending change without touching the repository.

Each save appends a redacted, hash-chained entry to the activity log, reachable
from the landing page.
