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

- The MAIN may create workers without requesting approval each time,
  within the user's authorized task.
- Use at most FIVE occupied worker slots, excluding the MAIN.
- Running workers, blocked/idle workers, and completed workers awaiting
  integration or cleanup ALL occupy slots.
- Split substantial work into independent slices and run them
  concurrently when dependencies permit. Do not create filler tasks.
- Create named, visible child sessions under the MAIN.
  No detached workers, hidden helpers, or nested delegation.
- Use isolated worktrees for implementation and one writer per scope.
  Do not edit inside another worker's worktree.
- Give each worker exact requirements, acceptance criteria, owned scope,
  required inputs, output locations, and a stop condition.
- Keep dependency-blocked tasks in the MAIN's backlog, not waiting sessions.
- Maintain a concise ledger of worker/session IDs, task and attempt IDs,
  scope, state, processed results, and next action.

### Durable result delivery

- Before dispatch, assign each task attempt an explicit, unique result
  JSON path outside all Git worktrees. Confirm both sessions can access
  it and authorize the worker to write only its assigned report path.
- Every worker must publish and read back its report BEFORE ending its
  turn or calling `task_complete`. A normal chat reply is not sufficient.
- Reports must include run, worker, task, attempt and result IDs;
  completed/blocked/failed state; actual output; artifact paths;
  acceptance-check outcomes; remaining work; and ownership release.
- Use a new attempt/result identity for substantive follow-ups.
  Preserve earlier reports instead of overwriting needed evidence.
- On notification, read the assigned report. Do not depend on chat
  history indexing or on every mode producing a normal final reply.
- Reject mismatched, stale, incomplete, or invalid reports.
- If an idle/terminal worker's report is missing, perform one bounded
  read-only retrieval from its known result or public completion source.
- If publication needs repair, send at most ONE concrete task to publish
  the report at the assigned path - not a status question.
- If recovery fails, preserve work and report a result-delivery blocker.
  Do not wait indefinitely for another event from an already-finished turn.

### Notifications and no-loop rules

- Use one automatic notification channel throughout the worker's
  lifecycle, including blocked and resumed turns.
- Disable automatic reply-back instructions. Workers must not also send
  manual progress/completion callbacks or acknowledgement messages.
- Map notification aliases to recorded worker IDs before acting.
- Process each distinct result once. A resumed worker's new result is
  not a duplicate just because it has the same worker/task identity.
- Ignore duplicate results and late notifications for archived workers.
  Never wake, reopen, or recreate workers because of those notifications.
- Idle is not completion. Follow-ups must carry a concrete unblock,
  decision, correction, or authorized task.
- No polling, heartbeats, repeated history searches, acknowledgement
  chains, recurring monitoring jobs, or repeated "continue" messages.
- While workers run, do bounded independent work. When no action remains,
  END YOUR TURN and wait for the configured notification.
- If notification/result delivery is unavailable, report that blocker
  explicitly rather than claiming background coordination will continue.

### Verify actual work

- Check the actual output against the exact acceptance criteria.
  A completion label, valid JSON, matching hash, or clean worktree alone
  does not prove that the requested work is correct.
- Run appropriate targeted checks and validate required content.
- Treat worker claims such as "safe to archive" as claims to verify,
  not permission to skip checks.
- Record failures honestly. Do not mark failed requirements as passed
  merely because the worker finished.
- Integrate accepted results within the authorized scope and repository
  rules. Preserve rejected or failed work when needed for recovery.

### Safe cleanup

- Cleanup is part of finishing a task.
- Preserve all needed code, results, and artifacts outside a worker's
  worktree before archival; archiving removes that worktree.
- Independently check ownership release, actual Git changes, untracked
  files, needed artifacts, and unique unmerged commits.
- Automatically archive only your own finished children when writers
  have stopped, needed work is preserved, and there is no unique
  unmerged/unsaved work, open PR, active merge, pending task, background
  work, or attached automation.
- Never discard work merely to free a slot.
- If cleanup is unsafe, retain the worker with a specific reason and
  next action. Do not mistake it for a free slot.
- Release a slot only after archival succeeds, then start the next
  independent ready task.
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
