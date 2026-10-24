Source: https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth
Title: WebGLRenderingContext: drawingBufferWidth property - Web APIs | MDN
Fetched: 2026-10-24T19:33:43.452Z

- [Skip to main content](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth#content)
- [Skip to search](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth#mdn-search)

Learn frontend, backend, and AI from our course partner
[Scrimba](https://scrimba.com/learn/frontend?via=mdn)

# WebGLRenderingContext: drawingBufferWidth property

Baseline


Widely available

This feature is well established and works across many devices and browser versions. It’s been available across browsers since July 2015.

- [See full compatibility](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth#browser_compatibility)
- [Learn more](https://developer.mozilla.org/en-US/docs/Glossary/Baseline/Compatibility)

**Note:** This feature is available in [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API).

The read-only **`WebGLRenderingContext.drawingBufferWidth`**
property represents the actual width of the current drawing buffer. It should match the
`width` attribute of the [`<canvas>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/canvas) element associated with
this context, but might differ if the implementation is not able to provide the
requested width.

## [Value](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth\#value)

A number.

## [Examples](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth\#examples)

Given this [`<canvas>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/canvas) element:

htmlCopy

```
<canvas id="canvas"></canvas>
```

You can get the width of the drawing buffer with the following lines:

jsCopy

```
const canvas = document.getElementById("canvas");
const gl = canvas.getContext("webgl");
gl.drawingBufferWidth; // 300
```

## [Specifications](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth\#specifications)

| Specification |
| --- |
| [WebGL Specification\<br>\# DOM-WebGLRenderingContext-drawingBufferWidth](https://registry.khronos.org/webgl/specs/latest/1.0/#DOM-WebGLRenderingContext-drawingBufferWidth) |

## [Browser compatibility](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth\#browser_compatibility)

[Report problems with this compatibility data](https://github.com/mdn/browser-compat-data/issues/new?mdn-url=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FAPI%2FWebGLRenderingContext%2FdrawingBufferWidth&metadata=%3C%21--+Do+not+make+changes+below+this+line+--%3E%0A%3Cdetails%3E%0A%3Csummary%3EMDN+page+report+details%3C%2Fsummary%3E%0A%0A*+Query%3A+%60api.WebGLRenderingContext.drawingBufferWidth%60%0A*+Report+started%3A+2026-10-24T16%3A35%3A34.356Z%0A%0A%3C%2Fdetails%3E&title=api.WebGLRenderingContext.drawingBufferWidth+-+%3CSUMMARIZE+THE+PROBLEM%3E&template=data-problem.yml "Report an issue with this compatibility data") •
[View data on GitHub](https://github.com/mdn/browser-compat-data/tree/main/api/WebGLRenderingContext.json "File: api/WebGLRenderingContext.json")

Settings

Select the browsers to show in compatibility tables. Your selection is saved in this browser.


### Desktop

Chrome Edge Firefox Safari

Internet Explorer Opera

### Mobile

Chrome Android Firefox for Android Safari on iOS

WebView Android WebView on iOS

Opera Android Samsung Browser

### Server

Bun Deno Node.js

### XR

Quest Browser

### Legend

Browser not available for current feature. No support data available.

|  | desktop | mobile |
| --- | --- | --- |
|  | Chrome | Edge | Firefox | Opera | Safari | Chrome Android | Firefox for Android | Opera Android | Safari on iOS | Samsung Browser | WebView Android | WebView on iOS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `drawingBufferWidth` | Chrome – Full support<br>Chrome9 | Edge – Full support<br>Edge12 | Firefox – Full support<br>Firefox4 | Opera – Full support<br>Opera12 | Safari – Full support<br>Safari5.1 | Chrome Android – Full support<br>Chrome Android25 | Firefox for Android – Full support<br>Firefox for Android4 | Opera Android – Full support<br>Opera Android12 | Safari on iOS – Full support<br>Safari on iOS8 | Samsung Browser – Full support<br>Samsung Browser1.5 | WebView Android – Full support<br>WebView Android4.4.3 | WebView on iOS – Full support<br>WebView on iOS8 |

### Legend

Tip: you can click/tap on a cell for more information.


Full supportFull support

## [See also](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth\#see_also)

- [`WebGLRenderingContext.drawingBufferHeight`](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferHeight)
- [`WebGLRenderingContext.viewport()`](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/viewport)

## Help improve MDN

Was this page helpful to you?

YesNo

[Learn how to contribute](https://developer.mozilla.org/en-US/docs/MDN/Community/Getting_started)

This page was last modified on Sep 28, 2024 by [MDN contributors](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth/contributors.txt).


[View this page on GitHub](https://github.com/mdn/content/blob/main/files/en-us/web/api/webglrenderingcontext/drawingbufferwidth/index.md?plain=1 "Folder: en-us/web/api/webglrenderingcontext/drawingbufferwidth (Opens in a new tab)") • [Report a problem with this content](https://github.com/mdn/content/issues/new?template=page-report.yml&mdn-url=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FAPI%2FWebGLRenderingContext%2FdrawingBufferWidth&metadata=%3C%21--+Do+not+make+changes+below+this+line+--%3E%0A%3Cdetails%3E%0A%3Csummary%3EPage+report+details%3C%2Fsummary%3E%0A%0A*+Folder%3A+%60en-us%2Fweb%2Fapi%2Fwebglrenderingcontext%2Fdrawingbufferwidth%60%0A*+MDN+URL%3A+https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FAPI%2FWebGLRenderingContext%2FdrawingBufferWidth%0A*+GitHub+URL%3A+https%3A%2F%2Fgithub.com%2Fmdn%2Fcontent%2Fblob%2Fmain%2Ffiles%2Fen-us%2Fweb%2Fapi%2Fwebglrenderingcontext%2Fdrawingbufferwidth%2Findex.md%0A*+Last+commit%3A+https%3A%2F%2Fgithub.com%2Fmdn%2Fcontent%2Fcommit%2F2b942f0d8f84641c233d701cb5d1f4e6c23120ff%0A*+Document+last+modified%3A+2024-09-28T05%3A28%3A22.000Z%0A%0A%3C%2Fdetails%3E "This will take you to GitHub to file a new issue.")