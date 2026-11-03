// Runs only between the three baseline and three candidate measurements.
import { readFile, writeFile, mkdir, readdir, watch } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve(new URL("../../../", import.meta.url).pathname), out = join(root, "data/receive-stall");
await mkdir(out, { recursive: true });
const ready = async () => {
  try {
    const baseline = JSON.parse(await readFile(join(out, "before-2-600s.json"), "utf8"));
    await readFile(join(out, "allow-validation"));
    return baseline.repeat === 2 && baseline.seconds === 600;
  } catch { return false; }
};
if (!(await ready())) {
  console.log("waiting_for_baseline_and_final_source");
  for await (const _ of watch(out)) if (await ready()) break;
}
const fd = openSync(join(out, "validation.log"), "w");
const steps = [];
try {
  const tests = (await readdir(join(root, "server/test"))).filter(f => f.endsWith(".test.ts")).sort()
    .map(f => `server/test/${f}`);
  const commands = [
    ["pnpm", "--filter", "@workspace/receiver", "run", "typecheck"],
    [process.execPath, "--test", "--test-concurrency=1", ...tests],
    ["pnpm", "--filter", "@workspace/heatmap", "run", "typecheck"],
    ["pnpm", "--filter", "@workspace/receiver", "run", "build"],
  ];
  for (const [command, ...args] of commands) {
    const started = performance.now();
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: root, stdio: ["ignore", fd, fd],
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/home/runner" } });
      child.once("error", reject); child.once("exit", code => resolve(code));
    });
    const result = { command, args, exit, elapsedMs: performance.now() - started };
    steps.push(result); console.log(JSON.stringify(result));
    if (exit !== 0) throw Error("candidate_validation_failed");
  }
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "server/src", "lib/market",
    "artifacts/heatmap/src"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
  const sources = [];
  for (const path of files) sources.push({ path,
    sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex") });
  const candidate = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sources, sourceManifestSha256: createHash("sha256").update(JSON.stringify(sources)).digest("hex"),
    steps, validatedAt: new Date().toISOString(),
  };
  await writeFile(join(out, "candidate.json"), JSON.stringify(candidate, null, 2) + "\n");
  await writeFile(join(out, "candidate-ready"), candidate.sourceManifestSha256 + "\n");
  console.log("candidate_validation_passed");
} finally {
  closeSync(fd);
  await writeFile(join(out, "validation-steps.json"), JSON.stringify(steps, null, 2) + "\n");
}
