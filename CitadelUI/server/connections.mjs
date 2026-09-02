/**
 * Named GitHub connection profiles.
 *
 * ## Why these are not part of the registry document
 *
 * Projects and environments are browser-owned metadata mirrored into `/data`
 * under an epoch/revision handshake the browser drives. A connection profile is
 * the opposite: the server owns it, because it is the thing a stored credential
 * is bound to and the browser must never be able to rebind it. Putting both in
 * one document with one revision counter would give two owners one lock, and
 * every server-side reconnect would invalidate the browser's next save.
 *
 * So profiles live here, in their own document, with their own serialisation.
 * The registry refers to a profile by id and tolerates the id being gone: a
 * removed profile leaves its workspaces visible and marked `Reconnect`, rather
 * than deleting them. Removing a connection is a metadata action and must never
 * destroy work.
 *
 * ## What a profile is, and what it never contains
 *
 * A profile is: an immutable id, a friendly name the user chose and can change,
 * the immutable GitHub account id and login it is bound to, and timestamps. It
 * never contains a token, key material, or an opaque credential session id —
 * those are transient process state and encrypted-at-rest bytes respectively,
 * and neither belongs in a metadata document.
 *
 * ## Identity is the account id, never the login
 *
 * A login can be renamed and re-registered by someone else; the numeric account
 * id cannot. Reconnecting a profile therefore compares account ids. A token for
 * a different account is refused, and the caller is offered a distinct profile
 * instead — a profile is never silently rebound to another identity, because
 * every workspace attached to it would then be pointing at repositories the user
 * did not choose.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicJson } from './atomic-json.mjs';
import { transactionError } from './transactions.mjs';

export const CONNECTIONS_VERSION = 1;
const MAX_PROFILES = 24;
const NAME_MAX = 80;

export const CREDENTIAL_MODES = new Set(['session', 'persistent']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function profileName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw transactionError(
      400,
      'INVALID_CONNECTION_NAME',
      `Give this connection a name of 1 to ${NAME_MAX} characters.`
    );
  }
  return name;
}

function accountLogin(value) {
  const login = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
    throw transactionError(400, 'INVALID_CONNECTION_ACCOUNT', 'Invalid GitHub account login.');
  }
  return login;
}

function accountIdentifier(value) {
  const accountId = Number(value);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw transactionError(400, 'INVALID_CONNECTION_ACCOUNT', 'Invalid GitHub account id.');
  }
  return accountId;
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return Number.isNaN(Date.parse(text)) || text.length > 40 ? null : text;
}

/** Names are compared case- and accent-insensitively so two profiles cannot look identical. */
export function nameKey(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalize(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    provider: 'github',
    accountId: candidate.accountId,
    accountLogin: candidate.accountLogin,
    accountType: candidate.accountType === 'Organization' ? 'Organization' : 'User',
    credentialMode: CREDENTIAL_MODES.has(candidate.credentialMode)
      ? candidate.credentialMode
      : 'session',
    createdAt: timestamp(candidate.createdAt),
    updatedAt: timestamp(candidate.updatedAt),
    lastConnectedAt: timestamp(candidate.lastConnectedAt),
  };
}

export class ConnectionProfileStore {
  constructor(options = {}) {
    this.path = join(options.dataRoot, 'settings', 'connections.json');
    this.now = options.now || (() => Date.now());
    this.maxProfiles = options.maxProfiles ?? MAX_PROFILES;
    this.queue = Promise.resolve();
  }

  async initialize() {
    try {
      await readFile(this.path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await atomicJson(this.path, { version: CONNECTIONS_VERSION, profiles: [] });
    }
    return this;
  }

  async read() {
    let document;
    try {
      document = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const version = Number(document?.version ?? CONNECTIONS_VERSION);
    if (version > CONNECTIONS_VERSION) {
      throw transactionError(
        409,
        'CONNECTIONS_VERSION_UNSUPPORTED',
        `These connection profiles were written by a newer Citadel UI (schema v${version}).`
      );
    }
    return Array.isArray(document?.profiles)
      ? document.profiles.filter((item) => item && ID_PATTERN.test(String(item.id))).map(normalize)
      : [];
  }

  async list() {
    return (await this.read()).sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
    return (await this.read()).find((item) => item.id === id) || null;
  }

  async findByAccount(accountId) {
    const identifier = Number(accountId);
    return (await this.read()).find((item) => item.accountId === identifier) || null;
  }

  /** Serialise every mutation, so two connects cannot both win the last write. */
  mutate(work) {
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async write(profiles) {
    await atomicJson(this.path, {
      version: CONNECTIONS_VERSION,
      profiles: profiles.map(normalize),
    });
  }

  async create(input) {
    return this.mutate(async () => {
      const profiles = await this.read();
      if (profiles.length >= this.maxProfiles) {
        throw transactionError(
          409,
          'CONNECTION_LIMIT',
          'Too many GitHub connections are saved. Remove one first.'
        );
      }
      const name = profileName(input.name);
      if (profiles.some((item) => nameKey(item.name) === nameKey(name))) {
        throw transactionError(
          409,
          'CONNECTION_NAME_TAKEN',
          `A connection named "${name}" already exists. Choose a different name.`
        );
      }
      const at = new Date(this.now()).toISOString();
      const profile = normalize({
        id: randomUUID(),
        name,
        accountId: accountIdentifier(input.accountId),
        accountLogin: accountLogin(input.accountLogin),
        accountType: input.accountType,
        credentialMode: input.credentialMode,
        createdAt: at,
        updatedAt: at,
        lastConnectedAt: at,
      });
      await this.write([...profiles, profile]);
      return profile;
    });
  }

  /**
   * Apply a bounded set of changes to one profile.
   *
   * `accountId`, `accountLogin` and `id` are absent from the accepted keys by
   * construction: the identity a credential was sealed against is not editable,
   * and neither is the id every workspace refers to.
   */
  async update(id, changes) {
    return this.mutate(async () => {
      const profiles = await this.read();
      const index = profiles.findIndex((item) => item.id === id);
      if (index === -1) {
        throw transactionError(404, 'UNKNOWN_CONNECTION', 'That GitHub connection is not saved.');
      }
      const current = profiles[index];
      const next = { ...current };
      if (changes.name !== undefined) {
        const name = profileName(changes.name);
        if (
          profiles.some((item) => item.id !== id && nameKey(item.name) === nameKey(name))
        ) {
          throw transactionError(
            409,
            'CONNECTION_NAME_TAKEN',
            `A connection named "${name}" already exists. Choose a different name.`
          );
        }
        next.name = name;
      }
      if (changes.credentialMode !== undefined) {
        if (!CREDENTIAL_MODES.has(changes.credentialMode)) {
          throw transactionError(400, 'INVALID_CREDENTIAL_MODE', 'Invalid credential mode.');
        }
        next.credentialMode = changes.credentialMode;
      }
      if (changes.connected) next.lastConnectedAt = new Date(this.now()).toISOString();
      next.updatedAt = new Date(this.now()).toISOString();
      const updated = normalize(next);
      profiles[index] = updated;
      await this.write(profiles);
      return updated;
    });
  }

  async remove(id) {
    return this.mutate(async () => {
      const profiles = await this.read();
      const profile = profiles.find((item) => item.id === id) || null;
      if (!profile) return null;
      await this.write(profiles.filter((item) => item.id !== id));
      return profile;
    });
  }
}
