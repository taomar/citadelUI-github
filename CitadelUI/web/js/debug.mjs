import { ensureOwnerSession, forgetToken } from './owner-gate.mjs';
import { DiagnosticsClient } from './diagnostics-client.mjs';
import { mountDebugPage } from './debug-page.mjs';

const token = await ensureOwnerSession();
const client = new DiagnosticsClient({
  token, includeReport: true, captureErrors: false,
  onUnauthorized: () => { forgetToken(); window.location.reload(); },
});
mountDebugPage(document.getElementById('debug-workspace'), { client });
await client.start();
