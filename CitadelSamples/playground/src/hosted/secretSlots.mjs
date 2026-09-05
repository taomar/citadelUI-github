import { randomToken } from './sessions.mjs';
import { digest, exact, immutable, refuse } from './request.mjs';

export function validateCredentialTarget(target) {
  exact(target, ['resourceId', 'origin', 'routes', 'headerName']);
  const url = new URL(target.origin);
  if (!/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.ApiManagement\/service\/[^/]+\/subscriptions\/[^/]+$/i.test(target.resourceId)
    || url.protocol !== 'https:' || url.origin !== target.origin || url.username || url.password
    || !Array.isArray(target.routes) || !target.routes.length || target.routes.length > 20
    || target.routes.some((route) => typeof route !== 'string' || !route.startsWith('/') || /[?#\\\s]/.test(route))
    || !/^[A-Za-z0-9-]{1,64}$/.test(target.headerName)
    || /^(authorization|cookie|host|origin|proxy-authorization|x-citadel-csrf|content-length)$/i.test(target.headerName)) {
    refuse('Invalid credential target.', 'invalid-secret-binding', 400);
  }
  return immutable(target);
}

export function createSecretSlots(sessions, { now = sessions.now, maxSlots = 1000 } = {}) {
  const slots = new Map();
  let generation = 0;
  function remove(id) {
    const slot = slots.get(id);
    if (slot) slot.value = null;
    slots.delete(id);
  }
  function sweep() {
    for (const [id, slot] of slots) if (slot.expiresAt <= now() || !sessions.authorized(slot.session)
      || slot.session.contextVersion !== slot.contextVersion) remove(id);
  }
  function revokeSession(session) {
    for (const [id, slot] of slots) if (slot.session === session) remove(id);
  }
  const unsubscribe = sessions.onInvalidate(revokeSession);
  return Object.freeze({
    putGenerated(session, { value, target, field = 'gatewayAccess.apiKey' }) {
      sweep();
      if (!sessions.authorized(session) || session.authPending) refuse('Operator required.', 'operator-required', 403);
      if (field !== 'gatewayAccess.apiKey' || typeof value !== 'string' || !value || value.length > 4096 || /[\r\n\0]/.test(value)) {
        refuse('Invalid generated credential.', 'invalid-secret-binding', 400);
      }
      target = validateCredentialTarget(target);
      const targetDigest = digest(target);
      for (const [id, slot] of slots) if (slot.session === session && slot.field === field && slot.targetDigest === targetDigest) {
        remove(id);
        session.review = null;
        session.stagedReview = null;
      }
      if (slots.size >= maxSlots) refuse('Credential capacity reached.', 'secret-capacity', 429);
      const slotId = randomToken(), expiresAt = Math.min(now() + 1800000, session.created + 28800000, session.claims.exp * 1000);
      slots.set(slotId, { value, session, field, target: immutable(target), targetDigest,
        contextVersion: session.contextVersion, generation: ++generation, expiresAt });
      return { slotId, generation, field, expiresAt, targetLabel: target.resourceId };
    },
    resolveBinding(session, field, binding, target) {
      sweep();
      const slot = slots.get(binding.slotId);
      if (!slot || slot.session !== session || slot.field !== field || slot.generation !== binding.generation
        || session.authPending || slot.targetDigest !== digest(target)) {
        refuse('Credential expired, changed owner or targets a different route.', 'secret-binding-changed');
      }
      return slot.value;
    },
    describe(session, field, binding) {
      sweep();
      const slot = slots.get(binding.slotId);
      if (!slot || slot.session !== session || slot.field !== field || slot.generation !== binding.generation || session.authPending) {
        refuse('Credential binding is unavailable.', 'secret-binding-changed');
      }
      return { slotId: binding.slotId, generation: slot.generation, target: slot.target, expiresAt: slot.expiresAt };
    },
    revokeSession,
    revokeTarget(resourceId) {
      for (const [id, slot] of slots) if (slot.target.resourceId.toLowerCase() === resourceId.toLowerCase()) {
        slot.session.review = null;
        slot.session.stagedReview = null;
        slot.session.run?.controller.abort();
        remove(id);
      }
    },
    close() { unsubscribe(); for (const id of slots.keys()) remove(id); },
  });
}
