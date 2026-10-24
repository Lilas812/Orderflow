Source: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
Title: Window: requestAnimationFrame() method - Web APIs | MDN
Fetched: 2026-10-24T19:32:49.615Z

- [Skip to main content](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame#content)
- [Skip to search](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame#mdn-search)

Learn frontend, backend, and AI from our course partner
[Scrimba](https://scrimba.com/learn/frontend?via=mdn)

# Window: requestAnimationFrame() method

Baseline


Widely available

This feature is well established and works across many devices and browser versions. It’s been available across browsers since July 2015.

- [See full compatibility](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame#browser_compatibility)
- [Learn more](https://developer.mozilla.org/en-US/docs/Glossary/Baseline/Compatibility)

The **`window.requestAnimationFrame()`** method tells the
browser you wish to perform an animation. It requests the browser to call a
user-supplied callback function before the next repaint.

The frequency of calls to the callback function will generally match the display
refresh rate. The most common refresh rate is 60hz,
(60 cycles/frames per second), though 75hz, 120hz, and 144hz are also widely used.
`requestAnimationFrame()` calls are paused in most browsers when running in
background tabs or hidden [`<iframe>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) s, in order to improve
performance and battery life.

**Note:**
Your callback function must call `requestAnimationFrame()` again if
you want to animate another frame. `requestAnimationFrame()` is one-shot.

**Warning:**
Be sure always to use the first argument (or some other method for
getting the current time) to calculate how much the animation will progress in
a frame — **otherwise, the animation will run faster on high refresh-rate screens**.
For ways to do that, see the examples below.

## [Syntax](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame\#syntax)

jsCopy

```
requestAnimationFrame(callback)
```

### [Parameters](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame\#parameters)

[`callback`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame#callback)

The function to call when it's time to update your animation for the next repaint. This callback function is passed a single argument:

[`timestamp`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame#timestamp)

A [`DOMHighResTimeStamp`](https://developer.mozilla.org/en-US/docs/Web/API/DOMHighResTimeStamp) indicating the end time of the previous frame's rendering (based on the number of milliseconds since [time origin](https://developer.mozilla.org/en-US/docs/Web/API/Performance/timeOrigin)). The timestamp is a decimal number, in milliseconds, but with a minimal precision of 1 millisecond. For `Window` objects (not `Workers`), it is equal to [`document.timeline.currentTime`](https://developer.mozilla.org/en-US/docs/Web/API/AnimationTimeline/currentTime "document.timeline.currentTime"). This timestamp is shared between all windows that run on the same agent (all same-origin windows and, more importantly, same-origin iframes) — which allows synchronizing animations across multiple `requestAnimationFrame` callbacks. The timestamp value is also similar to calling [`performance.now()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now) at the start of the callback function, but it is never the same value.

When multiple callbacks queued by `requestAnimationFrame()` begin to fire in a single frame, each receives the same timestamp even though time has passed during the computation of every previous callback's workload.

### [Return value](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame\#return_value)

An `unsigned long` integer value, the request ID, that uniquely identifies the entry
in the callback list. You should not make any assumptions about its value. You can pass this value to
[`window.cancelAnimationFrame()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/cancelAnimationFrame) to cancel the refresh callback request.

**Warning:**
The request ID is typically implemented as a per-window incrementing counter. Therefore, even when it starts counting at 1, it may overflow and end up reaching 0.
While unlikely to cause issues for short-lived applications, you should avoid `0` as a sentinel value for invalid request identifier IDs and instead prefer unattainable values such as `null`.
The spec doesn't specify the overflowing behavior, so browsers have divergent behaviors. When overflowing, the value would either wrap around to 0, to a negative value, or fail with an error.
Unless overflow throws, request IDs are also not truly unique because there are only finitely many 32-bit integers for possibly infinitely many callbacks.
Note, however, that it would take approximately 800 days to reach the issue when rendering at 60Hz with a single call to `requestAnimationFrame()` per frame.

## [Examples](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame\#examples)

In this example, an element is animated for 2 seconds (2000 milliseconds). The element
moves at a speed of 0.1px/ms to the right, so its relative position (in CSS pixels) can
be calculated in function of the time elapsed since the start of the animation (in
milliseconds) with `0.1 * elapsed`. The element's final position is 200px
(`0.1 * 2000`) to the right of its initial position.

jsCopy

```
const element = document.getElementById("some-element-you-want-to-animate");
let start;

function step(timestamp) {
  if (start === undefined) {
    start = timestamp;
  }
  const elapsed = timestamp - start;

  // Math.min() is used here to make sure the element stops at exactly 200px
  const shift = Math.min(0.1 * elapsed, 200);
  element.style.transform = `translateX(${shift}px)`;
  if (shift < 200) {
    requestAnimationFrame(step);
  }
}

requestAnimationFrame(step);
```

The following three examples illustrate different approaches to setting the zero point in time,
the baseline for calculating the progress of your animation in each frame. If you
want to synchronize to an external clock, such as [`BaseAudioContext.currentTime`](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime),
the highest precision available is the duration of a single frame, 16.67ms @60Hz. The
callback's timestamp argument represents the end of the previous frame, so the soonest
your newly calculated value(s) will be rendered is in the next frame.

This example waits until the first callback executes to set `zero`. If your animation
jumps to a new value when it starts, you must structure it this way. If you do not need to
synchronize to anything external, such as audio, then this approach is recommended because
some browsers have a multi-frame delay between the initial call to `requestAnimationFrame()`
and the first call to the callback function.

jsCopy

```
let zero;
requestAnimationFrame(firstFrame);
function firstFrame(timestamp) {
  zero = timestamp;
  animate(timestamp);
}
function animate(timestamp) {
  const value = (timestamp - zero) / duration;
  if (value < 1) {
    element.style.opacity = value;
    requestAnimationFrame((t) => animate(t));
  } else element.style.opacity = 1;
}
```

This example uses [`document.timeline.currentTime`](https://developer.mozilla.org/en-US/docs/Web/API/AnimationTimeline/currentTime "document.timeline.currentTime") to set a zero value
before the first call to `requestAnimationFrame`. `document.timeline.currentTime`
aligns with the `timestamp` argument, so the zero value is equivalent to the
0th frame's timestamp.

jsCopy

```
const zero = document.timeline.currentTime;
requestAnimationFrame(animate);
function animate(timestamp) {
  const value = (timestamp - zero) / duration; // animation-timing-function: linear
  if (value < 1) {
    element.style.opacity = value;
    requestAnimationFrame((t) => animate(t));
  } else element.style.opacity = 1;
}
```

This example animates using [`performance.now()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now) instead of the callback's
timestamp value. You might use this to achieve slightly higher synchronization
precision, though the extra degree of precision is variable and not much of an increase.

**Note:**
This example does not allow you to synchronize animation callbacks reliably.

jsCopy

```
const zero = performance.now();
requestAnimationFrame(animate);
function animate() {
  const value = (performance.now() - zero) / duration;
  if (value < 1) {
    element.style.opacity = value;
    requestAnimationFrame(animate);
  } else element.style.opacity = 1;
}
```

## [Specifications](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame\#specifications)

| Specification |
| --- |
| [HTML\<br>\# dom-animationframeprovider-requestanimationframe](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-animationframeprovider-requestanimationframe) |

## [Browser compatibility](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame\#browser_compatibility)

[Report problems with this compatibility data](https://github.com/mdn/browser-compat-data/issues/new?mdn-url=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FAPI%2FWindow%2FrequestAnimationFrame&metadata=%3C%21--+Do+not+make+changes+below+this+line+--%3E%0A%3Cdetails%3E%0A%3Csummary%3EMDN+page+report+details%3C%2Fsummary%3E%0A%0A*+Query%3A+%60api.Window.requestAnimationFrame%60%0A*+Report+started%3A+2026-10-24T17%3A44%3A53.991Z%0A%0A%3C%2Fdetails%3E&title=api.Window.requestAnimationFrame+-+%3CSUMMARIZE+THE+PROBLEM%3E&template=data-problem.yml "Report an issue with this compatibility data") •
[View data on GitHub](https://github.com/mdn/browser-compat-data/tree/main/api/Window.json "File: api/Window.json")

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

|  | desktop | mobile | server |
| --- | --- | --- | --- |
|  | Chrome | Edge | Firefox | Opera | Safari | Chrome Android | Firefox for Android | Opera Android | Safari on iOS | Samsung Browser | WebView Android | WebView on iOS | Deno |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `requestAnimationFrame` | Chrome – Full support<br>Chrome24<br>more | Edge – Full support<br>Edge12<br>footnote | Firefox – Full support<br>Firefox23<br>footnotemore | Opera – Full support<br>Opera15<br>more | Safari – Full support<br>Safari7<br>more | Chrome Android – Full support<br>Chrome Android25<br>more | Firefox for Android – Full support<br>Firefox for Android23<br>more | Opera Android – Full support<br>Opera Android14<br>more | Safari on iOS – Full support<br>Safari on iOS7<br>more | Samsung Browser – Full support<br>Samsung Browser1.5<br>more | WebView Android – Full support<br>WebView Android4.4<br>more | WebView on iOS – Full support<br>WebView on iOS7<br>more | Deno – No support<br>DenoNo |

### Legend

Tip: you can click/tap on a cell for more information.


Full supportFull support

No supportNo support

See implementation notes.

Requires a vendor prefix or different name for use.

Has more compatibility info.

## [See also](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame\#see_also)

- [`Window.cancelAnimationFrame()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/cancelAnimationFrame)
- [`DedicatedWorkerGlobalScope.requestAnimationFrame()`](https://developer.mozilla.org/en-US/docs/Web/API/DedicatedWorkerGlobalScope/requestAnimationFrame)
- [Animating with JavaScript: from setInterval to requestAnimationFrame](https://hacks.mozilla.org/2011/08/animating-with-javascript-from-setinterval-to-requestanimationframe/ "External link (opens in new tab)") \- Blog post
- [TestUFO: Test your web browser for requestAnimationFrame() Timing Deviations](https://testufo.com/#test=animation-time-graph "External link (opens in new tab)")
- [Firefox switching to uint32\_t for the requestAnimationFrame request ID](https://phabricator.services.mozilla.com/rMOZILLACENTRAL149722297f033d5c3ad126d0c72edcb1cb96d72e "External link (opens in new tab)")

## Help improve MDN

Was this page helpful to you?

YesNo

[Learn how to contribute](https://developer.mozilla.org/en-US/docs/MDN/Community/Getting_started)

This page was last modified on Aug 21, 2026 by [MDN contributors](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame/contributors.txt).


[View this page on GitHub](https://github.com/mdn/content/blob/main/files/en-us/web/api/window/requestanimationframe/index.md?plain=1 "Folder: en-us/web/api/window/requestanimationframe (Opens in a new tab)") • [Report a problem with this content](https://github.com/mdn/content/issues/new?template=page-report.yml&mdn-url=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FAPI%2FWindow%2FrequestAnimationFrame&metadata=%3C%21--+Do+not+make+changes+below+this+line+--%3E%0A%3Cdetails%3E%0A%3Csummary%3EPage+report+details%3C%2Fsummary%3E%0A%0A*+Folder%3A+%60en-us%2Fweb%2Fapi%2Fwindow%2Frequestanimationframe%60%0A*+MDN+URL%3A+https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FAPI%2FWindow%2FrequestAnimationFrame%0A*+GitHub+URL%3A+https%3A%2F%2Fgithub.com%2Fmdn%2Fcontent%2Fblob%2Fmain%2Ffiles%2Fen-us%2Fweb%2Fapi%2Fwindow%2Frequestanimationframe%2Findex.md%0A*+Last+commit%3A+https%3A%2F%2Fgithub.com%2Fmdn%2Fcontent%2Fcommit%2F285941521a9a7c2c1b3c443d5f785e5f663a8fc9%0A*+Document+last+modified%3A+2026-08-21T03%3A40%3A34.000Z%0A%0A%3C%2Fdetails%3E "This will take you to GitHub to file a new issue.")