/**
 * Destination-origin allowlist for the standalone relay.
 *
 * The relay never trusts a caller-selected host. Every URL it is asked to
 * fetch — the one declared in the plan AND any URL discovered later via a
 * `{{steps.x.y}}` binding — is re-checked here, immediately before the
 * request is made, against an exact, operator-configured list of origins.
 *
 * Checked, all as outright refusals (never a silent rewrite):
 *   - control characters or a backslash anywhere in the raw text
 *   - anything that is not a valid URL
 *   - a URL whose serialised form does not round-trip through a second
 *     parse (guards against parser-confusion / normalisation tricks)
 *   - a scheme other than `https:`
 *   - inline userinfo (`https://user:pass@host/`)
 *   - a fragment
 *   - an origin (scheme + host + port) outside the configured list
 */

const RAW_URL_HAZARD = /[\u0000-\u001f\u007f\\]/;

/**
 * @param {string[]} origins  exact `https://host` or `https://host:port` entries
 */
export function createOriginAllowlist(origins) {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new TypeError('createOriginAllowlist requires at least one https:// origin.');
  }
  const allowed = new Set(origins.map((origin) => normaliseOrigin(origin)));
  return Object.freeze({
    origins: Object.freeze([...allowed]),
    /** @param {string} rawUrl @returns {URL} the parsed, allowed URL */
    assertAllowed(rawUrl) {
      return assertAllowedUrl(rawUrl, allowed);
    },
  });
}

function normaliseOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch {
    throw new TypeError(`"${origin}" is not a valid origin.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new TypeError(`Allowlisted origin "${origin}" must be https.`);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new TypeError(`Allowlisted origin "${origin}" must not carry a path.`);
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError(`Allowlisted origin "${origin}" must not carry a query or fragment.`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError(`Allowlisted origin "${origin}" must not carry credentials.`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Validate one URL against an already-normalised `Set` of allowed origins.
 * Exported so a call site that already holds the set (rather than the
 * `createOriginAllowlist` wrapper) can reuse the exact same checks.
 *
 * @param {string} rawUrl
 * @param {Set<string>} allowedOrigins
 * @returns {URL}
 */
export function assertAllowedUrl(rawUrl, allowedOrigins) {
  const text = String(rawUrl ?? '');
  if (RAW_URL_HAZARD.test(text)) {
    throw new Error('Refused a URL containing a control character or a backslash.');
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`"${text}" is not a URL.`);
  }
  // Re-parse the serialised form. A URL that only becomes "different" after a
  // second normalisation pass is exactly the parser-confusion shape SSRF
  // filters are bypassed with; refuse it rather than trust the first parse.
  const reparsed = new URL(parsed.href);
  if (reparsed.href !== parsed.href) {
    throw new Error('Refused a URL that does not round-trip through normalisation.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refused ${parsed.protocol}//… — the relay only makes https requests.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Refused a URL carrying inline credentials.');
  }
  if (parsed.hash) {
    throw new Error('Refused a URL carrying a fragment.');
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!allowedOrigins.has(origin)) {
    throw new Error(`Refused a request to "${origin}": it is not in the configured destination allowlist.`);
  }
  return parsed;
}
