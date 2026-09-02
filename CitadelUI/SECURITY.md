# Local Security Model

Citadel UI is a single-user local editor. The supported origin is
`http://127.0.0.1:4173`.

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
- For GitHub environments the container additionally owns the only outbound
  network boundary in the product and a memory-only credential.

The container has no source, home, drive, Docker socket, Git credential, Azure
credential, or cloud-service mount. Compose publishes only
`127.0.0.1:4173:4173`, uses an isolated bridge, a read-only root filesystem,
non-root UID/GID 10001, dropped capabilities, `no-new-privileges`, a bounded
`/tmp` tmpfs, and CPU/memory/PID limits.

## GitHub credentials

- Only a fine-grained personal access token is accepted. Classic tokens are
  refused unless explicitly enabled, because their scope cannot be limited to the
  selected repositories.
- The token is sent once over the existing protected loopback session and is
  retained **only in server process memory**. It is never written to `/data`, a
  Docker environment variable, Git configuration, browser storage, a cookie, a
  URL, a log line, an audit record, a transaction record, an error message, or
  any response body.
- The browser retains only an opaque, server-issued session id, in
  `sessionStorage`, so it dies with the tab.
- Sessions are keyed by a SHA-256 of that id, compared in constant time, expire
  after 30 minutes idle and 8 hours absolute, are bounded in number, and are
  cleared on container restart. **Disconnect GitHub** erases the credential
  immediately.
- Credential submissions are rate limited per browser session.
- Token-shaped strings and `Authorization`/`Bearer` fragments are redacted from
  any text that could reach a user or a log.

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
- Every Citadel operation is one blob/tree/commit/ref transaction, so a
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

## Local API controls

- A random 256-bit session token is injected into the no-store bootstrap HTML.
- API calls require the token, exact Host, same-origin Fetch Metadata, and exact
  Origin for mutations.
- GitHub routes additionally require the opaque GitHub session id, and are the
  only routes permitted to use `DELETE`.
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
