const fs = require('fs');
const path = require('path');
const os = require('os');

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
// Claude Code의 공개 OAuth client_id
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USER_AGENT = 'claude-code/2.1.109';
const TOKEN_ENDPOINTS = [
  'https://console.anthropic.com/v1/oauth/token',
  'https://claude.ai/v1/oauth/token'
];
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 60 * 1000;

let cache = { at: 0, data: null };

function loadCredFile() {
  try {
    return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// 리프레시 토큰은 사용 시마다 회전되므로, 갱신 결과를 반드시 파일에 되써서
// Claude Code CLI의 로그인 세션이 깨지지 않게 유지한다
function saveCredFile(full) {
  fs.writeFileSync(CRED_PATH, JSON.stringify(full));
}

async function refreshToken(oauth) {
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
      if (!res.ok) continue;
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

async function getAccessToken() {
  const full = loadCredFile();
  const oauth = full && full.claudeAiOauth;
  if (!oauth || !oauth.refreshToken) return null;

  if (oauth.accessToken && oauth.expiresAt && oauth.expiresAt > Date.now() + 60 * 1000) {
    return oauth.accessToken;
  }

  const fresh = await refreshToken(oauth);
  if (!fresh) return null;

  full.claudeAiOauth = { ...oauth, ...fresh };
  try {
    saveCredFile(full);
  } catch (err) {
    console.error('[claude adapter] credentials write-back failed:', err.message);
  }
  return fresh.accessToken;
}

function normalizeWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  return {
    usedPercent: w.utilization,
    resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : null,
    inferredReset: false
  };
}

async function read() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  let data;
  const token = await getAccessToken();
  if (!token) {
    data = { source: 'claude', error: 'auth' };
  } else {
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        }
      });
      if (!res.ok) {
        data = { source: 'claude', error: `http_${res.status}` };
      } else {
        const j = await res.json();
        data = {
          source: 'claude',
          primary: normalizeWindow(j.five_hour),
          secondary: normalizeWindow(j.seven_day),
          opusWeekly: normalizeWindow(j.seven_day_opus),
          sonnetWeekly: normalizeWindow(j.seven_day_sonnet),
          snapshotAt: new Date().toISOString()
        };
      }
    } catch (err) {
      data = { source: 'claude', error: 'network' };
    }
  }

  cache = { at: Date.now(), data };
  return data;
}

module.exports = { read };

if (require.main === module) {
  read().then((d) => console.log(JSON.stringify(d, null, 2)));
}
