// Importer-only Git model: real Git object hashes, isolated per-repository
// object stores, initialized-repository ref rules, and non-force fast forwards.
// No network, GitHub credentials, or shared/global object pool.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { githubError } from '../server/github/api.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';

export const IMPORT_SESSION = Object.freeze({
  token: 'fixture-credential-not-a-real-token', accountId: 101, login: 'fixture-owner',
  profileId: '00000000-0000-4000-8000-000000000101',
});
export const SOURCE_URL = 'https://github.com/fixture-upstream/source/tree/citadel-v1';

export function gitHash(type, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return createHash('sha1').update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest('hex');
}

function gitTree(entries) {
  const ordered = [...entries].sort((a, b) => {
    const left = Buffer.from(a.path + (a.type === 'tree' ? '/' : ''));
    const right = Buffer.from(b.path + (b.type === 'tree' ? '/' : ''));
    return Buffer.compare(left, right);
  });
  return gitHash('tree', Buffer.concat(ordered.flatMap((entry) => [
    Buffer.from(`${entry.mode === '040000' ? '40000' : entry.mode} ${entry.path}\0`),
    Buffer.from(entry.sha, 'hex'),
  ])));
}

const error = (status) => githubError(status, 'GITHUB_REQUEST_FAILED', 'Fixture GitHub request failed.');
const clone = (value) => value == null ? value : structuredClone(value);

export class ImportGitHub {
  constructor({ files = citadelRepositoryFiles(), defaultBranch = 'main', bootstrapBranch = 'main' } = {}) {
    this.calls = [];
    this.repos = new Map();
    this.nextId = 1000;
    this.identity = { id: 101, login: 'fixture-owner', type: 'User' };
    this.bootstrapBranch = bootstrapBranch;
    this.before = null;
    this.after = null;
    this.recursiveTruncated = false;
    this.nonrecursiveTruncated = false;
    this.renameDelay = 0;
    this.pendingRenames = [];
    this.source = this.repository('fixture-upstream/source', { default_branch: defaultBranch, owner: { id: 202, type: 'User' }, private: false });
    this.seed(this.source, 'main', citadelRepositoryFiles({ 'branch.txt': 'WRONG main snapshot\n' }));
    this.sourceHead = this.seed(this.source, 'citadel-v1', files);
  }

  repository(fullName, extra = {}) {
    const repository = {
      id: this.nextId++, full_name: fullName, name: fullName.split('/')[1],
      private: true, default_branch: 'main', description: '',
      owner: { id: 101, type: 'User', login: 'fixture-owner' },
      fork: false, archived: false, disabled: false,
      actionsEnabled: true, blobs: new Map(), trees: new Map(), commits: new Map(), refs: new Map(),
      ...extra,
    };
    this.repos.set(fullName.toLowerCase(), repository);
    return repository;
  }

  metadata(repo) {
    const { blobs, trees, commits, refs, actionsEnabled, ...record } = repo;
    return clone(record);
  }

  blob(repo, bytes) {
    const content = Buffer.from(bytes);
    const sha = gitHash('blob', content);
    repo.blobs.set(sha, content);
    return sha;
  }

  tree(repo, entries) {
    const sha = gitTree(entries);
    repo.trees.set(sha, clone(entries));
    return sha;
  }

  commit(repo, body) {
    assert(repo.trees.has(body.tree), 'commit tree must exist IN destination repository');
    for (const parent of body.parents) assert(repo.commits.has(parent), 'parent must exist in destination');
    const person = (item) => `${item.name} <${item.email}> ${Math.floor(Date.parse(item.date) / 1000)} +0000`;
    const author = body.author || { name: 'Fixture', email: 'fixture@example.invalid', date: '2026-01-01T00:00:00Z' };
    const committer = body.committer || author;
    const raw = [
      `tree ${body.tree}`, ...body.parents.map((parent) => `parent ${parent}`),
      `author ${person(author)}`, `committer ${person(committer)}`, '', body.message,
    ].join('\n');
    const sha = gitHash('commit', raw);
    repo.commits.set(sha, {
      sha, tree: { sha: body.tree }, parents: body.parents.map((parent) => ({ sha: parent })),
      author, committer, message: body.message,
    });
    return sha;
  }

  seed(repo, branch, files, parents = []) {
    const directories = new Map([['', []]]);
    for (const [path, value] of Object.entries(files)) {
      const record = Buffer.isBuffer(value) || typeof value === 'string' ? { content: value } : value;
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const prefix = parts.slice(0, i).join('/');
        if (!directories.has(prefix)) directories.set(prefix, []);
      }
      const mode = record.mode || '100644';
      const bytes = Buffer.from(record.content);
      const sha = this.blob(repo, bytes);
      directories.get(parts.slice(0, -1).join('/')).push({
        path: parts.at(-1), type: mode === '160000' ? 'commit' : 'blob', mode, sha, size: bytes.length,
      });
    }
    const ordered = [...directories.keys()].sort((a, b) => b.length - a.length);
    let root;
    for (const path of ordered) {
      const sha = this.tree(repo, directories.get(path));
      if (!path) root = sha;
      else {
        const parts = path.split('/');
        directories.get(parts.slice(0, -1).join('/')).push({ path: parts.at(-1), type: 'tree', mode: '040000', sha });
      }
    }
    const sha = this.commit(repo, { tree: root, parents, message: `Fixture ${branch}` });
    repo.refs.set(branch, sha);
    return sha;
  }

  flatten(repo, root, prefix = '') {
    const tree = repo.trees.get(root);
    if (!tree) throw error(404);
    return tree.flatMap((entry) => {
      const item = { ...entry, path: prefix + entry.path };
      return entry.type === 'tree' ? [item, ...this.flatten(repo, entry.sha, `${item.path}/`)] : [item];
    });
  }

  snapshot(repo, branch = 'main') {
    const commit = repo.commits.get(repo.refs.get(branch));
    if (!commit) return null;
    return this.flatten(repo, commit.tree.sha).filter((entry) => entry.type !== 'tree').map((entry) => ({
      path: entry.path, mode: entry.mode, sha: entry.sha, bytes: repo.blobs.get(entry.sha),
    })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  descendant(repo, candidate, ancestor) {
    if (candidate === ancestor) return true;
    const commit = repo.commits.get(candidate);
    return Boolean(commit?.parents.some((parent) => this.descendant(repo, parent.sha, ancestor)));
  }

  async request(path, options = {}) {
    const method = options.method || 'GET';
    const call = { path, method, body: clone(options.body) };
    this.calls.push(call);
    assert(options.token, 'every request requires a live session credential');
    assert(path.startsWith('/') && !path.startsWith('//'), 'relative fixed-host API only');
    if (method === 'GET') {
      for (const pending of [...this.pendingRenames]) {
        pending.remaining -= 1;
        if (pending.remaining <= 0) {
          this.rename(pending.repo, pending.from, pending.to);
          this.pendingRenames.splice(this.pendingRenames.indexOf(pending), 1);
        }
      }
    }
    if (this.before) await this.before(call, this);
    const data = this.dispatch(path, method, options.body);
    const response = { status: method === 'POST' ? 201 : 200, data: clone(data), rate: { remaining: 4000, reset: 0 } };
    if (this.after) await this.after(call, response, this);
    return response;
  }

  rename(repo, from, to) {
    if (!repo.refs.has(from)) throw error(404);
    if (repo.refs.has(to)) throw error(422);
    const head = repo.refs.get(from);
    repo.refs.set(to, head);
    repo.refs.delete(from);
    if (repo.default_branch === from) repo.default_branch = to;
    return { name: to, commit: { sha: head } };
  }

  dispatch(path, method, body) {
    if (path === '/user' && method === 'GET') return this.identity;
    if (path === '/user/repos' && method === 'POST') {
      assert.deepEqual(Object.keys(body).sort(), ['auto_init', 'description', 'name', 'private']);
      assert.equal(body.private, true);
      assert.equal(body.auto_init, true);
      assert.match(body.description, /^Citadel full snapshot operation [0-9a-f-]{36}$/);
      const name = `${this.identity.login}/${body.name}`;
      if (this.repos.has(name.toLowerCase())) throw error(422);
      const repo = this.repository(name, { description: body.description, default_branch: this.bootstrapBranch });
      this.seed(repo, this.bootstrapBranch, { 'README.md': `# ${body.name}\n${body.description}\n` });
      return this.metadata(repo);
    }
    const match = /^\/repos\/([^/]+\/[^/?]+)(.*)$/.exec(path);
    assert(match, `Unexpected endpoint ${method} ${path}`);
    const repo = this.repos.get(match[1].toLowerCase());
    if (!repo) throw error(404);
    const suffix = match[2];
    if (!suffix && method === 'GET') return this.metadata(repo);
    if (!suffix && method === 'PATCH') {
      assert.deepEqual(Object.keys(body), ['default_branch']);
      assert(repo.refs.has(body.default_branch), 'default branch must exist');
      repo.default_branch = body.default_branch;
      return this.metadata(repo);
    }
    if (suffix === '/actions/permissions') {
      if (method === 'GET') return { enabled: repo.actionsEnabled };
      assert.equal(method, 'PUT');
      assert.deepEqual(body, { enabled: false });
      repo.actionsEnabled = false;
      return null;
    }
    const rename = /^\/branches\/(.+)\/rename$/.exec(suffix);
    if (rename && method === 'POST') {
      assert.deepEqual(body, { new_name: 'main' });
      const from = decodeURIComponent(rename[1]);
      if (!repo.refs.has(from)) throw error(404);
      if (repo.refs.has(body.new_name)) throw error(422);
      if (this.renameDelay > 0) {
        if (!this.pendingRenames.some((pending) => pending.repo === repo)) {
          this.pendingRenames.push({ repo, from, to: body.new_name, remaining: this.renameDelay });
        }
        return { name: body.new_name, commit: { sha: repo.refs.get(from) } };
      }
      return this.rename(repo, from, body.new_name);
    }
    if (suffix.startsWith('/commits/') && method === 'GET') {
      const name = decodeURIComponent(suffix.slice('/commits/'.length));
      const commit = repo.commits.get(repo.refs.get(name) || name);
      if (!commit) throw error(404);
      return { sha: commit.sha, commit: { tree: commit.tree } };
    }
    if (suffix.startsWith('/git/commits/') && method === 'GET') {
      const commit = repo.commits.get(suffix.slice('/git/commits/'.length));
      if (!commit) throw error(404);
      return commit;
    }
    if (suffix === '/git/commits' && method === 'POST') {
      assert.deepEqual(Object.keys(body).sort(), ['author', 'committer', 'message', 'parents', 'tree']);
      return repo.commits.get(this.commit(repo, body));
    }
    if (suffix.startsWith('/git/blobs/') && method === 'GET') {
      const sha = suffix.slice('/git/blobs/'.length);
      const bytes = repo.blobs.get(sha);
      if (!bytes) throw error(404);
      return { sha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') };
    }
    if (suffix === '/git/blobs' && method === 'POST') {
      assert.deepEqual(Object.keys(body).sort(), ['content', 'encoding']);
      assert.equal(body.encoding, 'base64');
      return { sha: this.blob(repo, Buffer.from(body.content, 'base64')) };
    }
    if (suffix.startsWith('/git/trees/') && method === 'GET') {
      const [sha, query] = suffix.slice('/git/trees/'.length).split('?');
      if (!repo.trees.has(sha)) throw error(404);
      const recursive = query === 'recursive=1';
      const truncated = repo === this.source && (recursive ? this.recursiveTruncated : this.nonrecursiveTruncated);
      const entries = recursive ? this.flatten(repo, sha) : repo.trees.get(sha);
      return { sha, truncated, tree: truncated ? entries.slice(0, 1) : entries };
    }
    if (suffix === '/git/trees' && method === 'POST') {
      assert.deepEqual(Object.keys(body), ['tree'], 'never overlay a bootstrap base_tree');
      const entries = body.tree.map((entry) => {
        assert(!entry.path.includes('/'), 'bottom-up trees use immediate paths');
        assert(!(entry.sha && Object.hasOwn(entry, 'content')), 'content or SHA, never both');
        if (Object.hasOwn(entry, 'content')) {
          assert.equal(entry.type, 'blob');
          assert.equal(typeof entry.content, 'string');
          const bytes = Buffer.from(entry.content, 'utf8');
          return { path: entry.path, mode: entry.mode, type: 'blob', sha: this.blob(repo, bytes), size: bytes.length };
        }
        if (entry.type === 'tree') {
          assert(repo.trees.has(entry.sha), 'child tree must exist IN destination');
          return { ...entry };
        }
        assert(repo.blobs.has(entry.sha), 'blob must exist IN destination, not source');
        return { ...entry, size: repo.blobs.get(entry.sha).length };
      });
      return { sha: this.tree(repo, entries) };
    }
    if (suffix.startsWith('/git/ref/heads/') && method === 'GET') {
      const branch = decodeURIComponent(suffix.slice('/git/ref/heads/'.length));
      const sha = repo.refs.get(branch);
      if (!sha) throw error(404);
      return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } };
    }
    if (suffix === '/git/refs' && method === 'POST') {
      assert.deepEqual(Object.keys(body).sort(), ['ref', 'sha']);
      assert(repo.refs.size > 0, 'GitHub refuses creating refs in an empty repository');
      assert(repo.commits.has(body.sha), 'referenced commit must exist in destination');
      const branch = body.ref.slice('refs/heads/'.length);
      if (repo.refs.has(branch)) throw error(422);
      repo.refs.set(branch, body.sha);
      return { ref: body.ref, object: { type: 'commit', sha: body.sha } };
    }
    if (suffix.startsWith('/git/refs/heads/')) {
      const branch = decodeURIComponent(suffix.slice('/git/refs/heads/'.length));
      if (method === 'PATCH') {
        assert.deepEqual(Object.keys(body).sort(), ['force', 'sha']);
        assert.equal(body.force, false);
        if (!repo.refs.has(branch)) throw error(404);
        if (!this.descendant(repo, body.sha, repo.refs.get(branch))) throw error(422);
        repo.refs.set(branch, body.sha);
        return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: body.sha } };
      }
      assert.equal(method, 'DELETE');
      assert.notEqual(repo.default_branch, branch, 'cannot delete default branch');
      if (!repo.refs.delete(branch)) throw error(404);
      return null;
    }
    assert.fail(`Unexpected endpoint ${method} ${path}`);
  }
}
