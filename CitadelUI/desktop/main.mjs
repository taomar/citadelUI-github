import {
  app,
  BrowserWindow,
  dialog,
  safeStorage,
  session,
  utilityProcess,
} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DESKTOP_ALLOWED_HOST,
  DESKTOP_HOST,
  DESKTOP_ORIGIN,
  DESKTOP_PARTITION,
  DESKTOP_PORT,
  decodeCredentialKey,
  desktopPermissionAllowed,
  resourceRoot,
  serverProcessPath,
  trustedDesktopOrigin,
} from './runtime-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const smokeTest = process.env.CITADEL_DESKTOP_SMOKE_TEST === 'true';
const userDataOverride = process.env.CITADEL_DESKTOP_USER_DATA_ROOT;

if (userDataOverride) app.setPath('userData', resolve(userDataOverride));
if (squirrelStartup) app.quit();

const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) app.quit();

let mainWindow = null;
let serverProcess = null;
let quitting = false;

function atomicWrite(path, bytes) {
  return mkdir(dirname(path), { recursive: true }).then(async () => {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  });
}

async function encryptCredentialKey(value) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return null;
  return safeStorage.encryptStringAsync(value);
}

async function loadCredentialKey() {
  const keyPath = join(app.getPath('userData'), 'secure', 'credential-key.bin');
  let encrypted;
  try {
    encrypted = await readFile(keyPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { key: null, reason: 'desktop-key-unreadable' };
    }
  }

  if (encrypted) {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        return { key: null, reason: 'desktop-secure-storage-unavailable' };
      }
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      const key = decodeCredentialKey(decrypted.result);
      if (!key) return { key: null, reason: 'desktop-key-invalid' };
      if (decrypted.shouldReEncrypt) {
        try {
          const replacement = await safeStorage.encryptStringAsync(decrypted.result);
          await atomicWrite(keyPath, replacement);
        } catch {
          console.error(JSON.stringify({ event: 'citadel_desktop_key_reencrypt_failed' }));
        }
      }
      return { key, reason: 'ready' };
    } catch {
      return { key: null, reason: 'desktop-key-unreadable' };
    }
  }

  const key = randomBytes(32);
  const encoded = key.toString('base64');
  try {
    const protectedBytes = await encryptCredentialKey(encoded);
    if (!protectedBytes) {
      key.fill(0);
      return { key: null, reason: 'desktop-secure-storage-unavailable' };
    }
    await atomicWrite(keyPath, protectedBytes);
    return { key, reason: 'ready' };
  } catch {
    key.fill(0);
    return { key: null, reason: 'desktop-key-unreadable' };
  }
}

function childEnvironment(runtimeRoot, dataRoot) {
  const environment = {
    NODE_ENV: 'production',
    CITADEL_UI_HOST: DESKTOP_HOST,
    CITADEL_UI_PORT: String(DESKTOP_PORT),
    CITADEL_ALLOWED_HOST: DESKTOP_ALLOWED_HOST,
    CITADEL_ALLOWED_ORIGIN: DESKTOP_ORIGIN,
    CITADEL_DATA_ROOT: dataRoot,
    CITADEL_DESKTOP_RESOURCE_ROOT: runtimeRoot,
  };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function startServer(keyState) {
  const runtimeRoot = resourceRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopDirectory: here,
  });
  const entry = serverProcessPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopDirectory: here,
  });
  const dataRoot = join(app.getPath('userData'), 'data');
  const child = utilityProcess.fork(entry, [], {
    cwd: runtimeRoot,
    env: childEnvironment(runtimeRoot, dataRoot),
    serviceName: 'Citadel UI Server',
    stdio: 'pipe',
  });
  serverProcess = child;

  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    let output = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectReady(new Error('The Citadel desktop server did not become ready.'));
    }, 20_000);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    child.once('spawn', () => {
      if (keyState.key) {
        child.postMessage({ type: 'credential-key', bytes: new Uint8Array(keyState.key) });
        keyState.key.fill(0);
      } else {
        child.postMessage({
          type: 'credential-key-unavailable',
          reason: keyState.reason,
        });
      }
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      output += chunk;
      let newline = output.indexOf('\n');
      while (newline >= 0) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (line) {
          console.log(line);
          try {
            const message = JSON.parse(line);
            if (message.event === 'citadel_ui_started' && message.status === 'ready') {
              finish(resolveReady, child);
            }
          } catch {
            // The embedded server owns its output format; non-JSON diagnostics
            // stay visible without being treated as a readiness signal.
          }
        }
        newline = output.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => console.error(String(chunk).trim()));
    child.once('exit', (code) => {
      if (!settled) {
        finish(rejectReady, new Error(`The Citadel desktop server exited during startup (${code}).`));
        return;
      }
      if (!quitting) {
        dialog.showErrorBox(
          'Citadel UI stopped',
          'The embedded Citadel server stopped unexpectedly. Citadel UI will close.'
        );
        app.quit();
      }
    });
  });
}

function isTrustedContents(webContents) {
  return Boolean(webContents && trustedDesktopOrigin(webContents.getURL()));
}

function configureSession() {
  const desktopSession = session.fromPartition(DESKTOP_PARTITION);
  desktopSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin) =>
      isTrustedContents(webContents) &&
      desktopPermissionAllowed(permission, requestingOrigin)
  );
  desktopSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingOrigin = details?.requestingUrl || webContents?.getURL() || '';
    callback(
      isTrustedContents(webContents) &&
        desktopPermissionAllowed(permission, requestingOrigin)
    );
  });
  desktopSession.on('file-system-access-restricted', async (_event, details, callback) => {
    if (
      details.origin !== DESKTOP_ORIGIN ||
      !mainWindow ||
      details.webContents !== mainWindow.webContents
    ) {
      callback('deny');
      return;
    }
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Restricted folder',
      message: 'This folder is protected by the operating system.',
      detail: 'Choose another folder unless this Citadel repository must use the protected location.',
      buttons: ['Choose another folder', 'Allow this folder', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    callback(result.response === 1 ? 'allow' : result.response === 0 ? 'tryAgain' : 'deny');
  });
  return desktopSession;
}

async function createWindow(desktopSession) {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#f4f8fc',
    autoHideMenuBar: true,
    webPreferences: {
      session: desktopSession,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = window;

  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedDesktopOrigin(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => {
    if (!smokeTest) window.show();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  await window.loadURL(DESKTOP_ORIGIN);
  if (smokeTest) {
    const result = await window.webContents.executeJavaScript(
      `({
        title: document.title,
        secureContext: globalThis.isSecureContext,
        directoryPicker: typeof globalThis.showDirectoryPicker === 'function',
        indexedDB: Boolean(globalThis.indexedDB),
        origin: globalThis.location.origin
      })`
    );
    const passed =
      result.title === 'Citadel Control Panel' &&
      result.secureContext === true &&
      result.directoryPicker === true &&
      result.indexedDB === true &&
      result.origin === DESKTOP_ORIGIN;
    console.log(JSON.stringify({ event: 'citadel_desktop_smoke', passed, ...result }));
    process.exitCode = passed ? 0 : 1;
    app.quit();
  }
  return window;
}

async function launch() {
  const desktopSession = configureSession();
  const keyState = await loadCredentialKey();
  try {
    await startServer(keyState);
  } catch (error) {
    keyState.key?.fill(0);
    throw error;
  }
  await createWindow(desktopSession);
}

app.whenReady().then(launch).catch((error) => {
  dialog.showErrorBox(
    'Citadel UI could not start',
    error?.message || 'The desktop application could not start.'
  );
  app.exit(1);
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('activate', () => {
  if (!mainWindow && serverProcess) {
    createWindow(session.fromPartition(DESKTOP_PARTITION)).catch((error) => {
      dialog.showErrorBox('Citadel UI could not open', error?.message || 'The window could not open.');
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  quitting = true;
  serverProcess?.kill();
  serverProcess = null;
});
