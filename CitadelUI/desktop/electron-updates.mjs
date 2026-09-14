import { app, autoUpdater, dialog, ipcMain, Notification, shell } from 'electron';
import { createUpdateController, selectDesktopRelease, windowsUpdateSupport } from './updates.mjs';
import { trustedDesktopUpdateRequest } from './runtime-config.mjs';

export async function configureDesktopUpdates({ build, getWindow, smokeTest }) {
  const report = (error) => console.error(JSON.stringify({
    event: 'citadel_desktop_update_failed',
    errorType: error?.name || 'Error',
    ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
  }));
  let support;
  try {
    support = await windowsUpdateSupport({
      platform: process.platform, arch: process.arch, isPackaged: app.isPackaged,
      dirty: build.dirty, executablePath: process.execPath,
    });
  } catch (error) {
    report(error);
    support = { supported: false, reason: 'Updater access could not be checked. Notifications only; inspect the desktop logs.' };
  }
  const controller = createUpdateController({
    version: build.version,
    support,
    updater: support.supported ? autoUpdater : null,
    ...(smokeTest ? {
      loadRelease: async () => {
        const parts = build.version.split('.').map(Number);
        parts[2] += 1;
        return selectDesktopRelease([{
          tag_name: `citadel-ui-desktop-v${parts.join('.')}`, draft: false, prerelease: false, assets: [],
        }]);
      },
    } : {}),
    confirm: async (kind, version) => {
      const window = getWindow();
      if (!window || window.isDestroyed()) return false;
      const restart = kind === 'restart';
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        title: restart ? 'Restart and update Citadel UI' : 'Prepare Citadel UI update',
        message: restart ? `Restart into Citadel UI ${version}?` : `Download and prepare Citadel UI ${version}?`,
        detail: restart
          ? 'Save or deliberately discard unfinished edits first. The application will close and restart. Existing owner data, credentials and workspace records are retained.'
          : 'The Windows updater will download and stage the new application files. This may download a full package. You can keep working and choose when to restart.',
        buttons: [restart ? 'Restart and update' : 'Download update', 'Later'],
        defaultId: 1, cancelId: 1, noLink: true,
      });
      return result.response === 0;
    },
    openRelease: (url) => shell.openExternal(url),
    notify: ({ version }) => {
      if (smokeTest || !Notification.isSupported()) return;
      const notification = new Notification({
        title: 'Citadel UI update available',
        body: `Version ${version} is available. Use the update control in Citadel UI.`,
      });
      notification.on('click', () => {
        const window = getWindow();
        if (window && !window.isDestroyed()) { window.show(); window.focus(); }
      });
      notification.on('failed', () => report(new Error('Desktop notification unavailable.')));
      notification.show();
    },
    onState: (state) => {
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.send('citadel-desktop-updates:changed', state);
    },
    onError: report,
  });
  const methods = ['state', 'check', 'download', 'restart', 'viewRelease'];
  for (const method of methods) {
    ipcMain.handle(`citadel-desktop-updates:${method}`, async (event) => {
      if (!trustedDesktopUpdateRequest(event, getWindow()?.webContents)) {
        throw new Error('Only the main Citadel window can control desktop updates.');
      }
      return method === 'state' ? controller.getState() : controller[method]();
    });
  }
  let initialTimer;
  let recurringTimer;
  if (app.isPackaged && !build.dirty && !smokeTest) {
    const check = () => void controller.check().catch(report);
    initialTimer = setTimeout(check, process.argv.includes('--squirrel-firstrun') ? 60_000 : 10_000);
    recurringTimer = setInterval(check, 4 * 60 * 60 * 1000);
    initialTimer.unref();
    recurringTimer.unref();
  }
  return {
    controller,
    dispose() {
      clearTimeout(initialTimer);
      clearInterval(recurringTimer);
      for (const method of methods) ipcMain.removeHandler(`citadel-desktop-updates:${method}`);
      controller.dispose();
    },
  };
}
