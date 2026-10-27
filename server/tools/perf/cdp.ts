import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class CDP {
  private socket: WebSocket;
  private next = 0;
  private listeners = new Map<string, ((params: any) => void)[]>();
  private calls = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method) for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      const call = this.calls.get(message.id);
      if (!call) return;
      this.calls.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(Error(JSON.stringify(message.error))); else call.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(Error("cdp_closed")); }
      this.calls.clear();
    });
  }
  static async connect(url: string): Promise<CDP> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(Error("cdp_connect_failed")), { once: true });
    });
    return new CDP(socket);
  }
  call(method: string, params: object = {}): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(Error(`cdp_timeout:${method}`)); }, 30000);
      this.calls.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method: string, listener: (params: any) => void): void {
    this.listeners.set(method, [...this.listeners.get(method) ?? [], listener]);
  }
  async evaluate(expression: string): Promise<any> {
    const response = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw Error(`page_exception:${response.exceptionDetails.text}`);
    return response.result.value;
  }
  close(): void { this.socket.close(); }
}

/** Uses preinstalled Chromium and its native protocol: no package installation. */
export async function browser(port = 9222) {
  const child = spawn("/repl/tools/bin/chromium", [
    "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/heatmap-perf-browser-${process.pid}-${port}`, "about:blank",
  ], { stdio: "ignore" });
  let info: any;
  for (let i = 0; i < 100; i++) {
    try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { await delay(100); }
  }
  if (!info) { child.kill("SIGTERM"); throw Error("chromium_not_ready"); }
  const root = await CDP.connect(info.webSocketDebuggerUrl);
  const pages: { id: string; cdp: CDP }[] = [];
  return {
    async page(url: string, staticRoot?: string, responseStage = false) {
      const { targetId } = await root.call("Target.createTarget", { url: "about:blank" });
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
      const target = list.find(item => item.id === targetId);
      const cdp = await CDP.connect(target.webSocketDebuggerUrl);
      const userAgent = await cdp.evaluate("navigator.userAgent");
      await cdp.call("Network.setUserAgentOverride", { userAgent: `${userAgent} NQPerf/${process.pid}` });
      await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await cdp.call("Page.enable");
      if (staticRoot) {
        cdp.on("Fetch.requestPaused", request => {
          void (async () => {
            const pathname = new URL(request.request.url).pathname;
            const fixture = pathname.startsWith("/@fs/home/runner/workspace/data/perf-memory/render-fixture/");
            if (pathname !== "/" && !pathname.startsWith("/assets/") && !fixture) {
              await cdp.call("Fetch.continueRequest", { requestId: request.requestId }); return;
            }
            const file = fixture ? pathname.slice("/@fs".length) : path.join(staticRoot, pathname === "/" ? "index.html" : pathname);
            const body = await fs.readFile(file);
            const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css"
              : file.endsWith(".json") ? "application/json" : file.endsWith(".bin") ? "application/octet-stream" : "text/javascript";
            await cdp.call("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: type }, { name: "Cache-Control", value: "no-store" }],
              body: body.toString("base64") });
          })().catch(() => { void cdp.call("Fetch.failRequest", { requestId: request.requestId, errorReason: "Failed" }).catch(() => {}); });
        });
        await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "http://127.0.0.1*/*",
          requestStage: responseStage ? "Response" : "Request" }] });
      }
      await cdp.call("Page.navigate", { url });
      const page = { id: targetId, cdp }; pages.push(page); return page;
    },
    async closePage(page: { id: string; cdp: CDP }) {
      await root.call("Target.closeTarget", { targetId: page.id }); page.cdp.close();
      const index = pages.indexOf(page); if (index >= 0) pages.splice(index, 1);
    },
    async close() {
      const targetIds = pages.map(p => p.id);
      for (const page of [...pages]) {
        await root.call("Target.closeTarget", { targetId: page.id }).catch(() => {});
        page.cdp.close();
      }
      await root.call("Browser.close").catch(() => {});
      root.close();
      for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
      const exited = child.exitCode !== null || child.signalCode !== null;
      let portClosed = false;
      try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }); }
      catch { portClosed = true; }
      if (!exited || !portClosed) throw Error("browser_close_not_confirmed");
      return { pid: child.pid, exited, portClosed, targetIds };
    },
  };
}
