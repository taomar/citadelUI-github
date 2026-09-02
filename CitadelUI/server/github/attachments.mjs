/**
 * Server-owned attachment reservations.
 *
 * Attaching a repository can create a Citadel working branch before the
 * environment is known to be usable. If the browser then fails, that branch must
 * be cleaned up — but a cleanup request that names its own repository, branch
 * and head is a deletion primitive the browser controls, and could be aimed at
 * another environment's working branch.
 *
 * A reservation removes that authority from the request. The server records what
 * it is about to do, hands back an opaque id, and cleanup names only that id.
 * Everything else is read from the server's own record and re-validated.
 *
 * Three properties matter, and each cost a defect to learn:
 *
 *   - Provenance is recorded *before* the branch mutation. Recording it after
 *     means a create whose response is lost leaves a branch nothing can name.
 *   - A reservation is a state machine, not a one-shot token. Consuming it
 *     before the fallible lookup and delete meant one transient network failure
 *     destroyed the only provenance that could clean the branch up.
 *   - Work is serialised per credential and operation key, so two identical
 *     requests racing cannot both create a branch or both hand out provenance.
 *
 * Reservations live in memory: they exist only between an attach and its
 * immediate cleanup, and a restart cannot leave a branch that a later request
 * could delete on stale provenance.
 */
import { randomBytes, createHash } from 'node:crypto';

import { githubError } from './api.mjs';

const TTL_MS = 30 * 60 * 1000;
const MAX_RESERVATIONS = 64;

function fingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** `pending` -> `attached` -> `resolved`. A reservation is never half-recorded. */
export const RESERVATION_PENDING = 'pending';
export const RESERVATION_ATTACHED = 'attached';
export const RESERVATION_RESOLVED = 'resolved';

export class AttachmentReservations {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.ttlMs = options.ttlMs ?? TTL_MS;
    this.max = options.max ?? MAX_RESERVATIONS;
    /** @type {Map<string, object>} keyed by SHA-256 of the opaque operation id */
    this.entries = new Map();
    /** @type {Map<string, string>} `sessionFingerprint:clientKey` -> id hash */
    this.byKey = new Map();
    /** @type {Map<string, Promise<unknown>>} in-flight work, keyed the same way */
    this.inFlight = new Map();
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) {
        this.entries.delete(key);
        if (entry.keyIndex) this.byKey.delete(entry.keyIndex);
      }
    }
  }

  /**
   * Run `work` for one credential and operation key at a time.
   *
   * Two identical attach requests arriving together would otherwise each find no
   * prior reservation, each create a branch, and each hand back provenance for a
   * branch the other also believes it owns. Serialising makes the second caller
   * observe the first one's result, which is what idempotency means here.
   */
  async serialize(sessionFingerprint, clientKey, work) {
    if (!clientKey) return work();
    const gate = `${sessionFingerprint}:${clientKey}`;
    while (this.inFlight.has(gate)) {
      // Settled, not fulfilled: a failed attempt must not block the retry.
      await this.inFlight.get(gate).catch(() => {});
    }
    const running = (async () => work())();
    this.inFlight.set(gate, running);
    try {
      return await running;
    } finally {
      if (this.inFlight.get(gate) === running) this.inFlight.delete(gate);
    }
  }

  /**
   * Look up a prior reservation for the same client operation key.
   *
   * This is what makes attach idempotent: if the response was lost, retrying
   * with the same key returns the original result and provenance instead of
   * creating a second branch or orphaning the first.
   */
  findByKey(sessionFingerprint, clientKey) {
    this.prune();
    if (!clientKey) return null;
    const id = this.byKey.get(`${sessionFingerprint}:${clientKey}`);
    if (!id) return null;
    const entry = this.entries.get(id);
    if (!entry || entry.sessionFingerprint !== sessionFingerprint) return null;
    return entry;
  }

  /**
   * Reserve provenance *before* the branch is touched.
   *
   * The record names what the server is about to do. If the mutation then fails
   * ambiguously — a response lost after GitHub already acted — the reservation
   * is still the thing that can find and clean up whatever was created.
   */
  reserve(record) {
    this.prune();
    if (this.entries.size >= this.max) {
      // Oldest first: a reservation is short-lived provenance, not durable state.
      const oldest = this.entries.keys().next().value;
      const stale = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (stale?.keyIndex) this.byKey.delete(stale.keyIndex);
    }
    const operationId = randomBytes(32).toString('base64url');
    const idHash = fingerprint(operationId);
    const keyIndex = record.clientKey ? `${record.sessionFingerprint}:${record.clientKey}` : null;
    const entry = {
      ...record,
      keyIndex,
      operationId,
      createdAt: this.now(),
      state: RESERVATION_PENDING,
      workingBranch: record.workingBranch || null,
      baseHead: null,
      created: false,
      result: null,
    };
    this.entries.set(idHash, entry);
    if (keyIndex) this.byKey.set(keyIndex, idHash);
    return entry;
  }

  /** Record what the branch mutation actually did, and publish the result. */
  attach(entry, outcome) {
    entry.workingBranch = outcome.workingBranch;
    entry.baseHead = outcome.baseHead;
    entry.created = Boolean(outcome.created);
    entry.result = outcome.result;
    entry.state = RESERVATION_ATTACHED;
    return entry;
  }

  /** Drop a reservation whose branch mutation provably created nothing. */
  discard(entry) {
    this.entries.delete(fingerprint(entry.operationId));
    if (entry.keyIndex) this.byKey.delete(entry.keyIndex);
    return entry;
  }

  /**
   * Look up an operation for the session that owns it, without retiring it.
   *
   * Cleanup needs the record to *survive* a failed attempt: retiring it first
   * meant one transient lookup or delete failure destroyed the only provenance
   * that could ever remove the branch.
   */
  find(sessionFingerprint, operationId) {
    this.prune();
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operationId)) {
      throw githubError(400, 'INVALID_OPERATION', 'A valid attachment operation id is required.');
    }
    const entry = this.entries.get(fingerprint(operationId));
    if (!entry || entry.sessionFingerprint !== sessionFingerprint) {
      throw githubError(
        404,
        'UNKNOWN_OPERATION',
        'That attachment operation is unknown or has expired.'
      );
    }
    return entry;
  }

  /** Retire an operation once cleanup is confirmed, or confirmed unnecessary. */
  resolve(entry) {
    entry.state = RESERVATION_RESOLVED;
    this.entries.delete(fingerprint(entry.operationId));
    if (entry.keyIndex) this.byKey.delete(entry.keyIndex);
    return entry;
  }

  clear() {
    this.entries.clear();
    this.byKey.clear();
    this.inFlight.clear();
  }

  get size() {
    this.prune();
    return this.entries.size;
  }
}

export { fingerprint as reservationFingerprint };
