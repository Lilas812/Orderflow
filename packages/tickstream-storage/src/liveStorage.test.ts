import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseObservation } from "@workspace/tickstream-adapter/live-observation";
import { AppendStore } from "./appendStore";
import { recover } from "./recovery";
import { LiveAppendStore } from "./liveAppendStore";
import { LIVE_LOCK, LIVE_LOG, LIVE_MANIFEST, LIVE_TEMP, QUOTA_BYTES, readLiveManifest, type LiveWritePhase } from "./liveManifest";
import { OFFLINE_LIVE_MODE, offlineLiveRecord } from "./liveRecord";
import { recoverLive } from "./liveRecovery";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), writeSync: vi.fn(actual.writeSync), renameSync: vi.fn(actual.renameSync) };
});

const dirs: string[] = [];
function directory() {
  const d = mkdtempSync(join(tmpdir(), "tickstream-b2a-store-")); chmodSync(d, 0o700); dirs.push(d); return d;
}
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const wire = { type: "tick", symbol: "NQ", ts: 1700000000, price: 20000.25, size: 12, side: "buy", exch: "CME" };
function observation(n = 1, epoch = 1) {
  return parseObservation(JSON.stringify(wire), { origin: "SYNTHETIC_TEST", channel: "ticks", timestampUnit: "s",
    receivedAtUtcNs: "1700000000000000000", receivedAtMonotonicNs: "12345678901234567890",
    connectionEpoch: epoch, receiveOrdinal: n });
}
const record = (n = 1, epoch = 1) => offlineLiveRecord(observation(n, epoch));
const options = { testMode: OFFLINE_LIVE_MODE };

describe("B-2A isolated durable append protocol", () => {
  it("keeps identical Trades, receipt/hash order, private files and independent reopen", () => {
    const d = directory(), s = new LiveAppendStore(d, options);
    const a = s.append(record()), b = s.append(record(2)); s.close(); s.close();
    const records: unknown[] = [], r = recoverLive(d, value => records.push(value));
    expect(records).toEqual([record(), record(2)]);
    expect(r).toMatchObject({ status: "VERIFIED", persistedCount: 2, verifiedCount: 2,
      writerLockPresent: false, pendingManifest: false, tailBytes: 0 });
    expect(r.manifest.head).toBe(b.head); expect(a.head).not.toBe(b.head);
    expect(r.peakReadBufferBytes).toBeLessThan(4700);
    expect(readdirSync(d).sort()).toEqual([LIVE_LOG, LIVE_MANIFEST].sort());
    for (const name of readdirSync(d)) expect(statSync(join(d, name)).mode & 0o077).toBe(0);
    expect(() => s.append(record(3))).toThrow("LIVE_STORE_CLOSED");
  });
  it("keeps Gate A's actual-provider rejection and mutually rejects both file formats", () => {
    const aDir = directory(), a = new AppendStore(aDir);
    a.append(observation());
    const actual = parseObservation(JSON.stringify(wire), { ...observation().provenance,
      origin: "ACTUAL_PROVIDER_RESPONSE", channel: "ticks", timestampUnit: "s" });
    expect(() => a.append(actual)).toThrow("LIVE_GATE_CLOSED"); a.close();
    expect(() => recoverLive(aDir)).toThrow("LIVE_STORE_CORRUPT");
    const d = directory(), s = new LiveAppendStore(d, options); s.append(record()); s.close();
    expect(() => recover(d)).toThrow("STORE_CORRUPT");
    expect(() => new LiveAppendStore(aDir, options)).toThrow("LIVE_STORE_EXISTS");
    expect(recover(aDir).persistedCount).toBe(1);
  });
  it("accepts a reset local ordinal on a later connection, but does not invent continuity", () => {
    const d = directory(), s = new LiveAppendStore(d, options);
    s.append(record(2)); s.append(record(1, 2)); s.close();
    const records: any[] = []; recoverLive(d, r => records.push(r));
    expect(records.map(r => [r.connectionEpoch, r.receiveOrdinal])).toEqual([[1, 2], [2, 1]]);
    expect(records.every(r => r.continuityStatus === "UNKNOWN")).toBe(true);
  });
  it.each([[1, 1], [0, 1], [1, 0], [1, 2]])("rejects duplicate/reversed receive identity %s/%s and poisons writer", (epoch, ordinal) => {
    const d = directory(), s = new LiveAppendStore(d, options); s.append(record(2));
    expect(() => s.append({ ...record(), connectionEpoch: epoch, receiveOrdinal: ordinal }))
      .toThrow(/LIVE_(RECEIVE_ID_INVALID|RECORD_INVALID)/);
    expect(s.persisted).toBe(1); expect(() => s.append(record(3))).toThrow("LIVE_STORE_FAILED"); s.close();
    expect(recoverLive(d).persistedCount).toBe(1);
  });
  it("acknowledges only after log, manifest and directory sync complete", () => {
    const phases: string[] = [], d = directory(); let checking = true;
    const s = new LiveAppendStore(d, { ...options, fault: phase => {
      if (checking) { expect(s.persisted).toBe(0); phases.push(phase); }
    } });
    const receipt = s.append(record());
    expect(phases).toEqual(["BEFORE_APPEND", "AFTER_PARTIAL_APPEND", "AFTER_APPEND", "BEFORE_LOG_FSYNC",
      "AFTER_LOG_FSYNC", "BEFORE_MANIFEST_FSYNC", "AFTER_MANIFEST_FSYNC", "BEFORE_MANIFEST_RENAME",
      "BEFORE_DIRECTORY_FSYNC", "AFTER_DIRECTORY_FSYNC", "AFTER_MANIFEST"]);
    expect(receipt.position).toBe(1); expect(s.persisted).toBe(1);
    checking = false; s.close();
    expect(recoverLive(d).persistedCount).toBe(1);
  });
  it.each([
    "BEFORE_APPEND", "AFTER_PARTIAL_APPEND", "AFTER_APPEND", "BEFORE_LOG_FSYNC", "AFTER_LOG_FSYNC",
    "BEFORE_MANIFEST_FSYNC", "AFTER_MANIFEST_FSYNC", "BEFORE_MANIFEST_RENAME", "BEFORE_DIRECTORY_FSYNC",
    "AFTER_DIRECTORY_FSYNC", "AFTER_MANIFEST",
  ] as LiveWritePhase[])("retains evidence and independently resolves UNKNOWN after %s", phase => {
    const d = directory(); let armed = false;
    const s = new LiveAppendStore(d, { ...options, fault: p => { if (armed && p === phase) throw Error("SECRET_URL_SENTINEL"); } });
    s.append(record()); armed = true;
    expect(() => s.append(record(2))).toThrow(/^LIVE_STORE_UNKNOWN$/);
    expect(s.persisted).toBe(1); expect(() => s.append(record(2))).toThrow("LIVE_STORE_FAILED"); s.close();
    const result = recoverLive(d);
    const published = ["BEFORE_DIRECTORY_FSYNC", "AFTER_DIRECTORY_FSYNC", "AFTER_MANIFEST"].includes(phase);
    expect(result.persistedCount).toBe(published ? 2 : 1);
    expect(result.writerLockPresent).toBe(true);
    if (phase === "AFTER_PARTIAL_APPEND") expect(result.status).toBe("TRUNCATED_TAIL");
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(() => new LiveAppendStore(d, options)).toThrow("LIVE_STORE_EXISTS");
  });
  it.each(["fsyncSync", "writeSync", "renameSync"] as const)("sanitizes actual %s exceptions without retry", method => {
    const d = directory(), s = new LiveAppendStore(d, options);
    s.append(record());
    vi.mocked(fs[method]).mockImplementationOnce(() => { throw Object.assign(Error("KEY_URL_SENTINEL"), { code: "ENOSPC" }); });
    expect(() => s.append(record(2))).toThrow(/^LIVE_STORE_UNKNOWN$/);
    expect(s.persisted).toBe(1); s.close();
    expect(recoverLive(d).persistedCount).toBe(1);
  });
  it("accounts for log, manifest and temporary manifest reserve in quota", () => {
    const d = directory(), quotaBytes = 8192, s = new LiveAppendStore(d, { ...options, quotaBytes });
    let n = 0;
    expect(() => { while (true) { s.append(record(n + 1)); n++; } }).toThrow("LIVE_STORE_QUOTA");
    expect(n).toBeGreaterThan(0); s.close();
    expect(recoverLive(d).persistedCount).toBe(n);
    expect(readdirSync(d).reduce((sum, name) => sum + statSync(join(d, name)).size, 0)).toBeLessThanOrEqual(quotaBytes);
  });
  it.each([0, 8191, QUOTA_BYTES + 1, Infinity])("refuses quota override %s", quotaBytes => {
    expect(() => new LiveAppendStore(directory(), { ...options, quotaBytes })).toThrow("LIVE_STORE_QUOTA");
  });
  it("requires explicit offline mode and rejects hidden options carrying a key", () => {
    for (const opts of [undefined, {}, { testMode: "PRODUCTION" }, { ...options, key: "SECRET_SENTINEL" }]) {
      expect(() => new LiveAppendStore(directory(), opts as any)).toThrow("LIVE_PRODUCTION_DISABLED");
    }
  });
  it("rejects public/workspace/symlink paths before creating store files", () => {
    const d = directory(); chmodSync(d, 0o755);
    expect(() => new LiveAppendStore(d, options)).toThrow("LIVE_PRIVATE_DIRECTORY"); chmodSync(d, 0o700);
    const parent = directory(), link = join(parent, "link"); symlinkSync(d, link);
    expect(() => new LiveAppendStore(link, options)).toThrow("LIVE_PRIVATE_DIRECTORY");
    expect(() => new LiveAppendStore(process.cwd(), options)).toThrow("LIVE_PRIVATE_DIRECTORY");
    expect(readdirSync(d)).toEqual([]);
  });
  it("detects changed manifest or unexpected files before writing any next frame", () => {
    for (const target of ["manifest", "extra"]) {
      const d = directory(), s = new LiveAppendStore(d, options); s.append(record());
      const before = readFileSync(join(d, LIVE_LOG));
      if (target === "manifest") writeFileSync(join(d, LIVE_MANIFEST), "{}");
      else writeFileSync(join(d, "unexpected"), "SECRET_SENTINEL", { mode: 0o600 });
      expect(() => s.append(record(2))).toThrow("LIVE_STORE_CORRUPT");
      expect(readFileSync(join(d, LIVE_LOG))).toEqual(before); s.close();
    }
  });
  it("never stores artificial credential/raw sentinel or exposes it in errors", () => {
    const d = directory(), s = new LiveAppendStore(d, options);
    expect(() => s.append({ ...record(), secret: "KEY_URL_RAW_SENTINEL" } as any)).toThrow(/^LIVE_RECORD_INVALID$/);
    s.close();
    for (const name of readdirSync(d)) expect(readFileSync(join(d, name)).toString()).not.toContain("SENTINEL");
    expect(readLiveManifest(d).count).toBe(0);
  });
});
