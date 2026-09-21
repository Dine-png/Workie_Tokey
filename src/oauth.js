const crypto = require('crypto');
const http = require('http');

// ── OAuth PKCE 공통 유틸 ──────────────────────────────────────────
// 각 프로바이더의 login()이 쓰는 조각들: PKCE 쌍 생성, 브라우저 열기,
// localhost 리다이렉트 콜백을 받는 1회용 HTTP 서버.

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function randomState() {
  return base64url(crypto.randomBytes(24));
}

async function openBrowser(url) {
  try {
    const { shell } = require('electron');
    if (shell && shell.openExternal) {
      await shell.openExternal(url);
      return;
    }
  } catch {}
  const { exec } = require('child_process');
  if (process.platform === 'win32') exec(`start "" "${url.replace(/&/g, '^&')}"`);
  else if (process.platform === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

// 로그인 세션: localhost 콜백을 기다리되, 외부에서 submit(query)로 코드를
// 직접 넣어 줄 수도 있다(브라우저가 리다이렉트를 못 하거나 수동 붙여넣기).
// 반환: { listening: Promise<number|false>, promise, submit, cancel }
//   listening → 실제 열린 포트 번호(port: 0 이면 임의 포트) 또는 false.
//   promise → { query } 로 resolve, timeout/cancel 시 reject.
//   포트를 못 열어도(이미 사용 중) 세션은 살아 있어 수동 submit은 가능하다.
function loginSession({ port, pathname, timeoutMs = 5 * 60 * 1000, html }) {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  // 아무도 await 하지 않은 채 reject 되면 unhandled rejection이 되므로 미리 삼킨다
  promise.catch(() => {});

  let done = false;
  let timer = null;
  let server = null;
  function finish(err, query) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (server) {
      try { server.close(); } catch {}
    }
    if (err) rejectFn(err);
    else resolveFn({ query });
  }

  server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname !== pathname) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html || '<!doctype html><meta charset="utf-8"><title>Workie Tokey</title>' +
      '<body style="font-family:sans-serif;padding:40px;text-align:center">' +
      '<h2>로그인 완료</h2><p>이 창은 닫아도 됩니다. Workie Tokey로 돌아가세요.</p></body>');
    finish(null, Object.fromEntries(u.searchParams.entries()));
  });

  const listening = new Promise((resolve) => {
    server.once('error', () => {
      server = null;
      resolve(false);
    });
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });

  timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);

  return {
    listening,
    promise,
    submit: (query) => finish(null, query),
    cancel: () => finish(new Error('cancelled'))
  };
}

// JWT 페이로드 디코드 (서명 검증 없음 — 표시/계정 ID 추출 용도)
function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

module.exports = { pkce, randomState, openBrowser, loginSession, decodeJwt, base64url };
