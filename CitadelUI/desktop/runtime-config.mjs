import { resolve } from 'node:path';

export const DESKTOP_HOST = '127.0.0.1';
export const DESKTOP_PORT = 4174;
export const DESKTOP_ALLOWED_HOST = `${DESKTOP_HOST}:${DESKTOP_PORT}`;
export const DESKTOP_ORIGIN = `http://${DESKTOP_ALLOWED_HOST}`;
export const DESKTOP_PARTITION = 'persist:citadel-ui-desktop';

const DESKTOP_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'fileSystem',
  'loopback-network',
]);

export function resourceRoot({ isPackaged, resourcesPath, desktopDirectory }) {
  return isPackaged ? resolve(resourcesPath) : resolve(desktopDirectory, '..');
}

export function serverProcessPath({ isPackaged, resourcesPath, desktopDirectory }) {
  return isPackaged
    ? resolve(resourcesPath, 'server-process.mjs')
    : resolve(desktopDirectory, 'server-process.mjs');
}

export function trustedDesktopOrigin(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    return new URL(value).origin === DESKTOP_ORIGIN;
  } catch {
    return false;
  }
}

export function desktopPermissionAllowed(permission, requestingOrigin) {
  return DESKTOP_PERMISSIONS.has(permission) && trustedDesktopOrigin(requestingOrigin);
}

export function desktopPermissionCheckAllowed(_webContents, permission, requestingOrigin) {
  // Electron may pass null webContents for file-system checks. The exact origin
  // remains authoritative; permission requests still validate WebContents.
  return desktopPermissionAllowed(permission, requestingOrigin);
}

export function desktopDiagnosticsAllowed(value) {
  if (!trustedDesktopOrigin(value)) return false;
  const url = new URL(value);
  return ['/debug', '/debug.html'].includes(url.pathname) && !url.search && !url.hash;
}

export function desktopVersionLabel(info) {
  return `v${info.version} | ${info.applicationRevision.slice(0, 7)}${info.dirty ? ' (dev)' : ''}`;
}

export function trustedDesktopUpdateRequest(event, expectedWebContents) {
  return Boolean(expectedWebContents && event?.sender === expectedWebContents &&
    event.senderFrame === expectedWebContents.mainFrame &&
    trustedDesktopOrigin(event.senderFrame?.url));
}

export function trustedDesktopFileSystemRequest(details, expectedWebContents) {
  return Boolean(
    expectedWebContents &&
    details?.webContents === expectedWebContents &&
    trustedDesktopOrigin(details?.origin)
  );
}

export function decodeCredentialKey(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}
