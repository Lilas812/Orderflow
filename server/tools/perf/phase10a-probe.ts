import * as fs from "node:fs/promises";
import { delay } from "./cdp.ts";
/** 100ms /proc observations; never attaches a debugger to the receiver. */
const owner = Number(process.argv[2]);
let pid = 0;
for (;;) {
  try { await fs.access(`/proc/${owner}`); } catch { break; }
  try {
    if (!pid) pid = (await (await fetch("http://127.0.0.1:8080/api/status",
      { signal: AbortSignal.timeout(1000) })).json()).memory.pid;
    const [stat, status] = await Promise.all([fs.readFile(`/proc/${pid}/stat`, "utf8"), fs.readFile(`/proc/${pid}/status`, "utf8")]);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    await fs.appendFile("data/phase10a/proc-samples.jsonl", JSON.stringify({ at: Date.now(), pid,
      cpuSeconds: (Number(fields[11]) + Number(fields[12])) / 100,
      rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024,
      hwm: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]) * 1024 }) + "\n");
  } catch { pid = 0; }
  await delay(100);
}
console.log("PHASE10A_PROC_PROBE_STOPPED");
