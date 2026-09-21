const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererPath = path.join(__dirname, '..', 'renderer', 'app.js');
const rendererSource = fs.readFileSync(rendererPath, 'utf8');
const rendererHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

// The real renderer runs with only its DOM, timers, and preload bridge replaced.
// Bubbling matters here: a button click also reaches the enclosing chip.
class Element {
  constructor() {
    this.listeners = new Map();
    this.captures = new Set();
    const classes = new Set();
    this.classList = {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value),
      toggle(value, force = !classes.has(value)) {
        if (force) classes.add(value);
        else classes.delete(value);
        return force;
      },
    };
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }

  dispatch(type, properties = {}) {
    const event = {
      type, target: this, button: 0, pointerId: 1,
      screenX: 100, screenY: 100, detail: 1,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      ...properties,
    };
    if (type === 'lostpointercapture') this.captures.delete(event.pointerId);
    for (let current = this; current; current = current.parentElement) {
      event.currentTarget = current;
      for (const callback of current.listeners.get(type) || []) callback(event);
      if (event.stopped) break;
    }
    return event;
  }

  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}

function setup() {
  const elements = new Map([...rendererHtml.matchAll(/\bid="([^"]+)"/g)]
    .map((match) => [match[1], new Element()]));
  const chip = elements.get('chip');
  const arrow = elements.get('toggle-chip');
  const items = elements.get('chip-items');
  arrow.parentElement = chip;
  items.parentElement = chip;
  const document = new Element();
  document.body = new Element();
  document.getElementById = (id) => elements.get(id);
  const calls = [];
  const subscriptions = new Map();
  const workieTokey = new Proxy({}, {
    get(_target, name) {
      if (name.startsWith('on')) return (callback) => subscriptions.set(name, callback);
      return (...args) => { calls.push({ name, args }); };
    },
  });
  const timers = new Map();
  let nextTimer = 0;
  const window = new Element();
  window.workieTokey = workieTokey;
  vm.runInNewContext(rendererSource, {
    document, window,
    ResizeObserver: class { observe() {} },
    setInterval() {},
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  }, { filename: rendererPath });
  return {
    chip, arrow, items, document,
    count: (name) => calls.filter((call) => call.name === name).length,
    emit: (name, value) => subscriptions.get(name)(value),
    runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

function click(target, chip) {
  target.dispatch('pointerdown');
  chip.dispatch('pointerup');
  chip.dispatch('lostpointercapture');
  target.dispatch('click');
}

for (const target of ['chip', 'items', 'arrow']) {
  test(`a quick click on ${target} expands exactly once, only on native click`, () => {
    const app = setup();
    app[target].dispatch('pointerdown');
    app.chip.dispatch('pointerup');
    assert.equal(app.count('toggleMode'), 0, 'pointerup must not activate a disappearing chip');
    app.chip.dispatch('lostpointercapture');
    app[target].dispatch('click');
    assert.equal(app.count('toggleMode'), 1);
    assert.equal(app.count('startWindowDrag'), 1);
    assert.equal(app.count('endWindowDrag'), 1);
  });
}

test('dragging suppresses the trailing click and the next quick click still works', () => {
  const app = setup();
  app.items.dispatch('pointerdown');
  app.chip.dispatch('pointermove', { screenX: 120 });
  assert.equal(app.chip.classList.contains('dragging'), true);
  assert.equal(app.count('moveWindowDrag'), 1);
  app.chip.dispatch('pointerup', { screenX: 120 });
  app.chip.dispatch('lostpointercapture');
  app.chip.dispatch('click');
  assert.equal(app.count('toggleMode'), 0);
  assert.equal(app.chip.classList.contains('dragging'), false);
  assert.equal(app.count('endWindowDrag'), 1);
  click(app.items, app.chip);
  assert.equal(app.count('toggleMode'), 1);
});

for (const reason of ['pointercancel', 'lostpointercapture']) {
  for (const moved of [false, true]) {
    test(`${reason} ${moved ? 'during a drag' : 'before movement'} cleans up without expanding`, () => {
      const app = setup();
      app.chip.dispatch('pointerdown');
      if (moved) app.chip.dispatch('pointermove', { screenY: 115 });
      app.chip.dispatch(reason);
      app.chip.dispatch('lostpointercapture');
      app.chip.dispatch('pointerup');
      app.chip.dispatch('click');
      assert.equal(app.count('endWindowDrag'), 1, 'interrupted gestures must finish once');
      assert.equal(app.chip.classList.contains('dragging'), false);
      assert.equal(app.chip.hasPointerCapture(1), false);
      assert.equal(app.count('toggleMode'), 0);
      click(app.chip, app.chip);
      assert.equal(app.count('toggleMode'), 1, 'a canceled gesture must not swallow the next click');
    });
  }
}

for (const key of ['Enter', ' ']) {
  test(`keyboard ${JSON.stringify(key)} on the arrow activates exactly once`, () => {
    const app = setup();
    const keydown = app.arrow.dispatch('keydown', { key });
    assert.equal(keydown.defaultPrevented, false, 'the native button must retain keyboard activation');
    app.arrow.dispatch('click', { detail: 0 });
    assert.equal(app.count('toggleMode'), 1, 'the arrow click must not also activate its parent');
  });

  test(`keyboard ${JSON.stringify(key)} on the chip activates exactly once`, () => {
    const app = setup();
    const keydown = app.chip.dispatch('keydown', { key });
    assert.equal(keydown.defaultPrevented, true);
    assert.equal(app.count('toggleMode'), 1);
  });
}

test('agent-mode updates and hover events never ask the main process to change mouse passthrough', () => {
  const app = setup();
  for (const state of [
    { agentMode: true, clickThrough: true },
    { agentMode: true, clickThrough: false },
    { agentMode: false, clickThrough: false },
  ]) {
    app.emit('onAgentMode', state);
    assert.equal(app.document.body.classList.contains('agent-mode'), state.agentMode);
    app.document.dispatch('mousemove');
    app.runTimers();
    app.document.dispatch('mouseleave');
    app.runTimers();
  }
  assert.equal(app.count('setMousePassthrough'), 0,
    'dwell timers must not turn a quick click into input for the window underneath');
});
