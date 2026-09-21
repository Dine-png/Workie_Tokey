const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('./lines');
const trend = require('./claude-trend');
const authstore = require('../authstore');
const oauth = require('../oauth');

// ── Claude Code 구독 사용량 프로바이더 ──────────────────────────────
// 실시간: GET api.anthropic.com/api/oauth/usage
// 토큰 만료 시 console.anthropic.com에서 refresh 후 파일에 write-back
// (리프레시 토큰 회전 대응)
// 자격증명 소스: 워키토키 자체 로그인(auth.json) 우선, 없으면 Claude Code 파일.

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USER_AGENT = 'claude-code/2.1.109';
const TOKEN_ENDPOINTS = [
  'https://console.anthropic.com/v1/oauth/token',
  'https://claude.ai/v1/oauth/token'
];
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const SCOPES = 'org:create_api_key user:profile user:inference';
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = '/callback';
const MANUAL_REDIRECT = 'https://console.anthropic.com/oauth/code/callback';
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

// 자격증명 소스 선택: 워키토키 자체 로그인 → Claude Code CLI 파일 순.
function loadSource() {
  const own = authstore.get('claude');
  if (own && own.refreshToken) return { kind: 'app', oauth: own };
  const full = loadCredFile();
  const cliOauth = full && full.claudeAiOauth;
  if (cliOauth && cliOauth.refreshToken) return { kind: 'cli', oauth: cliOauth, full };
  return null;
}

function saveSource(src, fresh) {
  if (src.kind === 'app') {
    authstore.set('claude', { ...src.oauth, ...fresh });
  } else {
    src.full.claudeAiOauth = { ...src.oauth, ...fresh };
    saveCredFile(src.full);
  }
}

// 진행 중인 refresh를 하나로 합쳐(in-flight dedup) 동시에 두 번 갱신하지
// 않게 한다. Anthropic refresh token은 사용 시 회전(rotate)되므로, 폴링과
// HTTP API가 동시에 refresh하면 한쪽이 토큰을 회전시켜 다른 쪽이
// invalid_grant로 깨지고 순간적으로 '로그아웃'으로 보일 수 있다.
let refreshInFlight = null;

async function getAccessToken() {
  const src = loadSource();
  if (!src) {
    lastRefreshFailure = null;
    return null;
  }
  const o = src.oauth;
  if (o.accessToken && o.expiresAt && o.expiresAt > Date.now() + 60 * 1000) {
    return o.accessToken;
  }

  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const fresh = await refreshToken(o);
    if (!fresh) {
      // 자체 로그인 토큰이 완전히 만료됐으면 지워서 CLI 파일로 폴백하거나
      // 재로그인을 안내한다.
      if (src.kind === 'app' && lastRefreshFailure === 'expired') {
        try { authstore.remove('claude'); } catch {}
      }
      return null;
    }
    try {
      saveSource(src, fresh);
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

// ── 워키토키 자체 로그인 (Claude Code와 같은 PKCE 흐름) ────────────
// 브라우저에서 승인하면 localhost:54545/callback 으로 돌아온다. 포트를 못
// 열거나 리다이렉트가 막히면 콘솔이 보여주는 "code#state" 를 submitCode()로
// 붙여넣어도 된다.
let pending = null;

async function login() {
  cancelLogin();
  const { verifier, challenge } = oauth.pkce();
  const session = oauth.loginSession({ port: CALLBACK_PORT, pathname: CALLBACK_PATH });
  const listening = await session.listening;
  const redirectUri = listening ? `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}` : MANUAL_REDIRECT;
  const url = `${AUTHORIZE_URL}?` + new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier
  }).toString();

  pending = { session, verifier, redirectUri };
  await oauth.openBrowser(url);

  const done = session.promise
    .then(async ({ query }) => {
      await exchange(query, verifier, redirectUri);
      return { ok: true };
    })
    .catch((err) => ({ ok: false, error: err.message }))
    .finally(() => { if (pending && pending.session === session) pending = null; });
  return { ok: true, manual: !listening, url, done };
}

// 수동 붙여넣기: "code#state" 또는 code 만
function submitCode(text) {
  if (!pending) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  const [code, state] = t.split('#');
  pending.session.submit({ code, state: state || pending.verifier });
  return true;
}

function cancelLogin() {
  if (pending) {
    pending.session.cancel();
    pending = null;
  }
}

async function exchange(query, verifier, redirectUri) {
  if (!query || !query.code) throw new Error('no_code');
  let lastErr = 'exchange_failed';
  for (const url of TOKEN_ENDPOINTS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: query.code,
        state: query.state || verifier,
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        code_verifier: verifier
      })
    });
    if (!res.ok) {
      lastErr = `http_${res.status}`;
      continue;
    }
    const j = await res.json();
    if (!j.access_token || !j.refresh_token) {
      lastErr = 'bad_response';
      continue;
    }
    authstore.set('claude', {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: Date.now() + (j.expires_in ? j.expires_in * 1000 : 3600 * 1000),
      scopes: typeof j.scope === 'string' ? j.scope.split(' ') : SCOPES.split(' '),
      loggedInAt: Date.now()
    });
    lastRefreshFailure = null;
    cache = { at: 0, data: null };
    return;
  }
  throw new Error(lastErr);
}

function logout() {
  authstore.remove('claude');
  cache = { at: 0, data: null };
}

// 설정 패널 표시용: 어떤 소스로 로그인돼 있는지
function authStatus() {
  const src = loadSource();
  return { source: src ? src.kind : null, pending: !!pending, manual: !!(pending && pending.redirectUri === MANUAL_REDIRECT) };
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
      if (error === 'auth') errorNote = '로그인 필요 — ⚙ 설정';
      else if (error === 'auth_expired') errorNote = '로그인 만료 — ⚙ 설정';
      else if (error === 'http_401') errorNote = '인증 거부 — ⚙ 설정';
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

module.exports = { manifest, probe, getLastRaw, login, submitCode, cancelLogin, logout, authStatus };

if (require.main === module) {
  probe().then((d) => console.log(JSON.stringify(d, null, 2)));
}
