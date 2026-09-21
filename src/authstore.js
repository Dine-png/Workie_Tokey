const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 워키토키 자체 로그인 토큰 저장소 ──────────────────────────────
// <userData>/auth.json  { claude: {...}, codex: {...}, gemini: {...} }
// CLI(Claude Code, Codex, Gemini CLI)의 자격증명 파일과는 별개다. 프로바이더는
// 이 파일을 먼저 보고, 없으면 CLI 파일로 폴백한다. 그래서 CLI를 설치하지 않은
// PC에서도 워키토키만으로 로그인해 쓸 수 있고, CLI 로그인을 덮어쓰지도 않는다.

let filePath = null;

function resolvePath() {
  if (filePath) return filePath;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      filePath = path.join(app.getPath('userData'), 'auth.json');
      return filePath;
    }
  } catch {}
  filePath = path.join(os.homedir(), '.workie-tokey', 'auth.json');
  return filePath;
}

function loadAll() {
  try {
    const j = JSON.parse(fs.readFileSync(resolvePath(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function get(id) {
  return loadAll()[id] || null;
}

function set(id, value) {
  const all = loadAll();
  if (value) all[id] = value;
  else delete all[id];
  const p = resolvePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(all, null, 2), { mode: 0o600 });
}

function remove(id) {
  set(id, null);
}

module.exports = { get, set, remove, loadAll, resolvePath };
