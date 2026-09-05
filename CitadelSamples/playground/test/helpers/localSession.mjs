import {
  LOCAL_SESSION_BOOTSTRAP_HEADER,
  LOCAL_SESSION_CLAIM_PATH,
  LOCAL_SESSION_PROTOCOL_VERSION,
} from '../../src/core/localSession.mjs';

export const TEST_BOOTSTRAP_CAPABILITY = 'A'.repeat(43);

export async function claimLocalSession(baseUrl, bootstrapCapability = TEST_BOOTSTRAP_CAPABILITY) {
  const response = await fetch(new URL(LOCAL_SESSION_CLAIM_PATH, baseUrl), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: baseUrl,
      'Sec-Fetch-Site': 'same-origin',
      [LOCAL_SESSION_BOOTSTRAP_HEADER]: bootstrapCapability,
    },
    body: JSON.stringify({ protocolVersion: LOCAL_SESSION_PROTOCOL_VERSION }),
  });
  if (response.status !== 204) {
    throw new Error(`Local session claim failed with HTTP ${response.status}: ${await response.text()}`);
  }
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';', 1)[0];
  if (!cookie.includes('=')) throw new Error('Local session claim did not return a cookie.');
  return { cookie, setCookie };
}

export function createAuthenticatedFetch(baseUrl, cookie) {
  return (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookie);
    if (String(init.method ?? 'GET').toUpperCase() === 'POST') {
      if (!headers.has('Origin')) headers.set('Origin', baseUrl);
      if (!headers.has('Sec-Fetch-Site')) headers.set('Sec-Fetch-Site', 'same-origin');
    }
    return fetch(new URL(path, baseUrl), { ...init, headers });
  };
}
