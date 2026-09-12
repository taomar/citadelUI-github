# Repository instructions

Read `AGENTS.md` for repository boundaries, application conventions and tooling.
Read the applicable handover for the accepted source and remaining work.

## Delivery-first, reuse-first orchestration

Instruction revision: `result-handoff-v4` (action-owned result intake).

These rules govern orchestration alongside existing repository instructions.
Preserve the user's latest scope, model settings, required reviews, approval
gates and data-safety restrictions.

### Authority and roles

- Deliver the user's approved project queue, not coordination machinery.
  Approval of that queue is standing authority to execute its next ready tasks
  without another "continue" prompt.
- Process already-returned current results before optional policy maintenance.
  When a policy change is explicitly requested, make its bounded edit without
  treating "instructions updated" as completion of pending project work.
- A worker, task or phase finishing does not finish MAIN's overall job.
  Cancelled, speculative, deferred or unapproved handover items are not authority
  to expand the work.
- A status question does not revoke standing queue authority. Answer it briefly
  and continue the next authorized action unless the user explicitly pauses or
  redirects the work.
- Only a session explicitly designated MAIN coordinates workers. Workers own
  one bounded assignment at a time and must not create more workers or hidden
  helpers. Reading this file does not turn a worker into MAIN.
- Keep at most FIVE occupied worker sessions per MAIN, excluding MAIN itself.
  Running, blocked, idle and cleanup-pending workers all count. Five is a ceiling,
  not a requirement to invent enough work to fill every slot.

### Assignments and results

- Use named, visible child sessions and isolated worktrees. Keep one writer per
  owned scope. MAIN reviews and integrates in its own worktree.
- Assign each task once, with its required source revision, bounded scope,
  acceptance criteria and an accessible result-file path outside the worktree.
  Include MAIN's actual app session ID and the completion-handoff instructions.
  Keep only the small worker/task/attempt/result/state map needed for recovery.
- Dispatch through the actual session tools, not only a ledger update. A
  successful dispatch acknowledgement means dispatched, not proven running.
- Before ending a turn or calling `task_complete`, workers save and read back a
  concise completed/blocked/failed result. Identify the assignment and attempt,
  actual outcome, relevant checks, artifacts, remaining work and ownership
  release. Use a fresh result path for a substantive new attempt.
- Validate a result against its assigned owner/task/attempt and actual acceptance
  criteria. A completion label or a clean checkout alone is not proof of success.
- If a terminal worker's report is missing or invalid, use bounded read-only
  retrieval. If needed, allow at most one concrete publication-repair task at a
  new path. Preserve the earlier evidence. If recovery fails, report a specific
  blocker rather than waiting indefinitely for an already-finished turn.

### Change-driven reconciliation

Choose the read scope from the event or decision. Do not sweep the whole worker
pool for every message, callback or tool response.

- On a new `RESULT_READY`, read the matching current task/attempt report and
  update that task's outcome. Do not inspect every other worker or its history.
- On a relevant native idle/failure hint, refresh only the affected facts needed
  to act. Ignore already-handled hints without rereading unchanged workers;
  unfinished MAIN acceptance/integration/cleanup still remains actionable.
- On resumption, a current-status request, or a suspected missing handoff, use
  one shared `get_sessions_status` snapshot for the known owned workers and
  reconcile relevant current outcomes. Consume saved results even if notices
  were missed. Do not follow the snapshot with a `get_session` call per worker.
- Use `get_session` only for missing identity/path/metadata or a necessary
  safety fact not already established. If it omits a required fact, use one
  appropriate alternative source or report the gap; do not repeat that same
  unsupported read hoping it becomes useful.
- Reuse recorded outcomes and still-current metadata for pending actions.
  Refresh when a new attempt, relevant state/source change or fresh safety
  requirement makes that necessary. An informational question alone does not
  require a worker sweep when no current activity claim is needed.
- A read-only tool response is an observation, not new worker progress.
  It must not trigger another read by itself or restart a reconciliation cycle.
- Preserve fresh checks immediately before reuse or archival. Reducing redundant
  reads is not permission to act on stale ownership or activity information.
- Distinguish queued, dispatched, observed-running, reported, awaiting
  acceptance/integration, blocked and closed. Report running only when supported
  by a current activity observation. Preserve unknown or delivery-unconfirmed
  states rather than guessing.
- MAIN being marked busy and a task being marked assigned do not prove that
  a worker is executing or that the queue advanced.
- Result seen is not task closed. Keep outstanding acceptance, integration,
  reuse or cleanup actions until actually completed. Deduplicating a notification
  must not discard those unfinished MAIN actions.
- After inspection, perform the concrete next action or identify the blocker.
  Do not substitute another unchanged read for that action.

### MAIN's mandatory progress cycle

1. Use the event-specific read rules above and process available results,
   whether or not their idle notices arrived. Finish necessary acceptance or
   local integration. A blocked task must not hold independent completed work.
2. Close the previous assignment, then immediately REUSE a suitable idle worker
   for the next ready, compatible, already-authorized task. Keep its session ID;
   give it a concrete new task/attempt, source revision, scope and result path.
   Do not wait for the entire batch to finish or for another user prompt.
3. Reuse requires a completed handoff, released ownership, no conflicting
   unfinished work, and suitable model/source conditions. Any necessary safe
   source synchronization is performed by that worker. Never force-reset or
   discard work to make reuse possible.
4. Create a new worker only when no suitable reusable worker exists and the
   five-session ceiling permits it. Keep dependency-blocked tasks in the backlog.
5. If an idle worker has no suitable ready assignment and is genuinely no longer
   needed, archive it promptly once the safety conditions below hold. Do not keep
   speculative idle reserves. A slot is released only after archival succeeds;
   reuse neither releases nor consumes an additional slot.
6. Continue with the next actionable queue item. Do not substitute a status
   update or "all slots occupied" for acceptance, integration, reuse, dispatch or
   cleanup that can actually be performed.

For a concrete worker-scope blocker, MAIN may authorize a narrowly necessary
change only within the existing project permission and after checking ownership.
Otherwise state the exact decision or dependency needed and advance other
independent work. Do not bypass explicit user restrictions or required reviews.

### Every returned result requires a MAIN disposition

A current terminal report transfers the next-action responsibility to MAIN.
Do not leave that attempt labelled running or wait for its worker to finish again.

- A completed candidate starts MAIN acceptance: inspect the necessary changes,
  run the required targeted checks, and arrange any required independent review.
  If a review is required, identify the assigned reviewer and exact candidate;
  if none is assigned, assign it within authority/capacity or state that constraint.
- A blocked/failed result requires a concrete resolving action, a scoped
  correction, or one precise user decision. Record what is blocked and who owns
  the next action, then advance independent work.
- Keep code acceptance, source integration, worker ownership release and
  archival eligibility separate. A release is not automatic acceptance; an
  archive-only host-state question does not automatically block safe review or
  integration of an otherwise eligible preserved candidate.
- If a required host fact cannot be established, use one appropriate
  authoritative source or ask the necessary specific question. Do not repeatedly
  ask a finished worker to perform the same unsupported release check.
- Keep the unfinished MAIN action in the existing task map. A read receipt,
  callback deduplication or "result received" note is not a disposition by itself.
  Before yielding, no returned result may be orphaned without an actual next
  action or a named external dependency.

### When MAIN may yield

Before yielding, check recorded outcomes and the approved queue for actionable
work. If a worker could have finished since the last observation or handoff state
is stale/unknown, make one fresh missing-handoff check; do not run a second
unchanged sweep merely because the turn is ending. If acceptance, integration,
an authorized unblock, reuse, dispatch or eligible cleanup is ready, perform it.

End the turn only when:

- The approved queue is complete and every worker is accounted for; or
- No authorized action is feasible and progress genuinely depends on active
  work, an unmet dependency, a permission/ownership decision or another concrete
  external condition. Name that condition and the next action it enables.

Report a blocked queue as blocked, not completed. Do not mark MAIN's overall job
complete merely because an individual worker or phase ended. Do not repeat an
unchanged failing step without a material change or new evidence.

If all owned workers are idle and no known in-flight operation can produce
progress, do not merely say "waiting for workers". Consume available results,
close unfinished handoffs, dispatch ready work, or name the exact dependency,
permission or delivery failure. MAIN's own busy indicator is not an in-flight
worker operation.

### Completion handoff: one result callback, no acknowledgement chain

- After publishing and reading back a completed, blocked or failed result,
  the worker sends exactly ONE compact `RESULT_READY` message to the MAIN app
  session ID supplied in its assignment, using `send_session_message` with
  immediate delivery. Include actual task/attempt identifiers, outcome state
  and the saved report path; do not send the full report or progress chatter.
  Then end the worker turn. Never guess IDs or send placeholder values.
- MAIN does not acknowledge this message. It consumes the affected result and
  acts: acceptance, integration, a concrete correction, reuse or eligible cleanup.
- This explicit result callback replaces the earlier blanket prohibition on
  completion callbacks. Native idle/failure notifications may remain enabled
  as secondary lifecycle hints, but are not the only result-delivery mechanism.
  Handle both through the change-driven rules and the same task/outcome map,
  not as two independent triggers for full-worker sweeps.
- For app-created workers, keep `coordinate_with_creator: false` to avoid an
  additional implicit reply-back instruction. `notify_on_idle: "always"` may
  provide lifecycle hints; it is not evidence that a handoff was delivered.
- Deduplicate by assigned task/attempt/result identity, not transport event ID
  or delivery timestamp. Ignore already-closed outcomes, but continue any
  outstanding MAIN action. Neither native notices nor callbacks authorize
  archive/reuse without the actual safety checks.
- If callback delivery fails or is uncertain, preserve the report and state the
  delivery problem. Do not repeatedly resend or create another worker for it.
- No polling, status pings, acknowledgement chains, repeated unchanged-history
  searches, timers or recurring monitoring. Useful independent work is allowed;
  staying active merely to monitor is not.
- Instructions cannot repair the app's event transport or wake a session when
  no event is delivered. Report that platform limitation instead of claiming
  uninterrupted background advancement.

#### Apply the handoff contract to existing assignments

Updating MAIN's policy does not rewrite instructions already sent to workers.

- For workers already finished/idle, consume their current saved outcomes now.
  Do not wake them merely to backfill a callback or repeat finished execution.
- For a still-running real attempt that demonstrably lacks completion routing
  or still forbids callbacks, send one narrowly scoped routing correction:
  continue the same task, save the existing assigned result, then send one
  `RESULT_READY` to the supplied MAIN ID. Do not restart work or change its scope.
- Do not send that correction to attempts already configured correctly.
  This is a necessary delivery correction, not a policy broadcast or status ping.
- Include the completion contract explicitly in every new/reused assignment;
  do not assume an old worker checkout automatically inherited MAIN's edit.

### Safe archival

- Archive only your own genuinely finished child sessions. First confirm that
  writers have stopped, needed work is accepted/preserved, and there is no unique
  unmerged/unsaved work, open PR, active merge, pending task, background work or
  attached automation.
- Preserve needed code, reports and artifacts outside the worktree before
  archiving; archival removes that worktree. Never discard work to free capacity.
- If cleanup is unsafe, retain the session with a specific reason and next
  action, then continue independent work.
- Do not restore archived sessions merely to reuse them. Inherited sessions may
  require their original parent or the user to archive them.

### Optional recovery wake-up: fail closed

These are requirements for a separately authorized recovery component, not
permission to create a timer, sixth LLM session or supervisor. Instructions alone
do not implement this component. Prefer deterministic event-driven code with a
durable pending-event store, not an LLM deciding whether to wake another LLM.

Before any recovery wake, ALL applicable conditions must be positively verified:

- The exact MAIN and queue are explicitly opted in and the current approved
  scope is active; neither the user nor the host has paused, stopped, cancelled
  or archived them.
- A fresh authoritative observation shows MAIN responsive and idle, with no
  active turn or foreground/tool operation. Silence or an old ledger label is
  not evidence of idleness.
- MAIN is not awaiting user input, permission, plan approval, authentication,
  quota intervention or another human-controlled gate.
- There is a concrete current action: an unconsumed registered result, pending
  acceptance/integration/eligible cleanup, or an authorized ready task whose
  prerequisites can be met. Idle workers or elapsed time alone are not triggers.
- The triggering identity, attempt, report path and scope match the current
  registration. The event/queue revision is not already handled, superseded,
  cancelled, or covered by another outstanding recovery wake.
- There is no pending user/steering message that should be processed first, and
  no recovery wake is queued, sending, or awaiting acknowledgement.
- Capacity and ownership permit the particular action. Five occupied slots do
  not block a wake to process results or cleanup; they do block creating a sixth
  worker when no safe reuse or released slot exists.
- State is rechecked immediately before dispatch. If it changed, became stale,
  or cannot be established from supported observations, keep the event pending
  and report the reason instead of sending.

Atomically claim/coalesce pending events so concurrent signals cannot produce
multiple recovery messages. Persist claims, delivery outcomes and acknowledgements
across restarts. An uncertain send is not permission for blind replay.
The recovery component may request one MAIN reconciliation only: it must not
unpause queues, approve prompts, kill/restart processes, reassign project work,
delete worktrees, change models, push or deploy.

These checks must be enforced by the recovery implementation. If its adapter
cannot obtain a required gate, automatic waking stays disabled for that case.
Gate facts must come from trusted runtime/configuration observations, not from
worker report claims or an LLM manufacturing a safe-looking snapshot. Readiness,
dependencies and ownership must be established for each work item separately.
No software or LLM supervisor can be promised to never fail.

### Keep coordination small

Do not create timing-receipt infrastructure, detailed audit pipelines,
policy-maintenance tasks or preflight-only workers unless specifically requested.
Do not restart assignments, backfill administrative records, broadcast policy
changes to busy workers or change the project backlog merely to adopt instructions.
These are operating rules, not a code-enforced scheduler or a reliability guarantee.
