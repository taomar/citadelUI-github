import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function requiredPath(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return resolve(value);
}

function requiredPort() {
  const value = Number(process.env.CITADEL_UI_PORT);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error('Invalid Citadel desktop port.');
  }
  return value;
}

async function receiveCredentialKey() {
  if (!process.parentPort) throw new Error('Citadel desktop server requires an Electron parent.');
  return new Promise((resolveKey, rejectKey) => {
    const timer = setTimeout(() => rejectKey(new Error('Credential key handoff timed out.')), 10_000);
    process.parentPort.once('message', (event) => {
      clearTimeout(timer);
      const message = event?.data;
      if (message?.type === 'credential-key-unavailable') {
        const reason =
          typeof message.reason === 'string' &&
          /^desktop-[a-z-]{1,64}$/.test(message.reason)
            ? message.reason
            : 'desktop-secure-storage-unavailable';
        resolveKey({ bytes: null, reason });
        return;
      }
      const bytes =
        message?.type === 'credential-key' && message.bytes
          ? Buffer.from(message.bytes)
          : null;
      if (!bytes || bytes.length !== 32) {
        bytes?.fill(0);
        rejectKey(new Error('Invalid desktop credential key handoff.'));
        return;
      }
      resolveKey({ bytes, reason: 'ready' });
    });
  });
}

async function start() {
  const resourceRoot = requiredPath('CITADEL_DESKTOP_RESOURCE_ROOT');
  const dataRoot = requiredPath('CITADEL_DATA_ROOT');
  const port = requiredPort();
  const host = process.env.CITADEL_UI_HOST;
  const allowedHost = process.env.CITADEL_ALLOWED_HOST;
  const allowedOrigin = process.env.CITADEL_ALLOWED_ORIGIN;
  if (host !== '127.0.0.1' || allowedOrigin !== `http://${allowedHost}`) {
    throw new Error('Invalid Citadel desktop origin configuration.');
  }

  const [{ startCitadelServer }, { CredentialVault }] = await Promise.all([
    import(pathToFileURL(resolve(resourceRoot, 'server', 'index.mjs')).href),
    import(pathToFileURL(resolve(resourceRoot, 'server', 'credentials.mjs')).href),
  ]);
  let keyState = await receiveCredentialKey();
  const keySource = {
    kind: 'desktop-safe-storage',
    invalidReason: 'desktop-key-invalid',
    async read() {
      const current = keyState;
      keyState = { bytes: null, reason: current.reason };
      return current;
    },
  };
  const credentialVault = new CredentialVault({ dataRoot, keySource });

  await startCitadelServer({
    host,
    port,
    allowedHost,
    allowedOrigin,
    dataRoot,
    webRoot: resolve(resourceRoot, 'web'),
    sharedRoot: resolve(resourceRoot, 'shared'),
    credentialVault,
  });
}

start().catch((error) => {
  console.error(
    JSON.stringify({
      event: 'citadel_desktop_server_start_failed',
      status: 'failed',
      errorType: error?.constructor?.name || 'Error',
    })
  );
  process.exitCode = 1;
});
