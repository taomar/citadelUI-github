import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubApiClient } from '../server/github/api.mjs';
import { createCitadelServer } from '../server/index.mjs';
import { LocalSourceImportService } from '../server/github/local-import.mjs';
import { DEFAULT_REPOSITORY_SOURCE, parseRepositorySource } from '../shared/repository-source.mjs';
import { ImportGitHub } from './_repository-import-mock.mjs';

export function publicSourceFixture(options = {}) {
  const github = new ImportGitHub({ files: options.files });
  const fullName = parseRepositorySource(DEFAULT_REPOSITORY_SOURCE).fullName;
  github.repos.delete(github.source.full_name.toLowerCase());
  github.source.full_name = fullName;
  github.source.name = fullName.split('/')[1];
  github.repos.set(fullName.toLowerCase(), github.source);
  const calls = [];
  const fixture = { github, calls, before: null, after: null, unavailable: false };
  const client = new GitHubApiClient({
    timeoutMs: options.requestTimeoutMs,
    fetch: async (href, init) => {
      assert.equal(init.method, 'GET', 'a local import must never write GitHub');
      assert.equal(init.body, undefined);
      assert.equal(init.headers.Authorization, undefined, 'public reads must not borrow an editable credential');
      assert.equal(init.redirect, 'manual');
      const url = new URL(href);
      const call = { host: url.host, path: url.pathname + url.search };
      calls.push(call);
      const overridden = await fixture.before?.(call, fixture, init);
      if (overridden) return overridden;
      if (fixture.unavailable) throw new Error('fixture offline');
      let response;
      if (url.origin === 'https://api.github.com') {
        assert(url.pathname.startsWith(`/repos/${fullName}`));
        try {
          const data = github.dispatch(url.pathname + url.search, 'GET');
          response = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        } catch (error) {
          if (!error.status) throw error;
          response = new Response(null, { status: error.status });
        }
      } else {
        assert.equal(url.origin, 'https://raw.githubusercontent.com');
        const prefix = `/${fullName}/`;
        assert(url.pathname.startsWith(prefix));
        const parts = url.pathname.slice(prefix.length).split('/');
        const commit = parts.shift();
        assert.match(commit, /^[0-9a-f]{40}$/);
        const path = parts.map(decodeURIComponent).join('/');
        const root = github.source.commits.get(commit)?.tree.sha;
        const entry = root && github.flatten(github.source, root).find((item) => item.path === path);
        const bytes = entry && github.source.blobs.get(entry.sha);
        response = bytes ? new Response(bytes) : new Response(null, { status: 404 });
      }
      return await fixture.after?.(call, response, fixture) || response;
    },
  });
  fixture.client = client;
  fixture.service = new LocalSourceImportService({ client, ...(options.serviceOptions || {}) });
  fixture.prepare = async () => {
    const operation = fixture.service.prepare({ sourceUrl: DEFAULT_REPOSITORY_SOURCE, operationKey: randomUUID() });
    await fixture.service.settled();
    return fixture.service.public(fixture.service.find(operation.id));
  };
  return fixture;
}

export async function localSourceHttpFixture(options = {}) {
  const fixture = publicSourceFixture(options);
  const ownsData = !options.dataRoot;
  const dataRoot = options.dataRoot || await mkdtemp(join(tmpdir(), 'citadel-local-source-'));
  const host = `127.0.0.1:${options.port || 43185}`;
  const app = await createCitadelServer({
    dataRoot, allowedHost: host, allowedOrigin: `http://${host}`,
    testRuntime: true, registryNamespace: `local-source-fixture-${randomUUID()}`, credentialKeyFile: null,
    githubOptions: { client: fixture.client, localImportOptions: options.serviceOptions },
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(options.port || 0, '127.0.0.1', resolve);
  });
  const call = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({
      hostname: '127.0.0.1', port: app.server.address().port, path, method, agent: false,
      headers: {
        Host: host, 'Sec-Fetch-Site': 'same-origin', 'X-Citadel-Session': app.sessionToken, Connection: 'close',
        ...(method !== 'GET' ? { Origin: `http://${host}`, 'Content-Type': 'application/json' } : {}),
        ...(bytes ? { 'Content-Length': bytes.length } : {}), ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.setTimeout(15_000, () => req.destroy(new Error('Local source fixture timeout')));
    req.on('error', reject);
    if (bytes) req.write(bytes);
    req.end();
  });
  return {
    ...fixture, ...app, call, dataRoot, service: app.githubRoutes.localImports,
    async close() {
      app.githubRoutes.localImports.shutdown();
      await app.githubRoutes.localImports.settled();
      await new Promise((resolve) => app.server.close(resolve));
      await app.activityStore.settled();
      if (ownsData) await rm(dataRoot, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
