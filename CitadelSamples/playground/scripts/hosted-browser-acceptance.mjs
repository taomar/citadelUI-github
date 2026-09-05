import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { testTls } from '../test/helpers/hostedTls.mjs';
import { hostedConfig, fixtureResourceResponse, subscriptionId, gatewayOrigin } from '../test/helpers/hostedFixtures.mjs';
import { createHttpsIdentityFixture } from '../test/helpers/hostedIdentityHttps.mjs';
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
let app, holdResource = false, releaseResource;
let armRequests = 0, gatewayRequests = 0;
const config = hostedConfig();
const identity = await createHttpsIdentityFixture(config, tls);
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
      const auth = createMicrosoftAuth(config, { fetchImpl: identity.fetchHttps });
      app = createHostedServer({ config, tls, auth, root: fileURLToPath(new URL('..', import.meta.url)),
        fetchImpl: async (url, options) => {
          if (holdResource) await new Promise((resolve) => { releaseResource = resolve; });
          if (new URL(url).origin === 'https://management.azure.com') armRequests++;
          else gatewayRequests++;
          return fixtureResourceResponse(url, options);
        } });
      return app;
    },
  });
  const click = async (selector) => {
    await browser.waitFor(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
    await browser.nativeClick(selector);
  };
  const input = async (selector, value) => {
    await browser.waitFor(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('[inert]')`);
    await browser.nativeInput(selector, value);
  };
  const tabTo = async (selector) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      // Observe native focus after a paint, not between key dispatch and a queued blur render.
      await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      // Input blur rechecks readiness. Do not repeatedly Tab past a deliberately disabled Run.
      await browser.waitFor(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
      if (await browser.evaluate(`document.activeElement.matches(${JSON.stringify(selector)}) && !document.activeElement.disabled`)) return;
      await browser.pressKey('Tab');
    }
    throw new Error(`Native Tab did not reach ${selector}`);
  };
  const runCheck = async ({ city } = {}) => {
    for (let step = 0; step < 6; step++) {
      await browser.waitFor("document.querySelector('.wizard-primary') && !document.querySelector('.wizard-primary').disabled");
      const label = await browser.evaluate("document.querySelector('.wizard-primary').textContent");
      if (/Run Check|Run now|Run recipe/i.test(label)) {
        if (city) await input('#f-samples-weather-tools-call-city', city);
        await tabTo('.wizard-primary');
        await browser.pressKey('Tab', { shift: true });
        assert.equal(await browser.evaluate("document.activeElement.matches('.wizard-primary')"), false);
        await browser.waitFor("document.querySelector('.wizard-primary') && !document.querySelector('.wizard-primary').disabled");
        await tabTo('.wizard-primary');
        await browser.pressKey('Enter');
        return;
      }
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
  identity.denyNext();
  await click('#dossier-connect-azure');
  await browser.waitFor("document.body.textContent.includes('cancelled, denied or expired') && document.querySelector('#dossier-connect-azure') && !document.querySelector('#dossier-connect-azure').disabled");
  reporter.equal('declined ARM consent retains the authorized application operator', await browser.evaluate("(async () => (await (await fetch('/api/capabilities')).json()).auth.authorized)()"), true);
  reporter.equal('declined ARM consent preserves the entered subscription', await browser.evaluate("document.querySelector('#f-hub-subscriptionId').value"), subscriptionId);
  await click('#dossier-connect-azure');
  await browser.waitFor("document.querySelector('#dossier-load-subscriptions')");
  await click('#dossier-load-subscriptions');
  await browser.waitFor("document.querySelectorAll('#dossier-hosted-subscription option').length === 2");
  reporter.equal('async subscription loading restores the logical native focus', await browser.evaluate('document.activeElement.id'), 'dossier-load-subscriptions');
  holdResource = true;
  await click('#dossier-load-subscriptions');
  await browser.waitFor("document.querySelector('#dossier-load-subscriptions').disabled");
  await click('#dossier-guide');
  holdResource = false;
  assert.equal(typeof releaseResource, 'function');
  releaseResource();
  await browser.waitFor("!document.querySelector('#dossier-load-subscriptions').disabled");
  reporter.check('completing async work does not steal newer native dialog focus', await browser.evaluate("Boolean(document.activeElement.closest('dialog[open]'))"));
  await click('dialog[open] .evidence-drawer-header button');
  await browser.waitFor("!document.querySelector('dialog[open]')");
  await input('#dossier-hosted-subscription', subscriptionId);
  await click('#dossier-use-subscription');
  await browser.waitFor("!document.querySelector('#dossier-use-subscription').disabled");
  reporter.equal('async subscription selection restores its activating control', await browser.evaluate('document.activeElement.id'), 'dossier-use-subscription');
  await runCheck();
  await browser.waitFor("document.body.textContent.includes('Azure HTTPS checks completed using the signed-in user.')");
  reporter.check('screenshot Azure context scenario executes delegated ARM through the Docker backend', armRequests >= 2);
  reporter.equal('native Run navigates focus to its meaningful result heading', await browser.evaluate('document.activeElement.id'), 'wizard-step-title');
  reporter.check('result focus announces its destination step', await browser.evaluate("document.activeElement.getAttribute('aria-label').includes('Run & result')"));
  reporter.check('no CLI/Python invocation is represented as executed', !(await browser.evaluate("document.querySelector('.wizard-step-body')?.textContent || ''")).includes('az account show'));
  await click('#dossier-guide');
  await browser.waitFor("document.querySelector('dialog[open] .drawer-guide')");
  reporter.check('the guide describes the delegated HTTPS adapter rather than requiring CLI login',
    (await browser.evaluate("document.querySelector('dialog[open] .drawer-guide').textContent")).includes("Read Azure through HTTPS"));
  await click('dialog[open] .evidence-drawer-header button');
  await browser.waitFor("!document.querySelector('dialog[open]')");
  await browser.navigate(`${browser.baseUrl}/?recipe=apim-discovery`, { discardChanges: true });
  await browser.waitFor("document.querySelector('#f-hub-resourceGroupName')");
  await input('#f-hub-resourceGroupName', 'rg-citadel-hub-test');
  await input('#f-hub-subscriptionId', subscriptionId);
  await runCheck();
  await browser.waitFor("document.body.textContent.includes('Azure HTTPS checks completed using the signed-in user.')");
  reporter.check('APIM discovery executes its fixed delegated list/read adapter', armRequests >= 4);
  app.sessions.close();
  await browser.navigate(`${browser.baseUrl}/?recipe=weather-tools-call`, { discardChanges: true });
  await browser.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Sign in with Microsoft'");
  const beforeGatewayArm = armRequests;
  await input('#f-hub-gatewayUrl', gatewayOrigin);
  await input('#f-gatewayAccess-apiKey', 'FAKE-CONTRACT-KEY-do-not-use-0000');
  await click('#dossier-identity-sign-in');
  await browser.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Switch account' && !document.querySelector('#dossier-identity-sign-in').disabled");
  reporter.equal('gateway key is not persisted across sign-in', await browser.evaluate("document.querySelector('#f-gatewayAccess-apiKey')?.value"), '');
  reporter.equal('gateway-only sign-in has no Azure consent control', await browser.evaluate("Boolean(document.querySelector('#dossier-connect-azure'))"), false);
  await input('#f-gatewayAccess-apiKey', 'FAKE-CONTRACT-KEY-do-not-use-0000');
  await browser.waitFor("document.body.textContent.includes('Key present in memory.')");
  reporter.check('native re-entry commits the ephemeral key before leaving Connection', true);
  await runCheck({ city: 'Seattle' });
  await browser.waitFor("document.body.textContent.includes('Synthetic weather') || document.body.textContent.includes('checks passed')");
  reporter.check('Weather tools/call reaches the bounded gateway adapter', gatewayRequests >= 3);
  reporter.check('native non-default City reaches the Weather result', (await browser.evaluate('document.body.textContent')).includes('Seattle'));
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
  await browser.navigate(`${browser.baseUrl}/?recipe=azure-context-check`, { discardChanges: true });
  await browser.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Sign in with Microsoft' && !document.querySelector('#dossier-identity-sign-in').disabled");
  reporter.check('restart/session revocation recovers at the same URL with in-app sign-in', true);
  await input('#f-hub-subscriptionId', subscriptionId);
  identity.denyNext();
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
  await browser.navigate(`${browser.baseUrl}/?recipe=azure-context-check`, { discardChanges: true });
  await browser.waitFor("document.querySelector('#dossier-identity-retry') && !document.querySelector('#dossier-identity-retry').disabled");
  reporter.check('temporary session API failure offers in-app retry rather than terminal fallback', !(await browser.evaluate('document.body.textContent')).includes('Open the secure launch URL'));
  await browser.page.send('Fetch.disable');
  stopIntercepting();
  await click('#dossier-identity-retry');
  await browser.waitFor("document.querySelector('#dossier-identity-sign-in')?.textContent === 'Sign in with Microsoft' && !document.querySelector('#dossier-identity-sign-in').disabled");
  reporter.check('in-app retry restores Microsoft sign-in at the same HTTPS URL', true);
  reporter.equal('complete lifecycle has no uncaught JavaScript errors', browser.runtimeErrors.length, 0);
  reporter.check('native Enter produces trusted keypress and Run click events', browser.nativeEvents.some((event) => event.type === 'keypress' && event.key === 'Enter' && event.trusted)
    && browser.nativeEvents.some((event) => event.type === 'click' && event.id === 'wizard-action-run' && event.trusted));
  reporter.check('all observed browser dialogs were explicitly expected beforeunload events', browser.dialogs.every((dialog) => dialog.type === 'beforeunload' && dialog.expected));
  reporter.check('MSAL metadata, token and JOSE keys traversed real verified HTTPS', ['/token', '/keys', 'openid-configuration'].every((suffix) => identity.requests.some((request) => request.path.endsWith(suffix)))
    && identity.requests.every((request) => ['TLSv1.2','TLSv1.3'].includes(request.protocol)));
  console.log('Native event provenance:', JSON.stringify(browser.nativeEvents));
  console.log('Dialog provenance:', JSON.stringify(browser.dialogs));
  console.log('Identity HTTPS provenance (no tokens):', JSON.stringify(identity.requests));
  const outcome = reporter.finish();
  assert.equal(outcome.ok, true);
} catch (error) {
  if (browser) console.error('Safe browser state:', await browser.evaluate("({path:location.pathname,active:document.activeElement.id,primary:[...document.querySelectorAll('.wizard-primary')].map(el=>({id:el.id,disabled:el.disabled,visible:Boolean(el.getClientRects().length)})),text:document.body.textContent.slice(0,5000)})"));
  if (browser) console.error('Browser diagnostics:', browser.pageErrors);
  if (browser) console.error('Native failure provenance:', JSON.stringify(browser.nativeEvents));
  if (browser) console.error('Native dialog provenance:', JSON.stringify(browser.dialogs));
  console.error('Fixture identity HTTPS paths:', identity.requests.map((request) => request.path));
  throw error;
} finally {
  await browser?.close();
  await identity.close();
  tls.clean();
}
