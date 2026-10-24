Source: https://releases.electronjs.org/release/v45.0.0
Title: v45.0.0 | Electron Releases
Fetched: 2026-10-24T19:34:51.192Z

## Electron v45.0.0

Latest Stable

Released Oct 21, 20263 days ago

Compare to...v45.0.0v45.0.0-beta.7v45.0.0-beta.6v45.0.0-beta.5v45.0.0-beta.4v45.0.0-beta.3v45.0.0-beta.2v45.0.0-beta.1v45.0.0-alpha.16v45.0.0-alpha.15v45.0.0-alpha.14v45.0.0-alpha.13v45.0.0-alpha.12v45.0.0-alpha.11v45.0.0-alpha.10v45.0.0-alpha.9v45.0.0-alpha.8v45.0.0-alpha.7v45.0.0-alpha.6v45.0.0-alpha.5v45.0.0-alpha.4v45.0.0-alpha.3v45.0.0-alpha.2v45.0.0-alpha.1

npm

npm install --save-dev electron@45.0.0

yarn

yarn add --dev electron@45.0.0

Google ChromeChromium

[156.0.8078.48](https://source.chromium.org/chromium/chromium/src/+/refs/tags/156.0.8078.48:)

Node.jsNode.js

[24.22.0](https://github.com/nodejs/node/releases/tag/v24.22.0)

V8V8

15.6.75.19

### Release Notes

## Stack Upgrades

- Chromium `156.0.8078.48`

  - [Chrome 156 Release Notes](https://chromestatus.com/release-notes/156)

  - [Chrome 155 Release Notes](https://chromestatus.com/release-notes/155)

  - [New in 154](https://developer.chrome.com/blog/new-in-chrome-154/)

  - [New in 153](https://developer.chrome.com/blog/new-in-chrome-153/)
- Node `v24.22.0`

  - [Node 24.22.0 blog post](https://nodejs.org/en/blog/release/v24.22.0/)
- V8 `15.6`


## Breaking Changes

- Reduced sandboxed renderer startup work for preload scripts that do not use `Buffer`. [#54048](https://github.com/electron/electron/pull/54048)

  - Removed the `events`, `timers` and `url` modules and the `Buffer`, `setImmediate` and `clearImmediate` globals from sandboxed preload scripts; use a polyfill.

  - Made sandboxed renderers without a preload script start faster.

  - Made sandboxed preload scripts start faster; Electron no longer evaluates a JavaScript bundle of its own in sandboxed renderers unless `webviewTag` is enabled.
- With `nodeIntegrationInWorker: true`, a `Worker` created from an `<iframe>` in the same process as the main frame used to get Node.js integration even though the iframe itself had none. Workers now only get Node.js integration when the frame that creates them has it: the main frame, or any frame when `nodeIntegrationInSubFrames` is enabled.

- A `chrome-extension://` document used to receive the window's preload script (and session preload scripts) wherever it was embedded. It now only does so when it is a top-level frame or is hosted inside the DevTools front-end (a `devtools_page` or panel); an extension frame embedded in an ordinary page is treated like any other subframe and follows `nodeIntegrationInSubFrames`.

- The legacy `chromeMediaSource: 'desktop'` constraint now only accepts screen and window source ids from [`desktopCapturer.getSources`](https://github.com/electron/electron/blob/v45.0.0/docs/api/desktop-capturer.md#desktopcapturergetsourcesoptions). Passing a WebContents source id there now fails with an "Invalid state" error. To capture a WebContents, use `chromeMediaSource: 'tab'` with an id from [`webContents.getMediaSourceId()`](https://github.com/electron/electron/blob/v45.0.0/docs/api/web-contents.md#contentsgetmediasourceidrequestwebcontents), or use [`ses.setDisplayMediaRequestHandler`](https://github.com/electron/electron/blob/v45.0.0/docs/api/session.md#sessetdisplaymediarequesthandlerhandler-opts).

- The experimental `contentTracing.enableHeapProfiling()` API has been removed. Chromium removed the memlog implementation that backed this API and replaced it with a Perfetto heap-profiling data source. Pass a `nativeHeapProfiling` option to `contentTracing.startRecording()` to enable heap profiling for the duration of a trace. Like all recordings, heap-enabled recordings use the [Perfetto protobuf format](https://perfetto.dev/docs/reference/trace-packet-proto).

- Changed heap profiling in `contentTracing` recordings to now use a perfetto heap-profiling data source. [#54863](https://github.com/electron/electron/pull/54863)

- Screen, window and tab capture requests are now reported to `setPermissionRequestHandler` as `display-capture` instead of `media`; a handler that allows only `media` must also allow `display-capture` to keep screen sharing working. [#52824](https://github.com/electron/electron/pull/52824)

- Chromium has disabled `document.requestStorageAccessFor` by default ahead of its removal. The API can temporarily be restored with the [`enableBlinkFeatures`](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/web-preferences.md) web preference set to `RequestStorageAccessFor`. See [Chromium's intent to remove discussion](https://groups.google.com/a/chromium.org/g/blink-dev/c/bqHGZYHWxnQ) for more information.

- `fs.open`, `fs.openSync` and `fs.promises.open` on a file inside an ASAR archive used to extract the file to a temporary copy and return a descriptor for that copy. They now return a descriptor that only identifies the entry to Node's `fs` module, which reads directly out of the archive with no temporary file (`fs.read`, `fs.readv`, `fs.fstat`, `fs.readFile(fd)`, `fs.createReadStream` and the `FileHandle` methods). The descriptor itself is not backed by the file's contents: code that reads the raw descriptor (a native addon, `child_process``stdio`, `net.Socket({ fd })`, `http2stream.respondWithFile()` / `respondWithFD()`, a `FileHandle` transferred to a worker, ...) fails with `EBADF` and is not supported. Opening a file inside an archive with a flag that allows writing (`w`, `a`, `r+`, ...) now fails with `EACCES` instead of silently writing to the temporary copy, and `fs.fchmod`, `fs.fchown` and `fs.futimes` on these descriptors fail with `EACCES`.

- A `window.open()` child whose `sandbox` state differs from its opener's renderer process is now created in its own process with no opener relationship instead of silently sharing the opener's process; set `sandbox: false` in `setWindowOpenHandler` to keep sharing an unsandboxed opener's process. [#52472](https://github.com/electron/electron/pull/52472)

- The synchronous `safeStorage` methods are deprecated and will be removed in Electron 46, following Chromium's removal of the synchronous OSCrypt backend they are built on. Use the asynchronous methods instead, which use the same per-platform key stores. Data encrypted with `safeStorage.encryptString()` can be decrypted with `safeStorage.decryptStringAsync()`.

- Added `select-client-certificate` event support for `net.request` and `net.fetch`; requests to servers requesting a client certificate no longer fail with `ERR_SSL_CLIENT_AUTH_CERT_NEEDED`, and applications can now select a certificate to present. [#52162](https://github.com/electron/electron/pull/52162)(Also in [44](https://github.com/electron/electron/pull/52397))

- Clipboard module is now aligned with the W3C Clipboard API. [#51707](https://github.com/electron/electron/pull/51707)(Also in [44](https://github.com/electron/electron/pull/52508))

- Removed 32-bit builds (Windows ia32 and Linux armv7l). Electron is now published only for 64-bit (x64 and arm64) platforms. [#51816](https://github.com/electron/electron/pull/51816)(Also in [44](https://github.com/electron/electron/pull/52326))

- Removed `openAsHidden` option from `app.setLoginItemSettings()`. [#52351](https://github.com/electron/electron/pull/52351)(Also in [44](https://github.com/electron/electron/pull/52667))

  - Removed `openAsHidden`, `wasOpenedAsHidden` and `restoreState` fields from return value of `app.getLoginItemSettings()`.

  - Fixed potential deadlock inside `app.getLoginItemSettings()` on macOS.
- Updated the Linux support policy. [#52429](https://github.com/electron/electron/pull/52429)(Also in [44](https://github.com/electron/electron/pull/52538))


See the [Breaking Changes](https://github.com/electron/electron/blob/v45.0.0/docs/breaking-changes.md) doc for more details about these changes.

## Features

- Added a `badge` property to `MenuItem` on macOS 14+ for showing a count or custom text badge next to a menu item's label. [#50805](https://github.com/electron/electron/pull/50805)(Also in [43](https://github.com/electron/electron/pull/53045), [44](https://github.com/electron/electron/pull/53046))

- Added a Save/Restore Window State API for cross-platform use. [#51510](https://github.com/electron/electron/pull/51510)(Also in [44](https://github.com/electron/electron/pull/52270))

- Added a Windows Error Reporting helper (`electron_wer.dll`, renamed to `<app>_wer.dll` alongside the executable) so `crashReporter` captures `__fastfail` and other crashes that bypass the in-process handler on Windows. [#53851](https://github.com/electron/electron/pull/53851)

- Added app shims on macOS to show windows under another app's Dock icon. [#55072](https://github.com/electron/electron/pull/55072)(Also in [44](https://github.com/electron/electron/pull/55073))

- Added `app.configureWebAuthn()` API to enable iCloud Keychain passkey support on macOS. When enabled, `navigator.credentials.create()` and `.get()` present Apple's native passkey UI via [`ASAuthorizationController`](https://developer.apple.com/documentation/authenticationservices/asauthorizationcontroller?language=objc). [#51563](https://github.com/electron/electron/pull/51563)

- Added `available` to `process.getSystemMemoryInfo()` on Linux, exposing `proc/meminfo` MemAvailable. [#52299](https://github.com/electron/electron/pull/52299)(Also in [42](https://github.com/electron/electron/pull/52378), [43](https://github.com/electron/electron/pull/52379), [44](https://github.com/electron/electron/pull/52380))

- Added `disableWakeLocks` option to WebPreferences. [#52342](https://github.com/electron/electron/pull/52342)

- Added `getIsolatedWorlds` method and `isolated-world-created` event for `webFrame` to enable discovery of isolated worlds. [#50633](https://github.com/electron/electron/pull/50633)

- Added `initiatorOrigin` to webRequest and protocol handler requests, `DownloadItem.getInitiatorOrigin()`, and a trailing `frame` argument to the `will-download` and `preconnect` session events. [#53700](https://github.com/electron/electron/pull/53700)(Also in [43](https://github.com/electron/electron/pull/53704), [44](https://github.com/electron/electron/pull/53703))

- Added launch-failure reporting with `systemErrorCode` to the `app``child-process-gone` event. [#54230](https://github.com/electron/electron/pull/54230)(Also in [44](https://github.com/electron/electron/pull/54231))

- Added support for `Notification` action buttons on Linux. [#54889](https://github.com/electron/electron/pull/54889)(Also in [44](https://github.com/electron/electron/pull/54890))

- Added support for the Prompt API via the new `localAIHandler` module in UtilityProcess. [#50659](https://github.com/electron/electron/pull/50659)

- Added the `ELECTRON_DEBUG_DRAGGABLE_REGIONS` environment variable, which visualizes and logs draggable regions in unpackaged apps to help debug custom title bars. [#53626](https://github.com/electron/electron/pull/53626)(Also in [43](https://github.com/electron/electron/pull/53633), [44](https://github.com/electron/electron/pull/53627))

- Added the experimental `protocol.registerSource()` to serve a custom scheme from directories on disk without a JavaScript handler. [#54521](https://github.com/electron/electron/pull/54521)(Also in [44](https://github.com/electron/electron/pull/54522))

- Added webContents.caretBrowsingEnabled for toggling caret browsing in a WebContents. [#52696](https://github.com/electron/electron/pull/52696)(Also in [43](https://github.com/electron/electron/pull/53034), [44](https://github.com/electron/electron/pull/53035))

- Added `webFrameMain.printToPDF()` to allow printing individual frames to PDF from the main process. [#52439](https://github.com/electron/electron/pull/52439)(Also in [42](https://github.com/electron/electron/pull/52626), [43](https://github.com/electron/electron/pull/52627), [44](https://github.com/electron/electron/pull/52625))

- Fixed an issue where `getDisplayMedia({ audio: { restrictOwnAudio: true } })` was ignored in `setDisplayMediaRequestHandler`, causing loopback audio to include local app playback. [#52455](https://github.com/electron/electron/pull/52455)(Also in [43](https://github.com/electron/electron/pull/52533), [44](https://github.com/electron/electron/pull/52534))

- Frameless windows on Linux now use system-themed titlebar icons for Window Controls Overlay (WCO). [#52461](https://github.com/electron/electron/pull/52461)(Also in [44](https://github.com/electron/electron/pull/52531))

- `fs.open`, `fs.createReadStream`, `fs.copyFile`, `fs.cp` and friends now read files inside ASAR archives directly from the archive instead of extracting a temporary copy; `fs.opendir` and `fs.readlink` work on archives; opening a packed file for writing fails with `EACCES`. [#52833](https://github.com/electron/electron/pull/52833)

- Restored `app.setBadgeCount` and `win.setProgressBar` for Linux. These APIs now support any dock or taskbar which implements the LauncherEntry D-Bus API, and they no longer require `libunity`. [#52739](https://github.com/electron/electron/pull/52739)(Also in [44](https://github.com/electron/electron/pull/52895))

- The macOS `autoUpdater` now streams update downloads to disk, resumes an interrupted download on the next check instead of starting over, and applies a binary delta when the update feed offers one for the running version. [#52820](https://github.com/electron/electron/pull/52820)(Also in [44](https://github.com/electron/electron/pull/54204))


## Fixes

- `<webview>` and `window.open` now inherit `nodeIntegrationInWorker` from the embedder, consistent with the other Node and sandbox preferences. [#52823](https://github.com/electron/electron/pull/52823)(Also in [41](https://github.com/electron/electron/pull/52829), [42](https://github.com/electron/electron/pull/52831), [43](https://github.com/electron/electron/pull/52830), [44](https://github.com/electron/electron/pull/52832))

- `<webview>` without `allowpopups` also blocks links opened into a new window by modifier-click, and such windows navigate as the clicking document rather than as a browser-initiated load. [#53717](https://github.com/electron/electron/pull/53717)(Also in [42](https://github.com/electron/electron/pull/53719), [43](https://github.com/electron/electron/pull/53718), [44](https://github.com/electron/electron/pull/53721))

- Added validation to `protocol.registerSchemesAsPrivileged()` to reject protocol names that do not conform to RFC 3986 URI scheme grammar. [#53742](https://github.com/electron/electron/pull/53742)(Also in [44](https://github.com/electron/electron/pull/53743))

- Changed the default trash implementation on KDE Plasma 6 to `kioclient`. [#54362](https://github.com/electron/electron/pull/54362)(Also in [44](https://github.com/electron/electron/pull/54361))

- DevTools zoom in/out now uses the same zoom steps as Chromium. [#54388](https://github.com/electron/electron/pull/54388)(Also in [44](https://github.com/electron/electron/pull/54387))

- File System Access permission requests and the `file-system-access-restricted` event are scoped to the requesting document, grants are reset when the origin's last page closes, and write access works in in-memory sessions. [#53690](https://github.com/electron/electron/pull/53690)(Also in [42](https://github.com/electron/electron/pull/53695), [43](https://github.com/electron/electron/pull/53694), [44](https://github.com/electron/electron/pull/53691))

- Fixed `--xdg-portal-required-version` having no effect and a spurious portal warning being logged for file dialogs on Linux. [#54302](https://github.com/electron/electron/pull/54302)(Also in [43](https://github.com/electron/electron/pull/54304), [44](https://github.com/electron/electron/pull/54303))

- Fixed `<select>` dropdowns not rendering in offscreen windows on macOS. [#53716](https://github.com/electron/electron/pull/53716)

- Fixed a 1-in-200 chance per renderer process on Windows of scripts on the first page load being compiled without their V8 code cache. [#52791](https://github.com/electron/electron/pull/52791)(Also in [42](https://github.com/electron/electron/pull/52988), [43](https://github.com/electron/electron/pull/52943), [44](https://github.com/electron/electron/pull/52792))

- Fixed a browser process crash that could occur during Windows logoff, shutdown, or restart. [#52604](https://github.com/electron/electron/pull/52604)(Also in [42](https://github.com/electron/electron/pull/52621), [43](https://github.com/electron/electron/pull/52620), [44](https://github.com/electron/electron/pull/52619))

- Fixed a browser-process crash (`ValidateIntegrityOrDie`) and spurious preload `ENOENT` errors when an app's `app.asar` is replaced on disk (e.g. by an updater or MDM software) while the app is running. [#52283](https://github.com/electron/electron/pull/52283)(Also in [42](https://github.com/electron/electron/pull/52294), [43](https://github.com/electron/electron/pull/52293), [44](https://github.com/electron/electron/pull/52292))

- Fixed a bug where content-protected windows could temporarily appear in screen captures during picture-in-picture state changes. [#54612](https://github.com/electron/electron/pull/54612)

- Fixed a child `WebContentsView` losing focus when its window is reactivated. [#54454](https://github.com/electron/electron/pull/54454)(Also in [43](https://github.com/electron/electron/pull/54456), [44](https://github.com/electron/electron/pull/54455))

- Fixed a crash in `systemPreferences.promptTouchID(reason)` when an invalid reason value is passed. [#52764](https://github.com/electron/electron/pull/52764)(Also in [42](https://github.com/electron/electron/pull/52780), [43](https://github.com/electron/electron/pull/52782), [44](https://github.com/electron/electron/pull/52781))

- Fixed a crash on Linux at startup or on theme change with GTK modules loaded. [#55017](https://github.com/electron/electron/pull/55017)

- Fixed a crash on Linux when `process.env` was written while another thread was reading the environment, and a memory leak when a worker thread exits. [#53508](https://github.com/electron/electron/pull/53508)(Also in [42](https://github.com/electron/electron/pull/53511), [43](https://github.com/electron/electron/pull/53510), [44](https://github.com/electron/electron/pull/53509))

- Fixed a crash on Linux when the D-Bus session bus disconnected while the app was running, such as at logout or when dbus is restarted. [#53022](https://github.com/electron/electron/pull/53022)(Also in [42](https://github.com/electron/electron/pull/53094), [43](https://github.com/electron/electron/pull/53095), [44](https://github.com/electron/electron/pull/53096))

- Fixed a crash on macOS when a notification's icon could not be attached; the notification is now shown without the icon. [#53131](https://github.com/electron/electron/pull/53131)(Also in [42](https://github.com/electron/electron/pull/53148), [43](https://github.com/electron/electron/pull/53147), [44](https://github.com/electron/electron/pull/53146))

- Fixed a crash on macOS when a WebAuthn Touch ID prompt was requested while no locale resources were loaded. [#53185](https://github.com/electron/electron/pull/53185)(Also in [43](https://github.com/electron/electron/pull/53195), [44](https://github.com/electron/electron/pull/53194))

- Fixed a crash on `navigator.usb.requestDevice()` in in-memory sessions. [#54615](https://github.com/electron/electron/pull/54615)(Also in [44](https://github.com/electron/electron/pull/54616))

- Fixed a crash on Windows when V8 posted a delayed worker task during shutdown. [#52956](https://github.com/electron/electron/pull/52956)(Also in [42](https://github.com/electron/electron/pull/53014), [43](https://github.com/electron/electron/pull/53013), [44](https://github.com/electron/electron/pull/53201))

- Fixed a crash report when the X server or Wayland compositor exits while an app is running. [#52603](https://github.com/electron/electron/pull/52603)(Also in [42](https://github.com/electron/electron/pull/52686), [43](https://github.com/electron/electron/pull/52685), [44](https://github.com/electron/electron/pull/52684))

- Fixed a crash that could occur when closing DevTools while the host WebContents was being destroyed. [#52166](https://github.com/electron/electron/pull/52166)(Also in [41](https://github.com/electron/electron/pull/52512), [42](https://github.com/electron/electron/pull/52511), [43](https://github.com/electron/electron/pull/52510), [44](https://github.com/electron/electron/pull/52509))

- Fixed a crash when a WebAuthn request used a security key that required its PIN. [#54371](https://github.com/electron/electron/pull/54371)(Also in [43](https://github.com/electron/electron/pull/54404), [44](https://github.com/electron/electron/pull/54403))

- Fixed a crash when a webContents navigated to the Chrome Web Store and the page invoked the unsupported `chrome.webstorePrivate` API. [#53775](https://github.com/electron/electron/pull/53775)(Also in [44](https://github.com/electron/electron/pull/53776))

- Fixed a crash when accessing frame details during cross-origin navigation. [#53102](https://github.com/electron/electron/pull/53102)(Also in [44](https://github.com/electron/electron/pull/53109))

- Fixed a crash when calling `node:wasi` functions in optimized code. [#53266](https://github.com/electron/electron/pull/53266)(Also in [42](https://github.com/electron/electron/pull/53267), [43](https://github.com/electron/electron/pull/53265), [44](https://github.com/electron/electron/pull/53268))

- Fixed a crash when calling `setIgnoreMenuShortcuts()` on DevTools. [#54115](https://github.com/electron/electron/pull/54115)(Also in [43](https://github.com/electron/electron/pull/54117), [44](https://github.com/electron/electron/pull/54116))

- Fixed a crash when calling `utilityProcess.postMessage()` after the utility process had exited. [#53299](https://github.com/electron/electron/pull/53299)(Also in [43](https://github.com/electron/electron/pull/53301), [44](https://github.com/electron/electron/pull/53300))

- Fixed a crash when creating a framed window on Wayland in environments where GTK could not initialize. [#54399](https://github.com/electron/electron/pull/54399)(Also in [43](https://github.com/electron/electron/pull/54893), [44](https://github.com/electron/electron/pull/54420))

- Fixed a crash when quickly switching menus while the app is under heavy load. [#52598](https://github.com/electron/electron/pull/52598)(Also in [42](https://github.com/electron/electron/pull/52671), [43](https://github.com/electron/electron/pull/52673), [44](https://github.com/electron/electron/pull/52672))

- Fixed a crash when resolving a path inside a malformed ASAR archive that contains cyclic link entries. [#52825](https://github.com/electron/electron/pull/52825)(Also in [42](https://github.com/electron/electron/pull/52859), [43](https://github.com/electron/electron/pull/52857), [44](https://github.com/electron/electron/pull/52858))

- Fixed a crash when sending a DevTools protocol command with a non-string value for an optional string parameter via `webContents.debugger`. [#54444](https://github.com/electron/electron/pull/54444)(Also in [43](https://github.com/electron/electron/pull/54443), [44](https://github.com/electron/electron/pull/54445))

- Fixed a crash when showing Linux message boxes while another Linux UI implementation was active. [#52238](https://github.com/electron/electron/pull/52238)(Also in [42](https://github.com/electron/electron/pull/52408), [43](https://github.com/electron/electron/pull/52410), [44](https://github.com/electron/electron/pull/52409))

- Fixed a crash when starting without an available display server on Linux. [#54781](https://github.com/electron/electron/pull/54781)

- Fixed a crash with `app.setLoginItemSettings` if a non-UTF8 service name is used. [#52773](https://github.com/electron/electron/pull/52773)(Also in [42](https://github.com/electron/electron/pull/52989), [43](https://github.com/electron/electron/pull/52944), [44](https://github.com/electron/electron/pull/52801))

- Fixed a graphical glitch on Linux where thin borders appeared past the drop shadows on frameless windows when multiple windows were created. [#52584](https://github.com/electron/electron/pull/52584)(Also in [42](https://github.com/electron/electron/pull/52772), [43](https://github.com/electron/electron/pull/52607), [44](https://github.com/electron/electron/pull/52606))

- Fixed a grey border around frameless windows on Linux WMs without compositing. [#54392](https://github.com/electron/electron/pull/54392)(Also in [43](https://github.com/electron/electron/pull/54390), [44](https://github.com/electron/electron/pull/54391))

- Fixed a Linux crash creating a window with a menu bar when GTK failed to load. [#54846](https://github.com/electron/electron/pull/54846)(Also in [43](https://github.com/electron/electron/pull/54884), [44](https://github.com/electron/electron/pull/54859))

- Fixed a macOS File System Access blocklist bypass via `/System/Volumes/Data` paths. [#54678](https://github.com/electron/electron/pull/54678)

- Fixed a main process crash when a native API method was called with a `this` value of a different native type; it now throws a `TypeError`. [#54313](https://github.com/electron/electron/pull/54313)(Also in [43](https://github.com/electron/electron/pull/54316), [44](https://github.com/electron/electron/pull/54315))

- Fixed a main-process crash when an app called `loadURL()` again right after a load failed because the renderer process exited before the page committed. [#53942](https://github.com/electron/electron/pull/53942)(Also in [43](https://github.com/electron/electron/pull/53944), [44](https://github.com/electron/electron/pull/53943))

- Fixed a memory leak on Windows when `app.getPreferredSystemLanguages()` was called. [#53869](https://github.com/electron/electron/pull/53869)(Also in [43](https://github.com/electron/electron/pull/53867), [44](https://github.com/electron/electron/pull/53868))

- Fixed a memory leak when creating BrowserWindows. [#52092](https://github.com/electron/electron/pull/52092)(Also in [42](https://github.com/electron/electron/pull/52893), [43](https://github.com/electron/electron/pull/52892), [44](https://github.com/electron/electron/pull/52894))

- Fixed a pending read on a `net.request` chunked upload stream inside a protocol handler never settling when the request failed or was aborted. [#53368](https://github.com/electron/electron/pull/53368)(Also in [43](https://github.com/electron/electron/pull/53374), [44](https://github.com/electron/electron/pull/53373))

- Fixed a possible crash (SIGABRT) during process exit when the process had loaded `tls`/`https` shortly before exiting, affecting `app.exit()` before `ready` and short-lived `ELECTRON_RUN_AS_NODE` / `child_process.fork()` scripts. [#52856](https://github.com/electron/electron/pull/52856)(Also in [42](https://github.com/electron/electron/pull/52992), [43](https://github.com/electron/electron/pull/52870), [44](https://github.com/electron/electron/pull/52871))

- Fixed a possible crash during process exit when `vm.Script` or `vm` contexts created in the main process had been garbage collected shortly before quitting. [#54267](https://github.com/electron/electron/pull/54267)(Also in [43](https://github.com/electron/electron/pull/54268), [44](https://github.com/electron/electron/pull/54266))

- Fixed a possible crash on Windows on ARM when `powerMonitor` is torn down. [#54384](https://github.com/electron/electron/pull/54384)(Also in [44](https://github.com/electron/electron/pull/54408))

- Fixed a possible crash on Windows when a file dialog was shown for a window that was being closed at the same time. [#53586](https://github.com/electron/electron/pull/53586)(Also in [42](https://github.com/electron/electron/pull/53585), [43](https://github.com/electron/electron/pull/53584), [44](https://github.com/electron/electron/pull/53583))

- Fixed a possible hang when pressing Esc while a `<webview>` is fullscreen. [#53744](https://github.com/electron/electron/pull/53744)

- Fixed a possible main process crash at quit when a session was created from JavaScript that runs during shutdown. [#52836](https://github.com/electron/electron/pull/52836)(Also in [42](https://github.com/electron/electron/pull/53132), [43](https://github.com/electron/electron/pull/52925), [44](https://github.com/electron/electron/pull/52924))

- Fixed a potential crash during application shutdown. [#54526](https://github.com/electron/electron/pull/54526)

- Fixed a potential crash in `contentTracing.stopRecording()` when the trace file could not be written to the requested path. [#52793](https://github.com/electron/electron/pull/52793)(Also in [42](https://github.com/electron/electron/pull/52796), [43](https://github.com/electron/electron/pull/52795), [44](https://github.com/electron/electron/pull/52794))

- Fixed a potential crash when cleaning up download items. [#54517](https://github.com/electron/electron/pull/54517)

- Fixed a potential crash when closing detached DevTools. [#54538](https://github.com/electron/electron/pull/54538)

- Fixed a potential crash when notifying user activation before the primary main frame was live. [#52215](https://github.com/electron/electron/pull/52215)(Also in [42](https://github.com/electron/electron/pull/52699), [43](https://github.com/electron/electron/pull/52697), [44](https://github.com/electron/electron/pull/52698))

- Fixed a potential crash when using `menu.popup` with a frame from an offscreen rendered window. [#53242](https://github.com/electron/electron/pull/53242)(Also in [43](https://github.com/electron/electron/pull/53432), [44](https://github.com/electron/electron/pull/53362))

- Fixed a potential UAF in `app.getPreferredSystemLanguages()` on Windows. [#53864](https://github.com/electron/electron/pull/53864)(Also in [43](https://github.com/electron/electron/pull/53866), [44](https://github.com/electron/electron/pull/53865))

- Fixed a potential UAF when a `select-usb-device` handler destroys the requesting `webContents`. [#54008](https://github.com/electron/electron/pull/54008)(Also in [43](https://github.com/electron/electron/pull/54007), [44](https://github.com/electron/electron/pull/54009))

- Fixed a rare crash in the main process when DevTools were opened and a garbage collection ran before the DevTools frontend finished loading. [#52847](https://github.com/electron/electron/pull/52847)(Also in [42](https://github.com/electron/electron/pull/52994), [43](https://github.com/electron/electron/pull/52903), [44](https://github.com/electron/electron/pull/52904))

- Fixed a regression preventing from transparent frameless windows from being resized on Linux. [#52740](https://github.com/electron/electron/pull/52740)(Also in [43](https://github.com/electron/electron/pull/52947), [44](https://github.com/electron/electron/pull/52891))

- Fixed a regression where a window created with a custom title can show an empty title after using back/forward navigation. [#53180](https://github.com/electron/electron/pull/53180)(Also in [42](https://github.com/electron/electron/pull/53217), [43](https://github.com/electron/electron/pull/53219), [44](https://github.com/electron/electron/pull/53218))

- Fixed a renderer crash calling `image.toPNG()` from a sandboxed preload script. [#54501](https://github.com/electron/electron/pull/54501)(Also in [43](https://github.com/electron/electron/pull/54503), [44](https://github.com/electron/electron/pull/54502))

- Fixed a renderer crash that could occur when printing from an iframe. [#53763](https://github.com/electron/electron/pull/53763)(Also in [43](https://github.com/electron/electron/pull/53761), [44](https://github.com/electron/electron/pull/53762))

- Fixed a renderer crash when a page calls `SpeechRecognition.available()` or `SpeechRecognition.install()` with `processLocally`. [#52955](https://github.com/electron/electron/pull/52955)(Also in [42](https://github.com/electron/electron/pull/53016), [43](https://github.com/electron/electron/pull/53015), [44](https://github.com/electron/electron/pull/53021))

- Fixed a renderer crash when a `ResizeObserver` loop-limit error handler modified layout. [#54289](https://github.com/electron/electron/pull/54289)(Also in [42](https://github.com/electron/electron/pull/54610), [43](https://github.com/electron/electron/pull/54611), [44](https://github.com/electron/electron/pull/54290))

- Fixed a renderer crash when an array with a throwing property getter is passed across `contextBridge`, and several main/utility-process crashes when option objects passed to Electron APIs contain throwing accessors or Proxy traps. [#53069](https://github.com/electron/electron/pull/53069)(Also in [42](https://github.com/electron/electron/pull/53329), [43](https://github.com/electron/electron/pull/53330), [44](https://github.com/electron/electron/pull/53331))

- Fixed a renderer crash when an iframe was removed right after loading with `nodeIntegrationInSubFrames` enabled and `sandbox` disabled, e.g. on pages that embed Meta Pixel. [#53883](https://github.com/electron/electron/pull/53883)(Also in [42](https://github.com/electron/electron/pull/53886), [43](https://github.com/electron/electron/pull/53884), [44](https://github.com/electron/electron/pull/53885))

- Fixed a renderer crash when the main process sent IPC to, or a page navigated, a same-process `window.open()` child whose `contextIsolation` differed from its opener's. [#53538](https://github.com/electron/electron/pull/53538)(Also in [42](https://github.com/electron/electron/pull/53541), [43](https://github.com/electron/electron/pull/53540), [44](https://github.com/electron/electron/pull/53539))

- Fixed a spurious `node_init` error being logged when creating a `ShadowRealm` with Node.js integration enabled. [#53578](https://github.com/electron/electron/pull/53578)(Also in [44](https://github.com/electron/electron/pull/53579))

- Fixed a stale `nativeTheme.shouldUseDarkColors` after resetting `themeSource`. [#54648](https://github.com/electron/electron/pull/54648)

- Fixed a UAF with `protocol.registerStreamProtocol` when an error is emitted during a read. [#52474](https://github.com/electron/electron/pull/52474)(Also in [41](https://github.com/electron/electron/pull/52513), [42](https://github.com/electron/electron/pull/52516), [43](https://github.com/electron/electron/pull/52514), [44](https://github.com/electron/electron/pull/52515))

- Fixed a `WebContentsView` staying blank after its window is shown when `setBackgroundThrottling(false)` was called while the window was hidden. [#52844](https://github.com/electron/electron/pull/52844)(Also in [42](https://github.com/electron/electron/pull/52865), [43](https://github.com/electron/electron/pull/52864), [44](https://github.com/electron/electron/pull/52863))

- Fixed a window being marked hidden and background-throttled on macOS when covered by a transparent or click-through window. [#52365](https://github.com/electron/electron/pull/52365)(Also in [42](https://github.com/electron/electron/pull/52390), [43](https://github.com/electron/electron/pull/52389), [44](https://github.com/electron/electron/pull/52391))

- Fixed `accent-color-changed` on Windows reporting a colour that differed from `systemPreferences.getAccentColor()`. [#54405](https://github.com/electron/electron/pull/54405)(Also in [44](https://github.com/electron/electron/pull/54409))

- Fixed alignment of the text label and popup menu in the macOS save dialog. [#54144](https://github.com/electron/electron/pull/54144)(Also in [44](https://github.com/electron/electron/pull/54143))

- Fixed an "Invalid `guestInstanceId`" error when removing a loaded `<webview>` from the DOM. [#54096](https://github.com/electron/electron/pull/54096)(Also in [42](https://github.com/electron/electron/pull/54098), [43](https://github.com/electron/electron/pull/54097), [44](https://github.com/electron/electron/pull/54099))

- Fixed an intermittent crash (access violation) on Windows when an ASAR integrity violation is detected, so the process now exits with code 1 as intended. [#53438](https://github.com/electron/electron/pull/53438)(Also in [43](https://github.com/electron/electron/pull/53456), [44](https://github.com/electron/electron/pull/53455))

- Fixed an intermittent crash at startup on Linux caused by a race between Pango and the main thread initializing fontconfig. [#53338](https://github.com/electron/electron/pull/53338)(Also in [43](https://github.com/electron/electron/pull/53339), [44](https://github.com/electron/electron/pull/53340))

- Fixed an issue on Windows where the app process could fail to exit after `app.quit()` while a `shell.openExternal()` or `shell.openPath()` call was still waiting on a system "Open with" dialog. [#52888](https://github.com/electron/electron/pull/52888)(Also in [41](https://github.com/electron/electron/pull/52899), [43](https://github.com/electron/electron/pull/52897), [44](https://github.com/electron/electron/pull/52898))

- Fixed an issue where a JavaScript out-of-memory crash could be reported from inside the crash-key handler instead of at the out-of-memory site. [#52591](https://github.com/electron/electron/pull/52591)(Also in [42](https://github.com/electron/electron/pull/52723), [43](https://github.com/electron/electron/pull/52725), [44](https://github.com/electron/electron/pull/52724))

- Fixed an issue where an exception thrown by a property getter on an object passed through `contextBridge` was swallowed instead of being thrown back to the caller. [#53297](https://github.com/electron/electron/pull/53297)(Also in [43](https://github.com/electron/electron/pull/53334), [44](https://github.com/electron/electron/pull/53335))

- Fixed an issue where clicks posted to a background app were dropped on macOS. [#54818](https://github.com/electron/electron/pull/54818)(Also in [42](https://github.com/electron/electron/pull/54906), [43](https://github.com/electron/electron/pull/54905), [44](https://github.com/electron/electron/pull/54819))

- Fixed an issue where `crashReporter.setUploadToServer()` had no effect after `crashReporter.start()` was called. [#54519](https://github.com/electron/electron/pull/54519)(Also in [44](https://github.com/electron/electron/pull/54518))

- Fixed an issue where loading ICO files from ASAR archives on Windows left temporary icon files behind. [#52424](https://github.com/electron/electron/pull/52424)(Also in [42](https://github.com/electron/electron/pull/52479), [43](https://github.com/electron/electron/pull/52478), [44](https://github.com/electron/electron/pull/52477))

- Fixed an issue where notifications would sometimes not appear from certain long domains on Windows. [#54348](https://github.com/electron/electron/pull/54348)

- Fixed an issue where pages loaded in a detached `WebContentsView` wouldn't see the correct window size. [#53031](https://github.com/electron/electron/pull/53031)(Also in [42](https://github.com/electron/electron/pull/53151), [43](https://github.com/electron/electron/pull/53152), [44](https://github.com/electron/electron/pull/53153))

- Fixed an issue where some values passed into `requestSingleInstanceLock` could result in a crash. [#52025](https://github.com/electron/electron/pull/52025)(Also in [42](https://github.com/electron/electron/pull/52982), [43](https://github.com/electron/electron/pull/52471), [44](https://github.com/electron/electron/pull/52470))

- Fixed an issue where the browser-side check that blocks drag and drop between cross-site frames of the same page was disabled. [#53748](https://github.com/electron/electron/pull/53748)(Also in [43](https://github.com/electron/electron/pull/53750), [44](https://github.com/electron/electron/pull/53749))

- Fixed an `npm install` failure with no recovery path when the OS blocked the native zip extractor from loading (for example, Windows Smart App Control). [#52748](https://github.com/electron/electron/pull/52748)(Also in [43](https://github.com/electron/electron/pull/52845), [44](https://github.com/electron/electron/pull/52846))

- Fixed an uncatchable TypeError in `net.fetch` when receiving response headers with non-ASCII characters, and preserved multiple Set-Cookie headers. [#54671](https://github.com/electron/electron/pull/54671)(Also in [44](https://github.com/electron/electron/pull/54672))

- Fixed `app.disableHardwareAcceleration()` not fully disabling GPU hardware usage on Windows starting from Electron 38. [#51817](https://github.com/electron/electron/pull/51817)(Also in [41](https://github.com/electron/electron/pull/52368), [42](https://github.com/electron/electron/pull/52371), [43](https://github.com/electron/electron/pull/52369), [44](https://github.com/electron/electron/pull/52370))

- Fixed `app.getGPUInfo('complete')` stalling the GPU process for several seconds on some Windows systems. [#53645](https://github.com/electron/electron/pull/53645)(Also in [44](https://github.com/electron/electron/pull/53644))

- Fixed `app.getLoginItemSettings()` not finding login items on Windows when the executable path contains spaces. [#54419](https://github.com/electron/electron/pull/54419)

- Fixed `app.getRecentDocuments()` omitting documents with non-ASCII paths on Windows. [#54385](https://github.com/electron/electron/pull/54385)(Also in [44](https://github.com/electron/electron/pull/54407))

- Fixed application crash after a large number of IPC messages from renderers. [#53418](https://github.com/electron/electron/pull/53418)(Also in [42](https://github.com/electron/electron/pull/53419), [43](https://github.com/electron/electron/pull/53420), [44](https://github.com/electron/electron/pull/53417))

- Fixed asar archives in non-ASCII folders failing to load on Linux. [#54848](https://github.com/electron/electron/pull/54848)(Also in [44](https://github.com/electron/electron/pull/54849))

- Fixed `BrowserWindow` size corruption on Windows when created with explicit `x`/`y` on a secondary monitor whose DPI differs from the primary. [#51603](https://github.com/electron/electron/pull/51603)(Also in [42](https://github.com/electron/electron/pull/52500), [43](https://github.com/electron/electron/pull/52501), [44](https://github.com/electron/electron/pull/52499))

- Fixed `BrowserWindow.unmaximize()` and `restore()` having no effect on Wayland when the window was maximized immediately after creation. [#53063](https://github.com/electron/electron/pull/53063)(Also in [42](https://github.com/electron/electron/pull/53126), [43](https://github.com/electron/electron/pull/53125), [44](https://github.com/electron/electron/pull/53124))

- Fixed `chrome.tabs.query()` returning tab `url` and `title` to extensions without the `tabs` permission or host access, aligning with `tabs.get`. [#53353](https://github.com/electron/electron/pull/53353)(Also in [42](https://github.com/electron/electron/pull/53355), [43](https://github.com/electron/electron/pull/53356), [44](https://github.com/electron/electron/pull/53354))

- Fixed `clipboard.read()`, `readText()` and `has()` resolving seconds late on Linux while the app was idle. [#54307](https://github.com/electron/electron/pull/54307)(Also in [42](https://github.com/electron/electron/pull/54310), [43](https://github.com/electron/electron/pull/54309), [44](https://github.com/electron/electron/pull/54308))

- Fixed crash in sharedTexture module when GPU context becomes unavailable. [#49518](https://github.com/electron/electron/pull/49518)(Also in [42](https://github.com/electron/electron/pull/52983), [43](https://github.com/electron/electron/pull/52938), [44](https://github.com/electron/electron/pull/52926))

- Fixed crash triggered by replacing an open application menu. [#52248](https://github.com/electron/electron/pull/52248)(Also in [41](https://github.com/electron/electron/pull/52278), [42](https://github.com/electron/electron/pull/52275), [43](https://github.com/electron/electron/pull/52276), [44](https://github.com/electron/electron/pull/52277))

- Fixed crashes in `setDisplayMediaRequestHandler` when the granted frame had been destroyed or another tab was granted by id. [#53673](https://github.com/electron/electron/pull/53673)(Also in [42](https://github.com/electron/electron/pull/53674), [43](https://github.com/electron/electron/pull/53671), [44](https://github.com/electron/electron/pull/53672))

- Fixed crashes in sharedTexture, service-worker ipcRenderer and utilityProcess.fork() caused by object lifetime bugs. [#53280](https://github.com/electron/electron/pull/53280)(Also in [43](https://github.com/electron/electron/pull/53278), [44](https://github.com/electron/electron/pull/53279))

- Fixed crashes in the main process when a `webRequest.onBeforeRequest` listener redirected a CORS preflight request, and when calling `net.fetch()` with a `webRequest`-permission extension loaded. [#53302](https://github.com/electron/electron/pull/53302)(Also in [43](https://github.com/electron/electron/pull/53304), [44](https://github.com/electron/electron/pull/53303))

- Fixed crashes when a webContents or parent window is destroyed while other APIs still reference it. [#53281](https://github.com/electron/electron/pull/53281)(Also in [43](https://github.com/electron/electron/pull/53288), [44](https://github.com/electron/electron/pull/53287))

- Fixed crashes when certain app event handlers call back into Electron synchronously. [#53269](https://github.com/electron/electron/pull/53269)(Also in [43](https://github.com/electron/electron/pull/53276), [44](https://github.com/electron/electron/pull/53275))

- Fixed Ctrl+Y not yanking text killed with Ctrl+K in text fields on macOS. [#53715](https://github.com/electron/electron/pull/53715)(Also in [44](https://github.com/electron/electron/pull/53714))

- Fixed custom V8 snapshots (`electron-mksnapshot`, and the `loadBrowserProcessSpecificV8Snapshot` fuse) having no effect in the main process on macOS arm64, Linux x64 and Windows x64. [#52872](https://github.com/electron/electron/pull/52872)(Also in [42](https://github.com/electron/electron/pull/52876), [43](https://github.com/electron/electron/pull/52877), [44](https://github.com/electron/electron/pull/52878))

- Fixed default protocol client APIs falsely returning `true` on Windows. [#53958](https://github.com/electron/electron/pull/53958)(Also in [43](https://github.com/electron/electron/pull/53960), [44](https://github.com/electron/electron/pull/53959))

- Fixed `desktopCapturer.getSources()` leaving non-resizable windows resizable on macOS. [#54398](https://github.com/electron/electron/pull/54398)(Also in [43](https://github.com/electron/electron/pull/54396), [44](https://github.com/electron/electron/pull/54397))

- Fixed DevTools device metrics overrides persisting indefinitely when a remote debugging client disconnected without clearing them. [#52254](https://github.com/electron/electron/pull/52254)(Also in [42](https://github.com/electron/electron/pull/53133), [43](https://github.com/electron/electron/pull/52946), [44](https://github.com/electron/electron/pull/52930))

- Fixed DevTools popup and context menus not appearing when DevTools is hosted in a custom window via `webContents.setDevToolsWebContents()`. [#52205](https://github.com/electron/electron/pull/52205)(Also in [42](https://github.com/electron/electron/pull/52981), [43](https://github.com/electron/electron/pull/52937), [44](https://github.com/electron/electron/pull/52434))

- Fixed `dialog.showOpenDialog`/`dialog.showSaveDialog` opening at an unusable location on Linux when `defaultPath` is a bare filename without a directory. [#52243](https://github.com/electron/electron/pull/52243)(Also in [42](https://github.com/electron/electron/pull/52980), [43](https://github.com/electron/electron/pull/52401), [44](https://github.com/electron/electron/pull/52402))

- Fixed `Dirent.parentPath` being `undefined` for `fs.readdir`, `fs.readdirSync`, `fs.glob`, and `fs.globSync` with `withFileTypes: true` inside asar archives. [#51845](https://github.com/electron/electron/pull/51845)(Also in [42](https://github.com/electron/electron/pull/52506), [43](https://github.com/electron/electron/pull/52505), [44](https://github.com/electron/electron/pull/52507))

- Fixed downloading files that live inside an asar archive, including saving a packed PDF from the built-in PDF viewer. [#52808](https://github.com/electron/electron/pull/52808)(Also in [42](https://github.com/electron/electron/pull/52828), [43](https://github.com/electron/electron/pull/52826), [44](https://github.com/electron/electron/pull/52827))

- Fixed `fs.constants.O_DIRECTORY`, `O_NOFOLLOW` and `O_DIRECT` holding x86 values on Linux arm64 and armv7l, which made opening a directory fail with `EINVAL`, and made `require('trace_events')` behave the same on cross-compiled builds as on native ones. [#53321](https://github.com/electron/electron/pull/53321)(Also in [42](https://github.com/electron/electron/pull/53318), [43](https://github.com/electron/electron/pull/53319), [44](https://github.com/electron/electron/pull/53320))

- Fixed `fs.rmSync` failing to remove read-only files on Windows. [#54190](https://github.com/electron/electron/pull/54190)(Also in [42](https://github.com/electron/electron/pull/54257), [43](https://github.com/electron/electron/pull/54256), [44](https://github.com/electron/electron/pull/54255))

- Fixed `GDK_BACKEND` leaking into processes spawned by Electron apps on Linux. [#54424](https://github.com/electron/electron/pull/54424)(Also in [43](https://github.com/electron/electron/pull/54426), [44](https://github.com/electron/electron/pull/54425))

- Fixed `globalShortcut` not working on GNOME Wayland by enabling Chromium's `GlobalShortcutsPortalPreferredTrigger` feature by default on Linux. [#52221](https://github.com/electron/electron/pull/52221)(Also in [43](https://github.com/electron/electron/pull/52228))

- Fixed GPU shaders compiled by Skia not being cached between launches. [#54156](https://github.com/electron/electron/pull/54156)(Also in [44](https://github.com/electron/electron/pull/54161))

- Fixed helper executables on macOS starting a second app instance when launched without a process type, for example through `child_process.fork()` with the `runAsNode` fuse disabled; `fork()` now throws in that configuration. [#53839](https://github.com/electron/electron/pull/53839)(Also in [44](https://github.com/electron/electron/pull/53840))

- Fixed hidden windows continuing to render at full frame rate after `setBackgroundThrottling(false)` followed by `setBackgroundThrottling(true)`. [#54339](https://github.com/electron/electron/pull/54339)(Also in [44](https://github.com/electron/electron/pull/54341))

- Fixed interrupted macOS updates leaving a broken app behind. [#54843](https://github.com/electron/electron/pull/54843)(Also in [44](https://github.com/electron/electron/pull/54844))

- Fixed link-opened windows not using the opener's session and `webPreferences`. [#55051](https://github.com/electron/electron/pull/55051)(Also in [42](https://github.com/electron/electron/pull/55050), [43](https://github.com/electron/electron/pull/55049), [44](https://github.com/electron/electron/pull/55048))

- Fixed main process crashes when navigating to `http://accessibility/` or `http://devtools/`, when using the `LanguageModel` API from a Worker with a local AI handler registered, when an extension background page used `navigator.mediaDevices`, and when calling `SerialPort.forget()` for a disconnected device. [#53325](https://github.com/electron/electron/pull/53325)(Also in [43](https://github.com/electron/electron/pull/53332), [44](https://github.com/electron/electron/pull/53333))

- Fixed `matchMedia('(display-mode: ...)')` returning `browser` for window-controls-overlay, frameless, and fullscreen BrowserWindows. [#51396](https://github.com/electron/electron/pull/51396)

- Fixed mouse cursor missing over native dialogs in certain scenarios on Windows. [#54878](https://github.com/electron/electron/pull/54878)(Also in [44](https://github.com/electron/electron/pull/54987))

- Fixed native addons deriving from `node::ObjectWrap` aborting during garbage collection on Node.js 24.19.0 and later. [#53391](https://github.com/electron/electron/pull/53391)(Also in [42](https://github.com/electron/electron/pull/53394), [43](https://github.com/electron/electron/pull/53393), [44](https://github.com/electron/electron/pull/53392))

- Fixed `net.fetch` and `session.fetch` failing permanently with `net::ERR_FAILED` after the Network Service process restarts. [#54910](https://github.com/electron/electron/pull/54910)(Also in [42](https://github.com/electron/electron/pull/54925), [43](https://github.com/electron/electron/pull/54908), [44](https://github.com/electron/electron/pull/54909))

- Fixed `net.fetch()` / `net.request()` spending seconds of main-process time buffering large streamed request bodies. [#54062](https://github.com/electron/electron/pull/54062)(Also in [44](https://github.com/electron/electron/pull/54061))

- Fixed paste hanging indefinitely on Linux X11 until the app was restarted. [#54912](https://github.com/electron/electron/pull/54912)

- Fixed `pointerLock` permission requests from some iframes reporting the parent frame. [#54463](https://github.com/electron/electron/pull/54463)(Also in [42](https://github.com/electron/electron/pull/54466), [43](https://github.com/electron/electron/pull/54465), [44](https://github.com/electron/electron/pull/54464))

- Fixed `process.nextTick` and promise callbacks queued in `protocol`/`webRequest` handlers running at the wrong time. [#54301](https://github.com/electron/electron/pull/54301)

- Fixed `ready-to-show` never firing for some hidden windows on Windows and Linux. [#54110](https://github.com/electron/electron/pull/54110)(Also in [43](https://github.com/electron/electron/pull/54119), [44](https://github.com/electron/electron/pull/54118))

- Fixed region-qualified `--lang` values such as `de-DE` loading no locale resources on macOS, which left localized strings empty and could crash WebAuthn Touch ID prompts. [#53184](https://github.com/electron/electron/pull/53184)(Also in [42](https://github.com/electron/electron/pull/53187), [43](https://github.com/electron/electron/pull/53186), [44](https://github.com/electron/electron/pull/53188))

- Fixed `registerFileProtocol` and `registerHttpProtocol` returning readable responses to cross-origin `no-cors` fetches; they now return opaque responses like `protocol.handle`. [#52822](https://github.com/electron/electron/pull/52822)(Also in [41](https://github.com/electron/electron/pull/52854), [42](https://github.com/electron/electron/pull/52855), [43](https://github.com/electron/electron/pull/52853), [44](https://github.com/electron/electron/pull/52852))

- Fixed renderer crashes during garbage collection inside ShadowRealms. [#54864](https://github.com/electron/electron/pull/54864)(Also in [44](https://github.com/electron/electron/pull/54865))

- Fixed `select-hid-device` presenting HID devices that could not be granted, which caused `navigator.hid.requestDevice()` to resolve with no device. [#52467](https://github.com/electron/electron/pull/52467)(Also in [44](https://github.com/electron/electron/pull/52497))

- Fixed `session.setPermissionCheckHandler` receiving the top-level origin and a null `webContents` for `hid` and `usb` checks made from a subframe. [#53679](https://github.com/electron/electron/pull/53679)(Also in [42](https://github.com/electron/electron/pull/53736), [43](https://github.com/electron/electron/pull/53689), [44](https://github.com/electron/electron/pull/53688))

- Fixed `setCertificateVerifyProc` occasionally not being applied to a request issued concurrently with the first request to a host. [#55045](https://github.com/electron/electron/pull/55045)(Also in [42](https://github.com/electron/electron/pull/55054), [43](https://github.com/electron/electron/pull/55047), [44](https://github.com/electron/electron/pull/55046))

- Fixed `setContentProtection(true)` having no effect in Windows remote sessions. [#54499](https://github.com/electron/electron/pull/54499)(Also in [44](https://github.com/electron/electron/pull/54500))

- Fixed `setIgnoreMouseEvents()` taking effect late on X11. [#54496](https://github.com/electron/electron/pull/54496)(Also in [43](https://github.com/electron/electron/pull/54498), [44](https://github.com/electron/electron/pull/54497))

- Fixed `setIgnoreMouseEvents(true)` being undone by the next resize on X11. [#54394](https://github.com/electron/electron/pull/54394)(Also in [43](https://github.com/electron/electron/pull/54423), [44](https://github.com/electron/electron/pull/54393))

  - Added `setIgnoreMouseEvents` support on Wayland.
- Fixed several non-functional DevTools integrations: the Security panel's "View certificate" button, Ctrl+wheel zooming inside DevTools, and DevTools keyboard shortcuts (e.g. F8) while the inspected page has focus. [#53471](https://github.com/electron/electron/pull/53471)(Also in [43](https://github.com/electron/electron/pull/53631), [44](https://github.com/electron/electron/pull/53630))

- Fixed several object lifetime issues in `Debugger`, `Menu`, `Tray`, `Notification`, `globalShortcut`, `utilityProcess`, `ServiceWorkerMain`, `WebFrameMain`, `webFrame`, `sharedTexture`, `systemPreferences`, `netLog`, `MessagePortMain`, `net.request` and `shell.openPath()`. [#53805](https://github.com/electron/electron/pull/53805)(Also in [44](https://github.com/electron/electron/pull/53968))

- Fixed `shell.showItemInFolder()` on Linux for paths containing `#`, `?` or `%` when the file manager is reached over D-Bus. [#54386](https://github.com/electron/electron/pull/54386)(Also in [44](https://github.com/electron/electron/pull/54406))

- Fixed spellcheck not initializing on Linux when the dictionary was already cached from a previous run. [#52712](https://github.com/electron/electron/pull/52712)(Also in [43](https://github.com/electron/electron/pull/52717), [44](https://github.com/electron/electron/pull/52716))

- Fixed the built-in PDF viewer not rendering documents in in-memory sessions (partitions without the `persist:` prefix). [#52810](https://github.com/electron/electron/pull/52810)(Also in [42](https://github.com/electron/electron/pull/52990), [43](https://github.com/electron/electron/pull/52835), [44](https://github.com/electron/electron/pull/52834))

- Fixed the default action label on Linux notifications not being localized. [#54402](https://github.com/electron/electron/pull/54402)(Also in [43](https://github.com/electron/electron/pull/54400), [44](https://github.com/electron/electron/pull/54401))

- Fixed the GPU process being terminated in AppX/MSIX packaged apps on Windows when WebGPU fell back to SwiftShader. [#53174](https://github.com/electron/electron/pull/53174)(Also in [42](https://github.com/electron/electron/pull/53199), [43](https://github.com/electron/electron/pull/53197), [44](https://github.com/electron/electron/pull/53198))

- Fixed the GPU process crash-looping on Windows when the sandbox cannot read the install folder; the folder is now reported instead. [#54483](https://github.com/electron/electron/pull/54483)(Also in [43](https://github.com/electron/electron/pull/54485), [44](https://github.com/electron/electron/pull/54484))

- Fixed the PDF viewer failing to save an edited PDF with `NotAllowedError: Third party iframes are not allowed to show a file picker`. [#53326](https://github.com/electron/electron/pull/53326)(Also in [43](https://github.com/electron/electron/pull/53327), [44](https://github.com/electron/electron/pull/53328))

- Fixed the primary instance being killed or receiving truncated arguments when a second instance passed a very long command line or large `additionalData` to `app.requestSingleInstanceLock()`. [#52628](https://github.com/electron/electron/pull/52628)(Also in [42](https://github.com/electron/electron/pull/53157), [43](https://github.com/electron/electron/pull/53156), [44](https://github.com/electron/electron/pull/52950))

- Fixed the tray context menu not working for snap-confined apps because AppArmor blocked the `/org/chromium/DbusMenu` path. [#54102](https://github.com/electron/electron/pull/54102)(Also in [44](https://github.com/electron/electron/pull/54103))

- Fixed the zoom level resetting on `file:` and other host-less pages after a `location.hash` change. [#54441](https://github.com/electron/electron/pull/54441)(Also in [43](https://github.com/electron/electron/pull/54440), [44](https://github.com/electron/electron/pull/54442))

- Fixed `Tray` icons not appearing when running inside Flatpak or Snap sandboxes on Linux. [#53654](https://github.com/electron/electron/pull/53654)(Also in [44](https://github.com/electron/electron/pull/53653))

- Fixed typing not working after closing an `alert()` or `confirm()` on Windows. [#54460](https://github.com/electron/electron/pull/54460)(Also in [43](https://github.com/electron/electron/pull/54462), [44](https://github.com/electron/electron/pull/54461))

- Fixed `Uncaught illegal access` errors and renderer crashes when closing a same-process child window or removing an iframe with `nodeIntegrationInSubFrames` enabled, and when native modules use napi async work or thread-safe functions from such windows and frames. [#52964](https://github.com/electron/electron/pull/52964)(Also in [42](https://github.com/electron/electron/pull/53042), [43](https://github.com/electron/electron/pull/53041), [44](https://github.com/electron/electron/pull/53040))

- Fixed unnecessary autofill popup creation for fields without datalist suggestions, which could cause input latency on macOS. [#52262](https://github.com/electron/electron/pull/52262)(Also in [41](https://github.com/electron/electron/pull/52320), [42](https://github.com/electron/electron/pull/52319), [43](https://github.com/electron/electron/pull/52321), [44](https://github.com/electron/electron/pull/52318))

- Fixed utility process crashes at exit on Windows 11 24H2 and later. [#53038](https://github.com/electron/electron/pull/53038)(Also in [42](https://github.com/electron/electron/pull/53091), [43](https://github.com/electron/electron/pull/53092), [44](https://github.com/electron/electron/pull/53093))

- Fixed `utilityProcess` dropping messages posted with `process.parentPort.postMessage()` right before the process exits. [#54956](https://github.com/electron/electron/pull/54956)(Also in [42](https://github.com/electron/electron/pull/55000), [43](https://github.com/electron/electron/pull/54962))

- Fixed `utilityProcess` dropping `stdout`/`stderr` output that the child wrote immediately before exiting. [#54335](https://github.com/electron/electron/pull/54335)(Also in [42](https://github.com/electron/electron/pull/54332), [43](https://github.com/electron/electron/pull/54279), [44](https://github.com/electron/electron/pull/54278))

- Fixed V8 code caching for https scripts loaded by `file://` and custom-scheme pages. [#53746](https://github.com/electron/electron/pull/53746)(Also in [44](https://github.com/electron/electron/pull/53745))

- Fixed visual zoom limits resetting on navigation and not applying to webviews. [#54438](https://github.com/electron/electron/pull/54438)(Also in [43](https://github.com/electron/electron/pull/54450), [44](https://github.com/electron/electron/pull/54449))

- Fixed WebAssembly modules loaded from the code cache crashing or throwing `RuntimeError: unreachable` after updating between certain patch releases. [#54237](https://github.com/electron/electron/pull/54237)(Also in [42](https://github.com/electron/electron/pull/54239), [43](https://github.com/electron/electron/pull/54238), [44](https://github.com/electron/electron/pull/54246))

- Fixed WebAuthn platform passkey requests on macOS hanging until the request timeout when an operation failed, and a potential crash when selecting between Touch ID and platform passkeys. [#52682](https://github.com/electron/electron/pull/52682)

- Fixed `webContents` emitting `unresponsive` right after the system wakes from sleep on Windows, and emitting `responsive` when a hung window was hidden rather than when it recovered. [#53760](https://github.com/electron/electron/pull/53760)(Also in [44](https://github.com/electron/electron/pull/53764))

- Fixed `webContents.capturePage()` on offscreen windows returning an image resampled to the display's scale factor instead of rendered at the window's `offscreen.deviceScaleFactor`. [#53817](https://github.com/electron/electron/pull/53817)(Also in [43](https://github.com/electron/electron/pull/53818), [44](https://github.com/electron/electron/pull/53816))

- Fixed `webContents.executeJavaScript()` with `userGesture` set not granting browser-side user activation, which could make activation-gated APIs fail. [#54959](https://github.com/electron/electron/pull/54959)

- Fixed `webContents.executeJavaScriptInIsolatedWorld` resolving with `undefined` when `worldId` was not an integer. [#53205](https://github.com/electron/electron/pull/53205)(Also in [43](https://github.com/electron/electron/pull/53237), [44](https://github.com/electron/electron/pull/53238))

- Fixed `webContents.on()`, `removeListener()` and `removeAllListeners()` throwing "Object has been destroyed" for `console-message` listeners after the WebContents was destroyed. [#53495](https://github.com/electron/electron/pull/53495)(Also in [42](https://github.com/electron/electron/pull/53497), [43](https://github.com/electron/electron/pull/53496), [44](https://github.com/electron/electron/pull/53494))

- Fixed `webContents.print()` honoring `printBackground`, `duplexMode`, and printer default duplex settings. [#52279](https://github.com/electron/electron/pull/52279)(Also in [42](https://github.com/electron/electron/pull/53158), [43](https://github.com/electron/electron/pull/53160), [44](https://github.com/electron/electron/pull/53159))

- Fixed `webview.findInPage()` hanging when the host page also has an iframe. [#54585](https://github.com/electron/electron/pull/54585)(Also in [43](https://github.com/electron/electron/pull/54584), [44](https://github.com/electron/electron/pull/54586))

- Fixed `win.isFullScreen()` being stale in fullscreen events on Windows. [#55008](https://github.com/electron/electron/pull/55008)(Also in [44](https://github.com/electron/electron/pull/55009))

- Fixed `win.setEnabled(false)` and modal child windows not blocking input on Wayland. [#54448](https://github.com/electron/electron/pull/54448)(Also in [43](https://github.com/electron/electron/pull/54446), [44](https://github.com/electron/electron/pull/54447))

- Fixed Window Controls Overlay caption buttons not rendering on Linux. [#52577](https://github.com/electron/electron/pull/52577)(Also in [44](https://github.com/electron/electron/pull/52580))

- Fixed Window Controls Overlay CSS environment variables and `navigator.windowControlsOverlay` not being populated for `WebContentsView`s in a `BaseWindow`. [#53811](https://github.com/electron/electron/pull/53811)(Also in [44](https://github.com/electron/electron/pull/53812))

- Fixed window state not being persisted when a window entered or left fullscreen, or was maximized or unmaximized, without also being moved or resized. [#53577](https://github.com/electron/electron/pull/53577)(Also in [44](https://github.com/electron/electron/pull/53576))

- Fixed windows native message boxes being dismissed by other applications using invalid button ID. [#52812](https://github.com/electron/electron/pull/52812)(Also in [43](https://github.com/electron/electron/pull/53155), [44](https://github.com/electron/electron/pull/53154))

- Fixed windows opened by a sandboxed top-level frame not inheriting the opener's sandbox restrictions. [#52841](https://github.com/electron/electron/pull/52841)(Also in [41](https://github.com/electron/electron/pull/52849), [42](https://github.com/electron/electron/pull/52850), [43](https://github.com/electron/electron/pull/52848), [44](https://github.com/electron/electron/pull/52851))

- Fixed zoom in/out getting stuck after zooming past the 25%-500% range. [#54395](https://github.com/electron/electron/pull/54395)(Also in [43](https://github.com/electron/electron/pull/54422), [44](https://github.com/electron/electron/pull/54421))

  - Fixed `setVisualZoomLevelLimits()` shrinking pages when the minimum is under 1.
- Fixed webContents.print() returning "Invalid printer settings" when print options are provided. [#52367](https://github.com/electron/electron/pull/52367)(Also in [43](https://github.com/electron/electron/pull/52381), [44](https://github.com/electron/electron/pull/52382))

- Fixeed document title updates when using back/forward navigation using the same document without utilizing `browserWindow.setTitle()`. [#52089](https://github.com/electron/electron/pull/52089)(Also in [42](https://github.com/electron/electron/pull/53099), [43](https://github.com/electron/electron/pull/53023), [44](https://github.com/electron/electron/pull/52968))

- `getUserMedia` with `chromeMediaSource: 'desktop'` no longer accepts WebContents source ids; use `chromeMediaSource: 'tab'` with `webContents.getMediaSourceId()` or `setDisplayMediaRequestHandler` to capture a WebContents. [#53708](https://github.com/electron/electron/pull/53708)(Also in [42](https://github.com/electron/electron/pull/53710), [43](https://github.com/electron/electron/pull/53707), [44](https://github.com/electron/electron/pull/53709))

- Internal `<webview>`, `window.close()` and `executeJavaScript` reply IPCs are validated against the sending frame. [#53724](https://github.com/electron/electron/pull/53724)(Also in [42](https://github.com/electron/electron/pull/53727), [43](https://github.com/electron/electron/pull/53726), [44](https://github.com/electron/electron/pull/53723))

- `nodeIntegrationInWorker` now applies only to workers created by frames that themselves have Node integration; enable `nodeIntegrationInSubFrames` to keep Node in workers created by subframes. [#53706](https://github.com/electron/electron/pull/53706)(Also in [42](https://github.com/electron/electron/pull/53713), [43](https://github.com/electron/electron/pull/53712), [44](https://github.com/electron/electron/pull/53711))

- `openExternal` permission requests started by a frame that has since gone away are attributed to that frame's origin rather than to the navigating page. [#53696](https://github.com/electron/electron/pull/53696)(Also in [42](https://github.com/electron/electron/pull/53697), [43](https://github.com/electron/electron/pull/53698), [44](https://github.com/electron/electron/pull/53699))

- `pointerLock` and `keyboardLock` permission requests now report the requesting frame, and `execCommand('paste')` requires user activation in the frame that calls it. [#53692](https://github.com/electron/electron/pull/53692)(Also in [42](https://github.com/electron/electron/pull/53702), [43](https://github.com/electron/electron/pull/53701), [44](https://github.com/electron/electron/pull/53693))

- Reduced the cost of calling native methods and properties on `BrowserWindow`, `BaseWindow`, `WebContents`, `WebFrameMain` and `View` from JavaScript. [#54359](https://github.com/electron/electron/pull/54359)

  - Fixed `BaseWindow.setBounds()` throwing when given a partial bounds object.

  - Improved the performance of `app.getName()`, `app.name`, `app.getVersion()` and `app.getAppPath()`.

## Performance Improvements

- Fixed a stall of tens of milliseconds while creating the first `BrowserWindow` on Linux. [#52923](https://github.com/electron/electron/pull/52923)(Also in [42](https://github.com/electron/electron/pull/53019), [43](https://github.com/electron/electron/pull/53018), [44](https://github.com/electron/electron/pull/53017))

  - Improved the performance of file lookups inside ASAR archives and of large files served from them to the renderer.

  - Improved the performance of calls through `contextBridge`-exposed APIs.

  - Improved the performance of `Buffer.allocUnsafe()` and of large file reads in the main and utility processes.

  - Reduced the main-thread cost of sending large values through `ipcRenderer`, `ipcMain` handlers and `webContents.send`.
- Fixed the app becoming unresponsive when a page has a very large number of `app-region` draggable elements. [#53596](https://github.com/electron/electron/pull/53596)(Also in [43](https://github.com/electron/electron/pull/53632), [44](https://github.com/electron/electron/pull/53597))

- Improved application startup time on Linux by skipping GDK's OpenGL probe and loading FontConfig off the main thread during toolkit initialization. [#53070](https://github.com/electron/electron/pull/53070)(Also in [43](https://github.com/electron/electron/pull/53108), [44](https://github.com/electron/electron/pull/53107))

- Improved cold-launch time on macOS by prefetching Electron's framework files. [#54528](https://github.com/electron/electron/pull/54528)

- Improved startup time of `utilityProcess.fork()`, `child_process.fork()` / `ELECTRON_RUN_AS_NODE` child processes and Node.js-enabled renderers. [#52873](https://github.com/electron/electron/pull/52873)(Also in [42](https://github.com/electron/electron/pull/53136), [43](https://github.com/electron/electron/pull/53135), [44](https://github.com/electron/electron/pull/53134))

- Improved the error message when an asar integrity check fails to name the entry that failed. [#52600](https://github.com/electron/electron/pull/52600)(Also in [42](https://github.com/electron/electron/pull/52623), [43](https://github.com/electron/electron/pull/52622), [44](https://github.com/electron/electron/pull/52624))

- Improved the performance of APIs that return rectangles, sizes, points and display objects. [#54213](https://github.com/electron/electron/pull/54213)(Also in [44](https://github.com/electron/electron/pull/54215))

- Improved the performance of building and showing menus. [#53914](https://github.com/electron/electron/pull/53914)

- Improved the performance of `fs` operations and `require()` on files inside asar archives. [#53919](https://github.com/electron/electron/pull/53919)(Also in [44](https://github.com/electron/electron/pull/54051))

- Improved the performance of `session.getUserAgent()`. [#54245](https://github.com/electron/electron/pull/54245)(Also in [44](https://github.com/electron/electron/pull/54244))

- Improved throughput of responses that `protocol.handle` handlers return straight from `net.fetch`. [#53379](https://github.com/electron/electron/pull/53379)(Also in [44](https://github.com/electron/electron/pull/53378))

- Page resources, `fetch()` calls and file:// loads in renderers no longer wait for the main process to be idle when no `webRequest` listeners or protocol interceptors are registered. [#53115](https://github.com/electron/electron/pull/53115)(Also in [42](https://github.com/electron/electron/pull/53143), [43](https://github.com/electron/electron/pull/53142), [44](https://github.com/electron/electron/pull/53141))

- Reduced idle main-process CPU wakeups caused by Node.js timers and immediates. [#52862](https://github.com/electron/electron/pull/52862)(Also in [43](https://github.com/electron/electron/pull/52905), [44](https://github.com/electron/electron/pull/52906))

- Reduced the macOS distribution size by shipping only the locale strings that Electron can actually use. [#52290](https://github.com/electron/electron/pull/52290)

- Renderer network requests no longer waited on the main process when the session's `webRequest` listeners only observe requests (`onCompleted`, `onErrorOccurred`, `onSendHeaders`, `onBeforeRedirect`, `onResponseStarted`) or are filtered to other resource types. [#53204](https://github.com/electron/electron/pull/53204)(Also in [44](https://github.com/electron/electron/pull/53240))

- The first sandboxed `BrowserWindow` now starts in a renderer process launched ahead of time when the default session already exists, shortening the time from window creation to the page's first script; apps that open many windows can keep a spare renderer warm at all times with `--enable-features=SpareRendererForSitePerProcess`. [#53116](https://github.com/electron/electron/pull/53116)(Also in [44](https://github.com/electron/electron/pull/53144))


## Other Changes

- Backported fix from upstream V8. [#53987](https://github.com/electron/electron/pull/53987)

- Backported fixes from upstream ANGLE, Chromium, PDFium and V8. [#54220](https://github.com/electron/electron/pull/54220)

- Backported fixes from upstream ANGLE, Chromium, PDFium and V8. [#54897](https://github.com/electron/electron/pull/54897)

- Backported fixes from upstream ANGLE, Chromium, Skia and V8. [#53983](https://github.com/electron/electron/pull/53983)

- Backported fixes from upstream Chromium and V8. [#53765](https://github.com/electron/electron/pull/53765)

- Backported fixes from upstream Chromium and WebRTC. [#54656](https://github.com/electron/electron/pull/54656)

- Backported fixes from upstream Chromium, PDFium and V8. [#54084](https://github.com/electron/electron/pull/54084)

- Backported fixes from upstream Chromium, PDFium, Skia and V8. [#55145](https://github.com/electron/electron/pull/55145)

- Backported fixes from upstream Chromium, V8 and WebRTC. [#54664](https://github.com/electron/electron/pull/54664)

- Backported fixes from upstream Chromium. [#55031](https://github.com/electron/electron/pull/55031)

- Deprecated the synchronous `safeStorage.isEncryptionAvailable()`, `safeStorage.encryptString()` and `safeStorage.decryptString()` in favor of `isAsyncEncryptionAvailable()`, `encryptStringAsync()` and `decryptStringAsync()`. [#53850](https://github.com/electron/electron/pull/53850)

- Electron's internal JavaScript bundles are no longer listed in `require('module').builtinModules` or loadable through `process.getBuiltinModule()`. [#53624](https://github.com/electron/electron/pull/53624)

- Linux arm64, Windows arm64 and macOS x64 builds now start the main process from the embedded Node.js startup snapshot like the other platforms, improving startup time. [#52874](https://github.com/electron/electron/pull/52874)(Also in [42](https://github.com/electron/electron/pull/52880), [43](https://github.com/electron/electron/pull/52881), [44](https://github.com/electron/electron/pull/52879))

- None (reverts an unreleased change). [#52323](https://github.com/electron/electron/pull/52323)

- Refactored mouse forwarding on Windows to fix `setIgnoreMouseEvents(true, { forward: true })` related issues. [#54803](https://github.com/electron/electron/pull/54803)(Also in [44](https://github.com/electron/electron/pull/54802))

- The non-functional dummy libEGL.so and libGLESv2.so files are no longer included in the Linux distribution, now that ANGLE is statically linked. [#52226](https://github.com/electron/electron/pull/52226)(Also in [44](https://github.com/electron/electron/pull/52227))


## Documentation

- Documentation changes: [#52337](https://github.com/electron/electron/pull/52337), [#53170](https://github.com/electron/electron/pull/53170), [#53202](https://github.com/electron/electron/pull/53202), [#54343](https://github.com/electron/electron/pull/54343), [#54588](https://github.com/electron/electron/pull/54588), [#54882](https://github.com/electron/electron/pull/54882)


## Notices

### End of Support for 42.x.y

Electron 42.x.y has reached end-of-support as per the project's [support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines#version-support-policy). Developers and applications are encouraged to upgrade to a newer version of Electron.