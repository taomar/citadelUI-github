# Citadel UI GitHub Repository Integration Plan

## Status

Proposed architecture for `taomar/citadelUI-github`.

This edition keeps the existing local-folder product intact in
`taomar/Citadel-UI`. It adds a separate GitHub-backed source mode so a user can
connect a GitHub account, choose an accessible Citadel repository and branch,
edit Bicepparam and policy files, create access contracts, and save through Git
commits.

## Goals

1. Connect to GitHub.com from the local Citadel UI container.
2. Accept a repository-scoped fine-grained personal access token for the first
   release.
3. List repositories and branches available to that credential.
4. Attach a selected repository and branch as a Citadel environment.
5. Reuse the existing discovery, forms, validation, preview, policy, contract,
   draft, and compare behavior.
6. Save every multi-file operation as one atomic Git commit.
7. Reject stale writes when the branch changes after the user loads or reviews
   a file.
8. Support History and undo by creating new revert commits, never by rewriting
   branch history.
9. Never persist, log, audit, back up, or return the GitHub token.

## Non-goals for the first release

- Azure deployment or Azure API access.
- GitHub Enterprise Server or arbitrary Git hosts.
- Background repository synchronization.
- Force pushes, resets, rebases, or history rewriting.
- Storing a PAT in browser storage, `/data`, a Docker environment variable, or
  Git configuration.
- Editing Git submodules, symbolic links, Git LFS objects, or files outside the
  existing Citadel source scope.

## Product decisions

### Initial authentication

The first release supports a **fine-grained personal access token** because the
requested workflow explicitly starts with token input.

Required token characteristics:

- Resource owner limited to one user or organization.
- Repository access limited to only the intended Citadel repositories.
- Repository permission: **Contents: Read and write**.
- Metadata read access, granted with repository access.
- Optional **Pull requests: Read and write** only when the PR workflow is
  enabled.
- Explicit expiration date.

Classic PATs are rejected by default. An organization-specific compatibility
setting may permit one only when GitHub's fine-grained token limitations prevent
access and the UI clearly states the broader risk.

### Target authentication

The production target is a GitHub App using user-to-server authentication and
device flow:

- Short-lived user tokens.
- Installation limited to explicitly selected repositories.
- Fine-grained app permissions.
- Better audit and revocation behavior.

The provider and session interfaces must not depend on PAT-specific behavior so
the GitHub App flow can replace token entry without changing workspace logic.

### Branch behavior

The default write mode is **working branch**:

1. User selects a source branch.
2. Citadel UI creates or reuses
   `citadel-ui/<environment-id>` from the selected head.
3. All edits commit to that working branch.
4. The UI offers a link to open or create a pull request.

Direct writes to the selected branch require an explicit environment setting.
Protected-branch rejection is surfaced as a normal permission error and never
worked around with force.

### GitHub.com boundary

The first release talks only to `https://api.github.com`. It does not accept an
API base URL from the user and does not follow API-provided links to arbitrary
hosts. GitHub Enterprise support is a later feature with an administrator
allowlist and TLS validation requirements.

## Current architecture to preserve

The current application already has useful boundaries:

- `BrowserDirectoryProvider` owns selected-folder enumeration and file I/O.
- `WorkspaceService` owns discovery, parsing, preview generation, validation,
  contract creation, policy mutation, compare, History, and restore behavior.
- `WorkspaceService` receives `commitFiles` as a dependency, so source-specific
  mutation coordination is already injectable.
- `WorkspaceRegistry` stores non-sensitive project/environment metadata and
  IndexedDB retains local directory handles.
- The server authenticates browser requests with a random session token and
  enforces host, origin, fetch-site, body-size, and concurrency limits.
- Local saves use verified backup-before-write transactions under `/data`.

The GitHub edition should extend these boundaries rather than add GitHub
conditions throughout the editor.

## Proposed architecture

```mermaid
flowchart LR
  UI[Browser UI] --> WS[WorkspaceService]
  WS --> RP[RepositoryProvider]
  WS --> MC[MutationCoordinator]

  RP --> LP[LocalDirectoryProvider]
  RP --> GP[GitHubRepositoryProvider]

  MC --> LT[LocalTransactionCoordinator]
  MC --> GC[GitHubCommitCoordinator]

  GP --> API[Same-origin GitHub API routes]
  GC --> API
  API --> SM[In-memory credential sessions]
  API --> GH[api.github.com]

  WS --> REG[WorkspaceRegistry v3]
  REG --> IDB[Browser IndexedDB]
  REG --> DATA[/data metadata mirror]
```

## Architecture decisions

### Decision: Keep local and GitHub mutation protocols separate

#### Context

Local folder mutation needs backup-before-write recovery because the filesystem
has no immutable parent revision. GitHub mutation needs a single atomic commit
across all changed files and optimistic branch concurrency.

#### Current behavior

`WorkspaceService` prepares file changes and delegates them through an injected
`commitFiles` function. Local writes are authorized, backed up, applied, and
verified as one transaction.

#### Root cause

A low-level provider interface alone cannot express the transaction boundary.
Implementing GitHub writes as repeated `write()` calls would permit partial
contract creation and lose branch-level stale-write protection.

#### Decision

Use one shared read-oriented `RepositoryProvider` contract and a separate
`MutationCoordinator` contract. Keep local transaction and Git commit
implementations behind that coordinator.

#### Rationale

This is the smallest change that preserves editor reuse while putting atomicity,
recovery, and concurrency at the source-owning boundary.

#### Alternatives considered

- Make GitHub imitate local `write()` and `remove()` calls.
  - Benefit: fewer new interfaces.
  - Risk: partial multi-file changes and multiple commits.
  - Rejected because it violates contract-pair atomicity.
- Move all GitHub behavior into `WorkspaceService`.
  - Benefit: direct implementation.
  - Risk: source-specific conditions throughout every editor operation.
  - Rejected because it couples product behavior to one transport.

#### Consequences

- Positive: identical editor workflow with source-correct atomicity.
- Negative: local code requires a behavior-preserving adapter.
- Migration impact: one internal interface extraction before GitHub features.
- Compatibility impact: no public file-format change.
- Operational impact: GitHub saves can leave unreachable blobs/commits after a
  failed ref update, but the branch remains unchanged.

#### Validation

Run shared provider tests, local regression tests, and GitHub race tests that
prove a failed operation never changes the branch ref.

### Decision: Proxy GitHub through the local server

#### Context

The browser needs repository data, but retaining a repository credential in
browser storage would enlarge the exposure boundary and make safe redaction
harder.

#### Current behavior

The browser calls only the same-origin Citadel server. The local edition has no
outbound dependency.

#### Root cause

GitHub access introduces a bearer credential and outbound network boundary that
the current browser-owned folder model does not have.

#### Decision

Accept the PAT once over the existing protected loopback session, retain it only
in server memory, and proxy a bounded set of GitHub operations to the fixed
`api.github.com` host.

#### Rationale

The server can consistently enforce host restrictions, request limits, token
attachment, expiry, and redaction without giving the browser the credential
after connection.

#### Alternatives considered

- Call GitHub directly from the browser.
  - Benefit: less server code.
  - Risk: token exposure to browser state, extensions, and diagnostics.
  - Rejected because credential lifecycle cannot be centrally enforced.
- Persist an encrypted token under `/data`.
  - Benefit: automatic reconnect after restart.
  - Risk: key-management complexity and durable credential exposure.
  - Rejected for the first release; reconnect is safer and explicit.

#### Consequences

- Positive: memory-only credential and fixed egress boundary.
- Negative: the server processes repository bytes and becomes security-critical.
- Migration impact: server routes and an in-memory session manager.
- Compatibility impact: container restart requires GitHub reconnect.
- Operational impact: GitHub availability and rate limits become user-visible.

#### Validation

Prove the token is absent from disk, responses, logs, audit records, errors,
browser storage, and support artifacts; exercise SSRF and session-isolation
tests.

### Decision: Use working branches and non-force Git Database commits

#### Context

Citadel operations may change multiple files, and selected repositories may
protect their default branches or require review.

#### Current behavior

Local transactions mutate the selected folder directly after a review step.

#### Root cause

The GitHub Contents API is file-oriented, while contract creation and environment
copy require one all-or-nothing repository revision. Direct default-branch writes
also bypass the safest collaboration workflow.

#### Decision

Create one blob/tree/commit/ref transaction per Citadel action, update refs with
`force: false`, and write to a Citadel working branch by default. Undo creates an
inverse commit.

#### Rationale

Git objects provide the required multi-file atomicity and immutable recovery
history. A working branch respects branch protection and enables review without
making PR creation mandatory for every save.

#### Alternatives considered

- Use the Contents API once per file.
  - Benefit: simpler endpoints.
  - Risk: multiple commits and partial operations.
  - Rejected because it cannot preserve existing transaction semantics.
- Write directly to the default branch.
  - Benefit: fewer workflow steps.
  - Risk: protected-branch failures and unsafe shared changes.
  - Rejected as the default; retained only as an explicit opt-in.
- Undo with a force reset.
  - Benefit: exact branch rewind.
  - Risk: destroys shared history and concurrent work.
  - Rejected unconditionally.

#### Consequences

- Positive: atomic saves, reviewable diffs, immutable undo history.
- Negative: users must manage a working branch and possible PR.
- Migration impact: branch metadata is added to each GitHub environment.
- Compatibility impact: commit history gains Citadel trailers.
- Operational impact: stale refs require reload and re-review.

#### Validation

Assert one commit per operation, exact parent/tree relationships, non-fast-
forward rejection, protected-branch behavior, and inverse-commit correctness.

## Core interfaces

### RepositoryProvider

Create a shared provider contract and run the same contract tests against local
and GitHub implementations.

```js
class RepositoryProvider {
  async permission()
  async assertWritable()
  async entries()
  async read(alias)
  async missingDirectories(alias)
}
```

`read(alias)` returns:

```js
{
  alias,
  bytes,
  text,
  size,
  hash,          // SHA-256 of reviewed bytes
  version,       // local mtime/hash or Git blob SHA
  workspaceHead // null locally, Git commit SHA for GitHub
}
```

Local-only methods such as subscription `.env` editing remain capabilities on
the local provider and are not added to the shared contract.

### MutationCoordinator

Do not make the GitHub provider imitate sequential local file writes.

```js
class MutationCoordinator {
  async commit(files, context)
  async history(context)
  async inspect(changeId, context)
  async revert(changeId, context)
}
```

Implementations:

- `LocalTransactionCoordinator`: existing backup, authorization, write,
  verification, receipt, audit, and recovery protocol.
- `GitHubCommitCoordinator`: one Git tree and commit per operation.

`WorkspaceService` continues to prepare exact before/after bytes and calls the
coordinator once. Parameter saves, policy saves, environment copy, and
two-file contract creation therefore remain source-agnostic.

## Credential session design

### Token intake

1. Browser opens **Connect GitHub**.
2. User pastes a fine-grained PAT into a password control.
3. Browser sends it once to `POST /api/github/sessions` over loopback using the
   existing `X-Citadel-Session` and origin protections.
4. Server validates the token with GitHub.
5. Server stores it only in an in-memory map.
6. Server returns an opaque random GitHub session ID, authenticated user summary,
   expiry/idle timestamps, and no token.
7. Browser stores only the opaque session ID in `sessionStorage`.

### Session rules

- 30-minute idle expiration.
- Eight-hour absolute maximum for PAT sessions.
- Explicit **Disconnect GitHub** action.
- Clear all sessions on container restart.
- Never include tokens in exceptions, URLs, query strings, request logs, audit
  events, registry metadata, support bundles, or transaction records.
- Redact `Authorization`, PAT prefixes, and GitHub response request IDs from
  user-visible diagnostics where they could expose sensitive context.
- Compare opaque session IDs in constant time.
- Rate-limit login attempts per browser session.

### Later GitHub App flow

Replace PAT intake with:

1. Request device code using the GitHub App client ID.
2. Show GitHub verification URL and user code.
3. Poll at GitHub's required interval and honor `slow_down`.
4. Store user and refresh tokens in memory only for the default mode.
5. Optionally add OS-keychain persistence as an explicit user choice, never
   `/data` plaintext.

## Same-origin GitHub API

The browser never calls GitHub directly. The local server owns fixed-host HTTPS
egress and token attachment.

Proposed routes:

| Route | Purpose |
| --- | --- |
| `POST /api/github/sessions` | Validate and retain a credential in memory |
| `DELETE /api/github/sessions/:id` | Disconnect and erase token |
| `GET /api/github/repos` | List repositories accessible to the credential |
| `GET /api/github/repos/:id/branches` | List selectable branches |
| `POST /api/github/attachments` | Validate and attach repo/branch metadata |
| `GET /api/github/workspaces/:environmentId/tree` | Return filtered source tree |
| `GET /api/github/workspaces/:environmentId/blob` | Read one allowed source |
| `POST /api/github/workspaces/:environmentId/commits` | Atomic multi-file commit |
| `GET /api/github/workspaces/:environmentId/history` | Citadel-authored commit history |
| `POST /api/github/workspaces/:environmentId/reverts` | Create inverse commit |

Every route keeps existing host/origin/session/body/concurrency controls and also
requires the opaque GitHub session ID.

## Repository selection

1. Call `GET /user/repos` with pagination.
2. Keep repositories where the token has read access.
3. Show owner, name, visibility, archived state, default branch, and effective
   push permission.
4. Disable archived repositories and read-only repositories for write mode.
5. User selects repository and source branch.
6. Resolve and retain immutable numeric repository ID.
7. Re-fetch repository by numeric ID during attachment so a renamed repository
   cannot redirect the selection.
8. Run existing Citadel capability discovery before activating it.
9. Reject an incomplete tree with the same missing-capability messages used by
   local mode.

Repository search and branch selectors are paginated and searchable. The UI
does not ask the user to type an owner/repository path.

## GitHubRepositoryProvider

### Tree loading

1. Read branch ref and commit.
2. Read the commit's tree SHA.
3. Request the recursive tree.
4. If GitHub returns `truncated: true` (100,000-entry or 7 MB tree limit),
   traverse non-recursive subtrees only under relevant Citadel paths.
5. Apply the existing source extension and skipped-directory policy.
6. Reject symlinks (`120000`), submodules (`160000`), and unsupported modes.
7. Retain blob SHA, mode, size, commit SHA, and normalized alias.

### Blob loading

- Read blobs by SHA, not a mutable branch path.
- Enforce the existing 8 MiB source limit before decode.
- Base64-decode strictly and verify byte count.
- Compute SHA-256 locally so existing stale-review invariants remain unchanged.
- Treat Git LFS pointer files as unsupported rather than editing the pointer.

### Cache

Cache immutable tree/blob responses by SHA in browser memory. Do not cache token-
bearing responses or source bytes in `/data`. Browser drafts remain IndexedDB
records keyed by:

```text
repository-id : branch : alias : loaded-blob-sha
```

Secure parameter drafts remain memory-only as today.

### Subscription environment bridge

Preserve the local edition's narrow subscription editor for tracked
`.azure/<environment>/.env` files without exposing the full file:

1. A dedicated server operation reads the blob by SHA.
2. It returns only `AZURE_SUBSCRIPTION_ID` and source-version metadata.
3. Save accepts only a normalized subscription ID plus the reviewed blob SHA and
   branch head.
4. The server patches only that key while preserving all other bytes.
5. The patched `.env` blob participates in the same atomic Git commit protocol.
6. A missing file may be created with only `AZURE_SUBSCRIPTION_ID`.

No other environment key or raw `.env` content is returned to the browser,
logged, audited, cached, or persisted by Citadel UI. The UI warns that the
subscription ID will be committed to the selected working branch.

## Atomic Git save protocol

For every save:

1. Re-read the target branch ref.
2. Require it to equal the workspace head the user loaded/reviewed.
3. Require every edited path's loaded blob SHA and SHA-256 to match the reviewed
   source.
4. Create blobs for all changed/created files.
5. Create one tree using the current commit tree as `base_tree`.
   - New/changed file: mode plus new blob SHA.
   - Deleted file: `sha: null`.
6. Create one commit whose parent is the reviewed branch head.
7. Update `refs/heads/<working-branch>` with `force: false`.
8. If the branch moved, GitHub rejects the non-fast-forward update. Return a
   stale-source conflict and keep browser edits intact.
9. Re-read the branch ref and resulting blobs.
10. Record a redacted audit event containing repository ID, branch, base commit,
    final commit, action, aliases, and hashes only.

This makes:

- A parameter save one commit.
- A policy save one commit.
- Environment copy one commit.
- Contract creation one commit containing both files.
- Contract undo one inverse commit deleting both files.

No source bytes need to be backed up under `/data`; the parent commit already
contains immutable originals.

## History and undo

History uses both Git and the existing audit model:

- Add commit trailers:

```text
Citadel-Action: policy-edit
Citadel-Environment: <environment-id>
Citadel-Transaction: <uuid>
```

- Store no values or file contents in trailers.
- Show commit SHA, author, timestamp, action, and changed aliases.
- Undo creates a new commit restoring parent-tree blobs for modified/deleted
  files or deleting files created by the original commit.
- Before undo, require current blobs to match the original Citadel commit's final
  blobs. If later edits touched them, reject instead of overwriting.
- Never reset, force-update, delete, or rewrite a shared branch.

## Registry v3

Replace local-only environment shape with a tagged source union:

```js
{
  id,
  projectId,
  label,
  source: {
    kind: 'local',
    folderName,
    localPath
  }
}
```

or:

```js
{
  id,
  projectId,
  label,
  source: {
    kind: 'github',
    repositoryId,
    fullName,
    sourceBranch,
    workingBranch
  }
}
```

Migration:

- Existing v2 records become `kind: local`.
- Local directory handles remain in the handles store.
- GitHub records never carry a token or opaque credential session ID.
- After restart, GitHub environments remain visible but show
  **Reconnect GitHub** until a new in-memory credential session is established.

## User experience

### First run

Offer two source choices:

- **Local folder**
- **GitHub repository**

GitHub flow:

1. Explain minimum token permissions and that the token is memory-only.
2. Connect token.
3. Show authenticated account.
4. Search/select repository.
5. Select source branch.
6. Choose default working-branch mode.
7. Scan Citadel capabilities.
8. Name environment and attach.

### Active workspace

Top command bar shows:

```text
Project > Environment > owner/repo @ working-branch
GitHub connected as <login>
```

Save review shows:

- Repository and branch.
- Base commit.
- Files changed.
- Exact text diff.
- Commit message.
- Whether a pull request will be opened or updated.

Success shows the final commit SHA and GitHub link.

### Reconnect and failures

Map GitHub failures into explicit recovery:

| Condition | UI response |
| --- | --- |
| 401 | Token expired/revoked; reconnect |
| 403 permission | Token lacks Contents write or organization approval |
| 403 rate limit | Show reset time; do not retry automatically |
| 404 | Repository/branch unavailable to this credential |
| 409/422 ref update | Branch changed; reload and re-review |
| Protected branch | Use working branch/PR; never force |
| Truncated tree | Fall back to bounded subtree traversal |
| Network timeout/5xx | Retry read operations with bounded backoff; never retry a ref update blindly |

## Security controls

1. Fixed GitHub API host and HTTPS only.
2. No arbitrary URL fetch or open redirect following.
3. PAT accepted only in a password input with autocomplete disabled.
4. Token memory-only, time-bounded, and explicitly disconnectable.
5. Opaque per-browser GitHub session ID in `sessionStorage`.
6. Repository selection bound to immutable repository ID.
7. Owner/repo/ref/path validated and URL-encoded per segment.
8. Existing source extension, size, hidden-directory, traversal, and symlink
   boundaries retained.
9. No token/source logging, registry persistence, audit persistence, telemetry,
   or support-bundle inclusion.
10. GitHub response bodies bounded before parse.
11. Pagination, tree traversal, and concurrency bounded.
12. `force: false` for every branch update.
13. Branch protections and organization policies treated as authoritative.
14. Redaction tests include PAT prefixes (`github_pat_`, `ghp_`, `gho_`,
    `ghu_`, `ghs_`, `ghr_`) and Authorization headers.
15. Container egress documented and optionally restricted by an operator proxy
    or firewall to GitHub endpoints.

## Deployment changes

The GitHub edition changes a major current guarantee: the container gains
outbound network access and receives repository source through GitHub API
responses.

Required updates:

- Separate image/repository identity from the local-only edition.
- Update SECURITY.md and README.md trust-boundary statements.
- Keep browser CSP `connect-src 'self'`; only the server contacts GitHub.
- Add `CITADEL_GITHUB_API_HOST=api.github.com` as a fixed validated setting,
  not a free-form URL.
- Support `HTTPS_PROXY` only as an operator setting.
- Add DNS/TLS/API timeout limits.
- Keep loopback-only published port and read-only container filesystem.
- Do not mount Git credentials, SSH keys, home directories, or Docker socket.

## Implementation milestones

### Milestone 0: Contract extraction

- Define `RepositoryProvider` and `MutationCoordinator`.
- Adapt local provider/coordinator without behavior changes.
- Run one provider contract suite against the local implementation.
- Preserve all current 88 tests.

Exit criteria: local-folder edition behaves byte-for-byte as before.

### Milestone 1: Authentication and repository selection

- Add in-memory credential sessions.
- Add PAT validation, logout, expiry, and redaction.
- List repositories and branches.
- Add GitHub environment registry v3 migration.
- Implement read-only GitHub provider.

Exit criteria: restart-safe metadata, reconnect-required credential state, and
read-only Main/LLM/Access editors for a selected private repository.

### Milestone 2: Atomic commits

- Implement blob/tree/commit/ref flow.
- Create working branches.
- Add stale branch/blob checks.
- Wire parameter and policy saves.
- Verify one save equals one Git commit.

Exit criteria: no force path, branch races reject, reviewed bytes equal committed
bytes, pending edits survive conflicts.

### Milestone 3: Full feature parity

- Contract creation in one two-file commit.
- Environment copy across GitHub environments.
- History and inverse commits.
- GitHub commit links and optional PR creation/update.

Exit criteria: every current local operation has an equivalent GitHub operation
or a clearly documented source-specific exception.

### Milestone 4: GitHub App authentication

- Register least-privilege GitHub App.
- Add device flow.
- Add installation/repository selection.
- Replace PAT default while retaining PAT compatibility mode.

Exit criteria: short-lived app/user tokens and per-installation repository
authorization.

### Milestone 5: Hardening and release

- Threat model and abuse tests.
- API rate-limit and outage tests.
- Large/truncated tree tests.
- Branch protection and SSO tests.
- Container egress documentation.
- Release/signing/SBOM updates.

## Test strategy

### Pure tests

- Git tree filtering and mode rejection.
- Blob decoding and size limits.
- Path/ref/repository validation.
- Registry v2-to-v3 migration.
- Error mapping and redaction.
- Commit tree construction and inverse commit construction.

### Provider contract tests

Run identical discovery/read/hash tests for:

- `BrowserDirectoryProvider`
- `GitHubRepositoryProvider` backed by a fake GitHub API

### Concurrency and mutation tests

- Branch moves before commit creation.
- Branch moves after commit creation but before ref update.
- Non-fast-forward ref rejection.
- Partial blob/tree/commit creation leaves branch unchanged.
- Two-file contract creation is one commit.
- Changed created files block undo.
- Revert commit restores exact prior blobs.

### Security tests

- Token absent from responses, logs, registry, audit, errors, and disk.
- Expired/disconnected sessions fail closed.
- Cross-browser opaque session IDs do not authorize each other.
- SSRF host bypass attempts fail.
- Traversal, symlink, submodule, LFS, oversized blob, and truncated-tree cases.
- Rate-limit and organization approval errors remain actionable without
  revealing credentials.

### End-to-end tests

Use a disposable private repository and dedicated token:

1. Attach repository and branch.
2. Load all primary editors.
3. Edit Main and LLM parameters.
4. Edit guided and raw policy.
5. Create a contract pair.
6. Verify commit history and blob hashes.
7. Create a competing branch commit and verify stale rejection.
8. Undo through an inverse commit.
9. Verify original/default branch is unchanged.
10. Revoke token and verify reconnect behavior.

Never run destructive E2E against a user repository.

## Acceptance criteria

- User can connect, list, select, and attach an accessible private Citadel repo.
- Token never persists and is absent from every observable output.
- Existing three focus editors work against GitHub source.
- Comments and formatting retain current byte-preservation guarantees.
- Each save/creation/copy/undo is one atomic non-force Git commit.
- Concurrent branch updates reject before any ref is changed.
- Protected branches are never bypassed.
- Contract creation and undo have exact two-file behavior.
- Registry metadata survives restart; authentication does not.
- Local-folder edition remains unchanged.
- Full local and GitHub provider suites pass.

## References

- [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Building a CLI with a GitHub App and device flow](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-cli-with-a-github-app)
- [List repositories for the authenticated user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)
- [Git trees](https://docs.github.com/en/rest/git/trees)
- [Git commits](https://docs.github.com/en/rest/git/commits)
- [Git references](https://docs.github.com/en/rest/git/refs)
- [Fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
