const rootEl = document.getElementById('settings');
const themeSegment = document.getElementById('theme-segment');
const autoLaunchEl = document.getElementById('auto-launch');
const hideDisconnectedEl = document.getElementById('hide-disconnected');
const notifyEl = document.getElementById('notify');
const pollSecondsEl = document.getElementById('poll-seconds');
const alertThresholdEl = document.getElementById('alert-threshold');
const languageEl = document.getElementById('language');

let lang = I18N.resolve('auto', navigator.language);
const T = (key, params) => I18N.t(lang, key, params);

// data-i18n / data-i18n-title 붙은 정적 텍스트 일괄 번역
function applyLang() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = T(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = T(el.dataset.i18nTitle);
  }
}

function renderSource(which, info) {
  const box = document.getElementById(`source-${which}`);
  const status = box.querySelector('.source-status');
  const pathEl = box.querySelector('.source-path');
  const resetBtn = box.querySelector('.reset');

  status.textContent = info.exists
    ? (info.custom ? T('statusManual') : T('statusAuto'))
    : T('statusNone');
  status.classList.toggle('ok', info.exists);
  status.classList.toggle('bad', !info.exists);

  pathEl.textContent = info.path;
  pathEl.classList.toggle('dim', !info.exists);
  resetBtn.classList.toggle('hidden', !info.custom);
}

function render(payload) {
  const { settings, autoLaunch, sources } = payload;

  lang = payload.language;
  applyLang();
  languageEl.value = settings.language;

  for (const btn of themeSegment.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.theme === settings.theme);
  }
  autoLaunchEl.checked = autoLaunch;
  hideDisconnectedEl.checked = settings.hideDisconnected;
  notifyEl.checked = settings.notify;
  pollSecondsEl.value = String(settings.pollSeconds);
  alertThresholdEl.value = String(settings.alertThreshold);

  renderSource('claude', sources.claude);
  renderSource('codex', sources.codex);
}

themeSegment.addEventListener('click', (e) => {
  const theme = e.target.dataset && e.target.dataset.theme;
  if (theme) window.workieTokey.setSettings({ theme }).then(render);
});

autoLaunchEl.addEventListener('change', () => {
  window.workieTokey.setAutoLaunch(autoLaunchEl.checked).then(render);
});

hideDisconnectedEl.addEventListener('change', () => {
  window.workieTokey.setSettings({ hideDisconnected: hideDisconnectedEl.checked }).then(render);
});

notifyEl.addEventListener('change', () => {
  window.workieTokey.setSettings({ notify: notifyEl.checked }).then(render);
});

pollSecondsEl.addEventListener('change', () => {
  window.workieTokey.setSettings({ pollSeconds: Number(pollSecondsEl.value) }).then(render);
});

alertThresholdEl.addEventListener('change', () => {
  window.workieTokey.setSettings({ alertThreshold: Number(alertThresholdEl.value) }).then(render);
});

languageEl.addEventListener('change', () => {
  window.workieTokey.setSettings({ language: languageEl.value }).then(render);
});

for (const which of ['claude', 'codex']) {
  const box = document.getElementById(`source-${which}`);
  box.querySelector('.pick').addEventListener('click', async () => {
    const picked = await window.workieTokey.pickSourcePath(which);
    if (picked) {
      render(await window.workieTokey.setSettings({ sources: { [which]: { path: picked } } }));
    }
  });
  box.querySelector('.reset').addEventListener('click', async () => {
    render(await window.workieTokey.setSettings({ sources: { [which]: { path: null } } }));
  });
}

document.getElementById('close').addEventListener('click', () => window.workieTokey.closeSettings());

// 메인 창에서 테마를 바꾸는 등 외부 변경도 반영
window.workieTokey.onSettingsUpdated(render);

// 내용 크기에 맞춰 창 크기 보정 (메인 창과 같은 방식)
function reportSize() {
  const r = rootEl.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) {
    window.workieTokey.reportSettingsSize(r.width + 4, r.height + 4);
  }
}
new ResizeObserver(reportSize).observe(rootEl);
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(reportSize);
}
window.addEventListener('load', reportSize);

window.workieTokey.getSettings().then(render);
