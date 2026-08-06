const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('./lines');
const trend = require('./claude-trend');

// ── Claude Code 구독 사용량 프로바이더 ──────────────────────────────
// 실시간: GET api.anthropic.com/api/oauth/usage
// 토큰 만료 시 console.anthropic.com에서 refresh 후 파일에 write-back
// (리프레시 토큰 회전 대응)

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USER_AGENT = 'claude-code/2.1.109';
const TOKEN_ENDPOINTS = [
  'https://console.anthropic.com/v1/oauth/token',
  'https://claude.ai/v1/oauth/token'
];
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 60 * 1000;

const manifest = {
  id: 'claude',
  label: 'Claude',
  accent: '#D97757',
  accentText: '#C2410C',
  accentTextDark: '#E89B7D'
};

let cache = { at: 0, data: null };

function loadCredFile() {
  try {
    return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveCredFile(full) {
  fs.writeFileSync(CRED_PATH, JSON.stringify(full));
}

// 마지막 refresh 실패 사유. 'expired'면 리프레시 토큰 자체가 만료된 것이라
// 재로그인 말고는 방법이 없다 — 사용자에게 그대로 알려 준다.
let lastRefreshFailure = null;

async function refreshToken(oauth) {
  lastRefreshFailure = null;
  for (const url of TOKEN_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: oauth.refreshToken,
          client_id: CLIENT_ID
        })
      });
      if (!res.ok) {
        // invalid_grant = 리프레시 토큰 만료/폐기. 다른 엔드포인트도 마찬가지다.
        try {
          const err = await res.json();
          if (err && err.error === 'invalid_grant') lastRefreshFailure = 'expired';
        } catch {}
        continue;
      }
      const j = await res.json();
      if (!j.access_token) continue;
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token || oauth.refreshToken,
        expiresAt: Date.now() + (j.expires_in ? j.expires_in * 1000 : 3600 * 1000)
      };
    } catch {}
  }
  return null;
}

// 진행 중인 refresh를 하나로 합쳐(in-flight dedup) 동시에 두 번 갱신하지
// 않게 한다. Anthropic refresh token은 사용 시 회전(rotate)되므로, 폴링과
// HTTP API가 동시에 refresh하면 한쪽이 토큰을 회전시켜 다른 쪽이
// invalid_grant로 깨지고 순간적으로 '로그아웃'으로 보일 수 있다.
let refreshInFlight = null;

async function getAccessToken() {
  const full = loadCredFile();
  const oauth = full && full.claudeAiOauth;
  if (!oauth || !oauth.refreshToken) {
    lastRefreshFailure = null;
    return null;
  }

  if (oauth.accessToken && oauth.expiresAt && oauth.expiresAt > Date.now() + 60 * 1000) {
    return oauth.accessToken;
  }

  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const fresh = await refreshToken(oauth);
    if (!fresh) return null;
    full.claudeAiOauth = { ...oauth, ...fresh };
    try {
      saveCredFile(full);
    } catch (err) {
      console.error('[claude provider] credentials write-back failed:', err.message);
    }
    return fresh.accessToken;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function windowRemaining(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  return {
    remainingPercent: 100 - w.utilization,
    resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : null
  };
}

// 원시 usage 응답을 잡아 다른 모듈(추이/비용 뷰)이 재사용할 수 있게 보관
let lastRaw = null;
function getLastRaw() {
  return lastRaw;
}

async function fetchUsage() {
  const token = await getAccessToken();
  if (!token) return { error: lastRefreshFailure === 'expired' ? 'auth_expired' : 'auth' };
  const res = await fetch(USAGE_URL, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) return { error: `http_${res.status}` };
  return { json: await res.json() };
}

async function probe() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  let result;
  try {
    const { error, json } = await fetchUsage();
    if (error) {
      let errorNote = '연결 안 됨';
      if (error === 'auth') errorNote = '로그인 필요 (claude /login)';
      else if (error === 'auth_expired') errorNote = '로그인 만료 — claude /login';
      else if (error === 'http_401') errorNote = '인증 거부 — claude /login';
      result = base({ error, errorNote });
    } else {
      lastRaw = json;
      const lines = [];
      const five = windowRemaining(json.five_hour);
      const week = windowRemaining(json.seven_day);
      if (five) {
        lines.push(L.progress({
          key: '5h', label: 'Claude', note: '5h',
          remainingPercent: five.remainingPercent, resetsAt: five.resetsAt
        }));
      }
      if (week) {
        lines.push(L.progress({
          key: 'week', label: 'Claude 주간',
          remainingPercent: week.remainingPercent, resetsAt: week.resetsAt
        }));
      }
      // 모델별 주간 한도 — 실제로 소비가 있을 때만 노출(평소엔 숨겨 군더더기 방지)
      const opus = windowRemaining(json.seven_day_opus);
      if (opus && opus.remainingPercent < 100) {
        lines.push(L.progress({
          key: 'opus', label: 'Opus 주간',
          remainingPercent: opus.remainingPercent, resetsAt: opus.resetsAt
        }));
      }
      const sonnet = windowRemaining(json.seven_day_sonnet);
      if (sonnet && sonnet.remainingPercent < 100) {
        lines.push(L.progress({
          key: 'sonnet', label: 'Sonnet 주간',
          remainingPercent: sonnet.remainingPercent, resetsAt: sonnet.resetsAt
        }));
      }
      // 최근 7일 토큰 사용 추이 (로컬 로그 집계, 15분 캐시)
      try {
        const points = trend.compute();
        if (points) {
          lines.push(L.barChart({ key: 'trend', label: '최근 7일 사용량', points }));
        }
      } catch {}
      result = base({ realtime: true, lines });
    }
  } catch {
    result = base({ error: 'network', errorNote: '연결 안 됨' });
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
    lines: [],
    ...extra
  };
}

module.exports = { manifest, probe, getLastRaw };

if (require.main === module) {
  probe().then((d) => console.log(JSON.stringify(d, null, 2)));
}
