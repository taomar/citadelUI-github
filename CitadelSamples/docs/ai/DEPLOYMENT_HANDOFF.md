# Deployment engineering handoff

This is a read-only routing brief, not deployment approval or an executable plan.
`DEPLOYMENT_BUILD_INSTRUCTIONS.md` was **not supplied**. Its contents, parameters
and approvals must not be invented. A future deployment child needs that brief
or an explicit replacement approved by the owner, plus a current
[task contract](TEMPLATES.md).

## Existing topology, not a new proposal

The authoritative implementation/runbook is
[`playground/infra/README.md`](../../playground/infra/README.md), with
[`main.bicep`](../../playground/infra/main.bicep) and the deliberately
non-deployable [`main.bicepparam`](../../playground/infra/main.bicepparam) example.
These describe two Container Apps in an **existing managed environment, registry
and Key Vault in the same resource group**:

| Surface | Existing contract |
| --- | --- |
| Public playground | External ingress; exact tenant/audience through Entra Easy Auth, then `Citadel.Operator` or deployment-owned principal/group allowlist; separate user-assigned identity with `AcrPull` and relay-token use |
| Internal relay | Internal ingress; exact calling application/playground identity and relay audience; separate identity with `AcrPull` and Key Vault Secrets User; logical secret references, not browser-selected vaults or secret values |
| Relay execution | HTTP/assertion-only; no Python, Azure CLI, process executor or arbitrary artifact writer |
| Scaling/rollout | Direct nonce/admission state is process-local; one replica per active revision, drain acknowledgement validity window; no horizontal scale-out without shared atomic state |
| Future process jobs | Fresh immutable no-ingress job per run is a candidate only, subject to independent live isolation/security gates |

Managed-run state-machine offline evidence is not proof that a durable store/job
adapter is deployed. Existing immutable-image, destination-policy and application
registration prerequisites remain in the infra runbook; do not copy or relax them.
This worker inspected documentation, not Azure provider state, and made no calls.

This is **not** the seven-resource `CitadelUI` azd application and **not** the root
gateway accelerator. Do not run root `azd up`, reuse Control Plane approvals, or
generate root infrastructure for the playground.

## Decisions and evidence still required

[CONTINUATION-PLAN.md](../../CONTINUATION-PLAN.md) remains the authoritative
external gate/runbook, including browser/assistive-technology coverage and live
scenario sequencing. [PROJECT_STATE.md](PROJECT_STATE.md) identifies the current
unaccepted candidate caveat; the handover's earlier passes cannot close newer UX
browser gates.

Before external work, the named environment owner must supply/approve the exact
non-production subscription/tenant/cloud/resource group/targets, existing resource
identities, access boundaries, region, operator permissions, cost ceiling,
duration/cleanup responsibility, rollback/residue plan and intended mutations.
**Region is unresolved**; do not inherit the Control Plane's unconfirmed West
Europe assumption. No target, owner approval or budget is established by this file.

Current outstanding categories are candidate-specific browser acceptance;
Firefox/Safari/real screen-reader coverage from the continuation plan; live
scenarios 1-16 including `a2aProperties`/API-version behavior; redacted golden live
evidence; then gated Policy bursts and Lifecycle cleanup; and live relay
identity/authentication/authorization/network/rotation/cancellation/timeout/
partial-failure checks. Do not turn this summary into a second status queue.

Use the [deployment startup prompt](STARTUP_PROMPTS.md#deployment-engineering).
Until a complete authorized contract exists, prepare only read-only/offline
findings. For any eventual operation record intended effect, provider operation
identity, observed status and reconciliation method. Outcome unknown blocks retry;
a timed-out client is not proof that a deployment failed.
