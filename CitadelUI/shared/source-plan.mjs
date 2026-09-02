/**
 * What Citadel is actually interested in, decided from path metadata alone.
 *
 * ## Why this exists
 *
 * Discovery used to read every `.bicepparam` in the repository and every
 * template each one referenced. Against a real 170-file Citadel repository that
 * was 32 network reads and 38 seconds, and almost all of it was wasted: Citadel
 * has exactly three editors, and it already knows where their sources live.
 * Making those 32 reads faster was the wrong correction. Not making them is the
 * right one.
 *
 * ## What it is allowed to look at
 *
 * Tree metadata — aliases and kinds — which is one request for the whole
 * repository and carries no file content. Everything here is a decision about
 * *paths*. No blob is read to build a plan.
 *
 * ## The interest set
 *
 *   - The Main deployment parameter file, at its exact known path.
 *   - The LLM onboarding parameter file, at its exact known path.
 *   - Parameter files under a `citadel-access-contracts` subtree, and the policy
 *     XML beside them.
 *   - The Bicep template each of those references — resolved after the
 *     parameter file is read, and fetched once per template no matter how many
 *     parameter files point at it.
 *
 * A subscription `.azure/<environment>/.env` is deliberately absent. It is
 * reachable only through its own dedicated bridge, which returns one key, and it
 * must never become part of a scan.
 */

export const CONTRACT_ROOT_MARKER = 'citadel-access-contracts';
export const MAIN_PATH = 'bicep/infra/main.bicepparam';
export const LLM_PATH = 'bicep/infra/llm-backend-onboarding/main.bicepparam';

/**
 * Subtrees inside a contract root that are not themselves contracts.
 *
 * Shared modules, the policy documents a contract loads, and the base contracts
 * a contract is derived from all live under the marker without being editable
 * contracts. Discovery already knows this — `contractMetadata` returns null for
 * them — so the interest policy has to know it too. When the two disagreed, the
 * plan pulled `base-contracts/common/main.bicepparam` across the network and
 * discovery then classified it as generic: a file downloaded to be ignored.
 */
export const NON_CONTRACT_SUBTREES = Object.freeze(['modules', 'policies', 'base-contracts']);

/** The contract subtree an alias belongs to, or null. */
export function contractRootOf(alias) {
  const parts = String(alias).split('/');
  const index = parts.lastIndexOf(CONTRACT_ROOT_MARKER);
  if (index < 0) return null;
  return parts.slice(0, index + 1).join('/');
}

/**
 * Whether an alias is an editable contract, judged from its path alone.
 *
 * The single definition both the plan and discovery answer to.
 */
export function isContractAlias(alias) {
  const parts = String(alias).split('/');
  const index = parts.lastIndexOf(CONTRACT_ROOT_MARKER);
  if (index < 0) return false;
  return !NON_CONTRACT_SUBTREES.includes(parts[index + 1]);
}

function isUnder(alias, root) {
  return Boolean(root) && (alias === root || alias.startsWith(`${root}/`));
}

/**
 * Classify a repository's aliases into the sources Citadel edits.
 *
 * `entries` is the tree listing: `{ alias, kind }`. Nothing here reads content,
 * so a plan costs one tree request and can be built before any decision about
 * what to download.
 */
export function citadelSourcePlan(entries = []) {
  const aliases = new Set(entries.map((entry) => entry.alias));
  const parameters = entries
    .filter((entry) => entry.kind === 'bicepparam')
    .map((entry) => entry.alias);

  const main = parameters.includes(MAIN_PATH) ? MAIN_PATH : null;
  const llm = parameters.includes(LLM_PATH) ? LLM_PATH : null;

  const contractRoots = new Set();
  for (const alias of parameters) {
    const root = contractRootOf(alias);
    if (root) contractRoots.add(root);
  }
  const contracts = parameters
    .filter((alias) => alias !== main && alias !== llm && isContractAlias(alias))
    .sort((left, right) => left.localeCompare(right));
  const policies = [...aliases]
    .filter(
      (alias) =>
        alias.toLowerCase().endsWith('.xml') &&
        [...contractRoots].some((root) => isUnder(alias, root))
    )
    .sort((left, right) => left.localeCompare(right));

  // The parameter files needed to prove the three capabilities. A contract
  // subtree proves itself with its template contract, which is the one Citadel
  // copies to create a new contract; the instances beside it are candidates and
  // are named from their paths rather than downloaded.
  const contractTemplate =
    contracts.find((alias) => alias.endsWith(`${CONTRACT_ROOT_MARKER}/main.bicepparam`)) ||
    contracts[0] ||
    null;

  const signature = [main, llm, contractTemplate].filter(Boolean);
  const interest = new Set([...signature, ...contracts]);

  return {
    aliases,
    main,
    llm,
    contracts,
    policies,
    contractRoots: [...contractRoots].sort((left, right) => left.localeCompare(right)),
    contractTemplate,
    /** The minimum set that proves Main + LLM + Access. */
    signature,
    /** Every parameter file Citadel will ever open, templates excluded. */
    interest,
    /** Parameter files that exist but are none of Citadel's business. */
    unrelated: parameters.filter((alias) => !interest.has(alias)),
    isInterest(alias) {
      return interest.has(alias);
    },
  };
}

/**
 * The read scope for one purpose.
 *
 * `capabilities` is what a compatibility check needs and nothing more.
 * `workspace` adds the contract instances the Contracts area lists.
 */
export function planScope(plan, purpose = 'workspace') {
  if (!plan) return null;
  return new Set(purpose === 'capabilities' ? plan.signature : plan.interest);
}
