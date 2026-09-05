# Compact recovery checkpoint

Checkpoint generation **2**, recorded **2026-09-05** after coordinator acceptance
of protocol v1 and its independent explicit-fallback/SIMULATION rehearsal.
This is an index of the last accepted/reported product references and pending
work, **not a shared live task dashboard, new acceptance decision or lock**.
Confirm newer state with the coordinator before mutation.

| Identity | Checkpoint value |
| --- | --- |
| Repository / product | `taomar/citadelUI-github` / Citadel Publish Playground |
| Protocol | [SESSION_PROTOCOL.md](SESSION_PROTOCOL.md), version 1 |
| Integration owner | Parent session `890b92d0-09a1-4c0c-8829-2996b3160657`, Citadel samples playground |
| Integration branch at checkpoint | `taomar-citadel-samples-playground` |
| Evidence amendment | `install-orchestration-protocol` v2; v1 remains accepted in coordinator history |
| Workflow worker | Tool-returned ID `8528f459-d903-4a21-9fbe-c816317a6e41`; reported alias `716c4efa-5de1-403e-aa97-e1952c8f7fce`; [mapping evidence](BOOTSTRAP_RESULT.md#session-identifiers) |
| Workflow branch | `taomar-orchestration-protocol-setup` |
| Original product baseline | `af36f847ab9fab01163115e85b0553438e6cb7fa`; original workflow worktree initially clean |
| Evidence-amendment baseline | Source submission `2fb0d6fc38027eda8a561796da0beb8a2280a472`; worktree clean before v2 |
| Accepted/released reference | Parent reports prior release `0e761de` was pushed; use [product handover](../../AGENT_PROGRESS.md) for detailed evidence, not this index |
| Unaccepted continuation | Product UX remains separately in review; protocol acceptance does not accept UX/browser/live gates |
| Independently rehearsed candidate | Integrated `d1093f927e18d30ada9c0f7ec3f48c536e515651`; exact tree/report and source distinction in [bootstrap evidence](BOOTSTRAP_RESULT.md) |

The source submission and integrated rehearsal are different commits even though
their trees match. This generation-2 evidence amendment was not loaded by that
rehearsal; its own submitted candidate identity belongs in the v2 result packet.

## Route, work and next action

Keep the accepted protected-source, declared-input, server-authoritative catalogue
route in [PRODUCT.md](../../PRODUCT.md). Keep workflow setup documentation-only
using native sessions/events/SQLite/Git; no orchestration software.

At generation 1 the parent assigned two implementation workers:
UX child `667e866b-ca7c-471f-a627-f4bc2a142cdb` owns existing app/tests/UX documents
on `taomar-finalize-playground-ux`; this workflow child owns only
`CitadelSamples/AGENTS.md` and `CitadelSamples/docs/ai/`. Those are a historical
reservation snapshot, not permission to assume the workers remain active.
Query the parent for live versions/reservations; the [policy](POLICY.md) limit
counts existing implementation workers, not only newly launched ones. The current
v2 amendment permits only evidence updates to `CAPABILITIES.md`,
`PROJECT_STATE.md`, new `BOOTSTRAP_RESULT.md` and an optional entrypoint link.
It does not reopen app, fixture, policy or protocol-semantic work.

Workflow deliverables are the [entrypoint](../../AGENTS.md), protocol, policy,
[capabilities](CAPABILITIES.md), [templates](TEMPLATES.md),
[role prompts](STARTUP_PROMPTS.md), [fixtures](fixtures/README.md) and
[deployment handoff](DEPLOYMENT_HANDOFF.md). The parent accepted v1 and the new
native rehearsal; [BOOTSTRAP_RESULT.md](BOOTSTRAP_RESULT.md) records that durable
evidence and next-startup links, not live task state. Next, submit the frozen v2
evidence delta for parent integration and safe distribution. No further reviewer
or app/browser run is part of this evidence-only amendment.

Parent-reported earlier 992/992 Node and 23/23 smoke results preceded unfinished
dynamic UX cleanup. Its candidate-specific browser gate remains pending.
[AGENT_PROGRESS.md](../../AGENT_PROGRESS.md) includes earlier accepted evidence;
[CONTINUATION-PLAN.md](../../CONTINUATION-PLAN.md) owns outstanding browser,
assistive-technology and live/release gates. No live gate was satisfied by this
documentation task.

## Recovery locations and unresolved effects

Local machine snapshot (Windows paths, not portable configuration):

```text
Parent worktree:
C:\Users\tarekomar\.copilot\repos\copilot-worktrees\citadelUI-github\taomar-probable-spoon
Workflow worktree:
C:\Users\tarekomar\.copilot\repos\copilot-worktrees\citadelUI-github\taomar-miniature-disco
Parent artifact directory:
C:\Users\tarekomar\.copilot\session-state\890b92d0-09a1-4c0c-8829-2996b3160657\files
Workflow artifact directory:
C:\Users\tarekomar\.copilot\session-state\8528f459-d903-4a21-9fbe-c816317a6e41\files
```

Use `get_session` to reconcile actual paths/branches and accessibility. Durable
committed guidance lives with the Git candidate; assignment/result exports belong
in versioned session artifacts. The live registry is the parent's
`orchestration_assignments` table accessed by its SQL tool, not by worker SQL.
On parent loss, the replacement needs the latest accessible registry export and
confirmed coordinator transfer. The presence of an artifact directory does not
prove an export exists; if missing, freeze affected assignments and reconstruct
with the former owner/operator before issuing new work.

The parent reported a detached user preview, handle `final-playground-server`,
at `*.localhost:50672`. This is a reservation, not a verified current process
status or complete launch URL. This worker did not probe or control it. Do not
persist bootstrap/cookies/credentials or stop/restart the preview. Workflow work
has no authorized external mutations or owned long-running operations.

Unresolved: automatic discovery remains **UNCHECKED**, remote distribution had
not occurred at recording, product UX/browser acceptance remains separate, and
live target/owner/region/cost approvals and release gates remain open.
The accepted rehearsal proves explicit reads and four local SIMULATION responses
only. See [deployment handoff](DEPLOYMENT_HANDOFF.md); the companion deployment
brief was not supplied. Parent publication must not include unaccepted UX.

Evidence-amendment v2 budget: one evidence-writing pass and one link/path/scope
consistency check, with no review recursion or app/browser suites. The preserved
v1 result retains its consumed budget/history; this amendment does not reset it.
Record v2 consumed/remaining budget in its result packet. Stop/report if scope or
authority must expand. After submission, freeze; further writes need an amendment.
