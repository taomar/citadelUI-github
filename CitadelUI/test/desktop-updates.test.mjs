import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  UPDATE_API, compareVersions, createUpdateController, fetchDesktopRelease,
  selectDesktopRelease, validateWindowsFeed, verifyWindowsFeed, windowsUpdateSupport,
} from '../desktop/updates.mjs';
import { DESKTOP_ORIGIN, trustedDesktopUpdateRequest } from '../desktop/runtime-config.mjs';

const feed = `${'a'.repeat(40)} citadel_ui-1.1.5-full.nupkg 123\n`;
const digest = `sha256:${createHash('sha256').update(feed).digest('hex')}`;
const releaseRecord = (version = '1.1.5') => ({
  tag_name: `citadel-ui-desktop-v${version}`, draft: false, prerelease: false,
  html_url: 'https://untrusted.example/ignored',
  assets: [
    { name: 'RELEASES', state: 'uploaded', size: Buffer.byteLength(feed), digest },
    { name: `citadel_ui-${version}-full.nupkg`, state: 'uploaded', size: 123 },
  ],
});
const release = () => selectDesktopRelease([releaseRecord()]);

class Updater extends EventEmitter {
  calls = [];
  setFeedURL(value) { this.calls.push(['feed', value.url]); }
  async checkForUpdates() { this.calls.push(['download']); }
  quitAndInstall() { this.calls.push(['restart']); }
}

function setup(options = {}) {
  const updater = new Updater();
  const prompts = [];
  const states = [];
  const notices = [];
  const errors = [];
  const prepared = [];
  const opened = [];
  const controller = createUpdateController({
    version: '1.1.4',
    support: { supported: true, reason: 'Installed Windows application.' },
    loadRelease: async () => release(),
    updater,
    prepareUpdate: async (value) => { prepared.push(value.version); },
    confirm: async (kind) => { prompts.push(kind); return true; },
    notify: (value) => notices.push(value.version),
    onState: (value) => states.push(value),
    onError: (error) => errors.push(error),
    openRelease: async (url) => { opened.push(url); },
    ...options,
  });
  return { controller, updater, prompts, states, notices, errors, prepared, opened };
}

test('desktop updates compare stable versions numerically and reject invalid ranges', () => {
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('1.1.4', '1.1.4'), 0);
  assert.equal(compareVersions('1.1.3', '1.1.4'), -1);
  for (const invalid of ['1.01.4', 'v1.1.4', '1.1.4-beta', '1.1', '99999999999999999999.1.1']) {
    assert.throws(() => compareVersions(invalid, '1.1.4'), /Invalid/);
  }
});

test('desktop updates select only stable desktop tags and construct their own trusted URLs', () => {
  const result = selectDesktopRelease([
    releaseRecord('1.9.0'), releaseRecord('1.10.0'),
    { ...releaseRecord('8.0.0'), draft: true },
    { ...releaseRecord('9.0.0'), prerelease: true },
    { ...releaseRecord(), tag_name: 'another-product-v99.0.0' },
  ]);
  assert.equal(result.version, '1.10.0');
  assert.equal(result.pageUrl, 'https://github.com/taomar/citadelUI-github/releases/tag/citadel-ui-desktop-v1.10.0');
  assert.equal(result.feedUrl.endsWith('/citadel-ui-desktop-v1.10.0/'), true);
  assert.equal(result.windowsFeed, true);
  assert.throws(() => selectDesktopRelease([]), /No stable desktop release/);
});

test('desktop update checks use public metadata without any GitHub credentials', async () => {
  let request;
  const result = await fetchDesktopRelease(async (url, options) => {
    request = { url, ...options };
    return new Response(JSON.stringify([releaseRecord()]));
  });
  assert.equal(result.version, '1.1.5');
  assert.equal(request.url, UPDATE_API);
  assert.equal(request.redirect, 'error');
  assert.equal('Authorization' in request.headers, false);
  assert.equal('credentials' in request, false);
  assert.ok(request.signal);
  await assert.rejects(fetchDesktopRelease(async () => new Response('', { status: 403 })), /HTTP 403/);
  await assert.rejects(fetchDesktopRelease(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), /size limit/);
});

test('desktop Windows feed requires the selected version, exact assets and full package', () => {
  assert.doesNotThrow(() => validateWindowsFeed(feed, '1.1.5', [{ name: 'citadel_ui-1.1.5-full.nupkg', size: 123 }]));
  for (const invalid of [
    feed.replace('1.1.5', '1.1.6'),
    feed.replace('citadel_ui-', '../citadel_ui-'),
    feed.replace('123', '124'),
    feed + feed,
    `${'a'.repeat(40)} https://example.test/app.nupkg 123\n`,
  ]) {
    assert.throws(() => validateWindowsFeed(invalid, '1.1.5', release().packages), /feed/);
  }
  assert.throws(() => validateWindowsFeed(
    `${'a'.repeat(40)} citadel_ui-1.1.5-delta.nupkg 123\n`, '1.1.5',
    [{ name: 'citadel_ui-1.1.5-delta.nupkg', size: 123 }]
  ), /no full package/);
});

test('desktop Windows feed is checksum-verified before native updater execution', async () => {
  await verifyWindowsFeed(release(), async (url) => {
    assert.equal(url, `${release().feedUrl}RELEASES`);
    return new Response(feed);
  });
  await assert.rejects(verifyWindowsFeed(release(), async () => new Response(feed.replace('123', '124'))), /checksum/);
});

test('desktop Windows updates require the real installed updater; Mac and portable never use it', async () => {
  const options = {
    platform: 'win32', arch: 'x64', isPackaged: true, dirty: false,
    executablePath: 'C:\\Users\\runner\\AppData\\Local\\citadel_ui\\app-1.1.4\\CitadelUI.exe',
  };
  let checked = '';
  assert.equal((await windowsUpdateSupport({ ...options, checkAccess: async (path) => { checked = path; } })).supported, true);
  assert.equal(checked, 'C:\\Users\\runner\\AppData\\Local\\citadel_ui\\Update.exe');
  const forbidden = async () => { throw new Error('Must not inspect an updater here.'); };
  for (const change of [
    { platform: 'darwin' }, { isPackaged: false }, { dirty: true }, { arch: 'arm64' },
    { executablePath: 'C:\\Downloads\\CitadelUIPortable\\CitadelUI.exe' },
  ]) {
    assert.equal((await windowsUpdateSupport({ ...options, ...change, checkAccess: forbidden })).supported, false);
  }
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    assert.equal((await windowsUpdateSupport({
      ...options, checkAccess: async () => { throw Object.assign(new Error('Unavailable'), { code }); },
    })).supported, false);
  }
});

test('desktop update notifications never download and notify once per newer version', async () => {
  const f = setup();
  assert.equal((await f.controller.check()).phase, 'available');
  await f.controller.check();
  assert.deepEqual(f.notices, ['1.1.5']);
  assert.deepEqual(f.updater.calls, []);
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.prepared, []);
  f.controller.dispose();
});

test('desktop update checks are single-flight and never downgrade', async () => {
  let resolveRelease;
  let calls = 0;
  const f = setup({ loadRelease: () => { calls += 1; return new Promise((resolve) => { resolveRelease = resolve; }); } });
  const first = f.controller.check();
  const second = f.controller.check();
  assert.equal(calls, 1);
  resolveRelease(selectDesktopRelease([releaseRecord('1.1.3')]));
  await Promise.all([first, second]);
  assert.equal(f.controller.getState().phase, 'current');
  assert.deepEqual(f.notices, []);
  f.controller.dispose();
});

test('desktop notification-only mode cannot download or restart even through direct calls', async () => {
  const f = setup({ support: { supported: false, reason: 'macOS updates are notification-only.' } });
  assert.equal((await f.controller.check()).canInstall, false);
  await assert.rejects(f.controller.download(), /not available/);
  await assert.rejects(f.controller.restart(), /No prepared/);
  assert.deepEqual(f.updater.calls, []);
  assert.equal(f.updater.listenerCount('update-downloaded'), 0);
  await f.controller.viewRelease();
  assert.deepEqual(f.opened, [release().pageUrl]);
  f.controller.dispose();
});

test('desktop installed Windows falls back to notification when a release has no updater feed', async () => {
  const f = setup({ loadRelease: async () => selectDesktopRelease([{ ...releaseRecord(), assets: [] }]) });
  const state = await f.controller.check();
  assert.equal(state.phase, 'available');
  assert.equal(state.canInstall, false);
  assert.match(state.reason, /no verified in-place/);
  await assert.rejects(f.controller.download(), /not available/);
  f.controller.dispose();
});

test('desktop rejecting download confirmation never fetches or runs an updater', async () => {
  const f = setup({ confirm: async () => false });
  await f.controller.check();
  assert.equal((await f.controller.download()).phase, 'available');
  assert.deepEqual(f.prepared, []);
  assert.deepEqual(f.updater.calls, []);
  f.controller.dispose();
});

test('desktop Windows prepares only after consent and restarts only after separate consent', async () => {
  const f = setup();
  await f.controller.check();
  await f.controller.download();
  assert.deepEqual(f.prompts, ['download']);
  assert.deepEqual(f.prepared, ['1.1.5']);
  assert.deepEqual(f.updater.calls, [['feed', release().feedUrl], ['download']]);
  await f.controller.check();
  assert.equal(f.controller.getState().phase, 'downloading');
  f.updater.emit('update-downloaded', {}, '', '1.1.5');
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.updater.calls.some(([kind]) => kind === 'restart'), false);
  await f.controller.restart();
  assert.deepEqual(f.prompts, ['download', 'restart']);
  assert.equal(f.updater.calls.at(-1)[0], 'restart');
  f.controller.dispose();
});

test('desktop update confirmation is single-flight and Later retains the prepared update', async () => {
  let finish;
  let prompts = 0;
  const f = setup({ confirm: async (kind) => {
    prompts += 1;
    if (kind === 'restart') return false;
    return new Promise((resolve) => { finish = resolve; });
  } });
  await f.controller.check();
  const first = f.controller.download();
  const second = f.controller.download();
  assert.equal(prompts, 1);
  finish(true);
  await Promise.all([first, second]);
  f.updater.emit('update-downloaded', {}, '', '1.1.5');
  assert.equal((await f.controller.restart()).phase, 'ready');
  assert.equal(f.updater.calls.some(([kind]) => kind === 'restart'), false);
  f.controller.dispose();
});

test('desktop invalid feeds and unexpected downloaded versions never offer restart', async () => {
  const invalid = setup({ prepareUpdate: async () => { throw new Error('Checksum mismatch'); } });
  await invalid.controller.check();
  assert.equal((await invalid.controller.download()).phase, 'error');
  assert.deepEqual(invalid.updater.calls, []);
  assert.equal(invalid.errors.length, 1);
  invalid.controller.dispose();
  const wrong = setup();
  await wrong.controller.check();
  await wrong.controller.download();
  wrong.updater.emit('update-downloaded', {}, '', '9.9.9');
  assert.equal(wrong.controller.getState().phase, 'error');
  await assert.rejects(wrong.controller.restart(), /No prepared/);
  wrong.controller.dispose();
});

test('desktop network and native updater errors remain visible and retryable', async () => {
  const offline = setup({ loadRelease: async () => { throw Object.assign(new Error('Offline'), { httpStatus: 503 }); } });
  const state = await offline.controller.check();
  assert.equal(state.phase, 'error');
  assert.match(state.message, /HTTP 503/);
  assert.equal(offline.errors.length, 1);
  offline.controller.dispose();
  const f = setup();
  await f.controller.check();
  await f.controller.download();
  f.updater.emit('error', new Error('Update.exe failed'));
  assert.equal(f.controller.getState().phase, 'error');
  assert.equal((await f.controller.check()).phase, 'available');
  f.controller.dispose();
});

test('desktop closing during confirmation prevents any later update action', async () => {
  let finish;
  const f = setup({ confirm: () => new Promise((resolve) => { finish = resolve; }) });
  await f.controller.check();
  const pending = f.controller.download();
  f.controller.dispose();
  finish(true);
  await pending;
  assert.deepEqual(f.prepared, []);
  assert.deepEqual(f.updater.calls, []);
});

test('desktop update IPC requires the exact main window, frame and origin', () => {
  const frame = { url: `${DESKTOP_ORIGIN}/` };
  const contents = { mainFrame: frame };
  assert.equal(trustedDesktopUpdateRequest({ sender: contents, senderFrame: frame }, contents), true);
  assert.equal(trustedDesktopUpdateRequest({ sender: {}, senderFrame: frame }, contents), false);
  assert.equal(trustedDesktopUpdateRequest({ sender: contents, senderFrame: { url: `${DESKTOP_ORIGIN}/` } }, contents), false);
  frame.url = 'https://example.test';
  assert.equal(trustedDesktopUpdateRequest({ sender: contents, senderFrame: frame }, contents), false);
  assert.equal(trustedDesktopUpdateRequest(null, contents), false);
});
