import { packager } from "@electron/packager";
import { mkdtemp, mkdir, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packaging } from "./packaging.mjs";

if (process.platform !== "win32") throw new Error("WINDOWS_HOST_REQUIRED: Windows 11 / Node 24 / pnpmで実行してください");
const root = fileURLToPath(new URL("../", import.meta.url));
const stage = await mkdtemp(path.join(tmpdir(), "orderflow-package-"));
try {
  // Only already-built main + renderer; never package workspace, private data or dev deps.
  await mkdir(path.join(stage, "dist"));
  // Do not recursively copy previous dist/windows distribution output.
  for (const section of ["main", "renderer"])
    await cp(path.join(root, "dist", section), path.join(stage, "dist", section), { recursive: true, errorOnExist: true });
  await writeFile(path.join(stage, "package.json"), JSON.stringify({
    name: "orderflow-lab-desktop", productName: packaging.name, version: packaging.appVersion,
    private: true, main: "dist/main/main.js", description: "Local finite MOCK analysis",
  }), { flag: "wx" });
  await packager({ ...packaging, dir: stage, out: path.join(root, "dist/windows") });
} finally { await rm(stage, { recursive: true, force: true }); }
