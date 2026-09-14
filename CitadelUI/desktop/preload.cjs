const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('citadelDesktopUpdates', {
  state: () => ipcRenderer.invoke('citadel-desktop-updates:state'),
  check: () => ipcRenderer.invoke('citadel-desktop-updates:check'),
  download: () => ipcRenderer.invoke('citadel-desktop-updates:download'),
  restart: () => ipcRenderer.invoke('citadel-desktop-updates:restart'),
  viewRelease: () => ipcRenderer.invoke('citadel-desktop-updates:viewRelease'),
  subscribe: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('An update callback is required.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('citadel-desktop-updates:changed', listener);
    return () => ipcRenderer.removeListener('citadel-desktop-updates:changed', listener);
  },
});
