const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workieTokey', {
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onMode: (callback) => ipcRenderer.on('mode', (_event, mode) => callback(mode)),
  toggleMode: () => ipcRenderer.send('toggle-mode'),
  toggleTheme: () => ipcRenderer.send('toggle-theme'),
  reportSize: (width, height) => ipcRenderer.send('content-size', { width, height })
});
