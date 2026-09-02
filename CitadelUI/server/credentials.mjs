/**
 * Optional encrypted persistence for one GitHub credential per connection
 * profile.
 *
 * ## What this is for
 *
 * Phase 1 kept credentials in memory only, so every container restart forced
 * the user to paste a token again. That is safe but hostile, and it made the
 * saved-workspace catalogue useless after a restart. This store makes the choice
 * explicit and singular: one checkbox, `Persist this connection on this device
 * (encrypted)`. Unchecked, nothing here is ever called and the behaviour is
 * exactly Phase 1's. Checked, the token is sealed under a key that does not live
 * in the data volume, and the server restores it by itself on the next start.
 *
 * There is deliberately no passphrase, no unlock screen and no key-change
 * ceremony. A local single-user control panel that demands a second secret every
 * morning gets that secret written on a sticky note, which is worse than the
 * threat it was meant to answer.
 *
 * ## Threat model, stated honestly
 *
 * Protects: theft or copying of the `/data` volume — a backup, a stray archive,
 * a mislaid disk — by someone who does not also hold the key file. The envelope
 * is useless without the key.
 *
 * Does not protect: a compromised running host or container, a process that can
 * read this server's memory, or theft of the data volume *and* the key file
 * together. Anyone who can read both can decrypt. The key is mounted read-only
 * from outside the repository and outside `/data` precisely so that the two are
 * not stolen by the same accident, but they are not separated by hardware.
 *
 * ## Envelope
 *
 *   random 256-bit DEK ── AES-256-GCM ──► token ciphertext (unique 96-bit IV)
 *   DEK ── AES-256-GCM under the mounted KEK ──► wrapped DEK (its own 96-bit IV)
 *
 * Both operations bind additional authenticated data containing the envelope
 * version, the profile id and the immutable GitHub account id, and the two AADs
 * are distinct. Moving an envelope to another profile, replaying an old account
 * binding, or swapping a wrapped DEK between files therefore fails the
 * authentication tag rather than yielding a token for the wrong account.
 *
 * Nothing here logs, prints, returns or re-serialises key material or a token.
 * The key file is read by path and its bytes never enter an environment
 * variable, an image layer, a command line, the registry, the audit, or the
 * activity log.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicJson } from './atomic-json.mjs';

export const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SECRET_BYTES = 4096;
const MAX_KEY_FILE_BYTES = 4096;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Wipe a buffer we are finished with, so a heap dump has less to find. */
function wipe(...buffers) {
  for (const buffer of buffers) {
    if (Buffer.isBuffer(buffer)) buffer.fill(0);
  }
}

/**
 * Interpret the mounted key file.
 *
 * Accepts raw 32 bytes, or hex/base64/base64url text encoding exactly 32 bytes,
 * because an operator generating a key with `openssl rand` may reasonably
 * produce any of them. Anything else is refused rather than stretched or hashed
 * into shape: silently accepting a short key would produce a vault that looks
 * encrypted and is not.
 */
export function decodeMasterKey(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_KEY_FILE_BYTES) {
    return null;
  }
  if (bytes.length === KEY_BYTES) return Buffer.from(bytes);
  const text = bytes.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}={0,2}$/.test(text)) {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === KEY_BYTES) return decoded;
    wipe(decoded);
  }
  return null;
}

function additionalData(scope, profileId, accountId) {
  return Buffer.from(`citadel:${scope}:v${ENVELOPE_VERSION}:${profileId}:${accountId}`, 'utf8');
}

function seal(key, plaintext, aad) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
}

/**
 * Open one sealed part, or fail closed.
 *
 * Every length is checked before the cipher is constructed, because a truncated
 * IV or tag from a corrupted file should be a refusal, not a thrown
 * `ERR_CRYPTO_*` that a caller might mistake for a transient fault.
 */
function open_(key, part, aad) {
  if (!part || typeof part !== 'object') return null;
  const iv = base64Bytes(part.iv, IV_BYTES);
  const tag = base64Bytes(part.tag, TAG_BYTES);
  const data = base64Bytes(part.data, null);
  if (!iv || !tag || !data) {
    wipe(iv, tag, data);
    return null;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    // Wrong key, tampered ciphertext, or an AAD that does not match this
    // profile and account. All three are the same answer: no credential.
    return null;
  } finally {
    wipe(iv, tag, data);
  }
}

function base64Bytes(value, expectedLength) {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_SECRET_BYTES) return null;
  if (expectedLength !== null && bytes.length !== expectedLength) return null;
  return bytes;
}

export class CredentialVault {
  constructor(options = {}) {
    this.directory = join(options.dataRoot, 'settings', 'credentials');
    this.keyFile = options.keyFile ?? process.env.CITADEL_CREDENTIAL_KEY_FILE ?? null;
    this.now = options.now || (() => Date.now());
    this.key = null;
    this.reason = 'not-initialised';
    this.queue = Promise.resolve();
  }

  /**
   * Load the key if one is mounted.
   *
   * A missing or malformed key is not a startup failure. The product still
   * works; the persistence option is simply unavailable and the UI says so,
   * because refusing to boot would turn a convenience feature into an outage.
   */
  async initialize() {
    if (!this.keyFile || typeof this.keyFile !== 'string') {
      this.reason = 'no-key-file';
      return this;
    }
    let raw = null;
    try {
      raw = await readFile(this.keyFile);
    } catch {
      this.reason = 'key-file-unreadable';
      return this;
    }
    const key = decodeMasterKey(raw);
    wipe(raw);
    if (!key) {
      this.reason = 'key-file-invalid';
      return this;
    }
    this.key = key;
    this.reason = 'ready';
    return this;
  }

  get available() {
    return this.key !== null;
  }

  /** Safe to show a user and safe to log: a state name, never key material. */
  status() {
    return { available: this.available, reason: this.reason };
  }

  path(profileId) {
    if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) {
      throw new Error('Invalid connection profile id.');
    }
    return join(this.directory, `${profileId}.json`);
  }

  /** Serialise writes so two profiles saved at once cannot interleave. */
  serial(work) {
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async store(profileId, accountId, secret) {
    if (!this.available) return false;
    const plaintext = Buffer.from(String(secret), 'utf8');
    if (!plaintext.length || plaintext.length > MAX_SECRET_BYTES) {
      wipe(plaintext);
      throw new Error('Credential is out of range.');
    }
    const dek = randomBytes(KEY_BYTES);
    try {
      const envelope = {
        version: ENVELOPE_VERSION,
        profileId,
        accountId: Number(accountId),
        algorithm: 'AES-256-GCM',
        wrappedKey: seal(this.key, dek, additionalData('dek', profileId, Number(accountId))),
        secret: seal(dek, plaintext, additionalData('token', profileId, Number(accountId))),
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.serial(() => atomicJson(this.path(profileId), envelope));
      return true;
    } finally {
      wipe(dek, plaintext);
    }
  }

  /**
   * Recover the credential for a profile, or null.
   *
   * The caller supplies the account id it believes the profile is bound to. A
   * mismatch changes the AAD, so an envelope that was sealed for a different
   * account cannot be opened here even though the file name matches — the
   * defence against an operator swapping envelope files between profiles.
   */
  async load(profileId, accountId) {
    if (!this.available) return null;
    let envelope = null;
    try {
      envelope = JSON.parse(await readFile(this.path(profileId), 'utf8'));
    } catch {
      return null;
    }
    if (
      !envelope ||
      envelope.version !== ENVELOPE_VERSION ||
      envelope.algorithm !== 'AES-256-GCM' ||
      envelope.profileId !== profileId ||
      Number(envelope.accountId) !== Number(accountId)
    ) {
      return null;
    }
    const dek = open_(this.key, envelope.wrappedKey, additionalData('dek', profileId, Number(accountId)));
    if (!dek || dek.length !== KEY_BYTES) {
      wipe(dek);
      return null;
    }
    const plaintext = open_(dek, envelope.secret, additionalData('token', profileId, Number(accountId)));
    wipe(dek);
    if (!plaintext) return null;
    const secret = plaintext.toString('utf8');
    wipe(plaintext);
    return secret;
  }

  async has(profileId) {
    try {
      await readFile(this.path(profileId), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** Unchecking the box, or removing the profile, deletes the envelope. */
  async remove(profileId) {
    let path;
    try {
      path = this.path(profileId);
    } catch {
      return false;
    }
    return this.serial(async () => {
      try {
        await rm(path, { force: true });
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Forget the key held in memory. Used by tests and by shutdown. */
  close() {
    wipe(this.key);
    this.key = null;
    this.reason = 'closed';
  }
}

/** Constant-time equality for two account identifiers rendered as text. */
export function sameAccount(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (a.length !== b.length || !a.length) return false;
  return timingSafeEqual(a, b);
}
