/**
 * Server-side redaction.
 *
 * The browser's `redact()` covers values the user typed. The server sees more:
 * an Azure access token minted by `az account get-access-token`, an APIM
 * subscription key returned by a deployment, a Key Vault secret value. None of
 * those were ever typed, so none of them are in the secret map.
 *
 * Redaction here is therefore two-layered:
 *
 *   1. exact-value replacement for everything the run knows to be a credential,
 *      including values a *step* produced and declared as credential-bearing;
 *   2. shape-based replacement for the credential formats that appear in `az`
 *      and gateway output whether or not this run minted them.
 *
 * Neither layer is the primary defence. The primary defence is that a
 * credential-producing step's output is never placed into evidence at all — the
 * redactor exists so that a mistake somewhere else does not become a leak.
 */

export const REDACTED = '[redacted]';

/**
 * Credential shapes that must never be echoed, whatever produced them.
 *
 * `eyJ…` covers a JWT, which is what every `az account get-access-token`
 * returns. The `Bearer`/`api-key`/`Ocp-Apim-Subscription-Key` forms cover a
 * credential that arrived inside a header line in `--debug` output.
 */
const CREDENTIAL_PATTERNS = Object.freeze([
  // A JSON Web Token: three base64url segments, the first starting `eyJ`.
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  // `Authorization: Bearer <token>` in any casing.
  /(bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi,
  // A subscription-key style header line.
  /((?:api-key|ocp-apim-subscription-key|x-mcp-sub-key)\s*[:=]\s*)[^\s",;]{8,}/gi,
  // `"primaryKey": "…"` / `"apiKey": "…"` in deployment or SDK output.
  /("(?:primary|secondary)?[Kk]ey"\s*:\s*")[^"]{8,}(")/g,
  /("api[Kk]ey"\s*:\s*")[^"]{8,}(")/g,
  /("accessToken"\s*:\s*")[^"]{8,}(")/g,
]);

/**
 * Build a redactor over a set of exact values plus the shape rules.
 * `add()` lets a step register a credential it just produced, so every later
 * step's output is scrubbed of it too.
 */
export function createRedactor(initialValues = []) {
  const values = new Set();
  const add = (value) => {
    // Very short strings would redact half the output; a real credential is
    // never four characters long.
    if (typeof value === 'string' && value.trim().length >= 8) values.add(value.trim());
  };
  for (const value of initialValues) add(value);

  function redactText(text) {
    let out = String(text ?? '');
    // Longest first, so a key that contains another key is replaced whole.
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      out = out.split(value).join(REDACTED);
    }
    for (const pattern of CREDENTIAL_PATTERNS) {
      out = out.replace(pattern, (...args) => {
        // `String.replace` passes (match, ...groups, offset, string). The last
        // argument is itself a string, so filtering by type would wrongly count
        // it as a capture group — slice it off explicitly instead.
        const groups = args.slice(1, -2);
        if (groups.length === 2) return `${groups[0]}${REDACTED}${groups[1]}`;
        if (groups.length === 1) return `${groups[0]}${REDACTED}`;
        return REDACTED;
      });
    }
    return out;
  }

  function redactDeep(value, depth = 0) {
    if (depth > 12) return '[too deep]';
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, depth + 1);
      return out;
    }
    return value;
  }

  return {
    add,
    addAll(list = []) {
      for (const value of list) add(value);
    },
    text: redactText,
    value: redactDeep,
    /** True when the text still contains a known credential value. */
    leaks(text) {
      const scanned = String(text ?? '');
      return [...values].some((value) => scanned.includes(value));
    },
    get size() {
      return values.size;
    },
  };
}

/**
 * Clip captured output to a bound, and say so rather than silently truncating.
 * Applied before redaction so an enormous stdout cannot exhaust memory first.
 */
export function clip(text, limitBytes) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf-8') <= limitBytes) return { text: value, truncated: false };
  const buffer = Buffer.from(value, 'utf-8').subarray(0, limitBytes);
  return {
    text: `${buffer.toString('utf-8')}\n… output truncated at ${limitBytes} bytes.`,
    truncated: true,
  };
}
