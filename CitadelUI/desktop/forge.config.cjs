const path = require('node:path');
const fs = require('node:fs/promises');

const desktopRoot = __dirname;
const applicationRoot = path.resolve(desktopRoot, '..');
const macSigning = process.env.CITADEL_MACOS_SIGN === 'true';
const appleIdNotarization =
  process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      }
    : null;
const appStoreNotarization =
  process.env.APPLE_API_KEY &&
  process.env.APPLE_API_KEY_ID &&
  process.env.APPLE_API_ISSUER
    ? {
        appleApiKey: process.env.APPLE_API_KEY,
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
      }
    : null;
const notarization =
  process.platform === 'darwin' ? appStoreNotarization || appleIdNotarization : null;

if (notarization && !macSigning) {
  throw new Error('CITADEL_MACOS_SIGN=true is required when notarization is configured.');
}

module.exports = {
  hooks: {
    prePackage: async () => {
      const { createBuildInfo } = await import('./source-integrity.mjs');
      const source = JSON.parse(await fs.readFile(path.join(desktopRoot, 'application-source.json'), 'utf8'));
      const { version } = JSON.parse(await fs.readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
      const info = await createBuildInfo(path.resolve(applicationRoot, '..'), { source, version });
      await fs.mkdir(path.join(desktopRoot, '.generated'), { recursive: true });
      await fs.writeFile(path.join(desktopRoot, '.generated', 'desktop-build.json'), `${JSON.stringify(info, null, 2)}\n`);
    },
    postPackage: async (_config, { platform, outputPaths }) => {
      const { verifyPackagedSources } = await import('./source-integrity.mjs');
      for (const output of outputPaths) {
        const resources = platform === 'darwin'
          ? path.join(output, 'Citadel UI.app', 'Contents', 'Resources')
          : path.join(output, 'resources');
        await verifyPackagedSources(resources);
      }
    },
  },
  packagerConfig: {
    name: 'Citadel UI',
    executableName: 'CitadelUI',
    appBundleId: 'com.citadel.controlpanel',
    appCopyright: 'Copyright (c) Citadel UI contributors',
    asar: true,
    overwrite: true,
    prune: true,
    extraResource: [
      path.join(applicationRoot, 'server'),
      path.join(applicationRoot, 'shared'),
      path.join(applicationRoot, 'web'),
      path.join(desktopRoot, 'server-process.mjs'),
      path.join(desktopRoot, '.generated', 'desktop-build.json'),
      path.resolve(applicationRoot, '..', 'LICENSE'),
    ],
    ignore: [
      /^\/out($|\/)/,
      /^\/\.generated($|\/)/,
      /^\/run-packaged-smoke\.mjs$/,
      /^\/run-smoke\.mjs$/,
      /^\/stage-release\.mjs$/,
      /^\/README\.md$/,
    ],
    win32metadata: {
      CompanyName: 'Citadel UI contributors',
      FileDescription: 'Citadel Control Panel',
      InternalName: 'CitadelUI',
      OriginalFilename: 'CitadelUI.exe',
      ProductName: 'Citadel UI',
    },
    ...(macSigning ? { osxSign: {} } : {}),
    ...(notarization ? { osxNotarize: notarization } : {}),
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'citadel_ui',
        setupExe: 'CitadelUISetup.exe',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32', 'darwin'],
      config: {},
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        format: 'ULFO',
      },
    },
  ],
};
