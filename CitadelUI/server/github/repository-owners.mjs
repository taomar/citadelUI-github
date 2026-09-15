import { githubError } from './api.mjs';
import { repositoryOwner, repositoryOwnerKey, repositoryOwnerLabel, sameRepositoryOwner } from '../../shared/repository-owner.mjs';

const permissionNote = 'Creation permissions are not verified. Token permissions and organization policy still apply.';
const discoverySources = [
  { kind: 'membership', label: 'Organization memberships', path: '/user/memberships/orgs?state=active' },
  { kind: 'repositories', label: 'Readable repositories', path: '/user/repos?affiliation=owner,collaborator,organization_member&sort=updated' },
];

export class RepositoryOwners {
  constructor({ client, validateSession }) {
    this.client = client;
    this.validateSession = validateSession;
  }

  async read(session, path) {
    this.validateSession?.(session);
    if (!session?.token) throw githubError(401, 'IMPORT_AUTH_REQUIRED', 'Reconnect GitHub before checking repository owners.');
    try {
      return await this.client.request(path, { token: session.token });
    } catch (error) {
      error.importRequest = { method: 'GET', stage: 'owner',
        target: path === '/user' ? 'account' : 'destination',
        action: path === '/user' ? 'verify the signed-in GitHub user' : path.startsWith('/user/memberships/')
          ? 'verify Organization membership' : path.startsWith('/user/repos?')
            ? 'discover owners of readable repositories' : 'read Organization access policy' };
      throw error;
    }
  }

  async identity(session) {
    const { data } = await this.read(session, '/user');
    const owner = repositoryOwner({ type: data?.type, id: data?.id, login: data?.login });
    if (owner.type !== 'User' || owner.id !== session.accountId) {
      throw githubError(403, 'IMPORT_WRONG_ACCOUNT', 'The authenticated personal account changed. Reconnect before choosing a repository owner.');
    }
    return owner;
  }

  async list(session) {
    const personal = await this.identity(session);
    const owners = [{ ...personal, access: 'not-verified',
      message: `Signed-in user confirmed. ${permissionNote}` }];
    const seen = new Set([repositoryOwnerKey(personal)]);
    const sources = [];
    // Repository metadata can reveal an owner even when membership listing
    // omits it. Neither observation is permission to create a repository.
    for (const source of discoverySources) {
      const result = { kind: source.kind, label: source.label, status: 'complete', count: 0 };
      const discovered = new Set();
      try {
        for (let page = 1; page <= 5; page += 1) {
          const { data, link } = await this.read(session, `${source.path}&per_page=100&page=${page}`);
          if (!Array.isArray(data)) throw githubError(502, 'IMPORT_OWNER_LOOKUP_FAILED', 'GitHub returned an invalid owner discovery list.');
          for (const item of data) {
            const candidate = source.kind === 'membership'
              ? item?.state === 'active' ? item.organization : null
              : item?.owner;
            if (!candidate || candidate.type !== 'Organization') continue;
            const owner = repositoryOwner(candidate);
            const key = repositoryOwnerKey(owner);
            discovered.add(key);
            if (seen.has(key)) continue;
            seen.add(key);
            owners.push({
              ...owner, access: 'not-verified',
              ...(source.kind === 'membership' ? { membership: item.role === 'admin' ? 'admin' : 'member' } : {}),
              message: source.kind === 'membership'
                ? `Active membership confirmed. ${permissionNote}`
                : 'Visible through readable repositories. Membership and creation permissions are not confirmed.',
            });
          }
          if (!/rel="next"/.test(link || '')) break;
          if (page === 5) result.status = 'partial';
        }
        result.message = result.status === 'partial'
          ? 'The first 500 entries were checked. Check an organization handle if it is missing.'
          : source.kind === 'membership'
            ? 'Membership lookup finished; creation permissions are separate.'
            : 'Repository visibility was checked without requesting write access.';
      } catch (error) {
        if (error.status === 401 || error.code === 'GITHUB_SESSION_EXPIRED' || error.code === 'IMPORT_WRONG_ACCOUNT') throw error;
        result.status = error.status === 403 ? 'denied' : 'unavailable';
        const status = error.upstreamStatus || error.status;
        if (Number.isInteger(status) && status >= 400 && status <= 599) result.httpStatus = status;
        result.message = result.status === 'denied'
          ? source.kind === 'membership'
            ? 'GitHub denied membership lookup. Members read access, token approval or organization policy may apply.'
            : 'GitHub denied repository visibility. Check the resource owner, repository selection and token approval.'
          : `${source.label} could not be read. Retry this lookup; missing results are not proof of absent access.`;
      }
      result.count = discovered.size;
      sources.push(result);
    }
    const count = owners.length - 1;
    const complete = sources.every((source) => source.status === 'complete');
    const status = complete ? 'complete' : count || sources.some((source) => source.status === 'partial') ? 'partial'
      : sources.some((source) => source.status === 'denied') ? 'denied' : 'unavailable';
    const lookup = { status, sources, message: count
      ? `Found ${count} organization${count === 1 ? '' : 's'}. Visibility does not prove creation permissions.${complete ? '' : ' Some discovery checks are incomplete.'}`
      : complete
        ? 'No organizations were returned by the visibility checks. Check a known organization handle if one is missing.'
        : 'Organization visibility is incomplete; this does not mean the account has no organizations. Check a known organization handle.' };
    owners.sort((a, b) => (a.type === b.type ? a.login.localeCompare(b.login) : a.type === 'Organization' ? -1 : 1));
    const preferred = owners.find((owner) => owner.type === 'Organization') ||
      (lookup.status === 'complete' ? owners.find((owner) => owner.type === 'User') : null);
    return { owners, organizationLookup: lookup, defaultOwner: preferred ? repositoryOwner(preferred) : null };
  }

  async check(session, input) {
    const personal = await this.identity(session);
    const selected = repositoryOwner(input);
    if (selected.type === 'User') {
      if (!sameRepositoryOwner(selected, personal)) {
        throw githubError(403, 'IMPORT_WRONG_ACCOUNT', 'A Personal destination must be the authenticated account, not another user.');
      }
      return { ...personal, access: 'not-verified', message: `Signed-in user confirmed. ${permissionNote}` };
    }
    const { data: organization } = await this.read(session, `/orgs/${selected.login}`);
    const current = repositoryOwner(organization);
    if (!sameRepositoryOwner(selected, current)) {
      throw githubError(409, 'IMPORT_OWNER_CHANGED', 'The Organization identity changed. Refresh the owner list and choose again.');
    }
    const { data: membership } = await this.read(session, `/user/memberships/orgs/${current.login}`);
    if (membership?.state !== 'active' || membership.organization?.id !== current.id) {
      throw githubError(403, 'IMPORT_OWNER_ACCESS_DENIED', `Active membership in ${repositoryOwnerLabel(current)} was not confirmed.`);
    }
    const prohibited = membership.role !== 'admin' &&
      (organization.members_can_create_private_repositories === false ||
        organization.members_allowed_repository_creation_type === 'none' ||
        organization.members_allowed_repository_creation_type === 'public' ||
        organization.members_can_create_private_repositories === undefined &&
          organization.members_can_create_repositories === false);
    return {
      ...current, access: prohibited ? 'denied' : 'not-verified',
      message: prohibited
        ? `${repositoryOwnerLabel(current)} does not allow this member to create private repositories. Ask an organization owner to review its creation policy.`
        : `Organization ${membership.role === 'admin' ? 'owner' : 'member'} membership confirmed. ${permissionNote}`,
    };
  }

  async lookup(session, login) {
    await this.identity(session);
    const { data } = await this.read(session, `/orgs/${repositoryOwner({ type: 'Organization', id: 1, login }).login}`);
    const owner = repositoryOwner(data);
    if (owner.type !== 'Organization') throw githubError(502, 'IMPORT_OWNER_LOOKUP_FAILED', 'GitHub did not return an Organization profile.');
    return { ...owner, access: 'not-verified', message: 'Organization profile found. Membership and creation permissions are not confirmed.' };
  }
}
