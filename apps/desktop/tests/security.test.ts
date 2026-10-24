import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { developmentOrigin, navigationAllowed, requestAllowed, assetPath, contentSecurityPolicy,
  localResponse, windowOptions, BRIDGE, WINDOW } from "../main/policy";
import { desktopSettings } from "../renderer/services";

describe("desktop security policy", () => {
  it("pins isolation, sandbox, window sizes and no Node/webview", () => {
    const options = windowOptions("/owned/preload.js", "in-memory");
    expect(options.webPreferences).toEqual({
      preload: "/owned/preload.js", partition: "in-memory", contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    });
    expect(WINDOW.width).toBeGreaterThan(WINDOW.minWidth);
    expect(WINDOW.height).toBeGreaterThan(WINDOW.minHeight);
    expect(options.title).toBe("Orderflow Lab");
    expect(WINDOW.minWidth).toBeGreaterThan(403);
  });
  it("allows only a strict loopback development origin", () => {
    expect(developmentOrigin("http://127.0.0.1:12345", false)).toBe("http://127.0.0.1:12345");
    for (const u of ["https://example.test", "http://localhost:1234", "http://127.0.0.1",
      "http://127.0.0.1:1234/other", "http://user:pass@127.0.0.1:1234", "http://127.0.0.1:1234/?x=1"])
      expect(() => developmentOrigin(u, false)).toThrow();
    expect(() => developmentOrigin("http://127.0.0.1:1234", true)).toThrow();
  });
  it.each(["https://example.test/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi",
    "orderflow://other/index.html", "orderflow://app/index.html?external=1",
    "orderflow://user:pass@app/index.html"])("rejects navigation %s", value => {
    expect(navigationAllowed(value)).toBe(false);
  });
  it("restricts development navigation, ports and websocket origin", () => {
    const dev = "http://127.0.0.1:1234";
    expect(navigationAllowed(dev + "/#x", dev)).toBe(true);
    expect(navigationAllowed(dev + "/other", dev)).toBe(false);
    expect(requestAllowed(dev + "/@vite/client", dev)).toBe(true);
    expect(requestAllowed("ws://127.0.0.1:1234/?token=artificial", dev)).toBe(true);
    expect(requestAllowed("ws://127.0.0.1:1235", dev)).toBe(false);
    expect(requestAllowed("https://example.test", dev)).toBe(false);
    expect(requestAllowed("file:///etc/passwd", dev)).toBe(false);
    expect(requestAllowed(dev)).toBe(false);
  });
  it.each(["orderflow://app/../../etc/passwd", "orderflow://app/assets/%252e%252e/private.js",
    "orderflow://app/assets/not.allowed.txt", "orderflow://app/assets/index.js?path=secret",
    "orderflow://app:1234/assets/a.js", "file:///index.html"])("rejects asset %s", value => {
    expect(assetPath(value)).toBeNull();
  });
  it("production CSP prevents remote/script/worker/frame access", () => {
    const csp = contentSecurityPolicy();
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy("http://127.0.0.1:12")).toContain("ws://127.0.0.1:12");
  });
  it("serves only contained built assets and rejects write/path/symlink escape", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "desktop-assets-test-"));
    try {
      const root = path.join(temp, "built"); await mkdir(path.join(root, "assets"), { recursive: true });
      await writeFile(path.join(root, "index.html"), "<title>synthetic</title>");
      await writeFile(path.join(temp, "outside.js"), "SYNTHETIC PRIVATE CANARY");
      await symlink(path.join(temp, "outside.js"), path.join(root, "assets/escape.js"));
      const html = await localResponse(new Request("orderflow://app/index.html"), root);
      expect(html.status).toBe(200);
      expect(await html.text()).toBe("<title>synthetic</title>");
      expect(html.headers.get("Content-Security-Policy")).toBe(contentSecurityPolicy());
      expect((await localResponse(new Request("orderflow://app/assets/escape.js"), root)).status).toBe(403);
      expect((await localResponse(new Request("orderflow://app/index.html", { method: "POST" }), root)).status).toBe(403);
      expect((await localResponse(new Request("orderflow://app/secret"), root)).status).toBe(403);
      expect((await localResponse(new Request("orderflow://app/assets/missing.js"), root)).status).toBe(404);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
  it("sandboxed preload exposes frozen metadata and only fixed observation commands, no arbitrary IPC/native APIs", async () => {
    const code = ts.transpileModule(readFileSync("main/preload.ts", "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    let name = "", value: unknown;
    const calls: unknown[] = [];
    vm.runInNewContext(code, { exports: {}, require: (module: string) => {
      expect(module).toBe("electron");
      return { contextBridge: { exposeInMainWorld: (n: string, v: unknown) => { name = n; value = v; } },
        ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args); } } };
    } });
    expect(name).toBe("orderflowDesktop");
    const { observations, ...metadata } = value as any;
    expect(metadata).toEqual(BRIDGE);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(observations).sort()).toEqual(["read", "release", "select", "stop"]);
    expect(Object.isFrozen(observations)).toBe(true);
    await observations.select(); await observations.read(2); await observations.stop(2); await observations.release(2);
    expect(calls).toEqual([
      ["orderflow:observations:v1", { op: "select", generation: 0 }],
      ["orderflow:observations:v1", { op: "read", generation: 2 }],
      ["orderflow:observations:v1", { op: "stop", generation: 2 }],
      ["orderflow:observations:v1", { op: "release", generation: 2 }],
    ]);
  });
  it("settings are defaults/read-only, cloned, and never silently file-saved", async () => {
    const first = await desktopSettings.load(), second = await desktopSettings.load();
    expect(first).toEqual(second);
    expect(first.settings).not.toBe(second.settings);
    expect(first.persisted).toBe(false);
    await expect(desktopSettings.save(first.settings, 0)).rejects.toThrow("未実装");
  });
  it("shares the real App/AnalysisHub path without an engine copy or load29 entry", () => {
    const renderer = readFileSync("renderer/main.tsx", "utf8"), web = readFileSync("../web/src/App.tsx", "utf8");
    const host = readFileSync("renderer/DesktopHost.tsx", "utf8");
    expect(host).toContain('from "../../web/src/App"');
    expect(host).toContain('<App key="mock" initialMock settingsTransport={desktopSettings}');
    expect(renderer).toContain("root.unmount()");
    expect(renderer).toContain('"beforeunload"');
    expect(renderer).not.toContain("load29");
    expect(web).toContain("initialMock = false");
    expect(web).toContain("uni.start(UNIFIED_DEFAULT_SPEED)");
    expect(web).toContain("useSettings(settingsTransport)");
  });
});
