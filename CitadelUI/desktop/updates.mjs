import { createHash } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import { win32 } from 'node:path';

export const UPDATE_REPOSITORY = 'taomar/citadelUI-github';
export const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=20`;
const releasePrefix = 'citadel-ui-desktop-v';

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Invalid stable desktop version.');
  }
  const parts = value.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error('Invalid desktop version range.');
  return parts;
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function selectDesktopRelease(releases) {
  if (!Array.isArray(releases)) throw new Error('Invalid GitHub release response.');
  const stable = releases.filter((release) => !release.draft && !release.prerelease &&
    typeof release.tag_name === 'string' &&
    /^citadel-ui-desktop-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name));
  stable.sort((left, right) => compareVersions(
    right.tag_name.slice(releasePrefix.length), left.tag_name.slice(releasePrefix.length)
  ));
  if (!stable.length) throw new Error('No stable desktop release was found.');
  const release = stable[0];
  const version = release.tag_name.slice(releasePrefix.length);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const uploaded = (name) => assets.find((asset) => asset.name === name && asset.state === 'uploaded' &&
    Number.isSafeInteger(asset.size) && asset.size > 0);
  const feed = uploaded('RELEASES');
  const full = uploaded(`citadel_ui-${version}-full.nupkg`);
  const root = `https://github.com/${UPDATE_REPOSITORY}/releases`;
  return {
    version,
    pageUrl: `${root}/tag/${release.tag_name}`,
    feedUrl: `${root}/download/${release.tag_name}/`,
    windowsFeed: Boolean(feed && full && /^sha256:[a-f0-9]{64}$/.test(feed.digest || '')),
    feedDigest: feed?.digest || null,
    packages: assets.filter((asset) => asset.state === 'uploaded' &&
      /^citadel_ui-[\d.]+-(full|delta)\.nupkg$/.test(asset.name)).map(({ name, size }) => ({ name, size })),
  };
}

async function boundedText(response, maximum) {
  if (!response.ok) {
    throw Object.assign(new Error(`GitHub update request failed (HTTP ${response.status}).`), { httpStatus: response.status });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('The update response exceeded its size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchDesktopRelease(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(UPDATE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CitadelUI-Desktop-Updates',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  return selectDesktopRelease(JSON.parse(await boundedText(response, 2 * 1024 * 1024)));
}

export function validateWindowsFeed(text, version, packages) {
  versionParts(version);
  const lines = text.trim().split(/\r?\n/);
  const names = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{40}) ([A-Za-z0-9_.-]+) (\d+)$/i.exec(line);
    if (!match) throw new Error('Invalid Windows updater feed.');
    const [, , name, size] = match;
    const expected = [`citadel_ui-${version}-full.nupkg`, `citadel_ui-${version}-delta.nupkg`];
    const asset = packages.find((item) => item.name === name);
    if (!expected.includes(name) || names.has(name) || !asset || Number(size) !== asset.size || asset.size <= 0) {
      throw new Error('The Windows updater feed does not match the selected release.');
    }
    names.add(name);
  }
  if (!names.has(`citadel_ui-${version}-full.nupkg`)) {
    throw new Error('The Windows updater feed has no full package.');
  }
}

export async function verifyWindowsFeed(release, fetchImpl = globalThis.fetch) {
  if (!release.windowsFeed) throw new Error('This release has no verified Windows updater feed.');
  const response = await fetchImpl(`${release.feedUrl}RELEASES`, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'CitadelUI-Desktop-Updates' },
  });
  const text = await boundedText(response, 16 * 1024);
  const digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  if (digest !== release.feedDigest) throw new Error('The Windows updater feed checksum did not match.');
  validateWindowsFeed(text, release.version, release.packages);
}

export async function windowsUpdateSupport({
  platform, arch, isPackaged, dirty, executablePath, checkAccess = access,
}) {
  if (platform !== 'win32') return { supported: false, reason: 'macOS updates are notification-only.' };
  if (!isPackaged || dirty) return { supported: false, reason: 'Development builds cannot install updates.' };
  if (arch !== 'x64') return { supported: false, reason: 'This Windows architecture has no update package.' };
  const appFolder = win32.dirname(executablePath);
  if (!/^app-\d+\.\d+\.\d+$/.test(win32.basename(appFolder))) {
    return { supported: false, reason: 'Portable copy: use the Windows installer to enable in-place updates.' };
  }
  try {
    await checkAccess(win32.resolve(appFolder, '..', 'Update.exe'), constants.R_OK);
    return { supported: true, reason: 'Installed Windows application.' };
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    return { supported: false, reason: 'The installed Windows updater is missing or inaccessible.' };
  }
}

export function createUpdateController({
  version, support, loadRelease = fetchDesktopRelease, prepareUpdate = verifyWindowsFeed,
  updater = null, confirm, openRelease, notify = () => {}, onState = () => {}, onError = () => {},
}) {
  versionParts(version);
  let candidate = null;
  let checking = null;
  let acting = null;
  let notified = null;
  let disposed = false;
  let state = {
    phase: 'idle', currentVersion: version, availableVersion: null,
    canInstall: false, inPlaceSupported: Boolean(support.supported), reason: support.reason, message: '', checkedAt: null,
  };
  const getState = () => ({ ...state });
  const emit = (patch) => {
    if (disposed) return getState();
    state = { ...state, ...patch };
    onState(getState());
    return getState();
  };
  const fail = (message, error) => {
    onError(error);
    return emit({ phase: 'error', canInstall: false,
      message: `${message}${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ''}` });
  };
  const available = () => emit({
    phase: 'available',
    availableVersion: candidate.version,
    canInstall: Boolean(support.supported && updater && candidate.windowsFeed),
    reason: support.supported && !candidate.windowsFeed
      ? 'This release has no verified in-place update package. Use View release.'
      : support.reason,
    message: `v${candidate.version} is available.${support.supported ? '' : ' Notification only.'}`,
  });
  const busy = () => ['confirming', 'downloading', 'ready', 'restarting'].includes(state.phase);

  async function check() {
    if (disposed) throw new Error('The update controller is closed.');
    if (checking) return checking;
    if (busy()) return getState();
    checking = (async () => {
      emit({ phase: 'checking', message: 'Checking for updates...' });
      try {
        candidate = await loadRelease();
        const checkedAt = new Date().toISOString();
        if (compareVersions(candidate.version, version) <= 0) {
          candidate = null;
          return emit({ phase: 'current', availableVersion: null, canInstall: false,
            checkedAt, message: 'No newer version is available.' });
        }
        emit({ checkedAt });
        available();
        if (notified !== candidate.version && !disposed) {
          notified = candidate.version;
          try { notify({ version: candidate.version }); }
          catch (error) { onError(error); }
        }
        return getState();
      } catch (error) {
        return fail('Could not check for updates. Check connectivity and retry.', error);
      }
    })();
    try { return await checking; }
    finally { checking = null; }
  }

  async function download() {
    if (acting) return acting;
    if (disposed || state.phase !== 'available' || !state.canInstall || !candidate) {
      throw new Error('In-place updating is not available for this installation or release.');
    }
    const selected = candidate;
    acting = (async () => {
      emit({ phase: 'confirming', message: 'Waiting for update confirmation...' });
      try {
        if (!(await confirm('download', selected.version))) return available();
        if (disposed) return getState();
        emit({ phase: 'downloading', message: `Preparing v${selected.version}...` });
        await prepareUpdate(selected);
        if (disposed) return getState();
        updater.setFeedURL({ url: selected.feedUrl });
        await updater.checkForUpdates();
        return getState();
      } catch (error) {
        return fail('The Windows update could not be prepared. Check for updates to retry.', error);
      }
    })();
    try { return await acting; }
    finally { acting = null; }
  }

  async function restart() {
    if (acting) return acting;
    if (disposed || state.phase !== 'ready' || !state.canInstall || !updater) {
      throw new Error('No prepared in-place update is ready.');
    }
    acting = (async () => {
      emit({ phase: 'confirming', message: 'Waiting for restart confirmation...' });
      try {
        if (!(await confirm('restart', candidate.version))) {
          return emit({ phase: 'ready', message: `v${candidate.version} is ready to restart.` });
        }
        if (disposed) return getState();
        emit({ phase: 'restarting', message: 'Restarting to apply the update...' });
        updater.quitAndInstall();
        return getState();
      } catch (error) {
        return fail('The update could not restart. Save your work and restart the app manually.', error);
      }
    })();
    try { return await acting; }
    finally { acting = null; }
  }

  const onDownloaded = (_event, _notes, downloadedVersion) => {
    if (state.phase !== 'downloading' || disposed) return;
    if (downloadedVersion !== candidate?.version) {
      fail('The downloaded version did not match the selected update.', new Error('Unexpected updater version.'));
      return;
    }
    emit({ phase: 'ready', message: `v${candidate.version} is ready. Save work before restarting.` });
  };
  const onUpdaterError = (error) => fail('The Windows updater failed. Check for updates to retry.', error);
  const onNoUpdate = () => {
    if (state.phase === 'downloading') {
      fail('The Windows feed did not offer the selected update. Check for updates to retry.', new Error('Update feed mismatch.'));
    }
  };
  if (support.supported && updater) {
    updater.on('update-downloaded', onDownloaded);
    updater.on('error', onUpdaterError);
    updater.on('update-not-available', onNoUpdate);
  }
  return {
    getState, check, download, restart,
    async viewRelease() {
      if (!candidate || disposed) throw new Error('Check for an available release first.');
      await openRelease(candidate.pageUrl);
      return getState();
    },
    dispose() {
      disposed = true;
      if (support.supported && updater) {
        updater.removeListener('update-downloaded', onDownloaded);
        updater.removeListener('update-not-available', onNoUpdate);
        const removeErrorListener = () => updater.removeListener('error', onUpdaterError);
        if (acting) acting.then(removeErrorListener, removeErrorListener);
        else removeErrorListener();
      }
    },
  };
}
