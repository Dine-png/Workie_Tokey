const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, Notification, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const codex = require('./adapters/codex');
const claude = require('./adapters/claude');
const { makeTrayPng } = require('./trayicon');

const POLL_MS = 30 * 1000;
// 초기 추정 크기 — 렌더러가 실제 내용 크기를 측정해 즉시 보정한다
const SIZES = {
  card: { width: 316, height: 206 },
  compact: { width: 230, height: 36 }
};

let win = null;
let tray = null;
let pollTimer = null;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
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
function anchoredBounds(width, height) {
  const b = win.getBounds();
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
    tick();
  });
}

async function collect() {
  let codexState = null;
  let claudeState = null;
  try {
    codexState = await codex.read();
  } catch (err) {
    console.error('[codex adapter]', err.message);
  }
  try {
    claudeState = await claude.read();
  } catch (err) {
    console.error('[claude adapter]', err.message);
  }
  return {
    collectedAt: Date.now(),
    codex: codexState,
    claude: claudeState
  };
}

// 잔량이 20% 이하로 떨어지는 순간 한 번만 알림 (리셋되면 다시 활성화)
const ALERT_THRESHOLD = 20;
const alerted = {};

function checkAlerts(state) {
  const entries = [];
  if (state.claude && state.claude.primary) entries.push(['claude-5h', 'Claude 5시간', state.claude.primary]);
  if (state.claude && state.claude.secondary) entries.push(['claude-week', 'Claude 주간', state.claude.secondary]);
  if (state.codex && state.codex.primary) entries.push(['codex-5h', 'Codex 5시간', state.codex.primary]);
  if (state.codex && state.codex.secondary) entries.push(['codex-week', 'Codex 주간', state.codex.secondary]);

  for (const [key, label, w] of entries) {
    const remaining = 100 - w.usedPercent;
    if (remaining <= ALERT_THRESHOLD && !alerted[key]) {
      alerted[key] = true;
      if (Notification.isSupported()) {
        new Notification({
          title: 'Workie Tokey',
          body: `${label} 잔량 ${Math.round(remaining)}% — 곧 한도에 도달해요`
        }).show();
      }
    } else if (remaining > ALERT_THRESHOLD && alerted[key]) {
      alerted[key] = false;
    }
  }
}

// 트레이에서도 간략화된 잔량이 보이게: 아이콘 게이지 = 가장 적게 남은 윈도우,
// 툴팁 = 소스별 5시간 잔량 텍스트
function updateTray(state) {
  if (!tray) return;
  const parts = [];
  if (state.claude && !state.claude.error && state.claude.primary) {
    parts.push(`Claude ${Math.round(100 - state.claude.primary.usedPercent)}%`);
  }
  if (state.codex && state.codex.primary) {
    parts.push(`Codex ${Math.round(100 - state.codex.primary.usedPercent)}%`);
  }
  tray.setToolTip(parts.length > 0 ? `Workie Tokey — ${parts.join(' · ')} 남음` : 'Workie Tokey');

  const windows = [
    state.claude && !state.claude.error ? state.claude.primary : null,
    state.claude && !state.claude.error ? state.claude.secondary : null,
    state.codex ? state.codex.primary : null,
    state.codex ? state.codex.secondary : null
  ].filter(Boolean);
  if (windows.length > 0) {
    const minRemaining = Math.min(...windows.map((w) => 100 - w.usedPercent));
    tray.setImage(nativeImage.createFromBuffer(makeTrayPng(minRemaining, minRemaining <= ALERT_THRESHOLD)));
  }
}

async function tick() {
  if (!win || win.isDestroyed()) return;
  const state = await collect();
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state', state);
  checkAlerts(state);
  updateTray(state);
}

function setMode(mode) {
  saveSettings({ compact: mode === 'compact' });
  if (!win || win.isDestroyed()) return;
  // 실제 크기 조정은 렌더러가 보고하는 content-size에서 처리한다
  win.webContents.send('mode', mode);
  buildTrayMenu();
}

// 렌더러가 측정한 내용 크기에 맞춰 창을 줄이고, 화면 안쪽으로 펴지게 재배치
function applyContentSize(width, height) {
  if (!win || win.isDestroyed()) return;
  width = Math.ceil(width);
  height = Math.ceil(height);
  if (width < 40 || height < 20) return;
  const b = win.getBounds();
  if (b.width === width && b.height === height) return;
  const next = anchoredBounds(width, height);
  win.setBounds(next);
  saveSettings({ x: next.x, y: next.y });
}

function loginItemArgs() {
  return app.isPackaged ? [] : [app.getAppPath()];
}

function buildTrayMenu() {
  if (!tray) return;
  const compact = currentMode() === 'compact';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Workie Tokey', enabled: false },
    { type: 'separator' },
    {
      label: compact ? '카드 모드로 전환' : '컴팩트 모드로 전환',
      click: () => setMode(compact ? 'card' : 'compact')
    },
    { label: '지금 새로고침', click: tick },
    {
      label: '시작 시 자동 실행',
      type: 'checkbox',
      checked: app.getLoginItemSettings({ args: loginItemArgs() }).openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
          args: loginItemArgs()
        });
      }
    },
    {
      label: '위치 초기화',
      click: () => {
        const b = win.getBounds();
        const pos = defaultPosition(b);
        win.setBounds({ ...pos, width: b.width, height: b.height });
        saveSettings(pos);
      }
    },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(makeTrayPng(100, false)));
  tray.setToolTip('Workie Tokey — AI 토큰 잔량');
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
  applyContentSize(size.width, size.height);
});

ipcMain.on('toggle-theme', () => {
  const next = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';
  nativeTheme.themeSource = next;
  saveSettings({ theme: next });
});


app.setAppUserModelId('com.workietokey.app');

app.whenReady().then(() => {
  const savedTheme = loadSettings().theme;
  if (savedTheme === 'light' || savedTheme === 'dark') {
    nativeTheme.themeSource = savedTheme;
  }
  createWindow();
  createTray();
  pollTimer = setInterval(tick, POLL_MS);
});

app.on('window-all-closed', () => {
  clearInterval(pollTimer);
  app.quit();
});
