import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { testTls } from '../test/helpers/hostedTls.mjs';
import { hostedConfig, createIdentityFixture, fixtureResourceResponse, subscriptionId, gatewayOrigin } from '../test/helpers/hostedFixtures.mjs';
import { createHostedServer } from '../src/hosted/server.mjs';
import { createMicrosoftAuth } from '../src/hosted/auth.mjs';
import { launchBrowserHarness, createCheckReporter } from './browser-harness.mjs';

if (process.env.CITADEL_AUTH_TEST_CONTAINER !== '1' || process.platform !== 'linux') {
  throw new Error('Run this acceptance only in its isolated, network-disabled Linux test container.');
}
const tls = testTls();
const nss = join(homedir(), '.local', 'share', 'pki', 'nssdb');
mkdirSync(nss, { recursive: true });
execFileSync('certutil', ['-N', '--empty-password', '-d', `sql:${nss}`]);
execFileSync('certutil', ['-A', '-d', `sql:${nss}`, '-n', 'citadel-auth-test-8ea0cc0f', '-t', 'C,,', '-i', join(tls.directory, 'ca.pem')]);
let identity, app, denyNext = false;
let armRequests = 0, gatewayRequests = 0;
const idp = createServer(tls, (request, response) => {
  const location = new URL(request.url, `https://${request.headers.host}`);
  if (location.pathname.endsWith('/authorize')) {
    const callback = new URL(identity.authorize(location.href));
    if (denyNext) { callback.searchParams.delete('code'); callback.searchParams.set('error', 'access_denied'); denyNext = false; }
    response.writeHead(303, { Location: callback.href, 'Cache-Control': 'no-store' });
  } else if (location.pathname.endsWith('/logout')) {
    response.writeHead(303, { Location: location.searchParams.get('post_logout_redirect_uri'), 'Cache-Control': 'no-store' });
  } else response.writeHead(404);
  response.end();
});
await new Promise((resolve) => idp.listen(0, '127.0.0.1', resolve));
const idpOrigin = `https://localhost:${idp.address().port}`;
const config = hostedConfig();
config.cloud = { ...config.cloud, loginEndpoint: idpOrigin, tokenIssuerBase: idpOrigin };
identity = await createIdentityFixture(config);
const reporter = createCheckReporter({ name: 'hosted HTTPS browser acceptance (synthetic identity/resources)' });
let browser;
try {
  browser = await launchBrowserHarness({
    bootstrapCapability: null, path: '/?recipe=azure-context-check',
    originForPort: (port) => `https://localhost:${port}`,
    // Chromium's process sandbox is unavailable in the network-disabled test container.
    // This does not alter TLS verification and is never a production application flag.
    browserArguments: ['--no-sandbox', '--disable-background-networking'],
    createServer({ port }) {
      config.origin = `https://localhost:${port}`;
      config.callback = `${config.origin}/auth/callback`;
      const auth = createMicrosoftAuth(config, { fetchImpl: identity.fetchImpl });
      app = createHostedServer({ config, tls, auth, root: fileURLToPath(new URL('..', import.meta.url)),
        fetchImpl: async (url, options) => {
          if (new URL(url).origin === 'https://management.azure.com') armRequests++;
          else gatewayRequests++;
          return fixtureResourceResponse(url, options);
        } });
      return app;
    },
  });
  const click = async (selector) => {
    await browser.waitFor(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
    await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const input = async (selector, value) => {
    await browser.waitFor(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('[inert]')`);
    await browser.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', {bubbles:true})); field.dispatchEvent(new Event('change', {bubbles:true})); field.blur(); })()`);
  };
  const runCheck = async () => {
    for (let step = 0; step < 6; step++) {
      await browser.waitFor("document.querySelector('.wizard-primary') && !document.querySelector('.wizard-primary').disabled");
      const label = await browser.evaluate("document.querySelector('.wizard-primary').textContent");
      if (/Run Check|Run now|Run recipe/i.test(label)) { await click('.wizard-primary'); return; }
      await click('.wizard-primary');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('The existing wizard never reached its Run action.');
  };
  await browser.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Sign in with Microsoft' && !document.querySelector('#dossier-identity-sign-in').disabled");
  reporter.check('fresh ordinary HTTPS URL exposes functional in-app sign-in without a bootstrap', await browser.evaluate("isSecureContext && !location.hash.includes('bootstrap')"));
  await input('#f-hub-subscriptionId', subscriptionId);
  await click('#dossier-identity-sign-in');
  await browser.waitFor("document.querySelector('#dossier-connect-azure') && !document.querySelector('#dossier-connect-azure').disabled");
  reporter.equal('recipe and entered subscription survive Microsoft-controlled fixture redirect', await browser.evaluate("document.querySelector('#f-hub-subscriptionId')?.value"), subscriptionId);
  reporter.equal('operator sign-in alone does not request ARM', armRequests, 0);
  await click('#dossier-connect-azure');
  await browser.waitFor("document.querySelector('#dossier-load-subscriptions')");
  await click('#dossier-load-subscriptions');
  await browser.waitFor("document.querySelectorAll('#dossier-hosted-subscription option').length === 2");
  await input('#dossier-hosted-subscription', subscriptionId);
  await click('#dossier-use-subscription');
  await runCheck();
  await browser.waitFor("document.body.textContent.includes('Azure HTTPS checks completed using the signed-in user.')");
  reporter.check('screenshot Azure context scenario executes delegated ARM through the Docker backend', armRequests >= 2);
  reporter.check('no CLI/Python invocation is represented as executed', !(await browser.evaluate("document.querySelector('.wizard-step-body')?.textContent || ''")).includes('az account show'));
  await click('#dossier-guide');
  await browser.waitFor("document.querySelector('dialog[open] .drawer-guide')");
  reporter.check('the guide describes the delegated HTTPS adapter rather than requiring CLI login',
    (await browser.evaluate("document.querySelector('dialog[open] .drawer-guide').textContent")).includes("Read Azure through HTTPS"));
  await click('dialog[open] .evidence-drawer-header button');
  await browser.waitFor("!document.querySelector('dialog[open]')");
  await browser.page.send('Page.navigate', { url: `${browser.baseUrl}/?recipe=apim-discovery` });
  await browser.waitFor("document.querySelector('#f-hub-resourceGroupName')");
  await input('#f-hub-resourceGroupName', 'rg-citadel-hub-test');
  await input('#f-hub-subscriptionId', subscriptionId);
  await runCheck();
  await browser.waitFor("document.body.textContent.includes('Azure HTTPS checks completed using the signed-in user.')");
  reporter.check('APIM discovery executes its fixed delegated list/read adapter', armRequests >= 4);
  app.sessions.close();
  await browser.page.send('Page.navigate', { url: `${browser.baseUrl}/?recipe=weather-tools-call` });
  await browser.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Sign in with Microsoft'");
  const beforeGatewayArm = armRequests;
  await input('#f-hub-gatewayUrl', gatewayOrigin);
  await input('#f-gatewayAccess-apiKey', 'FAKE-CONTRACT-KEY-do-not-use-0000');
  await click('#dossier-identity-sign-in');
  await browser.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Switch account' && !document.querySelector('#dossier-identity-sign-in').disabled");
  reporter.equal('gateway key is not persisted across sign-in', await browser.evaluate("document.querySelector('#f-gatewayAccess-apiKey')?.value"), '');
  reporter.equal('gateway-only sign-in has no Azure consent control', await browser.evaluate("Boolean(document.querySelector('#dossier-connect-azure'))"), false);
  await input('#f-gatewayAccess-apiKey', 'FAKE-CONTRACT-KEY-do-not-use-0000');
  await runCheck();
  await browser.waitFor("document.body.textContent.includes('Synthetic weather') || document.body.textContent.includes('checks passed')");
  reporter.check('Weather tools/call reaches the bounded gateway adapter', gatewayRequests >= 3);
  reporter.equal('Weather does not acquire or call ARM', armRequests, beforeGatewayArm);
  reporter.equal('no uncaught JavaScript errors', browser.runtimeErrors.length, 0);
  reporter.check('hosted result evidence is not mislabelled preview or boundary-conflicted', !(await browser.evaluate('document.body.textContent')).includes('Evidence boundary conflict'));
  const tab = await browser.openTestPage(`${browser.baseUrl}/?recipe=weather-tools-call`);
  await tab.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Switch account'");
  reporter.check('ordinary new tab resumes the authorized operator session', await tab.evaluate("(async () => (await (await fetch('/api/capabilities')).json()).auth.authorized)()"));
  await tab.close();
  const fresh = await browser.openTestPage(`${browser.baseUrl}/?recipe=weather-tools-call`, { freshContext: true });
  await fresh.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Sign in with Microsoft'");
  reporter.equal('fresh browser context requires normal application sign-in', await fresh.evaluate("(async () => (await (await fetch('/api/capabilities')).json()).auth.authorized)()"), false);
  await fresh.close();
  app.sessions.close();
  await browser.page.send('Page.navigate', { url: `${browser.baseUrl}/?recipe=azure-context-check` });
  await browser.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Sign in with Microsoft' && !document.querySelector('#dossier-identity-sign-in').disabled");
  reporter.check('restart/session revocation recovers at the same URL with in-app sign-in', true);
  await input('#f-hub-subscriptionId', subscriptionId);
  denyNext = true;
  await click('#dossier-identity-sign-in');
  await browser.waitFor("document.body.textContent.includes('cancelled, denied or expired') && !document.querySelector('#dossier-identity-sign-in').disabled");
  reporter.equal('cancelled Microsoft consent returns to retry UI with non-secret input intact', await browser.evaluate("document.querySelector('#f-hub-subscriptionId').value"), subscriptionId);
  await click('#dossier-identity-sign-in');
  await browser.waitFor("document.querySelector('#dossier-identity-sign-out') && !document.querySelector('#dossier-identity-sign-out').disabled");
  await click('#dossier-identity-sign-out');
  await browser.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Sign in with Microsoft' && !document.querySelector('#dossier-identity-sign-in').disabled");
  reporter.equal('sign-out revokes the application session and returns through the app', await browser.evaluate("(async () => (await (await fetch('/api/capabilities')).json()).auth.signedIn)()"), false);
  const stopIntercepting = browser.page.on('Fetch.requestPaused', ({ requestId }) => {
    void browser.page.send('Fetch.fulfillRequest', { requestId, responseCode: 503,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from('{"summary":"Synthetic capacity unavailable"}').toString('base64') });
  });
  await browser.page.send('Fetch.enable', { patterns: [{ urlPattern: `${browser.baseUrl}/api/capabilities` }] });
  await browser.page.send('Page.navigate', { url: `${browser.baseUrl}/?recipe=azure-context-check` });
  await browser.waitFor("document.querySelector('#dossier-identity-retry') && !document.querySelector('#dossier-identity-retry').disabled");
  reporter.check('temporary session API failure offers in-app retry rather than terminal fallback', !(await browser.evaluate('document.body.textContent')).includes('Open the secure launch URL'));
  await browser.page.send('Fetch.disable');
  stopIntercepting();
  await click('#dossier-identity-retry');
  await browser.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Sign in with Microsoft' && !document.querySelector('#dossier-identity-sign-in').disabled");
  reporter.check('in-app retry restores Microsoft sign-in at the same HTTPS URL', true);
  reporter.equal('complete lifecycle has no uncaught JavaScript errors', browser.runtimeErrors.length, 0);
  const outcome = reporter.finish();
  assert.equal(outcome.ok, true);
} catch (error) {
  if (browser) console.error('Safe browser state:', await browser.evaluate("({path:location.pathname,text:document.body.textContent.slice(0,5000)})"));
  if (browser) console.error('Browser diagnostics:', browser.pageErrors);
  console.error('Fixture identity endpoint paths:', identity.calls.map((call) => new URL(call.url).pathname));
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => { idp.closeAllConnections(); idp.close(resolve); });
  tls.clean();
}
