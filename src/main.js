const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, Notification, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const registry = require('./providers');
const httpapi = require('./httpapi');
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
let apiServer = null;
let latestState = null; // 로컬 HTTP API가 노출하는 최신 스냅샷

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

// 표기 관련 사용자 설정(렌더러로 전달). 기본: 그래프 표시 ON, 펼침.
// chartCollapsed는 프로바이더별 접힘 맵 { [id]: bool } (구버전 boolean 호환).
function currentPrefs() {
  const s = loadSettings();
  let chartCollapsed = s.chartCollapsed;
  if (typeof chartCollapsed === 'boolean') chartCollapsed = {};
  if (!chartCollapsed || typeof chartCollapsed !== 'object') chartCollapsed = {};
  return {
    showChart: s.showChart !== false,
    chartCollapsed
  };
}

function isAutostart() {
  return app.getLoginItemSettings({ args: loginItemArgs() }).openAtLogin;
}

function setAutostart(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: loginItemArgs() });
}

function resetPosition() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const pos = defaultPosition(b);
  win.setBounds({ ...pos, width: b.width, height: b.height });
  saveSettings(pos);
}

function sendPrefs() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('prefs', currentPrefs());
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
    sendPrefs();
    tick();
  });
}

// 모든 등록된 프로바이더를 수집 → { collectedAt, providers: [...] }
async function collect() {
  return registry.collectAll();
}

// 상태에서 모든 progress 라인을 (프로바이더 + 라인) 쌍으로 평탄화
function progressLines(state) {
  const out = [];
  for (const p of state.providers || []) {
    if (p.error) continue;
    for (const line of p.lines || []) {
      if (line.type === 'progress' && line.remainingPercent !== null) {
        out.push({ provider: p, line });
      }
    }
  }
  return out;
}

// 잔량이 20% 이하로 떨어지는 순간 한 번만 알림 (리셋되면 다시 활성화)
const ALERT_THRESHOLD = 20;
const alerted = {};

function checkAlerts(state) {
  for (const { provider, line } of progressLines(state)) {
    const key = `${provider.id}-${line.key}`;
    const label = line.label;
    const remaining = line.remainingPercent;
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
  const all = progressLines(state);

  // 툴팁: 프로바이더별 첫 progress 라인(보통 5시간 윈도우) 잔량
  const seen = new Set();
  const parts = [];
  for (const { provider, line } of all) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    parts.push(`${provider.label} ${Math.round(line.remainingPercent)}%`);
  }
  tray.setToolTip(parts.length > 0 ? `Workie Tokey — ${parts.join(' · ')} 남음` : 'Workie Tokey');

  // 아이콘 게이지: 모든 윈도우 중 가장 적게 남은 값
  if (all.length > 0) {
    const minRemaining = Math.min(...all.map(({ line }) => line.remainingPercent));
    tray.setImage(nativeImage.createFromBuffer(makeTrayPng(minRemaining, minRemaining <= ALERT_THRESHOLD)));
  }
}

async function tick() {
  if (!win || win.isDestroyed()) return;
  const state = await collect();
  latestState = state;
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
      label: '사용량 그래프 표시',
      type: 'checkbox',
      checked: currentPrefs().showChart,
      click: (item) => {
        saveSettings({ showChart: item.checked });
        sendPrefs();
      }
    },
    {
      label: '시작 시 자동 실행',
      type: 'checkbox',
      checked: isAutostart(),
      click: (item) => setAutostart(item.checked)
    },
    {
      label: '위치 초기화',
      click: resetPosition
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

// 차트 접기/펼치기 (카드의 캐럿). 프로바이더별로 영구 저장.
ipcMain.on('set-chart-collapsed', (_event, { id, collapsed }) => {
  const map = currentPrefs().chartCollapsed;
  map[id] = !!collapsed;
  saveSettings({ chartCollapsed: map });
});

// ── 설정 패널 IPC ──────────────────────────────────────
ipcMain.handle('get-settings', () => ({
  showChart: currentPrefs().showChart,
  autostart: isAutostart()
}));

ipcMain.on('set-show-chart', (_event, on) => {
  saveSettings({ showChart: !!on });
  sendPrefs();
  buildTrayMenu();
});

ipcMain.on('set-autostart', (_event, on) => setAutostart(!!on));
ipcMain.on('reset-position', resetPosition);
ipcMain.on('refresh-now', () => tick());
ipcMain.on('quit-app', () => app.quit());


app.setAppUserModelId('com.workietokey.app');

app.whenReady().then(() => {
  const savedTheme = loadSettings().theme;
  if (savedTheme === 'light' || savedTheme === 'dark') {
    nativeTheme.themeSource = savedTheme;
  }
  createWindow();
  createTray();
  pollTimer = setInterval(tick, POLL_MS);
  if (loadSettings().httpApi !== false) {
    apiServer = httpapi.start(() => latestState);
  }
});

app.on('window-all-closed', () => {
  clearInterval(pollTimer);
  if (apiServer) apiServer.close();
  app.quit();
});
