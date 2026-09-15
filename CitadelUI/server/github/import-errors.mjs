import { repositoryOwnerLabel } from '../../shared/repository-owner.mjs';

export function transientImportRead(error) {
  return ['GITHUB_TIMEOUT', 'GITHUB_UNREACHABLE'].includes(error?.code) ||
    ['GITHUB_REQUEST_FAILED', 'PUBLIC_DONOR_READ_FAILED', 'LOCAL_IMPORT_READ_FAILED'].includes(error?.code) &&
      [500, 502, 503, 504].includes(error?.upstreamStatus || error.status);
}

export function importRequestContext(path, options, op) {
  const method = options.method || 'GET';
  const target = ['source', 'manifest', 'blobs', 'compatibility'].includes(op.stage) && method === 'GET' ||
    path.startsWith(`/repos/${op.source?.fullName}/`) || path === `/repos/${op.source?.fullName}`
    ? 'source' : path === '/user' ? 'account' : 'destination';
  let action = method === 'GET' ? 'read GitHub data' : 'update repository data';
  if (method === 'POST' && (path === '/user/repos' || /^\/orgs\/[^/]+\/repos$/.test(path))) action = 'create the private repository';
  else if (path.endsWith('/actions/permissions')) action = method === 'GET' ? 'read GitHub Actions settings' : 'disable GitHub Actions for the import';
  else if (path.endsWith('/git/blobs')) action = 'upload a binary file';
  else if (path.endsWith('/git/trees')) action = 'write the imported file tree';
  else if (path.endsWith('/git/commits')) action = 'write the import commit';
  else if (path.includes('/git/refs/') || path.includes('/branches/')) action = method === 'GET' ? 'read the repository branch' : 'publish the repository branch';
  else if (path.includes('/git/blobs/')) action = 'download a file';
  else if (path.includes('/git/trees/')) action = 'read the file manifest';
  return { method, target, action, stage: op.stage };
}

export function importFailureDescription(error, op) {
  const context = error?.importRequest;
  const status = error?.upstreamStatus || error?.status;
  const owner = op.owner || { type: 'User', id: op.accountId, login: op.login };
  const target = context?.target === 'source' ? `source ${op.source?.fullName || 'repository'}`
    : context?.target === 'account' ? `authenticated Personal @${op.login}`
      : `${repositoryOwnerLabel(owner)}/${op.name}`;
  const action = context?.action || 'finish this import';
  const prefix = `Could not ${action} for ${target}${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.`;
  if (error?.code === 'GITHUB_TIMEOUT') return {
    code: 'IMPORT_TIMEOUT', message: `${prefix} GitHub did not finish the request before the timeout. ${context?.method === 'GET'
      ? 'Bounded read retries were exhausted. Resume this same attempt; verified source bytes are reused while this server keeps them in memory.'
      : 'The write was not automatically retried. Resume this same attempt to reconcile whether it completed.'}`,
  };
  if (error?.code === 'GITHUB_UNREACHABLE' || [500, 502, 503, 504].includes(status)) return {
    code: 'IMPORT_NETWORK_FAILED', message: `${prefix} GitHub or the network/proxy is unavailable. This is not proof of missing permissions. Resume this same attempt after connectivity recovers.`,
  };
  if (status === 403) return {
    code: 'IMPORT_ACCESS_DENIED',
    message: `${prefix} GitHub denied this action for the selected owner. Check the token Resource owner, ${action.includes('Actions') ? 'Actions settings access' : 'Administration and Contents permissions'}, and organization/enterprise approval, SSO or creation policy. Membership alone does not prove these rights.`,
  };
  if (status === 404) return {
    code: 'IMPORT_NOT_VISIBLE', message: `${prefix} The resource is missing or not visible to this connection. Confirm the source/destination owner and the token's selected repositories; do not create a replacement attempt.`,
  };
  if (status === 422 || status === 409) return {
    code: 'IMPORT_REQUEST_REJECTED', message: `${prefix} GitHub rejected the repository name, settings or current state. Check the displayed destination for an existing repository or organization rule, then reconcile this same attempt.`,
  };
  return { code: 'IMPORT_FAILED', message: `${prefix} Refresh this attempt's status and resume it; no permission failure is assumed.` };
}
