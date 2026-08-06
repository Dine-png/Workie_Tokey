const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('./lines');
const trend = require('./codex-trend');

// ── Codex (ChatGPT 구독) 사용량 프로바이더 ─────────────────────────
// 실시간: GET chatgpt.com/backend-api/wham/usage
// 폴백: ~/.codex/sessions/**/*.jsonl 마지막 rate_limits 스냅샷

const CODEX_HOME = path.join(os.homedir(), '.codex');
const AUTH_PATH = path.join(CODEX_HOME, 'auth.json');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TAIL_BYTES = 256 * 1024;
const CACHE_MS = 60 * 1000;

const manifest = {
  id: 'codex',
  label: 'Codex',
  accent: '#1D9E75',
  accentText: '#0F6E56',
  accentTextDark: '#5DCAA5'
};

let cache = { at: 0, data: null };

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function windowSeconds(w) {
  if (!w) return null;
  if (typeof w.limit_window_seconds === 'number') return w.limit_window_seconds;
  if (typeof w.window_seconds === 'number') return w.window_seconds;
  if (typeof w.limit_window_minutes === 'number') return w.limit_window_minutes * 60;
  if (typeof w.window_minutes === 'number') return w.window_minutes * 60;
  return null;
}

function apiWindowRemaining(w) {
  if (!w || typeof w.used_percent !== 'number') return null;
  let resetsAt = w.reset_at ?? w.resets_at ?? null;
  if (resetsAt === null && typeof w.reset_after_seconds === 'number') {
    resetsAt = Math.floor(Date.now() / 1000) + w.reset_after_seconds;
  }
  return {
    remainingPercent: 100 - w.used_percent,
    resetsAt,
    inferredReset: false,
    windowSeconds: windowSeconds(w)
  };
}

async function fetchUsageApi() {
  const auth = loadAuth();
  const token = auth && auth.tokens && auth.tokens.access_token;
  if (!token) return null;

  const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'codex_cli_rs' };
  if (auth.tokens.account_id) headers['chatgpt-account-id'] = auth.tokens.account_id;

  const res = await fetch(USAGE_URL, { headers });
  if (!res.ok) return null;
  const j = await res.json();

  const rl = j.rate_limit || j.rate_limits || {};
  const primary = apiWindowRemaining(rl.primary_window || rl.primary);
  const secondary = apiWindowRemaining(rl.secondary_window || rl.secondary);
  if (!primary && !secondary) return null;
  return { realtime: true, planType: j.plan_type ?? rl.plan_type ?? null, primary, secondary };
}

// ── 폴백: 로컬 세션 로그 ──
function findLatestSessionFile(dir) {
  let latest = null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (!latest || stat.mtimeMs > latest.mtimeMs) {
          latest = { file: full, mtimeMs: stat.mtimeMs };
        }
      }
    }
  }
  return latest;
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function logWindowRemaining(w) {
  if (!w || typeof w.used_percent !== 'number') return null;
  const resetsAt = w.resets_at ?? null;
  const resetPassed = resetsAt !== null && resetsAt * 1000 < Date.now();
  return {
    remainingPercent: resetPassed ? 100 : 100 - w.used_percent,
    resetsAt: resetPassed ? null : resetsAt,
    inferredReset: resetPassed,
    windowSeconds: windowSeconds(w)
  };
}

function readFromLogs() {
  const latest = findLatestSessionFile(SESSIONS_DIR);
  if (!latest) return null;
  const lines = readTail(latest.file, TAIL_BYTES).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const payload = parsed.payload || {};
    const rl = payload.rate_limits || (payload.info && payload.info.rate_limits);
    if (!rl) continue;
    return {
      realtime: false,
      planType: rl.plan_type ?? null,
      primary: logWindowRemaining(rl.primary),
      secondary: logWindowRemaining(rl.secondary),
      fileMtimeMs: latest.mtimeMs
    };
  }
  return null;
}

function windowNote(w, prefix) {
  if (!w) return '';
  if (w.inferredReset) return prefix ? `${prefix} · 리셋됨` : '리셋됨';
  return prefix || '';
}

// API의 primary/secondary 이름은 기간을 뜻하지 않는다. 실제 기간 필드를
// 읽어 5시간, 주간 등 서버가 현재 제공하는 양식에 맞춰 표시한다.
function windowDisplay(w, fallback) {
  const seconds = w && w.windowSeconds;
  const hour = 60 * 60;
  const day = 24 * hour;

  if (Number.isFinite(seconds)) {
    if (seconds >= 6 * day && seconds <= 8 * day) {
      return { key: fallback === 'primary' ? 'main' : 'week', label: 'Codex 주간', note: '' };
    }
    if (seconds >= day && seconds % day === 0) {
      const days = Math.round(seconds / day);
      return { key: fallback === 'primary' ? 'main' : `${days}d`, label: `Codex ${days}일`, note: '' };
    }
    if (seconds >= hour && seconds % hour === 0) {
      const hours = Math.round(seconds / hour);
      return { key: `${hours}h`, label: 'Codex', note: `${hours}시간` };
    }
  }

  return fallback === 'secondary'
    ? { key: 'week', label: 'Codex 주간', note: '' }
    : { key: 'main', label: 'Codex', note: '' };
}

function progressLine(w, fallback) {
  const display = windowDisplay(w, fallback);
  return L.progress({
    key: display.key,
    label: display.label,
    remainingPercent: w.remainingPercent,
    resetsAt: w.resetsAt,
    note: windowNote(w, display.note)
  });
}

async function probe() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  let raw = null;
  try {
    raw = await fetchUsageApi();
  } catch {}
  if (!raw) raw = readFromLogs();

  let result;
  if (!raw) {
    result = base({ error: 'nodata', errorNote: '데이터 없음' });
  } else {
    const lines = [];
    if (raw.primary) {
      lines.push(progressLine(raw.primary, 'primary'));
    }
    if (raw.secondary) {
      lines.push(progressLine(raw.secondary, 'secondary'));
    }
    // 최근 7일 토큰 사용 추이 (로컬 세션 로그 집계, 15분 캐시)
    try {
      const points = trend.compute();
      if (points) {
        lines.push(L.barChart({ key: 'trend', label: '최근 7일 사용량', points }));
      }
    } catch {}
    result = base({ realtime: raw.realtime, fileMtimeMs: raw.fileMtimeMs ?? null, lines });
  }

  cache = { at: Date.now(), data: result };
  return result;
}

function base(extra) {
  return {
    id: manifest.id,
    label: manifest.label,
    accent: manifest.accent,
    accentText: manifest.accentText,
    accentTextDark: manifest.accentTextDark,
    realtime: false,
    error: null,
    errorNote: null,
    fileMtimeMs: null,
    lines: [],
    ...extra
  };
}

module.exports = { manifest, probe };

if (require.main === module) {
  probe().then((d) => console.log(JSON.stringify(d, null, 2)));
}
