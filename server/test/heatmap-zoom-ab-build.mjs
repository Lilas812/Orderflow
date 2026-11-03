/** Build immutable before/after source trees. Never reset or rebuild the running app. */
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const cwd = process.cwd();
const before = "38a46afc4d549937512cbd72b09c620989b17a63";
const after = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const root = path.resolve("data/footprint-zoom-ab", `run-${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const builds = {};
for (const [name, sha] of Object.entries({ before, after })) {
  const tree = path.join(root, "build", name);
  await fs.mkdir(tree, { recursive: true });
  execFileSync("bash", ["-c", 'git archive "$1" artifacts/heatmap lib/market | tar -x -C "$2"', "--", sha, tree]);
  await fs.symlink(path.join(cwd, "artifacts/heatmap/node_modules"), path.join(tree, "artifacts/heatmap/node_modules"));
  execFileSync("pnpm", ["--filter", "@workspace/heatmap", "exec", "vite", "build", path.join(tree, "artifacts/heatmap"), "--config", path.join(tree, "artifacts/heatmap/vite.config.ts")], { cwd, stdio: "inherit" });
  const frontRoot = path.join(tree, "artifacts/heatmap/dist/public");
  const artifacts = [];
  for (const file of ["index.html", ...(await fs.readdir(path.join(frontRoot, "assets"))).map(f => "assets/" + f)]) {
    artifacts.push({ file, sha256: createHash("sha256").update(await fs.readFile(path.join(frontRoot, file))).digest("hex") });
  }
  builds[name] = { sha, frontRoot, artifacts };
}
await fs.writeFile(path.join(root, "builds.json"), JSON.stringify({ root, builds }, null, 2));
console.log("AB_BUILD_ROOT=" + root);
