import { app, BrowserWindow, session, protocol, ipcMain } from "electron";
import { createDesktopLiveController, LIVE_CHANNEL } from "./liveController";
import path from "node:path";
import { APP_NAME, LOCAL_DOCUMENT, developmentOrigin, navigationAllowed, requestAllowed,
  contentSecurityPolicy, localResponse, windowOptions } from "./policy";

// No environment/credential reads, external endpoint, persistence IPC or market connection.
app.setName(APP_NAME);
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{
  scheme: "orderflow", privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

let window: BrowserWindow | null = null;
let quitting = false;
let liveController: ReturnType<typeof createDesktopLiveController> | null = null;

async function openWindow() {
  const devArgs = process.argv.filter(a => a.startsWith("--dev-origin="));
  if (devArgs.length > 1 || process.argv.some(a =>
    /^--(no-sandbox|disable-web-security|disable-setuid-sandbox)(=|$)/.test(a)))
    throw new Error("DESKTOP_SECURITY_ARGUMENT_REJECTED");
  const dev = devArgs.length ? developmentOrigin(devArgs[0].slice("--dev-origin=".length), app.isPackaged) : undefined;
  const partition = "orderflow-mock"; // No persist: prefix: in-memory, isolated session.
  const ses = session.fromPartition(partition, { cache: false });
  ses.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", event => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !requestAllowed(details.url, dev) }));
  ses.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [contentSecurityPolicy(dev)],
      "X-Content-Type-Options": ["nosniff"] },
  }));
  if (!dev) ses.protocol.handle("orderflow", request => localResponse(request, path.join(__dirname, "../renderer")));
  const win = new BrowserWindow(windowOptions(path.join(__dirname, "preload.js"), partition));
  window = win;
  const documentUrl = dev ? `${dev}/` : LOCAL_DOCUMENT;
  liveController = createDesktopLiveController(documentUrl, () => performance.now());
  ipcMain.handle(LIVE_CHANNEL, (event, request: unknown) => {
    if (!liveController) throw Error("IPC_UNAVAILABLE");
    return liveController.command({
      owned: event.sender === win.webContents,
      mainFrame: event.senderFrame !== null && event.senderFrame === win.webContents.mainFrame,
      url: event.senderFrame?.url ?? "",
    }, request);
  });
  const releaseLive = () => { liveController?.dispose(); liveController = null; };
  win.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) liveController?.invalidate();
  });
  win.webContents.on("render-process-gone", releaseLive);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => { if (!navigationAllowed(url, dev)) event.preventDefault(); });
  win.webContents.on("will-redirect", event => event.preventDefault());
  win.webContents.on("will-attach-webview", event => event.preventDefault());
  win.webContents.on("login", event => event.preventDefault());
  win.webContents.on("render-process-gone", () => { process.exitCode = 1; app.quit(); });
  win.once("ready-to-show", () => win.show());
  win.once("closed", () => { releaseLive(); ipcMain.removeHandler(LIVE_CHANNEL); window = null; if (!quitting) app.quit(); });
  await win.loadURL(dev ? `${dev}/` : LOCAL_DOCUMENT);
}

// React is unmounted via the private desktop host event, not an IPC service. Existing
// hook cleanup stops the finite source and renderer effects release their GL objects.
app.on("before-quit", () => { quitting = true; liveController?.dispose(); ipcMain.removeHandler(LIVE_CHANNEL); });
app.on("window-all-closed", () => app.quit());
app.whenReady().then(openWindow).catch(() => {
  // Deliberately avoid logging URLs, environment variables or arbitrary exception text.
  console.error("DESKTOP_START_FAILED");
  process.exitCode = 1;
  app.quit();
});
