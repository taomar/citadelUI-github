# CitadelSamples session entrypoint

Scope: `CitadelSamples` and descendants, not the Control Plane or root accelerator.
Workflow identifier: `citadel-samples-protocol-v1`.

@docs/ai/SESSION_PROTOCOL.md
@docs/ai/PROJECT_STATE.md

At startup, read the linked protocol and checkpoint if they were not included.
Report your role, task ID/version, actual workspace/branch/HEAD, authority, and
next action before mutation. Reconcile the current assignment with its owner;
the checkpoint is not a live task registry or a grant of permission.

Every complaint, including a small ordinary fix, uses structured orchestration:
the parent coordinates/evaluates/integrates; an assigned child implements.
There is no small inline implementation exception. A child already assigned
implementation does that bounded work, not recursively delegate it.

Read [policy](docs/ai/POLICY.md) before acting.
[Startup prompts](docs/ai/STARTUP_PROMPTS.md),
[task/result/checkpoint templates](docs/ai/TEMPLATES.md), and
[runtime capabilities and activation](docs/ai/CAPABILITIES.md) are available
without prior chat. Use existing [product handover](AGENT_PROGRESS.md),
[release gates](CONTINUATION-PLAN.md), and [product contract](PRODUCT.md);
historical evidence does not verify a newer candidate.

CLI documentation supports scoped `AGENTS.md` and relative includes. This file
does not ensure repository-root sessions load child instructions before touching
this subtree, does not configure every Copilot surface, and cannot update
already-running sessions. Automatic discovery here still needs the fresh-session
rehearsal; explicit reading is the supported fallback, not proof of auto-loading.
