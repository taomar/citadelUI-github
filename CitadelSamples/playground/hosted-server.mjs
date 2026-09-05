import { fileURLToPath } from 'node:url';
import { readHostedConfig, readTls } from './src/hosted/config.mjs';
import { createHostedServer } from './src/hosted/server.mjs';

const config = readHostedConfig();
const tls = readTls(process.env, config.origin);
const port = Number(process.env.CITADEL_PLAYGROUND_PORT ?? 8443);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Configure a valid HTTPS listener port.');
const server = createHostedServer({ config, tls, root: fileURLToPath(new URL('.', import.meta.url)) });
server.listen(port, process.env.CITADEL_PLAYGROUND_HOST ?? '0.0.0.0', () => {
  process.stdout.write(`Citadel HTTPS application: ${config.origin}\n`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.sessions.close();
  server.close();
  server.closeAllConnections();
});
