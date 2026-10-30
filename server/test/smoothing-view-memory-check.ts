/** Targeted reload/return check with the exact viewport captured by the UI price-axis drag. */
import fs from "node:fs/promises";
import { browser, delay } from "../tools/perf/cdp.ts";
const out = "data/heatmap-smoothing/remaining-ui";
const prior = JSON.parse(await fs.readFile(`${out}/native-extra.json`, "utf8"));
const dragged = prior.checks.find((c: any) => c.name === "price-zoom").value.after;
const chrome = await browser(9234);
const result: any = { expectedViewport: dragged, tests: [] };
try {
  for (const follow of [true, false]) {
    const p = await chrome.page("http://127.0.0.1:18814/__dummy/away");
    await p.cdp.evaluate(`sessionStorage.clear();sessionStorage.setItem("view.heatmap.NQ",${JSON.stringify(JSON.stringify({ viewport: dragged, follow }))})`);
    await p.cdp.call("Page.navigate", { url: "http://127.0.0.1:18814/?debug=1" });
    await p.cdp.call("Page.bringToFront");
    for (let i = 0; i < 100; i++) {
      if (await p.cdp.evaluate("!!window.__heatmapDebug && window.__heatmapDebug.currentPrice!==null && window.__heatmapDebug.cachedColumns>0")) break;
      await delay(100);
    }
    await delay(400);
    const actual = await p.cdp.evaluate("({viewport:window.__heatmapDebug.viewport,follow:window.__heatmapDebug.follow})");
    const test = { follow, actual, zoomRetained: actual.viewport.priceSpanTicks === dragged.priceSpanTicks };
    result.tests.push(test);
    const shot = await p.cdp.call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(`${out}/restore-follow-${follow}.png`, Buffer.from(shot.data, "base64"));
    await chrome.closePage(p);
  }
} finally {
  result.closed = await chrome.close();
  await fs.writeFile(`${out}/view-memory.json`, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
