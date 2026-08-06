const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, Notification, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
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
let compactDrag = null;
let applyingLayout = 0;
let replacementScheduled = false;

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

// 창은 아래 모서리를 고정점으로 삼아 위로 자란다. 그래서 위치를 저장할 때
// 좌상단뿐 아니라 아래 모서리(bottom)도 같이 남겨, 다시 켰을 때 기본 크기로
// 열렸다가 내용 크기로 커져도 아래 모서리가 제자리에 있게 한다.
function rememberPosition() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  saveSettings({ x: b.x, y: b.y, bottom: b.y + b.height });
}

// 단일 인스턴스 잠금을 사용하지 않던 구버전이 이미 실행 중이어도 새 버전이
// 자리를 넘겨받을 수 있도록, 현재 메인 프로세스를 제외한 구형 최상위 프로세스만 종료한다.
function stopLegacyInstances() {
  if (process.platform !== 'win32') return;
  const script = [
    `$currentPid = ${process.pid}`,
    "$targets = Get-CimInstance Win32_Process -Filter \"Name = 'WorkieTokey.exe'\" | Where-Object { $_.ProcessId -ne $currentPid -and $_.CommandLine -notmatch '--type=' }",
    "$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000
    });
  } catch {}
}

function currentLaunchSpec() {
  const portablePath = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portablePath && path.isAbsolute(portablePath)) {
    return { execPath: portablePath, args: [] };
  }
  return {
    execPath: process.execPath,
    args: process.defaultApp ? process.argv.slice(1) : []
  };
}

function replacementData() {
  return { workieTokeyReplacement: true, ...currentLaunchSpec() };
}

function restartWithReplacement(data) {
  if (replacementScheduled || !data || data.workieTokeyReplacement !== true) return;
  if (typeof data.execPath !== 'string' || !path.isAbsolute(data.execPath) || !fs.existsSync(data.execPath)) return;
  const args = Array.isArray(data.args) && data.args.every((arg) => typeof arg === 'string') ? data.args : [];

  replacementScheduled = true;
  rememberPosition();
  app.relaunch({ execPath: data.execPath, args });
  app.quit();
}

function defaultPosition(size) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - size.width - 24,
    y: workArea.y + workArea.height - size.height - 24
  };
}

// 작업표시줄 위에 둔 좌표도 그대로 복원한다. 모니터 구성이 바뀐 경우에만
// 최소한의 손잡이 영역을 화면 안에 남겨 다시 끌어올 수 있게 한다.
function restorePosition(x, y, width, height) {
  const bounds = screen.getDisplayNearestPoint({ x, y }).bounds;
  const visible = 32;
  return {
    x: Math.max(bounds.x - width + visible, Math.min(x, bounds.x + bounds.width - visible)),
    y: Math.max(bounds.y - height + visible, Math.min(y, bounds.y + bounds.height - visible))
  };
}

function keepWindowOnTop(force = false) {
  if (!win || win.isDestroyed()) return;
  if (force || !win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
  }
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
  saveSettings({ ...pos, bottom: pos.y + b.height });
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
    ? restorePosition(
        settings.x,
        Number.isFinite(settings.bottom) ? settings.bottom - size.height : settings.y,
        size.width,
        size.height
      )
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

  keepWindowOnTop(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenu(null);
  // 작업표시줄/Alt-Tab 아이콘은 exe에 내장된 다중 해상도 ICO를 그대로 쓴다.
  // setIcon으로 256px PNG를 넘기면 Windows가 작은 크기로 축소하면서
  // 픽셀아트가 뭉개진다.
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.on('moved', () => {
    if (applyingLayout || compactDrag) return;
    rememberPosition();
  });
  win.on('close', rememberPosition);

  // Windows에서 다른 창이나 가상 데스크톱 전환 후 최상위 레벨이 풀리는
  // 경우를 복구한다. 포커스를 빼앗지는 않는다.
  win.on('show', () => keepWindowOnTop(true));
  win.on('restore', () => keepWindowOnTop(true));
  win.on('blur', () => keepWindowOnTop(true));
  win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
    if (!isAlwaysOnTop) setImmediate(() => keepWindowOnTop(true));
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
// 툴팁 = 소스별 대표 사용량 창의 잔량 텍스트
function updateTray(state) {
  if (!tray) return;
  const all = progressLines(state);

  // 툴팁: 프로바이더별 첫 progress 라인 잔량
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

// 렌더러가 측정한 내용 크기에 맞춰 창 크기를 바꾼다. 왼쪽과 **아래** 모서리를
// 고정점으로 삼아, 카드가 펼쳐질 때 아래가 아니라 위로 자라게 한다.
// (왼쪽/아래 고정은 결정적이라 갱신마다 창이 떠다니지 않는다.)
function applyContentSize(width, height) {
  if (!win || win.isDestroyed()) return;
  width = Math.ceil(width);
  height = Math.ceil(height);
  if (width < 40 || height < 20) return;
  const b = win.getBounds();
  if (b.width === width && b.height === height) return;

  let y = b.y + b.height - height;
  // 위로 자라다 화면 밖으로 나가면 화면 상단에서 멈춘다
  const screenTop = screen.getDisplayMatching(b).bounds.y;
  if (y < screenTop) y = screenTop;

  applyingLayout += 1;
  win.setBounds({ x: b.x, y, width, height });
  setImmediate(() => { applyingLayout = Math.max(0, applyingLayout - 1); });
  saveSettings({ x: b.x, y, bottom: y + height });
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

// 컴팩트 모드는 전체 영역이 클릭 대상이므로 네이티브 drag region 대신
// 클릭과 드래그를 구분하는 작은 커스텀 드래그 경로를 쓴다.
ipcMain.on('start-window-drag', () => {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  compactDrag = { x, y };
});

ipcMain.on('move-window-drag', (_event, delta) => {
  if (!win || win.isDestroyed() || !compactDrag) return;
  const dx = Number.isFinite(delta.dx) ? Math.round(delta.dx) : 0;
  const dy = Number.isFinite(delta.dy) ? Math.round(delta.dy) : 0;
  win.setPosition(compactDrag.x + dx, compactDrag.y + dy, false);
});

ipcMain.on('end-window-drag', () => {
  if (!win || win.isDestroyed() || !compactDrag) return;
  compactDrag = null;
  rememberPosition();
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

const hasSingleInstanceLock = app.requestSingleInstanceLock(replacementData());

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, _commandLine, _workingDirectory, data) => {
    restartWithReplacement(data);
  });

  app.whenReady().then(() => {
    // requestSingleInstanceLock을 사용하지 않는 설치본이 남아 있다면 여기서 종료한다.
    stopLegacyInstances();

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
}

app.on('before-quit', rememberPosition);

app.on('window-all-closed', () => {
  clearInterval(pollTimer);
  if (apiServer) apiServer.close();
  app.quit();
});
