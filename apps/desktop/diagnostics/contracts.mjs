import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
export const sha = x => createHash("sha256").update(x).digest("hex");
export const LIMITS = Object.freeze({ wall: [70_000, 120_000, 210_000], total: 420_000,
  rss: 2 * 1024 ** 3, processes: 24, file: 8 * 1024 ** 2, totalBytes: 32 * 1024 ** 2, rows: 8192 });
export function usage(root) {
  let bytes = 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name), s = fs.lstatSync(p);
    assert(!s.isSymbolicLink(), "EVIDENCE_SYMLINK");
    if (s.isDirectory()) bytes += usage(p);
    else { assert(s.isFile() && s.size <= LIMITS.file, "FILE_CAP"); bytes += s.size; }
  }
  assert(bytes <= LIMITS.totalBytes, "TOTAL_EVIDENCE_CAP");
  return bytes;
}
export function writer(directory, root = directory) {
  const owned = fs.lstatSync(directory);
  assert(owned.isDirectory() && !owned.isSymbolicLink() && (owned.mode & 0o777) === 0o700 &&
    owned.uid === process.getuid() && fs.realpathSync(directory) === path.resolve(directory), "OUTPUT_OWNER");
  return (name, value) => {
    assert(/^[a-z0-9][a-z0-9.-]*\.json$/.test(name), "OUTPUT_FILENAME");
    const current = fs.lstatSync(directory);
    assert(current.ino === owned.ino && current.dev === owned.dev && current.uid === owned.uid &&
      (current.mode & 0o777) === 0o700 && !current.isSymbolicLink(), "OUTPUT_CHANGED");
    const text = JSON.stringify(value) + "\n", size = Buffer.byteLength(text);
    assert(size <= LIMITS.file && usage(root) + size <= LIMITS.totalBytes, "EVIDENCE_CAP");
    const dest = path.join(directory, name), temp = dest + ".tmp";
    assert(!fs.existsSync(dest), "OUTPUT_EXISTS");
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      fs.linkSync(temp, dest);
      const d = fs.openSync(directory, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
    } finally { fs.unlinkSync(temp); }
    assert.equal(fs.readFileSync(dest, "utf8"), text, "EVIDENCE_READBACK");
    return { file: name, bytes: size, sha256: sha(text) };
  };
}
export function geometryGate(g, expected) {
  assert(g?.dpr === expected.dpr && g.innerWidth === expected.innerWidth &&
    g.innerHeight === expected.innerHeight, "NATIVE_ENV_CHANGED");
  const cells = ["heatmap", "bubble"].map(layer => g.canvases.find(c => c.layer === layer && c.connected));
  assert(cells.every(Boolean), "CANVASES_MISSING");
  for (const c of cells) {
    assert(c.cssWidth === expected.width && c.cssHeight === expected.height &&
      c.width === Math.round(c.cssWidth * g.dpr) && c.height === Math.round(c.cssHeight * g.dpr) &&
      c.bufferWidth === c.width && c.bufferHeight === c.height, "NATIVE_CANVAS_GEOMETRY");
  }
}
export function stats(a) {
  if (!a.length) return { status: "UNKNOWN", n: 0 };
  assert(a.every(x => Number.isFinite(x) && x >= 0), "INVALID_METRIC");
  const s = [...a].sort((a, b) => a - b), n = s.length;
  return { status: "MEASURED", n, mean: s.reduce((a, b) => a + b, 0) / n,
    median: (s[Math.floor((n - 1) / 2)] + s[Math.floor(n / 2)]) / 2,
    p95: s[Math.ceil(n * .95) - 1], max: s[n - 1] };
}
export function exitCode(result) {
  return result?.status === "PASS" && result.stages?.length === 3 &&
    result.stages.every((s, i) => s.stage === i && s.status === "PASS" && s.cleanup?.remaining === 0) ? 0 : 1;
}
export function signalTarget(started, current, held) {
  assert(held && started.pid > 0 && started.pid === started.pgid && started.pid === started.sid &&
    !["Z", "X"].includes(current.state) &&
    ["pid", "pgid", "sid", "startTicks", "uid"].every(k => current[k] === started[k]), "SIGNAL_OWNER");
  return started.pid;
}
