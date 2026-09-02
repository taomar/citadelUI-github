/**
 * Bounded, redacted governance record of workspace and connection events.
 *
 * ## Why this is separate from the commit audit
 *
 * `github/audit.mjs` answers one question — "did Citadel UI create this commit?"
 * — and Undo depends on its answer. Mixing governance events into it would put
 * ordinary noise in front of a security decision and let a busy week of opens
 * and renames evict the proof that a commit was ours. Git History stays separate
 * from both: it is the repository's record, not this device's.
 *
 * This store answers a different question: what was connected, attached,
 * validated, opened or removed on this machine, and when.
 *
 * ## Why the schema is closed
 *
 * Every field is drawn from a fixed vocabulary or is a name the user themselves
 * typed for a profile or an environment. There is no free-text `message` and no
 * structured `detail` object, because a log that accepts arbitrary text
 * eventually receives an error string that contains a parameter value, a path,
 * or — once — a credential. Making that impossible in the schema is a stronger
 * guarantee than filtering for it on the way in.
 *
 * Consequently this file never contains: a token, key material, an opaque
 * session id, source bytes, a parameter name or value, a policy fragment, a
 * commit SHA, or a local filesystem path.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicJson } from './atomic-json.mjs';

const MAX_EVENTS = 400;
const MAX_NAME = 160;

/**
 * Every action this log will record. An unknown action is refused rather than
 * stored, so a future caller cannot widen the log by inventing a name.
 */
export const ACTIVITY_ACTIONS = Object.freeze({
  'connection.create': 'Connection created',
  'connection.rename': 'Connection renamed',
  'connection.reconnect': 'Connection reconnected',
  'connection.restore': 'Connection restored from encrypted store',
  'connection.disconnect': 'Connection disconnected',
  'connection.persistence-enabled': 'Encrypted persistence enabled',
  'connection.persistence-disabled': 'Encrypted persistence disabled',
  'connection.remove': 'Connection removed',
  'repository.validate': 'Repository branch validated',
  'repository.attach': 'Repository branch attached',
  'repository.detach': 'Workspace detached',
  'environment.open': 'Workspace opened',
  'validation.failure': 'Validation failed',
});

/**
 * Why an event ended the way it did. A closed vocabulary, because this is the
 * field a careless caller would otherwise fill with an exception message.
 */
export const ACTIVITY_REASONS = Object.freeze(new Set([
  'account-mismatch',
  'already-attached',
  'compatibility-failed',
  'credential-expired',
  'credential-unavailable',
  'duplicate-name',
  'not-a-citadel-repository',
  'permission-denied',
  'persistence-unavailable',
  'rate-limited',
  'repository-renamed',
  'unreachable',
]));

const OUTCOMES = new Set(['ok', 'failed', 'refused']);
const ORIGINS = new Set(['server', 'client']);

/** A user-supplied display name, stripped of anything that could reshape a log line. */
function displayName(value) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}\u2026` : text;
}

export class ActivityStore {
  constructor(options = {}) {
    this.path = join(options.dataRoot, 'settings', 'activity.json');
    this.now = options.now || (() => Date.now());
    this.maxEvents = options.maxEvents ?? MAX_EVENTS;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const current = JSON.parse(await readFile(this.path, 'utf8'));
      return Array.isArray(current?.events) ? current.events : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * Normalise one candidate event, or return null.
   *
   * Returning null rather than throwing is deliberate: recording governance
   * activity must never be able to fail the operation it is describing. A
   * malformed event is dropped, and the attach or the open still succeeds.
   */
  normalize(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    const action = String(candidate.action || '');
    if (!Object.hasOwn(ACTIVITY_ACTIONS, action)) return null;
    const outcome = String(candidate.outcome || 'ok');
    if (!OUTCOMES.has(outcome)) return null;
    const origin = String(candidate.origin || 'server');
    if (!ORIGINS.has(origin)) return null;
    const reason =
      candidate.reason && ACTIVITY_REASONS.has(String(candidate.reason))
        ? String(candidate.reason)
        : null;
    return {
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      origin,
      action,
      outcome,
      reason,
      target: displayName(candidate.target),
      account: displayName(candidate.account),
    };
  }

  /** Append one event. Never throws into the caller's operation. */
  async record(candidate) {
    const event = this.normalize(candidate);
    if (!event) return null;
    const work = async () => {
      const events = await this.read();
      events.push(event);
      await atomicJson(this.path, {
        version: 1,
        events: events.slice(-this.maxEvents),
      });
      return event;
    };
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    try {
      return await result;
    } catch {
      return null;
    }
  }

  /**
   * Resolve once every write requested so far has landed.
   *
   * Recording is fire-and-forget so it can never fail the operation it
   * describes, but that would otherwise make the log read stale: a user who
   * connects and immediately opens the activity panel would see nothing. The
   * read waits for the writes that were already asked for, and for nothing else.
   */
  async settled() {
    try {
      await this.queue;
    } catch {
      // A failed write is already accounted for; it must not fail a read.
    }
  }

  /** Most recent first, bounded by the caller's page size. */
  async list(limit = 50) {
    await this.settled();
    const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, this.maxEvents) : 50;
    const events = await this.read();
    return events.slice(-size).reverse();
  }
}
