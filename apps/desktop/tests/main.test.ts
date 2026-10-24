import { expect, it, vi, beforeEach } from "vitest";

const f = vi.hoisted(() => ({ app: null as any, ses: null as any, protocol: null as any, win: null as any }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  f.app = Object.assign(new EventEmitter(), { setName: vi.fn(), enableSandbox: vi.fn(), isPackaged: false,
    whenReady: () => Promise.resolve(), quit: vi.fn() });
  f.ses = Object.assign(new EventEmitter(), { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(), protocol: { handle: vi.fn() }, webRequest: {
      onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn(),
    } });
  f.protocol = { registerSchemesAsPrivileged: vi.fn() };
  class FakeWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    loadURL = vi.fn(async () => {});
    show = vi.fn();
    constructor(public options: any) { super(); f.win = this; }
  }
  return { app: f.app, protocol: f.protocol, session: { fromPartition: () => f.ses }, BrowserWindow: FakeWindow };
});
// Vitest 5 clears call history before each test. Initialize after that boundary
// rather than relying on beforeAll's already-cleared initialization history.
beforeEach(async () => {
  vi.resetModules();
  f.app?.removeAllListeners();
  f.ses?.removeAllListeners();
  await import("../main/main");
  await Promise.resolve();
});

it("initializes one isolated local window and production protocol", () => {
  expect(f.app.enableSandbox).toHaveBeenCalledOnce();
  expect(f.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([{
    scheme: "orderflow", privileges: { standard: true, secure: true, supportFetchAPI: true },
  }]);
  expect(f.ses.protocol.handle).toHaveBeenCalledWith("orderflow", expect.any(Function));
  expect(f.win.loadURL).toHaveBeenCalledWith("orderflow://app/index.html");
  expect(f.win.options.webPreferences.sandbox).toBe(true);
  expect(f.win.options.webPreferences.partition).not.toMatch(/^persist:/);
  f.win.emit("ready-to-show"); expect(f.win.show).toHaveBeenCalledOnce();
});
it("blocks native permissions, downloads, external navigation, redirects and webviews", () => {
  const denied = vi.fn();
  f.ses.setPermissionRequestHandler.mock.calls[0][0](null, "media", denied);
  expect(denied).toHaveBeenCalledWith(false);
  expect(f.ses.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
  expect(f.ses.setDevicePermissionHandler.mock.calls[0][0]()).toBe(false);
  for (const [emitter, event, args] of [
    [f.ses, "will-download", []], [f.win.webContents, "will-navigate", ["https://example.test"]],
    [f.win.webContents, "will-redirect", []], [f.win.webContents, "will-attach-webview", []],
    [f.win.webContents, "login", []],
  ] as any[]) {
    const preventDefault = vi.fn(); emitter.emit(event, { preventDefault }, ...args);
    expect(preventDefault).toHaveBeenCalledOnce();
  }
  expect(f.win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: "deny" });
});
it("denies external requests before network, allowing only built app content", () => {
  const callback = vi.fn(), handler = f.ses.webRequest.onBeforeRequest.mock.calls[0][0];
  handler({ url: "https://example.test" }, callback); expect(callback).toHaveBeenLastCalledWith({ cancel: true });
  handler({ url: "orderflow://app/assets/entry-test.js" }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: false });
});
it("quits on close rather than leaving a hidden desktop service", () => {
  f.win.emit("closed"); expect(f.app.quit).toHaveBeenCalled();
  f.app.emit("window-all-closed"); expect(f.app.quit).toHaveBeenCalledTimes(2);
});
