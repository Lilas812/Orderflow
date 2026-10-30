/** ダミー隔離。実Canvas・同一Chromeで旧描画と新描画を比較する。 */
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { browser, delay } from "../tools/perf/cdp.ts";
const option = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = option("out") ?? "data/heatmap-smoothing";
const seconds = Number(option("seconds") ?? 15);
const dprs = option("dpr") ? [Number(option("dpr"))] : [1, 2];
const styles = option("style") ? [option("style")!] : ["block", "glow"];
if (dprs.some(n => n !== 1 && n !== 2) || styles.some(s => s !== "block" && s !== "glow")
  || !Number.isFinite(seconds) || seconds <= 0) throw Error("invalid_benchmark_options");
await fs.mkdir(out, { recursive: true });
const port = 9233, profile = `--user-data-dir=/tmp/heatmap-perf-browser-${process.pid}-${port}`;
const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
async function cpu() {
  const rows: { pid:number; ppid:number; ticks:number; root:boolean }[] = [];
  for (const pid of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const a = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (!/chrome|chromium/.test(a[0] ?? "")) continue;
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8"), v = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.push({pid:Number(pid),ppid:Number(v[1]),ticks:Number(v[11])+Number(v[12]),root:a.includes(profile)});
    } catch {}
  }
  const ids = new Set(rows.filter(p=>p.root).map(p=>p.pid));
  for (let n=0;n<6;n++) for(const p of rows) if(ids.has(p.ppid)) ids.add(p.pid);
  return rows.filter(p=>ids.has(p.pid)).reduce((s,p)=>s+p.ticks,0)/hz;
}
const chrome = await browser(port);
const results: any = { dummy:true, input:"600列×160明示価格、600秒、250msごと1列の後着修正。同一Chrome・固定上限200・下限なし・gamma1。",
  scenarios:[],assertions:[],networkBytes:0 };
try {
  const p = await chrome.page("http://127.0.0.1:18812/smoothing-check.html");
  await p.cdp.call("Network.enable");
  p.cdp.on("Network.loadingFinished", e => { results.networkBytes += e.encodedDataLength ?? 0; });
  for(let n=0;n<100;n++){if(await p.cdp.evaluate("!!window.smoothingHarness"))break;await delay(100);}
  for (const dpr of dprs) {
    await p.cdp.call("Emulation.setDeviceMetricsOverride",{width:1280,height:800,deviceScaleFactor:dpr,mobile:false});
    results.assertions.push({dpr,...await p.cdp.evaluate("window.smoothingHarness.assertions()")});
    for(const style of styles) for(const legacy of [true,false]) {
      const c0=await cpu(),t0=Date.now(),n0=results.networkBytes;
      const r = await p.cdp.evaluate(`window.smoothingHarness.run(${legacy},${JSON.stringify(style)},${seconds})`);
      results.scenarios.push({...r,cpuSeconds:await cpu()-c0,wallSeconds:(Date.now()-t0)/1000,networkBytes:results.networkBytes-n0});
      await fs.writeFile(`${out}/canvas.json`,JSON.stringify(results,null,2));
    }
    if (!process.argv.includes("--skip-images")) for(const style of styles) for(const time of ["mean","max"]) for(const price of ["auto","none"]) {
      await p.cdp.evaluate(`window.smoothingHarness.comparison("${time}","${price}","${style}")`);
      const shot=await p.cdp.call("Page.captureScreenshot",{format:"png"});
      await fs.writeFile(`${out}/${style}-${time}-${price}-dpr${dpr}.png`,Buffer.from(shot.data,"base64"));
    }
  }
} finally {
  results.closed=await chrome.close();
  await fs.writeFile(`${out}/canvas.json`,JSON.stringify(results,null,2));
}
