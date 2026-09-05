# Task, result and recovery packets

Copy only the applicable template into a versioned, accessible session artifact
or the existing selected tracker. These are schemas for human/agent handoffs,
not executable YAML or a new database. Replace placeholders; explain material
omissions. Never put secrets in a packet.

## Assignment (complete source section 7)

```yaml
task_id: <stable identifier>
assignment_version: <increment for ownership or scope change>
objective: <observable result or research question>
acceptance:
  - id: <criterion ID>
    requirement: <observable outcome>
    evidence_required: <check and bound candidate/environment>
inputs: <accessible paths/links, relevant decisions and contract versions>
dependencies: <prerequisites and required states, or none>
owner: <one accountable session/person>
workspace: <actual branch, worktree/execution location and source baseline SHA>
write_scope: <files, interfaces, services and external effects allowed>
reserved_resources: <single-writer interfaces/records and non-file resources>
authority: <grant source, scope, limits; not merely a role name>
skills: <relevant installed skills and source/revision, or none>
budget: <finite total; consumed attempts/replacements and remaining allowance>
checkpoint: <startup, progress, recovery and freeze triggers; packet locations>
stop_conditions: <pause/escalate conditions>
deliverables: <actual work and evidence locations; result submission target>
integration_owner: <coordinator session ID>
contract_versions: <shared contracts checked at integration, or none>
status: <draft|ready|running|review|accepted|blocked|cancelled|superseded>
blocker: <reason, unblock owner and next useful action, or none>
supersedes: <prior task/version or none>
```

Only the coordinator publishes current assignment state. A worker's copy is an
input snapshot. Superseded versions are retained as evidence, never resumed.

## Worker result

```yaml
task_id: <matching stable identifier>
assignment_version: <version actually executed>
owner: <assigned owner>
result_generation: <monotonic packet generation>
status: <review|blocked; worker cannot declare acceptance>
source_baseline: <starting SHA and initial worktree condition>
candidate:
  commit: <exact submitted SHA, or none>
  tree_or_snapshot: <tested tree/manifest identity if not that commit>
  branch: <actual branch>
  workspace: <recoverable location>
  frozen: <true only after writes and relevant tools have stopped>
contract_versions: <versions used>
acceptance_results:
  - id: <assignment criterion>
    outcome: <met|unmet|blocked|not applicable with reason>
    evidence: <path/section and exact candidate/environment>
changed_artifacts: <all tracked/untracked paths, real saved bytes and scope>
checks:
  - command_or_procedure: <exact command, CWD or inspection>
    source_identity: <tested commit/tree/snapshot>
    environment: <relevant runtime/version/target>
    outcome: <actual outcome, no confidence-based substitution>
    evidence_path: <redacted saved evidence>
check_limits: <pre-existing/new failures, skipped/unavailable gates>
decisions_and_assumptions: <new choices, authority, unresolved hypotheses>
unfinished_work: <saved partial artifacts and unresolved questions, or none>
external_effects: <intended/observed mutations, operation IDs and unknowns, or none>
live_operations: <owned process/provider handles and safe monitoring, or none>
attempt_history: <hypothesis/approach/failure signature/new evidence per attempt>
remaining_budget: <task-level remaining limits, including replacements>
recovery_location: <accessible commit/artifact paths; no unsaved-byte claims>
recommended_next_action: <smallest useful coordinator action>
integration_owner: <recipient ID; evaluator owns acceptance>
```

Coordinator evaluation additionally records: current registry version/owner check,
candidate/contract match, scope and reservation check, stale-result rejection if
needed, acceptance per criterion, combined candidate/check evidence, decision,
remaining blockers and authoritative status update. Do not integrate first and
check assignment freshness afterward.

## Recovery checkpoint

```yaml
checkpoint_generation: <increment only after next snapshot is complete>
identity: <project, task, assignment version, session, timestamp>
intent: <objective, acceptance, scope, authority, next action>
work:
  source_baseline: <starting revision>
  snapshot_identity: <frozen commit/tree or versioned artifact manifest>
  workspace: <actual path and branch>
  tracked_changes: <paths and recoverable bytes>
  untracked_changes: <paths and recoverable bytes, or none>
reasoning: <route/decisions, unresolved hypotheses, failed approaches, why next step>
evidence: <checks/outcomes, tested identity, environment, limitations>
live_operations: <IDs, owners, reservations, last observation, safe monitoring>
external_effects: <intended/observed changes, unknowns, reconciliation/idempotency>
coordination: <dependencies, owners, blockers, remaining budget, stop conditions>
previous_checkpoint: <last usable accessible packet retained until publication>
publication_state: <consistent and frozen, or explicitly moving with changing paths>
handover: <writer-stop acknowledgement and current owner/version, or blocked>
```

For coordinator recovery, include the latest registry export and all active
assignments/reservations/acceptance references, not just its own next action.
Keep task-level failed attempts and spent budgets across fresh sessions.

## External operation record

```yaml
operation_id: <real provider/process identity, or explicit unavailable>
task_id: <owning task>
assignment_version: <current authorized version>
owner_and_authority: <who may reconcile/mutate which target>
status: <intended|in progress|succeeded|failed|outcome unknown>
intended_effect: <exact target and requested change>
observed_effect: <provider observation plus time; no inference from timeout>
idempotency: <supported mechanism and key reference, or not established>
reconciliation: <authorized readback, evidence location, next safe action>
retry_decision: <blocked until outcome/authority reconciled, or bounded decision>
```
