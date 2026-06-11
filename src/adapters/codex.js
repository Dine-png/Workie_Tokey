const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TAIL_BYTES = 256 * 1024;
const CACHE_MS = 60 * 1000;

let cache = { at: 0, key: null, data: null };

// 수동 지정 경로는 .codex 디렉터리를 가리켜야 한다 (auth.json / sessions 포함)
function resolveHome(customPath) {
  return customPath || DEFAULT_CODEX_HOME;
}

function detect(customPath) {
  const home = resolveHome(customPath);
  const exists = fs.existsSync(path.join(home, 'auth.json'))
    || fs.existsSync(path.join(home, 'sessions'));
  return { path: home, exists };
}

// ---------- 실시간: ChatGPT 백엔드 사용량 API ----------

function loadAuth(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
  } catch {
    return null;
  }
}

function normalizeApiWindow(w) {
  if (!w || typeof w.used_percent !== 'number') return null;
  let resetsAt = w.reset_at ?? w.resets_at ?? null;
  if (resetsAt === null && typeof w.reset_after_seconds === 'number') {
    resetsAt = Math.floor(Date.now() / 1000) + w.reset_after_seconds;
  }
  return {
    usedPercent: w.used_percent,
    windowMinutes: typeof w.limit_window_seconds === 'number'
      ? Math.round(w.limit_window_seconds / 60)
      : (w.window_minutes ?? null),
    resetsAt,
    inferredReset: false
  };
}

async function fetchUsageApi(home) {
  const auth = loadAuth(home);
  const token = auth && auth.tokens && auth.tokens.access_token;
  if (!token) return null;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'codex_cli_rs'
  };
  if (auth.tokens.account_id) headers['chatgpt-account-id'] = auth.tokens.account_id;

  const res = await fetch(USAGE_URL, { headers });
  if (!res.ok) return null;
  const j = await res.json();

  const rl = j.rate_limit || j.rate_limits || {};
  const primary = normalizeApiWindow(rl.primary_window || rl.primary);
  const secondary = normalizeApiWindow(rl.secondary_window || rl.secondary);
  if (!primary && !secondary) return null;

  return {
    source: 'codex',
    realtime: true,
    planType: j.plan_type ?? rl.plan_type ?? null,
    primary,
    secondary,
    snapshotAt: new Date().toISOString(),
    raw: process.env.WORKIE_DEBUG ? j : undefined
  };
}

// ---------- 폴백: 로컬 세션 로그의 마지막 스냅샷 ----------

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

function normalizeLogWindow(w) {
  if (!w || typeof w.used_percent !== 'number') return null;
  const resetsAt = w.resets_at ?? null;
  // 스냅샷의 리셋 시각이 지났고 그 후 사용 기록이 없으면 새 윈도우는 미사용
  const resetPassed = resetsAt !== null && resetsAt * 1000 < Date.now();
  return {
    usedPercent: resetPassed ? 0 : w.used_percent,
    windowMinutes: w.window_minutes ?? null,
    resetsAt: resetPassed ? null : resetsAt,
    inferredReset: resetPassed
  };
}

function readFromLogs(home) {
  const latest = findLatestSessionFile(path.join(home, 'sessions'));
  if (!latest) return null;

  const lines = readTail(latest.file, TAIL_BYTES).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = parsed.payload || {};
    const rl = payload.rate_limits || (payload.info && payload.info.rate_limits);
    if (!rl) continue;
    return {
      source: 'codex',
      realtime: false,
      planType: rl.plan_type ?? null,
      primary: normalizeLogWindow(rl.primary),
      secondary: normalizeLogWindow(rl.secondary),
      snapshotAt: parsed.timestamp ?? null,
      fileMtimeMs: latest.mtimeMs
    };
  }
  return null;
}

// ---------- 공개 인터페이스 ----------

async function read(customPath) {
  const home = resolveHome(customPath);
  if (cache.data && cache.key === home && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  let data = null;
  try {
    data = await fetchUsageApi(home);
  } catch {}
  if (!data) data = readFromLogs(home);

  cache = { at: Date.now(), key: home, data };
  return data;
}

module.exports = { read, detect };

if (require.main === module) {
  read().then((d) => console.log(JSON.stringify(d, null, 2)));
}
