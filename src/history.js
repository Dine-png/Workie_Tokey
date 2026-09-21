const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 폴링 기반 한도 소비 기록 ─────────────────────────────────────
// 프로바이더의 usage API는 계정 단위 쿼터를 돌려주므로, 어떤 클라이언트
// (CLI, Claude Desktop, ChatGPT 데스크톱, 웹 등)에서 썼든 used%에 반영된다.
// 로컬 CLI 로그가 없는 데스크톱 앱 사용분까지 추이로 남기기 위해, 매 폴링마다
// 프로바이더별 대표 윈도우의 used%를 시계열로 저장하고 증분을 일자별로 합산한다.
//
// 저장: <userData>/history.json
//   { version: 1, series: { "<providerId>/<windowKey>": [[t, used, resetsAt], ...] } }
// 샘플은 값이나 리셋 시각이 바뀔 때만 추가하고, 14일 지난 것은 잘라낸다.

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const DAYS = 7;
const VERSION = 1;

let filePath = null;
let data = null;
let dirty = false;
let saveTimer = null;

function defaultPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'history.json');
  } catch {}
  return path.join(os.homedir(), '.workie-tokey', 'history.json');
}

function load() {
  if (data) return data;
  filePath = filePath || defaultPath();
  try {
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (j && j.version === VERSION && j.series && typeof j.series === 'object') {
      data = j;
      return data;
    }
  } catch {}
  data = { version: VERSION, series: {} };
  return data;
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 2000);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty || !data) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  } catch (err) {
    console.error('[history] save failed:', err.message);
  }
}

function prune(samples, now) {
  const cutoff = now - KEEP_MS;
  let i = 0;
  while (i < samples.length && samples[i][0] < cutoff) i++;
  // 잘라낸 직전 샘플 하나는 남겨 두어 첫 증분 계산의 기준점이 되게 한다
  if (i > 1) samples.splice(0, i - 1);
}

// 프로바이더별 "대표" progress 라인 — 가장 자주 리셋되는 짧은 윈도우가
// 증분 추적에 가장 정확하므로 첫 번째 progress 라인을 쓴다.
function primaryLine(provider) {
  return (provider.lines || []).find((l) => l.type === 'progress' && l.remainingPercent !== null) || null;
}

function seriesKey(provider, line) {
  return `${provider.id}/${line.key}`;
}

// 수집 결과(state)를 한 번 기록한다. main.js의 tick에서 호출.
function record(state) {
  const d = load();
  const now = Date.now();
  for (const p of state.providers || []) {
    if (p.error) continue;
    const line = primaryLine(p);
    if (!line) continue;
    const used = Math.round((100 - line.remainingPercent) * 10) / 10;
    const resetsAt = line.resetsAt || null;
    const key = seriesKey(p, line);
    const samples = d.series[key] || (d.series[key] = []);
    const last = samples[samples.length - 1];
    if (last && last[1] === used && (last[2] || null) === resetsAt) continue;
    samples.push([now, used, resetsAt]);
    prune(samples, now);
    scheduleSave();
  }
}

function dayKey(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// 샘플 시계열 → 일자별 소비 %(한도 대비). 증분이 음수면 윈도우가 리셋된 것으로
// 보고 현재 used 전체를 새 윈도우의 소비로 친다(리셋 후 0에서 시작했다고 가정).
function dailyConsumption(samples, cutoffMs) {
  const buckets = new Map();
  for (let i = 1; i < samples.length; i++) {
    const [t, used, resetsAt] = samples[i];
    const [, prevUsed, prevReset] = samples[i - 1];
    if (t < cutoffMs) continue;
    let delta = used - prevUsed;
    const reset = (resetsAt && prevReset && resetsAt !== prevReset) || delta < 0;
    if (reset) delta = used;
    if (delta <= 0) continue;
    const k = dayKey(new Date(t));
    buckets.set(k, (buckets.get(k) || 0) + delta);
  }
  return buckets;
}

// 프로바이더의 최근 7일 소비 추이 → barChart points (데이터 없으면 null)
function trendPoints(provider) {
  const d = load();
  const line = primaryLine(provider);
  if (!line) return null;
  const samples = d.series[seriesKey(provider, line)];
  if (!samples || samples.length < 2) return null;

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (DAYS - 1));
  cutoff.setHours(0, 0, 0, 0);

  const buckets = dailyConsumption(samples, cutoff.getTime());
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const points = [];
  let total = 0;
  for (let i = 0; i < DAYS; i++) {
    const dt = new Date(cutoff);
    dt.setDate(cutoff.getDate() + i);
    const v = Math.round(buckets.get(dayKey(dt)) || 0);
    total += v;
    points.push({ label: days[dt.getDay()], value: v, valueLabel: `${v}%` });
  }
  return total > 0 ? { points, windowLabel: line.note || line.label } : null;
}

// HTTP API용: 모든 시리즈의 일자별 소비 요약
function summary() {
  const d = load();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (DAYS - 1));
  cutoff.setHours(0, 0, 0, 0);
  const out = {};
  for (const [key, samples] of Object.entries(d.series)) {
    const buckets = dailyConsumption(samples, cutoff.getTime());
    out[key] = {
      samples: samples.length,
      latest: samples.length ? { at: samples[samples.length - 1][0], usedPercent: samples[samples.length - 1][1] } : null,
      dailyUsedPercent: Object.fromEntries([...buckets.entries()].sort())
    };
  }
  return out;
}

module.exports = { record, trendPoints, summary, flush, load };
