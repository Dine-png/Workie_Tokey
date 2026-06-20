// 프로바이더 레지스트리.
// 새 소스를 추가하려면 이 디렉터리에 { manifest, probe } 를 export 하는
// 모듈을 만들고 아래 배열에 넣기만 하면 된다. main.js·렌더러·HTTP API는
// 종류에 무관하게 동작하므로 코어 수정이 필요 없다 (openusage 플러그인 모델).

const claude = require('./claude');
const codex = require('./codex');
const gemini = require('./gemini');

const providers = [claude, codex, gemini];

// 모든 프로바이더의 probe()를 병렬 실행하고 정규화된 결과 배열을 반환.
// 하나가 던져도 전체가 멈추지 않도록 개별적으로 감싼다.
async function collectAll() {
  const results = await Promise.all(providers.map(async (p) => {
    try {
      return await p.probe();
    } catch (err) {
      console.error(`[provider:${p.manifest.id}]`, err.message);
      return {
        id: p.manifest.id,
        label: p.manifest.label,
        accent: p.manifest.accent,
        accentText: p.manifest.accentText,
        accentTextDark: p.manifest.accentTextDark,
        realtime: false,
        error: 'exception',
        errorNote: '연결 안 됨',
        lines: []
      };
    }
  }));
  return { collectedAt: Date.now(), providers: results };
}

function list() {
  return providers.map((p) => p.manifest);
}

module.exports = { collectAll, list, providers };
