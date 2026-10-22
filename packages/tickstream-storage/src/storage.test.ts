import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { parseObservation, type ReceiveContext } from "@workspace/tickstream-adapter/live-observation";
import { AppendStore, type WritePhase } from "./appendStore";
import { recover, encodeFrame } from "./recovery";
import { MANIFEST_NAME, LOG_NAME, QUOTA_BYTES, readManifest, digest, sealedManifest, publishManifest } from "./manifest";

const dirs: string[] = [];
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "tickstream-gate-a-")); chmodSync(dir, 0o700); dirs.push(dir); return dir;
}
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const context: ReceiveContext = { origin: "SYNTHETIC_TEST", channel: "ticks", timestampUnit: "s",
  receivedAtUtcNs: "1700000000000000000", receivedAtMonotonicNs: "12345678901234567890",
  connectionEpoch: 1, receiveOrdinal: 1 };
const wire = JSON.stringify({ type: "tick", symbol: "NQ", ts: 1700000000, price: 20000.25,
  size: 12, side: "buy", exch: "CME" });
function record(ordinal = 1) { return parseObservation(wire, { ...context, receiveOrdinal: ordinal }); }

describe("private finite append-only structured observation store", () => {
  it("persists identical Trades separately, preserves all hashes, reopens and bounds reads", () => {
    const dir = directory(), store = new AppendStore(dir);
    const a = store.append(record()), b = store.append(record(2)); store.close();
    const recovered: unknown[] = [];
    const result = recover(dir, r => recovered.push(r));
    expect(result).toMatchObject({ status: "VERIFIED", persistedCount: 2, verifiedCount: 2, tailBytes: 0 });
    expect(result.manifest.head).toBe(b.head); expect(a.head).not.toBe(b.head);
    expect(recovered).toEqual([record(), record(2)]);
    expect(result.peakReadBufferBytes).toBeLessThan(1024 * 1024 + 600);
    expect(readdirSync(dir).sort()).toEqual([MANIFEST_NAME, LOG_NAME].sort());
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, LOG_NAME)).mode & 0o077).toBe(0);
  });
  it("stores a book snapshot without constructing add/cancel/modify events", () => {
    const dir = directory(), store = new AppendStore(dir);
    const book = parseObservation(JSON.stringify({ type: "book", symbol: "NQ", ts: 1700000000,
      bids: [[20000, 0]], asks: [[20000.25, 40]], imbalance: -.5 }), { ...context, channel: "book" });
    store.append(book); store.close();
    const records: unknown[] = []; recover(dir, r => records.push(r));
    expect(records).toEqual([book]);
  });
  it("stores rejection metadata, never the rejected raw payload", () => {
    const dir = directory(), store = new AppendStore(dir);
    store.append(parseObservation('{"SECRET_SENTINEL":"RAW_SENTINEL"}', context)); store.close();
    expect(readFileSync(join(dir, LOG_NAME)).toString()).not.toMatch(/SECRET_SENTINEL|RAW_SENTINEL/);
    expect(recover(dir).persistedCount).toBe(1);
  });
  it("keeps Gate A storage closed to records claiming actual-provider origin", () => {
    const dir = directory(), store = new AppendStore(dir);
    expect(() => store.append(parseObservation(wire, { ...context, origin: "ACTUAL_PROVIDER_RESPONSE" }))).toThrow("LIVE_GATE_CLOSED");
    expect(store.persisted).toBe(0); store.close();
  });
  it("never overwrites an existing store or opens a second writer", () => {
    const dir = directory(), store = new AppendStore(dir); store.append(record());
    expect(() => new AppendStore(dir)).toThrow("STORE_EXISTS");
    store.close();
    expect(() => new AppendStore(dir)).toThrow("STORE_EXISTS");
    expect(recover(dir).persistedCount).toBe(1);
  });
  it("rejects duplicate local receive identity, not economically identical Trades", () => {
    const store = new AppendStore(directory()); store.append(record());
    expect(() => store.append(record())).toThrow("STORE_INVALID_RECORD");
    store.append(record(2)); expect(store.persisted).toBe(2); store.close();
    expect(() => store.append(record(3))).toThrow("STORE_CLOSED"); store.close();
  });
  it("enforces quota including manifest/temp reserve before appending", () => {
    const dir = directory(), quota = 8192, store = new AppendStore(dir, { quotaBytes: quota });
    let count = 0;
    expect(() => { for (let n = 1; n < 20; n++) { store.append(record(n)); count++; } }).toThrow("STORE_QUOTA");
    expect(count).toBeGreaterThan(0); expect(store.persisted).toBe(count); store.close();
    expect(recover(dir).persistedCount).toBe(count);
    expect(readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0)).toBeLessThanOrEqual(quota);
  });
  it.each([0, 8191, QUOTA_BYTES + 1, Infinity])("rejects unsafe quota %s", quotaBytes => {
    expect(() => new AppendStore(directory(), { quotaBytes })).toThrow("STORE_QUOTA");
  });
  it("rejects publicly readable and symlinked directories", () => {
    const dir = directory(); chmodSync(dir, 0o755);
    expect(() => new AppendStore(dir)).toThrow("PRIVATE_DIRECTORY"); chmodSync(dir, 0o700);
    const parent = directory(), link = join(parent, "linked"); symlinkSync(dir, link);
    expect(() => new AppendStore(link)).toThrow("PRIVATE_DIRECTORY");
    expect(() => new AppendStore(process.cwd())).toThrow("PRIVATE_DIRECTORY");
  });
  it("rejects unsafe filesystem file links", () => {
    const dir = directory(), store = new AppendStore(dir); store.close();
    chmodSync(join(dir, LOG_NAME), 0o644);
    expect(() => recover(dir)).toThrow("STORE_CORRUPT");
  });
  it.each(["BEFORE_APPEND", "AFTER_APPEND", "AFTER_LOG_FSYNC", "AFTER_MANIFEST"] as WritePhase[])(
    "contains I/O error and independently reconciles unknown outcome at %s", phase => {
      const dir = directory(); let armed = false;
      const store = new AppendStore(dir, { fault: p => { if (armed && p === phase) throw Error("KEY_URL_STACK_SENTINEL"); } });
      store.append(record()); armed = true;
      expect(() => store.append(record(2))).toThrow(/^STORE_UNKNOWN$/);
      expect(store.persisted).toBe(1);
      expect(() => store.append(record(2))).toThrow("STORE_FAILED"); store.close();
      const result = recover(dir);
      expect(result.persistedCount).toBe(phase === "AFTER_MANIFEST" ? 2 : 1);
      expect(result.status).toBe(["AFTER_APPEND", "AFTER_LOG_FSYNC"].includes(phase) ? "UNPUBLISHED_TAIL" : "VERIFIED");
      expect(JSON.stringify(result)).not.toContain("SENTINEL");
    },
  );
  it.each([1, 7, 11, 14, 100])("detects a truncated uncommitted tail of %s bytes without repair", tailLength => {
    const dir = directory(), store = new AppendStore(dir); store.append(record()); store.close();
    const m = readManifest(dir), frame = encodeFrame({ sessionId: m.sessionId, position: 2, previousHash: m.head, record: record(2) });
    appendFileSync(join(dir, LOG_NAME), frame.data.subarray(0, tailLength));
    const before = readFileSync(join(dir, LOG_NAME));
    expect(recover(dir)).toMatchObject({ status: "TRUNCATED_TAIL", persistedCount: 1, tailBytes: tailLength });
    expect(() => recover(dir, () => {})).toThrow("STORE_TAIL");
    expect(readFileSync(join(dir, LOG_NAME))).toEqual(before);
  });
  it.each(["checksum", "magic", "length", "committedTail", "manifest"])("rejects corruption of %s", kind => {
    const dir = directory(), store = new AppendStore(dir); store.append(record()); store.close();
    const path = join(dir, LOG_NAME), b = readFileSync(path);
    if (kind === "checksum") b[b.length - 1] ^= 1;
    if (kind === "magic") b[0] ^= 1;
    if (kind === "length") b.writeUInt32BE(0xffffffff, 8);
    if (kind === "manifest") {
      const m = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), "utf8")); m.count++;
      writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(m));
    } else writeFileSync(path, kind === "committedTail" ? b.subarray(0, b.length - 1) : b);
    expect(() => recover(dir)).toThrow("STORE_CORRUPT");
  });
  it("rejects a rehashed but inconsistent position/chain and semantic record", () => {
    for (const mutate of ["position", "previousHash", "semantic"]) {
      const dir = directory(), store = new AppendStore(dir); store.append(record()); store.close();
      const m = readManifest(dir);
      const bad = JSON.parse(JSON.stringify(record()));
      if (mutate === "semantic") bad.result.observation.priceTicks++;
      const frame = encodeFrame({ sessionId: m.sessionId, position: mutate === "position" ? 2 : 1,
        previousHash: mutate === "previousHash" ? "a".repeat(64) : "0".repeat(64), record: bad });
      writeFileSync(join(dir, LOG_NAME), frame.data);
      const { checksum: _, ...base } = m;
      publishManifest(dir, sealedManifest({ ...base, bytes: frame.data.length, head: frame.hash }));
      expect(() => recover(dir)).toThrow("STORE_CORRUPT");
    }
  });
  it.each(["AFTER_LOG_FSYNC", "AFTER_MANIFEST"] as WritePhase[])("recovers after real SIGKILL at %s in a separate empty-env process", async phase => {
    const dir = directory();
    const moduleUrl = new URL("./appendStore.ts", import.meta.url).href;
    const adapterUrl = new URL("../../tickstream-adapter/src/liveObservation.ts", import.meta.url).href;
    const code = `
      import {registerHooks} from "node:module";
      import {writeSync} from "node:fs";
      registerHooks({resolve(s,c,n){try{return n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}});
      const {AppendStore}=await import(${JSON.stringify(moduleUrl)});
      const {parseObservation}=await import(${JSON.stringify(adapterUrl)});
      let armed=false;
      const store=new AppendStore(${JSON.stringify(dir)},{fault:p=>{
        if(armed&&p===${JSON.stringify(phase)}){writeSync(1,"READY\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
      }});
      const make=n=>parseObservation(${JSON.stringify(wire)},{...${JSON.stringify(context)},receiveOrdinal:n});
      store.append(make(1));armed=true;store.append(make(2));
    `;
    const child = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning",
      "--input-type=module", "-e", code], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "";
    child.stderr.on("data", b => { stderr += b.toString(); });
    const exit = once(child, "exit");
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("CHILD_READY_TIMEOUT")), 5000);
        child.stdout.on("data", b => {
          output += b.toString();
          if (output.includes("READY")) { clearTimeout(timer); resolve(); }
        });
        child.once("exit", () => { clearTimeout(timer); reject(Error(`CHILD_FAILED_${stderr.length}`)); });
      });
      child.kill("SIGKILL"); const [, signal] = await exit; expect(signal).toBe("SIGKILL");
      const result = recover(dir);
      expect(result.persistedCount).toBe(phase === "AFTER_MANIFEST" ? 2 : 1);
      expect(result.status).toBe(phase === "AFTER_MANIFEST" ? "VERIFIED" : "UNPUBLISHED_TAIL");
      expect(digest(readFileSync(join(dir, LOG_NAME)))).toHaveLength(64);
    } finally { child.kill("SIGKILL"); }
  });
});
