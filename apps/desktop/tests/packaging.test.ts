import { expect, it } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// Configuration-only: this test never downloads Electron or creates a Windows package.
// @ts-expect-error the small packaging config is a plain ESM build tool
import { packaging } from "../tools/packaging.mjs";

it("runs the workspace pnpm guard with Node rather than a POSIX shell", () => {
  const pkg = JSON.parse(fs.readFileSync("../../package.json", "utf8"));
  expect(pkg.scripts.preinstall).toMatch(/^node -e /);
  const code = JSON.parse(pkg.scripts.preinstall.slice("node -e ".length));
  const temp = fs.mkdtempSync(path.join(tmpdir(), "orderflow-install-test-"));
  try {
    fs.writeFileSync(path.join(temp, "package-lock.json"), "artificial");
    fs.writeFileSync(path.join(temp, "yarn.lock"), "artificial");
    const ok = spawnSync(process.execPath, ["-e", code], {
      cwd: temp, env: { npm_config_user_agent: "pnpm/10.26.1" },
    });
    expect(ok.status).toBe(0);
    expect(fs.readdirSync(temp)).toEqual([]);
    const rejected = spawnSync(process.execPath, ["-e", code], {
      cwd: temp, env: { npm_config_user_agent: "npm/11" }, encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Use pnpm instead");
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

it("keeps Windows x64 frontend binaries available without enabling unrelated platforms", () => {
  const workspace = fs.readFileSync("../../pnpm-workspace.yaml", "utf8");
  expect(workspace).not.toContain('"esbuild>@esbuild/win32-x64": "-"');
  expect(workspace).not.toContain('"rollup>@rollup/rollup-win32-x64-msvc": "-"');
  expect(workspace).toContain('"esbuild>@esbuild/win32-arm64": "-"');
  expect(workspace).toContain('"rollup>@rollup/rollup-win32-arm64-msvc": "-"');
});

it("pins Windows x64, the same Electron version and asar-only local assets", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  expect(packaging.platform).toBe("win32"); expect(packaging.arch).toBe("x64");
  expect(packaging.electronVersion).toBe(pkg.devDependencies.electron);
  expect(packaging.asar).toBe(true); expect(packaging.overwrite).toBe(false);
  expect(packaging.win32metadata.ProductName).toBe("Orderflow Lab");
  const source = fs.readFileSync("tools/package.mjs", "utf8");
  expect(source).toContain('process.platform !== "win32"');
  expect(source).toContain('path.join(root, "dist", section)');
  expect(source).toContain('["main", "renderer"]');
  expect(source).not.toContain("signWindows");
  expect(source).not.toContain("autoUpdater");
  expect(source).not.toContain("process.env");
});
