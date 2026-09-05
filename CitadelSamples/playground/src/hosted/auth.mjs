import { createHash } from 'node:crypto';
import { ConfidentialClientApplication, InteractionRequiredAuthError } from '@azure/msal-node';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { createHttpsTransport } from './httpsTransport.mjs';
import { GUID, httpsOrigin } from './config.mjs';

export function createMicrosoftAuth(config, { fetchImpl = createHttpsTransport(), verifyKey } = {}) {
  const authority = `${config.cloud.loginEndpoint}/${config.tenantId}`;
  const issuer = `${config.cloud.tokenIssuerBase}/${config.tenantId}/v2.0`;
  const armScope = `${config.cloud.resourceManager.replace(/\/?$/, '/')}.default`;
  const allowedOrigins = new Set([config.cloud.loginEndpoint, config.cloud.tokenIssuerBase]);
  async function fetchIdentity(url, options) {
    if (!allowedOrigins.has(new URL(url).origin)) throw new Error('Identity endpoint outside the selected Azure cloud.');
    return fetchImpl(url, options);
  }
  const key = verifyKey ?? createRemoteJWKSet(new URL(`${authority}/discovery/v2.0/keys`), {
    [customFetch]: fetchIdentity, timeoutDuration: 10000, cooldownDuration: 30000,
  });
  async function network(url, options = {}, method) {
    const response = await fetchIdentity(url, { ...options, method, body: options.body });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
  }
  function client() {
    return new ConfidentialClientApplication({
      auth: { clientId: config.clientId, authority, clientSecret: config.clientSecret,
        knownAuthorities: [new URL(authority).host] },
      system: {
        networkClient: {
          sendGetRequestAsync: (url, options) => network(url, options, 'GET'),
          sendPostRequestAsync: (url, options) => network(url, options, 'POST'),
        },
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
      },
    });
  }
  return Object.freeze({
    client,
    async start(tx, session) {
      const url = await tx.client.getAuthCodeUrl({
        scopes: tx.purpose === 'azure' ? [armScope] : ['openid', 'profile'],
        redirectUri: config.callback, responseMode: 'query',
        codeChallenge: createHash('sha256').update(tx.verifier).digest('base64url'),
        codeChallengeMethod: 'S256', state: tx.state, nonce: tx.nonce,
        ...(tx.purpose === 'azure'
          ? { loginHint: session.account?.username }
          : { prompt: 'select_account' }),
      });
      const endpoint = new URL(url);
      if (!allowedOrigins.has(httpsOrigin(endpoint.origin)) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Unexpected authorization endpoint.');
      return url;
    },
    async finish(tx, code) {
      const result = await tx.client.acquireTokenByCode({
        code, scopes: tx.purpose === 'azure' ? [armScope] : ['openid', 'profile'],
        redirectUri: config.callback, codeVerifier: tx.verifier,
      });
      const { payload } = await jwtVerify(result.idToken, key, {
        issuer, audience: config.clientId, algorithms: ['RS256'],
        maxTokenAge: config.absoluteMs / 1000,
        requiredClaims: ['exp', 'iat', 'nbf', 'sub', 'tid', 'oid', 'nonce'],
      });
      if (payload.nonce !== tx.nonce || payload.aud !== config.clientId || payload.tid !== config.tenantId || !GUID.test(payload.oid ?? '')
        || !result.account || result.account.localAccountId !== payload.oid
        || result.account.tenantId !== payload.tid || (tx.expectedOid && tx.expectedOid !== payload.oid)) {
        throw new Error('The sign-in identity did not match the requested transaction.');
      }
      return { claims: payload, account: result.account, cache: tx.client, azure: tx.purpose === 'azure' };
    },
    async token(session) {
      if (!session.azure || !session.account || !session.cache) {
        throw Object.assign(new Error('Connect Azure from the application to authorize this account for Azure operations.'), { status: 409, code: 'azure-consent-required' });
      }
      const reconnect = () => {
        session.azure = false;
        session.cache = null;
        session.subscription = null;
        session.review = null;
        session.contextVersion++;
        session.run?.controller.abort();
        throw Object.assign(new Error('Azure authorization expired or requires interaction. Reconnect Azure in this application.'), { status: 401, code: 'azure-consent-required' });
      };
      let result;
      try { result = await session.cache.acquireTokenSilent({ account: session.account, scopes: [armScope] }); }
      catch (error) {
        if (error instanceof InteractionRequiredAuthError
          || ['invalid_grant', 'no_tokens_found', 'token_refresh_required', 'no_account_in_silent_request'].includes(error?.errorCode)) reconnect();
        throw Object.assign(new Error('Azure token acquisition is unavailable. Retry explicitly, or ask the deployment owner to check the confidential credential and identity service.'), { status: 503, code: 'azure-token-unavailable' });
      }
      if (result.account?.localAccountId !== session.claims.oid || result.account?.tenantId !== session.claims.tid
        || typeof result.accessToken !== 'string' || !result.accessToken
        || !(result.expiresOn instanceof Date) || !Number.isFinite(result.expiresOn.getTime())
        || result.expiresOn.getTime() <= Date.now()) reconnect();
      return result.accessToken;
    },
    logoutUrl: `${authority}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(config.origin + '/')}`,
  });
}
