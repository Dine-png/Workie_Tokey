# Workie Tokey

사용 중인 AI(Claude Code, Codex, Gemini)의 남은 토큰 잔량을 화면 위에 창 없는
오버레이로 보여주는 Windows 데스크톱 앱. 기획·디자인 상세는 [PLAN.md](PLAN.md) 참고.

## 실행 (개발)

```sh
npm install
npm start
```

## 빌드 (portable exe)

```sh
npm run dist
# → dist/WorkieTokey <버전>.exe  (단일 실행 파일, 설치 불필요)
```

> **Windows 빌드 주의:** electron-builder가 `winCodeSign` 캐시를 풀 때
> macOS용 심볼릭 링크(`*.dylib`) 생성에 실패하며 멈출 수 있다
> (관리자/개발자 모드 권한 없을 때). 그 경우 캐시를 darwin 제외하고 수동 추출:
>
> ```powershell
> $c = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
> & "node_modules\7zip-bin\win\x64\7za.exe" x -snld -bd -y "$c\<id>.7z" "-o$c\<id>" "-xr!darwin"
> ```
>
> 그 후 `npm run dist` 재실행.

## 조작

- **드래그**: 카드를 잡아 이동 (위치 자동 저장)
- 다시 실행하면 기존 워키토키를 종료하고 새 인스턴스로 교체하며, 마지막 위치에서 다시 열린다.
- **카드 우상단 버튼 2개**:
  - `◐` 라이트/다크 테마 전환 (저장됨, 기본은 OS 따라감)
  - `▾` 카드 ↔ 컴팩트 칩 모드 전환
- **트레이 아이콘**: 잔량 게이지로 실시간 변함(가장 적게 남은 윈도우 기준, 20% 이하면 레드),
  마우스를 올리면 "Claude N% · Codex N% 남음" 툴팁.
  클릭 = 창 숨김/복귀 (숨겼다 복귀하면 펼쳐진 카드 상태)
  클릭 통과 중에는 트레이 클릭으로 통과를 해제하고 카드를 복귀시킨다.
- **트레이 우클릭**: 메뉴(새로고침, 자동 시작, 위치 초기화, 종료)
- **에이전트 모드**: 화면 캡처에서만 제외하며 카드 클릭/드래그는 그대로 가능하다.
  별도 `클릭 통과`를 켜면 아래 창이 클릭된다. 해제하려면 트레이 아이콘을 클릭한다.
  이전 버전의 호버 기반 클릭 통과 설정은 업데이트 시 한 번 꺼진다.
- 잔량 20% 이하로 떨어지면 토스트 알림 (윈도우별 1회)

## 데이터 소스 (프로바이더)

프로바이더는 `src/providers/` 의 플러그인 구조다. `{ manifest, probe() }` 를
export 하는 모듈을 만들어 `src/providers/index.js` 배열에 넣으면 끝 — 메인/렌더러/
HTTP API 수정 없이 새 소스가 추가된다. `probe()` 는 정규화된 *라인*
(`progress`/`text`/`badge`/`barChart`, `src/providers/lines.js`)을 반환한다.

- **Claude**: `api.anthropic.com/api/oauth/usage` (Claude Code의 `/usage`와 동일).
  5시간·주간 + (소진 시) Opus/Sonnet 주간, 그리고 로컬 로그 기반 **최근 7일 토큰 추이 차트**.
- **Codex**: `chatgpt.com/backend-api/wham/usage` (실시간), 실패 시 세션 로그 폴백.
  서버가 알려 주는 실제 제한 기간을 읽어 현재 주간 한도 등으로 자동 표기한다.
- **Gemini**: `~/.gemini/oauth_creds.json`(Gemini CLI 로그인) → 토큰 갱신 후
  `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`. 모델별 요청 쿼터(`remainingFraction`).

표기는 **남은 %** 기준. 자격증명은 두 곳 중 먼저 찾는 것을 쓴다:

1. **워키토키 자체 로그인** — 카드의 `⚙ 설정 › 계정` 에서 프로바이더별 `로그인`.
   CLI가 하는 것과 같은 OAuth(PKCE) 흐름으로 브라우저에서 승인하면 끝이다.
   토큰은 `settings.json` 옆 `auth.json` 에 따로 저장되어 CLI 로그인을 건드리지 않는다.
   Claude는 localhost 리다이렉트가 막힌 경우 콘솔이 보여주는 `code#state` 를 붙여넣을 수 있다.
2. **CLI 로그인 공유** — Claude Code · Codex CLI · Gemini CLI 가 남긴 토큰 파일을 그대로 읽는다.

잔량 자체는 **계정 단위 쿼터**라 Claude Desktop, claude.ai, ChatGPT 데스크톱 등 어떤
클라이언트에서 쓴 분량이든 같은 숫자에 반영된다. CLI를 설치하지 않은 PC에서도 1번만으로 쓸 수 있다.

> Claude/Codex 로그인은 각 CLI의 공개 OAuth 클라이언트 ID를 쓴다. 제공사 정책이 바뀌면 막힐 수 있다.

## 사용량 추이 차트

- **최근 7일 사용량** — CLI 로컬 로그(`~/.claude/projects`, `~/.codex/sessions`)의 토큰 수 합산.
  CLI 세션만 잡힌다.
- 폴링한 usage API의 used% 변화량은 `history.json` 에 14일 보관하며 오버레이에는 표시하지 않고
  로컬 HTTP API의 `/history` 로만 제공한다.

## 로컬 HTTP API

켜져 있으면(`settings.json`의 `httpApi`가 `false`가 아니면) 현재 스냅샷을 노출한다.
외부 도구(상태바 위젯, 스크립트 등)가 읽을 수 있다.

```sh
curl http://127.0.0.1:6736/usage     # { ok, providers:[{id,label,realtime,windows:[{key,remainingPercent,usedPercent,resetsAt}]}] }
curl http://127.0.0.1:6736/history   # { ok, series:{ "<provider>/<window>": { latest, dailyUsedPercent:{ "YYYY-MM-DD": % } } } }
curl http://127.0.0.1:6736/healthz   # { ok: true }
```

루프백(127.0.0.1)에만 바인딩한다. 포트 충돌 시 6737~로 자동 폴백.
