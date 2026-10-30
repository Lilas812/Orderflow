// Local isolation helper. CDP uses the existing ws package, never an upstream API.
import WebSocket from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
export { delay };
export async function waitFor(test, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) { const v = await test(); if (v) return v; if (Date.now() > end) throw Error("verification_timeout"); await delay(80); }
}
export async function browser({ headed = false } = {}) {
  const profile = await fs.mkdtemp("/tmp/footprint-cdp-");
  const executable = "/nix/store/71577rskzyhch3axhdqx7faygc2xyn4v-playwright-browsers-1.55.0-with-cjk/chromium-1187/chrome-linux/chrome";
  const out = await fs.open(`${profile}/chrome.log`, "w");
  const proc = spawn(executable, [
    headed ? "--ozone-platform=headless" : "--headless=new",
    "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", out.fd, out.fd] });
  const port = await waitFor(async () => {
    try { return Number((await fs.readFile(`${profile}/DevToolsActivePort`, "utf8")).split("\n")[0]); } catch { if (proc.exitCode !== null) throw Error(await fs.readFile(`${profile}/chrome.log`, "utf8")); return false; }
  });
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(info.webSocketDebuggerUrl); await new Promise((r, j) => { socket.once("open", r); socket.once("error", j); });
  let id = 0; const pending = new Map(), listeners = new Set();
  socket.on("message", raw => {
    const m = JSON.parse(raw.toString());
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } }
    else for (const f of listeners) f(m);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error(`CDP timeout ${method}`)); }, 20000);
    pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  async function page(url = "about:blank", background = false) {
    const { targetId } = await send("Target.createTarget", { url, background });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    const evaluate = async expression => {
      const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw Error(r.exceptionDetails.text + JSON.stringify(r.exceptionDetails.exception));
      return r.result.value;
    };
    await call("Runtime.enable"); await call("Page.enable");
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    return { targetId, sessionId, call, evaluate,
      front: () => call("Page.bringToFront"),
      close: () => send("Target.closeTarget", { targetId }),
      screenshot: async file => { const { data } = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await fs.writeFile(file, Buffer.from(data, "base64")); },
    };
  }
  return { proc, profile, port, info, send, page, listeners,
    close: async () => {
      try { await send("Browser.close"); } catch { /* close may race the response */ }
      await Promise.race([new Promise(r => proc.once("exit", r)), delay(1500)]);
      if (proc.exitCode === null) { proc.kill("SIGTERM"); await Promise.race([new Promise(r => proc.once("exit", r)), delay(1500)]); }
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error("browser_closed")); } pending.clear();
      socket.terminate(); await out.close();
      return { pid: proc.pid, exited: proc.exitCode !== null || proc.signalCode !== null, exitCode: proc.exitCode, signal: proc.signalCode, port, profile };
    },
  };
}
