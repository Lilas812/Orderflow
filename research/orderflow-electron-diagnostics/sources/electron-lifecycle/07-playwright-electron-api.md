Source: https://playwright.dev/docs/api/class-electron
Title: Electron | Playwright
Fetched: 2026-10-24T19:33:45.928Z

[Skip to main content](https://playwright.dev/docs/api/class-electron#__docusaurus_skipToContent_fallback)

On this page

Playwright has **experimental** support for Electron automation. You can access electron namespace via:

```js
const { _electron } = require('playwright');
```

An example of the Electron automation script would be:

```js
const { _electron: electron } = require('playwright');

(async () => {

  // Launch Electron app.

  const electronApp = await electron.launch({ args: ['main.js'] });

  // Evaluation expression in the Electron context.

  const appPath = await electronApp.evaluate(async ({ app }) => {

    // This runs in the main Electron process, parameter here is always

    // the result of the require('electron') in the main app script.

    return app.getAppPath();

  });

  console.log(appPath);

  // Get the first window that the app opens, wait if necessary.

  const window = await electronApp.firstWindow();

  // Print the title.

  console.log(await window.title());

  // Capture a screenshot.

  await window.screenshot({ path: 'intro.png' });

  // Direct Electron console to Node terminal.

  window.on('console', console.log);

  // Click button.

  await window.click('text=Click me');

  // Exit app.

  await electronApp.close();

})();
```

**Supported Electron versions are:**

- v21+

**Known issues:**

If you are not able to launch Electron and it will end up in timeouts during launch, try the following:

- Ensure that `nodeCliInspect` ( [FuseV1Options.EnableNodeCliInspectArguments](https://www.electronjs.org/docs/latest/tutorial/fuses#nodecliinspect)) fuse is **not** set to `false`.

**Mocking native dialogs:**

Playwright does not intercept the native Electron [dialog](https://www.electronjs.org/docs/latest/api/dialog) API (`dialog.showOpenDialog`, `dialog.showSaveDialog`, `dialog.showMessageBox`, etc.) because those calls happen in the Electron main process and go straight to OS APIs. Use [electronApplication.evaluate()](https://playwright.dev/docs/api/class-electronapplication#electron-application-evaluate) to replace the relevant methods in the main process so tests run deterministically without any OS-level UI:

```js
// Stub the open dialog to always return a fixed path.

await electronApp.evaluate(({ dialog }, filePaths) => {

  dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths });

}, ['/path/to/file.txt']);

// Stub the save dialog.

await electronApp.evaluate(({ dialog }, filePath) => {

  dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });

}, '/path/to/saved.txt');

// Stub showMessageBox to click the first button.

await electronApp.evaluate(({ dialog }) => {

  dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });

});
```

The replacement persists until the application is closed. Synchronous variants (`showOpenDialogSync`, `showSaveDialogSync`, `showMessageBoxSync`) can be stubbed the same way — just return the value directly instead of a `Promise`.

* * *

## Methods [​](https://playwright.dev/docs/api/class-electron\#methods "Direct link to Methods")

### launch [​](https://playwright.dev/docs/api/class-electron\#electron-launch "Direct link to launch")

Added in: v1.9electron.launch

Launches electron application specified with the [executablePath](https://playwright.dev/docs/api/class-electron#electron-launch-option-executable-path).

**Usage**

```js
await electron.launch();

await electron.launch(options);
```

**Arguments**

- `options` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") _(optional)_
  - `acceptDownloads` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-accept-downloads)

    Whether to automatically download all the attachments. Defaults to `true` where all the downloads are accepted.

  - `args` [Array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array "Array") < [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") \> _(optional)_ [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-args)

    Additional arguments to pass to the application when launching. You typically pass the main script name here.

  - `artifactsDir` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_ Added in: v1.59 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-artifacts-dir)

    If specified, artifacts (traces, videos, downloads, HAR files, etc.) are saved into this directory. The directory is not cleaned up when the browser closes. If not specified, a temporary directory is used and cleaned up when the browser closes.

  - `bypassCSP` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-bypass-csp)

    Toggles bypassing page's Content-Security-Policy. Defaults to `false`.

  - `chromiumSandbox` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") _(optional)_ Added in: v1.59 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-chromium-sandbox)

    Enable Chromium sandboxing. Defaults to `false`.

  - `colorScheme` [null](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/null "null") \| "light" \| "dark" \| "no-preference" _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-color-scheme)

    Emulates [prefers-colors-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme) media feature, supported values are `'light'` and `'dark'`. See [page.emulateMedia()](https://playwright.dev/docs/api/class-page#page-emulate-media) for more details. Passing `null` resets emulation to system defaults. Defaults to `'light'`.

  - `cwd` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_ [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-cwd)

    Current working directory to launch application from.

  - `env` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") < [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string"), [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") \> _(optional)_ [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-env)

    Specifies environment variables that will be visible to Electron. Defaults to `process.env`.

  - `executablePath` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_ [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-executable-path)

    Launches given Electron application. If not specified, launches the default Electron executable installed in this package, located at `node_modules/.bin/electron`.

  - `extraHTTPHeaders` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") < [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string"), [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") \> _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-extra-http-headers)

    An object containing additional HTTP headers to be sent with every request. Defaults to none.

  - `geolocation` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-geolocation)
    - `latitude` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number")

      Latitude between -90 and 90.

    - `longitude` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number")

      Longitude between -180 and 180.

    - `accuracy` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number") _(optional)_

      Non-negative accuracy value. Defaults to `0`.
  - `httpCredentials` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") \| [Array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array "Array") < [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") \> _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-http-credentials)


    - `username` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string")

    - `password` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string")

    - `origin` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_

      Restrain sending http credentials on specific origin (scheme://host:port).

    - `send` "unauthorized" \| "always" _(optional)_

      This option only applies to the requests sent from corresponding [APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext "APIRequestContext") and does not affect requests sent from the browser. `'always'` \- `Authorization` header with basic authentication credentials will be sent with the each API request. `'unauthorized` \- the credentials are only sent when 401 (Unauthorized) response with `WWW-Authenticate` header is received. Defaults to `'unauthorized'`.


Credentials for [HTTP authentication](https://developer.mozilla.org/en-US/docs/Web/HTTP/Authentication). If no origin is specified, the username and password are sent to any servers upon unauthorized responses.

Pass an array to use different credentials for different origins. The first entry that matches the request origin is used, and entries with no origin match any request.

  - `ignoreHTTPSErrors` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-ignore-https-errors)

    Whether to ignore HTTPS errors when sending network requests. Defaults to `false`.

  - `locale` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-locale)

    Specify user locale, for example `en-GB`, `de-DE`, etc. Locale will affect `navigator.language` value, `Accept-Language` request header value as well as number and date formatting rules. Defaults to the system default locale. Learn more about emulation in our [emulation guide](https://playwright.dev/docs/emulation#locale--timezone).

  - `offline` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-offline)

    Whether to emulate network being offline. Defaults to `false`. Learn more about [network emulation](https://playwright.dev/docs/emulation#offline).

  - `recordHar` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-record-har)


    - `omitContent` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") _(optional)_

      Optional setting to control whether to omit request content from the HAR. Defaults to `false`. Deprecated, use `content` policy instead.

    - `content` "omit" \| "embed" \| "attach" _(optional)_

      Optional setting to control resource content management. If `omit` is specified, content is not persisted. If `attach` is specified, resources are persisted as separate files or entries in the ZIP archive. If `embed` is specified, content is stored inline the HAR file as per HAR specification. Defaults to `attach` for `.zip` output files and to `embed` for all other file extensions.

    - `path` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string")

      Path on the filesystem to write the HAR file to. If the file name ends with `.zip`, `content: 'attach'` is used by default.

    - `mode` "full" \| "minimal" _(optional)_

      When set to `minimal`, only record information necessary for routing from HAR. This omits sizes, timing, page, cookies, security and other types of HAR information that are not used when replaying from HAR. Defaults to `full`.

    - `urlFilter` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") \| [RegExp](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp "RegExp") _(optional)_

      A glob or regex pattern to filter requests that are stored in the HAR. When a [baseURL](https://playwright.dev/docs/api/class-browser#browser-new-context-option-base-url) via the context options was provided and the passed URL is a path, it gets merged via the [`new URL()`](https://developer.mozilla.org/en-US/docs/Web/API/URL/URL) constructor. Defaults to none.


Enables [HAR](http://www.softwareishard.com/blog/har-12-spec) recording for all pages into `recordHar.path` file. If not specified, the HAR is not recorded. Make sure to await [browserContext.close()](https://playwright.dev/docs/api/class-browsercontext#browser-context-close) for the HAR to be saved.

  - `recordVideo` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-record-video)


    - `dir` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_

      Path to the directory to put videos into. If not specified, the videos will be stored in `artifactsDir` (see [browserType.launch()](https://playwright.dev/docs/api/class-browsertype#browser-type-launch) options).

    - `size` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") _(optional)_


      - `width` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number")

        Video frame width.

      - `height` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number")

        Video frame height.


Optional dimensions of the recorded videos. If not specified the size will be equal to `viewport` scaled down to fit into 800x800. If `viewport` is not configured explicitly the video size defaults to 800x450. Actual picture of each page will be scaled down if necessary to fit the specified size.

    - `fps` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number") _(optional)_

      Frame rate of the recorded videos in frames per second. Defaults to `25`. Firefox and WebKit currently capture up to 25 frames per second.

    - `showActions` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") _(optional)_


      - `duration` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number") _(optional)_

        How long each annotation is displayed in milliseconds. Defaults to `500`.

      - `position` "top-left" \| "top" \| "top-right" \| "bottom-left" \| "bottom" \| "bottom-right" _(optional)_

        Position of the action title overlay. Defaults to `"top-right"`.

      - `fontSize` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number") _(optional)_

        Font size of the action title in pixels. Defaults to `24`. Deprecated, use `style.title` instead.

      - `cursor` "none" \| "pointer" _(optional)_

        Cursor decoration shown for pointer actions. `"pointer"` (the default) renders a mouse pointer that animates from the previous action point to the next one. `"none"` disables the cursor decoration.

      - `style` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") _(optional)_


        - `point` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_

          CSS declarations for the zero-sized marker centered on the action point. Not shown when omitted.

        - `highlight` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_

          CSS declarations for the box that covers the target element. Not shown when omitted.

        - `title` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_

          CSS declarations for the action title.


Styles of the action decorations.

If specified, enables visual annotations on interacted elements during video recording.

Enables video recording for all pages into `recordVideo.dir` directory. If not specified videos are not recorded. Make sure to await [browserContext.close()](https://playwright.dev/docs/api/class-browsercontext#browser-context-close) for videos to be saved.

  - `timeout` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number") _(optional)_ Added in: v1.15 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-timeout)

    Maximum time in milliseconds to wait for the application to start. Defaults to `30000` (30 seconds). Pass `0` to disable timeout.

  - `timezoneId` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_ Added in: v1.12 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-timezone-id)

    Changes the timezone of the context. See [ICU's metaZones.txt](https://cs.chromium.org/chromium/src/third_party/icu/source/data/misc/metaZones.txt?rcl=faee8bc70570192d82d2978a71e2a615788597d1) for a list of supported timezone IDs. Defaults to the system timezone.

  - `tracesDir` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") _(optional)_ Added in: v1.36 [#](https://playwright.dev/docs/api/class-electron#electron-launch-option-traces-dir)

    If specified, traces are saved into this directory.

**Returns**

- [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise") < [ElectronApplication](https://playwright.dev/docs/api/class-electronapplication "ElectronApplication") > [#](https://playwright.dev/docs/api/class-electron#electron-launch-return)

- [Methods](https://playwright.dev/docs/api/class-electron#methods)
  - [launch](https://playwright.dev/docs/api/class-electron#electron-launch)