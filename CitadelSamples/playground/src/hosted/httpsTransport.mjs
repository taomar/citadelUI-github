import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');

export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

// Resolve once, validate every answer, and pin the socket to that resolution.
export function createHttpsTransport({ resolve = lookup, ca, addressAllowed = publicAddress } = {}) {
  return async function fetchHttps(raw, options = {}) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || /[\u0000-\u0020\\]/.test(String(raw))) {
      throw new Error('Only credential-free HTTPS request URLs are allowed.');
    }
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(75000)]);
    signal.throwIfAborted();
    const answers = await new Promise((accept, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => resolve(url.hostname, { all: true, verbatim: true }))
        .then(accept, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    signal.throwIfAborted();
    if (!answers.length || answers.some(({ address }) => !addressAllowed(address))) {
      throw new Error('Destination DNS resolved outside the permitted public network boundary.');
    }
    const chosen = answers[0];
    const body = options.body;
    if (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body) > 256 * 1024)) throw new Error('Request body exceeds the transport limit.');
    return new Promise((resolveResponse, reject) => {
      const req = request(url, {
        method: options.method ?? 'GET', headers: options.headers, signal, ca,
        minVersion: 'TLSv1.2', rejectUnauthorized: true, agent: false,
        lookup: (_host, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [chosen]);
          else callback(null, chosen.address, chosen.family);
        },
      }, (response) => {
        if (response.statusCode < 200 || response.statusCode > 599 || (response.statusCode >= 300 && response.statusCode < 400)) {
          response.destroy();
          reject(new Error('Upstream redirects and invalid statuses are refused.'));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) { response.destroy(new Error('Upstream response exceeds the limit.')); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          resolveResponse(new Response([204, 205].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers }));
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}
