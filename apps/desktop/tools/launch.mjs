import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some(a => !["--dev", "--smoke", "--software"].includes(a) &&
    !a.startsWith("--output-dir=") && !/^--display=:\d+(?:\.\d+)?$/.test(a)))
  throw new Error("DESKTOP_LAUNCH_ARGUMENT_REJECTED");
const dev = args.includes("--dev"), smoke = args.includes("--smoke");
if (args.includes("--software") && !smoke) throw new Error("SOFTWARE_FLAG_IS_SMOKE_ONLY");
if (args.some(a => a.startsWith("--output-dir=")) && !smoke) throw new Error("OUTPUT_IS_SMOKE_ONLY");
const require = createRequire(import.meta.url);
// Whitelist local runtime needs; do not enumerate or propagate project Secrets.
const env = {};
for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "LANG", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "LD_LIBRARY_PATH", "NIX_LD", "NIX_LD_LIBRARY_PATH"])
  if (process.env[key] !== undefined) env[key] = process.env[key];
const display = args.find(a => a.startsWith("--display="));
if (display) env.DISPLAY = display.slice("--display=".length);
let server, child, stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await server?.close();
}
try {
  let origin;
  if (dev) {
    server = await createServer({ configFile: root + "vite.config.mts" });
    await server.listen();
    const address = server.httpServer.address();
    if (!address || typeof address === "string") throw new Error("DESKTOP_DEV_LISTEN_FAILED");
    origin = `http://127.0.0.1:${address.port}`;
  }
  const electronArgs = [smoke ? root + "tools/smoke.cjs" : root + "dist/main/main.js"];
  if (origin) electronArgs.push(`--dev-origin=${origin}`);
  if (smoke) electronArgs.push(...args.filter(a => a.startsWith("--output-dir=")));
  if (args.includes("--software")) electronArgs.push("--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  child = spawn(require("electron"), electronArgs, { cwd: root, env, stdio: "inherit", windowsHide: false });
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await close();
  process.exitCode = result.code === 0 && !result.signal ? 0 : 1;
} catch {
  await close();
  console.error("DESKTOP_LAUNCH_FAILED");
  process.exitCode = 1;
}
