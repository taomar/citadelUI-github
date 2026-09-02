/**
 * Binds one target environment to one reviewed copy.
 *
 * The compare dialog reads its target from a `<select>`. Every await inside the
 * flow — comparing, previewing, confirming, copying — is a window in which the
 * user can change that selector, and each step used to re-read it. Reviewing a
 * copy into environment A and then switching to B therefore wrote A's reviewed
 * parameters into B, which the hash preconditions cannot catch because they only
 * prove the *source* was unchanged.
 *
 * This owns two rules:
 *
 *   1. A reviewed operation captures its target once and keeps it, so the
 *      confirmation writes where the diff said it would.
 *   2. Compare responses carry a generation, so a slow response for a target the
 *      user has since moved away from is discarded rather than rendered.
 */
export function createCompareSession() {
  let generation = 0;
  let reviewing = null;

  return {
    /** Start a compare for `targetId`; the token identifies this attempt. */
    begin(targetId) {
      generation += 1;
      return { generation, targetId };
    },

    /** Has a newer compare superseded this one? */
    isStale(token) {
      return !token || token.generation !== generation;
    },

    /**
     * Bind the target for a reviewed copy. Refused while another review is open,
     * so two confirmations can never be in flight against different targets.
     */
    review(targetId) {
      if (reviewing) return null;
      generation += 1;
      reviewing = { generation, targetId };
      return reviewing;
    },

    /** The bound target, or null when no review is open. */
    get reviewed() {
      return reviewing;
    },

    /** True while a reviewed copy is awaiting confirmation. */
    get locked() {
      return reviewing !== null;
    },

    /** Abandon or complete the reviewed copy and unlock the selector. */
    release() {
      reviewing = null;
    },
  };
}
