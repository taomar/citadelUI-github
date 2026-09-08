import { resolveAlias } from './citadel-core.mjs';
import { contractRootOf, isContractAlias, NON_CONTRACT_SUBTREES } from './source-plan.mjs';
import { publicDonorAlias } from './migration-public-github.mjs';
import { sourceExtension } from './source-scope.mjs';

const EXCLUDED = new Set([
  ...NON_CONTRACT_SUBTREES, 'apim-gateway-upgrade', 'citadel-publish-contracts', 'samples', 'examples', 'validation',
]);
const TOOLING = ['src/usage-ingestion-logicapp', 'src/usage-reports'];

export function excludedMigrationSource(alias) {
  const path = alias.toLowerCase();
  if (TOOLING.some((root) => path.startsWith(`${root}/`) || path.includes(`/${root}/`))) return true;
  const root = contractRootOf(path);
  return root
    ? !isContractAlias(path) || path.slice(0, path.lastIndexOf('/')) === root
    : path.split('/').some((part) => EXCLUDED.has(part));
}

export function migrationTemplateAlias(alias, using) {
  if (!using || typeof using !== 'string' || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|[/\\])/.test(using)) return null;
  try {
    const target = publicDonorAlias(resolveAlias(alias, using));
    return sourceExtension(target) === '.bicep' ? target : null;
  } catch { return null; }
}
