const http = require('http');

// 로컬 HTTP API — 외부 도구(상태바 위젯, 스크립트, Raycast 등)가 현재
// 사용량 스냅샷을 읽어갈 수 있게 한다. openusage의 127.0.0.1:6736 개념 차용.
// 보안상 루프백(127.0.0.1)에만 바인딩한다.

const HOST = '127.0.0.1';
const DEFAULT_PORT = 6736;

// 내부 state(프로바이더 객체 배열)를 외부 공개용 평탄 스키마로 변환.
function toPublic(state) {
  if (!state) return { ok: false, providers: [] };
  return {
    ok: true,
    collectedAt: state.collectedAt,
    generatedAt: Date.now(),
    providers: (state.providers || []).map((p) => ({
      id: p.id,
      label: p.label,
      realtime: !!p.realtime,
      error: p.error || null,
      windows: (p.lines || [])
        .filter((l) => l.type === 'progress' && l.remainingPercent !== null)
        .map((l) => ({
          key: l.key,
          label: l.label,
          remainingPercent: Math.round(l.remainingPercent * 10) / 10,
          usedPercent: Math.round((100 - l.remainingPercent) * 10) / 10,
          resetsAt: l.resetsAt || null
        }))
    }))
  };
}

// getSnapshot: () => 최신 내부 state
// 반환: { server, port } (start됨). 포트 충돌 시 다음 포트로 폴백.
function start(getSnapshot, port = DEFAULT_PORT) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = (req.url || '').split('?')[0];

    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === '/usage' || url === '/' ) {
      const body = JSON.stringify(toPublic(getSnapshot()), null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < DEFAULT_PORT + 5) {
      console.warn(`[httpapi] port ${port} in use, trying ${port + 1}`);
      setTimeout(() => start(getSnapshot, port + 1), 100);
    } else {
      console.error('[httpapi]', err.message);
    }
  });

  server.listen(port, HOST, () => {
    console.log(`[httpapi] listening on http://${HOST}:${port}/usage`);
  });

  return server;
}

module.exports = { start, toPublic, DEFAULT_PORT };
