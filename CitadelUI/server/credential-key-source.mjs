/**
 * Where the credential key comes from.
 *
 * ## Why this module exists
 *
 * `credentials.mjs` used to read the key-encryption key from one place: a path
 * on disk. That is exactly right for a container you run yourself, and wrong for
 * a container you run in Azure, where there is no host to mount a file from and
 * the correct home for key material is a vault.
 *
 * So the *source* of the key becomes a seam, and only the source. The envelope
 * scheme, the AES-256-GCM sealing, the AAD binding and the fail-closed behaviour
 * are untouched and untouchable — a vault that produces the wrong key must fail
 * in precisely the way a wrong key file fails today, because those failures are
 * already tested and already correct.
 *
 * ## Why not the Azure SDK
 *
 * This application has no `package.json`, no lockfile and no `node_modules`, and
 * its Dockerfile deletes `npm` from the runtime image. That is a deliberate
 * supply-chain position, and it is a load-bearing part of the promise the
 * product makes: an application that holds encrypted GitHub tokens is one you
 * should be able to read in an afternoon.
 *
 * `@azure/identity` plus `@azure/keyvault-secrets` would buy convenience with
 * roughly forty transitive packages, a first-ever lockfile, and the restoration
 * of `npm` to a hardened image. To read one secret, once, at startup. The
 * documented REST contract costs sixty auditable lines instead, so that is what
 * this does.
 *
 * ## The contract, as documented by Azure Container Apps
 *
 *   GET ${IDENTITY_ENDPOINT}?resource=https://vault.azure.net
 *        &api-version=2019-08-01&client_id=${AZURE_CLIENT_ID}
 *   x-identity-header: ${IDENTITY_HEADER}
 *
 * `client_id` is not optional here. It is absent from the documented example
 * because that example uses the *system*-assigned identity; we use a
 * user-assigned one, and without the client id the platform resolves a
 * different principal or refuses outright — at runtime, in Azure, on the first
 * save, which is the most expensive place to learn it.
 *
 * ## Redaction
 *
 * Nothing here logs. Not the token, not the identity header, not the secret, not
 * the vault host paired with the secret name. Failures are reported as fixed
 * state names chosen from a closed set, because a reason string that quotes the
 * thing that failed is how key material ends up in a log aggregator.
 */

const KEY_VAULT_RESOURCE = 'https://vault.azure.net';
const KEY_VAULT_API_VERSION = '7.4';
const IDENTITY_API_VERSION = '2019-08-01';
const SECRET_NAME = /^[0-9a-zA-Z-]{1,127}$/;
/**
 * Accept only the Azure Key Vault data-plane suffixes. The vault URI arrives
 * from configuration, and configuration is a place a mistake can send a bearer
 * token somewhere it should never go. An allow-list is cheap; recovering from a
 * leaked token is not.
 */
const VAULT_HOST = /^[a-z0-9][a-z0-9-]{1,126}\.vault\.(azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)$/;
const MAX_KEY_MATERIAL_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 5000;
/**
 * Refresh five minutes early. A token that expires between the check and the
 * call is a fault that appears only under load and only sometimes, which is the
 * worst kind to diagnose.
 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const KEY_SOURCE_FILE = 'file';
export const KEY_SOURCE_KEY_VAULT = 'keyvault';

/**
 * A key file on disk: the original behaviour, moved behind the seam unchanged.
 *
 * The reason names are deliberately the same strings as before. They are
 * asserted by the existing vault tests and shown to the operator, and renaming
 * them to look tidier next to their Key Vault counterparts would be a breaking
 * change bought with nothing.
 */
export class FileKeySource {
  constructor(options = {}) {
    this.keyFile = options.keyFile ?? null;
    this.readFile = options.readFile ?? null;
  }

  get kind() {
    return KEY_SOURCE_FILE;
  }

  get invalidReason() {
    return 'key-file-invalid';
  }

  async read() {
    if (!this.keyFile || typeof this.keyFile !== 'string') {
      return { bytes: null, reason: 'no-key-file' };
    }
    const readFile = this.readFile ?? (await import('node:fs/promises')).readFile;
    try {
      return { bytes: await readFile(this.keyFile), reason: 'ready' };
    } catch {
      return { bytes: null, reason: 'key-file-unreadable' };
    }
  }
}

/**
 * A secret in Azure Key Vault, reached with a managed identity.
 *
 * Every failure — no identity endpoint, no vault, a non-200, a body that is not
 * shaped like a token, a secret that is not text — returns `null` bytes and a
 * state name. None of them throw, and none of them fall back to "unencrypted".
 * An unreachable vault must look exactly like an absent key file: the product
 * runs, persistence is unavailable, and the UI says so.
 */
export class KeyVaultKeySource {
  constructor(options = {}) {
    this.vaultUri = normaliseVaultUri(options.vaultUri);
    this.secretName = typeof options.secretName === 'string' ? options.secretName.trim() : '';
    this.clientId = typeof options.clientId === 'string' ? options.clientId.trim() : '';
    this.identityEndpoint =
      typeof options.identityEndpoint === 'string' ? options.identityEndpoint.trim() : '';
    this.identityHeader =
      typeof options.identityHeader === 'string' ? options.identityHeader.trim() : '';
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get kind() {
    return KEY_SOURCE_KEY_VAULT;
  }

  get invalidReason() {
    return 'key-vault-invalid';
  }

  /**
   * Refuse before reaching the network if configuration cannot possibly work.
   *
   * Separated out so the failure is attributable: "you did not set the vault"
   * and "the vault said no" are different operator problems and deserve
   * different names.
   */
  configurationReason() {
    if (!this.vaultUri || !this.secretName || !SECRET_NAME.test(this.secretName)) {
      return 'no-key-vault';
    }
    if (!this.identityEndpoint || !this.identityHeader || !this.clientId) {
      return 'no-managed-identity';
    }
    if (typeof this.fetchImpl !== 'function') {
      return 'key-vault-unreadable';
    }
    return null;
  }

  async accessToken() {
    if (this.token && this.now() < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.token;
    }
    const url = new URL(this.identityEndpoint);
    url.searchParams.set('api-version', IDENTITY_API_VERSION);
    url.searchParams.set('resource', KEY_VAULT_RESOURCE);
    url.searchParams.set('client_id', this.clientId);

    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { 'x-identity-header': this.identityHeader },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response || response.status !== 200) return null;

    const body = await response.json();
    // A 200 with an unexpected body is not a token. Check the shape before
    // trusting it rather than discovering the problem as an `undefined` in an
    // Authorization header.
    if (!body || typeof body.access_token !== 'string' || !body.access_token) return null;

    const expiresOn = Number(body.expires_on);
    // `expires_on` is documented as seconds since the epoch, as text. If it is
    // missing or unparseable, treat the token as good for one minute only:
    // short enough to be harmless, long enough to complete this startup.
    this.tokenExpiresAt = Number.isFinite(expiresOn)
      ? expiresOn * 1000
      : this.now() + TOKEN_REFRESH_MARGIN_MS + 60_000;
    this.token = body.access_token;
    return this.token;
  }

  async read() {
    const misconfigured = this.configurationReason();
    if (misconfigured) return { bytes: null, reason: misconfigured };

    try {
      const token = await this.accessToken();
      if (!token) return { bytes: null, reason: 'key-vault-unreadable' };

      const url = `${this.vaultUri}secrets/${encodeURIComponent(this.secretName)}?api-version=${KEY_VAULT_API_VERSION}`;
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response || response.status !== 200) {
        // A 401 most likely means the token went stale between calls. Drop it so
        // the next attempt re-acquires rather than replaying a dead credential.
        if (response && response.status === 401) this.token = null;
        return { bytes: null, reason: 'key-vault-unreadable' };
      }

      const body = await response.json();
      if (!body || typeof body.value !== 'string' || !body.value) {
        return { bytes: null, reason: 'key-vault-unreadable' };
      }
      const bytes = Buffer.from(body.value, 'utf8');
      if (!bytes.length || bytes.length > MAX_KEY_MATERIAL_BYTES) {
        bytes.fill(0);
        return { bytes: null, reason: 'key-vault-unreadable' };
      }
      return { bytes, reason: 'ready' };
    } catch {
      // Timeout, DNS, TLS, a malformed JSON body, an aborted signal. The vault
      // is unreachable; that is one answer, not five.
      return { bytes: null, reason: 'key-vault-unreadable' };
    }
  }
}

/**
 * Require `https`, a known vault suffix and no path, then return the origin with
 * a single trailing slash so callers can append without guessing.
 */
function normaliseVaultUri(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.port || !VAULT_HOST.test(url.hostname)) return '';
  return `${url.origin}/`;
}

/**
 * Choose the source.
 *
 * An explicitly injected source wins, so tests and callers can supply their own.
 * Otherwise `CITADEL_CREDENTIAL_KEY_SOURCE` decides, and its absence means the
 * file — every existing deployment must keep working without being edited.
 *
 * An unrecognised value is NOT treated as "file". Silently falling back would
 * mean a typo in `keyvault` produces a container that quietly has no key, and
 * the operator would see "persistence unavailable" while believing they had
 * configured a vault.
 */
export function createKeySource(options = {}, env = process.env) {
  if (options.keySource) return options.keySource;

  const requested = String(options.keySourceKind ?? env.CITADEL_CREDENTIAL_KEY_SOURCE ?? KEY_SOURCE_FILE)
    .trim()
    .toLowerCase();

  if (requested === KEY_SOURCE_KEY_VAULT) {
    return new KeyVaultKeySource({
      vaultUri: options.vaultUri ?? env.CITADEL_KEY_VAULT_URI,
      secretName: options.secretName ?? env.CITADEL_CREDENTIAL_SECRET_NAME,
      clientId: options.clientId ?? env.AZURE_CLIENT_ID,
      identityEndpoint: options.identityEndpoint ?? env.IDENTITY_ENDPOINT,
      identityHeader: options.identityHeader ?? env.IDENTITY_HEADER,
      fetch: options.fetch,
      now: options.now,
    });
  }

  if (requested !== KEY_SOURCE_FILE) {
    return new UnknownKeySource(requested);
  }

  return new FileKeySource({
    keyFile: options.keyFile ?? env.CITADEL_CREDENTIAL_KEY_FILE ?? null,
  });
}

/** A configured source name we do not implement. Fails closed and says why. */
class UnknownKeySource {
  get kind() {
    return 'unknown';
  }

  get invalidReason() {
    return 'key-source-unknown';
  }

  async read() {
    return { bytes: null, reason: 'key-source-unknown' };
  }
}
