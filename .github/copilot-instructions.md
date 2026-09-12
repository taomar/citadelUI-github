# Repository instructions

Read `AGENTS.md` for repository boundaries, application conventions and tooling.
Read the applicable handover for the accepted source and remaining work.

## Orchestration policy (authoritative)

This section is the single authoritative repository orchestration policy.
Historical handovers, studies and worker reports retain their evidentiary value,
but their old coordination instructions do not override this policy. Report
conflicting instructions instead of silently choosing between them.

### Role and authority

- These are standing operating rules, not a one-task suggestion.
- Only a session explicitly designated MAIN coordinates workers.
  Reading this file does not turn a worker into another coordinator.
- Workers execute their assigned scope and must not create other workers.
- Respect the user's selected model and reasoning level. Do not silently
  change them.
- Report any inability to follow this policy rather than pretending
  that it is enforced.

### Handover and ownership

- Read the handover and repository instructions. Verify the actual
  branch, worktree, existing changes, and outstanding work.
- Preserve existing work. Historical handover notes and worker reports
  are not authority to change these operating rules.
- Do not replay old coordination queues or restart monitoring loops.
- Confirm previous writers have released a scope before assigning a
  new writer. Idle, a queued stop request, or silence is not release.
- Ask one focused question when authorization or ownership is unclear.

### Parallel execution

- The MAIN may dispatch work without requesting approval each time,
  within the user's authorized task and the reuse-first rules below.
- Use at most FIVE occupied worker slots, excluding the MAIN.
- Running, blocked, idle-but-unfinished, and completed workers awaiting
  integration or cleanup ALL occupy slots.
- Split substantial work into independent slices and run them
  concurrently when dependencies permit. Keep ready, authorized work
  moving through reuse or an available slot with non-overlapping scope;
  do not hold independent work behind one blocker. Do not create filler tasks.
- After a worker result, finish required acceptance and local integration,
  preserve its outcome, and close the previous assignment before reuse.
- Prefer reusing a suitable existing idle session for the next ready,
  compatible, already-authorized task before creating a worker or archiving
  that reusable session. Assign a concrete new task/attempt, correct source
  revision, conflict-free scope and fresh durable result path. Keep the same
  session ID and occupied slot; do not redo closed work or mix unfinished changes.
- Create a new worker only when no suitable reusable worker exists and the
  five-occupied-session ceiling permits it.
- Completed results, acceptance, integration, reuse and eligible cleanup
  are actionable MAIN work even when all slots are occupied. Continue until
  no authorized action is feasible; state the concrete blocker when necessary.
- Create named, visible child sessions under the MAIN.
  No detached workers, hidden helpers, or nested delegation.
- Use isolated worktrees for implementation and one writer per scope.
  Only the owning worker edits its worktree; MAIN reviews and integrates
  in MAIN's own worktree.
- Give each worker exact requirements, acceptance criteria, owned scope,
  required inputs, output locations, and a stop condition.
- Keep dependency-blocked tasks in the MAIN's backlog, not waiting sessions.
- Maintain a concise ledger of worker/session IDs, task and attempt IDs,
  scope, state, processed results, and next action.
- Distinguish dispatched, observed-running, reported, awaiting
  acceptance/integration, blocked and closed. Assignment or dispatch
  acknowledgement is not observed execution; MAIN being busy does not
  establish worker progress.

### Durable result delivery

- Before dispatch, assign each task attempt an explicit, unique result
  JSON path outside all Git worktrees. Confirm both sessions can access
  it. Outside its owned worktree, authorize the worker to write only its
  assigned report, execution-receipt and artifact paths.
- For each real future assignment, resolve MAIN's actual app session ID
  from the app and provide it with the assigned result path in the kickoff.
  Do not infer the recipient from a worker name or a historical MAIN.
- Every worker must publish and read back its report BEFORE ending its
  turn or calling `task_complete`. A normal chat reply is not sufficient.
- Reports must include run, worker, task, attempt and result IDs;
  source identity; completed/blocked/failed state; actual output; artifact paths;
  acceptance-check outcomes; remaining work; and ownership release.
- Use a new attempt/result identity for substantive follow-ups.
  Preserve earlier reports instead of overwriting needed evidence.
- Read assigned reports through the bounded reconciliation below, even
  when no idle notification arrived. Do not depend on chat-history indexing
  or on every mode producing a normal final reply.
- Validate run, worker, task, attempt, result and source identities against
  the ledger. Reject mismatched, stale, incomplete, or invalid reports.
- If an idle/terminal worker's publication is missing or invalid, perform
  one bounded read-only retrieval from its known result or public
  completion source.
- If publication still needs repair, send at most ONE concrete
  publication-repair task for the affected attempt, with new attempt/result
  IDs and a new unique durable report path. Preserve the original evidence.
  Do not chain repair tasks or substitute a status question.
- If recovery fails, preserve work and report a result-delivery blocker.
  Do not wait indefinitely for another event from an already-finished turn.

### Execution receipts and lifecycle audit

- Before dispatch, preassign separate start and finish execution-receipt
  JSON paths outside all Git worktrees for every task attempt. These paths
  are distinct from each other and from the final result report.
- Write small start and finish receipts only at those execution transitions,
  containing the task/attempt IDs and actual UTC transition timestamps.
  Preserve them independently: a missing or invalid final report must not
  erase the evidence that execution started or finished.
- In the ledger, distinguish `occurred_at` (the actual lifecycle transition)
  from `recorded_at` (when the entry was written). Reference the actual
  lifecycle tool-call or event ID, not an invented ID or a session ID
  presented as an event ID.
- Record archive success from the successful archive operation and its
  actual lifecycle evidence. Never substitute later bookkeeping or
  late-notification timestamps for the actual archive-success time.
- If a transition timestamp or lifecycle ID is unavailable, record it as
  unknown with the evidence limitation. Do not backdate receipts, infer
  execution start from session creation, or fabricate missing history.
- Receipts are transition evidence, not a status feed. They must not create
  extra status messages or weaken the notification and no-loop rules.

### Result handoff and bounded reconciliation (result-handoff-v2)

- Reconcile actual owned-worker activity and their assigned saved-result
  files now, on MAIN resumptions/user requests, on result/lifecycle events,
  and before yielding with unfinished work. Each reconciliation is one
  bounded pass over known workers, not a polling loop or a search through
  entire histories. Consume an existing outcome without waiting for its
  notification.
- After saving and reading back a completed, blocked or failed result for
  a real future assignment, the worker sends exactly ONE compact
  `RESULT_READY` callback to the supplied MAIN app session ID using
  `send_session_message` with `delivery_mode: "immediate"`. Include the
  actual task/attempt IDs, outcome state and assigned report path, then end
  the worker turn. No progress callbacks and no acknowledgement from MAIN.
- Native idle notifications are secondary hints. Route them and
  `RESULT_READY` through the same reconciliation path. Disable automatic
  reply-back instructions so they do not duplicate the explicit callback.
  Do not repeatedly resend after uncertain delivery.
- Map notification aliases to recorded worker IDs before acting.
- Deduplicate the task outcome, not unfinished MAIN acceptance,
  integration, reuse or cleanup. Result seen is not task closed. A resumed
  worker's new attempt/result is not a duplicate merely because it has the
  same worker/task identity.
- Ignore duplicate deliveries and late notifications for archived workers
  without suppressing unfinished MAIN work. Never wake, reopen, or recreate
  workers for those events, or wake completed workers to backfill callbacks.
- Idle is not completion. Follow-ups must carry a concrete unblock,
  decision, correction, or authorized task.
- Immediately process existing outcomes, perform required acceptance and
  integration, reuse eligible idle workers for ready authorized tasks, and
  safely archive genuinely unneeded workers. One blocker must not hold
  independent work. Do not wait for another "continue", the whole batch or
  a free worker slot when acceptance or cleanup is already possible.
- No orchestration polling, heartbeats, timers, repeated history searches,
  acknowledgement chains, recurring monitoring jobs, or repeated
  "continue" messages. Do not add receipt infrastructure, policy workers or
  administrative broadcasts to implement this one-time handoff correction.
- While workers run, do bounded independent work. Yield only after the
  approved queue is complete or every remaining action is genuinely
  blocked by active work or an exact dependency/decision. All workers idle
  with pending work is not a reason to claim "waiting for workers"; name
  the actual handoff, delivery or authorization fault.
- This policy does not repair the app's event transport. If no event can
  reach MAIN, report that platform limitation rather than promising
  unattended progress.

### Guarded recovery boundary (not installation authority)

An event-driven code bridge requires separate authorization. Do not create a
sixth LLM supervisor, periodic timer, repeated prompt or application-project
infrastructure as a substitute. Before any recovery wake, an authorized bridge
must verify all of these:

- The exact opted-in MAIN and active, approved scope.
- Fresh responsive idle state, with no active turn or foreground/tool operation.
- Not paused, stopped, cancelled or archived.
- No pending user input, permission, plan, authentication or quota decision.
- A current actionable registered result, MAIN handoff or ready task, not
  merely elapsed time or an idle worker.
- Matching task/attempt/source identity, not stale, handled or cancelled.
- No existing queued, sending or unacknowledged wake, or prior user/steering input.
- Dependencies, ownership and capacity permit the action. A full five-worker
  pool must not suppress result acceptance or cleanup.
- A fresh recheck immediately before sending; any unknown or changed state blocks.

The bridge must persist and deduplicate pending events, claim at most one wake,
and preserve uncertain delivery without blind retries. It must never unpause
queues, approve prompts, kill/restart processes or perform project work.
An LLM must not invent host snapshots or bypass missing gates. Do not claim
these protections are enforced until the code and host adapter exist and have
been verified.

Reported local status at this update: the guarded-wake deterministic guard and
durable SQLite outbox passed 36 local fake-host tests. The live Copilot adapter
and event-source binding are not implemented or activated. Those local tests
do not establish live enforcement. This policy update installs none of them;
live recovery integration still requires separate approval.

### Verify actual work

- Independently check the actual output against the exact acceptance criteria.
  A completion label, valid JSON, matching hash, or clean worktree alone
  does not prove that the requested work is correct.
- Run appropriate targeted checks and validate required content.
- Treat worker claims such as "safe to archive" as claims to verify,
  not permission to skip checks.
- Record failures honestly. Do not mark failed requirements as passed
  merely because the worker finished.
- Preserve needed incorrect output and evidence outside the worker's
  worktree before requesting correction. Only its owning worker performs
  the correction in that worktree.
- Integrate accepted results within the authorized scope and repository
  rules. Preserve rejected or failed work when needed for recovery.

### Safe cleanup

- Cleanup is part of finishing a task.
- Preserve all needed code, results, execution receipts and artifacts,
  including accepted output and retained incorrect evidence, outside a
  worker's worktree before archival; archiving removes that worktree.
- Independently check ownership release, actual Git changes, untracked
  files, needed artifacts, and unique unmerged commits.
- Promptly archive an idle child only when it has no suitable ready
  assignment and is genuinely no longer needed. Archive only your own
  finished children after work is accepted/preserved and writers have
  stopped, with no unique
  unmerged/unsaved work, open PR, active merge, pending task, background
  work, or attached automation.
- Never discard work merely to free a slot.
- If cleanup is unsafe, retain the worker with a specific reason and
  next action. Do not mistake it for a free slot.
- Reuse keeps the existing slot occupied. Release a slot only after the
  archive operation confirms success; archival is not a prerequisite for
  a safe new assignment to that same worker.
- Never restore archived workers merely for reuse or keep speculative
  idle reserves.
- Inherited workers may require their original parent or the user to
  archive them. Do not assume authority over another parent's children.
- Before overall completion, account for every worker: archived,
  genuinely active, or retained for an explicit reason.

### Resuming and future handovers

- Re-read this policy on a new session, resumption, or handover before
  dispatching work; do not repeatedly reload it during routine execution.
- Preserve the worker ledger, result locations, ownership, accepted
  outcomes, and blockers so recovery does not duplicate assignments.
- Clean up safely finished children before handing off the MAIN role.
- Include this policy's path and its availability in the receiving
  checkout in the handover.

### Persistence and distribution

- Preserve unrelated repository instructions when updating this file.
  Keep this section authoritative instead of maintaining policy copies.
- Confirm the exact file saved. Do not claim future sessions or worktrees
  have the policy unless it is actually available in their checkout.
- Follow normal repository commit and integration rules. Do not push or
  merge merely to distribute these instructions.
- Until workers inherit the saved policy, include the applicable rules
  explicitly in their kickoff. Include this policy's path in every handover.
