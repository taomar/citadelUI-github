import { get } from 'node:https';

const origin = new URL(process.env.CITADEL_PLAYGROUND_PUBLIC_ORIGIN);
if (origin.protocol !== 'https:') throw new Error('Health checks require HTTPS.');
const request = get({
  hostname: origin.hostname, servername: origin.hostname,
  port: Number(process.env.CITADEL_PLAYGROUND_PORT ?? 8443), path: '/api/live',
  headers: { Host: origin.host }, minVersion: 'TLSv1.2', rejectUnauthorized: true,
  lookup: (_hostname, options, callback) => callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4),
}, (response) => {
  response.resume();
  if (response.statusCode !== 200) {
    process.stderr.write(`HTTPS health check returned HTTP ${response.statusCode}.\n`);
    process.exitCode = 1;
  }
});
request.setTimeout(5000, () => request.destroy(new Error('HTTPS health check timed out.')));
request.on('error', () => {
  process.stderr.write('HTTPS health check failed. Verify listener availability, certificate validity and trust.\n');
  process.exitCode = 1;
});
