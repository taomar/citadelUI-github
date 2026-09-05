import { randomToken, sameToken } from './sessions.mjs';
import { acknowledgementRequired } from '../core/validation.mjs';
import { envelope, exact, refuse } from './request.mjs';

export function reviewResolution(session, resolution, payload, now) {
  envelope(payload, ['resolutionId', 'contextVersion', 'reviewDigest', 'acknowledgement']);
  if (resolution.state !== 'ready' || resolution.reviewDigest !== payload.reviewDigest) refuse('Resolve the ready target and inspect its preview first.', 'review-required');
  const acknowledgement = payload.acknowledgement;
  if (acknowledgement !== null) {
    exact(acknowledgement, ['accepted', 'sampleId']);
    if (acknowledgement.accepted !== true || acknowledgement.sampleId !== resolution.sample.id) refuse('Acknowledge this exact recipe.', 'acknowledgement-required');
  }
  if (acknowledgementRequired(resolution.sample, { read: (path) => resolution.inputs[path] }) && !acknowledgement) {
    refuse('A fresh acknowledgement is required for the reviewed effects.', 'acknowledgement-required');
  }
  session.stagedReview = { runNonce: randomToken(), reviewDigest: resolution.reviewDigest, resolutionId: resolution.id,
    expiresAt: Math.min(now() + 60000, resolution.expiresAt) };
  return { ...session.stagedReview };
}

export function requireReview(session, resolution, payload, now) {
  envelope(payload, ['resolutionId', 'contextVersion', 'reviewDigest', 'runNonce']);
  const review = session.stagedReview;
  if (!review || review.expiresAt <= now() || review.resolutionId !== resolution.id
    || review.reviewDigest !== payload.reviewDigest || resolution.reviewDigest !== payload.reviewDigest
    || !sameToken(review.runNonce, payload.runNonce)) refuse('Review expired, changed or was already used.', 'review-required');
  return review;
}
