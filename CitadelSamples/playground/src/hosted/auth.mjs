import { createHash } from 'node:crypto';
import { ConfidentialClientApplication, PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-node';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { createHttpsTransport } from './httpsTransport.mjs';
import { GUID, httpsOrigin } from './config.mjs';
import { purposeScopes } from './credentialPurposes.mjs';

export function createMicrosoftAuth(config, { fetchImpl = createHttpsTransport(), verifyKey } = {}) {
  if (config.logoutRedirect !== undefined && config.logoutRedirect !== `${config.origin}/`) {
    throw new TypeError('The sign-out return must be the fixed application root.');
  }
  const authority = `${config.cloud.loginEndpoint}/${config.tenantId}`;
  const issuer = `${config.cloud.tokenIssuerBase}/${config.tenantId}/v2.0`;
  const allowedOrigins = new Set([config.cloud.loginEndpoint, config.cloud.tokenIssuerBase]);
  async function fetchIdentity(url, options) {
    if (!allowedOrigins.has(new URL(url).origin)) throw new Error('Identity endpoint outside the selected Azure cloud.');
    return fetchImpl(url, options);
  }
  const key = verifyKey ?? createRemoteJWKSet(new URL(`${authority}/discovery/v2.0/keys`), {
    [customFetch]: fetchIdentity, timeoutDuration: 10000, cooldownDuration: 30000,
  });
  function client(method = 'browser', { signal, onResponse } = {}) {
    if (!['browser', 'device-code'].includes(method)) throw new TypeError('Unknown authentication method.');
    const device = method === 'device-code';
    if (device && (!GUID.test(config.deviceClientId ?? '') || config.deviceClientId === config.clientId)) {
      throw new TypeError('A dedicated public client is required.');
    }
    async function network(url, options = {}, verb) {
      signal?.throwIfAborted();
      const response = await fetchIdentity(url, { ...options, method: verb, body: options.body,
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]) });
      const body = await response.json();
      signal?.throwIfAborted();
      onResponse?.(url, body);
      return { status: response.status, headers: Object.fromEntries(response.headers), body };
    }
    const Application = device ? PublicClientApplication : ConfidentialClientApplication;
    return new Application({
      auth: { clientId: device ? config.deviceClientId : config.clientId, authority,
        ...(!device ? { clientSecret: config.clientSecret } : {}),
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
  async function verifyResult(tx, result, { device = false, signal } = {}) {
    signal?.throwIfAborted();
    if (!result?.idToken || !result.account) throw new Error('Missing identity result.');
    const audience = device ? config.deviceClientId : config.clientId;
    const verificationKey = !device || verifyKey ? key : createRemoteJWKSet(new URL(`${authority}/discovery/v2.0/keys`), {
      [customFetch]: (url, options) => fetchIdentity(url, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) }),
      timeoutDuration: 10000, cooldownDuration: 30000,
    });
    const { payload } = await jwtVerify(result.idToken, verificationKey, {
      issuer, audience, algorithms: ['RS256'], maxTokenAge: config.absoluteMs / 1000,
      requiredClaims: ['exp', 'iat', 'nbf', 'sub', 'tid', 'oid', ...(!device ? ['nonce'] : [])],
    });
    signal?.throwIfAborted();
    if ((!device && payload.nonce !== tx.nonce) || payload.aud !== audience || payload.tid !== config.tenantId
      || !GUID.test(payload.oid ?? '') || result.account.localAccountId !== payload.oid
      || result.account.tenantId !== payload.tid || (tx.expectedOid && tx.expectedOid !== payload.oid)
      || (tx.expectedTid && tx.expectedTid !== payload.tid)
      || (tx.expectedHomeAccountId && tx.expectedHomeAccountId !== result.account.homeAccountId)) {
      throw new Error('The sign-in identity did not match the requested transaction.');
    }
    const credential = {
      method: device ? 'device-code' : 'browser', clientKind: device ? 'public' : 'confidential',
      clientId: audience, authority, purpose: tx.purpose, account: result.account,
      requestedScopes: purposeScopes(config, tx.purpose), validatedScopes: result.scopes ?? [],
      cache: device ? tx.client.getTokenCache().serialize() : tx.client, grantGeneration: 1,
    };
    return { claims: payload, account: result.account, cache: credential.cache, azure: tx.purpose === 'azure',
      credentials: tx.purpose === 'signin' ? {} : { [tx.purpose]: credential } };
  }
  return Object.freeze({
    client, verifyDevice: (tx, result, signal) => verifyResult(tx, result, { device: true, signal }),
    async start(tx, session) {
      const url = await tx.client.getAuthCodeUrl({
        scopes: purposeScopes(config, tx.purpose),
        redirectUri: config.callback, responseMode: 'query',
        codeChallenge: createHash('sha256').update(tx.verifier).digest('base64url'),
        codeChallengeMethod: 'S256', state: tx.state, nonce: tx.nonce,
        ...(tx.purpose !== 'signin'
          ? { loginHint: session.account?.username }
          : { prompt: 'select_account' }),
      });
      const endpoint = new URL(url);
      if (!allowedOrigins.has(httpsOrigin(endpoint.origin)) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Unexpected authorization endpoint.');
      return url;
    },
    async finish(tx, code) {
      const result = await tx.client.acquireTokenByCode({
        code, scopes: purposeScopes(config, tx.purpose),
        redirectUri: config.callback, codeVerifier: tx.verifier,
      });
      return verifyResult(tx, result);
    },
    async token(session, purpose = 'azure', { signal: operationSignal } = {}) {
      const scopes = purposeScopes(config, purpose);
      if (purpose === 'signin') throw new TypeError('Sign-in is not a resource credential.');
      const credential = session.credentials?.[purpose]
        ?? (purpose === 'azure' && session.azure ? { account: session.account, cache: session.cache } : null);
      const code = purpose === 'azure' ? 'azure' : 'resource';
      if (!credential?.account || !credential.cache || (purpose === 'azure' && !session.azure)) {
        throw Object.assign(new Error(purpose === 'azure'
          ? 'Connect Azure from the application to authorize this account for Azure operations.'
          : 'Resolve the target and connect this resource in the application.'), { status: 409, code: `${code}-consent-required` });
      }
      const version = session.contextVersion, controller = session.controller;
      const reconnect = () => {
        if (session.credentials) delete session.credentials[purpose];
        if (purpose === 'azure') { session.azure = false; session.cache = null; }
        if (session.invalidateContext) session.invalidateContext();
        else { session.subscription = null; session.review = null; session.contextVersion++; session.run?.controller.abort(); }
        throw Object.assign(new Error('Resource authorization expired or requires interaction. Reconnect in this application.'), { status: 401, code: `${code}-consent-required` });
      };
      if (credential.account.localAccountId !== session.claims.oid || credential.account.tenantId !== session.claims.tid) reconnect();
      if (credential.clientKind === 'public') {
        if (credential.method !== 'device-code' || credential.clientId !== config.deviceClientId
          || credential.authority !== authority || credential.purpose !== purpose || typeof credential.cache !== 'string') reconnect();
      } else if (credential.clientKind && (credential.clientKind !== 'confidential' || credential.clientId !== config.clientId
        || credential.authority !== authority || credential.purpose !== purpose)) reconnect();
      let result, acquisition;
      try {
        if (credential.clientKind === 'public') {
          const signal = AbortSignal.any([...(controller ? [controller.signal] : []),
            ...(operationSignal ? [operationSignal] : []),
            ...(session.contextController ? [session.contextController.signal] : []), AbortSignal.timeout(10000)]);
          acquisition = client('device-code', { signal });
          acquisition.getTokenCache().deserialize(credential.cache);
        } else {
          acquisition = credential.cache;
        }
        result = await acquisition.acquireTokenSilent({ account: credential.account, scopes });
      }
      catch (error) {
        if (operationSignal?.aborted || controller?.signal.aborted || session.contextVersion !== version) {
          throw Object.assign(new Error('Execution context changed during token acquisition.'), { status: 409, code: 'context-changed' });
        }
        if (error instanceof InteractionRequiredAuthError
          || ['invalid_grant', 'no_tokens_found', 'token_refresh_required', 'no_account_in_silent_request'].includes(error?.errorCode)) reconnect();
        throw Object.assign(new Error('Resource token acquisition is unavailable. Retry explicitly, or ask the deployment owner to check the confidential credential and identity service.'), { status: 503, code: `${code}-token-unavailable` });
      }
      if (operationSignal?.aborted || controller?.signal.aborted || session.contextVersion !== version || session.authPending) {
        throw Object.assign(new Error('Execution context changed during token acquisition.'), { status: 409, code: 'context-changed' });
      }
      if (result.account?.localAccountId !== session.claims.oid || result.account?.tenantId !== session.claims.tid
        || typeof result.accessToken !== 'string' || !result.accessToken
        || !(result.expiresOn instanceof Date) || !Number.isFinite(result.expiresOn.getTime())
        || result.expiresOn.getTime() <= Date.now()) reconnect();
      if (credential.account.homeAccountId && result.account.homeAccountId !== credential.account.homeAccountId) reconnect();
      if (credential.clientKind === 'public') credential.cache = acquisition.getTokenCache().serialize();
      return result.accessToken;
    },
    logoutUrl: `${authority}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(config.logoutRedirect ?? config.origin + '/')}`,
  });
}
