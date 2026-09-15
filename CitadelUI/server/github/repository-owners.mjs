import { githubError } from './api.mjs';
import { repositoryOwner, repositoryOwnerKey, repositoryOwnerLabel, sameRepositoryOwner } from '../../shared/repository-owner.mjs';

const permissionNote = 'Creation is not proven by membership alone. The selected resource owner, repository Administration and Contents permissions, and organization or enterprise policies still apply.';

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
        action: path === '/user' ? 'verify the signed-in Personal account' : path.startsWith('/user/memberships/')
          ? 'verify Organization membership' : 'read Organization access policy' };
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
      message: `${repositoryOwnerLabel(personal)} is authenticated. ${permissionNote}` }];
    const seen = new Set([repositoryOwnerKey(personal)]);
    let lookup = { status: 'complete', message: 'Organizations visible to this connection are listed below.' };
    // /user/orgs returns an empty list for fine-grained tokens; membership is
    // the authenticated endpoint that can actually discover these owners.
    try {
      for (let page = 1; page <= 5; page += 1) {
        const { data, link } = await this.read(session, `/user/memberships/orgs?state=active&per_page=100&page=${page}`);
        if (!Array.isArray(data)) throw githubError(502, 'IMPORT_OWNER_LOOKUP_FAILED', 'GitHub returned an invalid organization membership list.');
        for (const membership of data) {
          if (membership.state !== 'active') continue;
          const owner = repositoryOwner({ ...membership.organization, type: 'Organization' });
          const key = repositoryOwnerKey(owner);
          if (seen.has(key)) continue;
          seen.add(key);
          owners.push({ ...owner, access: 'not-verified', membership: membership.role === 'admin' ? 'admin' : 'member',
            message: `Active membership confirmed for ${repositoryOwnerLabel(owner)}. ${permissionNote}` });
        }
        if (!/rel="next"/.test(link || '')) break;
        if (page === 5) lookup = {
          status: 'partial', message: 'The organization list reached its safety limit. Choose a listed owner or use an explicit organization lookup.',
        };
      }
    } catch (error) {
      if (error.status === 401 || error.code === 'GITHUB_SESSION_EXPIRED' || error.code === 'IMPORT_WRONG_ACCOUNT') throw error;
      lookup = {
        status: error.status === 403 ? 'denied' : 'unavailable',
        message: error.status === 403
          ? 'GitHub denied organization discovery. Check Organization Members: read access and the token resource owner. This does not mean the account has no organizations.'
          : 'Organization discovery could not finish. Retry or check an explicit organization handle; no absence of organizations is assumed.',
      };
    }
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
      return { ...personal, access: 'not-verified', message: `${repositoryOwnerLabel(personal)} is authenticated. ${permissionNote}` };
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
        : `Active ${membership.role === 'admin' ? 'owner' : 'member'} access confirmed for ${repositoryOwnerLabel(current)}. ${permissionNote}`,
    };
  }

  async lookup(session, login) {
    const { data } = await this.read(session, `/orgs/${repositoryOwner({ type: 'Organization', id: 1, login }).login}`);
    return this.check(session, repositoryOwner(data));
  }
}
