# Orderflow Lab — Windows 11 desktop shell (Task 30-A1)

This is the native Electron host for the **existing** Web React App, real
AnalysisHub, WebGL2 renderers and finite baseline13 MOCK session. Engines and
fixtures are not copied. The Web app keeps its normal NO DATA startup.

**No actual LIVE connection.** The desktop now has a RAM-only observation route,
fixed IPC and a separate LIVE HOLD display. Only synthetic input is enabled in
the Node test seam; the production host has no connected feed. No credentials,
order execution or market-data storage. R29-B-R5 Stage 0 remains FAIL (`DELTA_BIN_COUNT`); Stage 1/2 NOT_RUN.
This shell and its baseline13 functional smoke do not certify those stages.
The Windows desktop is the intended product; the Web app remains the
implementation/verification foundation.

## Requirements and commands

Use Node 24 and the workspace's pnpm 10. Electron 45.0.0 and
@electron/packager 20.3.0 are pinned in the lockfile. Electron downloads its
platform binary on demand into its ignored package/cache directory. No unrelated
workspace dependency resolution was updated.

For the Windows x64 frontend build, the existing exclusions of
`@esbuild/win32-x64` and `@rollup/rollup-win32-x64-msvc` are removed. Only these
target-platform optional dependencies are restored; existing versions and all
other platform exclusions remain unchanged.
The root pnpm-only preinstall guard uses Node instead of `sh`; a Windows install
does not need Git Bash merely to run that guard.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm desktop:dev         # builds main/preload, owns a loopback Vite and Electron
pnpm desktop:build       # dist/main + Vite bundle of existing Web App
pnpm desktop:start       # built assets, no HTTP server
```

Development binds **only** `127.0.0.1`, on an OS-selected port; the launcher
passes that exact origin to main and closes its Vite server when Electron exits.
No Replit Preview URL, existing Web Vite config, JSON middleware or public
artifact routing is used. Developer main/preload edits require stopping and
restarting `desktop:dev`; Vite HMR handles renderer edits.

Native desktop windows require a real desktop/display. Replit can provide VNC,
but Linux libraries and OS sandbox support must actually be present. **Never
add `--no-sandbox` to make an unsupported container appear to pass.** Missing
display, GTK/NSS libraries or supported sandbox is a platform limitation, not
proof of successful GUI startup. No system module/settings modifications are
made by this package. Windows behavior is not established by a Linux test.

For this inspected Replit workspace only, the non-secret generated library
inventory reproduces the verified VNC startup without changing project settings:

```sh
LD_LIBRARY_PATH="$(node -p "require('./.local/diagnostics/task30-a1/native-libraries.json').ldLibraryPath")" DISPLAY=:0 pnpm desktop:dev
```

Those Nix paths are environment-specific, not a Windows prerequisite.

## Assets, security and lifecycle

- Main/preload: Vite SSR bundles workspace ESM/TypeScript into CJS, `dist/main`.
  Electron/Node built-ins stay external; the sandboxed preload has no local
  module dependency. No runtime TypeScript loader or new external package.
- Renderer: imports `apps/web/src/App.tsx` and its styles directly. The only
  Web startup wiring is optional `initialMock` and `settingsTransport` props;
  ordinary Web callers omit them.
- Desktop starts the **existing 13-input baseline13 finite session**, at the
  existing 300ms/input and 250ms publication cadence. Existing Start/Stop/
  Restart/Exit MOCK UI remains available. No Task29 load generator is run.
- 1440×960 initial outer window; 1024×720 minimum. No 403×324 override. Existing
  ResizeObserver/Viewport/DPR paths remain authoritative. The chart's existing
  fixed vertical layout is retained; overflow is scrollable, not a new
  fullscreen chart design.
- Sandboxed renderer/preload: `sandbox`, `contextIsolation`, `webSecurity`
  enabled; `nodeIntegration`, insecure content and webviews disabled.
- Preload publishes frozen initial-source metadata and four fixed observation
  methods: select/read/stop/release. A single owned-window/main-frame/document
  checked IPC channel carries bounded replies. There is no arbitrary channel,
  filesystem, command, credential, or raw-wire-input bridge.
- Production loads `orderflow://app/index.html` and only whitelisted bundled
  assets through a realpath-contained handler. Remote/file navigation,
  redirects, downloads, popups, native permissions and remote network are
  blocked. Production CSP forbids network/frames/workers/object content.
  Dev allows only its owned loopback origin and matching Vite websocket.
- Launcher passes a runtime variable allowlist rather than forwarding project
  Secrets. Main/preload never read credentials.
- Existing settings preview/cancel run unchanged. Desktop host supplies cloned
  defaults and **explicitly rejects persistence**; it does not write the Web
  settings JSON, SQLite, events or a new settings file.

## Root NQ observations (offline implementation)

See [the contract and verification report](../../docs/live-observation-route.md).
The desktop selector switches between independent MOCK and observation screens;
it never relabels a MOCK frame as LIVE. LIVE selection is HOLD / NOT CONNECTED
until a separately authorized feed is integrated. Restart owns a new generation.
Stopping or switching clears quantities and cancels the renderer publication pump.

The provider documents root futures as automatically rolling, unadjusted
front-month continuous symbols, not individually addressable expiries. Tick/book
frames do not identify the expiry or exchange session. We retain both as null.
The latest Snapshot can be shown as an **observation**, not current market depth;
unlisted levels remain unknown, including when listed quantity zero is valid.
Without identity/completeness evidence, existing TWA, finalized Bubble, Delta
and Volume Profile calculations are not supplied with invented MarketEvents.
The four displays receive one coherent revision with explicit NO DATA states.
The last Trade observation is not an exactly deduplicated total.

Safety limits for this finite offline path: 1 MiB raw frame, 400 levels per side,
800 normalized levels, 20,000 accepted observations or 16 MiB cumulative normalized
input, and a 256 KiB IPC reply. Exceeding a budget stops, clears and reports the
reason; no eviction, truncation, storage or automatic reconnect. These are not
approved long-running market-data retention limits. Node publications are
coalesced at >=250 ms; the renderer allows only one request in flight, clears
quantities on a 2 s request timeout, and stops its timers. An observed book is
cleared after 2 s without a new book in the Node monotonic clock; this is a
conservative local display cutoff, not a provider freshness guarantee.
- Closing the window dispatches the browser unload lifecycle; desktop root
  unmount invokes existing session/timer/subscriber/GL cleanups. The app exits
  with its last window; no background service or auto-restart is installed.

## Windows package

On **Windows 11 x64**, with Node 24/pnpm, in this repository:

```powershell
pnpm install --frozen-lockfile
pnpm desktop:package:win
& ".\apps\desktop\dist\windows\Orderflow Lab-win32-x64\Orderflow Lab.exe"
```

The packaging tool stages **only** built main/preload/renderer plus a minimal
runtime package.json in a private OS temporary directory. It does not package
the monorepo, development dependencies, diagnostics, DBs or `.local`. ASAR
contains the local assets. Output is an **unsigned unpacked portable application
directory**, not an installer. Distribute the **whole directory**, not just
the exe. No code signing, installer, automatic updater, auto-start or live-data
storage is included. Existing output is not overwritten automatically.

Linux intentionally refuses `package:win`; this avoids claiming a Windows build
without the Windows resource toolchain. Configuration tests are not an actual
Windows build or installer/exe execution test. Those remain UNKNOWN until tested
on Windows. Delete only your generated desktop `dist` to undo generated output;
no existing data migration occurs.

## Tests / finite native smoke

```sh
pnpm --filter @workspace/desktop test
pnpm --filter @workspace/desktop typecheck
pnpm --filter @workspace/core test
pnpm --filter @workspace/render test
pnpm --filter @workspace/web test
pnpm typecheck
pnpm build
git diff --check
```

Storage timeout is an existing separate issue; these commands do not establish
a stable all-monorepo regression. No existing assertion, timeout or skip is
relaxed.

After build, to run a finite **functional** native Electron smoke (not a
performance benchmark), choose a new, nonexistent output directory:

```sh
cd apps/desktop
node tools/launch.mjs --smoke --output-dir=/absolute/private/new-run
# Development variant (also owns an ephemeral local Vite):
node tools/launch.mjs --smoke --dev --output-dir=/absolute/private/new-dev-run
```

On Linux a local display can be selected with `--display=:0`. Smoke-only
`--software` selects SwiftShader without disabling the OS/renderer sandbox.
Do not interpret software rendering as physical-GPU performance.

Smoke is finite (45s), records genuine main/preload preferences, real App
completion, existing baseline checks, Canvas/revision/DPR geometry, native
capture, resize and synthetic CDP DPR2, then real root unmount and app quit.
It does not mutate product state or add a permanent diagnostic API. Unobservable
timer/GL allocation counts remain UNKNOWN. It does not test Windows monitor
scaling or all context loss scenarios, nor fix/waive the R5 diagnostic FAIL.
No automatic retries or forced kills are installed. An environment failure
before Electron can execute the script may produce no result.json; preserve
the launcher stderr/exit status and report GUI UNKNOWN rather than PASS.

## Next, separately approved work

1. Fix the R5 observer's `delta-row-empty` versus real-bin classification with
   production-shaped empty/known-zero/invalid-row regressions, preserving the
   original FAIL. No Delta calculation changes.
2. Design and then separately authorize desktop-window Stage 0 -> 1 -> 2
   diagnostics, with fixed input/reference, bounded CPU/RAM/process/output
   budgets, honest ownership/cleanup and fail-fast gates. Do not reuse a
   baseline13 functional smoke as proof of those load stages.
