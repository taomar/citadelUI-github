import { createServer } from 'node:https';
import { createIdentityFixture } from './hostedFixtures.mjs';
import { createHttpsTransport } from '../../src/hosted/httpsTransport.mjs';

// Isolated fixture connector only: real TLS/hostname checks, no external DNS or egress.
export async function createHttpsIdentityFixture(config, tls) {
  let fixture, origin, denyNext = false;
  const requests = [];
  const server = createServer(tls, async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      requests.push({ path: url.pathname, method: request.method, protocol: request.socket.getProtocol() });
      if (url.pathname.endsWith('/authorize')) {
        const callback = new URL(fixture.authorize(url.href));
        if (denyNext) {
          callback.searchParams.delete('code');
          callback.searchParams.set('error', 'access_denied');
          denyNext = false;
        }
        response.writeHead(303, { Location: callback.href, 'Cache-Control': 'no-store' }).end();
      } else if (url.pathname.endsWith('/logout')) {
        if (url.searchParams.get('post_logout_redirect_uri') !== config.origin + '/') throw new Error('Unregistered fixture logout redirect.');
        response.writeHead(303, { Location: config.origin + '/', 'Cache-Control': 'no-store' }).end();
      } else {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 128 * 1024) throw new Error('Fixture request too large.');
        }
        const result = await fixture.fetchImpl(url.href, { method: request.method, body });
        response.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(await result.text());
      }
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"synthetic_fixture_failure"}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `https://identity.localhost:${server.address().port}`;
  config.cloud = { ...config.cloud, loginEndpoint: origin, tokenIssuerBase: origin };
  try { fixture = await createIdentityFixture(config); }
  catch (error) { server.close(); throw error; }
  const transport = createHttpsTransport({ ca: tls.ca,
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    addressAllowed: (address) => address === '127.0.0.1' });
  return {
    origin, requests, authorize: (...args) => fixture.authorize(...args),
    denyNext: () => { denyNext = true; },
    fetchHttps(url, options) {
      if (new URL(url).origin !== origin) throw new Error('Fixture connector refuses external identity destinations.');
      return transport(url, options);
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
