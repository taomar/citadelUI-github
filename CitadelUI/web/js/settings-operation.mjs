export function createEnvironmentOperation({ setInlineStatus, setGlobalStatus, setBusy = () => {} }) {
  return (message, action) => async () => {
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
  };
}
