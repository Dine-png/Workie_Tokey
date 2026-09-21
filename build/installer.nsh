; 설치/제거 시작 전에 실행 중인 워키토키를 강제로 닫는다.
; 기본 NSIS 흐름은 앱이 떠 있으면 "파일이 이미 사용 중" 오류로 멈추거나
; 확인 창을 띄우는데, 워키토키는 트레이/에이전트 모드로 숨어 있는 경우가
; 많아 사용자가 직접 닫기 어렵다. 렌더러 자식 프로세스까지 모두 종료한 뒤
; 파일 핸들이 풀리도록 잠시 기다린다.
!macro closeRunningApp
  nsExec::ExecToLog 'taskkill /F /T /IM "WorkieTokey.exe"'
  Pop $0
  Sleep 1500
!macroend

!macro customInit
  !insertmacro closeRunningApp
!macroend

!macro customUnInit
  !insertmacro closeRunningApp
!macroend
