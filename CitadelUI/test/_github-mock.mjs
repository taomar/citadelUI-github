/**
 * Mocked GitHub API.
 *
 * An in-memory Git object model good enough to exercise the real request
 * sequence Citadel UI performs: refs, commits, trees, blobs, and non-fast-forward
 * ref updates. Tests never contact github.com and never use a real token.
 */
import { createHash } from 'node:crypto';

export const TEST_TOKEN = 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789';

function hashObject(kind, payload) {
  return createHash('sha1').update(`${kind}:${payload}`).digest('hex');
}

export class MockGitHub {
  constructor(options = {}) {
    this.token = options.token || TEST_TOKEN;
    this.user = options.user || { login: 'octo-dev', id: 4242, type: 'User' };
    this.repositories = new Map();
    this.blobs = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.calls = [];
    this.failNextRefUpdate = false;
    this.protectedBranches = new Set();
    this.rateLimited = false;
    // When set, `?recursive=1` omits `.azure` entries and reports truncation,
    // reproducing GitHub's large-tree behavior.
    this.truncateTrees = false;
  }

  addRepository(spec) {
    const repository = {
      id: spec.id,
      full_name: spec.fullName,
      name: spec.fullName.split('/')[1],
      owner: { login: spec.fullName.split('/')[0] },
      private: spec.private !== false,
      archived: Boolean(spec.archived),
      disabled: Boolean(spec.disabled),
      default_branch: spec.defaultBranch || 'main',
      permissions: { push: spec.canPush !== false, admin: false },
      updated_at: '2026-01-01T00:00:00Z',
      refs: new Map(),
    };
    this.repositories.set(repository.id, repository);
    return repository;
  }

  byName(fullName) {
    return [...this.repositories.values()].find((item) => item.full_name === fullName) || null;
  }

  writeBlob(content) {
    const base64 = Buffer.from(content).toString('base64');
    const sha = hashObject('blob', base64);
    this.blobs.set(sha, base64);
    return sha;
  }

  /** Store one tree level exactly as Git does: entries are names, not paths. */
  writeTree(entries) {
    const normalized = [...entries].sort((left, right) => left.path.localeCompare(right.path));
    const sha = hashObject('tree', JSON.stringify(normalized));
    this.trees.set(sha, normalized);
    return sha;
  }

  /**
   * Build real nested trees from `path -> entry`.
   *
   * Git stores a tree per directory, and Citadel UI's targeted path lookup walks
   * those levels, so a flat one-level tree would not exercise it faithfully.
   */
  writeNestedTree(files) {
    const root = new Map();
    for (const file of files) {
      const segments = file.path.split('/');
      let level = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        if (!level.has(name)) level.set(name, new Map());
        level = level.get(name);
      }
      level.set(segments.at(-1), { ...file, path: segments.at(-1) });
    }
    const build = (level) => {
      const entries = [];
      for (const [name, value] of level) {
        if (value instanceof Map) {
          entries.push({ path: name, mode: '040000', type: 'tree', sha: build(value) });
        } else {
          entries.push(value);
        }
      }
      return this.writeTree(entries);
    };
    return build(root);
  }

  /** Expand nested trees into the flat listing `?recursive=1` returns. */
  flatten(treeSha, prefix = '') {
    const entries = [];
    for (const entry of this.trees.get(treeSha) || []) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === 'tree') {
        entries.push({ ...entry, path });
        entries.push(...this.flatten(entry.sha, path));
      } else {
        entries.push({ ...entry, path });
      }
    }
    return entries;
  }

  writeCommit(treeSha, parents, message) {
    const sha = hashObject('commit', `${treeSha}:${parents.join(',')}:${message}`);
    this.commits.set(sha, {
      sha,
      tree: treeSha,
      parents,
      message,
      author: { name: 'Citadel UI', date: '2026-02-01T00:00:00Z' },
    });
    return sha;
  }

  /** Seed a branch from a plain `path -> text` map. */
  seed(repository, branch, files, options = {}) {
    const entries = Object.entries(files).map(([path, value]) => {
      const content = typeof value === 'string' ? value : value.content;
      const mode = typeof value === 'string' ? '100644' : value.mode || '100644';
      const bytes = Buffer.from(content);
      return {
        path,
        mode,
        type: mode === '160000' ? 'commit' : 'blob',
        sha: this.writeBlob(bytes),
        size: bytes.byteLength,
      };
    });
    const tree = this.writeNestedTree(entries);
    const commit = this.writeCommit(tree, options.parents || [], options.message || 'seed');
    repository.refs.set(branch, commit);
    return commit;
  }

  treeOf(commitSha) {
    const commit = this.commits.get(commitSha);
    return commit ? this.flatten(commit.tree).filter((entry) => entry.type !== 'tree') : [];
  }

  fileText(repository, branch, path) {
    const commit = repository.refs.get(branch);
    const entry = this.treeOf(commit).find((item) => item.path === path);
    return entry ? Buffer.from(this.blobs.get(entry.sha), 'base64').toString('utf8') : null;
  }

  json(status, body, headers = {}) {
    const payload = Buffer.from(JSON.stringify(body));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...headers,
      }),
      body: (async function* () {
        yield payload;
      })(),
      arrayBuffer: async () => payload,
    };
  }

  /** A `fetch` implementation for `GitHubApiClient`. */
  fetch = async (href, init = {}) => {
    const url = new URL(href);
    const authorization = init.headers?.Authorization || null;
    this.calls.push({ method: init.method || 'GET', path: url.pathname + url.search, authorization });
    if (url.origin !== 'https://api.github.com') {
      throw new Error(`Unexpected egress to ${url.origin}`);
    }
    if (this.rateLimited) {
      return this.json(429, { message: 'API rate limit exceeded' });
    }
    if (authorization !== `Bearer ${this.token}`) {
      return this.json(401, { message: 'Bad credentials' });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    const segments = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/user') return this.json(200, this.user);

    if (url.pathname === '/user/repos') {
      const page = Number(url.searchParams.get('page') || 1);
      const list = page === 1 ? [...this.repositories.values()] : [];
      return this.json(200, list.map(({ refs, ...rest }) => rest));
    }

    if (segments[0] === 'repositories' && segments.length === 2) {
      const repository = this.repositories.get(Number(segments[1]));
      if (!repository) return this.json(404, { message: 'Not Found' });
      const { refs, ...rest } = repository;
      return this.json(200, rest);
    }

    if (segments[0] !== 'repos' || segments.length < 3) {
      return this.json(404, { message: 'Not Found' });
    }
    const fullName = `${segments[1]}/${segments[2]}`;
    const repository = this.byName(fullName);
    if (!repository) return this.json(404, { message: 'Not Found' });
    const rest = segments.slice(3);

    if (rest[0] === 'branches' && rest.length === 1) {
      const page = Number(url.searchParams.get('page') || 1);
      const list =
        page === 1
          ? [...repository.refs.keys()].map((name) => ({
              name,
              commit: { sha: repository.refs.get(name) },
              protected: this.protectedBranches.has(name),
            }))
          : [];
      return this.json(200, list);
    }

    if (rest[0] === 'git' && rest[1] === 'ref' && rest[2] === 'heads') {
      const branch = decodeURIComponent(rest.slice(3).join('/'));
      const sha = repository.refs.get(branch);
      if (!sha) return this.json(404, { message: 'Not Found' });
      return this.json(200, { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } });
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && init.method === 'POST') {
      const branch = String(body.ref || '').replace('refs/heads/', '');
      if (repository.refs.has(branch)) return this.json(422, { message: 'Reference already exists' });
      repository.refs.set(branch, body.sha);
      return this.json(201, { ref: body.ref, object: { type: 'commit', sha: body.sha } });
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && init.method === 'DELETE') {
      const branch = decodeURIComponent(rest.slice(3).join('/'));
      if (!repository.refs.has(branch)) return this.json(404, { message: 'Not Found' });
      repository.refs.delete(branch);
      return this.json(204, null);
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && init.method === 'PATCH') {
      const branch = decodeURIComponent(rest.slice(3).join('/'));
      if (this.protectedBranches.has(branch)) {
        return this.json(403, { message: 'Protected branch update failed' });
      }
      if (this.failNextRefUpdate) {
        this.failNextRefUpdate = false;
        return this.json(422, { message: 'Update is not a fast forward' });
      }
      const commit = this.commits.get(body.sha);
      const current = repository.refs.get(branch);
      // Non-forced updates must be fast-forward from the current ref.
      if (body.force === false && commit && !commit.parents.includes(current)) {
        return this.json(422, { message: 'Update is not a fast forward' });
      }
      repository.refs.set(branch, body.sha);
      return this.json(200, { object: { type: 'commit', sha: body.sha } });
    }

    if (rest[0] === 'git' && rest[1] === 'commits' && init.method === 'POST') {
      const sha = this.writeCommit(body.tree, body.parents || [], body.message);
      return this.json(201, { sha });
    }

    if (rest[0] === 'git' && rest[1] === 'commits' && rest[2]) {
      const commit = this.commits.get(rest[2]);
      if (!commit) return this.json(404, { message: 'Not Found' });
      return this.json(200, { sha: commit.sha, tree: { sha: commit.tree } });
    }

    if (rest[0] === 'git' && rest[1] === 'blobs' && init.method === 'POST') {
      const sha = this.writeBlob(Buffer.from(body.content, 'base64'));
      return this.json(201, { sha });
    }

    if (rest[0] === 'git' && rest[1] === 'blobs' && rest[2]) {
      const content = this.blobs.get(rest[2]);
      if (content === undefined) return this.json(404, { message: 'Not Found' });
      return this.json(200, {
        sha: rest[2],
        encoding: 'base64',
        content,
        size: Buffer.from(content, 'base64').byteLength,
      });
    }

    if (rest[0] === 'git' && rest[1] === 'trees' && init.method === 'POST') {
      const base = this.flatten(body.base_tree).filter((entry) => entry.type !== 'tree');
      const merged = new Map(base.map((entry) => [entry.path, entry]));
      for (const entry of body.tree) {
        if (entry.sha === null) merged.delete(entry.path);
        else {
          const content = this.blobs.get(entry.sha) || '';
          merged.set(entry.path, {
            path: entry.path,
            mode: entry.mode,
            type: 'blob',
            sha: entry.sha,
            size: Buffer.from(content, 'base64').byteLength,
          });
        }
      }
      return this.json(201, { sha: this.writeNestedTree([...merged.values()]) });
    }

    if (rest[0] === 'git' && rest[1] === 'trees' && rest[2]) {
      const tree = this.trees.get(rest[2]);
      if (!tree) return this.json(404, { message: 'Not Found' });
      if (url.searchParams.get('recursive')) {
        const flat = this.flatten(rest[2]);
        const truncated = this.truncateTrees;
        return this.json(200, {
          sha: rest[2],
          // A truncated response deliberately omits entries, which is what makes
          // a recursive listing an unsafe basis for "this file does not exist".
          tree: truncated ? flat.filter((entry) => !entry.path.startsWith('.azure')) : flat,
          truncated,
        });
      }
      return this.json(200, { sha: rest[2], tree, truncated: false });
    }

    if (rest[0] === 'commits' && rest.length === 1) {
      const branch = url.searchParams.get('sha');
      const list = [];
      let cursor = repository.refs.get(branch);
      while (cursor && list.length < 100) {
        const commit = this.commits.get(cursor);
        if (!commit) break;
        list.push({
          sha: commit.sha,
          parents: commit.parents.map((parent) => ({ sha: parent })),
          commit: { message: commit.message, author: commit.author },
        });
        cursor = commit.parents[0];
      }
      return this.json(200, list);
    }

    if (rest[0] === 'commits' && rest[1]) {
      const commit = this.commits.get(rest[1]);
      if (!commit) return this.json(404, { message: 'Not Found' });
      const parent = commit.parents[0];
      const before = new Map(this.treeOf(parent).map((entry) => [entry.path, entry]));
      const after = new Map(this.treeOf(commit.sha).map((entry) => [entry.path, entry]));
      const files = [];
      for (const [path, entry] of after) {
        const prior = before.get(path);
        if (!prior) files.push({ filename: path, status: 'added', sha: entry.sha });
        else if (prior.sha !== entry.sha) files.push({ filename: path, status: 'modified', sha: entry.sha });
      }
      for (const [path] of before) {
        if (!after.has(path)) files.push({ filename: path, status: 'removed', sha: null });
      }
      return this.json(200, {
        sha: commit.sha,
        parents: commit.parents.map((item) => ({ sha: item })),
        commit: { message: commit.message, author: commit.author },
        files,
      });
    }

    return this.json(404, { message: 'Not Found' });
  };
}

/** Registry mirror stub exposing only `getEnvironment`, as the routes require. */
export function environmentRegistry(records) {
  return {
    async getEnvironment(id) {
      return records[id] || null;
    },
  };
}

/**
 * In-memory equivalent of `GitHubAuditStore`.
 *
 * Undo requires proof that Citadel UI created a commit, so tests need a real
 * audit rather than a permissive stub.
 */
export class MemoryAudit {
  constructor() {
    this.commits = [];
  }

  async record(entry) {
    this.commits.push({ ...entry, recordedAt: new Date().toISOString() });
  }

  async find({ commit, repositoryId, environmentId, branch }) {
    return (
      this.commits.find(
        (item) =>
          item.commit === commit &&
          item.environmentId === environmentId &&
          item.branch === branch &&
          (repositoryId == null || item.repositoryId === repositoryId)
      ) || null
    );
  }

  async listForEnvironment(environmentId, branch) {
    return this.commits
      .filter((item) => item.environmentId === environmentId && item.branch === branch)
      .reverse();
  }
}
