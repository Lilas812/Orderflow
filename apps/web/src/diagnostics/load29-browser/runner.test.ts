import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { definition } from "../load29/generator";
const driverModule = "./runner.mjs", processModule = "./process.mjs";
const { verifyInput, publicMatch, decodeBlock, glGate } = await import(driverModule);
const { parseProcess, resourceGate } = await import(processModule);
import { BUDGET } from "./contracts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAnalysisHub } from "@workspace/core/analysis-hub";
import { canonical } from "./contracts";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
describe("driver gates (artificial data only)", () => {
  it("checks input SHA, not a setting pretending to be a receipt", () => {
    const d = definition(0);
    expect(() => verifyInput(d, 0, d.inputSha256)).not.toThrow();
    expect(() => verifyInput(d, 0, "0".repeat(64))).toThrow("SHA");
  });
  it("rejects event order changes", () => {
    const d = structuredClone(definition(0)); const a = [...d.inputs]; [a[0], a[1]] = [a[1], a[0]];
    expect(() => verifyInput({ ...d, inputs: a }, 0, d.inputSha256)).toThrow("SHA");
  });
  it("rejects meaning mismatch", () => {
    expect(() => publicMatch({ revision: 1 }, digest('{"revision":2}'))).toThrow("MISMATCH");
  });
  it("validates lossless compressed block SHA", () => {
    const raw = '[{"kind":"frame","revision":9}]';
    const b = { codec: "gzip/base64", bytes: Buffer.byteLength(raw), data: gzipSync(raw).toString("base64"), sha256: digest(raw) };
    expect(decodeBlock(b)).toEqual([{ kind: "frame", revision: 9 }]);
    expect(() => decodeBlock({ ...b, sha256: "bad" })).toThrow("BLOCK_SHA");
    expect(() => decodeBlock({ ...b, bytes: 1 })).toThrow("BLOCK_BYTES");
  });
  for (const error of ["GL_ERROR", "OBSERVER_LIMIT"]) it(`never hides actual ${error}`, () => {
    expect(() => glGate({ fault: error, totals: { errors: 0, loss: 0 } })).toThrow();
  });
  it("detects GL errors even if the fault field is empty", () => {
    expect(() => glGate({ fault: null, totals: { errors: 1, loss: 0 } })).toThrow();
  });
  const p = { pid: 9999, ppid: 10, pgid: 9999, sid: 9999, startTicks: "1000", uid: 1000, state: "S",
    rss: 100, userTicks: 1, systemTicks: 1 };
  it("records measurable owned resources", () => {
    expect(resourceGate(p, { processes: [p], live: [p.pid] }, p, BUDGET).rss).toBe(100);
  });
  it("rejects memory excess", () => {
    expect(() => resourceGate(p, { processes: [{ ...p, rss: BUDGET.browserRss + 1 }], live: [p.pid] }, p, BUDGET)).toThrow("RSS_CAP");
  });
  it("protects reused and unknown owners", () => {
    expect(() => resourceGate(p, { processes: [{ ...p, startTicks: "999" }], live: [p.pid] }, p, BUDGET)).toThrow("OWNERSHIP");
  });
  it("refuses unknown running RSS rather than recording zero", () => {
    expect(() => resourceGate(p, { processes: [{ ...p, rss: null }], live: [p.pid] }, p, BUDGET)).toThrow("RSS_UNKNOWN");
  });
  it("distinguishes known-exited RSS from unknown running RSS", () => {
    const fields = (state: string) => `99 (node) ${[state, "1", "99", "99", ...Array(15).fill("0"), "1000"].join(" ")}`;
    expect(parseProcess(99, fields("Z"), "Uid: 1000\n").rss).toBeNull();
    expect(() => parseProcess(99, fields("S"), "Uid: 1000\n")).toThrow("RUNNING_RSS_UNKNOWN");
  });
  it("persists and losslessly reloads actual public frame checkpoints in a private temporary directory", async () => {
    const { journal } = await import(driverModule);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "load29-offline-"));
    try {
      const d = definition(0), hub = createAnalysisHub(d.scope, () => 0);
      d.inputs.forEach(i => expect(hub.ingest(i).disposition).toBe("ACCEPTED"));
      const text = canonical(hub.readRenderFrame(d.query));
      const j = journal(0, directory); j.append({ kind: "frame", prefix: 128, canonical: text });
      const receipt = j.checkpoint();
      const rows = decodeBlock(JSON.parse(fs.readFileSync(path.join(directory, receipt.blocks[0].file), "utf8")));
      expect(rows[0].canonical).toBe(text);
      expect(() => publicMatch(JSON.parse(rows[0].canonical), digest(text))).not.toThrow();
      expect(() => j.append({ huge: "x".repeat(BUDGET.wireBytes + 1) })).toThrow("ROW_CAP");
    } finally { fs.rmSync(directory, { recursive: true }); }
  });
});
