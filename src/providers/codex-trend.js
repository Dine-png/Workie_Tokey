const fs = require('fs');
const path = require('path');
const os = require('os');

// 최근 7일 Codex 토큰 사용 추이를 로컬 세션 로그에서 집계한다.
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 의 token_count 이벤트
//   payload.info.last_token_usage.total_tokens (턴별 증분) 을 일자별 합산.
// 세션이 날짜 폴더로 나뉘어 있어 최근 며칠 폴더만 스캔하면 된다.

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const DAYS = 7;
const SCAN_DAYS = DAYS + 1;          // 타임존 보정 위해 하루 더 스캔
const MAX_BYTES = 4 * 1024 * 1024;   // 파일당 상한
const CACHE_MS = 15 * 60 * 1000;

let cache = { at: 0, points: null };

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// UTC 날짜 폴더 경로 (sessions/YYYY/MM/DD)
function dateDir(d) {
  return path.join(
    SESSIONS_DIR,
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0')
  );
}

function listJsonl(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(dir, e.name));
}

function readCapped(file, bytes) {
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

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

// 최근 7일 [{ label, value, valueLabel }] 반환 (없으면 null)
function compute() {
  if (cache.points && Date.now() - cache.at < CACHE_MS) return cache.points;

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (DAYS - 1));
  cutoff.setHours(0, 0, 0, 0);

  // 스캔할 UTC 날짜 폴더 목록
  const dirs = [];
  for (let i = 0; i < SCAN_DAYS + 1; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dirs.push(dateDir(d));
  }

  const buckets = new Map();
  let any = false;
  for (const dir of dirs) {
    for (const file of listJsonl(dir)) {
      let text;
      try {
        text = readCapped(file, MAX_BYTES);
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes('"token_count"') || !line.includes('last_token_usage')) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = obj.timestamp;
        const last = obj.payload && obj.payload.info && obj.payload.info.last_token_usage;
        if (!ts || !last || typeof last.total_tokens !== 'number') continue;
        const d = new Date(ts);
        if (isNaN(d) || d < cutoff) continue;
        any = true;
        const k = dayKey(d);
        buckets.set(k, (buckets.get(k) || 0) + last.total_tokens);
      }
    }
  }

  if (!any) {
    cache = { at: Date.now(), points: null };
    return null;
  }

  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const points = [];
  let total = 0;
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(cutoff);
    d.setDate(cutoff.getDate() + i);
    const v = buckets.get(dayKey(d)) || 0;
    total += v;
    points.push({ label: days[d.getDay()], value: v, valueLabel: fmtTokens(v) });
  }

  const result = total > 0 ? points : null;
  cache = { at: Date.now(), points: result };
  return result;
}

module.exports = { compute, fmtTokens };
