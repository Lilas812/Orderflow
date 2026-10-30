// Identical INITIAL viewport driver in two temporary snapshots, not product sources.
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
const cwd = process.cwd();
const old = (await fs.readFile("/tmp/footprint-completion-root", "utf8")).trim();
const current = await fs.mkdtemp("/tmp/footprint-measure-after-");
execFileSync("bash", ["-c", 'git archive HEAD artifacts/heatmap lib/market | tar -x -C "$1"', "--", current], { cwd });
await fs.mkdir(path.join(current, "artifacts/heatmap/node_modules"), { recursive: false }).catch(() => {});
// Remove only the empty directory just created inside this owned temporary snapshot.
await fs.rmdir(path.join(current, "artifacts/heatmap/node_modules"));
await fs.symlink(path.join(cwd, "artifacts/heatmap/node_modules"), path.join(current, "artifacts/heatmap/node_modules"));
await fs.copyFile(path.join(cwd, "artifacts/heatmap/src/footprint/app.ts"), path.join(current, "artifacts/heatmap/src/footprint/app.ts"));
const driver = `let follow = true;
// Same measurement-only viewport seed in before and after. Never shipped.
const __benchmarkViewport = new URLSearchParams(location.search).get("benchViewport");
if (__benchmarkViewport) { viewport = JSON.parse(__benchmarkViewport); follow = false; }
`;
for (const root of [old, current]) {
  const file = path.join(root, "artifacts/heatmap/src/main.ts");
  let text = await fs.readFile(file, "utf8");
  if (!text.includes("__benchmarkViewport")) text = text.replace("let follow = true;", driver);
  if (!text.includes("// measurement-after-hello")) text = text.replace(
    "      hasHello = true;\n    }\n    positionPriceFromData();",
    "      hasHello = true;\n    }\n    // measurement-after-hello: same paused view, including pre-view-memory baseline.\n    if (__benchmarkViewport) { viewport = JSON.parse(__benchmarkViewport); follow = false; }\n    positionPriceFromData();");
  await fs.writeFile(file, text);
  execFileSync("pnpm", ["--filter", "@workspace/heatmap", "exec", "vite", "build", path.join(root, "artifacts/heatmap"),
    "--config", path.join(root, "artifacts/heatmap/vite.config.ts")], { cwd, stdio: "inherit" });
}
await fs.writeFile("/tmp/footprint-measure-after-root", current);
console.log(JSON.stringify({ old, current, driver }));
