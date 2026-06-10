const rowsEl = document.getElementById('rows');
const footerEl = document.getElementById('footer');
const cardEl = document.getElementById('card');
const chipEl = document.getElementById('chip');
const chipItemsEl = document.getElementById('chip-items');

let lastState = null;

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

function windowNote(w, prefix) {
  if (w.inferredReset) return prefix ? `${prefix} · 리셋됨` : '리셋됨';
  const reset = fmtReset(w.resetsAt);
  return prefix ? `${prefix} · ${reset}` : reset;
}

// 표시할 줄 목록으로 변환 — percent는 "남은 %" 기준
function buildRows(state) {
  const rows = [];

  const cl = state && state.claude;
  if (cl && cl.primary) {
    rows.push({
      id: 'claude',
      label: 'Claude',
      percent: 100 - cl.primary.usedPercent,
      note: windowNote(cl.primary, '5h')
    });
  }
  if (cl && cl.secondary) {
    rows.push({
      id: 'claude',
      label: 'Claude 주간',
      percent: 100 - cl.secondary.usedPercent,
      note: windowNote(cl.secondary, '')
    });
  }
  if (!cl || cl.error) {
    rows.push({
      id: 'claude',
      label: 'Claude',
      dim: true,
      percent: null,
      note: cl && cl.error === 'auth' ? '로그인 필요 (claude /login)' : '연결 안 됨'
    });
  }

  const cx = state && state.codex;
  if (cx && cx.primary) {
    rows.push({
      id: 'codex',
      label: 'Codex',
      percent: 100 - cx.primary.usedPercent,
      note: windowNote(cx.primary, '5h')
    });
  }
  if (cx && cx.secondary) {
    rows.push({
      id: 'codex',
      label: 'Codex 주간',
      percent: 100 - cx.secondary.usedPercent,
      note: windowNote(cx.secondary, '')
    });
  }
  if (!cx) {
    rows.push({
      id: 'codex',
      label: 'Codex',
      dim: true,
      percent: null,
      note: '데이터 없음'
    });
  }
  return rows;
}

function colorClass(row) {
  if (row.percent !== null && row.percent <= 20) return 'warn';
  return row.id;
}

function render(state) {
  lastState = state;
  const rows = buildRows(state);

  rowsEl.replaceChildren(...rows.map((row) => {
    const div = document.createElement('div');
    div.className = 'row';

    const top = document.createElement('div');
    top.className = 'row-top';

    const label = document.createElement('span');
    label.className = 'row-label' + (row.dim ? ' dim' : '');
    label.textContent = row.label;

    const value = document.createElement('span');
    value.className = 'row-value';
    if (row.percent !== null) {
      const pct = document.createElement('span');
      pct.className = `pct ${colorClass(row)}`;
      pct.textContent = `${Math.round(row.percent)}% 남음`;
      value.append(pct);
    }
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = (row.percent !== null ? ' · ' : '') + row.note;
    value.append(note);

    top.append(label, value);
    div.append(top);

    const gauge = document.createElement('div');
    gauge.className = 'gauge';
    const fill = document.createElement('div');
    fill.className = `gauge-fill ${colorClass(row)}`;
    fill.style.width = `${Math.min(100, Math.max(0, row.percent ?? 0))}%`;
    gauge.append(fill);
    div.append(gauge);

    return div;
  }));

  const cx = state && state.codex;
  const cl = state && state.claude;
  const claudeLive = cl && !cl.error;
  const codexLive = cx && cx.realtime;
  let footer;
  if (claudeLive && codexLive) {
    footer = '실시간 갱신';
  } else {
    const parts = [];
    if (claudeLive) parts.push('Claude 실시간');
    if (cx) parts.push(codexLive ? 'Codex 실시간' : `Codex ${fmtAgo(cx.fileMtimeMs)}`);
    footer = parts.length > 0 ? parts.join(' · ') : '소스를 찾는 중...';
  }
  footerEl.textContent = footer;

  renderChip(rows);
}

// 컴팩트 모드에는 5시간 윈도우만 표시
function renderChip(rows) {
  const visible = rows.filter((r) => r.percent !== null && !r.label.includes('주간'));
  const items = [];
  visible.forEach((row, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'chip-sep';
      items.push(sep);
    }
    const item = document.createElement('span');
    item.className = 'chip-item';
    const dot = document.createElement('span');
    dot.className = `chip-dot ${colorClass(row)}`;
    const text = document.createElement('span');
    text.textContent = row.label;
    const pct = document.createElement('span');
    pct.className = `pct ${colorClass(row)}`;
    pct.textContent = `${Math.round(row.percent)}%`;
    item.append(dot, text, pct);
    items.push(item);
  });
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
document.getElementById('toggle-chip').addEventListener('click', () => window.workieTokey.toggleMode());
document.getElementById('toggle-theme').addEventListener('click', () => window.workieTokey.toggleTheme());

// 보이는 요소(카드/칩)의 실제 크기를 메인에 보고 → 창이 내용에 딱 맞게 줄어듦
function reportSize() {
  const el = chipEl.classList.contains('hidden') ? cardEl : chipEl;
  const r = el.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) {
    // 요소의 2px 바깥 여백까지 포함
    window.workieTokey.reportSize(r.width + 4, r.height + 4);
  }
}

const ro = new ResizeObserver(() => reportSize());
ro.observe(cardEl);
ro.observe(chipEl);

window.workieTokey.onState(render);
window.workieTokey.onMode((mode) => {
  applyMode(mode);
  reportSize();
});

// 폰트 로드 후 reflow까지 잡기 위해 한 번 더
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(reportSize);
}
window.addEventListener('load', reportSize);

setInterval(() => {
  if (lastState) render(lastState);
}, 60 * 1000);
