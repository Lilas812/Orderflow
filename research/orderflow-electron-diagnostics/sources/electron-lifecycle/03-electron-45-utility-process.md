Source: https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md
Title: electron/docs/api/utility-process.md at v45.0.0 · electron/electron · GitHub
Fetched: 2026-10-24T19:33:18.169Z

[Skip to content](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#start-of-content)

You signed in with another tab or window. [Reload](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md) to refresh your session.You signed out in another tab or window. [Reload](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md) to refresh your session.You switched accounts on another tab or window. [Reload](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md) to refresh your session.Dismiss alert

{{ message }}

## Collapse file tree

## Files

View file on default branch

v45.0.0

Search this repository(forward slash)` forward slash/`

/

# utility-process.md

Copy path

Blame

More file actions

Blame

More file actions

## Latest commit

![trop[bot]](https://avatars.githubusercontent.com/in/9879?v=4&size=40)![gengjiawen](https://avatars.githubusercontent.com/u/3759816?v=4&size=40)

[trop\[bot\]](https://github.com/electron/electron/commits?author=trop%5Bbot%5D)

and

[gengjiawen](https://github.com/electron/electron/commits?author=gengjiawen)

[docs: fix utilityProcess 'login' args and setSSLConfig minVersion val…](https://github.com/electron/electron/commit/a67cdc2e0acbcdcdd64e101d9cd35a0be9a16b48)

Open commit detailssuccess

2 weeks agoOct 13, 2026

[a67cdc2](https://github.com/electron/electron/commit/a67cdc2e0acbcdcdd64e101d9cd35a0be9a16b48) · 2 weeks agoOct 13, 2026

## History

[History](https://github.com/electron/electron/commits/v45.0.0/docs/api/utility-process.md)

Open commit details

[View commit history for this file.](https://github.com/electron/electron/commits/v45.0.0/docs/api/utility-process.md) History

244 lines (185 loc) · 10.2 KB

/

# utility-process.md

Copy path

Top

## File metadata and controls

- Preview

- Code

- Blame


244 lines (185 loc) · 10.2 KB

[Raw](https://github.com/electron/electron/raw/refs/tags/v45.0.0/docs/api/utility-process.md)

Copy raw file

Download raw file

Outline

Edit and raw actions

# utilityProcess

[Permalink: utilityProcess](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#utilityprocess)

`utilityProcess` creates a child process with
Node.js and Message ports enabled. It provides the equivalent of [`child_process.fork`](https://nodejs.org/dist/latest-v16.x/docs/api/child_process.html#child_processforkmodulepath-args-options) API from Node.js
but instead uses [Services API](https://chromium.googlesource.com/chromium/src/+/main/docs/mojo_and_services.md) from Chromium to launch the child process.

Process: [Main](https://github.com/electron/electron/blob/v45.0.0/docs/glossary.md#main-process)

## Methods

[Permalink: Methods](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#methods)

### `utilityProcess.fork(modulePath[, args][, options])`

[Permalink: utilityProcess.fork(modulePath[, args][, options])](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#utilityprocessforkmodulepath-args-options)

- `modulePath` string - Path to the script that should run as entrypoint in the child process.
- `args` string\[\] (optional) - List of string arguments that will be available as `process.argv`
in the child process.
- `options`Object (optional)

  - `env` Object (optional) - Environment key-value pairs. Default is `process.env`.
  - `execArgv` string\[\] (optional) - List of string arguments passed to the executable.
  - `cwd` string (optional) - Current working directory of the child process.
  - `session` [Session](https://github.com/electron/electron/blob/v45.0.0/docs/api/session.md) (optional) - Sets the session used by the process for network
    requests. By default, network requests from the utility process will use the system network
    context which does not have HTTP cache support. Setting a session enables HTTP caching and
    other session-specific network features. See [session](https://github.com/electron/electron/blob/v45.0.0/docs/api/session.md) for more information.
  - `partition` string (optional) - Sets the session used by the process according to the
    session's partition string. If `partition` starts with `persist:`, the process will use a
    persistent session available to all pages in the app with the same `partition`. If there is
    no `persist:` prefix, the process will use an in-memory session. By assigning the same
    `partition`, multiple processes can share the same session. If the `session` option is set,
    this option is ignored.
  - `stdio` (string\[\] \| string) (optional) - Allows configuring the mode for `stdout` and `stderr`
    of the child process. Default is `inherit`.
    String value can be one of `pipe`, `ignore`, `inherit`, for more details on these values you can refer to
    [stdio](https://nodejs.org/dist/latest/docs/api/child_process.html#optionsstdio) documentation from Node.js. Currently this option only supports configuring `stdout` and
    `stderr` to either `pipe`, `inherit` or `ignore`. Configuring `stdin` to any property other than `ignore` is not supported and will result in an error.
    For example, the supported values will be processed as following:

    - `pipe`: equivalent to \['ignore', 'pipe', 'pipe'\]
    - `ignore`: equivalent to \['ignore', 'ignore', 'ignore'\]
    - `inherit`: equivalent to \['ignore', 'inherit', 'inherit'\] (the default)
  - `serviceName` string (optional) - Name of the process that will appear in `name` property of
    [`ProcessMetric`](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/process-metric.md) returned by [`app.getAppMetrics`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#appgetappmetrics)
    and [`child-process-gone` event of `app`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-child-process-gone).
    Default is `Node Utility Process`.
  - `allowLoadingUnsignedLibraries` boolean (optional) _macOS_ \- With this flag, the utility process will be
    launched via the `Electron Helper (Plugin).app` helper executable on macOS, which can be
    codesigned with `com.apple.security.cs.disable-library-validation` and
    `com.apple.security.cs.allow-unsigned-executable-memory` entitlements. This will allow the utility process
    to load unsigned libraries. Unless you specifically need this capability, it is best to leave this disabled.
    Default is `false`.
  - `disclaim` boolean (optional) _macOS_ \- With this flag, the utility process will disclaim
    responsibility for the child process. This causes the operating system to consider the child
    process as a separate entity for purposes of security policies like Transparency, Consent, and
    Control (TCC). When responsibility is disclaimed, the parent process will not be attributed
    for any TCC requests initiated by the child process. This is useful when launching processes
    that run third-party or otherwise untrusted code. Default is `false`.
  - `respondToAuthRequestsFromMainProcess` boolean (optional) - With this flag, all HTTP 401 and 407 network
    requests created via the [net module](https://github.com/electron/electron/blob/v45.0.0/docs/api/net.md) will allow responding to them via the
    [`login`](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#event-login) event on the `UtilityProcess` instance when a `session` is provided, or via
    the [`app#login`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-login) event in the main process when using the default system network
    context. This flag also routes client-certificate selection to the
    [`app#select-client-certificate`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-select-client-certificate) event in the main process; without
    it, `net` requests from the utility process proceed without a client certificate. Without this flag, auth
    challenges are handled by the default [`login`](https://github.com/electron/electron/blob/v45.0.0/docs/api/client-request.md#event-login) event on the
    [`ClientRequest`](https://github.com/electron/electron/blob/v45.0.0/docs/api/client-request.md) object. Default is `false`.

Returns [`UtilityProcess`](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#class-utilityprocess)

Note

`utilityProcess.fork` can only be called after the `ready` event has been emitted on `App`.

## Class: UtilityProcess

[Permalink: Class: UtilityProcess](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#class-utilityprocess)

> Instances of the `UtilityProcess` represent the Chromium spawned child process
> with Node.js integration.

`UtilityProcess` is an [EventEmitter](https://nodejs.org/api/events.html#events_class_eventemitter).

### Instance Methods

[Permalink: Instance Methods](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#instance-methods)

#### `child.postMessage(message, [transfer])`

[Permalink: child.postMessage(message, [transfer])](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#childpostmessagemessage-transfer)

- `message` any
- `transfer` MessagePortMain\[\] (optional)

Send a message to the child process, optionally transferring ownership of
zero or more [`MessagePortMain`](https://github.com/electron/electron/blob/v45.0.0/docs/api/message-port-main.md) objects.

For example:

```
// Main process
const { port1, port2 } = new MessageChannelMain()
const child = utilityProcess.fork(path.join(__dirname, 'test.js'))
child.postMessage({ message: 'hello' }, [port1])

// Child process
process.parentPort.once('message', (e) => {
  const [port] = e.ports
  // ...
})
```

#### `child.kill()`

[Permalink: child.kill()](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#childkill)

Returns `boolean`

Terminates the process gracefully. On POSIX, it uses SIGTERM
but will ensure the process is reaped on exit. This function returns
true if the kill is successful, and false otherwise.

### Instance Properties

[Permalink: Instance Properties](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#instance-properties)

#### `child.pid`

[Permalink: child.pid](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#childpid)

A `Integer | undefined` representing the process identifier (PID) of the child process.
Until the child process has spawned successfully, the value is `undefined`. When
the child process exits, then the value is `undefined` after the `exit` event is emitted.

```
const child = utilityProcess.fork(path.join(__dirname, 'test.js'))

console.log(child.pid) // undefined

child.on('spawn', () => {
  console.log(child.pid) // Integer
})

child.on('exit', () => {
  console.log(child.pid) // undefined
})
```

Note

You can use the `pid` to determine if the process is currently running.

#### `child.stdout`

[Permalink: child.stdout](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#childstdout)

A `NodeJS.ReadableStream | null` that represents the child process's stdout.
If the child was spawned with options.stdio\[1\] set to anything other than 'pipe', then this will be `null`.
When the child process exits, then the value is `null` after the `exit` event is emitted.

```
// Main process
const { port1, port2 } = new MessageChannelMain()
const child = utilityProcess.fork(path.join(__dirname, 'test.js'))
child.stdout.on('data', (data) => {
  console.log(`Received chunk ${data}`)
})
```

#### `child.stderr`

[Permalink: child.stderr](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#childstderr)

A `NodeJS.ReadableStream | null` that represents the child process's stderr.
If the child was spawned with options.stdio\[2\] set to anything other than 'pipe', then this will be `null`.
When the child process exits, then the value is `null` after the `exit` event is emitted.

### Instance Events

[Permalink: Instance Events](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#instance-events)

#### Event: 'spawn'

[Permalink: Event: 'spawn'](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#event-spawn)

Emitted once the child process has spawned successfully.

#### Event: 'error' _Experimental_

[Permalink: Event: 'error' Experimental](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#event-error-experimental)

Returns:

- `type`string - Type of error. One of the following values:

  - `FatalError`
- `location` string - Source location from where the error originated.
- `report` string - [`Node.js diagnostic report`](https://nodejs.org/docs/latest/api/report.html#diagnostic-report).

Emitted when the child process needs to terminate due to non continuable error from V8.

No matter if you listen to the `error` event, the `exit` event will be emitted after the
child process terminates.

#### Event: 'exit'

[Permalink: Event: 'exit'](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#event-exit)

Returns:

- `code` number - Contains the exit code for
the process obtained from waitpid on POSIX, or GetExitCodeProcess on Windows.

Emitted after the child process ends.

#### Event: 'message'

[Permalink: Event: 'message'](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#event-message)

Returns:

- `message` any

Emitted when the child process sends a message using [`process.parentPort.postMessage()`](https://github.com/electron/electron/blob/v45.0.0/docs/api/process.md#processparentport).

#### Event: 'login'

[Permalink: Event: 'login'](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md#event-login)

Returns:

- `event` Event
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

Emitted when the utility process encounters an HTTP 401 or 407 authentication challenge, if the
process was created with both `respondToAuthRequestsFromMainProcess: true` and a `session` option.

The default behavior is to cancel the authentication. To override this you should prevent the
default behavior with `event.preventDefault()` and call `callback(username, password)` with the
credentials. Calling `callback` without arguments will cancel the request.

This behaves the same as the [`login` event on `app`](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md#event-login) but is scoped to the
individual utility process instance.

```
const { session, utilityProcess } = require('electron')

const ses = session.defaultSession
const child = utilityProcess.fork('./worker.js', [], {
  session: ses,
  respondToAuthRequestsFromMainProcess: true
})

child.on('login', (event, authenticationResponseDetails, authInfo, callback) => {
  event.preventDefault()
  callback('username', 'password')
})
```

You can’t perform that action at this time.