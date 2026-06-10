# Workie Tokey

사용 중인 AI(Claude Code, Codex)의 남은 토큰 잔량을 화면 위에 창 없는 오버레이로
보여주는 Windows 데스크톱 앱. 기획·디자인 상세는 [PLAN.md](PLAN.md) 참고.

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
- **카드 우상단 버튼 2개**:
  - `◐` 라이트/다크 테마 전환 (저장됨, 기본은 OS 따라감)
  - `▾` 카드 ↔ 컴팩트 칩 모드 전환
- **트레이 아이콘**: 잔량 게이지로 실시간 변함(가장 적게 남은 윈도우 기준, 20% 이하면 레드),
  마우스를 올리면 "Claude N% · Codex N% 남음" 툴팁.
  클릭 = 창 숨김/복귀 (숨겼다 복귀하면 펼쳐진 카드 상태)
- **트레이 우클릭**: 메뉴(새로고침, 자동 시작, 위치 초기화, 종료)
- 잔량 20% 이하로 떨어지면 토스트 알림 (윈도우별 1회)

## 데이터 소스

- **Claude**: `api.anthropic.com/api/oauth/usage` (Claude Code의 `/usage`와 동일한 서버 기준)
- **Codex**: `chatgpt.com/backend-api/wham/usage` (실시간), 실패 시 세션 로그 폴백

둘 다 로컬에 저장된 기존 로그인 토큰을 읽어 쓴다. 별도 로그인 불필요.
표기는 모두 **남은 %** 기준.
