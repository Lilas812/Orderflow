import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseObservation } from "@workspace/tickstream-adapter/live-observation";
import { LiveAppendStore } from "./liveAppendStore";
import { digest, LIVE_LOG, LIVE_MANIFEST, LIVE_TEMP, publishLiveManifest, readLiveManifest,
  sealLiveManifest, type LiveWritePhase } from "./liveManifest";
import { offlineLiveRecord, OFFLINE_LIVE_MODE } from "./liveRecord";
import { encodeLiveFrame, recoverLive } from "./liveRecovery";

const dirs: string[] = [];
function directory() {
  const d = mkdtempSync(join(tmpdir(), "tickstream-b2a-recover-")); chmodSync(d, 0o700); dirs.push(d); return d;
}
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const wire = JSON.stringify({ type: "tick", symbol: "NQ", ts: 1700000000, price: 20000.25, size: 12, side: "buy", exch: "CME" });
const context = { origin: "SYNTHETIC_TEST", channel: "ticks", timestampUnit: "s",
  receivedAtUtcNs: "1700000000000000000", receivedAtMonotonicNs: "1000000001",
  connectionEpoch: 1, receiveOrdinal: 1 } as const;
function record(n = 1) { return offlineLiveRecord(parseObservation(wire, { ...context, receiveOrdinal: n })); }
function stored() {
  const d = directory(), s = new LiveAppendStore(d, { testMode: OFFLINE_LIVE_MODE }); s.append(record()); s.close(); return d;
}

describe("B-2A full bounded verification and crash evidence", () => {
  it.each([1, 7, 11, 12, 100])("detects %s-byte partial tail, does not repair or publish it", length => {
    const d = stored(), m = readLiveManifest(d), frame = encodeLiveFrame({
      sessionId: m.sessionId, position: 2, previousHash: m.head, record: record(2) });
    appendFileSync(join(d, LIVE_LOG), frame.data.subarray(0, length));
    const before = readFileSync(join(d, LIVE_LOG)), visitor: unknown[] = [];
    expect(recoverLive(d)).toMatchObject({ status: "TRUNCATED_TAIL", persistedCount: 1,
      verifiedCount: 1, tailBytes: length });
    expect(() => recoverLive(d, r => visitor.push(r))).toThrow("LIVE_STORE_TAIL");
    expect(visitor).toEqual([]); expect(readFileSync(join(d, LIVE_LOG))).toEqual(before);
  });
  it("distinguishes complete unpublished tail from committed data", () => {
    const d = stored(), m = readLiveManifest(d), frame = encodeLiveFrame({
      sessionId: m.sessionId, position: 2, previousHash: m.head, record: record(2) });
    appendFileSync(join(d, LIVE_LOG), frame.data);
    expect(recoverLive(d)).toMatchObject({ status: "UNPUBLISHED_TAIL", persistedCount: 1,
      verifiedCount: 2, tailBytes: frame.data.length });
    expect(() => recoverLive(d, () => {})).toThrow("LIVE_STORE_TAIL");
  });
  it("reports an interrupted manifest publication without trusting or deleting the temp file", () => {
    const d = stored(); writeFileSync(join(d, LIVE_TEMP), '{"unfinished":', { mode: 0o600 });
    expect(recoverLive(d)).toMatchObject({ status: "PUBLISH_INTERRUPTED", persistedCount: 1, pendingManifest: true });
    expect(() => recoverLive(d, () => {})).toThrow("LIVE_STORE_TAIL");
    expect(readFileSync(join(d, LIVE_TEMP), "utf8")).toBe('{"unfinished":');
  });
  it.each(["checksum", "magic", "length", "committedTail", "manifestChecksum", "missingManifest",
    "manifestMode", "manifestCount", "manifestHead", "manifestBytes", "manifestExtra"])(
    "rejects %s before exposing any records", kind => {
      const d = stored(), path = join(d, LIVE_LOG), bytes = readFileSync(path);
      if (kind.startsWith("manifest")) {
        const m = JSON.parse(readFileSync(join(d, LIVE_MANIFEST), "utf8"));
        if (kind === "manifestChecksum") m.checksum = "f".repeat(64);
        if (kind === "manifestMode") m.mode = "PRODUCTION";
        if (kind === "manifestCount") m.count = 0;
        if (kind === "manifestHead") m.head = "0".repeat(64);
        if (kind === "manifestBytes") m.bytes--;
        if (kind === "manifestExtra") m.extra = "SECRET_SENTINEL";
        if (kind !== "manifestChecksum") {
          const { checksum: _, ...base } = m; m.checksum = sealLiveManifest(base).checksum;
        }
        writeFileSync(join(d, LIVE_MANIFEST), JSON.stringify(m));
      } else if (kind === "missingManifest") rmSync(join(d, LIVE_MANIFEST));
      else {
        if (kind === "checksum") bytes[bytes.length - 1] ^= 1;
        if (kind === "magic") bytes[0] ^= 1;
        if (kind === "length") bytes.writeUInt32BE(0xffffffff, 8);
        writeFileSync(path, kind === "committedTail" ? bytes.subarray(0, bytes.length - 1) : bytes);
      }
      const published: unknown[] = [];
      expect(() => recoverLive(d, r => published.push(r))).toThrow("LIVE_STORE_CORRUPT");
      expect(published).toEqual([]);
    });
  it.each(["position", "previousHash", "session", "semantic", "provenance", "extra", "receiveOrder"])(
    "rejects fully rehashed %s corruption", kind => {
      const d = stored(), m = readLiveManifest(d), r: any = JSON.parse(JSON.stringify(record()));
      if (kind === "semantic") r.priceTicks++;
      if (kind === "provenance") r.inputOrigin = "ACTUAL_PROVIDER_RESPONSE";
      if (kind === "extra") r.key = "SECRET_SENTINEL";
      const body = { sessionId: kind === "session" ? "invented" : m.sessionId,
        position: kind === "position" ? 2 : 1, previousHash: kind === "previousHash" ? "f".repeat(64) : "0".repeat(64), record: r };
      const a = encodeLiveFrame(body);
      let bytes = a.data, head = a.hash, count = 1;
      if (kind === "receiveOrder") {
        const b = encodeLiveFrame({ sessionId: m.sessionId, position: 2, previousHash: head, record: record() });
        bytes = Buffer.concat([bytes, b.data]); head = b.hash; count = 2;
      }
      writeFileSync(join(d, LIVE_LOG), bytes);
      const { checksum: _, ...base } = m;
      publishLiveManifest(d, sealLiveManifest({ ...base, count, head, bytes: bytes.length }));
      expect(() => recoverLive(d)).toThrow("LIVE_STORE_CORRUPT");
    });
  it("does not publish a valid prefix when a later record is corrupt", () => {
    const d = directory(), s = new LiveAppendStore(d, { testMode: OFFLINE_LIVE_MODE });
    s.append(record()); s.append(record(2)); s.close();
    const b = readFileSync(join(d, LIVE_LOG)); b[b.length - 1] ^= 1; writeFileSync(join(d, LIVE_LOG), b);
    const visits: unknown[] = [];
    expect(() => recoverLive(d, r => visits.push(r))).toThrow("LIVE_STORE_CORRUPT"); expect(visits).toEqual([]);
  });
  it("detects mutation by a recovery visitor rather than silently continuing", () => {
    const d = stored();
    expect(() => recoverLive(d, () => appendFileSync(join(d, LIVE_LOG), Buffer.from([0])))).toThrow("LIVE_STORE_UNKNOWN");
  });
  it("rejects public files and hard links", () => {
    const d = stored(); chmodSync(join(d, LIVE_LOG), 0o644);
    expect(() => recoverLive(d)).toThrow("LIVE_STORE_CORRUPT"); chmodSync(join(d, LIVE_LOG), 0o600);
    const external = directory(); linkSync(join(d, LIVE_LOG), join(external, "linked"));
    expect(() => recoverLive(d)).toThrow("LIVE_STORE_CORRUPT");
  });
  it.each(["AFTER_PARTIAL_APPEND", "AFTER_LOG_FSYNC", "BEFORE_MANIFEST_RENAME", "AFTER_MANIFEST"] as LiveWritePhase[])(
    "recovers real SIGKILL at %s; no inherited env, auto repair or lease breaking", async phase => {
      const d = directory(), storeUrl = new URL("./liveAppendStore.ts", import.meta.url).href,
        recordUrl = new URL("./liveRecord.ts", import.meta.url).href,
        adapterUrl = new URL("../../tickstream-adapter/src/liveObservation.ts", import.meta.url).href;
      const code = `
        import {registerHooks} from "node:module"; import {writeSync} from "node:fs";
        registerHooks({resolve(s,c,n){try{return n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}});
        const {LiveAppendStore}=await import(${JSON.stringify(storeUrl)});
        const {offlineLiveRecord,OFFLINE_LIVE_MODE}=await import(${JSON.stringify(recordUrl)});
        const {parseObservation}=await import(${JSON.stringify(adapterUrl)});
        let armed=false;
        const s=new LiveAppendStore(${JSON.stringify(d)},{testMode:OFFLINE_LIVE_MODE,fault:p=>{
          if(armed&&p===${JSON.stringify(phase)}){writeSync(1,"READY\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
        }});
        const make=n=>offlineLiveRecord(parseObservation(${JSON.stringify(wire)},{...${JSON.stringify(context)},receiveOrdinal:n}));
        s.append(make(1));armed=true;s.append(make(2));
      `;
      const child = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning",
        "--input-type=module", "-e", code], { env: {}, stdio: ["ignore", "pipe", "ignore"] });
      const exit = once(child, "exit");
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("OFFLINE_CHILD_TIMEOUT")), 5000);
          let text = "";
          child.stdout.on("data", b => {
            text += b.toString(); if (text.includes("READY\n")) { clearTimeout(timer); resolve(); }
          });
          child.once("exit", () => { clearTimeout(timer); reject(Error("OFFLINE_CHILD_EXIT")); });
          child.once("error", () => { clearTimeout(timer); reject(Error("OFFLINE_CHILD_ERROR")); });
        });
        child.kill("SIGKILL"); const [, signal] = await exit; expect(signal).toBe("SIGKILL");
        const before = digest(readFileSync(join(d, LIVE_LOG))), r = recoverLive(d);
        expect(r.persistedCount).toBe(phase === "AFTER_MANIFEST" ? 2 : 1);
        expect(r.status).toBe(phase === "AFTER_PARTIAL_APPEND" ? "TRUNCATED_TAIL" :
          phase === "AFTER_MANIFEST" ? "VERIFIED" : "UNPUBLISHED_TAIL");
        expect(r.writerLockPresent).toBe(true); expect(digest(readFileSync(join(d, LIVE_LOG)))).toBe(before);
        expect(() => new LiveAppendStore(d, { testMode: OFFLINE_LIVE_MODE })).toThrow("LIVE_STORE_EXISTS");
      } finally { child.kill("SIGKILL"); }
    });
  it("a separate empty-env process reopens and verifies the saved head and full record hashes", async () => {
    const d = stored(), expected = recoverLive(d);
    const code = `
      import {registerHooks} from "node:module";
      registerHooks({resolve(s,c,n){try{return n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}});
      const {recoverLive}=await import(${JSON.stringify(new URL("./liveRecovery.ts", import.meta.url).href)});
      const {digest}=await import(${JSON.stringify(new URL("./liveManifest.ts", import.meta.url).href)});
      const hashes=[];const result=recoverLive(${JSON.stringify(d)},r=>hashes.push(digest(JSON.stringify(r))));
      process.stdout.write(JSON.stringify({count:result.persistedCount,head:result.manifest.head,hashes}));
    `;
    const child = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning",
      "--input-type=module", "-e", code], { env: {}, stdio: ["ignore", "pipe", "ignore"] });
    let output = ""; child.stdout.on("data", b => { output += b.toString(); });
    try {
      const [code] = await once(child, "exit"); expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({ count: 1, head: expected.manifest.head,
        hashes: [digest(JSON.stringify(record()))] });
      expect(readdirSync(d).sort()).toEqual([LIVE_LOG, LIVE_MANIFEST].sort());
    } finally { child.kill("SIGKILL"); }
  });
});
