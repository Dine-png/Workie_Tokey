// 빌드/실행 전에 이미 떠 있는 워키토키를 종료한다.
// 실행 중인 WorkieTokey.exe가 dist/win-unpacked 안의 파일을 점유하고 있으면
// electron-builder가 "다른 프로세스가 파일을 사용 중" (EBUSY) 으로 실패한다.
const { execFileSync } = require('child_process');

if (process.platform !== 'win32') process.exit(0);

const script = [
  "$targets = Get-CimInstance Win32_Process -Filter \"Name = 'WorkieTokey.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' }",
  "if ($targets) { $targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Output ('[stop-app] stopped ' + @($targets).Count + ' WorkieTokey process(es)') }"
].join('; ');

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 10000
  }).toString().trim();
  if (out) console.log(out);
  // 자식 프로세스까지 정리되고 파일 핸들이 풀릴 시간을 준다.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
} catch (err) {
  console.warn('[stop-app] skipped:', err.message);
}
