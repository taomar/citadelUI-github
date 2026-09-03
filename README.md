![Citadel](./assets/citadel-logo-v2.PNG)

# Citadel Control Plane

The configuration surface for the Citadel AI Hub Gateway.

---

## Overview

Citadel Control Plane is a containerised, browser-based editor for the declarative
configuration of a Citadel AI Hub Gateway deployment. It presents Bicep parameter
files and their associated API Management policy documents as explained forms, and
writes surgical changes that leave unrelated comments and formatting untouched.

It is an operations tool, not a runtime component. It never contacts Azure,
authenticates to it, deploys, sends telemetry, or checks for updates. The gateway
it configures is deployed by the accelerator's own pipeline, exactly as before.

## How it completes the Citadel AI Hub

The [Citadel AI Hub Gateway](https://github.com/mohamedsaif/ai-hub-gateway-solution-accelerator/tree/citadel-v1)
is contract-driven. The model backends behind the gateway, the products and
subscriptions that grant access to them, and the policies that constrain them are
all declared as files in the repository and then deployed. That design is what
makes the gateway reviewable, reproducible and auditable.

It also means day-to-day operation is editing Bicep parameter files and API
Management policy XML by hand, in a repository where a misplaced comma in an
untyped array, or a parameter removed because its purpose was not obvious, is not
caught until a deployment fails or a policy silently stops applying.

The Control Plane is the interface over exactly those artefacts. It reads the
banner comments the files already carry and renders them as guidance, so the
explanation beside a field is the repository's own rather than a second copy that
drifts. It validates across files, not just within them. And every write is a
verified transaction: back up, write, verify hashes, restore on failure.

| Gateway concern | Declared in | Control Plane surface |
| --- | --- | --- |
| Hub infrastructure, networking, feature flags | `bicep/infra/main.bicepparam` | Azure Deployment |
| Model backends behind the gateway | `llm-backend-onboarding/main.bicepparam` | LLM Onboarding |
| Products, subscriptions and per-use-case policy | Access contract folders | Access Contracts |

The accelerator defines and deploys the runtime. The Control Plane is how its
configuration is operated between deployments.

## What it edits

The browser traverses only a directory or repository the operator selects, and the
scope is limited to `.bicepparam` files, the Bicep templates those parameters refer
to for schema, and the API Management policy XML belonging to an access contract.
Generated and unrelated directories are ignored.

Repository access is granted by the browser through the File System Access API, or
by a GitHub token scoped to the repositories it should reach. The container
receives no source mount, no Docker socket, no cloud credential and no broad host
filesystem access.

## What it looks like

Feature flags decide which capabilities the hub deploys at all. Turning one off
does not merely hide it: the resources behind it are not created, and the
parameters belonging only to it stop being asked for.

![Feature flags](./docs/images/10-deployment-features.png)

Address planning is checked against Azure's rules rather than a regular
expression. Overlapping subnets are named on both fields and block the save.

![Overlapping subnets](./docs/images/12-vnet-overlap.png)

`llmBackendConfig` is an untyped array in Bicep, so the compiler cannot help and
neither can a generic form. It gets a purpose-built editor covering every
supported provider, with credential handling that follows the provider.

![LLM backends](./docs/images/21-llm-backends.png)

Access contract policies are presented as the blocks they are made of, each one
switchable, with the raw XML always a click away. A model allowed here but never
onboarded is flagged by name.

![Contract policy](./docs/images/32-contract-policy.png)

## Guides

- [Deployment guide](./guides/deployment.md) — running on Azure, running locally,
  and the choices available during deployment.
- [Using Citadel Control Plane](./guides/using-the-control-plane.md) — workspaces,
  the three editing areas, validation, and how saves are made.

## Reference

Detailed reference for the application itself is kept with it:
[`CitadelUI/README.md`](./CitadelUI/README.md),
[`CitadelUI/SECURITY.md`](./CitadelUI/SECURITY.md) and
[`CitadelUI/BACKUP-RECOVERY.md`](./CitadelUI/BACKUP-RECOVERY.md).

## License

See [LICENSE](./LICENSE).
