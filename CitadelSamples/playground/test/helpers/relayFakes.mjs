/**
 * Small relay test fixtures shared across `test/relay/*.test.mjs`.
 */

/**
 * A requestPolicy stand-in for tests that are not themselves exercising
 * per-sample/per-step request-policy enforcement. `createRelayHttpExecutor`
 * requires a requestPolicy structurally (see `src/relay/httpExecutor.mjs`) —
 * this fixture authorizes every URL/header unconditionally, so tests about
 * redirects, size limits, timeouts, bursts, secrets, etc. do not have to
 * hand-enumerate a real per-sample policy just to satisfy that requirement.
 */
export function allowAllRequestPolicy() {
  return Object.freeze({
    authorizeRequestUrl: () => ({ ok: true }),
    authorizeHeaderNames: () => ({ ok: true }),
  });
}
