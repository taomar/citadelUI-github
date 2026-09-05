import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export {
  LOCAL_SESSION_BOOTSTRAP_HEADER,
  LOCAL_SESSION_CLAIM_PATH,
  LOCAL_SESSION_PROTOCOL_VERSION,
} from '../core/localSession.mjs';
import { LOCAL_SESSION_CLAIM_PATH, LOCAL_SESSION_PROTOCOL_VERSION } from '../core/localSession.mjs';

export const LOCAL_SESSION_COOKIE_NAME = 'citadel_playground_session';

const TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const MAX_COOKIE_HEADER_BYTES = 4096;
const MAX_COOKIE_PAIRS = 64;
const ZERO_TOKEN = Buffer.alloc(TOKEN_BYTES);
const ZERO_DIGEST = Buffer.alloc(32);

function encodeToken(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeToken(value) {
  const canonical = typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  let decoded = ZERO_TOKEN;
  if (canonical) {
    const candidate = Buffer.from(value, 'base64url');
    if (candidate.length === TOKEN_BYTES && encodeToken(candidate) === value) decoded = candidate;
  }
  return { canonical: canonical && decoded !== ZERO_TOKEN, value: decoded };
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isLoopbackAddress(address) {
  const value = String(address ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (value === '::1' || value === '127.0.0.1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  return mapped?.[1] === '127.0.0.1';
}

function readSessionCookie(request, cookieName) {
  const header = request?.headers?.cookie;
  if (typeof header !== 'string' || Buffer.byteLength(header, 'utf8') > MAX_COOKIE_HEADER_BYTES) {
    return { present: false, validShape: false, value: '' };
  }
  const pairs = header.split(';');
  if (pairs.length > MAX_COOKIE_PAIRS) return { present: false, validShape: false, value: '' };

  let value = '';
  let matches = 0;
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    if (pair.slice(0, separator).trim() !== cookieName) continue;
    matches += 1;
    value = pair.slice(separator + 1).trim();
  }
  return { present: matches > 0, validShape: matches === 1, value };
}

export function createLocalSessionAuth({
  bootstrapCapability,
  cookieName = LOCAL_SESSION_COOKIE_NAME,
  secureCookie = false,
  random = randomBytes,
} = {}) {
  if (typeof random !== 'function') throw new TypeError('A cryptographic random byte source is required.');
  if (!/^[A-Za-z0-9_]+$/.test(cookieName)) throw new TypeError('The local session cookie name is invalid.');

  const injected = bootstrapCapability == null ? null : decodeToken(bootstrapCapability);
  if (injected && !injected.canonical) {
    throw new TypeError(`The bootstrap capability must be a canonical ${TOKEN_LENGTH}-character base64url token.`);
  }
  let bootstrap = injected?.value ?? Buffer.from(random(TOKEN_BYTES));
  if (bootstrap.length !== TOKEN_BYTES) throw new TypeError(`The random source must return ${TOKEN_BYTES} bytes.`);
  let claimed = false;
  let sessionDigest = null;

  function hasValidSession(request) {
    const cookie = readSessionCookie(request, cookieName);
    const candidate = decodeToken(cookie.value);
    const candidateDigest = digest(candidate.value);
    const expected = sessionDigest ?? ZERO_DIGEST;
    const matches = timingSafeEqual(expected, candidateDigest);
    return Boolean(sessionDigest && cookie.present && cookie.validShape && candidate.canonical && matches);
  }

  return Object.freeze({
    cookieName,

    launchUrl(origin) {
      if (!bootstrap) throw new Error('The bootstrap capability has already been consumed.');
      const url = new URL('/', origin);
      url.hash = `bootstrap=${encodeURIComponent(encodeToken(bootstrap))}`;
      return url.href;
    },

    describe(request) {
      const authenticated = hasValidSession(request);
      return Object.freeze({
        required: true,
        state: authenticated ? 'claimed' : 'unclaimed',
        claimEndpoint: LOCAL_SESSION_CLAIM_PATH,
        message: authenticated
          ? 'This browser holds the local operator session.'
          : 'Open the secure launch URL shown in the terminal.',
      });
    },

    authorize(request) {
      if (hasValidSession(request)) return { ok: true };
      return {
        ok: false,
        status: 401,
        code: 'local-session-required',
        message: 'Open the secure launch URL shown in the terminal.',
      };
    },

    claim({ request, payload, capability }) {
      if (!isLoopbackAddress(request?.socket?.remoteAddress)) {
        return { ok: false, status: 403, code: 'loopback-required', message: 'Local session claims require loopback.' };
      }
      if (!exactObject(payload, ['protocolVersion']) || payload.protocolVersion !== LOCAL_SESSION_PROTOCOL_VERSION) {
        return { ok: false, status: 400, code: 'invalid-claim', message: 'The local session claim is invalid.' };
      }
      if (claimed || !bootstrap) {
        return { ok: false, status: 409, code: 'claim-consumed', message: 'The local session claim was already used.' };
      }

      const candidate = decodeToken(capability);
      const matches = timingSafeEqual(bootstrap, candidate.value);
      if (!candidate.canonical || !matches) {
        return { ok: false, status: 401, code: 'invalid-claim', message: 'The local session claim is invalid.' };
      }

      claimed = true;
      bootstrap.fill(0);
      bootstrap = null;
      const session = Buffer.from(random(TOKEN_BYTES));
      if (session.length !== TOKEN_BYTES) throw new TypeError(`The random source must return ${TOKEN_BYTES} bytes.`);
      sessionDigest = digest(session);
      const attributes = [`${cookieName}=${encodeToken(session)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/'];
      if (secureCookie) attributes.push('Secure');
      session.fill(0);
      return { ok: true, cookie: attributes.join('; ') };
    },
  });
}
