// 프로바이더가 반환하는 정규화된 "라인" 빌더.
// openusage의 line builder(progress/text/badge/barChart)를 차용하되,
// Electron 인프로세스 환경에 맞게 단순화했다. 모든 프로바이더가 같은
// 스키마로 출력하므로 렌더러/HTTP API/트레이가 종류에 상관없이 처리한다.

// 게이지 바 한 줄. 표기는 "남은 %" 기준(워키토키 전역 규칙).
//   remainingPercent: 0~100 (null이면 데이터 없음/연결 안 됨)
//   resetsAt: unix seconds (선택) — 리셋 시각 표기에 사용
function progress({ key, label, remainingPercent, note = '', resetsAt = null, dim = false }) {
  return { type: 'progress', key, label, remainingPercent, note, resetsAt, dim };
}

// 라벨 + 값 텍스트 한 줄 (예: "오늘  1.2M 토큰 · $3.40").
function text({ key, label, value, subtitle = '' }) {
  return { type: 'text', key, label, value, subtitle };
}

// 작은 뱃지 (예: 플랜 이름 "Pro").
function badge({ key, label, badgeText, subtitle = '' }) {
  return { type: 'badge', key, label, badgeText, subtitle };
}

// 막대 차트 한 줄. points: [{ label, value, valueLabel? }]
function barChart({ key, label, points, note = '' }) {
  return { type: 'barChart', key, label, points, note };
}

module.exports = { progress, text, badge, barChart };
