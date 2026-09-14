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
  desktopPermissionAllowed,
  resourceRoot,
  serverProcessPath,
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
  assert.equal(packageJson.version, '1.1.0');
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
});
