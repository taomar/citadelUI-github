# Compact recovery checkpoint

Checkpoint generation **1**, recorded **2026-09-05** for workflow bootstrap.
This is an index of the last accepted/reported product references and pending
work, **not a shared live task dashboard, new acceptance decision or lock**.
Confirm newer state with the coordinator before mutation.

| Identity | Checkpoint value |
| --- | --- |
| Repository / product | `taomar/citadelUI-github` / Citadel Publish Playground |
| Protocol | [SESSION_PROTOCOL.md](SESSION_PROTOCOL.md), version 1 |
| Integration owner | Parent session `890b92d0-09a1-4c0c-8829-2996b3160657`, Citadel samples playground |
| Integration branch at checkpoint | `taomar-citadel-samples-playground` |
| Bootstrap task / worker | `install-orchestration-protocol` v1 / `716c4efa-5de1-403e-aa97-e1952c8f7fce` |
| Workflow branch | `taomar-orchestration-protocol-setup` |
| Source baseline | `af36f847ab9fab01163115e85b0553438e6cb7fa`; workflow worktree initially clean |
| Accepted/released reference | Parent reports prior release `0e761de` was pushed; use [product handover](../../AGENT_PROGRESS.md) for detailed evidence, not this index |
| Unaccepted continuation | Source baseline is an unfinished UX checkpoint; older automated/browser evidence does not accept it |
| Tested workflow candidate | Exact frozen commit/tree and checks belong to the worker result packet and later integrated rehearsal packet, NOT the source-baseline SHA |

## Route, work and next action

Keep the accepted protected-source, declared-input, server-authoritative catalogue
route in [PRODUCT.md](../../PRODUCT.md). Keep workflow setup documentation-only
using native sessions/events/SQLite/Git; no orchestration software.

At this checkpoint the parent assigned two implementation workers:
UX child `667e866b-ca7c-471f-a627-f4bc2a142cdb` owns existing app/tests/UX documents
on `taomar-finalize-playground-ux`; this workflow child owns only
`CitadelSamples/AGENTS.md` and `CitadelSamples/docs/ai/`. Those are a historical
reservation snapshot, not permission to assume the workers remain active.
Query the parent for live versions/reservations; the [policy](POLICY.md) limit
counts both workers.

Workflow deliverables are the [entrypoint](../../AGENTS.md), protocol, policy,
[capabilities](CAPABILITIES.md), [templates](TEMPLATES.md),
[role prompts](STARTUP_PROMPTS.md), [fixtures](fixtures/README.md) and
[deployment handoff](DEPLOYMENT_HANDOFF.md). Submit a frozen candidate, then the
parent evaluates/integrates and launches a NEW read-only native rehearsal using
the durable prompt. Do not claim setup activated before that evidence.

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

Unresolved: fresh-session auto-discovery and rehearsal evidence, UX browser
acceptance after cleanup, live target/owner/region/cost approval and remaining
release gates. See [deployment handoff](DEPLOYMENT_HANDOFF.md); the companion
deployment brief was not supplied.

Bootstrap budget: one focused discovery/writing pass, one consistency pass and
at most one correction pass. Consumed/remaining budget and failed approaches are
recorded in the result packet; a fresh session cannot reset them. Stop/report if
root edits, expanded scope, external authority or unsupported automation are
needed. After submission, further workflow writes require an assignment amendment.
