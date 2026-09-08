import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicGitHubMock, publicHarness } from './_migration-public-fixture.mjs';

/** Exact supplied public HTTP data. Missing cache data fails; no live transport. */
export function cachedPublicHarness(cache, local = {}, { resolveMissingBlob } = {}) {
  const github = new PublicGitHubMock();
  github.repository = cache.repository;
  github.refs = new Map([['heads/main', cache.reference]]);
  github.commits = new Map([[cache.commit.sha, cache.commit]]);
  github.trees = new Map([[cache.tree.sha, cache.tree]]);
  github.blobs = new Map(Object.entries(cache.blobs));
  const read = github.fetch;
  github.fetch = (input, options) => {
    const url = new URL(input);
    if (url.pathname.includes('/git/blobs/')) {
      const sha = url.pathname.split('/').at(-1);
      if (!github.blobs.has(sha) && resolveMissingBlob) {
        const entry = cache.tree.tree.find((entry) => entry.sha === sha);
        assert(entry && entry.path.endsWith('.bicep'), 'Only a referenced template may be supplemented by an exact local Git object');
        const bytes = resolveMissingBlob(entry);
        assert.equal(bytes.length, entry.size);
        assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), sha);
        github.blobs.set(sha, { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
      }
      assert(github.blobs.has(sha), 'Required blob absent from supplied public cache');
    }
    return read(input, options);
  };
  return publicHarness({ github, local, repository: cache.repository.full_name, ref: 'main' });
}
