# Citadel UI deployment record

**Status:** Live acceptance completed on 2026-09-06.
**Scope:** Citadel UI only. Gateway infrastructure and sample branches are excluded.
**Region exercised:** West Europe.

## Supported workflow

Operator configuration lives in `infra/main.bicepparam`. azd reads it natively;
`scripts/prepare-deployment.ps1` synchronizes evaluated nonsecret inputs into the
selected environment before resource preflight. Context, image and legacy secret
values are not copied by that synchronization step.

The postprovision hook calls `scripts/ensure-credential-key.ps1`. It creates the
credential-encryption key only when absent and preserves an existing key before
the UI image starts. Hosted deployments use owner sign-in, not an external
container login provider.

Use `scripts/deploy-image.ps1` for image-only updates. Private registry builds
must run on a connected private host; ordinary hosted remote builds do not gain
private endpoint access merely because an existing registry was selected.

## Live acceptance completed

| Scenario | Result |
| --- | --- |
| Fresh public `azd up` | Passed; new infrastructure and UI image deployed |
| Repeat public `azd up` | Passed; owner, registry state and exact key version retained |
| Native Bicep parameter-file workflow | Passed with actual azd |
| Public image-only helper | Passed with retained state |
| Protected platform pre-staging | Passed after source-controlled corrections |
| Private existing-resource deployment | Passed from the private build VM with an immutable image |
| Private DNS and HTTP | UI, registry, vault, storage and monitoring resolved privately; UI/sign-in checks passed |
| Key Vault and Azure Files | App identity read its key; durable state was readable/writable |
| Private diagnostic query | Passed through AMPLS after diagnostic delivery |
| Repeat private deployment | Passed; owner, state, exact key version and private log access retained |
| Shared-resource configuration | Eight before/after snapshots unchanged |

Fresh private-network creation through the main template was compiled and
checked offline, but was not the fresh live scenario selected for this run.
Do not represent it as live-tested.

## Protected-resource prerequisites

`infra/protected/` and `scripts/protected-*` provide isolated test pre-staging:
Premium ACR, private Key Vault and storage, internal Container Apps environment,
Log Analytics/AMPLS, private endpoints and DNS, scoped identities and a temporary
private build/test VM. The UI runs in Container Apps, not on that VM.

The runner has no public IP or inbound SSH; NAT provides explicit outbound HTTPS
for platform and signed package/image sources. This is not an air-gapped design.
An existing connected workstation or private CI runner can replace the test VM.

Direct Container Apps logging through a customer Log Analytics private endpoint
is unsupported. The tested configuration uses `azure-monitor` diagnostics over
Microsoft's private delivery channel, with public workspace ingestion/query
disabled and private query through AMPLS.

## Corrections captured in source

- Added scoped environment join permission for cross-resource-group app creation.
- Enabled the registry data endpoint and vault purge protection.
- Removed invalid Allow rules using the special platform DNS/IMDS service tags.
- Handled omitted public-IP fields during strict-mode NIC validation.
- Streamed large receiver code through stdin to avoid Linux argument limits.
- Enforced LF shell sources before transfer and preserved their checksums.
- Set an explicit private HOME for noninteractive Azure agent operations.

No service firewall was opened as a test workaround. Shared settings were
captured before UI deployment and compared afterwards.

## Validation and evidence

Bicep build/lint, actual Azure validation/what-if, native PowerShell/Linux checks,
source-transfer checksum/reassembly tests and live API checks were performed.
Detailed logs, source hashes and encrypted test credentials are retained outside
the repository; no secrets or transfer payloads belong in Git.

The existing primary-editor and missing external-repository fixture failures
remain unrelated baseline limitations. The known connection-profile temporary-file
race reproduced during the full suite and passed its targeted rerun.

## Cleanup

The user authorized deleting all Azure test resources created in this effort
after publication. The original pre-existing deployment must remain untouched.
Purge-protected test vaults retain their soft-deleted names for seven days;
their protection must not be disabled to speed cleanup.
