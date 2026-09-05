const BOOTSTRAP_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_ENDPOINT = '/api/session/claim';
const PROTOCOL_VERSION = 1;

export function consumeBootstrapCapability({
  locationRef = globalThis.location,
  historyRef = globalThis.history,
} = {}) {
  const hash = String(locationRef?.hash ?? '');
  if (!hash.startsWith('#bootstrap=')) return null;
  historyRef?.replaceState?.(
    null,
    '',
    `${locationRef.pathname ?? '/'}${locationRef.search ?? ''}`,
  );
  const match = hash.match(/^#bootstrap=([A-Za-z0-9_-]{43})$/);
  return match?.[1] ?? null;
}

export function normalizeSessionAuthDescriptor(value = {}) {
  const state = ['claimed', 'unclaimed', 'not-required'].includes(value.state)
    ? value.state
    : 'unclaimed';
  const endpoint =
    typeof value.claimEndpoint === 'string' && value.claimEndpoint === CLAIM_ENDPOINT
      ? value.claimEndpoint
      : null;
  return Object.freeze({
    required: value.required === true,
    state,
    claimEndpoint: endpoint,
    message: typeof value.message === 'string' ? value.message : '',
  });
}

export async function claimBrowserSession({
  descriptor,
  capability,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const sessionAuth = normalizeSessionAuthDescriptor(descriptor);
  if (!sessionAuth.required || sessionAuth.state !== 'unclaimed') {
    return Object.freeze({ claimed: sessionAuth.state === 'claimed', skipped: true });
  }
  if (!sessionAuth.claimEndpoint || !BOOTSTRAP_PATTERN.test(String(capability ?? ''))) {
    return Object.freeze({ claimed: false, skipped: false, reason: 'missing-capability' });
  }
  if (typeof fetchImpl !== 'function') {
    return Object.freeze({ claimed: false, skipped: false, reason: 'fetch-unavailable' });
  }

  const response = await fetchImpl(sessionAuth.claimEndpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Citadel-Bootstrap-Capability': capability,
    },
    body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }),
    signal,
  });
  return Object.freeze({
    claimed: response.status === 204,
    skipped: false,
    reason: response.status === 204 ? '' : `http-${response.status}`,
  });
}
