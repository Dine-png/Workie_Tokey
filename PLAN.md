# 워키토키 (Workie_Tokey) 기획서

> Work + Token + 워키토키. 사용 중인 AI(Claude Code, Codex 등)의 남은 토큰량을
> 화면 위에 창 없는 오버레이로 보여주는 데스크톱 프로그램.

작성일: 2026-06-10 · 상태: 기획 확정 (1차 타당성 검증 완료)

---

## 1. 컨셉

- **창이 없는 프로그램.** 타이틀바, 테두리, 작업표시줄 아이콘 없이 화면 구석에
  정보만 떠 있다. 종료/설정은 트레이 아이콘에서만.
- **항상 위 (always-on-top)** — 어떤 작업을 하든 토큰 잔량이 항상 보인다.
- **드래그 가능** — 마우스로 잡아서 원하는 위치로 옮길 수 있다.

표시 예시:

```
 ◢ Workie Tokey
 🟠 Claude   ▓▓▓▓▓▓▓░░░  68%   (5h, 14:32 리셋)
 🟢 Codex    ▓▓░░░░░░░░  16%   (주간)
```

## 2. 지원 대상 (MVP)

| 대상 | 데이터 소스 | 상태 |
|---|---|---|
| **Codex (ChatGPT Plus 구독)** | ① 실시간: `GET chatgpt.com/backend-api/wham/usage` (Bearer = `~/.codex/auth.json`의 `tokens.access_token`, 헤더 `chatgpt-account-id`) ② 폴백: `~/.codex/sessions/**/*.jsonl` 마지막 `rate_limits` 스냅샷 | ✅ **구현 완료.** 응답 `rate_limit.primary_window/secondary_window`의 `used_percent`, `reset_at`, `limit_window_seconds` 사용. 401 등 실패 시 자동으로 로그 폴백 |
| **Claude Code (구독)** | ① 실시간: `GET api.anthropic.com/api/oauth/usage` (Bearer = `~/.claude/.credentials.json`, 헤더 `anthropic-beta: oauth-2025-04-20` + `User-Agent: claude-code/<버전>` 필수) ② 토큰 만료 시 `console.anthropic.com/v1/oauth/token`으로 refresh 후 **파일에 write-back** (리프레시 토큰 회전 대응) | ✅ **구현 완료.** `/usage` 명령과 동일한 서버 기준 수치 (`five_hour`/`seven_day`의 `utilization`, `resets_at`) |

2차 후보 (MVP 이후): Gemini/Antigravity (인증 정보는 있으나 쿼터 조회 방법 조사 필요), API 키 사용량.

## 3. 기술 스택

- **Electron** (Node 설치 확인됨)
  - 메인 프로세스: 파일 감시/파싱, 트레이, 창 관리
  - 렌더러: 오버레이 UI (HTML/CSS — 투명 배경)
- 창 옵션: `frame: false`, `transparent: true`, `alwaysOnTop: true`,
  `skipTaskbar: true`, `resizable: false`
- 드래그: CSS `-webkit-app-region: drag` (버튼 영역만 `no-drag`)
- 트레이 메뉴: 표시/숨김, 위치 초기화, 시작 시 자동 실행, 종료

## 4. 동작 구조

```
[수집기 Collector]  ── 어댑터 구조 (소스마다 1개)
 ├─ codex-adapter   : 최신 세션 jsonl을 tail → rate_limits 추출
 └─ claude-adapter  : OAuth usage 조회 (폴백: jsonl 5h 윈도우 합산)
        ↓ 30~60초 주기 + 파일 변경 감지(fs.watch)
[상태 저장소 Store]  : { source, usedPercent, window, resetsAt, updatedAt }
        ↓ IPC
[오버레이 Overlay]   : 게이지 바 + % + 리셋 시간, 임계치별 색상 (🟢<50 🟡<80 🔴≥80)
```

## 5. 디자인 (Claude 인터페이스 스타일)

목표: claude.ai / Claude Code의 디자인 언어 — 따뜻한 크림 톤, 테라코타 오렌지 포인트,
세리프 악센트, 부드러운 둥근 모서리, 플랫하고 절제된 표면.

### 디자인 토큰

| 토큰 | 라이트 | 다크 |
|---|---|---|
| 카드 배경 | `#FAF9F5` (크림) | `#262624` (웜 차콜) |
| 게이지 트랙 | `#ECEAE2` | `#3A3A37` |
| 본문 텍스트 | `#3D3D3A` | `#F5F4EF` |
| 보조 텍스트 | `#8A8984` | `#8A8984` |
| 힌트 텍스트 | `#A8A69E` | `#6B6A64` |
| Claude 포인트 | `#D97757` (테라코타 — Claude 브랜드 톤) | 동일, 텍스트는 `#E89B7D` |
| Codex 포인트 | `#1D9E75` (틸) | 동일, 텍스트는 `#5DCAA5` |
| 경고 (80%↑) | `#E24B4A` 게이지로 전환 | 동일 |
| 테두리 | `rgba(0,0,0,0.12)` 0.5px | `rgba(255,255,255,0.10)` 0.5px |
| 모서리 | 카드 8px, 게이지 2px, 컴팩트 모드 6px(각진 칩) | 동일 |

### 타이포그래피 — 갈무리11 (픽셀 폰트, 확정)

- 전체 폰트: **Galmuri11 (11px)** — 처음엔 Galmuri9(9px)였으나 "1.3배 키우자" 요청으로 변경.
  픽셀 폰트는 정수 배수만 또렷하므로 9px×1.3 대신 한 단계 큰 Galmuri11을 채택 (~1.22배)
- 퍼센트 숫자 강조: **Galmuri11 Bold** (`Galmuri11-Bold.ttf`, 갈무리 공식 npm 배포에서 동봉)
- **크기는 반드시 11px 또는 22px** (11의 배수) — 다른 크기에서는 뭉개짐
- 폰트 파일: `assets/fonts/` 에 Galmuri11, Galmuri11-Bold, Galmuri9, Galmuri7 동봉 (SIL OFL)
- 주의: Windows 디스플레이 배율이 100%가 아니면(125%/150%) 픽셀 폰트가 미세하게 흐려질 수 있음
- 컨셉: Claude의 따뜻한 크림/테라코타 팔레트 + 픽셀 폰트 = 따뜻한 레트로

### 레이아웃 원칙

- 그라데이션·그림자·블러 금지, 플랫한 단색 표면 + 헤어라인 테두리
- **픽셀 감성에 맞춰 모서리 축소**: 카드 8px, 게이지 2px(채움 바는 각지게), 컴팩트 모드는 알약 대신 각진 칩(6px)
- 게이지 바: 높이 8px, 색상 = 소스 브랜드 톤
- **표기는 "남은 %" 기준** (Codex 공식 UI와 동일) — 게이지 = 남은 양, 20% 이하면 레드로 전환
- 스냅샷의 리셋 시각이 지났으면 새 윈도우 미사용으로 간주 → 자동으로 100% 남음 처리
- 컴팩트 모드 상태 점: 원형 대신 **7px 사각형 픽셀**
- 카드 하단에 "마지막 갱신" 힌트 라인 (Codex 스냅샷 신선도 문제 대응)
- **두 가지 표시 모드**: 카드 모드(기본) ↔ 컴팩트 칩 모드(한 줄), 토글 버튼/트레이로 전환
- **창은 내용에 딱 맞게 자동 측정** (`ResizeObserver` → IPC → 메인이 창 크기 조정). 폰트가 커져도 창은 최소 크기 유지
- **펼침 방향 자동**: 창이 화면 어느 사분면에 있는지 보고 가까운 모서리를 고정점으로 삼아 펴짐 (좌하단이면 우상 방향으로) + 작업영역 클램프로 항상 화면 안에 보이게
- 다크/라이트는 OS 테마 자동 추종 (`nativeTheme`) + 트레이에서 수동 전환

## 6. 개발 단계

1. ✅ **Phase 1 — Codex 어댑터 + 오버레이 뼈대** (2026-06-10 완료)
2. ✅ **Phase 2 — Claude 어댑터** (2026-06-10 완료, OAuth 실시간 + 토큰 자동 갱신)
3. ✅ **Phase 3 — 다듬기** (2026-06-10 완료)
   - Codex도 실시간 API로 전환 (`wham/usage`)
   - 시작 시 자동 실행 토글 (트레이 메뉴)
   - 잔량 20% 이하 진입 시 토스트 알림 (윈도우별 1회, 리셋 후 재활성)
   - electron-builder portable exe 패키징 (`npm run dist` → `dist/WorkieTokey.exe`)

## 7. 확인된 리스크

- Claude의 OAuth 사용량 엔드포인트는 **비공식** — 버전업 시 바뀔 수 있음.
  → 로그 기반 추정을 항상 폴백으로 유지.
- Codex `rate_limits`는 세션이 활성일 때만 갱신됨 — Codex를 한동안 안 쓰면
  마지막 스냅샷 기준 표시 (마지막 갱신 시각을 함께 표시해서 해결).
- ChatGPT **웹** 구독 사용량(웹에서 쓴 분량)은 조회 불가 — Codex CLI 사용분 기준임을 UI에 명시.

## 8. 검증에 사용한 실제 데이터

- Codex: `~/.codex/sessions/2026/06/09/rollout-*.jsonl`
  `"rate_limits":{"primary":{"used_percent":67.0,"window_minutes":300,"resets_at":...},"secondary":{"used_percent":16.0,"window_minutes":10080,...},"plan_type":"plus"}`
- Claude: `~/.claude/projects/**/*.jsonl` 각 줄에
  `timestamp`, `message.model`, `message.usage.{input_tokens,output_tokens,cache_*}`
