import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { checkDirectory, distribution, save, LIMITS } from "./evidence";
import { sha256 } from "./generator";
const owned: string[] = [];
const dir = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "load29-test-")); owned.push(p); return p; };
afterEach(() => { for (const p of owned.splice(0)) fs.rmSync(p, { recursive: true }); });
describe("load29 evidence no-overwrite and quotas", () => {
  it("publishes a complete parseable file with exact byte hash and no temp residue", () => {
    const d = dir(), receipt = save(d, "sample.json", { status: "PASS", sample: [1, 2] });
    expect(JSON.parse(fs.readFileSync(path.join(d, receipt.file), "utf8")).sample).toEqual([1, 2]);
    expect(sha256(fs.readFileSync(path.join(d, receipt.file), "utf8"))).toBe(receipt.sha256);
    expect(fs.readdirSync(d)).toEqual(["sample.json"]);
  });
  it("never replaces an existing file", () => {
    const d = dir(); save(d, "sample.json", { status: "FAIL" });
    expect(() => save(d, "sample.json", { status: "PASS" })).toThrow("OUTPUT_EEXIST");
    expect(JSON.parse(fs.readFileSync(d + "/sample.json", "utf8")).status).toBe("FAIL");
  });
  it("distinguishes a directory from a file and stops", () => {
    const d = dir(); fs.mkdirSync(d + "/sample.json");
    expect(() => save(d, "sample.json", {})).toThrow("UNEXPECTED_OUTPUT");
    expect(fs.statSync(d + "/sample.json").isDirectory()).toBe(true);
  });
  it.each(["../data.json", "/data.json", "dir/file.json", "report"])("rejects invalid output %s", name => {
    expect(() => save(dir(), name, {})).toThrow("OUTPUT_FILENAME");
  });
  it("rejects per-file and directory quotas before partial writes", () => {
    const d = dir(); expect(() => save(d, "x.json", { x: "12345" }, 1)).toThrow("EVIDENCE_QUOTA");
    expect(() => save(d, "x.json", { x: "12345" }, 100, 1)).toThrow("EVIDENCE_QUOTA");
    expect(fs.readdirSync(d)).toHaveLength(0);
  });
  it("rejects undefined/incomplete JSON", () => {
    expect(() => save(dir(), "x.json", undefined)).toThrow("INVALID_EVIDENCE");
  });
  it("retains explicit FAIL evidence, not a cleanup-based PASS", () => {
    const d = dir(); save(d, "failure.json", { status: "FAIL", cleanup: "PASS", completed: 4, total: 8 });
    expect(JSON.parse(fs.readFileSync(d + "/failure.json", "utf8")).status).toBe("FAIL");
  });
  it("refuses symlinks and non-private output", () => {
    const d = dir(), other = dir();
    fs.symlinkSync(other, d + "/link"); expect(() => checkDirectory(d)).toThrow("UNEXPECTED_OUTPUT");
    fs.chmodSync(other, 0o755); expect(() => checkDirectory(other)).toThrow("PRIVATE_DIRECTORY");
  });
  it("rejects budget inflation through save options", () => {
    expect(() => save(dir(), "x.json", {}, LIMITS.fileBytes + 1)).toThrow("INVALID_QUOTA");
  });
  it("reports nearest-rank p95 and no fabricated empty metric", () => {
    expect(distribution([4, 1, 3, 2])).toMatchObject({ n: 4, mean: 2.5, median: 2.5, p95: 4, max: 4 });
    expect(distribution([])).toEqual({ status: "UNKNOWN", n: 0 });
    expect(() => distribution([NaN])).toThrow("INVALID_METRIC");
  });
});
