# Local Security Model

Citadel UI is a single-user local editor. The supported origin is
`http://127.0.0.1:4173`.

## Trust boundaries

- The browser owns Citadel repository authority through user-selected
  `FileSystemDirectoryHandle` objects retained in IndexedDB.
- `/data/settings/registry.json` mirrors labels, IDs, folder display names,
  user-entered display-only Local paths, capability versions/fingerprints,
  compatibility, and timestamps. It never contains handles.
- Shared browser modules parse, discover, preview, and edit source bytes.
- The container owns only application files and durable `/data` state. It stores
  Local path as inert profile metadata and never uses it to open a repository.

The container has no source, home, drive, Docker socket, Git credential, Azure
credential, or cloud-service mount. Compose publishes only
`127.0.0.1:4173:4173`, uses an isolated bridge, a read-only root filesystem,
non-root UID/GID 10001, dropped capabilities, `no-new-privileges`, a bounded
`/tmp` tmpfs, and CPU/memory/PID limits.

## Source exclusions

Browser traversal skips generated and application directories. Generic alias
validation allows only `.bicepparam`, `.bicep`, and `.xml`; it rejects
traversal, absolute paths, `.azure` segments, and `.env` names before requesting
a handle. A separate, non-generic browser method may open only
`.azure/<environmentName>/.env`, return only `AZURE_SUBSCRIPTION_ID`, and replace
only that value span after a full-file hash precondition. When the exact file is
absent, it may create the environment directory and a new `.env` containing
only that key. Other values remain
opaque, and no environment bytes are sent to the server, transaction backup,
registry, audit, or logs.

## Local API controls

- A random 256-bit session token is injected into the no-store bootstrap HTML.
- API calls require the token, exact Host, same-origin Fetch Metadata, and exact
  Origin for mutations.
- No CORS response is emitted.
- JSON and backup bodies have explicit limits; concurrency is bounded.
- CSP denies external scripts, connections, frames, forms, and objects.
- Errors carry correlation IDs. Request bodies, authorization headers, source
  content, diffs, values, Local paths, and browser handles are never logged.

## Sensitive data

Backups under `/data` contain the original selected source bytes and may contain
secure parameters or policy content. Use a user-owned local data directory with
restrictive permissions. Do not include `/data`, browser storage, transaction
tokens, or container logs in support bundles.

Citadel UI has no Azure runtime calls, deployment actions, telemetry, analytics,
or update checks. Docker Desktop 29.6.2 does not publish host ports from an
`internal: true` network, so the supported Compose profile uses a normal isolated
bridge; application code and CSP make no outbound runtime requests.
