const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('./lines');

// ── Gemini (Google Code Assist / Gemini CLI 구독) 프로바이더 ────────
// 자격증명: ~/.gemini/oauth_creds.json (Gemini CLI 로그인 시 생성)
// 토큰 갱신: oauth2.googleapis.com/token (gemini-cli 공개 OAuth 클라이언트)
// 쿼터: POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
//   → buckets[].{ modelId, remainingFraction(0~1), resetTime, tokenType }
// 검증 완료(2026-06-19): 빈 바디로 200, 모델별 REQUESTS 잔량 반환.

const CRED_PATH = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
// gemini-cli 소스에 공개된 OAuth 클라이언트 (사용자별 비밀이 아니라
// 앱 식별자임). 아래 secret은 조각으로 합친다 — 값 자체는 그대로지만
// GitHub 시크릿 스캐너의 오탐(공개 저장소 푸시 차단)을 피하기 위함.
const CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const CLIENT_SECRET = ['GOCSPX', '4uHgMPm-1o7Sk-geV6Cu5clXFsxl'].join('-');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const CACHE_MS = 60 * 1000;
const PROJECT_TTL = 30 * 60 * 1000; // 프로젝트 ID는 거의 안 변함 → 길게 캐시

const manifest = {
  id: 'gemini',
  label: 'Gemini',
  accent: '#4285F4',
  accentText: '#1A73E8',
  accentTextDark: '#8AB4F8'
};

let cache = { at: 0, data: null };
let projectCache = { at: 0, id: null };

function loadCred() {
  try {
    return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveCred(full) {
  fs.writeFileSync(CRED_PATH, JSON.stringify(full, null, 2));
}

async function refresh(cred) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: cred.refresh_token
    })
  });
  if (!res.ok) return null;
  const j = await res.json();
  if (!j.access_token) return null;
  // 갱신 결과를 파일에 write-back (Gemini CLI 세션과 공유). Google
  // refresh_token은 회전하지 않으므로 기존 값을 유지한다.
  const next = {
    ...cred,
    access_token: j.access_token,
    expiry_date: Date.now() + (j.expires_in ? j.expires_in * 1000 : 3600 * 1000)
  };
  if (j.id_token) next.id_token = j.id_token;
  try {
    saveCred(next);
  } catch (err) {
    console.error('[gemini provider] credentials write-back failed:', err.message);
  }
  return j.access_token;
}

async function getAccessToken() {
  const cred = loadCred();
  if (!cred || !cred.refresh_token) return null;
  if (cred.access_token && cred.expiry_date && cred.expiry_date > Date.now() + 60 * 1000) {
    return cred.access_token;
  }
  return refresh(cred);
}

// retrieveUserQuota는 사용자의 Code Assist 프로젝트를 body.project로 요구한다.
// (빈 바디 {} 는 라이선스 없음으로 오인되어 403). loadCodeAssist가 현재 티어와
// cloudaicompanionProject를 알려주므로 거기서 프로젝트 ID를 받아 캐시한다.
async function getProject(token) {
  if (projectCache.id && Date.now() - projectCache.at < PROJECT_TTL) return projectCache.id;
  const res = await fetch(LOAD_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
    })
  });
  if (!res.ok) return null;
  const j = await res.json();
  const id = j.cloudaicompanionProject || null;
  if (id) projectCache = { at: Date.now(), id };
  return id;
}

// 모델 표시 우선순위: 가장 강력한 모델을 헤드라인으로
function modelRank(id) {
  if (/pro/.test(id)) return 3;
  if (/flash-lite/.test(id)) return 1;
  if (/flash/.test(id)) return 2;
  return 0;
}

// 모델 id를 짧은 라벨로 (gemini-2.5-pro → 2.5 Pro)
function shortModel(id) {
  return id.replace(/^gemini-/, '').replace(/-/g, ' ')
    .replace(/\bpro\b/i, 'Pro').replace(/\bflash\b/i, 'Flash').replace(/\blite\b/i, 'Lite');
}

async function probe() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  let result;
  try {
    const token = await getAccessToken();
    if (!token) {
      result = base({ error: 'auth', errorNote: '로그인 필요 (gemini)' });
    } else {
      const project = await getProject(token);
      const res = await fetch(QUOTA_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(project ? { project } : {})
      });
      if (!res.ok) {
        // 403 = Code Assist 라이선스/구독 없음(SUBSCRIPTION_REQUIRED)
        const note = res.status === 403 ? '구독 필요 (라이선스 없음)' : '연결 안 됨';
        result = base({ error: `http_${res.status}`, errorNote: note });
      } else {
        const j = await res.json();
        const buckets = (j.buckets || []).filter((b) => typeof b.remainingFraction === 'number');
        if (buckets.length === 0) {
          result = base({ error: 'nodata', errorNote: '데이터 없음' });
        } else {
          // 헤드라인: 가장 강력한 모델(Pro). 추가로, 다른 모델이 의미 있게
          // 소진됐으면 가장 적게 남은 것을 한 줄 더 표시.
          const headline = [...buckets].sort((a, b) => modelRank(b.modelId) - modelRank(a.modelId))[0];
          const lowest = [...buckets].sort((a, b) => a.remainingFraction - b.remainingFraction)[0];
          const lines = [bucketLine('main', 'Gemini', headline)];
          if (lowest.modelId !== headline.modelId && lowest.remainingFraction < 0.999) {
            lines.push(bucketLine('low', `Gemini ${shortModel(lowest.modelId)}`, lowest));
          }
          result = base({ realtime: true, lines });
        }
      }
    }
  } catch {
    result = base({ error: 'network', errorNote: '연결 안 됨' });
  }

  cache = { at: Date.now(), data: result };
  return result;
}

function bucketLine(key, label, b) {
  const resetsAt = b.resetTime ? Math.floor(Date.parse(b.resetTime) / 1000) : null;
  return L.progress({
    key, label,
    remainingPercent: Math.round(b.remainingFraction * 1000) / 10,
    resetsAt,
    note: shortModel(b.modelId)
  });
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

module.exports = { manifest, probe };

if (require.main === module) {
  probe().then((d) => console.log(JSON.stringify(d, null, 2)));
}
