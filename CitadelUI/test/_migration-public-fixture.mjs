import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { PublicGitHubMigrationDonor } from '../web/js/migration-public-donor.mjs';
import { migrationHarness, TARGET } from './_migration-fixture.mjs';

const hash = (text) => createHash('sha1').update(text).digest('hex');
export const PUBLIC_MAIN_SAMPLE = Object.freeze({
  repository: 'mohamedsaif/ai-hub-gateway-solution-accelerator',
  branch: 'main',
  commit: '9ef37ad75a47ca89c179a0db5a4123e60c4c720e',
});
export const PUBLIC_REPO = 'synthetic/older-configuration';
export const PUBLIC_FILE = 'legacy/main.bicepparam';
export const PUBLIC_TEMPLATE = 'legacy/main.bicep';
export const PUBLIC_TEXT = "using './main.bicep'\nparam count = 4\nparam retired = 'legacy-only'\n";
export const PUBLIC_SCHEMA = 'param count int\nparam retired string\n';
export const armParameters = (parameters) => JSON.stringify({
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
  contentVersion: '1.0.0.0',
  parameters,
});

/**
 * Public GitHub API responses only. Actual fetch headers are asserted before
 * any response is returned; no token, credential adapter, or live egress exists.
 */
export class PublicGitHubMock {
  constructor() {
    this.repository = { id: 8001, full_name: PUBLIC_REPO, private: false, visibility: 'public', default_branch: 'legacy-main' };
    this.refs = new Map();
    this.commits = new Map();
    this.trees = new Map();
    this.blobs = new Map();
    this.tags = new Map();
    this.calls = [];
    this.overrides = new Map();
    this.serial = 0;
    this.seed('legacy-main', { [PUBLIC_FILE]: PUBLIC_TEXT, [PUBLIC_TEMPLATE]: PUBLIC_SCHEMA });
  }

  seed(ref, files, options = {}) {
    const entries = Object.entries(files).map(([path, value]) => {
      const spec = typeof value === 'string' ? { text: value } : value;
      const bytes = Buffer.from(spec.text);
      const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      this.blobs.set(sha, { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
      return { path, type: spec.type || 'blob', mode: spec.mode || '100644', sha, size: spec.size ?? bytes.length };
    });
    const treeSha = hash(`tree:${JSON.stringify(entries)}`);
    this.trees.set(treeSha, { sha: treeSha, tree: entries, truncated: false });
    const commit = hash(`commit:${treeSha}:${++this.serial}`);
    this.commits.set(commit, { sha: commit, tree: { sha: treeSha } });
    const namespace = options.tag ? 'tags' : 'heads';
    let object = { type: 'commit', sha: commit };
    if (options.annotated) {
      const sha = hash(`tag:${ref}:${commit}`);
      this.tags.set(sha, { sha, object });
      object = { type: 'tag', sha };
    }
    this.refs.set(`${namespace}/${ref}`, { ref: `refs/${namespace}/${ref}`, object });
    return { commit, treeSha, refSha: object.sha };
  }

  json(status, body, headers = {}) {
    const text = JSON.stringify(body);
    return new Response(text, {
      status,
      headers: {
        'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)),
        'x-ratelimit-remaining': '50', ...headers,
      },
    });
  }

  fetch = async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.github.com', 'public donor egress must use the fixed GitHub API host');
    assert.equal(init.method, 'GET', 'public donors must never mutate GitHub');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    assert.equal(Object.keys(init.headers).some((key) => /authorization|cookie|citadel/i.test(key)), false);
    const path = decodeURIComponent(target.pathname);
    this.calls.push({ path: `${target.pathname}${target.search}`, method: init.method, headers: { ...init.headers } });
    const override = this.overrides.get(path);
    if (override) return override(this, target);
    const prefix = `/repos/${this.repository.full_name}`;
    if (path === prefix || path === `/repositories/${this.repository.id}`) return this.json(200, this.repository);
    let data;
    if (path.startsWith(`${prefix}/git/ref/`)) data = this.refs.get(path.slice(`${prefix}/git/ref/`.length));
    else if (path.startsWith(`${prefix}/git/commits/`)) data = this.commits.get(path.slice(`${prefix}/git/commits/`.length));
    else if (path.startsWith(`${prefix}/git/trees/`)) data = this.trees.get(path.slice(`${prefix}/git/trees/`.length));
    else if (path.startsWith(`${prefix}/git/blobs/`)) data = this.blobs.get(path.slice(`${prefix}/git/blobs/`.length));
    else if (path.startsWith(`${prefix}/git/tags/`)) data = this.tags.get(path.slice(`${prefix}/git/tags/`.length));
    return data ? this.json(200, data) : this.json(404, { message: 'SYNTHETIC_UPSTREAM_CONTENT_MUST_NOT_ESCAPE' });
  };
}

export function publicHarness(options = {}) {
  const local = migrationHarness(options.local || {});
  const github = options.github || new PublicGitHubMock();
  const forbidden = new Proxy({}, { get() { throw new Error('Public donor touched a credential/session/registry service'); } });
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: github.fetch }),
    sessions: forbidden, profiles: forbidden, vault: forbidden, registryStore: forbidden, activity: forbidden,
    publicDonorOptions: options.routes || {},
  });
  const calls = [];
  const request = async (path, init = {}) => {
    calls.push({ path, method: init.method || 'GET', headers: init.headers || {} });
    const url = new URL(path, 'http://public-donor.test');
    return routes.handle({
      req: { method: init.method || 'GET', headers: { 'x-citadel-github-session': 'unused-synthetic-session' } },
      url, parts: url.pathname.split('/').filter(Boolean),
      readBody: async () => { throw new Error('A public donor must not read a mutation body'); },
    });
  };
  const donor = new PublicGitHubMigrationDonor({
    repository: options.repository || `https://github.com/${PUBLIC_REPO}`,
    refType: options.refType || 'branch', ref: options.ref || 'legacy-main', request,
  });
  return {
    ...local, github, routes, request, publicCalls: calls, donor,
    plan: (extra = {}) => local.session.plan({ donor, sourceIds: [PUBLIC_FILE], targetAlias: TARGET, ...extra }),
  };
}
