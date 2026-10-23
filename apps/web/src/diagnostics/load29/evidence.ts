import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./generator";

export const LIMITS = Object.freeze({
  wallMs: 30000, childRss: 512 * 1024 ** 2, totalRss: 768 * 1024 ** 2,
  fileBytes: 8 * 1024 ** 2, directoryBytes: 32 * 1024 ** 2, records: 2048,
});
export function checkDirectory(dir: string): number {
  const resolved = path.resolve(dir);
  if (fs.realpathSync(dir) !== resolved) throw new Error("SYMLINK_PARENT");
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() ||
      (stat.mode & 0o777) !== 0o700) throw new Error("PRIVATE_DIRECTORY");
  let bytes = 0;
  for (const name of fs.readdirSync(dir)) {
    const s = fs.lstatSync(path.join(dir, name));
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid!()) throw new Error("UNEXPECTED_OUTPUT");
    bytes += s.size;
  }
  if (bytes > LIMITS.directoryBytes) throw new Error("DIRECTORY_QUOTA");
  return bytes;
}
/** Atomic no-replace publication. Only this call's own temp is removed. */
export function save(dir: string, name: string, data: unknown,
  fileLimit = LIMITS.fileBytes, directoryLimit = LIMITS.directoryBytes) {
  if (!/^[a-z0-9][a-z0-9.-]*\.json$/.test(name)) throw new Error("OUTPUT_FILENAME");
  const used = checkDirectory(dir), dest = path.join(dir, name);
  if (fs.existsSync(dest)) throw new Error("OUTPUT_EEXIST");
  if (!(fileLimit > 0 && fileLimit <= LIMITS.fileBytes &&
      directoryLimit > 0 && directoryLimit <= LIMITS.directoryBytes)) throw new Error("INVALID_QUOTA");
  const encoded = JSON.stringify(data, null, 2);
  if (encoded === undefined) throw new Error("INVALID_EVIDENCE");
  const text = encoded + "\n", bytes = Buffer.byteLength(text);
  if (bytes > fileLimit || used + bytes > directoryLimit) throw new Error("EVIDENCE_QUOTA");
  const temp = path.join(dir, `.${name}-${process.pid}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(temp, "wx", 0o600); created = true;
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(temp, dest);
    const d = fs.openSync(dir, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  } finally { if (created) fs.unlinkSync(temp); }
  if (fs.readFileSync(dest, "utf8") !== text) throw new Error("EVIDENCE_READBACK");
  return { file: name, bytes, sha256: sha256(text) };
}
export function distribution(values: readonly number[]) {
  if (!values.length) return { status: "UNKNOWN" as const, n: 0 };
  if (values.some(x => !Number.isFinite(x) || x < 0)) throw new Error("INVALID_METRIC");
  const a = [...values].sort((x, y) => x - y);
  return { status: "MEASURED" as const, n: a.length,
    mean: a.reduce((x, y) => x + y, 0) / a.length,
    median: (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2,
    p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1)! };
}
