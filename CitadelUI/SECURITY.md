# Local Security Model

Citadel UI is a single-owner configuration editor, run as an Electron desktop
application, in a local container, or on Azure Container Apps. The supported
container origin is `http://127.0.0.1:4173`; the packaged desktop origin is
`http://127.0.0.1:4174`. Hosted browser access uses the instance's HTTPS origin.
This document describes boundaries and known limitations, not a security
certification.

## Owner credential

This container has exactly one account, and it is what makes publishing the UI
beyond loopback defensible.

- **First run claims it.** While no owner exists, the page asks for a username
  and password and stores the credential at `/data/settings/owner.json`. The file
  is created with an exclusive open, so if two people arrive at once exactly one
  becomes the owner and the other is told to sign in.
- **One account, permanently.** There is no route that creates a second account
  or resets the password. Fresh state creates a different instance identity,
  not recovery of the old account. Preserve existing state; do not delete it
  to work around a sign-in or mount problem.
- **The password is never stored.** Only an scrypt hash with a per-record random
  salt, compared in constant time. The cost parameters are stored with the hash
  so they can be raised later without locking out the existing owner.
- **Signing in is the only way to get a session token.** `GET /` no longer
  carries one; it reports only whether this container has been claimed. Every API
  route authenticates exactly as it did before — the token simply has to be
  earned now.
- **An unreadable owner record fails closed.** A corrupt or truncated file is
  reported as "cannot tell", never as "unclaimed", so damaging one file cannot
  re-open the claim on a running deployment. Restore access to the original
  valid state rather than treating the instance as unclaimed.
- **`/healthz` stays unauthenticated**, so the platform can still tell whether
  the container is up.

Known gaps, deliberate for a demo and listed for whoever hardens this next:

- **The claim window.** Between the first public deploy and the first successful
  claim, whoever reaches the URL first becomes the owner. Closing it means either
  requiring a deployment-supplied claim secret or refusing the claim flow until
  the operator has claimed it over internal ingress. The place to add either is
  `OwnerAccount.claim` in `server/owner.mjs`.
- **The token lives in `localStorage`.** The CSP admits no third-party script,
  but does not make a compromised browser, host or same-origin script safe.
  The token is not protected by an httpOnly cookie.
- **The session token is process-wide and does not expire.** A container restart
  signs everyone out; there is no rotation and no idle timeout.
- **`/data` must be persistent.** On ephemeral storage the owner record is lost
  on every restart and the deployment becomes claimable again by anyone.

## Trust boundaries

### Opt-in instance diagnostics

**Diagnostics** in the application header opens the support page in a new tab;
`/debug` remains a direct route. The public bootstrap presents the normal owner
claim/sign-in flow. Discoverability is not an access control: every
`/api/diagnostics/*` route requires the owner session, Host/Fetch-Site checks and
the appropriate Origin check. No query-string switch, TTL override, cross-origin
sharing route or unprotected report endpoint exists.

Capture defaults off and lasts a fixed 30 minutes per explicit activation,
unless stopped manually. Reloads, activity and repeated ON requests do not
extend it; closing the debug page does not stop it.
Server wall/monotonic time and read/ingest/export checks enforce the cutoff even
when browser timers or the page are suspended. The bounded latest report stays
only in process memory, including after stop; restart clears it and never
resumes capture. Nothing is written to `/data` or uploaded automatically.

Records are constructed from fixed catalogs of error codes, methods, route
templates and known bundled assets, not scrubbed raw logs. Unknown fields are rejected before
ingestion, and export/display revalidate the exact schema. No raw message, stack,
URL, query, header, credential, source value, label, DOM text or arbitrary path
is retained. Correlations are server-generated; caller-supplied correlations
are not logged or captured. Browser records cannot supply them.

Browser activation is normally within a 5-second poll; offline/throttled tabs
can miss errors and cannot report historical events. Original application
errors and browser console behavior are not suppressed. Explanatory UI text is
static guidance, not proof of a cause; unknown 404s remain errors. The exact
[capture/export schema and limitations](DIAGNOSTICS.md) are part of this contract.

### Application and source boundaries

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

The container has no source, home, drive, Docker socket, Git credential, operator
Azure credential or cloud-service mount. A configured hosted instance can use
managed identity to read its credential-encryption key from Key Vault.
The supported local Compose base publishes only
`127.0.0.1:4173:4173`, uses an isolated bridge, a read-only root filesystem,
non-root UID/GID 10001, dropped capabilities, `no-new-privileges`, a bounded
`/tmp` tmpfs, and CPU/memory/PID limits.

The desktop package keeps the same repository boundary in a sandboxed Electron
renderer with Node integration disabled and context isolation enabled. The
existing server runs in a separate Electron utility process bound only to
`127.0.0.1:4174`. Navigation and renderer permissions are
denied except for the exact desktop origin and the file-system, clipboard-write,
and loopback permissions the application uses. Chromium profile data and
directory handles live in a persistent Electron session under the current
user's Electron `userData` directory. Electron may omit `webContents` from a
file-system permission check, so checks use the exact requesting origin;
permission requests and restricted-path decisions still require the exact
desktop `webContents`. For operating-system-restricted locations, the main
process normalizes Electron's serialized origin, confirms the request came from
the desktop window, and requires an explicit **Allow this folder** choice before
Chromium receives the handle.

The Diagnostics link can open `/debug` or `/debug.html` on the exact desktop
origin in another sandboxed window with the same isolated settings. Other popup
URLs remain denied. Packaged runtime hashes and a pinned source revision prevent
accidental stale/mixed releases; they are not a replacement for code signing.

### Desktop update boundary

The sandbox preload exposes a small update-only IPC interface. Main process
accepts its calls only from the exact main window's top frame at the desktop
origin. No filesystem, shell command, repository or credential API is exposed.
Update checks query public GitHub release metadata for this repository with no
workspace PAT; release URLs are constructed from validated desktop version tags,
not accepted from the renderer or release prose.

macOS never invokes an automatic installer. Windows in-place updating requires
the per-user installed Squirrel updater and explicit download/staging consent.
The selected release feed's SHA-256 is compared with GitHub metadata; its
package names, versions and sizes are validated before native execution.
Squirrel verifies the downloaded packages against that feed. Restart needs
separate confirmation so the user can save drafts first. Automatic checks and
notifications do not download, restart, elevate privileges or reset the profile.
Public GitHub account/release integrity and HTTPS remain part of this trust
boundary; the current unsigned packages do not claim publisher-signature proof.

For desktop credential persistence, the existing AES-256-GCM envelope key is
generated once and protected on disk with Electron `safeStorage` before being
handed to the utility process. This uses DPAPI for the current Windows user and
Keychain on macOS. The plaintext key is not placed in an environment variable,
command line, log, or renderer. If operating-system encryption is unavailable,
credential persistence is unavailable; the application does not fall back to
plaintext.

macOS should use a consistent Developer ID signature in production. Unsigned
builds may not be recognized as the same Keychain application after an update,
and they are not notarized for Gatekeeper.

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

- API egress is fixed to `https://api.github.com`. Local source creation also has
  a separate anonymous GET-only transport fixed to `https://raw.githubusercontent.com`,
  using a validated repository, full commit SHA, and encoded source path. It
  sends no API credential, cookie, or request body to that host. No API base URL
  is accepted from the user and no host is taken from a GitHub response.
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

- A repository must pass its selected configuration format's compatibility
  checks: required Bicep/Citadel capabilities, or explicitly selected supported
  native Terraform roots and inputs. The server checks the exact branch head
  during attachment, not a trusted browser verdict. Native LLM/Access roots can
  stand alone without Bicep or Deployment files.
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

## New local source creation

**Create local from Citadel source** is independent of GitHub repository creation
and configuration migration. Its owner/session/origin-protected routes accept
only a source selector and operation identifier, never a host path, directory
handle, or PAT. Public metadata must identify the selected repository as public.
The source ref is pinned once; verified Git tree/blob identities bind all bytes
to that commit. Binary files are copied as bytes, not decoded and reconstructed.
Normal preparation uses metadata, commit and tree API reads plus bounded raw-host
file reads, rather than one anonymous REST request per blob.

The complete source is capped at 64 MiB, 8 MiB per blob, 10,000 files, 20,000
entries and 2,000 directories, with bounded manifests, request timeouts, a
preparation deadline, and at most four active file reads. Truncated responses,
invalid identities or sizes, LFS pointers, symlinks, submodules, unsupported
modes, traversal, `.git`, Windows-unsafe names, and normalized/case collisions
are errors, not omissions. One ephemeral server operation expires after
30 minutes; restart drops it. Source bytes are not persisted in `/data`.

Before choosing a folder, the browser downloads and independently verifies the
entire manifest and file hashes. It accepts only an empty granted parent and a
validated, explicitly reviewed child name, rejecting an existing child even if
empty when detected. Only that browser handle grants filesystem authority.
Display paths are inert registry metadata, not source-import inputs.
Permission, parent/ancestor/file handle identity, empty baselines and content
are rechecked before publication; complete enumeration and hash verification
plus the usual Citadel scan precede registration.

File System Access has no portable exclusive-create or no-replace directory
publication primitive. Unpublished writable streams and repeated checks reduce
race windows but do not exclude OS writers, including the final check-to-close
gap. The UI states that limitation and requires the destination stay untouched.
No automatic deletion, replacement, or staging promotion is used. Recovery
resumes only operation-attributed unchanged entries, retaining foreign or
conflicting data; losing the browser's in-memory ledger requires a fresh
destination. Registration failures use explicit compensating metadata removals,
with retained recovery records when confirmation fails. Imported scripts remain
untrusted data: no execution, deployment, Git history, or executable-mode
restoration is part of this operation.

## Configuration migration

**Migrate Citadel Configuration (Experimental)** separates the read-only older
source from the current Bicep destination. Local sources use read-only browser file/folder grants, not
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

The server fixes visibility to private. The client explicitly selects a Personal
or Organization owner, and the server verifies its type, handle and immutable ID.
Personal destinations must match the authenticated account. Organization
destinations must match GitHub's organization identity and active membership;
known member creation-policy denials are enforced. Token rights unavailable
through read-only metadata remain "not verified", not assumed granted.
Name collisions are never overwritten or adopted. An operation records
its intent before creation and verifies repository provenance, immutable ID,
actor account, destination owner, privacy and expected branch heads on recovery.
The actor ID is never conflated with the organization ID. Old journal entries
without an explicit owner retain their original Personal destination; a resume
cannot switch namespaces. It never automatically
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
selected-repository Contents-only recommendation. Discovery combines membership
information with owners of repositories the token can read. It performs no write
permission probes and does not require write access. An explicit organization
profile lookup also proves visibility only. Creation's active-membership checks
still require Members read access for the selected organization.
The UI distinguishes verified membership, policy denial and unverified create
rights; it does not treat a failed lookup as an empty organization list.
Workflows permission is
conditional on source workflow files; for those imports, Actions are disabled
before copying and remain disabled for operator review. GitHub must permit that
settings change. No Pull requests permission is requested.

Only transient GET failures and short-lived visibility delays after a confirmed
create receive bounded retries (at most three attempts, each read capped at
60 seconds). Writes are never blindly replayed. A lost write response requires
same-attempt provenance/state reconciliation. Immutable verified source blobs
can be reused in the bounded in-memory cache after a transient read failure;
authorization failure, cancellation, restart or eviction prevents continued
use. Failure messages retain only the selected owner, known action/stage and
HTTP status, not upstream response bodies or credentials.

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

Browser traversal skips generated and application directories. The Bicep alias
scope allows only `.bicepparam`, `.bicep`, and `.xml`; it rejects
traversal, absolute paths, `.azure` segments, and `.env` names before requesting
a handle. The same rules are defined once in `shared/source-scope.mjs` and are
enforced for both local folders and GitHub trees. A separate, non-generic method
may open only `.azure/<environmentName>/.env`, return only
`AZURE_SUBSCRIPTION_ID`, and replace only that value span after a hash
precondition. When the exact file is absent, it may create the environment
directory and a new `.env` containing only that key. Other values remain
opaque, and no Local environment bytes are sent to the container, transaction backup,
registry, audit, or logs. For a GitHub environment the patched `.env` blob
participates in the same atomic commit protocol and the UI warns that the
subscription id will be committed to the working branch.

Native Terraform uses the versioned scope in
`shared/workspace-configuration.mjs`. Only the registered unit's selected
nonsecret `.tfvars` or `.tfvars.json` is writable. Read authority additionally
covers the known root schema/configuration files, bounded module dependencies
and conventional shared Access XML; listing a filename does not authorize its
contents. Provider/backend/output configuration, state, plans, credentials,
`.terraform`, unrelated inputs and generic environment files are not writable
targets. Native workspaces have no subscription environment bridge.

Native `variables.tf` and dependencies are read-only. Eligible service
`policy_xml` changes own a span in the operator file, not a shared XML file.
An empty literal can select the pinned default through `.tf` behavior;
Citadel does not evaluate that behavior or allow `file()` calls in `.tfvars`.

Native format/root/input/repository/working-branch bindings are immutable.
One GitHub connection may serve multiple formats, but overlapping writable
files on one repository/working branch cannot have multiple owners. Local
folders also have one workspace owner. Losing the original native folder
handle does not grant authority to transfer drafts/history to a newly picked
folder, even if its display path matches.

Known secret-bearing **whole operator or dependency files** are refused before
ordinary native read/review/save, backup or history exposure. An unrelated
nonsecret edit cannot bypass the check: the complete file would enter a backup
or commit. Empty/null slots are allowed; the exact public PII placeholder in the
pinned schema is recognized only as a schema default, not as an operator secret
exception. Concealing a UI field is not sufficient protection. Detection is
conservative, not universal secret discovery; source secrets are neither
silently removed nor encrypted by this workflow.

Local existing-file conflict confirmation backs up current external bytes before
overwrite. Native creation has a separate optimistic concurrency limitation:
browser checks and supported exclusive streams are not atomic create-if-absent.
Detected collisions and unknown ownership are not adopted or deleted merely
because bytes match. See [Backup and recovery](BACKUP-RECOVERY.md).

The source-only migration adapter additionally accepts strict ARM
deployment-parameters JSON. That does not widen the Bicep destination scope or
permit arbitrary JSON, scripts or environment-file evaluation. Native JSON
write authority comes only from its separate explicit unit binding.

## Local API controls

- Owner claim or sign-in issues the random 256-bit session token. `GET /` does
  not expose it; bootstrap metadata reports claim state only.
- API calls require the token, exact Host, same-origin Fetch Metadata, and exact
  Origin for mutations.
- Editable GitHub data routes additionally require the opaque workspace GitHub
  session id. Public migration reads require the owner/browser guard but no PAT;
  private migration reads require a separate source-session capability.
  Credential-management routes use their explicit owner-gated exchange/erasure
  protocol. GitHub routes remain the only routes permitted to use `DELETE`.
- No CORS response is emitted.
- JSON and backup bodies have explicit limits; active request processing is
  bounded to 32 requests by default. Up to 128 same-host static GET/HEAD requests
  can wait for capacity so pages, native modules, styles and parser assets do
  not fail during a startup burst. Waiting requests release their queue slot on
  disconnect. API requests, health checks and a full static queue still receive
  the bounded 503 response; host, path, session, and body guards are unchanged.
- CSP denies external scripts, connections, frames, forms, and objects. The
  browser never contacts GitHub directly. Native parsing adds only
  `'wasm-unsafe-eval'` to same-origin `script-src` for vendored WASM; JavaScript
  `unsafe-eval` and third-party script/connect origins remain disallowed.
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

Citadel UI does not deploy resources, run Terraform/providers or send external
telemetry, analytics or update checks. Timed diagnostics is explicit,
instance-local, memory-only capture with manual sharing, not an external
telemetry exporter. It does not scrub or export the original browser console,
and no-records is not evidence of application health.

Docker Desktop 29.6.2 does not publish host ports from an
`internal: true` network, so the supported Compose profile uses a normal isolated
bridge. Ordinary Local editing and the offline native parser need no outbound
service. GitHub operations use `api.github.com`; explicit public local-source
creation also reads `raw.githubusercontent.com`. Configured hosted credential
storage can read Key Vault through managed identity. These bounded integrations
do not give the editor general cloud-deployment authority.
