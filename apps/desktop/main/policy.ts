import path from "node:path";
import { realpath, readFile } from "node:fs/promises";

export const APP_NAME = "Orderflow Lab";
export const LOCAL_DOCUMENT = "orderflow://app/index.html";
export const WINDOW = Object.freeze({ width: 1440, height: 960, minWidth: 1024, minHeight: 720 });
export const BRIDGE = Object.freeze({ appName: APP_NAME, mode: "MOCK / SIMULATED", apiVersion: 2 });

export function developmentOrigin(value: string, packaged: boolean): string {
  const u = new URL(value);
  if (packaged || u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port ||
      u.username || u.password || u.pathname !== "/" || u.search || u.hash)
    throw new Error("DESKTOP_DEV_ORIGIN_REJECTED");
  return u.origin;
}

export function navigationAllowed(value: string, devOrigin?: string): boolean {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search) return false;
    return devOrigin
      ? u.origin === devOrigin && u.pathname === "/"
      : u.protocol === "orderflow:" && u.hostname === "app" && !u.port && u.pathname === "/index.html";
  } catch { return false; }
}

/** No remote network, file://, service workers, data navigation, or arbitrary local files. */
export function requestAllowed(value: string, devOrigin?: string): boolean {
  try {
    const u = new URL(value);
    if (u.username || u.password) return false;
    if (devOrigin) {
      const dev = new URL(devOrigin);
      return u.origin === devOrigin ||
        (u.protocol === "ws:" && u.hostname === dev.hostname && u.port === dev.port);
    }
    return assetPath(value) !== null;
  } catch { return false; }
}

export function assetPath(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "orderflow:" || u.hostname !== "app" || u.port || u.username || u.password ||
        u.search || u.hash || /%|\\/.test(u.pathname)) return null;
    if (u.pathname === "/index.html") return "index.html";
    return /^\/assets\/[A-Za-z0-9_-]+\.(js|css|svg|png|woff2)$/.test(u.pathname) ? u.pathname.slice(1) : null;
  } catch { return null; }
}

export function contentSecurityPolicy(devOrigin?: string): string {
  const connect = devOrigin ? `${devOrigin} ${devOrigin.replace("http:", "ws:")}` : "'none'";
  return `default-src 'none'; script-src 'self'${devOrigin ? " 'unsafe-inline'" : ""}; ` +
    `style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ${connect}; ` +
    "base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'";
}

/** Reads only a whitelisted built asset under a real, symlink-contained build root. */
export async function localResponse(request: Request, root: string): Promise<Response> {
  const asset = assetPath(request.url);
  if (request.method !== "GET" || !asset) return new Response(null, { status: 403 });
  try {
    const realRoot = await realpath(root), target = await realpath(path.join(realRoot, asset));
    if (!target.startsWith(realRoot + path.sep)) return new Response(null, { status: 403 });
    const ext = path.extname(target);
    const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript",
      ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
    return new Response(new Uint8Array(await readFile(target)), { headers: {
      "Content-Type": types[ext] ?? "application/octet-stream",
      "Content-Security-Policy": contentSecurityPolicy(), "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    } });
  } catch { return new Response(null, { status: 404 }); }
}

export function windowOptions(preload: string, partition: string) {
  return {
    ...WINDOW, title: APP_NAME, backgroundColor: "#08090D", show: false, autoHideMenuBar: true,
    webPreferences: {
      preload, partition, contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    },
  };
}
