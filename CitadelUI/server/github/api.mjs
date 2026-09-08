/**
 * Fixed-host GitHub API client.
 *
 * This module is the only place in Citadel UI that performs outbound network
 * I/O. The host is a constant, request paths are validated as relative API
 * paths, redirects are never followed, and response bodies are bounded before
 * they are parsed. A credential is supplied per call by the session store and is
 * never stored, echoed, or included in an error.
 */
export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'CitadelUI/1.0 (+local)';

const DEFAULT_JSON_LIMIT = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;

/**
 * A GitHub failure that is safe to show a user.
 *
 * `Authorization`, token material, and GitHub request identifiers are never
 * carried into the message.
 */
export function githubError(status, code, message, detail = null) {
  return Object.assign(new Error(message), { status, code, github: true }, detail || {});
}

const REDACTED = '[redacted]';
const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /\bBearer\s+\S+/gi,
  /\btoken\s+\S+/gi,
];

/**
 * Remove anything credential-shaped from text that may reach a user or a log.
 * Applied defensively: no caller is permitted to put a token in a message, and
 * this makes an accidental one non-recoverable.
 */
export function redactSecrets(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REDACTED);
  return text;
}

/**
 * Validate a GitHub API path.
 *
 * Only relative paths under the fixed origin are accepted. Absolute URLs,
 * protocol-relative paths, traversal, and control characters are rejected so a
 * response value can never redirect Citadel UI to another host.
 */
export function assertApiPath(path) {
  const value = String(path ?? '');
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw githubError(400, 'INVALID_GITHUB_PATH', 'GitHub API path must be origin-relative.');
  }
  if (/[\u0000-\u001f\u007f\s\\]/.test(value)) {
    throw githubError(400, 'INVALID_GITHUB_PATH', 'GitHub API path contains invalid characters.');
  }
  if (value.length > 2048) {
    throw githubError(400, 'INVALID_GITHUB_PATH', 'GitHub API path is too long.');
  }
  const [pathname] = value.split('?', 1);
  if (pathname.split('/').some((part) => part === '.' || part === '..')) {
    throw githubError(400, 'INVALID_GITHUB_PATH', 'GitHub API path must not traverse.');
  }
  const target = new URL(value, GITHUB_API_ORIGIN);
  if (target.origin !== GITHUB_API_ORIGIN) {
    throw githubError(400, 'INVALID_GITHUB_PATH', 'GitHub requests are limited to api.github.com.');
  }
  return target;
}

function describeStatus(status, fallback) {
  if (status === 401) return 'GitHub rejected the credential. Reconnect GitHub.';
  if (status === 403) return 'GitHub denied the request. Check the token repository permissions.';
  if (status === 404) return 'GitHub returned no such resource for this credential.';
  if (status === 409) return 'GitHub reported a conflicting repository state.';
  if (status === 422) return 'GitHub rejected the request as invalid.';
  if (status === 429) return 'GitHub rate limit reached. Wait before retrying.';
  if (status >= 500) return 'GitHub is unavailable. Try again later.';
  return fallback;
}

function rejectRateLimit(response, rate, message = '') {
  const retry = response.headers.get('retry-after');
  const seconds = retry && /^\d+$/.test(retry) ? Math.min(Number(retry), 86_400) : null;
  if (
    response.status !== 429 &&
    !(response.status === 403 && (rate.remaining === 0 || seconds !== null || /rate limit|abuse detection/i.test(message)))
  ) return;
  const rateResetAt = Number.isFinite(rate.reset) && rate.reset > 0 && rate.reset < 8_640_000_000
    ? new Date(rate.reset * 1000).toISOString()
    : null;
  throw githubError(response.status, 'GITHUB_RATE_LIMITED', 'GitHub rate limit reached. Wait before resuming this operation.', {
    retryAfterSeconds: seconds,
    rateResetAt,
  });
}

async function readBounded(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw githubError(502, 'GITHUB_RESPONSE_TOO_LARGE', 'GitHub response exceeds the safety limit.');
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) {
      throw githubError(
        502,
        'GITHUB_RESPONSE_TOO_LARGE',
        'GitHub response exceeds the safety limit.'
      );
    }
    return buffer;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      throw githubError(
        502,
        'GITHUB_RESPONSE_TOO_LARGE',
        'GitHub response exceeds the safety limit.'
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export class GitHubApiClient {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Math.min(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.jsonLimit = Number(options.jsonLimit) || DEFAULT_JSON_LIMIT;
  }

  /**
   * Perform one bounded GitHub call.
   *
   * @param {string} path origin-relative API path
   * @param {object} options `token` is used once for this call and not retained
   */
  async request(path, options = {}) {
    const target = assertApiPath(path);
    const method = String(options.method || 'GET').toUpperCase();
    if (options.anonymous && (method !== 'GET' || options.token || options.body !== undefined)) {
      throw githubError(400, 'PUBLIC_DONOR_READ_ONLY', 'Anonymous GitHub donor reads cannot carry credentials or mutations.');
    }
    if (options.migrationRead && (method !== 'GET' || options.body !== undefined)) {
      throw githubError(400, 'GITHUB_DONOR_READ_ONLY', 'GitHub donor operations are read-only.');
    }
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw githubError(400, 'INVALID_GITHUB_METHOD', 'Unsupported GitHub method.');
    }
    const headers = {
      Accept: options.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': USER_AGENT,
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let bytes;
    try {
      response = await this.fetch(target.href, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
        cache: 'no-store',
      });
      if (response.status >= 300 && response.status < 400) {
        throw githubError(502, 'GITHUB_REDIRECT', 'GitHub redirected the request and it was refused.');
      }
      if ((options.anonymous || options.migrationRead) && (response.status < 200 || response.status >= 300)) {
        // Donor failures must not read or echo upstream bodies, even when the
        // general client supports authenticated writes for repository creation.
        const limited = response.status === 429 || (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
        if (typeof response.body?.cancel === 'function') await response.body.cancel().catch(() => {});
        throw githubError(
          limited ? 429 : response.status < 500 ? response.status : 502,
          limited ? 'PUBLIC_DONOR_RATE_LIMIT' : 'PUBLIC_DONOR_READ_FAILED',
          limited ? 'GitHub donor rate limit reached.' : 'The GitHub donor read failed.'
        );
      }
      // Keep the deadline active through streaming, not just response headers.
      bytes = await readBounded(response, options.limit || this.jsonLimit);
    } catch (error) {
      if (error?.github) {
        controller.abort();
        throw error;
      }
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw githubError(504, 'GITHUB_TIMEOUT', 'GitHub did not respond in time.');
      }
      throw githubError(502, 'GITHUB_UNREACHABLE', 'Citadel UI could not reach GitHub.');
    } finally {
      clearTimeout(timer);
    }

    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const rate = {
      remaining: remaining === null ? null : Number(remaining),
      reset: reset === null ? null : Number(reset),
    };
    const link = response.headers.get('link') || '';
    const ok = response.status >= 200 && response.status < 300;

    if (bytes.length === 0) {
      if (ok) return { status: response.status, data: null, link, rate };
      rejectRateLimit(response, rate);
      throw githubError(
        response.status < 500 ? response.status : 502,
        'GITHUB_REQUEST_FAILED',
        describeStatus(response.status, 'GitHub rejected the request.')
      );
    }

    if (options.raw && ok) {
      return { status: response.status, bytes, link, rate };
    }

    let data;
    try {
      data = JSON.parse(bytes.toString('utf8'));
    } catch {
      if (!ok) {
        rejectRateLimit(response, rate);
        throw githubError(
          response.status < 500 ? response.status : 502,
          'GITHUB_REQUEST_FAILED',
          describeStatus(response.status, 'GitHub rejected the request.')
        );
      }
      throw githubError(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned an unreadable response.');
    }

    if (!ok) {
      rejectRateLimit(response, rate, typeof data?.message === 'string' ? data.message : '');
      const detail =
        typeof data?.message === 'string' && data.message.length <= 300
          ? redactSecrets(data.message)
          : null;
      throw githubError(
        response.status < 500 ? response.status : 502,
        'GITHUB_REQUEST_FAILED',
        describeStatus(response.status, detail || 'GitHub rejected the request.')
      );
    }
    return { status: response.status, data, link, rate };
  }

  /**
   * Follow `rel="next"` pagination without trusting the returned URL host.
   * Only the presence of a next link is used; every page path is rebuilt here.
   */
  async paginate(path, options = {}) {
    const maxPages = Math.min(Number(options.maxPages) || 10, 20);
    const perPage = Math.min(Number(options.perPage) || 100, 100);
    const maxItems = Math.min(Number(options.maxItems) || 1000, 5000);
    const items = [];
    let truncated = false;
    for (let page = 1; page <= maxPages; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const { data, link } = await this.request(
        `${path}${separator}per_page=${perPage}&page=${page}`,
        options
      );
      if (options.requireArray && !Array.isArray(data)) {
        throw githubError(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned an invalid paginated list.');
      }
      const batch = Array.isArray(data) ? data : [];
      items.push(...batch);
      if (items.length >= maxItems) {
        truncated = true;
        break;
      }
      if (!/rel="next"/.test(link)) break;
      if (page === maxPages) truncated = true;
    }
    return { items: items.slice(0, maxItems), truncated };
  }
}
