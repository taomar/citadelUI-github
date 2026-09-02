/**
 * Redacted audit record of Citadel-authored GitHub commits.
 *
 * Commit trailers travel inside the repository and anyone with push access can
 * forge them, so they are evidence of intent, not of authorship. Undo is a
 * destructive operation, so it needs proof that Citadel UI actually created the
 * commit. This store is that proof.
 *
 * It holds only redacted metadata: repository id and full name, environment id,
 * branch, action, transaction id, base and final commit SHAs, changed aliases,
 * and a timestamp. It never holds a token, source bytes, hashes of secrets, or
 * any file content, so it is safe to keep under `/data` alongside the existing
 * transaction journals and to survive a container restart.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicJson } from '../atomic-json.mjs';

const MAX_RECORDS = 500;

function alias(value) {
  const text = String(value || '');
  return text.length > 512 ? text.slice(0, 512) : text;
}

export class GitHubAuditStore {
  constructor(options = {}) {
    this.path = join(options.dataRoot, 'settings', 'github-audit.json');
    this.now = options.now || (() => Date.now());
    this.maxRecords = options.maxRecords ?? MAX_RECORDS;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const current = JSON.parse(await readFile(this.path, 'utf8'));
      return Array.isArray(current?.commits) ? current.commits : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Append one commit record, oldest-first, bounded. */
  async record(entry) {
    const work = async () => {
      const commits = await this.read();
      commits.push({
        repositoryId: Number(entry.repositoryId) || null,
        fullName: String(entry.fullName || ''),
        environmentId: String(entry.environmentId || ''),
        branch: String(entry.branch || ''),
        action: String(entry.action || ''),
        transactionId: String(entry.transactionId || ''),
        baseCommit: String(entry.baseCommit || ''),
        commit: String(entry.commit || ''),
        aliases: (entry.aliases || []).slice(0, 64).map(alias),
        recordedAt: new Date(this.now()).toISOString(),
      });
      await atomicJson(this.path, {
        version: 1,
        commits: commits.slice(-this.maxRecords),
      });
    };
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Find the record proving Citadel UI created this commit for this
   * environment, repository, and branch.
   */
  async find({ commit, repositoryId, environmentId, branch }) {
    const commits = await this.read();
    return (
      commits.find(
        (item) =>
          item.commit === commit &&
          item.environmentId === environmentId &&
          item.branch === branch &&
          (repositoryId == null || item.repositoryId === repositoryId)
      ) || null
    );
  }

  async listForEnvironment(environmentId, branch) {
    const commits = await this.read();
    return commits
      .filter((item) => item.environmentId === environmentId && item.branch === branch)
      .reverse();
  }
}
