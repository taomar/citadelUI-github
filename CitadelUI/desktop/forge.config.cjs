const path = require('node:path');

const desktopRoot = __dirname;
const applicationRoot = path.resolve(desktopRoot, '..');

module.exports = {
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
      path.resolve(applicationRoot, '..', 'LICENSE'),
    ],
    ignore: [
      /^\/out($|\/)/,
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
      platforms: ['win32'],
      config: {},
    },
  ],
};
