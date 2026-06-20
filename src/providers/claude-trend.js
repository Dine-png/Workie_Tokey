const fs = require('fs');
const path = require('path');
const os = require('os');

// 최근 7일 Claude 토큰 사용 추이를 로컬 로그에서 집계한다.
// (~/.claude/projects/**/*.jsonl 의 assistant 이벤트 message.usage 합산)
// 상대적 막대차트용이므로 정확도보다 가벼움을 우선: 파일별 tail 상한 + 캐시.

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DAYS = 7;
const MAX_TAIL_BYTES = 2 * 1024 * 1024; // 파일당 최근 2MB만 스캔
const CACHE_MS = 15 * 60 * 1000;        // 15분 캐시 (오버레이 부하 방지)

let cache = { at: 0, points: null };

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function listRecentJsonl(dir, cutoffMs) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.mtimeMs >= cutoffMs) out.push(full);
      }
    }
  }
  return out;
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

function usageTokens(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.output_tokens || 0) +
    (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

// 최근 7일 [{ label:'월', value: tokens, valueLabel:'1.2M' }] 반환 (없으면 null)
function compute() {
  if (cache.points && Date.now() - cache.at < CACHE_MS) return cache.points;

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (DAYS - 1));
  cutoff.setHours(0, 0, 0, 0);

  const buckets = new Map(); // dayKey -> tokens
  let files;
  try {
    files = listRecentJsonl(PROJECTS_DIR, cutoff.getTime());
  } catch {
    return null;
  }
  if (!files || files.length === 0) {
    cache = { at: Date.now(), points: null };
    return null;
  }

  for (const file of files) {
    let text;
    try {
      text = readTail(file, MAX_TAIL_BYTES);
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"') || !line.includes('"timestamp"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = obj.timestamp;
      const usage = obj.message && obj.message.usage;
      if (!ts || !usage) continue;
      const d = new Date(ts);
      if (isNaN(d) || d < cutoff) continue;
      const k = dayKey(d);
      buckets.set(k, (buckets.get(k) || 0) + usageTokens(usage));
    }
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

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

module.exports = { compute, fmtTokens };
