/**
 * Server-owned Citadel compatibility scan for a GitHub repository.
 *
 * A token that can push is not the same thing as a repository Citadel can edit.
 * The picker lists everything the credential reaches, so the decision of whether
 * a repository is a Citadel repository has to be made against its *contents*,
 * and it has to be made somewhere the browser cannot skip.
 *
 * The invariants are not restated here. `discoverWorkspace` in
 * `shared/citadel-core.mjs` is the single definition of what a Citadel workspace
 * is -- the same code the local folder provider is judged by -- so a GitHub
 * repository is held to exactly the same standard rather than to a weaker guess
 * based on a repository name.
 *
 * The scan is read-only: it lists one tree and reads the `.bicepparam` sources
 * in it. It creates no branch, no commit, and no registry record.
 */
import { discoverWorkspace } from '../../shared/citadel-core.mjs';
import { citadelSourcePlan, planScope } from '../../shared/source-plan.mjs';
import { githubError } from './api.mjs';
import { loadTree, readBlob, requireBranchHead } from './workspace.mjs';

/** Sources read during one scan, so a malformed repository cannot be a workload. */
const MAX_SCANNED_SOURCES = 400;

/**
 * A read-only `discoverWorkspace` provider backed by one commit's tree.
 *
 * Only the two methods discovery uses are implemented. Anything else would be
 * an unused write path into a repository the user has not yet attached.
 */
export function githubScanProvider(client, token, fullName, snapshot) {
  const blobs = new Map();
  let reads = 0;
  return {
    // Reads cross a network, so discovery scopes itself. This scan passes an
    // explicit narrower scope as well; stating it here keeps the provider
    // honest if that ever stops being true.
    remote: true,
    async entries() {
      return snapshot.files.map((file) => ({ alias: file.alias, kind: file.kind }));
    },
    async read(alias) {
      const file = snapshot.files.find((item) => item.alias === alias);
      if (!file) {
        throw githubError(404, 'SOURCE_NOT_FOUND', `Source not found: ${alias}`);
      }
      const cached = blobs.get(file.sha);
      if (cached) return cached;
      reads += 1;
      if (reads > MAX_SCANNED_SOURCES) {
        throw githubError(
          413,
          'REPOSITORY_TOO_LARGE',
          'This repository has too many Citadel sources to validate.'
        );
      }
      const blob = await readBlob(client, token, fullName, file.sha);
      const record = { text: blob.text, size: blob.size, hash: blob.hash };
      blobs.set(file.sha, record);
      return record;
    },
  };
}

/**
 * Which primary editors a catalog can actually open, in the product's words.
 *
 * Reported so the user is told what was *detected*, not merely that a check
 * passed -- and so a degraded repository names what is missing.
 */
function detectedCapabilities(catalog) {
  const capabilities = catalog.capabilities || {};
  return [
    capabilities.main ? 'Main deployment' : null,
    capabilities.llmOnboarding ? 'LLM onboarding' : null,
    (capabilities.accessContracts || []).length ? 'Access contracts' : null,
  ].filter(Boolean);
}

/**
 * Scan one repository at one exact commit.
 *
 * `head` is returned with the verdict because the verdict is only true of that
 * commit. Attachment revalidates against the head it is about to branch from,
 * so a repository that changed between the check and the attach is refused
 * rather than silently accepted on stale evidence.
 *
 * The verdict also names the repository and branch it is *about*. A verdict that
 * does not say what it describes forces every caller to re-derive that from its
 * own state, and a caller whose state has moved on cannot tell a fresh answer
 * from a stale one — which is how a successful validation ends up unable to
 * enable the button it exists to enable.
 */
export async function inspectRepositoryCompatibility(client, token, fullName, commitSha, branch = null) {
  const snapshot = await loadTree(client, token, fullName, commitSha);
  const provider = githubScanProvider(client, token, fullName, snapshot);
  // Only the files that prove the three capabilities. Reading every parameter
  // file in the repository to answer "is this a Citadel repository" downloaded
  // the whole product to check its name plate.
  const plan = citadelSourcePlan(snapshot.files);
  const catalog = await discoverWorkspace(provider, {
    scope: planScope(plan, 'capabilities'),
  });
  return {
    fullName,
    branch,
    head: commitSha,
    compatibility: catalog.compatibility,
    supported: catalog.compatibility === 'supported',
    missingCapabilities: catalog.missingCapabilities || [],
    detected: detectedCapabilities(catalog),
    sourceCount: snapshot.files.length,
  };
}

/**
 * Scan the current head of one branch.
 *
 * The head is read here rather than accepted from the browser: the point of the
 * check is to describe what is really on that branch right now.
 */
export async function inspectBranchCompatibility(client, token, fullName, branch) {
  const head = await requireBranchHead(client, token, fullName, branch);
  return inspectRepositoryCompatibility(client, token, fullName, head, branch);
}

/**
 * The gate attachment uses, immediately before it mutates anything.
 *
 * A browser that skipped the check, replayed an old verdict, or raced a push
 * cannot get past this: the head is re-read, compared against the head the user
 * was shown, and the contents are scanned again. Nothing has been created at the
 * point this throws.
 */
export async function assertAttachableRepository(client, token, fullName, branch, expectedHead) {
  const head = await requireBranchHead(client, token, fullName, branch);
  if (expectedHead && head !== expectedHead) {
    throw githubError(
      409,
      'REPOSITORY_MOVED',
      `${branch} moved while it was being validated. Re-check the repository before attaching.`,
      { head }
    );
  }
  const result = await inspectRepositoryCompatibility(client, token, fullName, head, branch);
  if (!result.supported) {
    throw githubError(
      422,
      'REPOSITORY_UNSUPPORTED',
      `${fullName} is not a Citadel repository on ${branch}. Missing: ${
        result.missingCapabilities.join(', ') || 'the Citadel source layout'
      }.`,
      { missingCapabilities: result.missingCapabilities }
    );
  }
  return result;
}
