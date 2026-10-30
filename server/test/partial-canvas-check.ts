/** Isolated real Canvas comparison; a dedicated Vite must run on 18812. */
import fs from "node:fs/promises";
import { browser, delay } from "../tools/perf/cdp.ts";
const out = "data/heatmap-smoothing/partial-canvas";
await fs.mkdir(out, { recursive: true });
const results = [];
for (const dpr of [1, 2, 3]) {
  const chrome = await browser(9235);
  let result: Record<string, any> = { dpr };
  try {
    const p = await chrome.page("http://127.0.0.1:18812/partial-check.html");
    await p.cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: dpr, mobile: false });
    for (let i = 0; i < 100; i++) {
      if (await p.cdp.evaluate("typeof window.partialCheck==='function'")) break;
      await delay(50);
      if (i === 99) throw Error("harness_timeout");
    }
    result = await p.cdp.evaluate("window.partialCheck()");
    const shot = await p.cdp.call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(`${out}/dpr${dpr}.png`, Buffer.from(shot.data, "base64"));
  } catch (e) { result.error = String(e); }
  finally {
    result.browserClosed = await chrome.close();
    results.push(result);
    await fs.writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
  }
}
console.log(JSON.stringify(results));
if (results.some(r => !r.pass)) process.exitCode = 1;
