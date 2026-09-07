import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { MigrationGitHubConnection } from '../web/js/migration-github-connection.mjs';
import { MIGRATION_SOURCE_HEADER } from '../shared/migration-github-auth.mjs';
import { migrationHarness, TARGET } from './_migration-fixture.mjs';
import { PublicGitHubMock, PUBLIC_FILE, PUBLIC_REPO } from './_migration-public-fixture.mjs';

/** Runtime-generated fake credentials are used only inside the mocked transport. */
export class AuthenticatedGitHubMock extends PublicGitHubMock {
  constructor() {
    super();
    this.repository.private = true;
    this.repository.visibility = 'private';
    this.repository.permissions = { pull: true, push: false, admin: false };
    this.credentials = new Map();
    this.authCalls = [];
    const read = this.fetch;
    this.fetch = async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      const header = options.headers.Authorization;
      const credential = this.credentials.get(typeof header === 'string' ? header.replace(/^Bearer /, '') : '');
      const target = new URL(url);
      this.authCalls.push({ path: target.pathname, method: options.method, authenticated: Boolean(header) });
      if (!credential || credential.revoked) return this.json(401, { message: 'SYNTHETIC_UPSTREAM_PRIVATE_DETAIL' });
      if (target.pathname === '/user') {
        await this.beforeIdentity?.();
        return this.json(200, credential.identity);
      }
      if (!credential.contentsRead && target.pathname.includes('/git/')) {
        return this.json(403, { message: 'SYNTHETIC_UPSTREAM_PRIVATE_DETAIL' });
      }
      const headers = { ...options.headers };
      delete headers.Authorization;
      return read(url, { ...options, headers });
    };
  }

  credential({ id = 4001, login = 'synthetic-reader', contentsRead = true } = {}) {
    const token = `github_pat_${randomBytes(24).toString('hex')}`;
    this.credentials.set(token, { identity: { id, login, type: 'User' }, contentsRead, revoked: false });
    return token;
  }
}

export function authenticatedHarness(options = {}) {
  const local = migrationHarness(options.local || {});
  const github = options.github || new AuthenticatedGitHubMock();
  const token = github.credential();
  const destinationToken = github.credential();
  const clock = { now: Date.now() };
  const sessions = new GitHubSessionStore({ now: () => clock.now });
  const destination = sessions.create(destinationToken, { id: 4001, login: 'synthetic-reader', type: 'User' }, { profileId: 'existing-connection' });
  const profileData = new Map([['existing-connection', {
    id: 'existing-connection', name: 'Existing connection', accountId: 4001,
    accountLogin: 'synthetic-reader', credentialMode: 'session', updatedAt: 'synthetic-original',
  }]]);
  const profiles = {
    get: async (id) => structuredClone(profileData.get(id) || null),
    list: async () => [...profileData.values()].map((profile) => structuredClone(profile)),
  };
  const vaultReads = [];
  const vaultWrites = [];
  const persisted = new Map();
  const vault = {
    available: true,
    status: () => ({ available: true }),
    has: async (id) => persisted.has(id),
    load: async (id) => { vaultReads.push(id); return persisted.get(id) || null; },
    store: async () => { vaultWrites.push('store'); throw new Error('Migration must not persist credentials'); },
    remove: async () => { vaultWrites.push('remove'); throw new Error('Migration must not change saved credentials'); },
  };
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: github.fetch }), sessions, profiles, vault,
    migrationSourceOptions: {
      sessionOptions: { now: () => clock.now, ...(options.sessionOptions || {}) },
      readerOptions: { now: () => clock.now },
    },
  });
  const localCalls = [];
  const mintedIds = [];
  const hooks = {};
  const request = async (input, init = {}) => {
    const url = new URL(input, 'http://migration-source.test');
    const method = init.method || 'GET';
    localCalls.push({ path: `${url.pathname}${url.search}`, method, sourceHeaderPresent: Boolean(init.headers?.[MIGRATION_SOURCE_HEADER]) });
    if (method === 'DELETE' && hooks.failErase) throw new Error('Synthetic erasure transport failure');
    const result = await routes.handle({
      req: { method, headers: Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value])) },
      url, parts: url.pathname.split('/').filter(Boolean),
      readBody: async () => JSON.parse(init.body || '{}'),
    });
    if (method === 'POST' && url.pathname.endsWith('/session')) {
      mintedIds.push(result.sessionId);
      await hooks.connected?.(result);
    }
    if (method === 'DELETE') await hooks.erased?.();
    return result;
  };
  const connection = new MigrationGitHubConnection({ request });
  let donor;
  return {
    ...local, github, token, destinationToken, destination, sessions, profileData, persisted,
    vaultReads, vaultWrites, routes, request, localCalls, mintedIds, connection, clock, hooks,
    selectDonor(selection = {}) {
      donor = connection.createDonor({ repository: PUBLIC_REPO, refType: 'branch', ref: 'legacy-main', ...selection });
      return donor;
    },
    plan(extra = {}) {
      donor ||= connection.createDonor({ repository: PUBLIC_REPO, refType: 'branch', ref: 'legacy-main' });
      return local.session.plan({ donor, sourceIds: [PUBLIC_FILE], targetAlias: TARGET, ...extra });
    },
  };
}
