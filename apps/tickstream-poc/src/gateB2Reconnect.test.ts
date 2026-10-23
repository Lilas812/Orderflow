import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { authorizeLiveStorage } from "@workspace/tickstream-storage/live-authorization";
import { B2_CONNECTION_POLICY } from "./gateB2Config";
import { runGateB2Session } from "./gateB2Session";
import { isolatedB2 } from "./gateB2Process";
import { GateBWireSocket } from "./gateBSession";
import { GateBTicks } from "./gateBTransport";
import { FakeClock, LIMITS } from "./transport";

class ObservedClock extends FakeClock {
  readonly requests: number[] = [];
  override schedule(ms: number, callback: () => void) {
    this.requests.push(ms); return super.schedule(ms, callback);
  }
}
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function authorization() {
  const directory = mkdtempSync(join(tmpdir(), "b2b-one-dial-"));
  chmodSync(directory, 0o700); dirs.push(directory);
  const now = Date.now();
  return authorizeLiveStorage({ explicitMode: "GATE_B2B", dataPermission: true, replitStoragePermission: true,
    manualCleanupConfirmed: true, captureMode: "ARTIFICIAL_PROTOCOL_TEST", trialId: randomUUID(),
    directory, issuedAtMs: now, deleteByMs: now + 60000 });
}
/** Real TCP + HTTP upgrade counters, in addition to the actual native WS dial counter. */
async function server(mode: "normal" | "refuse" | "auth" = "normal") {
  const http = createServer(), tcp = new Set<Socket>();
  let tcpAttempts = 0, upgrades = 0;
  http.on("connection", socket => {
    tcpAttempts++; tcp.add(socket); socket.on("close", () => tcp.delete(socket));
    if (mode === "refuse") socket.destroy();
  });
  http.on("upgrade", () => { upgrades++; });
  const ws = new WebSocketServer({ server: http, ...(mode === "auth" ?
    { verifyClient: (_info: unknown, cb: (ok: boolean, code: number) => void) => cb(false, 401) } : {}) });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); if (!address || typeof address === "string") throw Error("ARTIFICIAL_LISTEN");
  return { ws, tcp, get tcpAttempts() { return tcpAttempts; }, get upgrades() { return upgrades; },
    target: { kind: "LOOPBACK_TEST" as const, endpoint: `ws://127.0.0.1:${address.port}/` },
    async close() {
      ws.clients.forEach(s => s.terminate()); tcp.forEach(s => s.destroy());
      await new Promise<void>(r => ws.close(() => r()));
      await new Promise<void>(r => http.close(() => r()));
    } };
}
function countedFactory(target: Awaited<ReturnType<typeof server>>["target"], clock: ObservedClock) {
  let dials = 0;
  const sockets: GateBWireSocket[] = [];
  return { sockets, get dials() { return dials; }, factory: () => {
    const s = new GateBWireSocket(target, clock, () => ({ count: 0, bytes: 0 }), (url, options) => {
      dials++; // counts native WebSocket constructions, not settings or socket-factory calls
      return new WebSocket(url, options);
    });
    sockets.push(s); return s;
  } };
}
const until = (check: () => void) => vi.waitFor(check, { timeout: 1000, interval: 5 });

describe("B-2B native loopback one-connection contract (no production or Secrets)", () => {
  it.each(["open-close", "refuse", "auth", "subscribed-close"] as const)(
    "%s: one actual WS attempt, no reconnect reservation, no residual TCP connection", async mode => {
      const s = await server(mode === "refuse" || mode === "auth" ? mode : "normal");
      const clock = new ObservedClock(), native = countedFactory(s.target, clock);
      let subscriptions = 0;
      s.ws.on("connection", peer => {
        if (mode === "open-close") peer.close(1000);
        if (mode === "subscribed-close") peer.once("message", data => {
          expect(JSON.parse(data.toString())).toEqual({ op: "subscribe", channel: "ticks", symbols: ["NQ"] });
          subscriptions++; peer.close(1000);
        });
      });
      try {
        const r = await runGateB2Session(s.target, authorization(), { clock, artificial: { socketFactory: native.factory } });
        expect(r.connectionPolicy).toEqual(B2_CONNECTION_POLICY);
        expect(r.reason).toBe(mode === "auth" ? "AUTH_REJECTED" : mode === "refuse" ? "NETWORK_FAILURE" : "RECONNECT_LIMIT");
        expect(r.transport.counters).toMatchObject({ connectionAttempts: 1, reconnectAttempts: 0 });
        expect(native.dials).toBe(1); expect(s.tcpAttempts).toBe(1);
        if (mode === "subscribed-close") expect(subscriptions).toBe(1);
        // Inspect ALL scheduling requests, including ones which might have been cancelled.
        expect(clock.requests).not.toContain(LIMITS.reconnectMs);
        clock.advance(2 * LIMITS.wallMs);
        await until(() => expect(s.tcp.size).toBe(0));
        expect(native.dials).toBe(1); expect(clock.scheduled).toBe(0); expect(s.ws.clients.size).toBe(0);
      } finally { native.sockets.forEach(x => x.terminate()); await s.close(); }
    });
  it("reaches the real 60,000ms policy boundary with a controlled clock and native loopback WS", async () => {
    const s = await server(), clock = new ObservedClock(), native = countedFactory(s.target, clock);
    let peer: WebSocket | undefined, active = false;
    s.ws.on("connection", p => { peer = p; });
    try {
      const work = runGateB2Session(s.target, authorization(), { clock, artificial: { socketFactory: native.factory },
        onActive: () => { active = true; } });
      await until(() => { expect(peer).toBeDefined(); expect(active).toBe(true); });
      // Keep the independent heartbeat guard satisfied; do not shorten the 60s budget.
      for (let n = 0; n < 2; n++) {
        clock.advance(29000);
        const pong = once(peer!, "pong"); peer!.ping(); await pong;
      }
      clock.advance(2000);
      const r = await work;
      expect(r.reason).toBe("ACTIVE_TIME_LIMIT"); expect(r.transport.activeBudgetElapsedMs).toBe(60000);
      expect(r.transport.counters).toMatchObject({ connectionAttempts: 1, reconnectAttempts: 0 });
      expect(clock.requests).not.toContain(LIMITS.reconnectMs);
      clock.advance(2 * LIMITS.wallMs); await until(() => expect(s.tcp.size).toBe(0));
      expect(native.dials).toBe(1); expect(clock.scheduled).toBe(0);
    } finally { native.sockets.forEach(x => x.terminate()); await s.close(); }
  });
  it("a supervisor stop before start cannot create even the first native WS", async () => {
    const s = await server(), clock = new ObservedClock(), native = countedFactory(s.target, clock);
    try {
      const r = await runGateB2Session(s.target, authorization(), { clock, artificial: { socketFactory: native.factory },
        onStopReady: stop => stop("CTRL_C") });
      expect(r.reason).toBe("CTRL_C"); expect(native.dials).toBe(0); expect(s.tcpAttempts).toBe(0);
      expect(r.transport.counters).toMatchObject({ connectionAttempts: 0, reconnectAttempts: 0 });
      expect(clock.requests).toEqual([]);
    } finally { await s.close(); }
  });
  it("watchdog SIGKILL ends a real connected child; no child restart or second WS attempt", async () => {
    const s = await server();
    let starts = 0, exits = 0;
    try {
      const r = await isolatedB2({ spawn: () => {
        starts++;
        const child = spawn(process.execPath, ["-e", `
          const WebSocket=require("ws");
          process.on("message",m=>{if(m.type==="START"){
            const ws=new WebSocket(${JSON.stringify(s.target.endpoint)});
            ws.on("error",()=>process.exit(1));
            ws.on("open",()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));
          }});`], { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] });
        child.once("exit", () => { exits++; }); return child;
      }, decode: () => null, budgetMs: 1500, cleanupMs: 100 });
      expect(r.forced).toBe(true); expect(r.reason).toMatch(/WALL_TIME_LIMIT|FORCED_TERMINATION/);
      expect(starts).toBe(1); expect(exits).toBe(1);
      expect(s.tcpAttempts).toBe(1); expect(s.upgrades).toBe(1);
      await until(() => expect(s.tcp.size).toBe(0)); expect(s.ws.clients.size).toBe(0);
    } finally { await s.close(); }
  });
  it("unchanged RAM-only Gate B still reserves and performs its one allowed reconnect", async () => {
    const s = await server(), clock = new ObservedClock(), native = countedFactory(s.target, clock);
    let accepted = 0;
    s.ws.on("connection", peer => { if (++accepted === 1) peer.close(1000); });
    const pipeline = new GateBTicks(clock, native.factory, "LOOPBACK_TEST");
    try {
      expect(LIMITS.reconnects).toBe(1);
      pipeline.start();
      await until(() => expect(clock.requests).toContain(LIMITS.reconnectMs));
      expect(native.dials).toBe(1);
      clock.advance(LIMITS.reconnectMs);
      await until(() => expect(accepted).toBe(2));
      expect(native.dials).toBe(2);
      expect(pipeline.report().counters).toMatchObject({ connectionAttempts: 2, reconnectAttempts: 1 });
      pipeline.finish();
      await Promise.all(native.sockets.map(x => x.closed));
      await until(() => expect(s.tcp.size).toBe(0));
    } finally { pipeline.stop("CTRL_C"); native.sockets.forEach(x => x.terminate()); await s.close(); }
  });
  it.each([[], ["dev"], ["build"], ["test"]])("default/non-live entry %j holds with native network disabled", async (...args: string[]) => {
    const script = fileURLToPath(new URL("./gateB2Process.ts", import.meta.url));
    const blocker = `import net from 'node:net';net.Socket.prototype.connect=function(){throw Error('NETWORK_FORBIDDEN')};`;
    const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(blocker)}`,
      "--experimental-transform-types", "--disable-warning=ExperimentalWarning", script, ...args],
    { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    const [code] = await once(child, "close");
    expect(code).toBe(0); expect(JSON.parse(stdout)).toMatchObject({ phase: "HOLD", reason: "LIVE_MODE_REQUIRED" });
    expect(stderr).not.toContain("NETWORK_FORBIDDEN");
  });
  it("normal dev/build/test scripts never opt into explicit LIVE capture", () => {
    for (const path of ["../../../package.json", "../package.json", "../../../apps/web/package.json"]) {
      const { scripts } = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
      for (const name of ["dev", "build", "test"]) {
        expect(scripts?.[name] ?? "").not.toMatch(/execute-live-storage-trial|confirm-nq-ticks-permission|gate:b2b/);
      }
    }
  });
});
