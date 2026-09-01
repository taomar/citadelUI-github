/**
 * Record a raw policy draft and refresh only the global pending actions.
 *
 * Re-rendering the policy workspace here would replace the textarea on every
 * keystroke, losing its focus and caret. The toolbar is a separate mount, so it
 * can reflect the pending draft immediately without disturbing the raw editor.
 */
export function setRawPolicyDraft(state, text, refreshPendingActions) {
  state.policyRaw = text;
  state.policyChanges = {};
  refreshPendingActions();
}
