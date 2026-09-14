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
import { citadelSourcePlan, planScope } from '../../shared/source-plan.mjs';
import { discoverConfiguredWorkspace } from '../../shared/terraform/workspace.mjs';
import { githubError } from './api.mjs';
import { loadTree, requireBranchHead } from './git-reader.mjs';
import { githubScanProvider } from './scan-provider.mjs';

export { githubScanProvider } from './scan-provider.mjs';

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
export async function inspectRepositoryCompatibility(client, token, fullName, commitSha, branch = null, configuration = undefined) {
  const snapshot = await loadTree(client, token, fullName, commitSha, configuration);
  const provider = githubScanProvider(client, token, fullName, snapshot, configuration);
  // Only the files that prove the three capabilities. Reading every parameter
  // file in the repository to answer "is this a Citadel repository" downloaded
  // the whole product to check its name plate.
  const plan = citadelSourcePlan(snapshot.files);
  const catalog = await discoverConfiguredWorkspace(provider, null, {
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
export async function inspectBranchCompatibility(client, token, fullName, branch, configuration = undefined) {
  const head = await requireBranchHead(client, token, fullName, branch);
  return inspectRepositoryCompatibility(client, token, fullName, head, branch, configuration);
}

/**
 * The gate attachment uses, immediately before it mutates anything.
 *
 * A browser that skipped the check, replayed an old verdict, or raced a push
 * cannot get past this: the head is re-read, compared against the head the user
 * was shown, and the contents are scanned again. Nothing has been created at the
 * point this throws.
 */
export async function assertAttachableRepository(client, token, fullName, branch, expectedHead, configuration = undefined) {
  const head = await requireBranchHead(client, token, fullName, branch);
  if (expectedHead && head !== expectedHead) {
    throw githubError(
      409,
      'REPOSITORY_MOVED',
      `${branch} moved while it was being validated. Re-check the repository before attaching.`,
      { head }
    );
  }
  const result = await inspectRepositoryCompatibility(client, token, fullName, head, branch, configuration);
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
