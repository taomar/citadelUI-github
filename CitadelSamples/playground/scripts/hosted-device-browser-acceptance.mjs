import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { testTls } from '../test/helpers/hostedTls.mjs';
import { hostedConfig, deviceClientId, fixtureResourceResponse, subscriptionId, gatewayOrigin } from '../test/helpers/hostedFixtures.mjs';
import { createHttpsIdentityFixture } from '../test/helpers/hostedIdentityHttps.mjs';
import { createHostedServer } from '../src/hosted/server.mjs';
import { createMicrosoftAuth } from '../src/hosted/auth.mjs';
import { launchBrowserHarness, createCheckReporter } from './browser-harness.mjs';

if (process.env.CITADEL_AUTH_TEST_CONTAINER !== '1' || process.platform !== 'linux') {
  throw new Error('Run only in the isolated network-disabled Linux acceptance container.');
}
const tls = testTls(), nss = join(homedir(), '.local', 'share', 'pki', 'nssdb');
mkdirSync(nss, { recursive: true });
try { execFileSync('certutil', ['-L', '-d', `sql:${nss}`], { stdio: 'ignore' }); }
catch { execFileSync('certutil', ['-N', '--empty-password', '-d', `sql:${nss}`]); }
execFileSync('certutil', ['-A', '-d', `sql:${nss}`, '-n', 'citadel-device-v2-b1280821', '-t', 'C,,', '-i', join(tls.directory, 'ca.pem')]);
const config = hostedConfig({ authMethodIds: ['browser', 'device-code'], deviceClientId,
  deviceApplicationName: 'Synthetic Citadel Device', deviceAuthIssues: [] });
const identity = await createHttpsIdentityFixture(config, tls);
const reporter = createCheckReporter({ name: 'explicit device HTTPS native acceptance' });
const artifacts = '/tmp/citadel-device-v2-b1280821';
mkdirSync(artifacts, { recursive: true });
let browser, app, armRequests = 0, weather;
const deviceStarts = [];
let inputFailure = null;
try {
  browser = await launchBrowserHarness({
    bootstrapCapability: null, path: '/?recipe=azure-context-check',
    originForPort: (port) => `https://localhost:${port}`,
    browserArguments: ['--no-sandbox', '--disable-background-networking'],
    createServer({ port }) {
      config.origin = `https://localhost:${port}`; config.callback = `${config.origin}/auth/callback`;
      app = createHostedServer({ config, tls, root: fileURLToPath(new URL('..', import.meta.url)),
        auth: createMicrosoftAuth(config, { fetchImpl: identity.fetchHttps }),
        testVerificationUris: [`${identity.origin}/device`],
        fetchImpl: async (url, options) => {
          if (new URL(url).origin === 'https://management.azure.com') armRequests++;
          const response = fixtureResourceResponse(url, options);
          if (options.body && JSON.parse(options.body).method === 'tools/call') {
            const result = await response.clone().json();
            weather = JSON.parse(result.result.content.find((item) => item.type === 'text').text);
          }
          return response;
        } });
      app.on('request', (request, response) => {
        if (request.url === '/api/auth/device/start') response.once('finish', () => {
          deviceStarts.push({ at: Date.now(), status: response.statusCode });
        });
      });
      return app;
    },
  });
  const click = async (selector) => {
    await browser.waitFor(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled && !document.querySelector(${JSON.stringify(selector)}).closest('[hidden]')`);
    await browser.nativeClick(selector);
  };
  const input = async (selector, value, client = browser) => {
    try {
      await client.waitFor(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('[inert]')`);
      if (['#f-hub-gatewayUrl', '#f-gatewayAccess-apiKey'].includes(selector)) {
        assert.equal(await client.evaluate("document.querySelector('[data-wizard-step]')?.dataset.wizardStep"), 'account-target',
          'Gateway inputs belong to the real account-target step.');
        assert.equal(await client.evaluate("Boolean(document.querySelector('#f-gatewayAccess-apiKey'))"), true,
          'The account-target step must expose its gateway key input.');
      }
      await client.nativeInput(selector, value);
    } catch (error) {
      inputFailure = await client.evaluate(`(() => {
        const field = document.querySelector(${JSON.stringify(selector)});
        return { selector: ${JSON.stringify(selector)}, step: document.querySelector('[data-wizard-step]')?.dataset.wizardStep,
          exists: Boolean(field), disabled: field?.disabled === true,
          inert: Boolean(field?.closest('[inert]')), hidden: Boolean(field?.closest('[hidden]')),
          anyInert: Boolean(document.querySelector('[inert]')),
          appBusy: document.querySelector('#app')?.getAttribute('aria-busy') === 'true' };
      })()`);
      throw error;
    }
  };
  const snapshot = async (name) => {
    const restore = [];
    await browser.page.send('Page.setWebLifecycleState', { state: 'frozen' });
    try {
      const { root } = await browser.page.send('DOM.getDocument', { depth: -1 });
      const inputs = await browser.page.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[name=user_code]' });
      assert.ok(inputs.nodeIds.length === 0, 'Provider forms must not be captured by the app screenshot helper.');
      const fields = await browser.page.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-device-code]' });
      for (const nodeId of fields.nodeIds) {
        const { node } = await browser.page.send('DOM.describeNode', { nodeId, depth: 1 });
        for (const child of node.children ?? []) {
          if (child.nodeType !== 3 || !child.nodeValue) continue;
          restore.push({ nodeId: child.nodeId, value: child.nodeValue });
          await browser.page.send('DOM.setNodeValue', { nodeId: child.nodeId, value: '[REDACTED]' });
        }
        const { outerHTML } = await browser.page.send('DOM.getOuterHTML', { nodeId });
        assert.ok(!restore.some((item) => outerHTML.includes(item.value))
          && (!node.children?.length || outerHTML.includes('[REDACTED]')), 'Code redaction failed; capture refused.');
      }
      const { data } = await browser.page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, `${name}.png`), Buffer.from(data, 'base64'));
    } finally {
      for (const item of restore) await browser.page.send('DOM.setNodeValue', item);
      await browser.page.send('Page.setWebLifecycleState', { state: 'active' });
    }
  };
  const completeNative = async () => {
    await browser.waitFor("document.querySelector('[data-device-code]').textContent.length > 0");
    let code = await browser.evaluate("document.querySelector('[data-device-code]').textContent");
    await click('#device-verification-link');
    const verification = await browser.openedTestPage(`${identity.origin}/device`);
    await verification.waitFor("document.querySelector('input[name=user_code]')");
    await input('input[name=user_code]', code, verification);
    code = null;
    await verification.nativeClick('button');
    await verification.waitFor("document.body.textContent.includes('Device verified')");
    await verification.close();
    await browser.page.send('Page.bringToFront');
    await browser.waitFor("!document.querySelector('#device-complete').hidden");
    await click('#device-complete');
    await browser.waitFor("document.querySelector('#device-sign-in').hidden");
  };
  const retryNative = async () => {
    const prior = deviceStarts.length;
    const priorHandle = await browser.evaluate("(async () => (await (await fetch('/api/capabilities')).json()).auth.deviceFlow?.flowId)()");
    await click('#device-retry');
    const deadline = Date.now() + 5000;
    while (deviceStarts.length === prior && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(deviceStarts.length - prior, 1, 'One enabled native Retry must issue exactly one start.');
    assert.equal(deviceStarts[prior].status, 202, 'Native Retry must be admitted before waiting for provider state.');
    const next = await browser.evaluate("(async () => {const f=(await (await fetch('/api/capabilities')).json()).auth.deviceFlow;return {flowId:f?.flowId,state:f?.state,deadlineAt:f?.deadlineAt,expiresAt:f?.expiresAt};})()");
    assert.ok(next.flowId && next.flowId !== priorHandle, 'Native Retry must receive a new exact flow handle.');
    console.log('Native Retry admission:', JSON.stringify({ at: deviceStarts[prior].at, status: deviceStarts[prior].status,
      newHandle: true, state: next.state, deadlineAt: next.deadlineAt, expiresAt: next.expiresAt }));
  };
  await browser.waitFor("document.querySelector('#dossier-device-sign-in') && !document.querySelector('#dossier-device-sign-in').disabled");
  reporter.equal('browser sign-in remains the default first action', await browser.evaluate("document.querySelector('.task-identity button').textContent"), 'Sign in with Microsoft');
  await input('#f-hub-subscriptionId', subscriptionId);
  const stopFailedPreflight = browser.page.on('Fetch.requestPaused', ({ requestId }) => {
    void browser.page.send('Fetch.fulfillRequest', { requestId, responseCode: 503,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from('{"summary":"Synthetic browser preflight failure"}').toString('base64') });
  });
  await browser.page.send('Fetch.enable', { patterns: [{ urlPattern: `${browser.baseUrl}/api/capabilities` }] });
  await click('#dossier-identity-sign-in');
  await browser.waitFor("document.querySelector('#dossier-identity-retry') && !document.querySelector('#dossier-identity-retry').disabled");
  reporter.equal('failed browser preflight leaves its actual redirect draft before device selection',
    await browser.evaluate("Boolean(sessionStorage.getItem('citadel-hosted-signin-resume'))"), true);
  await browser.page.send('Fetch.disable');
  stopFailedPreflight();
  await click('#dossier-identity-retry');
  await browser.waitFor("document.querySelector('#dossier-device-sign-in') && !document.querySelector('#dossier-device-sign-in').disabled");
  await browser.page.send('Network.deleteCookies', { name: '__Host-citadel-preauth', url: browser.baseUrl });
  await click('#dossier-device-sign-in');
  await browser.waitFor("document.querySelector('[data-device-code]').textContent.length > 0");
  reporter.equal('same-page device entry leaves no browser redirect draft', await browser.evaluate("sessionStorage.getItem('citadel-hosted-signin-resume')"), null);
  reporter.check('expired preauth recovers through explicit device preflight', await browser.evaluate("document.querySelector('#device-verification-link').href.startsWith('https://identity.localhost:')"));
  await snapshot('pending-redacted');
  reporter.check('device flow has transient code, configured app warning and no automatic navigation', await browser.evaluate(`location.origin === ${JSON.stringify(browser.baseUrl)} && document.body.textContent.includes('Synthetic Citadel Device') && document.querySelector('[data-device-code]').textContent.length > 0`));
  await click('#device-verification-link');
  const unsubmitted = await browser.openedTestPage(`${identity.origin}/device`);
  await unsubmitted.close();
  await browser.page.send('Page.bringToFront');
  const flowId = await browser.evaluate("(async () => (await (await fetch('/api/capabilities')).json()).auth.deviceFlow.flowId)()");
  await browser.navigate(browser.baseUrl + '/?recipe=azure-context-check', { discardChanges: true });
  await browser.waitFor("document.querySelector('[data-device-resumed]')?.textContent.includes('reloaded')");
  reporter.equal('reload retains exact safe handle, not a restored code', await browser.evaluate(`(async () => {
    const a=(await (await fetch('/api/capabilities')).json()).auth;
    return a.deviceFlow.flowId === ${JSON.stringify(flowId)} && !a.deviceFlow.userCode && !document.querySelector('[data-device-code]').textContent;
  })()`), true);
  await click('#device-cancel');
  await browser.waitFor("!document.querySelector('#device-retry').hidden && !document.querySelector('#device-retry').disabled");
  reporter.equal('device cancellation leaves no browser redirect draft', await browser.evaluate("sessionStorage.getItem('citadel-hosted-signin-resume')"), null);
  reporter.check('reload can cancel and drain the exact pending request', true);
  identity.setDeviceBehavior({ expiresIn: 2 });
  await retryNative();
  await browser.waitFor("document.querySelector('[data-device-status]')?.textContent.includes('expired')");
  await browser.waitFor("!document.querySelector('#device-retry').disabled");
  reporter.equal('device expiry leaves no browser redirect draft', await browser.evaluate("sessionStorage.getItem('citadel-hosted-signin-resume')"), null);
  await snapshot('expired');
  reporter.check('immutable provider expiry produces stopped in-app Retry', true);
  identity.setDeviceBehavior({});
  await retryNative();
  await browser.waitFor("document.querySelector('[data-device-code]').textContent.length > 0");
  const foreign = await browser.openTestPage(browser.baseUrl + '/', { freshContext: true });
  await foreign.waitFor("document.querySelector('#dossier-device-sign-in')");
  reporter.equal('another browser cannot see the owning device flow', await foreign.evaluate("(async () => (await (await fetch('/api/capabilities')).json()).auth.deviceFlow)()"), null);
  await foreign.close();
  await browser.page.send('Page.bringToFront');
  await completeNative();
  reporter.equal('device completion leaves no browser redirect draft', await browser.evaluate("sessionStorage.getItem('citadel-hosted-signin-resume')"), null);
  reporter.equal('native code verification and explicit completion establish authorized operator', await browser.evaluate("(async () => (await (await fetch('/api/capabilities')).json()).auth.authorized)()"), true);
  await click('#dossier-device-azure');
  await completeNative();
  await click('#dossier-load-subscriptions');
  await browser.waitFor("document.querySelectorAll('#dossier-hosted-subscription option').length === 2");
  await input('#dossier-hosted-subscription', subscriptionId);
  await click('#dossier-use-subscription');
  const run = async () => {
    for (let i = 0; i < 6; i++) {
      await browser.waitFor("document.querySelector('.wizard-primary') && !document.querySelector('.wizard-primary').disabled");
      const text = await browser.evaluate("document.querySelector('.wizard-primary').textContent");
      await click('.wizard-primary');
      if (/Run Check|Run now|Run recipe/i.test(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('Native wizard did not reach Run.');
  };
  await run();
  await browser.waitFor("document.body.textContent.includes('Azure HTTPS checks completed using the signed-in user.')");
  reporter.check('device public grant executes returned delegated ARM result', armRequests >= 2);
  await snapshot('device-arm-result');
  const beforeNavigation = await browser.evaluate('performance.timeOrigin');
  const navigation = await browser.navigate(browser.baseUrl + '/?recipe=weather-tools-call', { discardChanges: true });
  assert.ok(!navigation.errorText, 'Weather navigation reported an error before document commit.');
  await browser.waitFor(`performance.timeOrigin !== ${beforeNavigation} && new URL(location.href).searchParams.get('recipe') === 'weather-tools-call'`);
  await browser.waitFor("document.querySelector('#f-hub-gatewayUrl')");
  const navigationEvidence = await browser.evaluate(`({ recipe: new URL(location.href).searchParams.get('recipe'),
    heading: document.querySelector('h1')?.textContent, beforeTimeOrigin: ${beforeNavigation}, afterTimeOrigin: performance.timeOrigin })`);
  reporter.check('Weather navigation commits the explicit recipe in a new document', navigationEvidence.recipe === 'weather-tools-call'
    && navigationEvidence.afterTimeOrigin !== navigationEvidence.beforeTimeOrigin && /weather/i.test(navigationEvidence.heading));
  await input('#f-hub-gatewayUrl', gatewayOrigin);
  await input('#f-gatewayAccess-apiKey', 'FAKE-CONTRACT-KEY-do-not-use-0000');
  await run();
  await browser.waitFor("document.body.textContent.includes('Synthetic weather') || document.body.textContent.includes('checks passed')");
  reporter.check('same device operator executes actual returned Weather fixture', Boolean(weather?.city));
  await snapshot('device-weather-result');
  reporter.equal('device native path has no uncaught browser errors', browser.runtimeErrors.length, 0);
  reporter.check('device starts, cancellation, retry and completion came from trusted native clicks',
    ['dossier-device-sign-in', 'device-cancel', 'device-retry', 'device-complete'].every((id) =>
      browser.nativeEvents.some((event) => event.id === id && event.type === 'click' && event.trusted)));
  reporter.check('real MSAL devicecode/token/JWKS calls used verified HTTPS', ['/devicecode', '/token', '/keys'].every((path) =>
    identity.requests.some((request) => request.path.endsWith(path))) && identity.requests.every((request) => ['TLSv1.2','TLSv1.3'].includes(request.protocol)));
  console.log('Device native provenance (no codes):', JSON.stringify(browser.nativeEvents));
  console.log('Device navigation provenance:', JSON.stringify(navigationEvidence));
  console.log('Device dialog provenance:', JSON.stringify(browser.dialogs));
  console.log('Device TLS provenance (paths only):', JSON.stringify(identity.requests));
  console.log('Device start provenance:', JSON.stringify(deviceStarts));
  assert.equal(reporter.finish().ok, true);
} catch (error) {
  if (browser) console.error('Safe device state:', await browser.evaluate("({path:location.pathname,recipe:new URL(location.href).searchParams.get('recipe')?.replace(/[^a-z0-9-]/g,'').slice(0,80),timeOrigin:performance.timeOrigin,active:document.activeElement.id,status:document.querySelector('[data-device-status]')?.textContent,ready:document.querySelector('#device-complete')?.hidden,primary:document.querySelector('.wizard-primary')?.textContent})"));
  if (browser) console.error('Device dialog provenance:', JSON.stringify(browser.dialogs));
  if (browser) console.error('Device runtime errors:', browser.runtimeErrors);
  console.error('Device start provenance:', JSON.stringify(deviceStarts));
  console.error('Device input availability:', JSON.stringify(inputFailure));
  throw error;
} finally {
  await app?.closeDevice();
  await browser?.close();
  await identity.close();
  tls.clean();
}
