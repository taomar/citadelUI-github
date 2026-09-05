# W1 staged hosted foundation

W1 supplies shared infrastructure only. `STAGED_ADAPTER_IDS` and production
`resourcePurposes` are empty. No new production operation, consent audience,
compiler, template, process executor or full staged UI has been enabled.
Existing seven-mode payloads and entered-key behavior remain supported without
opening SQLite. Browser authorization-code sign-in remains the current default;
an explicitly requested device-code option is separate future work, not a fallback.

## Closed requests

Every staged POST below includes `protocolVersion: 2, hostedFlowVersion: 1`.
Listed fields are exhaustive; `?` means optional. Unknown fields, undeclared
inputs/secrets, malformed handles and cross-origin/owner/CSRF requests fail closed.
The normal operator entitlement, pending-auth and context-generation checks apply.

| POST endpoint | Additional fields | Response |
| --- | --- | --- |
| `/api/execution-context` | `sampleId, inputs, gateway?, secretBindings?` | `{context}`; local-only, `canExecute:false` pending later UI/adapter integration |
| `/api/hosted/resolve` | `sampleId, inputs, contextVersion, secrets?, secretBindings?` | `{resolutionId,state,contextVersion,expiresAt,preview,requiredConsents,issues}` |
| `/api/hosted/review` | `resolutionId,contextVersion,reviewDigest,acknowledgement` | `{runNonce,reviewDigest,resolutionId,expiresAt}` |
| `/api/hosted/run` | `resolutionId,contextVersion,reviewDigest,runNonce` | durable `202 {runId,state}`; no submitted executable plan |
| `/api/hosted/status` | `runId` | `{runId,state,steps,result,secretBindings,recovery}`; local store only |
| `/api/hosted/cancel` | `runId` | `{runId,cancelRequested,state}`; fences future sends, not provider rollback |
| `/api/hosted/recoverable` | `contextVersion` | `{runs:[{id,sample,state,recovery}]}`; at most 100 same-owner reserved runs, including lost-202 recovery |
| `/api/hosted/reconcile` | `runId,contextVersion` | status shape after explicitly requested, policy-checked readback |

`gateway` is `{keyPresent:boolean,headerName:string}` and is only a local hint.
`secretBindings` maps declared secret field paths to `{slotId,generation}`.
Supplying an entered value and binding for the same field is rejected before reads.
Risk acknowledgement is `null` or `{accepted:true,sampleId}`; existing normalized,
conditional nonproduction/load/destructive validation is not replaced.

`preview` contains `sampleId,adapterVersion,sourceDigests,templateManifestDigest,
targets,reads,effects,artifacts,credentialBindings,limits,residuals,reviewDigest`.
W1 has no compiled artifacts: the manifest digest is null and artifacts are empty.
`sourceDigests.notebookExpected` is the catalogue's pinned expected notebook hash;
`catalogueMetadata` hashes its notebook/cell metadata. Neither claims a runtime
filesystem verification or compiled-template equivalence.

Resolve stores one immutable five-minute resolution per session. Review performs
no provider I/O and issues a one-minute ticket. Durable admission commits nonce,
run and canonical resource reservations atomically before returning 202.
Rejected admission does not consume the in-memory ticket. Only the reviewed
precondition requests may run before effects; whole-response digest drift yields
`result.meta.code: "review-required"` with zero effects and no implicit re-resolve.
Source/policy file overrides for Weather are rejected before any provider read.

Status/cancel require the original session/context binding. Reauthentication uses
the explicit same-tenant/object recoverable/reconcile path instead. A changed or
missing adapter policy is reported, not silently replaced. Reconciliation never
resends effects or retrieves a credential. Terminal execution may remain
inconclusive after a separately successful reconciliation; `recovery:null`
means its reservation has been released, not that the original operation passed.

## Authentication and in-memory credentials

Legacy `/api/auth/start` bodies remain `{purpose:"signin"}` and `{purpose:"azure"}`.
New purposes require exactly `{purpose,protocolVersion:2,hostedFlowVersion:1,
resolutionId,contextVersion,consentIntentId,targetDigest}`. Their only values are
`foundry`, `key-vault`, `insights`; production enablement is deliberately empty.
No scopes, authority, tenant/client identifiers, bearer tokens or fallback identity
can be supplied by a browser. The public-cloud scope candidates in
`credentialPurposes.mjs` are unverified service contracts, not tenant consent.

`requiredConsents` contains `{purpose,consentIntentId,resolutionId,contextVersion,
targetDigest,expiresAt}`. The server intent also binds tenant/object, session,
auth/resolution generations and policy digest. The target digest includes exact
purpose/method/URL routes and credential targets. Stale, swapped, expired and
consumed intents are rejected before auth-client creation, context mutation or
start admission. Cancellation and late callbacks cannot rotate a retained
operator or clear a newer cookie. After successful consent, Resolve is explicit again.

`auth.token(session,purpose="azure")` uses purpose-fixed scopes and exact cached
tenant/object/home-account identity. `sessions.finish` rotates session/CSRF,
preserves validated same-owner `credentials[purpose] = {cache,account,
grantGeneration}`, and transfers no grants on account-switch sign-in. Legacy
`azure`/`cache` projections remain available. `authGeneration`, context invalidation,
transaction consumption/in-flight reservation and N1 capabilities preflight are
shared seams any later device-login implementation must preserve; W1 adds no device flow.

Here `cache` is a live MSAL `ConfidentialClientApplication` instance, **not**
serialized cache JSON. `createMicrosoftAuth().client()` always constructs that
CCA with the configured confidential credential and bounded HTTPS network adapter;
`finish()` returns `tx.client`, and `token()` calls that retained instance's
`acquireTokenSilent`. Successful same-owner consent retains each earlier purpose's
separate instance. Transaction cancellation removes its admission record and
prevents adoption, but an already-awaiting auth call may retain its local client
until it settles. W1 has no PCA factory, grant-kind discriminator or client-disposal
API. A later device contract must explicitly separate PCA/CCA factories and
verified grant adoption rather than mixing their caches or retaining aborted flows.

`createSecretSlots(sessions)` exports `putGenerated`, `resolveBinding`, `describe`,
`revokeSession`, `revokeTarget`, `close`. Raw values exist only in process memory.
The target is `{resourceId,origin,routes,headerName}` with an exact APIM subscription
resource ID and HTTPS routes. Session/context/field/generation/expiry are checked
again before use. Replacement invalidates old bindings/reviews; context/logout,
expiry and explicit target revocation remove values. No HTTP secret-read route exists.

Only the future access-deploy descriptor may declare
`generatedFields:["gatewayAccess.apiKey"]`, separate from its input fields.
Confirmed execution can expose `{slotId,generation,field,expiresAt,targetLabel}`,
never a key. Consumers send only the slot ID/generation for their existing
`gatewayAccess.apiKey` field. `rebuildPlan` passes its existing server `hasSecret`
callback into catalogue validation: presence of a bound secret satisfies the
required-secret gate without injecting a fake value or disabling other validation.

## Fixed adapter and store exports

`createAdapterRegistry({testAdapters?})` exposes `ids,get`. W1 has no production
imports. Trusted constructor injection requires the Node test-runner context;
there is no HTTP, browser or environment adapter loader. Agent Framework is refused.
A descriptor has `id,version,policyId,resolvePurposes,generatedFields?,
resolve,authorizeRequest,execute,reconcile`. Resolution purposes currently allow
only ARM or none. Arrays/definitions are frozen.

`resolve({inputs,read})` returns exactly `{targets,preconditions,operations,
credentialTargets?}`. A target is `{resourceId,origin}`; a precondition is
`{request,digest}`. Operations have `id,method,url,purpose,effect` and optional
`body,headers,keyField`. Only fixed HTTPS requests with the `api-version` query
are accepted. Read phases allow GET only; write/paid requests are distinct.
The policy callback must authorize each phase/request; execution additionally
requires exact equality to a reviewed operation. W1 does not implement pagination,
LRO expansion, deployment bodies, load loops or cleanup algorithms.

`execute({resolution,send,confirmEffect,putGenerated})` returns only
`{state:"completed"|"failed"|"inconclusive"}`. `send` records intent before transport;
HTTP success alone does not confirm the outcome. A fixed adapter must validate
its response before `confirmEffect(id)`. Unconfirmed effects, 429/5xx and interrupted
responses retain reservations. No automatic resume or mutation retry exists.
`reconcile({run,effects,read})` returns a complete bounded array of
`{id,confirmed:true}` or fails inconclusive. It can only perform policy-allowed reads.

`createRunStore` re-exports `createSqliteRunStore`. Store methods are `claim,get,
hasReservation,listRecoverable,beginEffect,observeEffect,finish,effects,reconcile,
checkpoint,diagnostics,close`. `claim` takes `{tenant,owner,sampleId,adapterVersion,
policyDigest,identityDigest,nonceHash,targets}`. Intended operations persist only
ID/digest; observations are `{status,outcome:"confirmed"|"unknown"}`. No SQL,
request/response body, MSAL cache, key or session credential is a public store input.
Reservation identity conservatively collapses APIM children to the owning service,
Cognitive Services children to the account, and unresolved gateway identity to
the HTTPS origin. Known resources also reserve their origin; resolution includes
every effect origin, so learning a resource ID cannot bypass an older origin-only
reservation. This deliberately serializes unrelated resources sharing an origin
until a finer alias policy is independently reviewed. Identity never depends on
session IDs or ephemeral secret-HMAC salts.

## Storage, bounds and remaining gates

Staged mode requires Node 24 on Linux, an existing owner-only directory and a
dedicated persistent local volume. Known ext/XFS/btrfs types are accepted; unknown,
network/overlay/tmpfs and Windows are refused. The initial Windows probe returned
statfs type 0; this was not accepted as local-disk proof. Deployment persistence
cannot be inferred from statfs: the owner must actually mount and operate the volume.

`runs.sqlite` uses schema version 1, fixed prepared statements, transactional
migration, WAL, FULL synchronous and foreign-key readback. Extensions remain
disabled. `instance.sqlite` uses DELETE/EXCLUSIVE and a committed write to acquire
and retain the OS lock; no stale-lock deletion or silent recreation is used.
Reopen marks unfinished work inconclusive/unknown and retains target reservations.
No startup dispatcher resumes it. Database disappearance/replacement, corruption,
unavailability and over-capacity fail closed. Unresolved records are never purged.

Bounds: 4096 runs; 64 MiB per checked database/WAL file; 64 KiB result; 256 stored
effects/run; 16 targets, 32 preconditions, 64 operations/resolution; 256 KiB request
and existing 2 MiB response ceiling; 128 transport requests; 30-second Resolve/
readback and 75-second execution deadlines. Resolve admission is one/operator,
eight globally and four/adapter; run admission is one/operator, configured global
capacity and exclusive canonical target reservations. No retention/pruning service,
deployment-length runner, load cooldown policy or scale-out claim is supplied.

SQLite is synchronous: short transactions and a 50 ms busy wait do not impose an
fsync latency SLA. No token/provider await occurs in a transaction. Explicit
checkpoint and contention measurements are observations on the test volume only.
The pinned Node 24.20 runtime, actual guard/process-crash/reopen and replacing
containers over the same named volume require retained evidence at each freeze.

Later compiler selection/hash and actual raw/derived access artifact approval
remain gated. Neither KV-off nor its credential-bearing source output is silently
changed; W1 deploys neither variant. The eleven adapters remain pending.
Nine coordinator blockers remain: `browser-matrix`, `screen-reader`,
`nonprod-approval`, `live-baseline`, `live-fixtures`, `live-policy-cleanup`,
`hosted-integration`, `configure-hosted-deployment`, `approve-hosted-agent-framework`.
There is no live tenant/TLS/target setup or Azure/gateway proof in W1.
