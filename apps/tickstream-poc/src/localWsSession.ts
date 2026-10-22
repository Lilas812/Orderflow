import { WebSocketServer, type WebSocket } from "ws";
import { LIMITS, Transport, type Clock } from "./transport";
import { readReport, type Report } from "./diagnostics";
import { unavailableReport, syntheticTick } from "./session";
import { WsClient, WS_OPTIONS, WIRE_KEYS, emptyWireCounters, type WireCounters } from "./wsClient";

/** The single extra file: finite loopback server/CLI orchestration and report projection. */
export class RealClock implements Clock {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  monoNs(): bigint { return process.hrtime.bigint(); }
  utcMs(): number { return Date.now(); }
  get scheduled(): number { return this.timers.size; }
  schedule(ms: number, callback: () => void): () => void {
    const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, ms);
    this.timers.add(timer);
    return () => { clearTimeout(timer); this.timers.delete(timer); };
  }
}

export async function localServer(onConnection: (socket: WebSocket) => void): Promise<{
  url: string; server: WebSocketServer; close(): Promise<void>;
}> {
  const server = new WebSocketServer({
    host: "127.0.0.1", port: 0, clientTracking: true,
    maxPayload: WS_OPTIONS.maxPayload, maxFragments: WS_OPTIONS.maxFragments,
    maxBufferedChunks: WS_OPTIONS.maxBufferedChunks,
    perMessageDeflate: false, skipUTF8Validation: false, autoPong: true,
  });
  server.on("connection", socket => {
    // Test server errors/close reasons must never reach stderr.
    socket.on("error", () => {});
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    const error = (): void => { server.close(); reject(new Error("LOCAL_SERVER_FAILURE")); };
    server.once("error", error);
    server.once("listening", () => { server.removeListener("error", error); resolve(); });
  });
  server.on("error", () => {});
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close(); throw new Error("LOCAL_SERVER_FAILURE");
  }
  let closed: Promise<void> | undefined;
  return {
    url: `ws://127.0.0.1:${address.port}/`, server,
    close() {
      closed ??= (async () => {
        const peers = [...server.clients].map(socket => new Promise<void>(resolve => {
          if (socket.readyState === socket.CLOSED) { resolve(); return; }
          socket.once("close", () => resolve());
          socket.terminate();
        }));
        // ws's HTTP server-close callback can precede individual socket closes.
        // Await both instead of reporting cleanup while clients remain tracked.
        const listener = new Promise<void>(resolve => server.close(() => resolve()));
        await Promise.all([listener, ...peers]);
      })();
      return closed;
    },
  };
}

export type LocalReport = Omit<Report, "schema" | "network"> & {
  readonly schema: "ORDERFLOW_LOCAL_WEBSOCKET_V1";
  readonly network: "LOOPBACK_ONLY";
  readonly wire: WireCounters | null;
  readonly evidence: {
    readonly connectionOpen: "OBSERVED" | "NOT_OBSERVED" | "NOT_MEASURED";
    readonly subscriptionSend: "OBSERVED" | "NOT_OBSERVED" | "NOT_MEASURED";
    readonly subscriptionConfirmed: "UNCONFIRMED";
    readonly firstSyntheticTrade: "OBSERVED" | "NOT_OBSERVED" | "NOT_MEASURED";
  };
};
/**
 * Reuse P2-B's complete whitelist/counters, not its network=DISABLED label.
 * Only this local outer schema changes; diagnostics.ts and synthetic output stay fixed.
 */
export function localReport(base: Report, wire: WireCounters | null): LocalReport {
  const safe = readReport(base);
  if (!safe) throw new Error("LOCAL_REPORT_SCHEMA");
  const { schema: _schema, network: _network, ...common } = safe;
  return {
    ...common, schema: "ORDERFLOW_LOCAL_WEBSOCKET_V1", network: "LOOPBACK_ONLY",
    wire: wire === null ? null : Object.fromEntries(WIRE_KEYS.map(key => [key, wire[key]])) as WireCounters,
    evidence: {
      connectionOpen: wire === null ? "NOT_MEASURED" : wire.opens > 0 ? "OBSERVED" : "NOT_OBSERVED",
      subscriptionSend: wire === null ? "NOT_MEASURED" : wire.subscriptionSent > 0 ? "OBSERVED" : "NOT_OBSERVED",
      subscriptionConfirmed: "UNCONFIRMED",
      firstSyntheticTrade: safe.counters === null ? "NOT_MEASURED" :
        safe.counters.accepted > 0 ? "OBSERVED" : "NOT_OBSERVED",
    },
  };
}
export function readLocalReport(input: unknown): LocalReport | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const fields = input as Record<string, unknown>;
  if (fields.schema !== "ORDERFLOW_LOCAL_WEBSOCKET_V1" || fields.network !== "LOOPBACK_ONLY") return null;
  // The base whitelist validates every common column; no untrusted key is emitted.
  const base = readReport({ ...fields, schema: "ORDERFLOW_SYNTHETIC_TRANSPORT_V1", network: "DISABLED" });
  if (!base) return null;
  let wire: WireCounters | null = null;
  if (fields.wire !== null) {
    if (!fields.wire || typeof fields.wire !== "object" || Array.isArray(fields.wire)) return null;
    wire = emptyWireCounters();
    for (const key of WIRE_KEYS) {
      const value = (fields.wire as Record<string, unknown>)[key];
      if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
      wire[key] = value as number;
    }
  }
  return localReport(base, wire);
}
export function unavailableLocalReport(reason: Parameters<typeof unavailableReport>[0]): LocalReport {
  return localReport(unavailableReport(reason), null);
}

/** Real clock timestamps describe local receive time, not provider/network quality. */
export async function localWsSession(): Promise<LocalReport> {
  const clock = new RealClock(), wire = emptyWireCounters();
  let serverSawProtocolPong = false, serverSawJsonPong = false;
  const local = await localServer(socket => {
    let subscribed = false;
    socket.on("pong", bytes => { if (bytes.equals(Buffer.from("LOCAL_PROTOCOL_PROBE"))) serverSawProtocolPong = true; });
    socket.on("message", (bytes, binary) => {
      if (binary || !Buffer.isBuffer(bytes) || bytes.byteLength > 4096) { socket.terminate(); return; }
      // Local fixed script only. No arbitrary fields/strings appear in the report.
      if (!subscribed && bytes.equals(Buffer.from('{"op":"subscribe","channel":"ticks","symbols":["NQ"]}'))) {
        subscribed = true;
        const tick = { ...JSON.parse(new TextDecoder().decode(syntheticTick())),
          ts: Math.floor(clock.utcMs() / 1000) - 900 };
        socket.send(JSON.stringify(tick));
        socket.send('{"type":"ping"}');
        socket.ping("LOCAL_PROTOCOL_PROBE");
        socket.pong("LOCAL_UNSOLICITED_PONG");
        const text = JSON.stringify(tick), middle = Math.floor(text.length / 2);
        socket.send(text.slice(0, middle), { fin: false, binary: false });
        socket.send(text.slice(middle), { fin: true, binary: false });
      } else if (bytes.equals(Buffer.from('{"op":"pong"}'))) serverSawJsonPong = true;
      else socket.terminate();
    });
  });
  const clients: WsClient[] = [];
  let transport: Transport;
  transport = new Transport(clock, () => {
    const client = new WsClient(local.url, clock,
      () => ({ count: transport.pendingCount, bytes: transport.pendingBytes }), wire);
    clients.push(client); return client;
  });
  try {
    transport.start();
    await new Promise<void>(resolve => {
      const inspect = (): void => {
        if (transport.terminal) { resolve(); return; }
        if (transport.diagnostics.accepted === 2 && wire.subscriptionSent === 1 &&
          wire.protocolPing === 1 && wire.protocolPong === 1 && wire.jsonPongSent === 1 &&
          serverSawProtocolPong && serverSawJsonPong) {
          transport.stop(); resolve(); return;
        }
        clock.schedule(2, inspect);
      };
      inspect();
    });
  } finally {
    if (!transport.terminal) transport.stop("SESSION_FAILURE", true);
    await local.close();
    await Promise.all(clients.map(client => client.closed));
  }
  // Construct final counters after server AND client close events, not before.
  return localReport(transport.report(), wire);
}
