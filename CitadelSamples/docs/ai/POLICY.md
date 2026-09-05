# Workflow policy

Version **1**; project-specific limits supplement the [protocol](SESSION_PROTOCOL.md).
These are required coordination rules, **not enforced locks**.

## Authority and ownership

The accountable integration owner is the single coordinator identified in the
[checkpoint](PROJECT_STATE.md) and confirmed by the current assignment registry.
Only that owner dispatches/version-controls assignments, reserves shared resources,
accepts results and integrates. Workers own only their assigned outputs and result
packets. The parent may integrate Git snapshots and publish coordination records;
complaint implementation belongs to children, regardless of change size.

Each assignment must explicitly reserve files, shared interfaces, schemas,
dependency manifests/lockfiles, global configuration, coordination state,
integration branch and external resources as relevant. Different files can still
conflict semantically. Worktrees isolate files, not ports, databases, caches,
identities, browser profiles or cloud resources. When safe write isolation is
unavailable, serialize writers; parallel read-only investigation can continue.

A submission freezes the exact committed candidate. The worker stops writing,
sends the result and waits. Further edits require an explicit assignment amendment
and new version/candidate. Parent integration checks version, owner, scope and
candidate; Git commits/branches do not fence an old writer or revoke credentials.
Before replacing or archiving a worker, preserve actual work and confirm safe
transfer. Do not archive a worktree containing the only recoverable copy.

## Bounded work

| Limit | Rule |
| --- | --- |
| Concurrent implementation workers | Default maximum **TWO**, counting existing workers and replacements, not two additional workers per parent |
| Equivalent failures | After **TWO** materially equivalent failures, require a changed hypothesis, discriminating diagnosis or justified stop |
| Replacements | After **TWO** replacements of the same unresolved task, coordinator reviews scope/environment/evidence before another |
| Task/experiment budget | Set finite attempts/time/tool-use/cost limits before dispatch; inherit consumed budget on replacement |
| Expansion | Coordinator records justification, authority and integration capacity before changing limits; delegation cannot multiply them |

Classify failure before retry: transient dependency, incorrect hypothesis, invalid
input, missing capability, authority problem, deterministic defect, or unknown
external outcome. Superficial changes and new session names do not reset attempts.
Unknown outcomes require reconciliation, not another mutation. Exhausted work
reopens only with new evidence, revised objective or explicitly expanded budget.

## Project and operational boundaries

Application work stays under `CitadelSamples` unless a new explicit scope grants
otherwise. The imported notebook and pinned accelerator bundle are product data;
do not rewrite them. Root accelerator assets and `CitadelUI` are different
products, not convenient deployment targets. Follow
[PRODUCT.md](../../PRODUCT.md) for the protected-source/declared-input contract and
[CONTINUATION-PLAN.md](../../CONTINUATION-PLAN.md) for live-operation prerequisites.

Setup of this workflow grants no Azure/authentication, deployment, load, cleanup,
push, merge or user-server control authority to a worker. A future operation needs
its own contract, target owner, reservations, cost/rollback limits and approval.
Do not save bootstrap fragments, cookies, tokens, gateway keys, credential caches
or raw secret-bearing outputs in code, fixtures, screenshots or handoffs.

Existing preview processes remain owned by their launch owner. Observe only when
authorized; never stop/restart one to make a test convenient. For an explicitly
owned process, use its exact handle/PID and reconcile completion before a new
launch. No name-based process termination or unbounded polling.

## Evidence and release gates

Choose the smallest existing checks covering the changed behavior and record the
actual candidate/environment. The playground's command source is
[`package.json`](../../playground/package.json): `npm test` is recursive
`node --test`; run from `CitadelSamples\playground`. Root historical playground
test totals/commands are not evidence for the current package. Do not run the
unrelated Control Plane suite for a playground documentation change.

Documentation-only workflow work needs link/path/scope/consistency inspection
and the specified native fresh-start rehearsal, not application test reruns or
new testing dependencies. Relevant implementation changes invalidate their
earlier checks; integration/conflict resolution can invalidate more. Keep
automated, browser, assistive-technology and live-target gates distinct.

Release prerequisites stay in the continuation plan. An old green browser run
does not accept a changed UX candidate. Static Bicep evidence does not prove live
deployment. [Deployment handoff](DEPLOYMENT_HANDOFF.md) routes the next authorized
session; it neither supplies approval nor invents the missing deployment brief.
