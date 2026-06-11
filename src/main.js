const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, Notification, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const codex = require('./adapters/codex');
const claude = require('./adapters/claude');
const { makeTrayPng } = require('./trayicon');
const i18n = require('../renderer/i18n');

// 초기 추정 크기 — 렌더러가 실제 내용 크기를 측정해 즉시 보정한다
const SIZES = {
  card: { width: 316, height: 206 },
  compact: { width: 230, height: 36 }
};

const DEFAULT_SETTINGS = {
  theme: 'system',          // 'system' | 'light' | 'dark'
  language: 'auto',         // 'auto' | 'ko' | 'en' | 'ja' | 'fr'
  hideDisconnected: true,   // 인식 안 된 AI를 목록에서 숨김
  notify: true,             // 잔량 경고 알림
  pollSeconds: 30,          // 갱신 주기
  alertThreshold: 20,       // 잔량 경고 기준 %
  sources: {
    claude: { path: null }, // null이면 자동 인식
    codex: { path: null }
  }
};

let win = null;
let settingsWin = null;
let tray = null;
let pollTimer = null;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {}
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    sources: {
      claude: { ...DEFAULT_SETTINGS.sources.claude, ...(saved.sources && saved.sources.claude) },
      codex: { ...DEFAULT_SETTINGS.sources.codex, ...(saved.sources && saved.sources.codex) }
    }
  };
}

function saveSettings(patch) {
  const cur = loadSettings();
  const next = {
    ...cur,
    ...patch,
    sources: {
      claude: { ...cur.sources.claude, ...(patch.sources && patch.sources.claude) },
      codex: { ...cur.sources.codex, ...(patch.sources && patch.sources.codex) }
    }
  };
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch {}
  return next;
}

function defaultPosition(size) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - size.width - 24,
    y: workArea.y + workArea.height - size.height - 24
  };
}

// 현재 위치를 기준으로, 새 크기로 바뀔 때 화면 안쪽으로 펴지도록 좌표 계산.
// 창이 화면 어느 사분면에 있는지 보고 가까운 모서리를 고정점으로 삼는다.
function anchoredBounds(targetWin, width, height) {
  const b = targetWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const centerX = b.x + b.width / 2;
  const centerY = b.y + b.height / 2;

  // 왼쪽 절반이면 왼쪽 고정(오른쪽으로 펴짐), 오른쪽이면 오른쪽 고정
  let x = centerX < wa.x + wa.width / 2 ? b.x : b.x + b.width - width;
  // 위쪽 절반이면 위 고정(아래로 펴짐), 아래쪽이면 아래 고정(위로 펴짐)
  let y = centerY < wa.y + wa.height / 2 ? b.y : b.y + b.height - height;

  // 안전하게 작업영역 안으로 클램프
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  return { x, y, width, height };
}

function clampToWorkArea(x, y, width, height) {
  const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
  return {
    x: Math.max(wa.x, Math.min(x, wa.x + wa.width - width)),
    y: Math.max(wa.y, Math.min(y, wa.y + wa.height - height))
  };
}

function currentMode() {
  return loadSettings().compact ? 'compact' : 'card';
}

function currentLang() {
  return i18n.resolve(loadSettings().language, app.getLocale());
}

function t(key, params) {
  return i18n.t(currentLang(), key, params);
}

function createWindow() {
  const mode = currentMode();
  const size = SIZES[mode];
  const settings = loadSettings();
  const pos = Number.isFinite(settings.x) && Number.isFinite(settings.y)
    ? clampToWorkArea(settings.x, settings.y, size.width, size.height)
    : defaultPosition(size);

  win = new BrowserWindow({
    ...size,
    ...pos,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenu(null);
  win.setIcon(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.on('moved', () => {
    const [x, y] = win.getPosition();
    saveSettings({ x, y });
  });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('mode', currentMode());
    win.webContents.send('settings-updated', settingsPayload());
    tick();
  });
}

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 350,
    height: 540,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWin.setMenu(null);
  settingsWin.setIcon(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')));
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// 소스별 자동 인식 상태 (인식된 경로 / 수동 지정 여부)
function detectSources() {
  const s = loadSettings();
  return {
    claude: { custom: s.sources.claude.path, ...claude.detect(s.sources.claude.path) },
    codex: { custom: s.sources.codex.path, ...codex.detect(s.sources.codex.path) }
  };
}

function settingsPayload() {
  return {
    settings: loadSettings(),
    language: currentLang(),
    autoLaunch: app.getLoginItemSettings({ args: loginItemArgs() }).openAtLogin,
    sources: detectSources()
  };
}

function broadcastSettings() {
  const payload = settingsPayload();
  for (const w of [win, settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('settings-updated', payload);
  }
}

async function collect() {
  const s = loadSettings();
  let codexState = null;
  let claudeState = null;
  try {
    codexState = await codex.read(s.sources.codex.path);
  } catch (err) {
    console.error('[codex adapter]', err.message);
  }
  try {
    claudeState = await claude.read(s.sources.claude.path);
  } catch (err) {
    console.error('[claude adapter]', err.message);
  }
  return {
    collectedAt: Date.now(),
    codex: codexState,
    claude: claudeState
  };
}

// 잔량이 경고 기준 이하로 떨어지는 순간 한 번만 알림 (리셋되면 다시 활성화)
const alerted = {};

function checkAlerts(state) {
  const { notify, alertThreshold } = loadSettings();
  const entries = [];
  if (state.claude && state.claude.primary) entries.push(['claude-5h', t('label5h', { name: 'Claude' }), state.claude.primary]);
  if (state.claude && state.claude.secondary) entries.push(['claude-week', t('labelWeekly', { name: 'Claude' }), state.claude.secondary]);
  if (state.codex && state.codex.primary) entries.push(['codex-5h', t('label5h', { name: 'Codex' }), state.codex.primary]);
  if (state.codex && state.codex.secondary) entries.push(['codex-week', t('labelWeekly', { name: 'Codex' }), state.codex.secondary]);

  for (const [key, label, w] of entries) {
    const remaining = 100 - w.usedPercent;
    if (remaining <= alertThreshold && !alerted[key]) {
      alerted[key] = true;
      if (notify && Notification.isSupported()) {
        new Notification({
          title: 'Workie Tokey',
          body: t('notifBody', { label, pct: Math.round(remaining) })
        }).show();
      }
    } else if (remaining > alertThreshold && alerted[key]) {
      alerted[key] = false;
    }
  }
}

// 트레이에서도 간략화된 잔량이 보이게: 아이콘 게이지 = 가장 적게 남은 윈도우,
// 툴팁 = 소스별 5시간 잔량 텍스트
function updateTray(state) {
  if (!tray) return;
  const { alertThreshold } = loadSettings();
  const parts = [];
  if (state.claude && !state.claude.error && state.claude.primary) {
    parts.push(`Claude ${Math.round(100 - state.claude.primary.usedPercent)}%`);
  }
  if (state.codex && state.codex.primary) {
    parts.push(`Codex ${Math.round(100 - state.codex.primary.usedPercent)}%`);
  }
  tray.setToolTip(parts.length > 0
    ? `Workie Tokey — ${t('trayLeft', { parts: parts.join(' · ') })}`
    : 'Workie Tokey');

  const windows = [
    state.claude && !state.claude.error ? state.claude.primary : null,
    state.claude && !state.claude.error ? state.claude.secondary : null,
    state.codex ? state.codex.primary : null,
    state.codex ? state.codex.secondary : null
  ].filter(Boolean);
  if (windows.length > 0) {
    const minRemaining = Math.min(...windows.map((w) => 100 - w.usedPercent));
    tray.setImage(nativeImage.createFromBuffer(makeTrayPng(minRemaining, minRemaining <= alertThreshold)));
  }
}

async function tick() {
  if (!win || win.isDestroyed()) return;
  const state = await collect();
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state', state);
  checkAlerts(state);
  updateTray(state);
  // 설정 창이 열려 있으면 소스 인식 상태도 갱신
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings-updated', settingsPayload());
  }
}

function restartPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(tick, loadSettings().pollSeconds * 1000);
}

function applyTheme() {
  const { theme } = loadSettings();
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
}

function setMode(mode) {
  saveSettings({ compact: mode === 'compact' });
  if (!win || win.isDestroyed()) return;
  // 실제 크기 조정은 렌더러가 보고하는 content-size에서 처리한다
  win.webContents.send('mode', mode);
  buildTrayMenu();
}

// 렌더러가 측정한 내용 크기에 맞춰 창을 줄이고, 화면 안쪽으로 펴지게 재배치
function applyContentSize(targetWin, width, height, persist) {
  if (!targetWin || targetWin.isDestroyed()) return;
  width = Math.ceil(width);
  height = Math.ceil(height);
  if (width < 40 || height < 20) return;
  const b = targetWin.getBounds();
  if (b.width === width && b.height === height) return;
  const next = anchoredBounds(targetWin, width, height);
  targetWin.setBounds(next);
  if (persist) saveSettings({ x: next.x, y: next.y });
}

function loginItemArgs() {
  return app.isPackaged ? [] : [app.getAppPath()];
}

function setAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: loginItemArgs()
  });
}

function buildTrayMenu() {
  if (!tray) return;
  const compact = currentMode() === 'compact';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Workie Tokey', enabled: false },
    { type: 'separator' },
    {
      label: compact ? t('trayCard') : t('trayCompact'),
      click: () => setMode(compact ? 'card' : 'compact')
    },
    { label: t('trayRefresh'), click: tick },
    { label: t('traySettings'), click: createSettingsWindow },
    {
      label: t('trayResetPos'),
      click: () => {
        const b = win.getBounds();
        const pos = defaultPosition(b);
        win.setBounds({ ...pos, width: b.width, height: b.height });
        saveSettings(pos);
      }
    },
    { type: 'separator' },
    { label: t('trayQuit'), click: () => app.quit() }
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(makeTrayPng(100, false)));
  tray.setToolTip(t('trayTooltip'));
  // 트레이 클릭: 숨겨져 있으면 펼쳐진 카드 상태로 복귀, 보이면 숨김
  tray.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      if (currentMode() === 'compact') setMode('card');
    }
  });
  buildTrayMenu();
}

ipcMain.on('toggle-mode', () => {
  setMode(currentMode() === 'compact' ? 'card' : 'compact');
});

ipcMain.on('content-size', (_event, size) => {
  applyContentSize(win, size.width, size.height, true);
});

ipcMain.on('settings-size', (_event, size) => {
  applyContentSize(settingsWin, size.width, size.height, false);
});

ipcMain.on('toggle-theme', () => {
  const next = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';
  saveSettings({ theme: next });
  applyTheme();
  broadcastSettings();
});

ipcMain.on('open-settings', createSettingsWindow);

ipcMain.on('close-settings', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

ipcMain.handle('get-settings', () => settingsPayload());

ipcMain.handle('set-settings', (_event, patch) => {
  const before = loadSettings();
  saveSettings(patch);
  applyTheme();
  if (patch.pollSeconds && patch.pollSeconds !== before.pollSeconds) restartPolling();
  if (patch.language && patch.language !== before.language) buildTrayMenu();
  broadcastSettings();
  tick();
  return settingsPayload();
});

ipcMain.handle('set-auto-launch', (_event, enabled) => {
  setAutoLaunch(enabled);
  broadcastSettings();
  return settingsPayload();
});

// 소스 경로 직접 지정 — claude는 .credentials.json 파일, codex는 .codex 폴더
ipcMain.handle('pick-source-path', async (_event, which) => {
  if (!settingsWin || settingsWin.isDestroyed()) return null;
  const opts = which === 'claude'
    ? {
        title: t('pickClaudeTitle'),
        properties: ['openFile', 'showHiddenFiles'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
    : {
        title: t('pickCodexTitle'),
        properties: ['openDirectory', 'showHiddenFiles']
      };
  const result = await dialog.showOpenDialog(settingsWin, opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.setAppUserModelId('com.workietokey.app');

app.whenReady().then(() => {
  applyTheme();
  createWindow();
  createTray();
  restartPolling();
});

app.on('window-all-closed', () => {
  clearInterval(pollTimer);
  app.quit();
});
