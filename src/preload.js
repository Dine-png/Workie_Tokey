const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workieTokey', {
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onMode: (callback) => ipcRenderer.on('mode', (_event, mode) => callback(mode)),
  onSettingsUpdated: (callback) => ipcRenderer.on('settings-updated', (_event, payload) => callback(payload)),
  toggleMode: () => ipcRenderer.send('toggle-mode'),
  toggleTheme: () => ipcRenderer.send('toggle-theme'),
  reportSize: (width, height) => ipcRenderer.send('content-size', { width, height }),
  reportSettingsSize: (width, height) => ipcRenderer.send('settings-size', { width, height }),
  openSettings: () => ipcRenderer.send('open-settings'),
  closeSettings: () => ipcRenderer.send('close-settings'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  pickSourcePath: (which) => ipcRenderer.invoke('pick-source-path', which)
});
