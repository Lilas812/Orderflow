# Windows 11 x64 — manual acceptance checklist

This is a procedure, not a Windows PASS. Linux SwiftShader measurements cannot
establish Windows, physical GPU, SmartScreen, or real monitor behavior.

1. Use Windows 11 x64, supported GPU driver, Node **24.x** and pnpm **10.26.1**
   (the pnpm version used in this Linux verification). Record OS build, CPU/RAM, GPU and driver,
   `node --version` and `pnpm --version`. Do not put credentials in transcripts.
2. In PowerShell at the repository root:
   ```powershell
   pnpm install --frozen-lockfile
   pnpm desktop:build
   pnpm desktop:package:win
   ```
   Do not change the lockfile, enable excluded platforms indiscriminately, or
   disable package protection. Output must not already exist.
3. Run the entire portable folder, not an isolated exe:
   ```powershell
   & ".\apps\desktop\dist\windows\Orderflow Lab-win32-x64\Orderflow Lab.exe"
   ```
   No installer, signing or updater is provided. If Defender/SmartScreen blocks
   execution, record the exact warning, policy, file hash and Defender event.
   Do not disable antivirus or claim that a blocked launch passed.
4. Confirm **MOCK / SIMULATED**, never LIVE market connectivity. Check the finite
   13-input baseline, common revision13, Heatmap/Bubble/Delta/VP/POC/VAH/VAL.
   This does not replace Task29/30 workload correctness gates.
5. Record actual window/content dimensions, minimum size, Canvas CSS dimensions,
   width/height attributes and WebGL drawing buffer; check both Canvas layers.
   Resize wide/narrow and maximize/restore; time and price axes must still agree.
6. Repeat on actual monitor scaling **100%, 150%, 200%**. Record devicePixelRatio,
   both Canvas buffers vs rounded CSS×DPR, and monitor transitions. Synthetic CDP
   emulation is not a substitute. Do not impose the old browser 403×324 dimensions.
7. In a diagnostic session, record Electron/Chromium versions and actual WebGL2
   vendor/renderer, GL errors, driver workarounds and software fallback. Physical
   GPU and SwiftShader are separate environments.
8. Record owned PID tree before/during/after. Close normally, confirm all owned
   app/renderer/GPU/utility processes exit, and repeat start/close finitely. Do
   not terminate an unknown Electron process. Record exceptions and residuals.
9. On failure, stop and collect stderr and Windows Application/Defender events,
   versions, display/scaling, exact command, exe SHA-256, crash context and residual
   PIDs. Electron log files may be enabled for a dedicated diagnostic session:
   ```powershell
   & ".\apps\desktop\dist\windows\Orderflow Lab-win32-x64\Orderflow Lab.exe" `
     --enable-logging=file --log-file="$env:TEMP\orderflow-electron.log"
   ```
   Inspect/redact URLs, usernames, query parameters, environment values, cookies
   and tokens before sharing. Never dump Secrets or entire process environments.
   A permission-denied capture is UNKNOWN/FAIL, not a successful startup.

Keep Gate B-2B HOLD. No market subscription, event persistence, replay, settings
migration, or performance certification is authorized by this manual checklist.
