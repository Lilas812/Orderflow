import fs from "node:fs";
import assert from "node:assert/strict";
import { verifyBrowserOwnership } from "../baseline13-driver.mjs";
export function parseProcess(pid, stat, status) {
  const f = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const p = { pid, ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]),
    startTicks: f[19], uid: Number(status.match(/^Uid:\s+(\d+)/m)?.[1]), state: f[0],
    rss: null, userTicks: Number(f[11]), systemTicks: Number(f[12]) };
  assert(/^\d+$/.test(p.startTicks) && Number.isSafeInteger(p.uid), "PROCESS_IDENTITY_UNKNOWN");
  if (!["Z", "X"].includes(p.state)) {
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    assert(m, "RUNNING_RSS_UNKNOWN"); p.rss = Number(m[1]) * 1024;
  }
  return p;
}
export function identity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  try { return parseProcess(pid, stat, status); }
  catch (e) {
    const latest = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    if (["Z", "X"].includes(latest.slice(latest.lastIndexOf(")") + 2).split(" ")[0]))
      return parseProcess(pid, latest, status);
    throw e;
  }
}
export function group(pgid) {
  const processes = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${name}/stat`, "utf8"); } catch { continue; }
    const f = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (Number(f[2]) !== pgid && Number(f[3]) !== pgid) continue;
    try { processes.push(identity(Number(name))); }
    catch (e) { if (!["ENOENT", "ESRCH"].includes(e.code)) throw e; }
  }
  return { processes, live: processes.filter(p => p.pgid === pgid && !["Z", "X"].includes(p.state)).map(p => p.pid),
    zombies: processes.filter(p => ["Z", "X"].includes(p.state)).map(p => p.pid) };
}
export function resourceGate(started, snapshot, parent, budget) {
  assert.equal(verifyBrowserOwnership(started, snapshot).status, "PASS", "OWNERSHIP_UNKNOWN");
  const live = snapshot.processes.filter(p => !["Z", "X"].includes(p.state));
  assert(live.length <= budget.processes, "PROCESS_CAP");
  assert(live.every(p => typeof p.rss === "number") && typeof parent.rss === "number", "RSS_UNKNOWN");
  const rss = live.reduce((n, p) => n + p.rss, 0);
  assert(rss <= budget.browserRss && parent.rss <= budget.parentRss &&
    rss + parent.rss <= budget.totalRss, "RSS_CAP");
  return { at: performance.now(), processes: live.length, rss, parentRss: parent.rss,
    cpu: live.map(p => ({ pid: p.pid, startTicks: p.startTicks, userTicks: p.userTicks, systemTicks: p.systemTicks })) };
}
export function competingBrowsers() {
  return fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)).flatMap(n => {
    try { return /chrom(e|ium)/i.test(fs.readFileSync(`/proc/${n}/comm`, "utf8")) ? [Number(n)] : []; }
    catch { return []; }
  });
}
