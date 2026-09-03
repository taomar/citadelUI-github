/**
 * One environment operation at a time, with its own status line.
 *
 * The lock is the point, not a refinement of it. This factory used to accept a
 * `setBusy` callback that disabled the row's buttons, and one of its two call
 * sites passed one while the other did not — so a row operation was guarded and
 * a panel operation was not, for no reason anybody had decided. Disabling a
 * control is feedback; it is not a guarantee, because a second invocation can
 * be in flight before the first repaint. The guarantee now comes from
 * `single-flight`, and `setBusy` is what makes it visible.
 */
import { SKIPPED, createSingleFlight } from './single-flight.mjs';

export function createEnvironmentOperation({
  setInlineStatus,
  setGlobalStatus,
  setBusy = () => {},
  registry = createSingleFlight(),
}) {
  return (message, action) => {
    // Per built operation, so renaming one workspace does not block removing
    // another, while double-clicking either does nothing the second time.
    const key = Symbol(message);
    return async () => {
      // Dropped, not queued: the second click carries no new intention, and
      // replaying it would repeat a mutation against state the first one has
      // already changed.
      const outcome = registry.run(key, async () => {
        setInlineStatus(message, 'info');
        setBusy(true);
        let rollback = null;
        try {
          const result = await action((candidate) => {
            rollback = candidate;
          });
          setInlineStatus('Operation completed.', 'success');
          return result;
        } catch (error) {
          let detail = error?.message || 'The environment operation failed.';
          if (rollback) {
            try {
              await rollback();
            } catch (rollbackError) {
              detail += ` Local state recovery failed: ${rollbackError.message}`;
            }
          }
          setInlineStatus(detail, 'error');
          setGlobalStatus(detail, 'error');
          return undefined;
        } finally {
          setBusy(false);
        }
      });
      return outcome === SKIPPED ? SKIPPED : await outcome;
    };
  };
}
