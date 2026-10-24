Source: https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md
Title: electron/docs/api/app.md at v45.0.0 · electron/electron · GitHub
Fetched: 2026-10-24T19:33:02.506Z

[Skip to content](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#start-of-content)

You signed in with another tab or window. [Reload](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md) to refresh your session.You signed out in another tab or window. [Reload](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md) to refresh your session.You switched accounts on another tab or window. [Reload](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md) to refresh your session.Dismiss alert

{{ message }}

## Collapse file tree

## Files

View file on default branch

v45.0.0

Search this repository(forward slash)` forward slash/`

/

# app.md

Copy path

Blame

More file actions

Blame

More file actions

## Latest commit

![MarshallOfSound](https://avatars.githubusercontent.com/u/6634592?v=4&size=40)![claude](https://avatars.githubusercontent.com/u/81847?v=4&size=40)

[MarshallOfSound](https://github.com/electron/electron/commits?author=MarshallOfSound)

and

[claude](https://github.com/electron/electron/commits?author=claude)

[feat: add app shims on macOS (](https://github.com/electron/electron/commit/0399edbe6aa8a3add4cd7a31b063f84721085ede) [#55072](https://github.com/electron/electron/pull/55072) [)](https://github.com/electron/electron/commit/0399edbe6aa8a3add4cd7a31b063f84721085ede)

Open commit detailsfailure

last weekOct 17, 2026

[0399edb](https://github.com/electron/electron/commit/0399edbe6aa8a3add4cd7a31b063f84721085ede) · last weekOct 17, 2026

## History

[History](https://github.com/electron/electron/commits/v45.0.0/docs/api/app.md)

Open commit details

[View commit history for this file.](https://github.com/electron/electron/commits/v45.0.0/docs/api/app.md) History

2073 lines (1502 loc) · 84.9 KB

/

# app.md

Copy path

Top

## File metadata and controls

- Preview

- Code

- Blame


2073 lines (1502 loc) · 84.9 KB

[Raw](https://github.com/electron/electron/raw/refs/tags/v45.0.0/docs/api/app.md)

Copy raw file

Download raw file

Outline

Edit and raw actions

# app

[Permalink: app](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#app)

> Control your application's event lifecycle.

Process: [Main](https://github.com/electron/electron/blob/v45.0.0/docs/glossary.md#main-process)

The following example shows how to quit the application when the last window is
closed:

```
const { app } = require('electron')

app.on('window-all-closed', () => {
  app.quit()
})
```

## Events

[Permalink: Events](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#events)

The `app` object emits the following events:

### Event: 'will-finish-launching'

[Permalink: Event: 'will-finish-launching'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-will-finish-launching)

Emitted when the application has finished basic startup. On Windows and Linux,
the `will-finish-launching` event is the same as the `ready` event; on macOS,
this event represents the `applicationWillFinishLaunching` notification of
`NSApplication`.

In most cases, you should do everything in the `ready` event handler.

### Event: 'ready'

[Permalink: Event: 'ready'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-ready)

Returns:

- `event` Event
- `launchInfo` Record<string, any> \| [NotificationResponse](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/notification-response.md) _macOS_

Emitted once, when Electron has finished initializing. On macOS, `launchInfo`
holds the `userInfo` of the [`NSUserNotification`](https://developer.apple.com/documentation/foundation/nsusernotification)
or information from [`UNNotificationResponse`](https://developer.apple.com/documentation/usernotifications/unnotificationresponse)
that was used to open the application, if it was launched from Notification Center.
You can also call `app.isReady()` to check if this event has already fired and `app.whenReady()`
to get a Promise that is fulfilled when Electron is initialized.

Note

The `ready` event is only fired after the main process has finished running the first
tick of the event loop. If an Electron API needs to be called before the `ready` event, ensure
that it is called synchronously in the top-level context of the main process.

### Event: 'window-all-closed'

[Permalink: Event: 'window-all-closed'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-window-all-closed)

Emitted when all windows have been closed.

If you do not subscribe to this event and all windows are closed, the default
behavior is to quit the app; however, if you subscribe, you control whether the
app quits or not. If the user pressed `Cmd + Q`, or the developer called
`app.quit()`, Electron will first try to close all the windows and then emit the
`will-quit` event, and in this case the `window-all-closed` event would not be
emitted.

### Event: 'before-quit'

[Permalink: Event: 'before-quit'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-before-quit)

Returns:

- `event` Event

Emitted before the application starts closing its windows.
Calling `event.preventDefault()` will prevent the default behavior, which is
terminating the application.

Note

If application quit was initiated by `autoUpdater.quitAndInstall()`,
then `before-quit` is emitted _after_ emitting `close` event on all windows and
closing them.

Note

On Windows, this event will not be emitted if the app is closed due
to a shutdown/restart of the system or a user logout.

### Event: 'will-quit'

[Permalink: Event: 'will-quit'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-will-quit)

Returns:

- `event` Event

Emitted when all windows have been closed and the application will quit.
Calling `event.preventDefault()` will prevent the default behavior, which is
terminating the application.

See the description of the `window-all-closed` event for the differences between
the `will-quit` and `window-all-closed` events.

Note

On Windows, this event will not be emitted if the app is closed due
to a shutdown/restart of the system or a user logout.

### Event: 'quit'

[Permalink: Event: 'quit'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-quit)

Returns:

- `event` Event
- `exitCode` Integer

Emitted when the application is quitting.

Note

On Windows, this event will not be emitted if the app is closed due
to a shutdown/restart of the system or a user logout.

### Event: 'open-file' _macOS_

[Permalink: Event: 'open-file' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-open-file-macos)

Returns:

- `event` Event
- `path` string

Emitted when the user wants to open a file with the application. The `open-file`
event is usually emitted when the application is already open and the OS wants
to reuse the application to open the file. `open-file` is also emitted when a
file is dropped onto the dock and the application is not yet running. Make sure
to listen for the `open-file` event very early in your application startup to
handle this case (even before the `ready` event is emitted).

You should call `event.preventDefault()` if you want to handle this event.

On Windows, you have to parse `process.argv` (in the main process) to get the
filepath.

### Event: 'open-url' _macOS_

[Permalink: Event: 'open-url' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-open-url-macos)

Returns:

- `event` Event
- `url` string

Emitted when the user wants to open a URL with the application. Your application's
`Info.plist` file must define the URL scheme within the `CFBundleURLTypes` key, and
set `NSPrincipalClass` to `AtomApplication`.

As with the `open-file` event, be sure to register a listener for the `open-url`
event early in your application startup to detect if the application is being opened to handle a URL.
If you register the listener in response to a `ready` event, you'll miss URLs that trigger the launch of your application.

### Event: 'activate' _macOS_

[Permalink: Event: 'activate' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-activate-macos)

Returns:

- `event` Event
- `hasVisibleWindows` boolean

Emitted when the application is activated. Various actions can trigger
this event, such as launching the application for the first time, attempting
to re-launch the application when it's already running, or clicking on the
application's dock or taskbar icon.

### Event: 'app-shim-connected' _macOS_ _Experimental_

[Permalink: Event: 'app-shim-connected' macOSExperimental](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-app-shim-connected-macos-experimental)

Returns:

- `event` Event
- `shim` [AppShimHost](https://github.com/electron/electron/blob/v45.0.0/docs/api/app-shim-host.md)

Emitted when an app shim connects to your app. Shims can only connect after
[`app.startAppShimServer()`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appstartappshimserveroptions-macos-experimental)
has been called.

Any process running as the same user can connect. Verify the shim before
creating windows in it, for example with
[`shim.satisfiesCodeRequirement()`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app-shim-host.md#shimsatisfiescoderequirementrequirement-experimental),
and call `shim.quit()` to reject a shim that you do not trust.

### Event: 'app-shim-version-mismatch' _macOS_ _Experimental_

[Permalink: Event: 'app-shim-version-mismatch' macOSExperimental](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-app-shim-version-mismatch-macos-experimental)

Returns:

- `event` Event
- `bundlePath` string - The path of the app shim's bundle.

Emitted when an app shim was launched but could not connect because your app's
bundle has been replaced by a different version since your app started. A shim
loads the version of Electron that is on disk, which cannot communicate with
the version that is still running.

The shim quits without showing any UI, so use this event to tell the user what
happened. Shims can connect again after your app restarts.

```
const { app, dialog } = require('electron')

app.on('app-shim-version-mismatch', async () => {
  const { response } = await dialog.showMessageBox({
    message: `Restart ${app.name} to finish updating`,
    buttons: ['Restart', 'Later']
  })
  if (response === 0) {
    app.relaunch()
    app.quit()
  }
})
```

### Event: 'did-become-active' _macOS_

[Permalink: Event: 'did-become-active' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-did-become-active-macos)

Returns:

- `event` Event

Emitted when the application becomes active. This differs from the `activate` event in
that `did-become-active` is emitted every time the app becomes active, not only
when Dock icon is clicked or application is re-launched. It is also emitted when a user
switches to the app via the macOS App Switcher.

### Event: 'did-resign-active' _macOS_

[Permalink: Event: 'did-resign-active' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-did-resign-active-macos)

Returns:

- `event` Event

Emitted when the app is no longer active and doesn’t have focus. This can be triggered,
for example, by clicking on another application or by using the macOS App Switcher to
switch to another application.

### Event: 'continue-activity' _macOS_

[Permalink: Event: 'continue-activity' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-continue-activity-macos)

Returns:

- `event` Event
- `type` string - A string identifying the activity. Maps to
[`NSUserActivity.activityType`](https://developer.apple.com/library/ios/documentation/Foundation/Reference/NSUserActivity_Class/index.html#//apple_ref/occ/instp/NSUserActivity/activityType).
- `userInfo` unknown - Contains app-specific state stored by the activity on
another device.
- `details`Object

  - `webpageURL` string (optional) - A string identifying the URL of the webpage accessed by the activity on another device, if available.

Emitted during [Handoff](https://developer.apple.com/library/ios/documentation/UserExperience/Conceptual/Handoff/HandoffFundamentals/HandoffFundamentals.html) when an activity from a different device wants
to be resumed. You should call `event.preventDefault()` if you want to handle
this event.

A user activity can be continued only in an app that has the same developer Team
ID as the activity's source app and that supports the activity's type.
Supported activity types are specified in the app's `Info.plist` under the
`NSUserActivityTypes` key.

### Event: 'will-continue-activity' _macOS_

[Permalink: Event: 'will-continue-activity' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-will-continue-activity-macos)

Returns:

- `event` Event
- `type` string - A string identifying the activity. Maps to
[`NSUserActivity.activityType`](https://developer.apple.com/library/ios/documentation/Foundation/Reference/NSUserActivity_Class/index.html#//apple_ref/occ/instp/NSUserActivity/activityType).

Emitted during [Handoff](https://developer.apple.com/library/ios/documentation/UserExperience/Conceptual/Handoff/HandoffFundamentals/HandoffFundamentals.html) before an activity from a different device wants
to be resumed. You should call `event.preventDefault()` if you want to handle
this event.

### Event: 'continue-activity-error' _macOS_

[Permalink: Event: 'continue-activity-error' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-continue-activity-error-macos)

Returns:

- `event` Event
- `type` string - A string identifying the activity. Maps to
[`NSUserActivity.activityType`](https://developer.apple.com/library/ios/documentation/Foundation/Reference/NSUserActivity_Class/index.html#//apple_ref/occ/instp/NSUserActivity/activityType).
- `error` string - A string with the error's localized description.

Emitted during [Handoff](https://developer.apple.com/library/ios/documentation/UserExperience/Conceptual/Handoff/HandoffFundamentals/HandoffFundamentals.html) when an activity from a different device
fails to be resumed.

### Event: 'activity-was-continued' _macOS_

[Permalink: Event: 'activity-was-continued' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-activity-was-continued-macos)

Returns:

- `event` Event
- `type` string - A string identifying the activity. Maps to
[`NSUserActivity.activityType`](https://developer.apple.com/library/ios/documentation/Foundation/Reference/NSUserActivity_Class/index.html#//apple_ref/occ/instp/NSUserActivity/activityType).
- `userInfo` unknown - Contains app-specific state stored by the activity.

Emitted during [Handoff](https://developer.apple.com/library/ios/documentation/UserExperience/Conceptual/Handoff/HandoffFundamentals/HandoffFundamentals.html) after an activity from this device was successfully
resumed on another one.

### Event: 'update-activity-state' _macOS_

[Permalink: Event: 'update-activity-state' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-update-activity-state-macos)

Returns:

- `event` Event
- `type` string - A string identifying the activity. Maps to
[`NSUserActivity.activityType`](https://developer.apple.com/library/ios/documentation/Foundation/Reference/NSUserActivity_Class/index.html#//apple_ref/occ/instp/NSUserActivity/activityType).
- `userInfo` unknown - Contains app-specific state stored by the activity.

Emitted when [Handoff](https://developer.apple.com/library/ios/documentation/UserExperience/Conceptual/Handoff/HandoffFundamentals/HandoffFundamentals.html) is about to be resumed on another device. If you need to update the state to be transferred, you should call `event.preventDefault()` immediately, construct a new `userInfo` dictionary and call `app.updateCurrentActivity()` in a timely manner. Otherwise, the operation will fail and `continue-activity-error` will be called.

### Event: 'new-window-for-tab' _macOS_

[Permalink: Event: 'new-window-for-tab' macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-new-window-for-tab-macos)

Returns:

- `event` Event

Emitted when the user clicks the native macOS new tab button. The new
tab button is only visible if the current `BrowserWindow` has a
`tabbingIdentifier`.

You must create a window in this handler in order for macOS tabbing to work as expected.

### Event: 'browser-window-blur'

[Permalink: Event: 'browser-window-blur'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-browser-window-blur)

Returns:

- `event` Event
- `window` [BrowserWindow](https://github.com/electron/electron/blob/v45.0.0/docs/api/browser-window.md)

Emitted when a [browserWindow](https://github.com/electron/electron/blob/v45.0.0/docs/api/browser-window.md) gets blurred.

### Event: 'browser-window-focus'

[Permalink: Event: 'browser-window-focus'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-browser-window-focus)

Returns:

- `event` Event
- `window` [BrowserWindow](https://github.com/electron/electron/blob/v45.0.0/docs/api/browser-window.md)

Emitted when a [browserWindow](https://github.com/electron/electron/blob/v45.0.0/docs/api/browser-window.md) gets focused.

### Event: 'browser-window-created'

[Permalink: Event: 'browser-window-created'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-browser-window-created)

Returns:

- `event` Event
- `window` [BrowserWindow](https://github.com/electron/electron/blob/v45.0.0/docs/api/browser-window.md)

Emitted when a new [browserWindow](https://github.com/electron/electron/blob/v45.0.0/docs/api/browser-window.md) is created.

### Event: 'web-contents-created'

[Permalink: Event: 'web-contents-created'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-web-contents-created)

Returns:

- `event` Event
- `webContents` [WebContents](https://github.com/electron/electron/blob/v45.0.0/docs/api/web-contents.md)

Emitted when a new [webContents](https://github.com/electron/electron/blob/v45.0.0/docs/api/web-contents.md) is created.

### Event: 'certificate-error'

[Permalink: Event: 'certificate-error'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-certificate-error)

Returns:

- `event` Event
- `webContents` [WebContents](https://github.com/electron/electron/blob/v45.0.0/docs/api/web-contents.md)
- `url` string
- `error` string - The error code
- `certificate` [Certificate](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/certificate.md)
- `callback`Function

  - `isTrusted` boolean - Whether to consider the certificate as trusted
- `isMainFrame` boolean

Emitted when failed to verify the `certificate` for `url`, to trust the
certificate you should prevent the default behavior with
`event.preventDefault()` and call `callback(true)`.

```
const { app } = require('electron')

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url === 'https://github.com') {
    // Verification logic.
    event.preventDefault()
    callback(true)
  } else {
    callback(false)
  }
})
```

### Event: 'select-client-certificate'

[Permalink: Event: 'select-client-certificate'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-select-client-certificate)

Returns:

- `event` Event
- `webContents` [WebContents](https://github.com/electron/electron/blob/v45.0.0/docs/api/web-contents.md) \| null
- `url` URL
- `certificateList` [Certificate\[\]](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/certificate.md)
- `callback`Function

  - `certificate` [Certificate](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/certificate.md) (optional)

Emitted when a client certificate is requested.

The `url` corresponds to the navigation entry requesting the client certificate
and `callback` can be called with an entry filtered from the list. Using
`event.preventDefault()` prevents the application from using the first
certificate from the store.

`webContents` is `null` when the request does not originate from a renderer
process, for example when using [`net.request`](https://github.com/electron/electron/blob/v45.0.0/docs/api/net.md#netrequestoptions) or
[`net.fetch`](https://github.com/electron/electron/blob/v45.0.0/docs/api/net.md#netfetchinput-init) in the main process, or from a
[utility process](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md) created with
`respondToAuthRequestsFromMainProcess: true`. For utility processes created
without that flag, `net` requests proceed without a client certificate and this
event is not emitted.

```
const { app } = require('electron')

app.on('select-client-certificate', (event, webContents, url, list, callback) => {
  event.preventDefault()
  callback(list[0])
})
```

### Event: 'login'

[Permalink: Event: 'login'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-login)

Returns:

- `event` Event
- `webContents` [WebContents](https://github.com/electron/electron/blob/v45.0.0/docs/api/web-contents.md) \| null
- `authenticationResponseDetails`Object

  - `url` URL
  - `pid` number
  - `isRequestForNavigation` boolean - Indicates whether the request is for a navigation.
  - `firstAuthAttempt` boolean - Indicates whether this is the first authentication attempt.
  - `responseHeaders` Record<string, string \| string\[\]> (optional) - The headers returned in the response.
- `authInfo`Object

  - `isProxy` boolean
  - `scheme` string
  - `host` string
  - `port` Integer
  - `realm` string
- `callback`Function

  - `username` string (optional)
  - `password` string (optional)

Emitted when `webContents` or [Utility process](https://github.com/electron/electron/blob/v45.0.0/docs/glossary.md#utility-process) wants to do basic auth.

The default behavior is to cancel all authentications. To override this you
should prevent the default behavior with `event.preventDefault()` and call
`callback(username, password)` with the credentials.

```
const { app } = require('electron')

app.on('login', (event, webContents, details, authInfo, callback) => {
  event.preventDefault()
  callback('username', 'secret')
})
```

If `callback` is called without a username or password, the authentication
request will be cancelled and the authentication error will be returned to the
page.

### Event: 'gpu-info-update'

[Permalink: Event: 'gpu-info-update'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-gpu-info-update)

Emitted whenever there is a GPU info update.

### Event: 'render-process-gone'

[Permalink: Event: 'render-process-gone'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-render-process-gone)

Returns:

- `event` Event
- `webContents` [WebContents](https://github.com/electron/electron/blob/v45.0.0/docs/api/web-contents.md)
- `details` [RenderProcessGoneDetails](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/render-process-gone-details.md)

Emitted when the renderer process unexpectedly disappears. This is normally
because it was crashed or killed.

### Event: 'child-process-gone'

[Permalink: Event: 'child-process-gone'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-child-process-gone)

Returns:

- `event` Event
- `details`Object

  - `type`string - Process type. One of the following values:

    - `Utility`
    - `Zygote`
    - `Sandbox helper`
    - `GPU`
    - `Pepper Plugin`
    - `Pepper Plugin Broker`
    - `Unknown`
  - `reason`string - The reason the child process is gone. Possible values:

    - `clean-exit` \- Process exited with an exit code of zero
    - `abnormal-exit` \- Process exited with a non-zero exit code
    - `killed` \- Process was sent a SIGTERM or otherwise killed externally
    - `crashed` \- Process crashed
    - `oom` \- Process ran out of memory
    - `launch-failed` \- Process never successfully launched
    - `integrity-failure` \- Windows code integrity checks failed
    - `memory-eviction` \- Process proactively terminated to prevent a future out-of-memory (OOM) situation
  - `exitCode` number - The exit code for the process
    (e.g. status from waitpid if on POSIX, from GetExitCodeProcess on Windows),
    unless `reason` is `launch-failed`, in which case `exitCode` will be a
    platform-specific launch failure error code.
  - `systemErrorCode` number (optional) _Windows_ \- The Windows system error
    code (`GetLastError()`) of the failed launch. Only set when `reason` is
    `launch-failed`.
  - `serviceName` string (optional) - The non-localized name of the process.
  - `name` string (optional) - The name of the process.
    Examples for utility: `Audio Service`, `Content Decryption Module Service`, `Network Service`, `Video Capture`, etc.

Emitted when the child process unexpectedly disappears. This is normally
because it was crashed or killed, or because it failed to launch. It does not
include renderer processes.

### Event: 'accessibility-support-changed' _macOS_ _Windows_

[Permalink: Event: 'accessibility-support-changed' macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-accessibility-support-changed-macos-windows)

Returns:

- `event` Event
- `accessibilitySupportEnabled` boolean - `true` when Chromium's accessibility
support is enabled, `false` otherwise.

Emitted when Chromium's accessibility support changes. This event fires when
assistive technologies, such as screen readers, are enabled or disabled.
See [https://www.chromium.org/developers/design-documents/accessibility](https://www.chromium.org/developers/design-documents/accessibility) for more
details.

### Event: 'session-created'

[Permalink: Event: 'session-created'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-session-created)

Returns:

- `session` [Session](https://github.com/electron/electron/blob/v45.0.0/docs/api/session.md)

Emitted when Electron has created a new `session`.

```
const { app } = require('electron')

app.on('session-created', (session) => {
  console.log(session)
})
```

### Event: 'second-instance'

[Permalink: Event: 'second-instance'](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-second-instance)

Returns:

- `event` Event
- `argv` string\[\] - An array of the second instance's command line arguments
- `workingDirectory` string - The second instance's working directory
- `additionalData` unknown - A JSON object of additional data passed from the second instance

This event will be emitted inside the primary instance of your application
when a second instance has been executed and calls `app.requestSingleInstanceLock()`.

`argv` is an Array of the second instance's command line arguments,
and `workingDirectory` is its current working directory. Usually
applications respond to this by making their primary window focused and
non-minimized.

Note

`argv` will not be exactly the same list of arguments as those passed
to the second instance. The order might change and additional arguments might be appended.
If you need to maintain the exact same arguments, it's advised to use `additionalData` instead.

Note

If the second instance is started by a different user than the first, the `argv` array will not include the arguments.

This event is guaranteed to be emitted after the `ready` event of `app`
gets emitted.

Note

Extra command line arguments might be added by Chromium,
such as `--original-process-start-time`.

## Methods

[Permalink: Methods](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#methods)

The `app` object has the following methods:

Note

Some methods are only available on specific operating systems and are
labeled as such.

### `app.quit()`

[Permalink: app.quit()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appquit)

Try to close all windows. The `before-quit` event will be emitted first. If all
windows are successfully closed, the `will-quit` event will be emitted and by
default the application will terminate.

This method guarantees that all `beforeunload` and `unload` event handlers are
correctly executed. It is possible that a window cancels the quitting by
returning `false` in the `beforeunload` event handler.

### `app.exit([exitCode])`

[Permalink: app.exit([exitCode])](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appexitexitcode)

- `exitCode` Integer (optional)

Exits immediately with `exitCode`. `exitCode` defaults to 0.

All windows will be closed immediately without asking the user, and the `before-quit`
and `will-quit` events will not be emitted.

### `app.relaunch([options])`

[Permalink: app.relaunch([options])](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#apprelaunchoptions)

- `options`Object (optional)

  - `args` string\[\] (optional)
  - `execPath` string (optional)

Relaunches the app when the current instance exits.

By default, the new instance will use the same working directory and command line
arguments as the current instance. When `args` is specified, the `args` will be
passed as the command line arguments instead. When `execPath` is specified, the
`execPath` will be executed for the relaunch instead of the current app.

Note that this method does not quit the app when executed. You have to call
`app.quit` or `app.exit` after calling `app.relaunch` to make the app restart.

When `app.relaunch` is called multiple times, multiple instances will be
started after the current instance exits.

An example of restarting the current instance immediately and adding a new command
line argument to the new instance:

```
const { app } = require('electron')

app.relaunch({ args: process.argv.slice(1).concat(['--relaunch']) })
app.exit(0)
```

### `app.isReady()`

[Permalink: app.isReady()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appisready)

Returns `boolean` \- `true` if Electron has finished initializing, `false` otherwise.
See also `app.whenReady()`.

### `app.whenReady()`

[Permalink: app.whenReady()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appwhenready)

Returns `Promise<void>` \- fulfilled when Electron is initialized.
May be used as a convenient alternative to checking `app.isReady()`
and subscribing to the `ready` event if the app is not ready yet.

### `app.focus([options])`

[Permalink: app.focus([options])](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appfocusoptions)

- `options`Object (optional)

  - `steal` boolean _macOS_ \- Make the receiver the active app even if another app is
    currently active.

On macOS, makes the application the active app. On Windows, focuses on the application's
first window. On Linux, either focuses on the first visible window (X11) or requests
focus but may instead show a notification or flash the app icon (Wayland).

You should seek to use the `steal` option as sparingly as possible.

### `app.isActive()` _macOS_

[Permalink: app.isActive()macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appisactive-macos)

Returns `boolean` \- `true` if the application is active (i.e. focused).

### `app.hide()` _macOS_

[Permalink: app.hide()macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#apphide-macos)

Hides all application windows without minimizing them.

### `app.isHidden()` _macOS_

[Permalink: app.isHidden()macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appishidden-macos)

Returns `boolean` \- `true` if the application—including all of its windows—is hidden (e.g. with `Command-H`), `false` otherwise.

### `app.show()` _macOS_

[Permalink: app.show()macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appshow-macos)

Shows application windows after they were hidden. Does not automatically focus
them.

### `app.setAppLogsPath([path])`

[Permalink: app.setAppLogsPath([path])](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetapplogspathpath)

- `path` string (optional) - A custom path for your logs. Must be absolute.

Sets or creates a directory your app's logs which can then be manipulated with `app.getPath()` or `app.setPath(pathName, newPath)`.

Calling `app.setAppLogsPath()` without a `path` parameter will result in this directory being set to `~/Library/Logs/YourAppName` on _macOS_, and inside the `userData` directory on _Linux_ and _Windows_.

### `app.getAppPath()`

[Permalink: app.getAppPath()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetapppath)

Returns `string` \- The current application directory.

### `app.getPath(name)`

[Permalink: app.getPath(name)](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetpathname)

- `name`string - You can request the following paths by the name:

  - `home` User's home directory.
  - `appData`Per-user application data directory, which by default points to:

    - `%APPDATA%` on Windows
    - `$XDG_CONFIG_HOME` or `~/.config` on Linux
    - `~/Library/Application Support` on macOS
  - `assets` The directory where app assets such as `resources.pak` are stored. By default this is the same as the folder containing the `exe` path. Available on Windows and Linux only.
  - `userData` The directory for storing your app's configuration files, which
    by default is the `appData` directory appended with your app's name. On
    Windows, the app's name must not contain [reserved filename characters](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetname).
    By convention files storing user data should be written to this directory, and
    it is not recommended to write large files here because some environments
    may backup this directory to cloud storage. It is recommended to store
    app-specific files within a subdirectory of `userData` (e.g.,
    `path.join(app.getPath('userData'), 'my-app-data')`) rather than directly
    in `userData` itself, to avoid naming conflicts with Chromium's own
    subdirectories (such as `Cache`, `GPUCache`, and `Local Storage`).
  - `sessionData` The directory for storing data generated by `Session`, such
    as localStorage, cookies, disk cache, downloaded dictionaries, network
    state, DevTools files and compiled GPU shaders. By default this points to
    `userData`. Chromium may
    write very large disk cache here, so if your app does not rely on browser
    storage like localStorage or cookies to save user data, it is recommended
    to set this directory to other locations to avoid polluting the `userData`
    directory.
  - `temp` Temporary directory.
  - `exe` The current executable file.
  - `module` The location of the Chromium module. By default this is synonymous with `exe`.
  - `desktop` The current user's Desktop directory.
  - `documents` Directory for a user's "My Documents".
  - `downloads` Directory for a user's downloads.
  - `music` Directory for a user's music.
  - `pictures` Directory for a user's pictures.
  - `videos` Directory for a user's videos.
  - `recent` Directory for the user's recent files (Windows only).
  - `logs` Directory for your app's log folder.
  - `crashDumps` Directory where crash dumps are stored. See
    [Crash Reporting](https://github.com/electron/electron/blob/v45.0.0/docs/tutorial/crash-reporting.md#what-happens-when-your-app-crashes).

Returns `string` \- A path to a special directory or file associated with `name`. On
failure, an `Error` is thrown.

If `app.getPath('logs')` is called without calling `app.setAppLogsPath()` being called first, a default log directory will be created equivalent to calling `app.setAppLogsPath()` without a `path` parameter.

### `app.getFileIcon(path[, options])`

[Permalink: app.getFileIcon(path[, options])](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetfileiconpath-options)

- `path` string
- `options`Object (optional)

  - `size`string

    - `small` \- 16x16
    - `normal` \- 32x32
    - `large` \- 48x48 on _Linux_, 32x32 on _Windows_, unsupported on _macOS_.

Returns `Promise<NativeImage>` \- fulfilled with the app's icon, which is a [NativeImage](https://github.com/electron/electron/blob/v45.0.0/docs/api/native-image.md).

Fetches a path's associated icon.

On _Windows_, there are 2 kinds of icons:

- Icons associated with certain file extensions, like `.mp3`, `.png`, etc.
- Icons inside the file itself, like `.exe`, `.dll`, `.ico`.

On _Linux_ and _macOS_, icons depend on the application associated with file mime type.

### `app.setPath(name, path)`

[Permalink: app.setPath(name, path)](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetpathname-path)

- `name` string
- `path` string

Overrides the `path` to a special directory or file associated with `name`.
If the path specifies a directory that does not exist, an `Error` is thrown.
In that case, the directory should be created with `fs.mkdirSync` or similar.

You can only override paths of a `name` defined in `app.getPath`.

By default, web pages' cookies and caches will be stored under the `sessionData`
directory. If you want to change this location, you have to override the
`sessionData` path before the `ready` event of the `app` module is emitted.

### `app.getVersion()`

[Permalink: app.getVersion()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetversion)

Returns `string` \- The version of the loaded application. If no version is found in the
application's `package.json` file, the version of the current bundle or
executable is returned.

### `app.getName()`

[Permalink: app.getName()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetname)

Returns `string` \- The current application's name, which is the name in the application's
`package.json` file.

Usually the `name` field of `package.json` is a short lowercase name, according
to the npm modules spec. You should usually also specify a `productName`
field, which is your application's full capitalized name, and which will be
preferred over `name` by Electron.

Electron uses the application's name to construct the default `userData` directory.
On Windows, neither `productName` nor `name` should contain the following special
characters, which cannot be used in directory or file names:
`<`, `>`, `:`, `"`, `\`, `/`, `|`, `?`, `*`. Using these characters in the application's
name can prevent Electron from creating the default `userData` directory and cause
the application to crash on startup.

### `app.setName(name)`

[Permalink: app.setName(name)](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetnamename)

- `name` string

Overrides the current application's name.

On Windows, avoid the [reserved filename characters](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetname) in `name`.

Note

This function overrides the name used internally by Electron; it does not affect the name that the OS uses.

### `app.setDesktopName(name)` _Linux_

[Permalink: app.setDesktopName(name)Linux](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetdesktopnamename-linux)

- `name` string - The `.desktop` filename (e.g. `'com.example.MyApp.desktop'`).

Sets the [`.desktop` filename](https://specifications.freedesktop.org/desktop-entry/latest/file-naming.html) on Linux.
This must match the base filename of the app's installed `.desktop` file. The `.desktop` suffix is optional.

The name (without the `.desktop` suffix) is the app's identity for Linux desktop integration.
It should be a reverse-DNS style ID such as `com.example.MyApp`, following the
[desktop entry naming conventions](https://specifications.freedesktop.org/desktop-entry/latest/file-naming.html).
This value is used as:

- the XDG application ID (`app_id`) on Wayland and `WM_CLASS` on X11, used to match the app's icon and window grouping.
- the app ID that `xdg-desktop-portal` reports to portal backends such as
[GlobalShortcuts](https://github.com/electron/electron/blob/v45.0.0/docs/api/global-shortcut.md).

Portals increasingly enforce this identity. If the name is not a valid reverse-DNS ID or does not match an
installed `.desktop` file:

- GNOME 50.0/50.1 (Ubuntu 26.04) rejects [`globalShortcut`](https://github.com/electron/electron/blob/v45.0.0/docs/api/global-shortcut.md) binds with
`org.freedesktop.portal.Error.NotAllowed` — with no error surfaced to the app (see
[#52218](https://github.com/electron/electron/issues/52218)).
- `xdg-desktop-portal` 1.21 and later refuses portal sessions for app IDs it cannot resolve to a `.desktop` file.

If this value is not set and `desktopName` is not present in `package.json`, Electron falls back to a lowercased,
hyphenated slug of the app's name (e.g. `My App` → `my-app.desktop`), which is unlikely to be a valid portal
identity — packaged apps should always set it explicitly.

This API must be called before the `ready` event. The value can also be set using `desktopName` in `package.json`.

### `app.getLocale()`

[Permalink: app.getLocale()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetlocale)

Returns `string` \- The current application locale, fetched using Chromium's `l10n_util` library.
Possible return values are documented [here](https://source.chromium.org/chromium/chromium/src/+/main:ui/base/l10n/l10n_util.cc).

To set the locale, you'll want to use a command line switch at app startup, which may be found [here](https://github.com/electron/electron/blob/v45.0.0/docs/api/command-line-switches.md).

Note

When distributing your packaged app, you have to also ship the
`locales` folder.

Note

This API must be called after the `ready` event is emitted.

Note

To see example return values of this API compared to other locale and language APIs, see [`app.getPreferredSystemLanguages()`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetpreferredsystemlanguages).

### `app.getLocaleCountryCode()`

[Permalink: app.getLocaleCountryCode()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetlocalecountrycode)

Returns `string` \- User operating system's locale two-letter [ISO 3166](https://www.iso.org/iso-3166-country-codes.html) country code. The value is taken from native OS APIs.

Note

When unable to detect locale country code, it returns empty string.

### `app.getSystemLocale()`

[Permalink: app.getSystemLocale()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetsystemlocale)

Returns `string` \- The current system locale. On Windows and Linux, it is fetched using Chromium's `i18n` library. On macOS, `[NSLocale currentLocale]` is used instead. To get the user's current system language, which is not always the same as the locale, it is better to use [`app.getPreferredSystemLanguages()`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetpreferredsystemlanguages).

Different operating systems also use the regional data differently:

- Windows 11 uses the regional format for numbers, dates, and times.
- macOS Monterey uses the region for formatting numbers, dates, times, and for selecting the currency symbol to use.

Therefore, this API can be used for purposes such as choosing a format for rendering dates and times in a calendar app, especially when the developer wants the format to be consistent with the OS.

Note

This API must be called after the `ready` event is emitted.

Note

To see example return values of this API compared to other locale and language APIs, see [`app.getPreferredSystemLanguages()`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetpreferredsystemlanguages).

### `app.getPreferredSystemLanguages()`

[Permalink: app.getPreferredSystemLanguages()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetpreferredsystemlanguages)

Returns `string[]` \- The user's preferred system languages from most preferred to least preferred, including the country codes if applicable. A user can modify and add to this list on Windows or macOS through the Language and Region settings.

The API uses `GlobalizationPreferences` (with a fallback to `GetSystemPreferredUILanguages`) on Windows, `\[NSLocale preferredLanguages\]` on macOS, and `g_get_language_names` on Linux.

This API can be used for purposes such as deciding what language to present the application in.

Here are some examples of return values of the various language and locale APIs with different configurations:

On Windows, given application locale is German, the regional format is Finnish (Finland), and the preferred system languages from most to least preferred are French (Canada), English (US), Simplified Chinese (China), Finnish, and Spanish (Latin America):

```
app.getLocale() // 'de'
app.getSystemLocale() // 'fi-FI'
app.getPreferredSystemLanguages() // ['fr-CA', 'en-US', 'zh-Hans-CN', 'fi', 'es-419']
```

On macOS, given the application locale is German, the region is Finland, and the preferred system languages from most to least preferred are French (Canada), English (US), Simplified Chinese, and Spanish (Latin America):

```
app.getLocale() // 'de'
app.getSystemLocale() // 'fr-FI'
app.getPreferredSystemLanguages() // ['fr-CA', 'en-US', 'zh-Hans-FI', 'es-419']
```

Both the available languages and regions and the possible return values differ between the two operating systems.

As can be seen with the example above, on Windows, it is possible that a preferred system language has no country code, and that one of the preferred system languages corresponds with the language used for the regional format. On macOS, the region serves more as a default country code: the user doesn't need to have Finnish as a preferred language to use Finland as the region, and the country code `FI` is used as the country code for preferred system languages that do not have associated countries in the language name.

### `app.addRecentDocument(path)` _macOS_ _Windows_

[Permalink: app.addRecentDocument(path)macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appaddrecentdocumentpath-macos-windows)

- `path` string

Adds `path` to the recent documents list.

This list is managed by the OS. On Windows, you can visit the list from the task
bar, and on macOS, you can visit it from dock menu.

### `app.clearRecentDocuments()` _macOS_ _Windows_

[Permalink: app.clearRecentDocuments()macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appclearrecentdocuments-macos-windows)

Clears the recent documents list.

### `app.getRecentDocuments()` _macOS_ _Windows_

[Permalink: app.getRecentDocuments()macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetrecentdocuments-macos-windows)

Returns `string[]` \- An array containing documents in the most recent documents list.

```
const { app } = require('electron')

const path = require('node:path')

const file = path.join(app.getPath('desktop'), 'foo.txt')
app.addRecentDocument(file)

const recents = app.getRecentDocuments()
console.log(recents) // ['/path/to/desktop/foo.txt'}\
```\
\
### `app.setAsDefaultProtocolClient(protocol[, path, args])`\
\
[Permalink: app.setAsDefaultProtocolClient(protocol[, path, args])](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetasdefaultprotocolclientprotocol-path-args)\
\
- `protocol` string - The name of your protocol, without `://`. For example,\
if you want your app to handle `electron://` links, call this method with\
`electron` as the parameter.\
- `path` string (optional) _Windows_ \- The path to the Electron executable.\
Defaults to `process.execPath`\
- `args` string\[\] (optional) _Windows_ \- Arguments passed to the executable.\
Defaults to an empty array\
\
Returns `boolean` \- Whether the call succeeded.\
\
Sets the current executable as the default handler for a protocol (aka URI\
scheme). It allows you to integrate your app deeper into the operating system.\
Once registered, all links with `your-protocol://` will be opened with the\
current executable. The whole link, including protocol, will be passed to your\
application as a parameter.\
\
Note\
\
On macOS, you can only register protocols that have been added to\
your app's `info.plist`, which cannot be modified at runtime. However, you can\
change the file during build time via [Electron Forge](https://www.electronforge.io/),\
[Electron Packager](https://github.com/electron/packager), or by editing `info.plist` with a text\
editor. Please refer to [Apple's documentation](https://developer.apple.com/library/ios/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html#//apple_ref/doc/uid/TP40009249-102207-TPXREF115) for details.\
\
Note\
\
In a Windows Store environment (when packaged as an `appx`) this API\
will return `true` for all calls but the registry key it sets won't be accessible\
by other applications. In order to register your Windows Store application\
as a default protocol handler you must [declare the protocol in your manifest](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap-protocol).\
\
The API uses the Windows Registry and `LSSetDefaultHandlerForURLScheme` internally.\
\
### `app.removeAsDefaultProtocolClient(protocol[, path, args])` _macOS_ _Windows_\
\
[Permalink: app.removeAsDefaultProtocolClient(protocol[, path, args])macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appremoveasdefaultprotocolclientprotocol-path-args-macos-windows)\
\
- `protocol` string - The name of your protocol, without `://`.\
- `path` string (optional) _Windows_ \- Defaults to `process.execPath`\
- `args` string\[\] (optional) _Windows_ \- Defaults to an empty array\
\
Returns `boolean` \- Whether the call succeeded.\
\
This method checks if the current executable as the default handler for a\
protocol (aka URI scheme). If so, it will remove the app as the default handler.\
\
### `app.isDefaultProtocolClient(protocol[, path, args])`\
\
[Permalink: app.isDefaultProtocolClient(protocol[, path, args])](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appisdefaultprotocolclientprotocol-path-args)\
\
- `protocol` string - The name of your protocol, without `://`.\
- `path` string (optional) _Windows_ \- Defaults to `process.execPath`\
- `args` string\[\] (optional) _Windows_ \- Defaults to an empty array\
\
Returns `boolean` \- Whether the current executable is the default handler for a\
protocol (aka URI scheme).\
\
Note\
\
On macOS, you can use this method to check if the app has been\
registered as the default protocol handler for a protocol. You can also verify\
this by checking `~/Library/Preferences/com.apple.LaunchServices.plist` on the\
macOS machine. Please refer to\
[Apple's documentation](https://developer.apple.com/documentation/coreservices/1441725-lscopydefaulthandlerforurlscheme?language=objc) for details.\
\
The API uses the Windows Registry and `LSCopyDefaultHandlerForURLScheme` internally.\
\
### `app.getApplicationNameForProtocol(url)`\
\
[Permalink: app.getApplicationNameForProtocol(url)](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetapplicationnameforprotocolurl)\
\
- `url` string - a URL with the protocol name to check. Unlike the other\
methods in this family, this accepts an entire URL, including `://` at a\
minimum (e.g. `https://`).\
\
Returns `string` \- Name of the application handling the protocol, or an empty\
string if there is no handler. For instance, if Electron is the default\
handler of the URL, this could be `Electron` on Windows and Mac. However,\
don't rely on the precise format which is not guaranteed to remain unchanged.\
Expect a different format on Linux, possibly with a `.desktop` suffix.\
\
This method returns the application name of the default handler for the protocol\
(aka URI scheme) of a URL.\
\
### `app.getApplicationInfoForProtocol(url)`\
\
[Permalink: app.getApplicationInfoForProtocol(url)](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetapplicationinfoforprotocolurl)\
\
- `url` string - a URL with the protocol name to check. Unlike the other\
methods in this family, this accepts an entire URL, including `://` at a\
minimum (e.g. `https://`).\
\
Returns `Promise<Object>` \- Resolve with an object containing the following:\
\
- `icon` NativeImage - the display icon of the app handling the protocol.\
- `path` string - installation path of the app handling the protocol.\
- `name` string - display name of the app handling the protocol.\
\
This method returns a promise that contains the application name, icon and path of the default handler for the protocol\
(aka URI scheme) of a URL.\
\
### `app.setUserTasks(tasks)` _Windows_\
\
[Permalink: app.setUserTasks(tasks)Windows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetusertaskstasks-windows)\
\
- `tasks` [Task\[\]](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/task.md) \- Array of `Task` objects\
\
Adds `tasks` to the [Tasks](https://learn.microsoft.com/en-us/windows/win32/shell/taskbar-extensions#tasks) category of the Jump List on Windows.\
\
`tasks` is an array of [`Task`](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/task.md) objects.\
\
Returns `boolean` \- Whether the call succeeded.\
\
Note\
\
If you'd like to customize the Jump List even more use\
`app.setJumpList(categories)` instead.\
\
### `app.getJumpListSettings()` _Windows_\
\
[Permalink: app.getJumpListSettings()Windows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetjumplistsettings-windows)\
\
Returns `Object`:\
\
- `minItems` Integer - The minimum number of items that will be shown in the\
Jump List (for a more detailed description of this value see the\
[MSDN docs](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-icustomdestinationlist-beginlist)).\
- `removedItems` [JumpListItem\[\]](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/jump-list-item.md) \- Array of `JumpListItem`\
objects that correspond to items that the user has explicitly removed from custom categories in the\
Jump List. These items must not be re-added to the Jump List in the **next**\
call to `app.setJumpList()`, Windows will not display any custom category\
that contains any of the removed items.\
\
### `app.setJumpList(categories)` _Windows_\
\
[Permalink: app.setJumpList(categories)Windows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetjumplistcategories-windows)\
\
- `categories` [JumpListCategory\[\]](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/jump-list-category.md) \| `null` \- Array of `JumpListCategory` objects.\
\
Returns `string`\
\
Sets or removes a custom Jump List for the application, and returns one of the\
following strings:\
\
- `ok` \- Nothing went wrong.\
- `error` \- One or more errors occurred, enable runtime logging to figure out\
the likely cause.\
- `invalidSeparatorError` \- An attempt was made to add a separator to a\
custom category in the Jump List. Separators are only allowed in the\
standard `Tasks` category.\
- `fileTypeRegistrationError` \- An attempt was made to add a file link to\
the Jump List for a file type the app isn't registered to handle.\
- `customCategoryAccessDeniedError` \- Custom categories can't be added to the\
Jump List due to user privacy or group policy settings.\
\
If `categories` is `null` the previously set custom Jump List (if any) will be\
replaced by the standard Jump List for the app (managed by Windows).\
\
Note\
\
If a `JumpListCategory` object has neither the `type` nor the `name`\
property set then its `type` is assumed to be `tasks`. If the `name` property\
is set but the `type` property is omitted then the `type` is assumed to be\
`custom`.\
\
Note\
\
Users can remove items from custom categories, and Windows will not\
allow a removed item to be added back into a custom category until **after**\
the next successful call to `app.setJumpList(categories)`. Any attempt to\
re-add a removed item to a custom category earlier than that will result in the\
entire custom category being omitted from the Jump List. The list of removed\
items can be obtained using `app.getJumpListSettings()`.\
\
Note\
\
The maximum length of a Jump List item's `description` property is\
260 characters. Beyond this limit, the item will not be added to the Jump\
List, nor will it be displayed.\
\
Here's a very simple example of creating a custom Jump List:\
\
```\
const { app } = require('electron')\
\
app.setJumpList([\
  {\
    type: 'custom',\
    name: 'Recent Projects',\
    items: [\
      { type: 'file', path: 'C:\\Projects\\project1.proj' },\
      { type: 'file', path: 'C:\\Projects\\project2.proj' }\
    ]\
  },\
  {\
    // has a name so `type` is assumed to be "custom"\
    name: 'Tools',\
    items: [\
      {\
        type: 'task',\
        title: 'Tool A',\
        program: process.execPath,\
        args: '--run-tool-a',\
        iconPath: process.execPath,\
        iconIndex: 0,\
        description: 'Runs Tool A'\
      },\
      {\
        type: 'task',\
        title: 'Tool B',\
        program: process.execPath,\
        args: '--run-tool-b',\
        iconPath: process.execPath,\
        iconIndex: 0,\
        description: 'Runs Tool B'\
      }\
    ]\
  },\
  { type: 'frequent' },\
  {\
    // has no name and no type so `type` is assumed to be "tasks"\
    items: [\
      {\
        type: 'task',\
        title: 'New Project',\
        program: process.execPath,\
        args: '--new-project',\
        description: 'Create a new project.'\
      },\
      { type: 'separator' },\
      {\
        type: 'task',\
        title: 'Recover Project',\
        program: process.execPath,\
        args: '--recover-project',\
        description: 'Recover Project'\
      }\
    ]\
  }\
])\
```\
\
### `app.requestSingleInstanceLock([additionalData])`\
\
[Permalink: app.requestSingleInstanceLock([additionalData])](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#apprequestsingleinstancelockadditionaldata)\
\
- `additionalData` Record<any, any> (optional) - A JSON object containing additional data to send to the first instance.\
\
Returns `boolean`\
\
The return value of this method indicates whether or not this instance of your\
application successfully obtained the lock. If it failed to obtain the lock,\
you can assume that another instance of your application is already running with\
the lock and exit immediately.\
\
I.e. This method returns `true` if your process is the primary instance of your\
application and your app should continue loading. It returns `false` if your\
process should immediately quit as it has sent its parameters to another\
instance that has already acquired the lock.\
\
On macOS, the system enforces single instance automatically when users try to open\
a second instance of your app in Finder, and the `open-file` and `open-url`\
events will be emitted for that. However when users start your app in command\
line, the system's single instance mechanism will be bypassed, and you have to\
use this method to ensure single instance.\
\
Note\
\
On macOS and Linux, the second instance's command line arguments and\
`additionalData` are sent to the primary instance in a single message that is\
limited to 32 MB. Larger messages are dropped: this method still returns\
`false`, but the primary instance does not emit `second-instance`.\
\
An example of activating the window of primary instance when a second instance\
starts:\
\
```\
const { app, BrowserWindow } = require('electron')\
\
let myWindow = null\
\
const additionalData = { myKey: 'myValue' }\
const gotTheLock = app.requestSingleInstanceLock(additionalData)\
\
if (!gotTheLock) {\
  app.quit()\
} else {\
  app.on('second-instance', (event, commandLine, workingDirectory, additionalData) => {\
    // Print out data received from the second instance.\
    console.log(additionalData)\
\
    // Someone tried to run a second instance, we should focus our window.\
    if (myWindow) {\
      if (myWindow.isMinimized()) myWindow.restore()\
      myWindow.focus()\
    }\
  })\
\
  app.whenReady().then(() => {\
    myWindow = new BrowserWindow({})\
    myWindow.loadURL('https://electronjs.org')\
  })\
}\
```\
\
### `app.hasSingleInstanceLock()`\
\
[Permalink: app.hasSingleInstanceLock()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#apphassingleinstancelock)\
\
Returns `boolean`\
\
This method returns whether or not this instance of your app is currently\
holding the single instance lock. You can request the lock with\
`app.requestSingleInstanceLock()` and release with\
`app.releaseSingleInstanceLock()`\
\
### `app.releaseSingleInstanceLock()`\
\
[Permalink: app.releaseSingleInstanceLock()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appreleasesingleinstancelock)\
\
Releases all locks that were created by `requestSingleInstanceLock`. This will\
allow multiple instances of the application to once again run side by side.\
\
### `app.setUserActivity(type, userInfo[, webpageURL])` _macOS_\
\
[Permalink: app.setUserActivity(type, userInfo[, webpageURL])macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetuseractivitytype-userinfo-webpageurl-macos)\
\
- `type` string - Uniquely identifies the activity. Maps to\
[`NSUserActivity.activityType`](https://developer.apple.com/library/ios/documentation/Foundation/Reference/NSUserActivity_Class/index.html#//apple_ref/occ/instp/NSUserActivity/activityType).\
- `userInfo` any - App-specific state to store for use by another device.\
- `webpageURL` string (optional) - The webpage to load in a browser if no suitable app is\
installed on the resuming device. The scheme must be `http` or `https`.\
\
Creates an `NSUserActivity` and sets it as the current activity. The activity\
is eligible for [Handoff](https://developer.apple.com/library/ios/documentation/UserExperience/Conceptual/Handoff/HandoffFundamentals/HandoffFundamentals.html) to another device afterward.\
\
### `app.getCurrentActivityType()` _macOS_\
\
[Permalink: app.getCurrentActivityType()macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetcurrentactivitytype-macos)\
\
Returns `string` \- The type of the currently running activity.\
\
### `app.invalidateCurrentActivity()` _macOS_\
\
[Permalink: app.invalidateCurrentActivity()macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appinvalidatecurrentactivity-macos)\
\
Invalidates the current [Handoff](https://developer.apple.com/library/ios/documentation/UserExperience/Conceptual/Handoff/HandoffFundamentals/HandoffFundamentals.html) user activity.\
\
### `app.resignCurrentActivity()` _macOS_\
\
[Permalink: app.resignCurrentActivity()macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appresigncurrentactivity-macos)\
\
Marks the current [Handoff](https://developer.apple.com/library/ios/documentation/UserExperience/Conceptual/Handoff/HandoffFundamentals/HandoffFundamentals.html) user activity as inactive without invalidating it.\
\
### `app.updateCurrentActivity(type, userInfo)` _macOS_\
\
[Permalink: app.updateCurrentActivity(type, userInfo)macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appupdatecurrentactivitytype-userinfo-macos)\
\
- `type` string - Uniquely identifies the activity. Maps to\
[`NSUserActivity.activityType`](https://developer.apple.com/library/ios/documentation/Foundation/Reference/NSUserActivity_Class/index.html#//apple_ref/occ/instp/NSUserActivity/activityType).\
- `userInfo` any - App-specific state to store for use by another device.\
\
Updates the current activity if its type matches `type`, merging the entries from\
`userInfo` into its current `userInfo` dictionary.\
\
### `app.setAppUserModelId(id)` _Windows_\
\
[Permalink: app.setAppUserModelId(id)Windows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetappusermodelidid-windows)\
\
- `id` string\
\
Changes the [Application User Model ID](https://learn.microsoft.com/en-us/windows/win32/shell/appids) to `id`.\
\
### `app.setToastActivatorCLSID(id)` _Windows_\
\
[Permalink: app.setToastActivatorCLSID(id)Windows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsettoastactivatorclsidid-windows)\
\
- `id` string\
\
Changes the [Toast Activator CLSID](https://learn.microsoft.com/en-us/windows/win32/properties/props-system-appusermodel-toastactivatorclsid) to `id`. If one is not set via this method, it will be randomly generated for the app.\
\
- The value must be a valid GUID/CLSID in one of the following forms:\
  - Canonical brace-wrapped: `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}` (preferred)\
  - Canonical without braces: `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` (braces will be added automatically)\
- Hex digits are case-insensitive.\
\
This method should be called early (before showing notifications) so the value is baked into the registration/shortcut. Supplying an empty string or an unparsable value throws and leaves the existing (or generated) CLSID unchanged. If this method is never called, a random CLSID is generated once per run and exposed via `app.toastActivatorCLSID`.\
\
### `app.setActivationPolicy(policy)` _macOS_\
\
[Permalink: app.setActivationPolicy(policy)macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetactivationpolicypolicy-macos)\
\
- `policy` string - Can be 'regular', 'accessory', or 'prohibited'.\
\
Sets the activation policy for a given app.\
\
Activation policy types:\
\
- 'regular' - The application is an ordinary app that appears in the Dock and may have a user interface.\
- 'accessory' - The application doesn’t appear in the Dock and doesn’t have a menu bar, but it may be activated programmatically or by clicking on one of its windows.\
- 'prohibited' - The application doesn’t appear in the Dock and may not create windows or be activated.\
\
### `app.startAppShimServer([options])` _macOS_ _Experimental_\
\
[Permalink: app.startAppShimServer([options])macOSExperimental](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appstartappshimserveroptions-macos-experimental)\
\
- `options`Object (optional)\
\
  - `name` string (optional) - A name for this server, which lets several\
    running copies of your app each have their own. It can only contain\
    letters, digits, `.`, `-` and `_`, and must match the\
    `ElectronAppShimServerName` of the shims that connect to it. Default is\
    `appshim`.\
\
Starts accepting connections from [app shims](https://github.com/electron/electron/blob/v45.0.0/docs/api/app-shim-host.md). An\
[`app-shim-connected`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-app-shim-connected-macos-experimental) event is\
emitted for each shim that connects.\
\
Throws if the server cannot be started, for example because another copy of\
your app has already started a server with the same `name`.\
\
This method can only be called after the app is ready. It is not available in\
Mac App Store builds.\
\
### `app.stopAppShimServer()` _macOS_ _Experimental_\
\
[Permalink: app.stopAppShimServer()macOSExperimental](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appstopappshimserver-macos-experimental)\
\
Stops accepting connections from app shims. Shims that have already connected\
stay connected.\
\
### `app.importCertificate(options, callback)` _Linux_\
\
[Permalink: app.importCertificate(options, callback)Linux](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appimportcertificateoptions-callback-linux)\
\
- `options`Object\
\
  - `certificate` string - Path for the pkcs12 file.\
  - `password` string - Passphrase for the certificate.\
- `callback`Function\
\
  - `result` Integer - Result of import.\
\
Imports the certificate in pkcs12 format into the platform certificate store.\
`callback` is called with the `result` of import operation, a value of `0`\
indicates success while any other value indicates failure according to Chromium [net\_error\_list](https://source.chromium.org/chromium/chromium/src/+/main:net/base/net_error_list.h).\
\
### `app.configureHostResolver(options)`\
\
[Permalink: app.configureHostResolver(options)](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appconfigurehostresolveroptions)\
\
- `options`Object\
\
  - `enableBuiltInResolver` boolean (optional) - Whether the built-in host\
    resolver is used in preference to getaddrinfo. When enabled, the built-in\
    resolver will attempt to use the system's DNS settings to do DNS lookups\
    itself. Enabled by default on macOS, disabled by default on Windows and\
    Linux.\
  - `enableHappyEyeballs` boolean (optional) - Whether the\
    [Happy Eyeballs V3](https://datatracker.ietf.org/doc/draft-pauly-happy-happyeyeballs-v3/) algorithm should be used in creating\
    network connections. When enabled, hostnames resolving to multiple IP\
    addresses will be attempted in parallel to have a chance at establishing a\
    connection more quickly.\
  - `secureDnsMode` string (optional) - Can be 'off', 'automatic' or 'secure'.\
    Configures the DNS-over-HTTP mode. When 'off', no DoH lookups will be\
    performed. When 'automatic', DoH lookups will be performed first if DoH is\
    available, and insecure DNS lookups will be performed as a fallback. When\
    'secure', only DoH lookups will be performed. Defaults to 'automatic'.\
  - `secureDnsServers` string\[\] (optional) - A list of DNS-over-HTTP\
    server templates. See [RFC8484 § 3](https://datatracker.ietf.org/doc/html/rfc8484#section-3) for details on the template format.\
    Most servers support the POST method; the template for such servers is\
    simply a URI. Note that for [some DNS providers](https://source.chromium.org/chromium/chromium/src/+/main:net/dns/public/doh_provider_entry.cc;l=31?q=%22DohProviderEntry::GetList()%22&ss=chromium%2Fchromium%2Fsrc), the\
    resolver will automatically upgrade to DoH unless DoH is explicitly\
    disabled, even if there are no DoH servers provided in this list.\
  - `enableAdditionalDnsQueryTypes` boolean (optional) - Controls whether additional DNS\
    query types, e.g. HTTPS (DNS type 65) will be allowed besides the\
    traditional A and AAAA queries when a request is being made via insecure\
    DNS. Has no effect on Secure DNS which always allows additional types.\
    Defaults to true.\
\
Configures host resolution (DNS and DNS-over-HTTPS). By default, the following\
resolvers will be used, in order:\
\
1. DNS-over-HTTPS, if the [DNS provider supports it](https://source.chromium.org/chromium/chromium/src/+/main:net/dns/public/doh_provider_entry.cc;l=31?q=%22DohProviderEntry::GetList()%22&ss=chromium%2Fchromium%2Fsrc), then\
2. the built-in resolver (enabled on macOS only by default), then\
3. the system's resolver (e.g. `getaddrinfo`).\
\
This can be configured to either restrict usage of non-encrypted DNS\
(`secureDnsMode: "secure"`), or disable DNS-over-HTTPS (`secureDnsMode: "off"`). It is also possible to enable or disable the built-in resolver.\
\
To disable insecure DNS, you can specify a `secureDnsMode` of `"secure"`. If you do\
so, you should make sure to provide a list of DNS-over-HTTPS servers to use, in\
case the user's DNS configuration does not include a provider that supports\
DoH.\
\
```\
const { app } = require('electron')\
\
app.whenReady().then(() => {\
  app.configureHostResolver({\
    secureDnsMode: 'secure',\
    secureDnsServers: ['https://cloudflare-dns.com/dns-query']\
  })\
})\
```\
\
This API must be called after the `ready` event is emitted.\
\
### `app.configureWebAuthn(options)` _macOS_\
\
[Permalink: app.configureWebAuthn(options)macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appconfigurewebauthnoptions-macos)\
\
- `options`Object\
\
  - `touchID` Object (optional) - Enables the Touch ID / Secure Enclave platform\
    authenticator for [Web Authentication](https://www.w3.org/TR/webauthn-2/)\
    requests.\
\
    - `keychainAccessGroup` string - The keychain access group that WebAuthn\
      credentials will be stored under. This value **must** also be present in\
      your app's `keychain-access-groups` code-signing entitlement, and is\
      typically of the form `<TEAM_ID>.<BUNDLE_ID>.webauthn`.\
    - `promptReason` string (optional) - Customizes the reason text shown in\
      the macOS Touch ID prompt. macOS renders the prompt as\
      `"<App Name>" is trying to <promptReason>`, so the value should be a\
      lowercase sentence fragment. An optional `$1` placeholder is replaced\
      with the relying party ID (e.g. `example.com`) of the request being\
      authenticated. Defaults to `verify your identity on $1`.\
  - `platformPasskeys` boolean (optional) - Enables passkeys via Apple's\
    `ASAuthorizationController`. When enabled, passkey operations present the\
    system credential provider sheet (iCloud Keychain, 1Password, Bitwarden,\
    etc.) and credentials sync across the user's devices. Defaults to `false`.\
    Passing `null`/`undefined` (or omitting the key) leaves the previous\
    setting unchanged.\
\
Configures platform authenticators for the Web Authentication API\
(`navigator.credentials.create()` / `navigator.credentials.get()`). Until this\
is called, `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`\
resolves to `false` and platform-authenticator requests are not serviced.\
\
When `touchID` is provided, WebAuthn credentials are stored in the macOS\
keychain and bound to this device's Secure Enclave. Electron automatically\
generates and persists a per- [`session`](https://github.com/electron/electron/blob/v45.0.0/docs/api/session.md) metadata secret so that\
credentials created in one partition are not visible to another.\
\
When `platformPasskeys` is `true`, passkey operations use Apple's\
`ASAuthorizationController` which delegates to the system's configured\
Credential Provider Extensions. This enables the same passkey experience as\
Safari — credentials are available across all devices signed into the same\
account. Unlike Touch ID credentials, platform passkeys are stored by the\
credential provider and scoped to the relying party, not to Electron: they are\
shared across all [`session`](https://github.com/electron/electron/blob/v45.0.0/docs/api/session.md) partitions and with any other app or\
browser associated with the same domain. Platform passkeys cannot serve\
cross-origin (iframe) requests; those requests are left to the other available\
authenticators (Touch ID supports iframes) and a warning is logged to the\
DevTools console. The `prf` and `largeBlob` WebAuthn extensions are not\
currently supported by this authenticator — `prf` inputs are ignored, and a\
`create()` call with `largeBlob: { support: 'required' }` fails.\
\
```\
const { app } = require('electron')\
\
app.configureWebAuthn({\
  touchID: {\
    keychainAccessGroup: 'A1B2C3D4E5.com.example.app.webauthn',\
    promptReason: 'sign in to $1'\
  },\
  platformPasskeys: true\
})\
```\
\
With the matching entitlements in your app's `entitlements.plist`:\
\
```\
<key>keychain-access-groups</key>\
<array>\
  <string>A1B2C3D4E5.com.example.app.webauthn</string>\
</array>\
```\
\
For platform passkeys, your app needs the Associated Domains entitlement plus an\
application identifier, both in the same `entitlements.plist`:\
\
```\
<key>com.apple.developer.associated-domains</key>\
<array>\
  <string>webcredentials:example.com</string>\
</array>\
<!-- Must match the App ID in your provisioning profile: <TEAM_ID>.<BUNDLE_ID>. -->\
<key>com.apple.application-identifier</key>\
<string>A1B2C3D4E5.com.example.app</string>\
```\
\
Listing these entitlements is **not** sufficient on its own — unlike most\
entitlements, `com.apple.developer.associated-domains` is _provisioning-profile_\
_backed_. For platform passkeys to work, **all** of the following must hold:\
\
- In the [Apple Developer portal](https://developer.apple.com/account/resources/identifiers/list),\
your App ID (`com.example.app`) has the **Associated Domains** capability\
enabled, and you have created a provisioning profile for that App ID.\
- That provisioning profile is **embedded in the built app bundle** at\
`Contents/embedded.provisionprofile`. This is what authorizes the\
associated-domains entitlement at runtime; without an embedded profile macOS\
silently ignores the `webcredentials` association and the request fails. (Xcode\
and [`@electron/osx-sign`](https://github.com/electron/osx-sign) embed the\
profile for you; if you sign manually, copy it into the bundle before signing.)\
- The app is signed (ad-hoc / unsigned builds do not qualify). Both distribution\
and development signing work — for development builds, use the developer-mode\
path described below.\
- `com.apple.application-identifier` matches the profile's App ID. Without it,\
`ASAuthorizationController` fails with "The calling process does not have an\
application identifier" — this is `ASAuthorizationError` code 1004.\
- The relying party's domain (`example.com` above) serves a valid\
[`apple-app-site-association`](https://developer.apple.com/documentation/xcode/supporting-associated-domains)\
file over HTTPS at `/.well-known/apple-app-site-association` containing a\
`webcredentials` entry whose `apps` array lists this app's\
`<TEAM_ID>.<BUNDLE_ID>`.\
- The relying party ID of each request matches that associated domain.\
\
If these aren't satisfied, `ASAuthorizationController` fails before it can\
present the passkey sheet. The request surfaces to the page as a bare\
`NotAllowedError` with no further detail (Electron logs an explanatory message\
to the DevTools console on this path). Because the association is domain-based,\
platform passkeys always require a real associated domain and its AASA file —\
there is no `localhost` rpId escape hatch as there is in browsers.\
\
To test against your domain with a development-signed build (before shipping a\
distribution profile), append `?mode=developer` to the entitlement value and\
enable developer mode on the machine with `swcutil developer-mode -e true`. This\
makes macOS fetch the AASA directly from the domain — bypassing Apple's CDN\
cache — and honor the association for a development-signed app. You still need\
the embedded development provisioning profile described above:\
\
```\
<key>com.apple.developer.associated-domains</key>\
<array>\
  <string>webcredentials:example.com?mode=developer</string>\
</array>\
```\
\
Note\
\
Because the request is fulfilled by the system credential provider (not a\
browser), the `clientDataJSON` returned to the page reports\
`origin: "https://<rpId>"` — the associated domain — rather than the page's\
own origin. Relying-party servers that enforce a strict `expectedOrigin`\
allowlist must include `https://<rpId>` for verification to succeed. This\
also means the relying party cannot distinguish which subdomain of the\
associated domain initiated the ceremony.\
\
Note\
\
Touch ID WebAuthn credentials are device-bound and are not synced via iCloud\
Keychain. They are only available on Macs with a Secure Enclave (Apple\
silicon, or Intel Macs with a T2 chip).\
\
### `app.disableHardwareAcceleration()`\
\
[Permalink: app.disableHardwareAcceleration()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appdisablehardwareacceleration)\
\
Disables hardware acceleration for current app.\
\
This method can only be called before app is ready.\
\
### `app.isHardwareAccelerationEnabled()`\
\
[Permalink: app.isHardwareAccelerationEnabled()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appishardwareaccelerationenabled)\
\
Returns `boolean` \- whether hardware acceleration is currently enabled.\
\
Note\
\
This information is only usable after the `gpu-info-update` event is emitted.\
\
### `app.disableDomainBlockingFor3DAPIs()`\
\
[Permalink: app.disableDomainBlockingFor3DAPIs()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appdisabledomainblockingfor3dapis)\
\
By default, Chromium disables 3D APIs (e.g. WebGL) until restart on a per\
domain basis if the GPU process crashes too frequently. This function\
disables that behavior.\
\
This method can only be called before app is ready.\
\
### `app.getAppMetrics()`\
\
[Permalink: app.getAppMetrics()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetappmetrics)\
\
Returns [`ProcessMetric[]`](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/process-metric.md): Array of `ProcessMetric` objects that correspond to memory and CPU usage statistics of all the processes associated with the app.\
\
Note\
\
`cpu.percentCPUUsage` and `cpu.idleWakeupsPerSecond` are averages over the time since\
the last call to `app.getAppMetrics()`, and each call starts a new measurement interval\
for every process at once. Other code in the main process, including dependencies, shares those\
intervals. See [`CPUUsage`](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/cpu-usage.md) for more details.\
\
### `app.getGPUFeatureStatus()`\
\
[Permalink: app.getGPUFeatureStatus()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetgpufeaturestatus)\
\
Returns [`GPUFeatureStatus`](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/gpu-feature-status.md) \- The Graphics Feature Status from `chrome://gpu/`.\
\
Note\
\
This information is only usable after the `gpu-info-update` event is emitted.\
\
### `app.getGPUInfo(infoType)`\
\
[Permalink: app.getGPUInfo(infoType)](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetgpuinfoinfotype)\
\
- `infoType` string - Can be `basic` or `complete`.\
\
Returns `Promise<unknown>`\
\
For `infoType` equal to `complete`:\
Promise is fulfilled with `Object` containing all the GPU Information as in [chromium's GPUInfo object](https://chromium.googlesource.com/chromium/src/+/4178e190e9da409b055e5dff469911ec6f6b716f/gpu/config/gpu_info.cc). This includes the version and driver information that's shown on `chrome://gpu` page.\
\
For `infoType` equal to `basic`:\
Promise is fulfilled with `Object` containing fewer attributes than when requested with `complete`. Here's an example of basic response:\
\
```\
{\
  auxAttributes: {\
    amdSwitchable: true,\
    canSupportThreadedTextureMailbox: false,\
    directComposition: false,\
    directRendering: true,\
    glResetNotificationStrategy: 0,\
    inProcessGpu: true,\
    initializationTime: 0,\
    jpegDecodeAcceleratorSupported: false,\
    optimus: false,\
    passthroughCmdDecoder: false,\
    sandboxed: false,\
    softwareRendering: false,\
    supportsOverlays: false,\
    videoDecodeAcceleratorFlags: 0\
  },\
  gpuDevice: [\
    { active: true, deviceId: 26657, vendorId: 4098 },\
    { active: false, deviceId: 3366, vendorId: 32902 }\
  ],\
  machineModelName: 'MacBookPro',\
  machineModelVersion: '11.5'\
}\
```\
\
Using `basic` should be preferred if only basic information like `vendorId` or `deviceId` is needed.\
\
Promise is rejected if the GPU is completely disabled, i.e. no hardware and software implementations are available.\
\
### `app.setBadgeCount([count])` _Linux_ _macOS_\
\
[Permalink: app.setBadgeCount([count])LinuxmacOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetbadgecountcount-linux-macos)\
\
- `count` Integer (optional) - If a value is provided, set the badge to the provided value otherwise, on macOS, display a plain white dot (e.g. unknown number of notifications). On Linux, if a value is not provided the badge will not display.\
\
Returns `boolean` \- Whether the call succeeded.\
\
Sets the counter badge for current app. Setting the count to `0` will hide the\
badge.\
\
On macOS, it shows on the Dock icon. On Linux, it shows on docks and taskbars that support the LauncherEntry D-Bus API,\
\
Note\
\
On Linux, the badge is associated with the app's `.desktop` file, so\
[`app.setDesktopName`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetdesktopnamename-linux) (or the `desktopName`\
field in `package.json`) must match the name of the app's actual `.desktop`\
file.\
\
Note\
\
On macOS, you need to ensure that your application has the permission\
to display notifications for this method to work.\
\
### `app.getBadgeCount()` _macOS_\
\
[Permalink: app.getBadgeCount()macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetbadgecount-macos)\
\
Returns `Integer` \- The current value displayed in the counter badge.\
\
### `app.getLoginItemSettings([options])` _macOS_ _Windows_\
\
[Permalink: app.getLoginItemSettings([options])macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetloginitemsettingsoptions-macos-windows)\
\
- `options`Object (optional)\
\
  - `type` string (optional) _macOS_ \- Can be `mainAppService`, `agentService`, `daemonService`, or `loginItemService`. Defaults to `mainAppService`. See [app.setLoginItemSettings](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetloginitemsettingssettings-macos-windows) for more information about each type.\
  - `serviceName` string (optional) _macOS_ \- The name of the service. Required if `type` is non-default.\
  - `path` string (optional) _Windows_ \- The executable path to compare against. Defaults to `process.execPath`.\
  - `args` string\[\] (optional) _Windows_ \- The command-line arguments to compare against. Defaults to an empty array.\
\
If you provided `path` and `args` options to `app.setLoginItemSettings`, then you\
need to pass the same arguments here for `openAtLogin` to be set correctly.\
\
Returns `Object`:\
\
- `openAtLogin` boolean - `true` if the app is set to open at login.\
- `wasOpenedAtLogin` boolean _macOS_ \- `true` if the app was opened at login automatically.\
- `status` string _macOS_ \- can be `not-registered`, `enabled`, `requires-approval`, or `not-found`.\
- `executableWillLaunchAtLogin` boolean _Windows_ \- `true` if app is set to open at login and its run key is not deactivated. This differs from `openAtLogin` as it ignores the `args` option, this property will be true if the given executable would be launched at login with **any** arguments.\
- `launchItems` Object\[\] _Windows_\
  - `name` string _Windows_ \- name value of a registry entry.\
  - `path` string _Windows_ \- The executable to an app that corresponds to a registry entry.\
  - `args` string\[\] _Windows_ \- the command-line arguments to pass to the executable.\
  - `scope` string _Windows_ \- can be `user` or `machine`. Indicates whether the registry entry is under `HKEY_CURRENT USER` or `HKEY_LOCAL_MACHINE`.\
  - `enabled` boolean _Windows_ \- `true` if the app registry key is startup approved and therefore shows as `enabled` in Task Manager and Windows settings.\
\
### `app.setLoginItemSettings(settings)` _macOS_ _Windows_\
\
[Permalink: app.setLoginItemSettings(settings)macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetloginitemsettingssettings-macos-windows)\
\
Important\
\
On macOS, your app should be [code signed and notarized](https://github.com/electron/electron/blob/v45.0.0/docs/tutorial/code-signing.md#macos-apis-that-require-code-signing)\
for login item settings to work reliably. When an app isn't packaged, code signed,\
and notarized, `openAtLogin` may silently fail to take effect.\
\
- `settings`Object\
\
  - `openAtLogin` boolean (optional) - `true` to open the app at login, `false` to remove\
    the app as a login item. Defaults to `false`.\
  - `type` string (optional) _macOS_ \- The type of service to add as a login item. Defaults to `mainAppService`.\
\
    - `mainAppService` \- The primary application.\
    - `agentService` \- The property list name for a launch agent. The property list name must correspond to a property list in the app’s `Contents/Library/LaunchAgents` directory.\
    - `daemonService` string (optional) _macOS_ \- The property list name for a launch agent. The property list name must correspond to a property list in the app’s `Contents/Library/LaunchDaemons` directory.\
    - `loginItemService` string (optional) _macOS_ \- The property list name for a login item service. The property list name must correspond to a property list in the app’s `Contents/Library/LoginItems` directory.\
  - `serviceName` string (optional) _macOS_ \- The name of the service. Required if `type` is non-default.\
  - `path` string (optional) _Windows_ \- The executable to launch at login.\
    Defaults to `process.execPath`.\
  - `args` string\[\] (optional) _Windows_ \- The command-line arguments to pass to\
    the executable. Defaults to an empty array. Take care to wrap paths in\
    quotes.\
  - `enabled` boolean (optional) _Windows_ \- `true` will change the startup approved registry key and `enable / disable` the App in Task Manager and Windows Settings.\
    Defaults to `true`.\
  - `name` string (optional) _Windows_ \- value name to write into registry. Defaults to the app's AppUserModelId().\
\
Set the app's login item settings.\
\
To work with Electron's `autoUpdater` on Windows, which uses [Squirrel](https://github.com/Squirrel/Squirrel.Windows),\
you'll want to set the launch path to your executable's name but a directory up, which is\
a stub application automatically generated by Squirrel which will automatically launch the\
latest version.\
\
```\
const { app } = require('electron')\
\
const path = require('node:path')\
\
const appFolder = path.dirname(process.execPath)\
const ourExeName = path.basename(process.execPath)\
const stubLauncher = path.resolve(appFolder, '..', ourExeName)\
\
app.setLoginItemSettings({\
  openAtLogin: true,\
  path: stubLauncher,\
  args: [\
    // You might want to pass a parameter here indicating that this\
    // app was launched via login, but you don't have to\
  ]\
})\
```\
\
For more information about setting different services as login items on macOS, see [`SMAppService`](https://developer.apple.com/documentation/servicemanagement/smappservice?language=objc).\
\
### `app.isAccessibilitySupportEnabled()` _macOS_ _Windows_\
\
[Permalink: app.isAccessibilitySupportEnabled()macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appisaccessibilitysupportenabled-macos-windows)\
\
Returns `boolean` \- `true` if Chromium's accessibility support is enabled,\
`false` otherwise. This API will return `true` if the use of assistive\
technologies, such as screen readers, has been detected. See\
[https://www.chromium.org/developers/design-documents/accessibility](https://www.chromium.org/developers/design-documents/accessibility) for more\
details.\
\
### `app.setAccessibilitySupportEnabled(enabled)` _macOS_ _Windows_\
\
[Permalink: app.setAccessibilitySupportEnabled(enabled)macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetaccessibilitysupportenabledenabled-macos-windows)\
\
- `enabled` boolean - Enable or disable [accessibility tree](https://developers.google.com/web/fundamentals/accessibility/semantics-builtin/the-accessibility-tree) rendering\
\
Manually enables Chromium's accessibility support, allowing to expose accessibility switch to users in application settings. See [Chromium's accessibility docs](https://www.chromium.org/developers/design-documents/accessibility) for more\
details. Disabled by default.\
\
This API must be called after the `ready` event is emitted.\
\
Note\
\
Rendering accessibility tree can significantly affect the performance of your app. It should not be enabled by default. Calling this method will enable the following accessibility support features: `nativeAPIs`, `webContents`, `inlineTextBoxes`, and `extendedProperties`.\
\
### `app.getAccessibilitySupportFeatures()` _macOS_ _Windows_\
\
[Permalink: app.getAccessibilitySupportFeatures()macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetaccessibilitysupportfeatures-macos-windows)\
\
Returns `string[]` \- Array of strings naming currently enabled accessibility support components. Possible values:\
\
- `nativeAPIs` \- Native OS accessibility APIs integration enabled.\
- `webContents` \- Web contents accessibility tree exposure enabled.\
- `inlineTextBoxes` \- Inline text boxes (character bounding boxes) enabled.\
- `extendedProperties` \- Extended accessibility properties enabled.\
- `screenReader` \- Screen reader specific mode enabled.\
- `html` \- HTML accessibility tree construction enabled.\
- `labelImages` \- Accessibility support for automatic image annotations.\
- `pdfPrinting` \- Accessibility support for PDF printing enabled.\
\
Notes:\
\
- The array may be empty if no accessibility modes are active.\
- Use `app.isAccessibilitySupportEnabled()` for the legacy boolean check;\
prefer this method for granular diagnostics or telemetry.\
\
Example:\
\
```\
const { app } = require('electron')\
\
app.whenReady().then(() => {\
  if (app.getAccessibilitySupportFeatures().includes('screenReader')) {\
    // Change some app UI to better work with Screen Readers.\
  }\
})\
```\
\
### `app.setAccessibilitySupportFeatures(features)` _macOS_ _Windows_\
\
[Permalink: app.setAccessibilitySupportFeatures(features)macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetaccessibilitysupportfeaturesfeatures-macos-windows)\
\
- `features` string\[\] - An array of the accessibility features to enable.\
\
Possible values are:\
\
- `nativeAPIs` \- Native OS accessibility APIs integration enabled.\
- `webContents` \- Web contents accessibility tree exposure enabled.\
- `inlineTextBoxes` \- Inline text boxes (character bounding boxes) enabled.\
- `extendedProperties` \- Extended accessibility properties enabled.\
- `screenReader` \- Screen reader specific mode enabled.\
- `html` \- HTML accessibility tree construction enabled.\
- `labelImages` \- Accessibility support for automatic image annotations.\
- `pdfPrinting` \- Accessibility support for PDF printing enabled.\
\
To disable all supported features, pass an empty array `[]`.\
\
Example:\
\
```\
const { app } = require('electron')\
\
app.whenReady().then(() => {\
  // Enable a subset of features:\
  app.setAccessibilitySupportFeatures(['screenReader', 'pdfPrinting', 'webContents'])\
\
  // Other logic\
\
  // Some time later, disable all features:\
  app.setAccessibilitySupportFeatures([])\
})\
```\
\
### `app.showAboutPanel()`\
\
[Permalink: app.showAboutPanel()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appshowaboutpanel)\
\
Show the app's about panel options. These options can be overridden with `app.setAboutPanelOptions(options)`. This function runs asynchronously.\
\
### `app.setAboutPanelOptions(options)`\
\
[Permalink: app.setAboutPanelOptions(options)](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetaboutpaneloptionsoptions)\
\
- `options`Object\
\
  - `applicationName` string (optional) - The app's name.\
  - `applicationVersion` string (optional) - The app's version.\
  - `copyright` string (optional) - Copyright information.\
  - `version` string (optional) _macOS_ \- The app's build version number.\
  - `credits` string (optional) _macOS_ _Windows_ \- Credit information.\
  - `authors` string\[\] (optional) _Linux_ \- List of app authors.\
  - `website` string (optional) _Linux_ \- The app's website.\
  - `iconPath` string (optional) _Linux_ _Windows_ \- Path to the app's icon in a JPEG or PNG file format. On Linux, will be shown as 64x64 pixels while retaining aspect ratio. On Windows, a 48x48 PNG will result in the best visual quality.\
\
Set the about panel options. This will override the values defined in the app's `.plist` file on macOS. See the [Apple docs](https://developer.apple.com/reference/appkit/nsapplication/1428479-orderfrontstandardaboutpanelwith?language=objc) for more details. On Linux, values must be set in order to be shown; there are no defaults.\
\
If you do not set `credits` but still wish to surface them in your app, AppKit will look for a file named "Credits.html", "Credits.rtf", and "Credits.rtfd", in that order, in the bundle returned by the NSBundle class method main. The first file found is used, and if none is found, the info area is left blank. See Apple [documentation](https://developer.apple.com/documentation/appkit/nsaboutpaneloptioncredits?language=objc) for more information.\
\
### `app.isEmojiPanelSupported()`\
\
[Permalink: app.isEmojiPanelSupported()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appisemojipanelsupported)\
\
Returns `boolean` \- whether or not the current OS version allows for native emoji pickers.\
\
### `app.showEmojiPanel()` _macOS_ _Windows_\
\
[Permalink: app.showEmojiPanel()macOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appshowemojipanel-macos-windows)\
\
Show the platform's native emoji picker.\
\
### `app.startAccessingSecurityScopedResource(bookmarkData)` _mas_\
\
[Permalink: app.startAccessingSecurityScopedResource(bookmarkData)mas](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appstartaccessingsecurityscopedresourcebookmarkdata-mas)\
\
- `bookmarkData` string - The base64 encoded security scoped bookmark data returned by the `dialog.showOpenDialog` or `dialog.showSaveDialog` methods.\
\
Returns `Function` \- This function **must** be called once you have finished accessing the security scoped file. If you do not remember to stop accessing the bookmark, [kernel resources will be leaked](https://developer.apple.com/reference/foundation/nsurl/1417051-startaccessingsecurityscopedreso?language=objc) and your app will lose its ability to reach outside the sandbox completely, until your app is restarted.\
\
```\
const { app, dialog } = require('electron')\
\
const fs = require('node:fs')\
\
let filepath\
let bookmark\
\
dialog.showOpenDialog(null, { securityScopedBookmarks: true }).then(({ filePaths, bookmarks }) => {\
  filepath = filePaths[0]\
  bookmark = bookmarks[0]\
  fs.readFileSync(filepath)\
})\
\
// ... restart app ...\
\
const stopAccessingSecurityScopedResource = app.startAccessingSecurityScopedResource(bookmark)\
fs.readFileSync(filepath)\
stopAccessingSecurityScopedResource()\
```\
\
Start accessing a security scoped resource. With this method, Electron applications that are packaged for the Mac App Store may reach outside their sandbox to access files chosen by the user. See [Apple's documentation](https://developer.apple.com/documentation/professional-video-applications/enabling-security-scoped-bookmark-and-url-access) for a description of how this system works.\
\
### `app.enableSandbox()`\
\
[Permalink: app.enableSandbox()](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appenablesandbox)\
\
Enables full sandbox mode on the app. This means that all renderers will be launched sandboxed, regardless of the value of the `sandbox` flag in [`WebPreferences`](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/web-preferences.md).\
\
This method can only be called before app is ready.\
\
### `app.isInApplicationsFolder()` _macOS_\
\
[Permalink: app.isInApplicationsFolder()macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appisinapplicationsfolder-macos)\
\
Returns `boolean` \- Whether the application is currently running from the\
systems Application folder. Use in combination with `app.moveToApplicationsFolder()`\
\
### `app.moveToApplicationsFolder([options])` _macOS_\
\
[Permalink: app.moveToApplicationsFolder([options])macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appmovetoapplicationsfolderoptions-macos)\
\
- `options`Object (optional)\
\
  - `conflictHandler`Function<boolean> (optional) - A handler for potential conflict in move failure.\
\
    - `conflictType` string - The type of move conflict encountered by the handler; can be `exists` or `existsAndRunning`, where `exists` means that an app of the same name is present in the Applications directory and `existsAndRunning` means both that it exists and that it's presently running.\
\
Returns `boolean` \- Whether the move was successful. Please note that if\
the move is successful, your application will quit and relaunch.\
\
No confirmation dialog will be presented by default. If you wish to allow\
the user to confirm the operation, you may do so using the\
[`dialog`](https://github.com/electron/electron/blob/v45.0.0/docs/api/dialog.md) API.\
\
**NOTE:** This method throws errors if anything other than the user causes the\
move to fail. For instance if the user cancels the authorization dialog, this\
method returns false. If we fail to perform the copy, then this method will\
throw an error. The message in the error should be informative and tell\
you exactly what went wrong.\
\
By default, if an app of the same name as the one being moved exists in the Applications directory and is _not_ running, the existing app will be trashed and the active app moved into its place. If it _is_ running, the preexisting running app will assume focus and the previously active app will quit itself. This behavior can be changed by providing the optional conflict handler, where the boolean returned by the handler determines whether or not the move conflict is resolved with default behavior. i.e. returning `false` will ensure no further action is taken, returning `true` will result in the default behavior and the method continuing.\
\
For example:\
\
```\
const { app, dialog } = require('electron')\
\
app.moveToApplicationsFolder({\
  conflictHandler: (conflictType) => {\
    if (conflictType === 'exists') {\
      return (\
        dialog.showMessageBoxSync({\
          type: 'question',\
          buttons: ['Halt Move', 'Continue Move'],\
          defaultId: 0,\
          message: 'An app of this name already exists'\
        }) === 1\
      )\
    }\
  }\
})\
```\
\
Would mean that if an app already exists in the user directory, if the user chooses to 'Continue Move' then the function would continue with its default behavior and the existing app will be trashed and the active app moved into its place.\
\
### `app.isSecureKeyboardEntryEnabled()` _macOS_\
\
[Permalink: app.isSecureKeyboardEntryEnabled()macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appissecurekeyboardentryenabled-macos)\
\
Returns `boolean` \- whether `Secure Keyboard Entry` is enabled.\
\
By default this API will return `false`.\
\
### `app.setSecureKeyboardEntryEnabled(enabled)` _macOS_\
\
[Permalink: app.setSecureKeyboardEntryEnabled(enabled)macOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetsecurekeyboardentryenabledenabled-macos)\
\
- `enabled` boolean - Enable or disable `Secure Keyboard Entry`\
\
Set the `Secure Keyboard Entry` is enabled in your application.\
\
By using this API, important information such as password and other sensitive information can be prevented from being intercepted by other processes.\
\
See [Apple's documentation](https://developer.apple.com/library/archive/technotes/tn2150/_index.html) for more\
details.\
\
Note\
\
Enable `Secure Keyboard Entry` only when it is needed and disable it when it is no longer needed.\
\
### `app.setProxy(config)`\
\
[Permalink: app.setProxy(config)](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetproxyconfig)\
\
- `config` [ProxyConfig](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/proxy-config.md)\
\
Returns `Promise<void>` \- Resolves when the proxy setting process is complete.\
\
Sets the proxy settings for networks requests made without an associated [Session](https://github.com/electron/electron/blob/v45.0.0/docs/api/session.md).\
Currently this will affect requests made with [Net](https://github.com/electron/electron/blob/v45.0.0/docs/api/net.md) in the [utility process](https://github.com/electron/electron/blob/v45.0.0/docs/glossary.md#utility-process)\
and internal requests made by the runtime (ex: geolocation queries).\
\
This method can only be called after app is ready.\
\
### `app.resolveProxy(url)`\
\
[Permalink: app.resolveProxy(url)](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appresolveproxyurl)\
\
- `url` URL\
\
Returns `Promise<string>` \- Resolves with the proxy information for `url` that will be used when attempting to make requests using [Net](https://github.com/electron/electron/blob/v45.0.0/docs/api/net.md) in the [utility process](https://github.com/electron/electron/blob/v45.0.0/docs/glossary.md#utility-process).\
\
### `app.setClientCertRequestPasswordHandler(handler)` _Linux_\
\
[Permalink: app.setClientCertRequestPasswordHandler(handler)Linux](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appsetclientcertrequestpasswordhandlerhandler--linux)\
\
- `handler` Function<Promise<string>>\
\
\
  - `clientCertRequestParams`Object\
\
    - `hostname` string - the hostname of the site requiring a client certificate\
    - `tokenName` string - the token (or slot) name of the cryptographic device\
    - `isRetry` boolean - whether there have been previous failed attempts at prompting the password\
\
Returns `Promise<string>` \- Resolves with the password\
\
The handler is called when a password is needed to unlock a client certificate for\
`hostname`.\
\
```\
const { app } = require('electron')\
\
async function passwordPromptUI(text) {\
  return new Promise((resolve, reject) => {\
    // display UI to prompt user for password\
    // ...\
    // ...\
    resolve('the password')\
  })\
}\
\
app.setClientCertRequestPasswordHandler(async ({ hostname, tokenName, isRetry }) => {\
  const text = `Please sign in to ${tokenName} to authenticate to ${hostname} with your certificate`\
  const password = await passwordPromptUI(text)\
  return password\
})\
```\
\
## Properties\
\
[Permalink: Properties](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#properties)\
\
### `app.accessibilitySupportEnabled` _macOS_ _Windows_\
\
[Permalink: app.accessibilitySupportEnabledmacOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appaccessibilitysupportenabled-macos-windows)\
\
A `boolean` property that's `true` if Chromium's accessibility support is enabled, `false` otherwise. This property will be `true` if the use of assistive technologies, such as screen readers, has been detected. Setting this property to `true` manually enables Chromium's accessibility support, allowing developers to expose accessibility switch to users in application settings.\
\
See [Chromium's accessibility docs](https://www.chromium.org/developers/design-documents/accessibility) for more details. Disabled by default.\
\
This API must be called after the `ready` event is emitted.\
\
Note\
\
Rendering accessibility tree can significantly affect the performance of your app. It should not be enabled by default.\
\
### `app.applicationMenu`\
\
[Permalink: app.applicationMenu](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appapplicationmenu)\
\
A `Menu | null` property that returns [`Menu`](https://github.com/electron/electron/blob/v45.0.0/docs/api/menu.md) if one has been set and `null` otherwise.\
Users can pass a [Menu](https://github.com/electron/electron/blob/v45.0.0/docs/api/menu.md) to set this property.\
\
### `app.badgeCount` _Linux_ _macOS_\
\
[Permalink: app.badgeCountLinuxmacOS](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appbadgecount-linux-macos)\
\
An `Integer` property that returns the badge count for current app. Setting the count to `0` will hide the badge. Setting this with any nonzero integer shows the count on the Dock icon on macOS, or on the launcher on Linux.\
\
Note\
\
On macOS, you need to ensure that your application has the permission\
to display notifications for this property to take effect.\
\
### `app.commandLine` _Readonly_\
\
[Permalink: app.commandLineReadonly](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appcommandline-readonly)\
\
A [`CommandLine`](https://github.com/electron/electron/blob/v45.0.0/docs/api/command-line.md) object that allows you to read and manipulate the\
command line arguments that Chromium uses.\
\
### `app.dock` _macOS_ _Readonly_\
\
[Permalink: app.dockmacOSReadonly](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appdock-macos-readonly)\
\
A `Dock | undefined` property ( [`Dock`](https://github.com/electron/electron/blob/v45.0.0/docs/api/dock.md) on macOS, `undefined` on all other\
platforms) that allows you to perform actions on your app icon in the user's dock.\
\
### `app.isPackaged` _Readonly_\
\
[Permalink: app.isPackagedReadonly](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appispackaged-readonly)\
\
A `boolean` property that returns `true` if the app is packaged, `false` otherwise. For many apps, this property can be used to distinguish development and production environments.\
\
### `app.toastActivatorCLSID` _Windows_ _Readonly_\
\
[Permalink: app.toastActivatorCLSIDWindowsReadonly](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#apptoastactivatorclsid-windows-readonly)\
\
A `string` property that returns the app's [Toast Activator CLSID](https://learn.microsoft.com/en-us/windows/win32/properties/props-system-appusermodel-toastactivatorclsid).\
\
### `app.name`\
\
[Permalink: app.name](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appname)\
\
A `string` property that indicates the current application's name, which is the name in the application's `package.json` file.\
\
Usually the `name` field of `package.json` is a short lowercase name, according\
to the npm modules spec. You should usually also specify a `productName`\
field, which is your application's full capitalized name, and which will be\
preferred over `name` by Electron.\
\
On Windows, the application's name must not contain\
[reserved filename characters](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetname), because it is used to construct the\
default `userData` directory.\
\
### `app.userAgentFallback`\
\
[Permalink: app.userAgentFallback](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appuseragentfallback)\
\
A `string` which is the user agent string Electron will use as a global fallback.\
\
This is the user agent that will be used when no user agent is set at the\
`webContents` or `session` level. It is useful for ensuring that your entire\
app has the same user agent. Set to a custom value as early as possible\
in your app's initialization to ensure that your overridden value is used.\
\
### `app.runningUnderARM64Translation` _Readonly_ _macOS_ _Windows_\
\
[Permalink: app.runningUnderARM64TranslationReadonlymacOSWindows](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#apprunningunderarm64translation-readonly-macos-windows)\
\
A `boolean` which when `true` indicates that the app is currently running under\
an ARM64 translator (like the macOS\
[Rosetta Translator Environment](https://en.wikipedia.org/wiki/Rosetta_(software))\
or Windows [WOW](https://en.wikipedia.org/wiki/Windows_on_Windows)).\
\
You can use this property to prompt users to download the arm64 version of\
your application when they are mistakenly running the x64 version under Rosetta or WOW.\
\
You can’t perform that action at this time.