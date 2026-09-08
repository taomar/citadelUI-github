# Local Security Model

Citadel UI is a single-user local editor. The supported origin is
`http://127.0.0.1:4173`.

## Owner credential

This container has exactly one account, and it is what makes publishing the UI
beyond loopback defensible.

- **First run claims it.** While no owner exists, the page asks for a username
  and password and stores the credential at `/data/settings/owner.json`. The file
  is created with an exclusive open, so if two people arrive at once exactly one
  becomes the owner and the other is told to sign in.
- **One account, permanently.** There is no route that creates a second account
  and no route that resets the password. A forgotten password is recovered by
  redeploying with fresh state, which is the honest operation for a container
  whose identity is one file.
- **The password is never stored.** Only an scrypt hash with a per-record random
  salt, compared in constant time. The cost parameters are stored with the hash
  so they can be raised later without locking out the existing owner.
- **Signing in is the only way to get a session token.** `GET /` no longer
  carries one; it reports only whether this container has been claimed. Every API
  route authenticates exactly as it did before — the token simply has to be
  earned now.
- **An unreadable owner record fails closed.** A corrupt or truncated file is
  reported as "cannot tell", never as "unclaimed", so damaging one file cannot
  re-open the claim on a running deployment. Recovery is a redeploy.
- **`/healthz` stays unauthenticated**, so the platform can still tell whether
  the container is up.

Known gaps, deliberate for a demo and listed for whoever hardens this next:

- **The claim window.** Between the first public deploy and the first successful
  claim, whoever reaches the URL first becomes the owner. Closing it means either
  requiring a deployment-supplied claim secret or refusing the claim flow until
  the operator has claimed it over internal ingress. The place to add either is
  `OwnerAccount.claim` in `server/owner.mjs`.
- **The token lives in `localStorage`.** The CSP admits no third-party script, so
  there is no realistic reader, but an httpOnly cookie is the better answer.
- **The session token is process-wide and does not expire.** A container restart
  signs everyone out; there is no rotation and no idle timeout.
- **`/data` must be persistent.** On ephemeral storage the owner record is lost
  on every restart and the deployment becomes claimable again by anyone.

## Trust boundaries

- The browser owns Citadel repository authority through user-selected
  `FileSystemDirectoryHandle` objects retained in IndexedDB.
- `/data/settings/registry.json` mirrors labels, IDs, and a tagged `source`
  union per environment: a local folder display name and display-only Local
  path, or a GitHub repository id, full name, source branch, and working branch.
  It also holds capability versions/fingerprints, compatibility, and timestamps.
  It never contains handles, tokens, or credential session identifiers.
- Shared browser modules parse, discover, preview, and edit source bytes.
- The container owns only application files and durable `/data` state. It stores
  Local path as inert profile metadata and never uses it to open a repository.
- For GitHub workspaces and migration sources, the container additionally owns
  the outbound network boundary and any in-memory credential.

The container has no source, home, drive, Docker socket, Git credential, Azure
credential, or cloud-service mount. Compose publishes only
`127.0.0.1:4173:4173`, uses an isolated bridge, a read-only root filesystem,
non-root UID/GID 10001, dropped capabilities, `no-new-privileges`, a bounded
`/tmp` tmpfs, and CPU/memory/PID limits.

## GitHub credentials

- Only a fine-grained personal access token is accepted. Classic tokens are
  refused unless explicitly enabled, because their scope cannot be limited to the
  selected repositories.
- The token is submitted through the protected application session. By default
  it is retained **only in server process memory**. Explicit encrypted
  persistence, described below, stores a sealed credential under `/data`.
  Plaintext tokens are never written there, to a Docker environment variable,
  Git configuration, browser storage, a cookie, a URL, a log line, an audit
  record, a transaction record, an error message, or any response body.
- The browser retains only an opaque, server-issued session id, in
  `sessionStorage`, so it dies with the tab.
- Sessions are keyed by a SHA-256 of that id, compared in constant time, expire
  after 30 minutes idle and 8 hours absolute, are bounded in number, and are
  cleared on container restart. **Disconnect GitHub** erases the credential
  immediately.
- Credential submissions are rate limited per browser session.
- Token-shaped strings and `Authorization`/`Bearer` fragments are redacted from
  any text that could reach a user or a log.

## Connection identity

- A credential belongs to a **named connection profile**: an immutable id, a
  friendly name, and the immutable GitHub account id and login it is bound to.
  A profile never contains a token, key material, or a session id.
- Identity is the numeric account id, never the login. A login can be renamed and
  re-registered by someone else; the id cannot.
- Reconnecting compares account ids. A token for a different account is refused
  and a separate profile is offered. A profile is **never** silently rebound to
  another identity, because every workspace attached to it would then point at
  repositories the user did not choose.
- Every attach records the connection that performed it, taken from the
  credential rather than from the request body, so a browser cannot claim a
  workspace was attached through a connection it does not hold.
- Removing a profile deletes local metadata and any stored credential. It revokes
  no token, deletes no branch, and removes no workspace: affected workspaces stay
  listed as **Reconnect**.

## Encrypted credential persistence (optional, off by default)

One checkbox, `Save this connection on the Citadel server (encrypted)`, unticked
for a new connection. With it unticked nothing in this section runs and the
behaviour is memory-only. Persistence belongs to the Citadel server, not to the
browser or the operator's device. There is deliberately no passphrase and no unlock step: a local
single-user control panel that demands a second secret every morning gets that
secret written on a sticky note.

**Key.** `CITADEL_CREDENTIAL_KEY_FILE` names a **path**, never key material. The
file holds a random 256-bit key, is generated outside the repository and outside
`/data`, and is mounted read-only at `/run/secrets/citadel-credential-key`. The
key is never printed, logged, committed, placed in an environment value, baked
into an image layer, written to `/data`, put on a command line, or included in an
audit or activity record. A missing or malformed key is not a startup failure:
persistence is disabled, the checkbox says so, and session-only connections keep
working.

**Envelope.** Node's built-in `crypto`, versioned:

- A random 256-bit data-encryption key per credential.
- The credential sealed with AES-256-GCM under that key, with a unique random
  96-bit IV, a 128-bit tag, and additional authenticated data binding the
  envelope version, the profile id and the immutable account id.
- The data key wrapped with AES-256-GCM under the mounted key, with its own IV,
  its own tag, and a **different** AAD.
- Ciphertext and wrapped key written atomically under `/data` at mode `0600`.

Every length and version is validated before a cipher is constructed. A wrong
key, an edited ciphertext, an envelope moved between profiles, a wrapped key
swapped in from another envelope, or a replayed account binding all fail closed
and yield no credential. Restore is server-side and automatic; the browser
receives only an opaque session id and a status word. Buffers holding key
material are zeroed after use.

**Threat model, stated plainly.** This protects theft or copying of the `/data`
volume — a backup, a stray archive, a mislaid disk — by someone who does not also
hold the key file. It does **not** protect a compromised running host or
container, a process that can read this server's memory, or theft of the data
volume *and* the key file together. The key is mounted from outside the repo and
outside `/data` so the two are not lost to the same accident; they are not
separated by hardware.

## Workspace activity log

- `/data/settings/activity.json` is bounded, atomically written, and holds an
  event id, a timestamp, an origin, an action from a fixed vocabulary, an
  outcome, an optional reason from a fixed vocabulary, and names the user chose.
- There is **no free-text field**. Nothing a caller happens to be holding — an
  exception message, a path, a parameter value, a credential — has anywhere to
  travel. Unknown actions, outcomes and reasons are dropped rather than filtered.
- The browser may append only the events it alone observes (`environment.open`,
  `repository.detach`, `validation.failure`). Everything a credential touches is
  recorded server-side, where it cannot be forged or omitted.
- Recording never fails the operation it describes.
- This is separate from the commit audit that authorises undo, and separate from
  Git History.

## GitHub network boundary

- Egress is fixed to `https://api.github.com`. No API base URL is accepted from
  the user and no host is taken from a GitHub response.
- Request paths must be origin-relative; absolute URLs, protocol-relative paths,
  traversal, and control characters are rejected.
- Redirects are never followed.
- Responses are size-bounded before parsing, requests are time-bounded, and
  pagination is capped by page count and item count. `rel="next"` is used only as
  a signal; every page URL is rebuilt locally.
- A repository is identified by its immutable numeric id and re-resolved on every
  workspace operation, so a rename or transfer is reported rather than followed.
- Branch names, commit and blob SHAs, aliases, file modes, and blob sizes are all
  validated. Symlinks, submodules, Git LFS pointers, oversized blobs, and
  unsupported modes are refused, not silently skipped. A path Citadel may write
  is held to the same rules enumeration applies — including a length ceiling and
  a ban on control characters, so a committed path can never become one the
  editor is unable to list, read, or remove, and a newline in a filename cannot
  reach the commit message and forge a Citadel trailer.

## GitHub writes

- A repository is only attachable if it **is** a Citadel workspace. The server
  scans the exact branch head with the same `discoverWorkspace` invariants the
  local folder editor uses, and repeats that scan immediately before the first
  mutation, so a bypassed or replayed browser verdict cannot attach an ordinary
  repository or leave a working branch behind on one.
- Every edit to an attached workspace is one blob/tree/commit/ref transaction, so a
  multi-file change such as contract creation can never land partially.
- Ref updates always use `force: false`. A branch that moved after review causes
  a rejection that leaves the branch and the user's edits untouched; at worst
  unreferenced objects remain.
- There are no force pushes, resets, rebases, or history rewrites. Undo appends
  an inverse commit and is refused when later edits touched the affected files.
- Commit trailers record action, environment, and transaction id only; never
  values or file contents.
- Because the parent commit holds immutable originals, no GitHub source bytes are
  copied into `/data`.

## Configuration migration

**Migrate Citadel Configuration** separates the read-only older source from the
current destination. Local sources use read-only browser file/folder grants, not
server-side paths or source mounts. Public GitHub reads are anonymous;
authenticated public/private sources use a separate source-session store.
All GitHub egress in these source paths is fixed-host **GET-only**. Local
credential exchange and erasure use owner-gated POST/DELETE routes; they do not
create, edit, or delete GitHub resources.

A source PAT needs only selected-repository **Contents: Read** and the automatic
Metadata permission. A pasted PAT is session-only, and its form value is cleared
on submission and exit. The browser retains only an in-memory source capability.
Borrowing an existing live or explicitly encrypted saved credential does not
replace, reconnect, or revoke the editable destination session or saved profile.
Source sessions inherit the existing idle/absolute bounds. Disconnect, abandoned
login attempts, and bounded attempt eviction erase their associated source
credentials and snapshot caches; unconfirmed erasure is an explicit retry state.

Source identity/access and file/template fingerprints are checked during capture.
The supported configuration corpus and referenced templates are then retained as
sensitive application data in the protected runtime volume, not the image/repo.
Private directories/files, bounded binary APIs, hash verification and atomic
completion protect the copy; interrupted or corrupt copies fail explicitly.
Connection tokens, headers, `.env`, arbitrary host paths and unrelated files are
not capture inputs. Arbitrary configuration comments are not guaranteed secret-free.
There is no new encryption layer; volume protection and owner access still matter.

Completed copies are owner-gated and independent of source PAT sessions, original
folder access, or upstream ref changes. Only explicit refresh reacquires the
source; it creates a new identity and failed acquisition retains existing drafts.
Upstream revocation does not revoke previously downloaded data. The owner deletes
copies explicitly; limits are 8 copies / 256 MiB total and 256 files / 64 MiB each.
Current target freshness, identity, pending-editor and transaction checks remain
independent and enforced. Local browser target-handle proofs preserve the
acquisition separation check without retaining or reopening original handles.

Only reviewed values for assignments already in the new target can be written. Dynamic
expressions are never evaluated, secure/credential-shaped values are withheld,
and old-only reports contain names and metadata rather than unused source values.
Sanitized exports are not raw source dumps or deployment-ready files. Explicit
local apply uses the normal destination backup/authorization/rollback path;
source bytes are never backed up as destination data. GitHub destinations are
preview/local-export-only. No migration step runs an upgrade/deployment script,
copies policy XML, or widens the ordinary editor's write scope. The migration
target form reuses presentation with read-only, screened projections: it has no
ordinary editor save callbacks or subscription/environment bridge. Import/undo
actions change migration decisions only, and highlights are not an apply receipt.

See [the migration reference](README.md#migrate-citadel-configuration) for
supported inputs, limits, and the boundaries of conservative secret screening.

## Private repository initialization

**New GitHub Repo** is a separate, opt-in copy operation. A source URL must identify a
repository/ref on `https://github.com`; it never becomes a fetch destination.
All reads and writes still use the fixed, redirect-refusing `api.github.com`
transport. Preflight pins an immutable source commit and fully checks the
snapshot before the user confirms repository creation.

The server fixes visibility to private and destination ownership to the
authenticated personal account. Browser-supplied owner/visibility overrides are
refused. Name collisions are never overwritten or adopted. An operation records
its intent before creation and verifies repository provenance, immutable ID,
account, privacy and expected branch heads on recovery. It never automatically
deletes repositories or forces a ref update.

For an account whose initial default branch is not `main`, the importer publishes
on the proven bootstrap branch and then uses GitHub's branch-rename operation.
There is no check-then-delete race. Once publication or the default branch has
been confirmed, a later rollback is treated as an external change rather than
an invitation to replay a write.

Unlike editor access, initialization copies all supported checked-in file types,
including binary assets, dotfiles and licenses. This capability is restricted to
the pinned source and the new destination owned by that operation; it is not a
generic arbitrary-file editor or write endpoint. Size/mode/truncation failures
are explicit. Content hashes and the full destination tree must match before
setup reports completion.

Creation uses a temporary fine-grained token with All repositories access and
Administration/Contents read-write permissions. Normal editing retains its
selected-repository Contents-only recommendation. Workflows permission is
conditional on source workflow files; for those imports, Actions are disabled
before copying and remain disabled for operator review. No Actions or Pull
requests permission is requested.

The durable operation journal contains source/destination identifiers, file
metadata, checkpoints and safe status information, never tokens, credential
session IDs or copied file contents. Source buffers are bounded and transient.
Paused/interrupted copies retain their private destination and require the same
authenticated account to resume. Keep `/data` persistent to retain recovery
provenance, and narrow or replace the creation token afterward.

Background calls revalidate the held session against the same session store,
including idle and absolute expiry, after queue and pacing waits. A fatal journal
write failure halts further requests, remains observable even after the runner
exits, and requires storage access to be restored before explicit resume.

## Source exclusions

Browser traversal skips generated and application directories. Generic alias
validation allows only `.bicepparam`, `.bicep`, and `.xml`; it rejects
traversal, absolute paths, `.azure` segments, and `.env` names before requesting
a handle. The same rules are defined once in `shared/source-scope.mjs` and are
enforced for both local folders and GitHub trees. A separate, non-generic method
may open only `.azure/<environmentName>/.env`, return only
`AZURE_SUBSCRIPTION_ID`, and replace only that value span after a hash
precondition. When the exact file is absent, it may create the environment
directory and a new `.env` containing only that key. Other values remain
opaque, and no environment bytes are sent to the browser, transaction backup,
registry, audit, or logs. For a GitHub environment the patched `.env` blob
participates in the same atomic commit protocol and the UI warns that the
subscription id will be committed to the working branch.

The source-only migration adapter also accepts strict ARM deployment-parameters
JSON from explicitly selected files or GitHub snapshots. This does not add JSON
write targets or permit arbitrary JSON, script, or environment-file evaluation.

## Local API controls

- A random 256-bit session token is injected into the no-store bootstrap HTML.
- API calls require the token, exact Host, same-origin Fetch Metadata, and exact
  Origin for mutations.
- Editable GitHub data routes additionally require the opaque workspace GitHub
  session id. Public migration reads require the owner/browser guard but no PAT;
  private migration reads require a separate source-session capability.
  Credential-management routes use their explicit owner-gated exchange/erasure
  protocol. GitHub routes remain the only routes permitted to use `DELETE`.
- No CORS response is emitted.
- JSON and backup bodies have explicit limits; concurrency is bounded.
- CSP denies external scripts, connections, frames, forms, and objects. The
  browser never contacts GitHub directly.
- Errors carry correlation IDs. Request bodies, authorization headers, source
  content, diffs, values, Local paths, GitHub tokens, and browser handles are
  never logged.
- Server errors are sanitized to a generic message, with one deliberate
  exception: a GitHub failure constructed to be shown to the user keeps its code
  and message even at 5xx. Those messages are redacted where they are built and
  carry no token, header, or path. The exception exists because the answer to
  "did my save land?" is itself a 5xx — suppressing it would leave a user
  retrying a commit that had already been applied.

## Sensitive data

Backups under `/data` contain the original selected source bytes and may contain
secure parameters or policy content. Use a user-owned local data directory with
restrictive permissions. Do not include `/data`, browser storage, transaction
tokens, or container logs in support bundles.

Citadel UI has no Azure runtime calls, deployment actions, telemetry, analytics,
or update checks. Docker Desktop 29.6.2 does not publish host ports from an
`internal: true` network, so the supported Compose profile uses a normal isolated
bridge. A local-folder environment makes no outbound runtime request at all; a
GitHub environment reaches only `https://api.github.com`.
