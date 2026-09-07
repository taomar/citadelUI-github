import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createCitadelServer } from '../server/index.mjs';
import { GitHubApiClient } from '../server/github/api.mjs';
import { RepositoryCreationService } from '../server/github/repository-creation.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { ImportGitHub } from './_repository-import-mock.mjs';

/** Real app HTTP and transport over repository-bound, byte-exact mocked GitHub. */
export async function repositoryHttpFixture(options = {}) {
  const ownsData = !options.dataRoot;
  const dataRoot = options.dataRoot || await mkdtemp(join(tmpdir(), 'citadel-repository-http-'));
  const github = new ImportGitHub({ files: options.files, bootstrapBranch: options.bootstrapBranch || 'main' });
  if (options.sourceFullName) {
    github.repos.delete(github.source.full_name.toLowerCase());
    github.source.full_name = options.sourceFullName;
    github.source.name = options.sourceFullName.split('/')[1];
    github.source.owner.login = options.sourceFullName.split('/')[0];
    github.repos.set(options.sourceFullName.toLowerCase(), github.source);
  }
  const unexpected = [];
  const metadata = (repo) => ({
    ...github.metadata(repo),
    permissions: { push: repo.owner.id === github.identity.id, admin: repo.owner.id === github.identity.id },
  });
  const client = new GitHubApiClient({
    fetch: async (href, init) => {
      const url = new URL(href);
      if (url.origin !== 'https://api.github.com') throw new Error('Unexpected fixture egress');
      const token = init.headers.Authorization?.replace(/^Bearer /, '');
      if (!token) return new Response('{"message":"Bad credentials"}', { status: 401 });
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      try {
        let result;
        const byId = /^\/repositories\/(\d+)$/.exec(url.pathname);
        const branches = /^\/repos\/([^/]+\/[^/]+)\/branches$/.exec(url.pathname);
        const history = /^\/repos\/([^/]+\/[^/]+)\/commits$/.exec(url.pathname);
        if (init.method === 'GET' && url.pathname === '/user/repos') {
          github.calls.push({ method: 'GET', path: url.pathname + url.search });
          result = { status: 200, data: Number(url.searchParams.get('page') || 1) === 1
            ? [...github.repos.values()].filter((repo) => repo.owner.id === github.identity.id).map(metadata)
            : [] };
        } else if (init.method === 'GET' && byId) {
          github.calls.push({ method: 'GET', path: url.pathname });
          const repo = [...github.repos.values()].find((item) => item.id === Number(byId[1]));
          if (!repo) return new Response('{"message":"Not found"}', { status: 404 });
          result = { status: 200, data: metadata(repo) };
        } else if (init.method === 'GET' && branches) {
          github.calls.push({ method: 'GET', path: url.pathname + url.search });
          const repo = github.repos.get(branches[1].toLowerCase());
          if (!repo) return new Response('{"message":"Not found"}', { status: 404 });
          result = { status: 200, data: [...repo.refs].map(([name, commit]) => ({ name, commit: { sha: commit }, protected: false })) };
        } else if (init.method === 'GET' && history) {
          github.calls.push({ method: 'GET', path: url.pathname + url.search });
          const repo = github.repos.get(history[1].toLowerCase());
          if (!repo) return new Response('{"message":"Not found"}', { status: 404 });
          const ref = url.searchParams.get('sha') || repo.default_branch;
          const queue = [repo.refs.get(ref) || ref];
          const seen = new Set();
          const commits = [];
          while (queue.length) {
            const sha = queue.shift();
            if (seen.has(sha)) continue;
            seen.add(sha);
            const commit = repo.commits.get(sha);
            if (!commit) return new Response('{"message":"Not found"}', { status: 404 });
            commits.push({ sha, commit: { message: commit.message, author: commit.author, committer: commit.committer }, parents: commit.parents });
            queue.push(...commit.parents.map((parent) => parent.sha));
          }
          const page = Number(url.searchParams.get('page') || 1);
          const perPage = Number(url.searchParams.get('per_page') || 100);
          result = { status: 200, data: commits.slice((page - 1) * perPage, page * perPage) };
          if (commits.length > page * perPage) result.link = '<https://api.github.com/next>; rel="next"';
        } else {
          result = await github.request(url.pathname + url.search, { method: init.method, body, token });
        }
        return new Response(result.data == null ? null : JSON.stringify(result.data), {
          status: result.status,
          headers: { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '4000', ...(result.link ? { Link: result.link } : {}) },
        });
      } catch (error) {
        if (!Number.isInteger(error.status)) {
          unexpected.push(error.message);
          throw error;
        }
        return new Response(JSON.stringify({ message: error.message }), { status: error.status });
      }
    },
  });
  const sessions = new GitHubSessionStore(options.sessionOptions);
  const creations = new RepositoryCreationService({
    dataRoot, client,
    validateSession: (session) => sessions.assertActive(session),
    now: options.now, wait: options.wait,
    limits: { writeIntervalMs: 0, ...options.limits },
  });
  const allowedHost = `127.0.0.1:${options.port || 43184}`;
  const app = await createCitadelServer({
    dataRoot,
    allowedHost,
    allowedOrigin: `http://${allowedHost}`,
    testRuntime: true,
    registryNamespace: `citadel-repository-fixture-${randomUUID()}`,
    credentialKeyFile: null,
    githubOptions: { client, creations, sessions },
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(options.port || 0, '127.0.0.1', resolve);
  });
  const call = (path, { method = 'GET', body, githubSession } = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({
      hostname: '127.0.0.1', port: app.server.address().port, path, method, agent: false,
      headers: {
        Host: allowedHost, 'Sec-Fetch-Site': 'same-origin', 'X-Citadel-Session': app.sessionToken,
        Connection: 'close',
        ...(githubSession ? { 'X-Citadel-GitHub-Session': githubSession } : {}),
        ...(method !== 'GET' ? { Origin: `http://${allowedHost}`, 'Content-Type': 'application/json' } : {}),
        ...(bytes ? { 'Content-Length': bytes.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.setTimeout(15_000, () => req.destroy(new Error(`Fixture HTTP timeout: ${method} ${path}`)));
    req.on('error', reject);
    if (bytes) req.write(bytes);
    req.end();
  });
  return {
    ...app, creations, github, unexpected, dataRoot, call,
    async close() {
      creations.shutdown();
      try {
        await creations.settled();
      } finally {
        await new Promise((resolve) => app.server.close(resolve));
        await app.activityStore.settled();
        if (ownsData) await rm(dataRoot, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  };
}
