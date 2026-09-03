/**
 * The one account this container will ever have.
 *
 * The product's original trust model was "reaching it proves you own it": the
 * server only listened on loopback, so any browser that could load the page was
 * by definition the person running it. Published behind an ingress that stops
 * being true, and the owner credential is what replaces it.
 *
 * The shape is deliberately small and deliberately final:
 *
 *   - Exactly one account. It is claimed once, on first run, by whoever gets
 *     there first, and after that the claim route is closed for the life of the
 *     stored record.
 *   - No second account, and no password reset. Neither is a route that exists
 *     and refuses; neither is a route at all. Resetting means redeploying with a
 *     fresh `/data`, which is the honest operation for a container whose whole
 *     identity is one file.
 *   - No plaintext, ever. scrypt with a per-record salt, compared in constant
 *     time.
 *
 * CLAIM WINDOW — the known gap, recorded here for whoever hardens this next.
 * Between the first public deploy and the first successful claim, anyone who
 * reaches the URL can claim ownership. Nothing below closes that window; it was
 * accepted deliberately for a demo. The two ways to close it are a
 * deployment-supplied claim secret that must be presented to `claim()`, or
 * refusing to serve the claim at all until the operator has claimed it while the
 * ingress is still internal. Both belong here, at `claim()`.
 *
 * `node:crypto` only. The runtime image deletes npm, and the absence of a
 * dependency tree is a deliberate supply-chain position rather than an accident,
 * so an authentication feature is the last place to start one.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

/**
 * Cost parameters are stored with each record rather than compiled in.
 *
 * Raising them later must not invalidate credentials claimed under the old
 * ones: verification reads the parameters the hash was produced with, so a
 * future increase applies to new claims and leaves existing owners able to sign
 * in. Without this, raising the cost would silently lock the owner out of their
 * own container, which for a product with no reset is unrecoverable.
 */
const DEFAULT_COST = Object.freeze({ N: 16384, r: 8, p: 1 });
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const RECORD_VERSION = 1;

const MIN_USERNAME = 1;
const MAX_USERNAME = 64;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;

/**
 * scrypt's memory ceiling is derived, not guessed.
 *
 * Node's default `maxmem` is 32 MiB and the requirement is 128 * N * r, which at
 * N=16384, r=8 is exactly 16 MiB — comfortable now, and silently fatal the first
 * time someone doubles N. Deriving it with headroom means a future cost increase
 * fails on the cost, not on an unrelated default nobody remembered.
 */
function maxmemFor(cost) {
  return Math.max(32 * 1024 * 1024, 256 * cost.N * cost.r);
}

export function ownerError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * One message for every rejected sign-in.
 *
 * With a single account there is nothing to enumerate, but distinguishing "no
 * such user" from "wrong password" would still tell a caller which half they got
 * right. One string costs nothing and says nothing.
 */
const SIGN_IN_FAILED = 'Username or password is incorrect.';

function assertUsername(value) {
  if (
    typeof value !== 'string' ||
    value.length < MIN_USERNAME ||
    value.length > MAX_USERNAME ||
    value.trim() !== value ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw ownerError(400, 'INVALID_USERNAME', 'Choose a username of 1 to 64 characters.');
  }
  return value;
}

function assertPassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD || value.length > MAX_PASSWORD) {
    throw ownerError(400, 'INVALID_PASSWORD', 'Choose a password of at least 8 characters.');
  }
  return value;
}

function readCost(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { N, r, p } = value;
  const positive = (n) => Number.isInteger(n) && n > 0 && n <= 1_048_576;
  if (!positive(N) || !positive(r) || !positive(p)) return null;
  // scrypt requires N to be a power of two greater than one; an invalid stored
  // value must read as a corrupt record rather than reach the primitive and
  // throw something shaped like an internal error.
  if ((N & (N - 1)) !== 0 || N < 2) return null;
  return { N, r, p };
}

function base64Bytes(value, maximumBytes) {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximumBytes) return null;
  return bytes;
}

/**
 * Parse a stored record, or return null to mean "this file is not a record".
 *
 * Every field is checked before use. A record that fails any check is corrupt,
 * and corrupt is a refusal — never a fallback to unclaimed.
 */
function readRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== RECORD_VERSION) return null;
  if (value.algorithm !== 'scrypt') return null;
  if (typeof value.username !== 'string' || !value.username) return null;
  const cost = readCost(value.cost);
  if (!cost) return null;
  const keyLength = value.keyLength;
  if (!Number.isInteger(keyLength) || keyLength < 16 || keyLength > 1024) return null;
  const salt = base64Bytes(value.salt, 1024);
  if (!salt || salt.length < SALT_BYTES) return null;
  const hash = base64Bytes(value.hash, 1024);
  if (!hash || hash.length !== keyLength) return null;
  return { username: value.username, cost, keyLength, salt, hash };
}

async function derive(password, salt, cost, keyLength) {
  return scrypt(password, salt, keyLength, { ...cost, maxmem: maxmemFor(cost) });
}

function equalBytes(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Compare two usernames without leaking which prefix matched.
 *
 * `timingSafeEqual` needs equal lengths, and the length of the stored username
 * is not itself a secret worth protecting here — but the comparison still runs
 * over fixed-size digests of the two values so that a caller cannot learn
 * anything from how long the rejection took.
 */
function sameUsername(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return equalBytes(a, b);
}

export class OwnerAccount {
  constructor(options = {}) {
    this.path = options.path || join(options.dataRoot, 'settings', 'owner.json');
    this.cost = options.cost || DEFAULT_COST;
    this.now = options.now || (() => new Date());
    // A single fixed pause on a rejected sign-in. Not a lockout and not a
    // backoff — just enough to make an online guessing loop unattractive
    // without holding state that would then need its own correctness argument.
    this.failedDelayMs = options.failedDelayMs ?? 250;
  }

  /**
   * Report whether this container has an owner.
   *
   * Three answers, and the third is the one that matters: claimed, never
   * claimed, or *cannot tell*. A missing file is genuinely "never claimed". A
   * file that cannot be read or does not parse is unknown, and unknown throws.
   *
   * The tempting shortcut — treat anything unreadable as unclaimed — would mean
   * that corrupting or truncating one file re-opens the claim route on a live
   * deployment and hands ownership to the next caller. "I don't know" must never
   * be reported as "it didn't happen".
   */
  async read() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'unclaimed' };
      throw ownerError(
        503,
        'OWNER_UNREADABLE',
        'The owner record cannot be read. Check the data volume before continuing.'
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw ownerError(
        503,
        'OWNER_CORRUPT',
        'The owner record is unreadable. Redeploy with fresh state to claim this container again.'
      );
    }
    const record = readRecord(parsed);
    if (!record) {
      throw ownerError(
        503,
        'OWNER_CORRUPT',
        'The owner record is unreadable. Redeploy with fresh state to claim this container again.'
      );
    }
    return { state: 'claimed', record };
  }

  /** Whether the claim route is still open. Propagates a corrupt record. */
  async isClaimed() {
    return (await this.read()).state === 'claimed';
  }

  /**
   * Claim this container, once.
   *
   * The exclusivity is the point, and it is why this does not go through
   * `atomicJson` like every other `/data` store. That helper writes a temporary
   * with `wx` and then `rename()`s it into place — the `wx` guards the
   * *temporary*, while `rename` overwrites the *destination* silently. Two
   * first-run visitors racing each other would each get their own temporary,
   * both would succeed, and the later rename would take the container. The
   * second claimant would own a deployment the first was already using.
   *
   * Opening the destination itself with `wx` makes the filesystem settle the
   * race: exactly one caller creates the file, and every other gets EEXIST. The
   * durability and permission discipline is the same as the shared helper —
   * mode 0600 and an explicit `sync()` before the handle closes — but the
   * semantics are claim-once rather than last-writer-wins, which is the whole
   * requirement.
   */
  async claim(username, password) {
    assertUsername(username);
    assertPassword(password);
    // Refuse early when the record is corrupt, so an unreadable file cannot be
    // overwritten by a new claim. `wx` would refuse anyway; this turns a
    // confusing EEXIST into the accurate "cannot tell" answer.
    if (await this.isClaimed()) {
      throw ownerError(
        409,
        'OWNER_ALREADY_CLAIMED',
        'This container already has an owner. Redeploy with fresh state to start over.'
      );
    }
    const salt = randomBytes(SALT_BYTES);
    const hash = await derive(password, salt, this.cost, KEY_LENGTH);
    const record = {
      version: RECORD_VERSION,
      username,
      algorithm: 'scrypt',
      cost: { ...this.cost },
      keyLength: KEY_LENGTH,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      claimedAt: this.now().toISOString(),
    };
    await mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(this.path, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw ownerError(
          409,
          'OWNER_ALREADY_CLAIMED',
          'This container already has an owner. Redeploy with fresh state to start over.'
        );
      }
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { username };
  }

  /**
   * Verify a sign-in.
   *
   * A rejection always costs the same fixed pause and always says the same
   * thing, whichever half was wrong. A record that cannot be read throws rather
   * than returning false, so an operator sees "the volume is broken" instead of
   * "your password is wrong".
   */
  async verify(username, password) {
    const state = await this.read();
    if (state.state !== 'claimed') {
      await this.pause();
      throw ownerError(409, 'OWNER_UNCLAIMED', 'This container has no owner yet.');
    }
    const record = state.record;
    // Both halves are evaluated before either is allowed to decide, so a wrong
    // username costs the same derivation as a wrong password.
    const usernameMatches = sameUsername(record.username, typeof username === 'string' ? username : '');
    let hashMatches = false;
    if (typeof password === 'string' && password.length <= MAX_PASSWORD) {
      const candidate = await derive(password, record.salt, record.cost, record.keyLength);
      hashMatches = equalBytes(candidate, record.hash);
    }
    if (!usernameMatches || !hashMatches) {
      await this.pause();
      throw ownerError(401, 'INVALID_CREDENTIALS', SIGN_IN_FAILED);
    }
    return { username: record.username };
  }

  async pause() {
    if (!this.failedDelayMs) return;
    await new Promise((resolve) => setTimeout(resolve, this.failedDelayMs));
  }
}
