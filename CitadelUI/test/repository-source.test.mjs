import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_REPOSITORY_SOURCE, parseRepositorySource, validateNewRepositoryName } from '../shared/repository-source.mjs';

test('repository source: default root link preserves the exact citadel-v1 ref', () => {
  assert.deepEqual(parseRepositorySource(DEFAULT_REPOSITORY_SOURCE), {
    fullName: 'mohamedsaif/ai-hub-gateway-solution-accelerator', ref: 'citadel-v1',
    url: 'https://github.com/mohamedsaif/ai-hub-gateway-solution-accelerator/tree/citadel-v1',
  });
  assert.deepEqual(parseRepositorySource(' https://github.com/example/source/ '), {
    fullName: 'example/source', ref: null, url: 'https://github.com/example/source',
  });
  assert.equal(parseRepositorySource('https://github.com/example/source/tree/release/next').ref, 'release/next');
  assert.equal(parseRepositorySource('https://github.com/example/source/tree/main/subdirectory').ref, 'main/subdirectory');
});

test('repository source: rejects unsafe hosts, credentials and literal normalization tricks', () => {
  for (const value of [
    '', null, {}, 'http://github.com/a/b', 'https://evil.example/a/b',
    'https://github.com.evil.example/a/b', 'https://user@github.com/a/b',
    'https://github.com:443/a/b', 'https://github.com/a/b?q=1', 'https://github.com/a/b#main',
    'https://github.com/a/b/tree/../main', 'https://github.com/a/../b',
    'https://github.com/a/b/tree/%2e%2e/main', 'https://github.com/a/b/tree/feature%2fmain',
    'https://github.com/a/b/tree/main\\evil', 'https://github.com/a/b//',
    'https://github.com/a/b/blob/main/README.md', 'https://github.com/a/b/blob/main',
    'https://github.com/a/b/subdirectory', 'https://github.com/a/b/tree/main//',
    'https://github.com/a/b/tree/a..b', 'https://github.com/a/b/tree/a.lock',
    'https://github.com/a/b/tree/a/.hidden', 'https://github.com/a/b/tree/a\nb',
    'https://github.com/a/b/tree/a?b', 'https://github.com/a/b.git', 'https://github.com/a/b.GIT',
  ]) assert.throws(() => parseRepositorySource(value), undefined, String(value));
});

test('repository source: validates a new personal repository name without silently rewriting it', () => {
  assert.equal(validateNewRepositoryName('  my.repo_2026-test  '), 'my.repo_2026-test');
  assert.equal(validateNewRepositoryName('x'.repeat(100)), 'x'.repeat(100));
  for (const value of ['', ' ', '.', '..', '...', '../repo', 'owner/repo', 'repo.git', 'repo.GIT', 'x'.repeat(101),
    'a b', 'a%b', 'a?b', 'a#b', 'a\\b', 'a\nb', '<repo>', null, {}, ['repo']]) {
    assert.throws(() => validateNewRepositoryName(value));
  }
});
