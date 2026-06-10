# Workie Tokey

A borderless Windows desktop overlay that shows remaining token usage for AI tools (Claude Code, Codex) in real time.

사용 중인 AI(Claude Code, Codex)의 남은 토큰 잔량을 화면 위에 창 없는 오버레이로 보여주는 Windows 데스크톱 앱.

---

## Download

Get the latest installer from the [Releases](../../releases) page.

---

## Usage / 조작

- **Drag**: Move the card anywhere on screen (position is saved)
- **드래그**: 카드를 잡아 이동 (위치 자동 저장)

- **`◐`** — Toggle light/dark theme (saved, defaults to OS setting)
- **`◐`** — 라이트/다크 테마 전환 (저장됨, 기본은 OS 따라감)

- **`▾`** — Toggle between card and compact chip mode
- **`▾`** — 카드 ↔ 컴팩트 칩 모드 전환

- **Tray icon**: Shows real-time gauge (red when below 20%). Hover for tooltip: "Claude N% · Codex N% left". Click to hide/show window.
- **트레이 아이콘**: 잔량 게이지로 실시간 변함 (20% 이하면 레드). 마우스를 올리면 툴팁. 클릭 = 창 숨김/복귀

- **Tray right-click**: Menu (Refresh, Auto-start, Reset position, Quit)
- **트레이 우클릭**: 메뉴 (새로고침, 자동 시작, 위치 초기화, 종료)

- Toast notification when usage drops below 20% (once per window)
- 잔량 20% 이하로 떨어지면 토스트 알림 (윈도우별 1회)

---

## Data Sources / 데이터 소스

- **Claude**: `api.anthropic.com/api/oauth/usage` — same endpoint as Claude Code's `/usage`
- **Codex**: `chatgpt.com/backend-api/wham/usage` (live), falls back to session log

Both use locally stored login tokens — no separate login required.
All values are displayed as **remaining %**.

둘 다 로컬에 저장된 기존 로그인 토큰을 읽어 쓴다. 별도 로그인 불필요. 표기는 모두 **남은 %** 기준.

---

## Development / 개발 실행

```sh
npm install
npm start
```

## Build / 빌드

```sh
npm run dist
# → dist/WorkieTokey <version>.exe
```

> **Windows build note:** electron-builder may hang when extracting `winCodeSign` cache due to macOS symlinks (`*.dylib`). If this happens, extract manually excluding darwin:
>
> ```powershell
> $c = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
> & "node_modules\7zip-bin\win\x64\7za.exe" x -snld -bd -y "$c\<id>.7z" "-o$c\<id>" "-xr!darwin"
> ```
> Then re-run `npm run dist`.
