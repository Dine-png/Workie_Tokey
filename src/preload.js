const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workieTokey', {
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onMode: (callback) => ipcRenderer.on('mode', (_event, mode) => callback(mode)),
  onPrefs: (callback) => ipcRenderer.on('prefs', (_event, prefs) => callback(prefs)),
  onAgentMode: (callback) => ipcRenderer.on('agent-mode', (_event, state) => callback(state)),
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
  setAlwaysOnTop: (on) => ipcRenderer.send('set-always-on-top', on),
  setAgentMode: (on) => ipcRenderer.send('set-agent-mode', on),
  setClickThrough: (on) => ipcRenderer.send('set-click-through', on),
  resetPosition: () => ipcRenderer.send('reset-position'),
  refreshNow: () => ipcRenderer.send('refresh-now'),
  quitApp: () => ipcRenderer.send('quit-app'),
  // 계정(자체 로그인)
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  onAuthStatus: (callback) => ipcRenderer.on('auth-status', (_event, list) => callback(list)),
  onAuthResult: (callback) => ipcRenderer.on('auth-result', (_event, result) => callback(result)),
  authLogin: (id) => ipcRenderer.invoke('auth-login', id),
  authSubmitCode: (id, text) => ipcRenderer.invoke('auth-submit-code', { id, text }),
  authCancel: (id) => ipcRenderer.send('auth-cancel', id),
  authLogout: (id) => ipcRenderer.send('auth-logout', id)
});
