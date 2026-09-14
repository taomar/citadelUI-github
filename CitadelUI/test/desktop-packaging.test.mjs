import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DESKTOP_ALLOWED_HOST,
  DESKTOP_ORIGIN,
  DESKTOP_PORT,
  decodeCredentialKey,
  desktopDiagnosticsAllowed,
  desktopVersionLabel,
  desktopPermissionAllowed,
  desktopPermissionCheckAllowed,
  resourceRoot,
  serverProcessPath,
  trustedDesktopFileSystemRequest,
  trustedDesktopOrigin,
} from '../desktop/runtime-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const citadelRoot = resolve(here, '..');

test('desktop origin is stable and separate from the container origin', () => {
  assert.equal(DESKTOP_PORT, 4174);
  assert.equal(DESKTOP_ALLOWED_HOST, '127.0.0.1:4174');
  assert.equal(DESKTOP_ORIGIN, 'http://127.0.0.1:4174');
});

test('desktop trust checks require the exact application origin', () => {
  assert.equal(trustedDesktopOrigin('http://127.0.0.1:4174/'), true);
  assert.equal(trustedDesktopOrigin('http://127.0.0.1:4174/api'), true);
  assert.equal(trustedDesktopOrigin('http://localhost:4174/'), false);
  assert.equal(trustedDesktopOrigin('https://127.0.0.1:4174/'), false);
  assert.equal(trustedDesktopOrigin('http://127.0.0.1:4174.example.test/'), false);
});

test('desktop permission allow-list is origin-bound', () => {
  assert.equal(desktopPermissionAllowed('fileSystem', DESKTOP_ORIGIN), true);
  assert.equal(desktopPermissionAllowed('clipboard-sanitized-write', DESKTOP_ORIGIN), true);
  assert.equal(desktopPermissionAllowed('loopback-network', DESKTOP_ORIGIN), true);
  assert.equal(desktopPermissionAllowed('media', DESKTOP_ORIGIN), false);
  assert.equal(desktopPermissionAllowed('fileSystem', 'https://example.test'), false);
});

test('desktop permits only its own Diagnostics popup and keeps other popups denied', () => {
  assert.equal(desktopDiagnosticsAllowed(`${DESKTOP_ORIGIN}/debug.html`), true);
  assert.equal(desktopDiagnosticsAllowed(`${DESKTOP_ORIGIN}/debug`), true);
  assert.equal(desktopDiagnosticsAllowed(`${DESKTOP_ORIGIN}/`), false);
  assert.equal(desktopDiagnosticsAllowed(`${DESKTOP_ORIGIN}/debug.html?capture=on`), false);
  assert.equal(desktopDiagnosticsAllowed('https://example.test/debug.html'), false);
});
test('desktop permission checks allow null Electron webContents only for the trusted origin', () => {
  assert.equal(desktopPermissionCheckAllowed(null, 'fileSystem', DESKTOP_ORIGIN), true);
  assert.equal(
    desktopPermissionCheckAllowed(null, 'fileSystem', 'https://example.test'),
    false
  );
  assert.equal(desktopPermissionCheckAllowed(null, 'media', DESKTOP_ORIGIN), false);
});

test('desktop version label identifies the application revision and marks development builds', () => {
  const info = { version: '1.1.4', applicationRevision: '5791d4358f2696c1f4ec2805bd6bcfc2c7d729e8', dirty: false };
  assert.equal(desktopVersionLabel(info), 'v1.1.4 | 5791d43');
  assert.equal(desktopVersionLabel({ ...info, dirty: true }), 'v1.1.4 | 5791d43 (dev)');
});
test('desktop restricted local paths accept Electron serialized origins', () => {
  const webContents = {};
  assert.equal(
    trustedDesktopFileSystemRequest(
      { origin: `${DESKTOP_ORIGIN}/`, webContents },
      webContents
    ),
    true
  );
  assert.equal(
    trustedDesktopFileSystemRequest(
      { origin: 'https://example.test/', webContents },
      webContents
    ),
    false
  );
  assert.equal(
    trustedDesktopFileSystemRequest(
      { origin: `${DESKTOP_ORIGIN}/`, webContents: {} },
      webContents
    ),
    false
  );
});

test('desktop resource paths distinguish development and packaged layouts', () => {
  const resourcesPath = resolve('C:\\Program Files\\Citadel UI\\resources');
  const desktopDirectory = resolve(citadelRoot, 'desktop');
  assert.equal(
    resourceRoot({ isPackaged: false, resourcesPath, desktopDirectory }),
    citadelRoot
  );
  assert.equal(
    serverProcessPath({ isPackaged: false, resourcesPath, desktopDirectory }),
    resolve(desktopDirectory, 'server-process.mjs')
  );
  assert.equal(
    resourceRoot({ isPackaged: true, resourcesPath, desktopDirectory }),
    resourcesPath
  );
  assert.equal(
    serverProcessPath({ isPackaged: true, resourcesPath, desktopDirectory }),
    resolve(resourcesPath, 'server-process.mjs')
  );
});

test('desktop credential key decoder accepts exactly 32 bytes', () => {
  const encoded = Buffer.alloc(32, 7).toString('base64');
  const decoded = decodeCredentialKey(encoded);
  assert.ok(decoded);
  assert.equal(decoded.length, 32);
  decoded.fill(0);
  assert.equal(decodeCredentialKey(Buffer.alloc(31).toString('base64')), null);
  assert.equal(decodeCredentialKey('not-a-key'), null);
});

test('desktop package declares pinned Electron and Forge dependencies', async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(citadelRoot, 'desktop', 'package.json'), 'utf8')
  );
  assert.equal(packageJson.main, 'main.mjs');
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.version, '1.1.4');
  assert.equal(packageJson.devDependencies.electron, '44.3.0');
  assert.equal(packageJson.devDependencies['@electron-forge/cli'], '7.11.2');
  assert.equal(packageJson.devDependencies['@electron-forge/maker-dmg'], '7.11.2');
  assert.equal(packageJson.scripts['make:win'].includes('--platform=win32'), true);
  assert.equal(packageJson.scripts['make:mac:x64'].includes('--arch=x64'), true);
  assert.equal(packageJson.scripts['make:mac:arm64'].includes('--arch=arm64'), true);
  assert.equal(packageJson.scripts['release:win'].includes('release:stage'), true);
});

test('desktop release workflow builds and publishes both Mac architectures', async () => {
  const workflow = await readFile(
    resolve(citadelRoot, '..', '.github', 'workflows', 'citadel-ui-desktop-release.yml'),
    'utf8'
  );
  assert.match(workflow, /runner: macos-26-intel\s+platform: darwin\s+arch: x64/);
  assert.match(workflow, /runner: macos-26\s+platform: darwin\s+arch: arm64/);
  assert.match(workflow, /run-packaged-smoke\.mjs/);
  assert.match(workflow, /CitadelUI-macOS-arm64\.dmg/);
  assert.match(workflow, /CitadelUI-macOS-x64\.dmg/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /test-windows-update\.mjs/);
  assert.match(workflow, /citadel_ui-\*\.nupkg/);
  assert.match(workflow, /path: CitadelUI\/desktop\/\.generated\/source-step-\*\.png\s+include-hidden-files: true/);
});
