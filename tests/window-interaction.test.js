const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const mainPath = path.join(__dirname, '..', 'src', 'main.js');

// Exercise the actual main-process IPC and tray handlers without opening windows,
// reading real settings, loading providers, or starting the local HTTP server.
function launch(initialSettings = {}) {
  let settings = { httpApi: false, ...initialSettings };
  let ready;
  let window;
  let tray;
  const handlers = new Map();
  const intervals = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);

  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      window = this;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.visible = true;
      this.minimized = false;
      this.topmost = options.alwaysOnTop;
      this.ignoresMouse = false;
      this.protectedContent = false;
      this.calls = [];
      this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, value) => this.messages.push({ channel, value });
    }
    isDestroyed() { return false; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    setPosition(x, y) { Object.assign(this.bounds, { x, y }); }
    isAlwaysOnTop() { return this.topmost; }
    setAlwaysOnTop(on) { this.topmost = on; }
    moveTop() { this.calls.push('moveTop'); }
    setVisibleOnAllWorkspaces() {}
    setMenu() {}
    loadFile() {}
    setContentProtection(on) { this.protectedContent = on; }
    setIgnoreMouseEvents(on) { this.ignoresMouse = on; this.calls.push(`ignore:${on}`); }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    hide() { this.visible = false; this.calls.push('hide'); }
    show() { this.visible = true; this.calls.push('show'); this.emit('show'); }
    showInactive() { this.show(); }
    focus() { this.calls.push('focus'); }
    restore() { this.minimized = false; this.calls.push('restore'); this.emit('restore'); }
  }

  class FakeTray extends EventEmitter {
    constructor() { super(); tray = this; }
    setToolTip() {}
    setImage() {}
    setContextMenu(menu) { this.menu = menu; }
  }

  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    getPath: () => '/fake/workie-user-data',
    getAppPath: () => '/fake/workie-app',
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings() {},
    setAppUserModelId() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: (callback) => { ready = callback; } }),
    quit() {},
    relaunch() {}
  });
  const display = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 }
  };
  const electron = {
    app, BrowserWindow: FakeWindow, Tray: FakeTray, ipcMain,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromBuffer: () => ({}) },
    screen: {
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display
    },
    Notification: { isSupported: () => false },
    nativeTheme: { shouldUseDarkColors: false }
  };
  const fakeFs = {
    readFileSync(file) {
      assert.equal(path.basename(file), 'settings.json');
      return JSON.stringify(settings);
    },
    writeFileSync(file, contents) {
      assert.equal(path.basename(file), 'settings.json');
      settings = JSON.parse(contents);
    },
    existsSync: () => false
  };
  const dependencies = {
    electron, path, fs: fakeFs,
    child_process: { execFileSync() { throw new Error('Unexpected external process'); } },
    './providers': { providers: [], collectAll: async () => ({ providers: [] }) },
    './httpapi': { start() { throw new Error('Unexpected HTTP server'); } },
    './history': { record() {}, flush() {}, summary: () => ({}) },
    './providers/lines': {},
    './trayicon': { makeTrayPng: () => Buffer.alloc(0) }
  };
  const context = vm.createContext({
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    __dirname: path.dirname(mainPath),
    process: { platform: 'linux', env: {}, execPath: '/fake/electron', argv: ['/fake/electron'], pid: 123 },
    console,
    setInterval(callback, duration) { intervals.set(duration, callback); return duration; },
    clearInterval: (duration) => intervals.delete(duration),
    setImmediate: (callback) => callback()
  });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath });
  ready();
  window.webContents.emit('did-finish-load');
  return {
    window, tray,
    settings: () => ({ ...settings }),
    send: (channel, value) => ipcMain.emit(channel, {}, value),
    getSettings: () => handlers.get('get-settings')({}),
    runTopmostTimer: () => intervals.get(2000)()
  };
}

test('legacy hover-based click-through is disabled on upgrade without losing other preferences', () => {
  const app = launch({ agentMode: true, clickThrough: true, compact: true, theme: 'dark' });
  assert.equal(app.window.ignoresMouse, false);
  assert.equal(app.getSettings().clickThrough, false);
  assert.equal(app.settings().clickThrough, false);
  assert.equal(app.settings().clickThroughControl, 'manual');
  assert.equal(app.settings().agentMode, true);
  assert.equal(app.settings().compact, true);
  assert.equal(app.settings().theme, 'dark');
});

test('explicit click-through can be enabled, survives restart, and can be disabled', () => {
  const app = launch({ agentMode: true });
  app.send('set-click-through', true);
  assert.equal(app.window.ignoresMouse, true);
  assert.equal(app.getSettings().clickThrough, true);
  assert.equal(app.settings().clickThroughControl, 'manual');

  const restarted = launch(app.settings());
  assert.equal(restarted.window.ignoresMouse, true);
  restarted.send('set-click-through', false);
  assert.equal(restarted.window.ignoresMouse, false);
  assert.equal(restarted.getSettings().clickThrough, false);
});

test('agent mode protects captures without enabling click-through and turning it off restores clicks', () => {
  const app = launch();
  app.send('set-agent-mode', true);
  assert.equal(app.window.protectedContent, true);
  assert.equal(app.window.ignoresMouse, false);

  app.send('set-click-through', true);
  assert.equal(app.window.ignoresMouse, true);
  app.send('set-agent-mode', false);
  assert.equal(app.window.protectedContent, false);
  assert.equal(app.window.ignoresMouse, false);
  app.send('set-agent-mode', true);
  assert.equal(app.window.protectedContent, true);
  assert.equal(app.window.ignoresMouse, false);
});

test('tray click restores interaction instead of hiding an overlay with click-through enabled', () => {
  const app = launch({ agentMode: true, clickThrough: true, clickThroughControl: 'manual' });
  app.window.calls.length = 0;
  app.tray.emit('click');
  assert.equal(app.window.ignoresMouse, false);
  assert.equal(app.window.visible, true);
  assert.equal(app.settings().clickThrough, false);
  assert.equal(app.window.protectedContent, true);
  assert.ok(app.window.calls.includes('focus'));
  assert.ok(!app.window.calls.includes('hide'));
});

test('tray click restores a minimized overlay instead of hiding it', () => {
  const app = launch();
  app.window.minimized = true;
  app.window.calls.length = 0;
  app.tray.emit('click');
  assert.equal(app.window.minimized, false);
  assert.equal(app.window.visible, true);
  assert.ok(app.window.calls.includes('restore'));
  assert.ok(app.window.calls.includes('focus'));
  assert.ok(!app.window.calls.includes('hide'));
});

test('tray click keeps normal hide/show behavior and returns a hidden compact overlay to card mode', () => {
  const app = launch({ compact: true });
  app.tray.emit('click');
  assert.equal(app.window.visible, false);
  app.tray.emit('click');
  assert.equal(app.window.visible, true);
  assert.equal(app.settings().compact, false);
  assert.ok(app.window.calls.includes('focus'));
});

test('topmost refresh does not raise hidden or minimized windows', () => {
  const app = launch();
  app.tray.emit('click');
  app.window.calls.length = 0;
  app.runTopmostTimer();
  assert.ok(!app.window.calls.includes('moveTop'));
  assert.equal(app.window.visible, false);

  app.tray.emit('click');
  app.window.minimized = true;
  app.window.calls.length = 0;
  app.runTopmostTimer();
  assert.ok(!app.window.calls.includes('moveTop'));
  assert.equal(app.window.minimized, true);
});
