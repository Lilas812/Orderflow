/** Dedicated source-preview server on 18812; no real upstream/storage. */
import fs from "node:fs/promises";
import { browser, delay } from "../tools/perf/cdp.ts";
const out = "data/gpu-heatmap/pixels";
await fs.mkdir(out, { recursive: true });
const results: any[] = [];
for (const dpr of [1, 2, 3]) {
  if (process.argv.includes("--dpr=1") && dpr !== 1) continue;
  const chrome = await browser(9235);
  let result: any = { dpr };
  try {
    const p = await chrome.page(`http://127.0.0.1:18812/gpu-check.html${process.argv.includes("--saved")?"?saved=1":""}`);
    await p.cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: dpr, mobile: false });
    for (let i = 0; i < 100; i++) {
      if (await p.cdp.evaluate("typeof window.gpuCheck==='function'")) break;
      await delay(50);
    }
    result = await p.cdp.evaluate("window.gpuCheck()");
    for(const picture of result.pictures??[])
      await fs.writeFile(`${out}/dpr${dpr}-${picture.name}.png`,Buffer.from(picture.png.split(",")[1],"base64"));
    delete result.pictures;
    const png = await p.cdp.call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(`${out}/dpr${dpr}.png`, Buffer.from(png.data, "base64"));
  } catch (error) { result.error = String(error); }
  finally {
    result.browserClosed = await chrome.close(); results.push(result);
    await fs.writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
  }
}
console.log(JSON.stringify(results.map(r => ({dpr:r.dpr,pass:r.pass,error:r.error,
  failed:r.results?.filter((x:any)=>x.pixels>0).length, maximum:r.results?.reduce((m:number,x:any)=>Math.max(m,x.max),0)}))));
if (results.some(r => !r.pass)) process.exitCode = 1;
