# Accepted bootstrap evidence

Recorded 2026-09-05 under `install-orchestration-protocol` v2, evidence-only.
This is a durable evidence summary, not a mutable assignment registry.
Coordinator `890b92d0-09a1-4c0c-8829-2996b3160657` accepted source task v1 and
`rehearse-citadel-samples-protocol` v1 with **explicit-fallback/local-SIMULATION
limits**, as communicated at `2026-09-05T14:11:02.690+00:00`.
The original reviewer packet retains its earlier review disposition; the later
coordinator decision establishes acceptance.

## Candidate and report provenance

| Evidence identity | Value |
| --- | --- |
| Original source baseline | `af36f847ab9fab01163115e85b0553438e6cb7fa` |
| Frozen workflow source submission | `2fb0d6fc38027eda8a561796da0beb8a2280a472` |
| Integrated candidate actually rehearsed | `d1093f927e18d30ada9c0f7ec3f48c536e515651` |
| Complete tree shared by those two commits | `c18a18463f06d4998be836f369b0a5faee8a185e` |
| Rehearsal environment | NEW read-only native session; Windows, Copilot CLI 1.0.80; clean isolated worktree |
| Report | `rehearse-citadel-samples-protocol-v1-result-g1.md`, generation 1 |
| Report SHA-256 | `972684807123FDCC87EB2CD8BF01F714B04183A0FF21B4C3E254A85EEC94C4F1` |

Different commit identities remain distinct even when trees match. The
coordinator read and hash-verified the full report and checked its candidate/ID
mapping; the v2 evidence worker also read all 398 lines and verified the same hash.
The original accepted report is preserved, not rewritten by this summary.
Local evidence location (not a portable configuration path):

```text
C:\Users\tarekomar\.copilot\session-state\e6323b34-67dc-45f9-b5a6-edf3c527a801\files\rehearse-citadel-samples-protocol-v1-result-g1.md
```

## Session identifiers

The coordinator verified these pairs with `create_session`/`get_session` results.
Each pair resolves to the same worker/worktree, not two workers. These labels
describe tool-returned IDs and reported aliases only; no runtime-layer distinction
is inferred from the IDs or from terminology in the original packet.

| Role | Tool-returned ID used in coordinator registry | Reported alias |
| --- | --- | --- |
| Workflow worker | `8528f459-d903-4a21-9fbe-c816317a6e41` | `716c4efa-5de1-403e-aa97-e1952c8f7fce` |
| Independent rehearsal | `e6323b34-67dc-45f9-b5a6-edf3c527a801` | `1708801f-7681-445a-a947-c6006b0245ed` |

## Observed startup and simulation outcomes

Before explicit reads, the reviewer identified only injected root Agent notes,
workspace metadata and its assignment envelope. No child entrypoint/protocol/state
was separately identifiable as loaded; no discovery diagnostic or `/instructions`
output was available. **Automatic discovery remains UNCHECKED.**

Native `view` then read all eleven integrated guidance/fixture files in full.
Explicit fallback worked in the NEW native session: the reviewer identified the
protocol marker, protected-source route, single integration owner, assignment/
candidate distinctions, authority, freeze, worker limit and retry rules. Its
57 local link/include occurrences had no missing targets; this path inspection
did not establish external URL validity or automatic heading validation.

The report's Scenarios 1-4 record these actual **SIMULATION reasoning** outcomes:

| Scenario and exact inputs | Observed response |
| --- | --- |
| Fresh resume: [scenarios.json](fixtures/scenarios.json) `fresh_resume` and [unfinished-artifact.md](fixtures/unfinished-artifact.md) | Quoted saved draft bytes, preserved the unresolved capability-diagnostic versus owner-review question, retained the one-diagnostic budget, and required writer transfer before editing. No real restoration/replacement performed. |
| Stale result: [scenarios.json](fixtures/scenarios.json) `stale_result` | Rejected v1 against current v2/owner/contract despite its claimed passing check; retained old draft as reference only. No registry mutation. |
| Unknown effect: [scenarios.json](fixtures/scenarios.json) `unknown_external_effect` | Reconciled the same synthetic operation from unknown to succeeded using supplied terminal-status and image-B resource readback; noted no observation timestamp; no retry or live provider call. |
| Route change: [scenarios.json](fixtures/scenarios.json) `route_change` | Kept the label fix an ordinary child task; treated shared relay state/scale-out as material and proposed, not approved; paused/blocked affected v1 work, preserved partials and required authority/new v2 contracts before reassignment. Independent copy work could continue. |

Full fixture paths are under `CitadelSamples/docs/ai/fixtures/`; the
[fixture rubric](fixtures/README.md) remains unchanged. Fixture `executed: false`
describes the supplied inert data, not the status of this separate reasoning
rehearsal. No live recovery, cancellation, credential revocation, cross-session
lock, external fencing or unattended coordinator takeover was demonstrated.

## Remaining gates and next startup

This evidence-only v2 amendment was **not** the candidate loaded by the reviewer.
Remote distribution had not occurred at recording; the parent will coordinate
safe publication without unaccepted UX. Product UX remains separately in review;
no browser, assistive-technology, live-scenario or deployment gate was accepted
by the protocol rehearsal. The [deployment handoff](DEPLOYMENT_HANDOFF.md)
retains missing target/owner/region/cost/authority decisions and deployment brief.

For a fresh session, explicitly read [CitadelSamples/AGENTS.md](../../AGENTS.md)
and its protocol/checkpoint, then select the applicable
[startup prompt](STARTUP_PROMPTS.md) with a current complete assignment.
Use the [rehearsal prompt](STARTUP_PROMPTS.md#fresh-session-rehearsal) only for a
new authorized rehearsal; it is not an instruction to repeat one now.
The coordinator's registry remains authoritative; this evidence grants no work,
publication or external authority.
