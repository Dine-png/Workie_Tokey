const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workieTokey', {
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onMode: (callback) => ipcRenderer.on('mode', (_event, mode) => callback(mode)),
  onPrefs: (callback) => ipcRenderer.on('prefs', (_event, prefs) => callback(prefs)),
  toggleMode: () => ipcRenderer.send('toggle-mode'),
  toggleTheme: () => ipcRenderer.send('toggle-theme'),
  setChartCollapsed: (id, collapsed) => ipcRenderer.send('set-chart-collapsed', { id, collapsed }),
  reportSize: (width, height) => ipcRenderer.send('content-size', { width, height }),
  startWindowDrag: () => ipcRenderer.send('start-window-drag'),
  moveWindowDrag: (dx, dy) => ipcRenderer.send('move-window-drag', { dx, dy }),
  endWindowDrag: () => ipcRenderer.send('end-window-drag'),
  // 설정 패널
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setShowChart: (on) => ipcRenderer.send('set-show-chart', on),
  setAutostart: (on) => ipcRenderer.send('set-autostart', on),
  resetPosition: () => ipcRenderer.send('reset-position'),
  refreshNow: () => ipcRenderer.send('refresh-now'),
  quitApp: () => ipcRenderer.send('quit-app')
});
