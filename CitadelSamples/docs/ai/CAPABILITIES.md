# Runtime capabilities and activation

Evidence date: **2026-09-05**. Surface: GitHub Copilot app using CLI **1.0.80**,
Windows, local Git worktrees. Recheck when surface/version changes.

Evidence grades: **documented**, **tool-exposed**, **locally exercised**,
**verified in intended runtime**, **unchecked**. Execution modes:
**verified automatic**, **human assisted**, **unavailable**, **not yet checked**.
Tool exposure is not an exercised guarantee. Parent observations were supplied
in assignment `install-orchestration-protocol` v1. The later independent native
rehearsal and coordinator acceptance are recorded in
[BOOTSTRAP_RESULT.md](BOOTSTRAP_RESULT.md), including exact candidate/report
identity and tool-returned IDs versus reported aliases. These are not new
experiments by the evidence-documentation worker.

## Discovery

[Official CLI instructions documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
was read on the evidence date. It documents `AGENTS.md` in the repository root,
CWD, intermediate directories and ancestry of a file being worked on; relative
`@` includes in agent instructions; `/instructions` to inspect discovered/enabled
instructions; and restart/resume/new-session activation of changed instructions.
It does not establish that this app auto-loads a child-directory file before a
root-started session touches that subtree.

This project configures only [CitadelSamples/AGENTS.md](../../AGENTS.md), with two
relative includes. No root or user configuration is changed. Start a fresh session
on the integrated candidate with work in `CitadelSamples`; if the surface permits,
use `CitadelSamples` as CWD. Record actual discovered sources using supported
instruction diagnostics when available. First report what was already loaded;
then explicitly read the entrypoint and linked protocol/state. An explicit read
proves accessibility and fallback loading, **not automatic discovery**.

The reusable [rehearsal prompt](STARTUP_PROMPTS.md#fresh-session-rehearsal) works
from the repository root without relying on automatic child-directory discovery.
The coordinator must integrate/distribute the candidate into the branch used by
future sessions; files in one unshared worktree do not configure other sessions.
Do not modify global configuration to bypass this scope.

## Capability matrix

| Capability / worker type | Mechanism and evidence | Mode / limit |
| --- | --- | --- |
| Scoped instruction loading | CLI documentation above; fresh reviewer's pre-read inventory identified only injected root Agent notes, no identifiable child instructions or discovery diagnostics | Automatic discovery **UNCHECKED**; context presence does not establish automatic file loading |
| Explicit protocol read | Independent NEW native session explicitly read all eleven integrated guidance/fixture files; [accepted evidence](BOOTSTRAP_RESULT.md) | Locally exercised in the intended runtime through explicit fallback, not automatic loading |
| Roles and skills | Five prompts in [STARTUP_PROMPTS.md](STARTUP_PROMPTS.md); native `skill` exposed, `orchestrate` loaded by this worker | Prompts documented, skill loading locally exercised; not installed custom agents |
| Native independent child | `create_session`, `get_session`; parent observed separate branch/worktree/ID; this worker confirmed clean assigned HEAD | Locally exercised; verified automatic worktree creation only, not service/credential isolation |
| Native child observation | `get_session`, `notify_on_idle` events observed by parent | Locally exercised; status/output/idle are not proof of stopped processes or accepted work |
| Native child follow-up | `send_session_message` immediate delivery acknowledged by parent/worker tools | Locally exercised delivery; not interrupt, cancellation or ownership revocation |
| Native child replacement | New versioned packet and new isolated session via coordinator | Mechanism exposed; full writer-stop/transfer/recovery rehearsal unchecked |
| Native stop/archive | `archive_session` exposed for children created by the caller; parent reports archived sessions unavailable | No verified interrupt or external-effect cancellation; preserve artifacts before archive |
| Bounded task agent | `task` accepts complete task and returns bounded result; parent observed invocation | Locally exercised by parent; separate context does not isolate files/services |
| Background task agent | `read_agent` / `write_agent` exposed for supported multi-turn agents | Tool-exposed only here; same-invocation follow-up/control unchecked; do not assume native-session semantics |
| One-shot delegated invocation | Tool descriptions distinguish one-shot tasks from multi-turn agents | Documented/tool-exposed distinction; use new complete packet where follow-up unsupported |
| VS Code subagent | Source protocol cites [VS Code documentation](https://code.visualstudio.com/docs/agents/run/subagents) as stateless at its baseline | Different surface, not exercised here; do not impose that behavior on app/native/background workers |
| Save/recover Git artifacts | Fresh native reviewer located and quoted the saved partial fixture on the integrated candidate | Locally exercised access and SIMULATION continuity; no real writer transfer or artifact restoration performed |
| Session SQLite | Native `sql`, coordinator-only `orchestration_assignments`; `todos` UI projection | Session-local, not a shared worker DB; ownership rule is procedural, export needed for recovery |
| Exclusive integration | One named owner plus current-version/candidate review at integration | Human/agent-assisted procedure, **no observed enforced cross-session lock** |
| Exclusive external mutation | Resource reservations and explicit owner approval | No observed revocation/fencing; unsupported concurrent effects must stop |
| Orchestrator loss | Versioned checkpoint/export and explicit confirmed handover | Human assisted; **no observed automatic orphaned-orchestrator recovery** |
| Continue after all actors stop | No independently tested supervisor in this setup | Unavailable as a verified promise; Markdown cannot wake itself or clear context |

Do not infer that an idle child has no active tools, that acknowledgement stopped
it, or that a commit hash protects shared resources. Use the
[recovery procedure](SESSION_PROTOCOL.md#checkpoint-recovery-and-unknown-effects).
If native delegation is absent, a human opens the explicitly assigned child;
the parent does not take an inline implementation exception.

## Accepted bootstrap evidence and remaining limits

The coordinator accepted protocol v1 and the independent NEW read-only native
rehearsal with **explicit-fallback/local-SIMULATION limits**. See
[BOOTSTRAP_RESULT.md](BOOTSTRAP_RESULT.md) for the source submission, separately
identified integrated candidate, frozen report and four observed responses.
The reviewer used actual integrated files and reported instruction provenance,
identity, authority and recovery constraints without relying on automatic loading.

Automatic discovery remains **UNCHECKED**: no discovery diagnostic was available,
and injected root notes did not identify the child instruction files as loaded.
The four responses demonstrate reasoning over harmless local fixtures, not live
cancellation, external-write fencing or unattended recovery. Fixtures retain
their unexecuted-data labels; the separate result records the actual rehearsal.
No browser, live-product or deployment gate was accepted by this rehearsal.

This evidence-only amendment records the earlier candidate; it was not itself
loaded by that session. At recording, remote distribution had not occurred.
The parent owns safe integration/publication without publishing unaccepted UX.
Further capability upgrades require new bounded evidence, not a rereading of the
expected fixture answers.
