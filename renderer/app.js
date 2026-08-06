const rowsEl = document.getElementById('rows');
const footerEl = document.getElementById('footer');
const cardEl = document.getElementById('card');
const chipEl = document.getElementById('chip');
const chipItemsEl = document.getElementById('chip-items');

let lastState = null;
let prefs = { showChart: true, chartCollapsed: {} };

// chartCollapsed는 프로바이더별 접힘 상태 맵 { [providerId]: bool }.
// 구버전(단일 boolean) 설정과의 호환을 위해 정규화한다.
// 기본값은 '접힘' — 차트를 처음 켜면 접힌 채로 시작하고, 사용자가 펼치면
// 그 선택만 저장한다.
function isChartCollapsed(id) {
  const c = prefs.chartCollapsed;
  if (typeof c === 'boolean') return c;
  if (c && Object.prototype.hasOwnProperty.call(c, id)) return !!c[id];
  return true;
}

const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

// 한 프로바이더의 대표(주요) 윈도우 키 — 나머지는 서브행으로 흐리게 표시
const PRIMARY_KEYS = new Set(['5h', 'main']);

function fmtReset(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${hh}:${mm} 리셋`;
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${days[d.getDay()]} ${hh}:${mm} 리셋`;
}

function fmtAgo(ms) {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return '방금 갱신됨';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분 전 갱신`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}시간 전 갱신`;
  return `${Math.round(hr / 24)}일 전 갱신`;
}

function isWarn(remaining) {
  return remaining !== null && remaining <= 20;
}

// progress 라인의 부가 텍스트: [노트 prefix] · [리셋 시각]
function progressNote(line) {
  const parts = [];
  if (line.note) parts.push(line.note);
  const reset = fmtReset(line.resetsAt);
  if (reset) parts.push(reset);
  return parts.join(' · ');
}

// ── 라인 종류별 DOM 빌더 ──────────────────────────────────────────
function renderProgress(line, accent, accentText, sub) {
  const div = document.createElement('div');
  div.className = sub ? 'row sub' : 'row';

  const warn = isWarn(line.remainingPercent);
  const barColor = warn ? 'var(--warn)' : accent;
  const txtColor = warn ? 'var(--warn-text)' : accentText;

  const top = document.createElement('div');
  top.className = 'row-top';

  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = line.label;

  const value = document.createElement('span');
  value.className = 'row-value';
  const pct = document.createElement('span');
  pct.className = 'pct';
  pct.style.color = txtColor;
  pct.textContent = `${Math.round(line.remainingPercent)}% 남음`;
  value.append(pct);

  const note = document.createElement('span');
  note.className = 'note';
  const noteText = progressNote(line);
  note.textContent = noteText ? ` · ${noteText}` : '';
  value.append(note);

  top.append(label, value);
  div.append(top);

  const gauge = document.createElement('div');
  gauge.className = 'gauge';
  const fill = document.createElement('div');
  fill.className = 'gauge-fill';
  fill.style.background = barColor;
  fill.style.width = `${Math.min(100, Math.max(0, line.remainingPercent))}%`;
  gauge.append(fill);
  div.append(gauge);
  return div;
}

function renderText(line) {
  const div = document.createElement('div');
  div.className = 'row text-row';
  const top = document.createElement('div');
  top.className = 'row-top';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = line.label;
  const value = document.createElement('span');
  value.className = 'row-value note';
  value.textContent = line.value;
  top.append(label, value);
  div.append(top);
  if (line.subtitle) {
    const sub = document.createElement('div');
    sub.className = 'note';
    sub.textContent = line.subtitle;
    div.append(sub);
  }
  return div;
}

function renderBadge(line, accent) {
  const div = document.createElement('div');
  div.className = 'row text-row';
  const top = document.createElement('div');
  top.className = 'row-top';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = line.label;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.style.color = accent;
  badge.style.borderColor = accent;
  badge.textContent = line.badgeText;
  top.append(label, badge);
  div.append(top);
  return div;
}

function renderBarChart(line, accent, providerId) {
  const collapsed = isChartCollapsed(providerId);
  const div = document.createElement('div');
  div.className = collapsed ? 'row chart-row collapsed' : 'row chart-row';

  // 헤더 전체가 접기/펼치기 토글 (no-drag)
  const top = document.createElement('div');
  top.className = 'row-top chart-head';
  top.title = collapsed ? '펼치기' : '접기';

  const left = document.createElement('span');
  left.className = 'chart-head-left';
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = collapsed ? '▸' : '▾';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = line.label;
  left.append(caret, label);
  top.append(left);

  if (line.note && !collapsed) {
    const n = document.createElement('span');
    n.className = 'row-value note';
    n.textContent = line.note;
    top.append(n);
  }
  top.addEventListener('click', () => {
    const next = !isChartCollapsed(providerId);
    if (typeof prefs.chartCollapsed !== 'object' || prefs.chartCollapsed === null) {
      prefs.chartCollapsed = {};
    }
    prefs.chartCollapsed[providerId] = next;
    window.workieTokey.setChartCollapsed(providerId, next);
    if (lastState) render(lastState);
    reportSize();
  });
  div.append(top);

  if (!collapsed) {
    const chart = document.createElement('div');
    chart.className = 'barchart';
    const max = Math.max(1, ...line.points.map((p) => p.value));
    for (const p of line.points) {
      const col = document.createElement('div');
      col.className = 'barchart-col';
      const bar = document.createElement('div');
      bar.className = 'barchart-bar';
      bar.style.background = accent;
      bar.style.height = `${Math.round((p.value / max) * 100)}%`;
      bar.title = p.valueLabel || String(p.value);
      const cap = document.createElement('span');
      cap.className = 'barchart-cap';
      cap.textContent = p.label;
      col.append(bar, cap);
      chart.append(col);
    }
    div.append(chart);
  }
  return div;
}

function renderProviderError(p) {
  const div = document.createElement('div');
  div.className = 'row';
  const top = document.createElement('div');
  top.className = 'row-top';
  const label = document.createElement('span');
  label.className = 'row-label dim';
  label.textContent = p.label;
  const note = document.createElement('span');
  note.className = 'row-value note';
  note.textContent = p.errorNote || '연결 안 됨';
  top.append(label, note);
  div.append(top);
  const gauge = document.createElement('div');
  gauge.className = 'gauge';
  const fill = document.createElement('div');
  fill.className = 'gauge-fill';
  gauge.append(fill);
  div.append(gauge);
  return div;
}

function render(state) {
  lastState = state;
  const dark = isDark();
  const nodes = [];

  for (const p of state.providers || []) {
    const accent = p.accent || 'var(--text-sub)';
    const accentText = dark ? (p.accentTextDark || accent) : (p.accentText || accent);

    if (p.error) {
      nodes.push(renderProviderError(p));
      continue;
    }
    for (const line of p.lines || []) {
      if (line.type === 'progress') {
        nodes.push(renderProgress(line, accent, accentText, !PRIMARY_KEYS.has(line.key)));
      } else if (line.type === 'text') {
        nodes.push(renderText(line));
      } else if (line.type === 'badge') {
        nodes.push(renderBadge(line, accentText));
      } else if (line.type === 'barChart') {
        if (prefs.showChart) nodes.push(renderBarChart(line, accent, p.id));
      }
    }
  }

  rowsEl.replaceChildren(...nodes);
  footerEl.textContent = buildFooter(state);
  renderChip(state, dark);
}

function buildFooter(state) {
  const ps = (state.providers || []).filter((p) => !p.error);
  if (ps.length === 0) return '소스를 찾는 중...';
  if (ps.every((p) => p.realtime)) return '실시간 갱신';
  const parts = ps.map((p) => {
    if (p.realtime) return `${p.label} 실시간`;
    if (p.fileMtimeMs) return `${p.label} ${fmtAgo(p.fileMtimeMs)}`;
    return `${p.label}`;
  });
  return parts.join(' · ');
}

// 컴팩트 모드: 프로바이더별 대표 progress 라인만 표시
function renderChip(state, dark) {
  const items = [];
  let first = true;
  for (const p of state.providers || []) {
    if (p.error) continue;
    const line = (p.lines || []).find((l) => l.type === 'progress' && l.remainingPercent !== null);
    if (!line) continue;

    if (!first) {
      const sep = document.createElement('span');
      sep.className = 'chip-sep';
      items.push(sep);
    }
    first = false;

    const warn = isWarn(line.remainingPercent);
    const color = warn ? 'var(--warn)' : p.accent;
    const txtColor = warn ? 'var(--warn-text)' : (dark ? p.accentTextDark : p.accentText);

    const item = document.createElement('span');
    item.className = 'chip-item';
    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    dot.style.background = color;
    const text = document.createElement('span');
    text.textContent = line.label || p.label;
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.style.color = txtColor;
    pct.textContent = `${Math.round(line.remainingPercent)}%`;
    item.append(dot, text, pct);
    items.push(item);
  }
  if (items.length === 0) {
    const empty = document.createElement('span');
    empty.textContent = '데이터 없음';
    items.push(empty);
  }
  chipItemsEl.replaceChildren(...items);
}

function applyMode(mode) {
  const compact = mode === 'compact';
  cardEl.classList.toggle('hidden', compact);
  chipEl.classList.toggle('hidden', !compact);
}

document.getElementById('toggle-card').addEventListener('click', () => window.workieTokey.toggleMode());
document.getElementById('toggle-theme').addEventListener('click', () => window.workieTokey.toggleTheme());

const collapseTitleEl = document.getElementById('collapse-title');
collapseTitleEl.addEventListener('click', () => window.workieTokey.toggleMode());
collapseTitleEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    window.workieTokey.toggleMode();
  }
});

// 컴팩트 칩은 짧게 누르면 어디서든 확대되고, 일정 거리 이상 끌면
// 기존처럼 위치를 옮긴다.
let chipPointer = null;
chipEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  chipPointer = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
  chipEl.setPointerCapture(event.pointerId);
  window.workieTokey.startWindowDrag();
});
chipEl.addEventListener('pointermove', (event) => {
  if (!chipPointer || event.pointerId !== chipPointer.id) return;
  const dx = event.screenX - chipPointer.x;
  const dy = event.screenY - chipPointer.y;
  if (!chipPointer.moved && Math.hypot(dx, dy) < 4) return;
  chipPointer.moved = true;
  chipEl.classList.add('dragging');
  window.workieTokey.moveWindowDrag(dx, dy);
});
function finishChipPointer(event, expand) {
  if (!chipPointer || event.pointerId !== chipPointer.id) return;
  const moved = chipPointer.moved;
  chipPointer = null;
  chipEl.classList.remove('dragging');
  window.workieTokey.endWindowDrag();
  if (expand && !moved) window.workieTokey.toggleMode();
}
chipEl.addEventListener('pointerup', (event) => finishChipPointer(event, true));
chipEl.addEventListener('pointercancel', (event) => finishChipPointer(event, false));
chipEl.addEventListener('keydown', (event) => {
  if (event.target !== chipEl || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  window.workieTokey.toggleMode();
});
// 포커스된 화살표 버튼의 키보드 활성화는 유지하되 포인터 클릭은 위의
// 칩 전체 처리기가 한 번만 담당한다.
document.getElementById('toggle-chip').addEventListener('click', (event) => {
  if (event.detail === 0) window.workieTokey.toggleMode();
});

// ── 설정 패널 ───────────────────────────────────────────
const settingsEl = document.getElementById('settings');
const showChartRow = document.getElementById('set-show-chart');
const autostartRow = document.getElementById('set-autostart');

function applySwitch(row, on) {
  row.classList.toggle('on', !!on);
}

async function openSettings() {
  const s = await window.workieTokey.getSettings();
  applySwitch(showChartRow, s.showChart);
  applySwitch(autostartRow, s.autostart);
  cardEl.classList.add('settings-open');
  settingsEl.classList.remove('hidden');
  reportSize();
}

function closeSettings() {
  cardEl.classList.remove('settings-open');
  settingsEl.classList.add('hidden');
  reportSize();
}

document.getElementById('open-settings').addEventListener('click', () => {
  if (cardEl.classList.contains('settings-open')) closeSettings();
  else openSettings();
});

showChartRow.addEventListener('click', () => {
  const on = !showChartRow.classList.contains('on');
  applySwitch(showChartRow, on);
  window.workieTokey.setShowChart(on);
});
autostartRow.addEventListener('click', () => {
  const on = !autostartRow.classList.contains('on');
  applySwitch(autostartRow, on);
  window.workieTokey.setAutostart(on);
});
document.getElementById('set-refresh').addEventListener('click', () => {
  window.workieTokey.refreshNow();
  closeSettings();
});
document.getElementById('set-reset-pos').addEventListener('click', () => window.workieTokey.resetPosition());
document.getElementById('set-quit').addEventListener('click', () => window.workieTokey.quitApp());

function reportSize() {
  const el = chipEl.classList.contains('hidden') ? cardEl : chipEl;
  const r = el.getBoundingClientRect();
  // 내용이 넘칠 때(예: 칩에 소스가 늘어 토글 버튼이 잘리는 경우)를 대비해
  // 측정값과 scroll 크기 중 큰 값을 쓴다 → 창이 항상 내용 전체를 담는다
  const w = Math.max(r.width, el.scrollWidth);
  const h = Math.max(r.height, el.scrollHeight);
  if (w > 0 && h > 0) {
    window.workieTokey.reportSize(w + 4, h + 4);
  }
}

const ro = new ResizeObserver(() => reportSize());
ro.observe(cardEl);
ro.observe(chipEl);

window.workieTokey.onState(render);
window.workieTokey.onMode((mode) => {
  // 모드를 바꿀 때(특히 컴팩트 → 카드로 다시 확대할 때)는 항상 설정 화면을
  // 닫고 일반 카드부터 보여준다.
  closeSettings();
  applyMode(mode);
  reportSize();
});
window.workieTokey.onPrefs((p) => {
  prefs = p;
  if (lastState) render(lastState);
  reportSize();
});

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(reportSize);
}
window.addEventListener('load', reportSize);

setInterval(() => {
  if (lastState) render(lastState);
}, 60 * 1000);
