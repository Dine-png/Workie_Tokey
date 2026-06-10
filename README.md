# Workie Tokey

> A borderless Windows desktop overlay showing real-time token usage for Claude Code and Codex.
>
> 사용 중인 AI(Claude Code, Codex)의 남은 토큰 잔량을 화면 위에 창 없는 오버레이로 보여주는 Windows 데스크톱 앱.

---

## Download

**[→ Latest Release](../../releases/latest)**

---

## Features / 기능

| | English | 한국어 |
|---|---|---|
| 🖱️ | Drag to move, position saved | 드래그로 이동, 위치 자동 저장 |
| ◐ | Light / Dark theme toggle | 라이트/다크 테마 전환 |
| ▾ | Card ↔ Compact chip mode | 카드 ↔ 컴팩트 칩 모드 |
| 🔔 | Toast alert when below 20% (once per session) | 잔량 20% 이하 토스트 알림 (1회) |

---

## Tray Icon / 트레이 아이콘

| Action | English | 한국어 |
|---|---|---|
| Hover | "Claude N% · Codex N% left" tooltip | 잔량 툴팁 표시 |
| Left click | Hide / Show window | 창 숨김 / 복귀 |
| Right click | Refresh · Auto-start · Reset position · Quit | 새로고침 · 자동시작 · 위치초기화 · 종료 |

Tray icon turns **red** when any token drops below 20%.
잔량이 20% 이하면 트레이 아이콘이 **빨간색**으로 변합니다.

---

## Data Sources / 데이터 소스

| AI | Endpoint |
|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` |
| Codex | `chatgpt.com/backend-api/wham/usage` (falls back to session log) |

Uses locally stored login tokens — **no separate login required.**
로컬에 저장된 기존 로그인 토큰 사용 — **별도 로그인 불필요.**

---

## Development / 개발

```sh
npm install
npm start
```

## Build / 빌드

```sh
npm run dist
# → dist/WorkieTokey <version>.exe
```

<details>
<summary>Windows build troubleshooting</summary>

electron-builder may hang when extracting `winCodeSign` cache due to macOS symlinks. Extract manually excluding darwin:

```powershell
$c = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
& "node_modules\7zip-bin\win\x64\7za.exe" x -snld -bd -y "$c\<id>.7z" "-o$c\<id>" "-xr!darwin"
```

Then re-run `npm run dist`.

</details>
