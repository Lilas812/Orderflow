import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  DOCUMENTATION_REVIEW, RIGHTS_REVIEW, LIVE_BLOCKERS, LIVE_SAFETY_POLICY,
  PLANNED_DIAGNOSTIC_COUNTERS, checkLiveEndpoint, liveConnectionGate,
  preparationDiagnostics, prepareLiveConfig,
} from "./liveConfig";
import { LIMITS } from "./transport";
import { WS_OPTIONS, loopbackUrl } from "./wsClient";
import { syntheticSession, watchdog } from "./session";

const candidate = "wss://stream.tick-stream.xyz/v1/stream";
const prepared = (input: unknown = {}) => {
  const result = prepareLiveConfig(input);
  if (result.status !== "PREPARED_DISABLED") throw new Error("TEST_EXPECTED_DISABLED_CONFIG");
  return result.config;
};

describe("offline official-spec review, not a live entitlement assertion", () => {
  it("records both incompatible paths and never selects an endpoint", () => {
    expect(DOCUMENTATION_REVIEW.endpoint).toEqual({
      decision: "HOLD_DOCUMENTATION_PATH_CONFLICT", documentedCandidate: candidate,
      authenticationExample: "wss://stream.tick-stream.xyz/v1",
      relationship: "UNEXPLAINED_NO_PROBING", selectedEndpoint: null, fallback: "FORBIDDEN",
    });
    expect(Object.keys(DOCUMENTATION_REVIEW.sources)).toHaveLength(6);
  });
  it("distinguishes reported plan and published limits from account verification", () => {
    expect(DOCUMENTATION_REVIEW.entitlement).toMatchObject({
      plan: "REALTIME_PLUS_L2_USER_REPORTED_NOT_ACCOUNT_VERIFIED",
      documentedConnections: 3, documentedSubscriptionLimit: "UNLIMITED",
      accountClassification: "UNVERIFIED", runtimeStatus: "NOT_QUERIED",
    });
    expect(RIGHTS_REVIEW.decision).toBe("HOLD_ACCOUNT_AND_USAGE_SCOPE_UNCONFIRMED");
  });
  it("keeps second precision, contract uncertainty, coalescing and unknown completeness", () => {
    expect(DOCUMENTATION_REVIEW.protocol.timestampUnit).toBe("s");
    expect(DOCUMENTATION_REVIEW.interpretation).toMatchObject({
      contract: null, providerSequence: "UNAVAILABLE", providerTradeId: "UNAVAILABLE",
      completeness: "UNKNOWN", sequenceContinuity: "UNVERIFIED",
      book: "COALESCED_FULL_SNAPSHOTS_NOT_INCREMENTAL_UPDATES",
      intermediateUpdates: "UNOBSERVED", snapshotDifferenceAsOrderAddCancelModify: "FORBIDDEN",
      productionValidityPromotion: "NOT_IMPLEMENTED_EXISTING_CONTRACTS_UNCHANGED",
    });
  });
  it("records control/error semantics without treating HTTP403 as just a bad key", () => {
    expect(DOCUMENTATION_REVIEW.authentication.http403).toBe("ENTITLEMENT_OR_ACCOUNT_REFUSAL_NOT_JUST_INVALID_KEY");
    expect(DOCUMENTATION_REVIEW.protocol).toMatchObject({
      jsonPingIntervalMs: 15_000, protocolPingIntervalMs: 15_000, idleCloseMs: 45_000,
      explicitSubscriptionAck: "NOT_DOCUMENTED", subscriptionErrors: "ERROR_FRAME_SOCKET_MAY_REMAIN_OPEN",
    });
  });
  it("does not infer storage/replay/redistribution permissions from the plan", () => {
    expect(RIGHTS_REVIEW).toHaveProperty("replitNodeReceive", "CLOUD_EXECUTION_SCOPE_UNCONFIRMED");
    expect(RIGHTS_REVIEW).toHaveProperty("historicalReplay", "NO_BLANKET_PERMISSION_CONFIRMED");
    expect(RIGHTS_REVIEW).toHaveProperty("thirdPartyRedistribution", "PROHIBITED_BY_DEFAULT_NO_FUTURES_GRANT_CONFIRMED");
    expect(Object.keys(RIGHTS_REVIEW)).toHaveLength(11);
  });
});

describe("candidate-only exact WSS allowlist; no endpoint probing or fallback", () => {
  it("accepts only a documented candidate, never an executable connection", () => {
    expect(checkLiveEndpoint(candidate)).toEqual({ status: "DOCUMENTED_CANDIDATE_ONLY", connectionEnabled: false });
    expect(prepared().selectedEndpoint).toBeNull();
    expect(() => loopbackUrl(candidate)).toThrow("LOOPBACK_ENDPOINT_REQUIRED");
  });
  it.each([
    "ws://stream.tick-stream.xyz/v1/stream", "http://stream.tick-stream.xyz/v1/stream",
    "https://stream.tick-stream.xyz/v1/stream", "file:///tmp/local", "not-a-url",
  ])("rejects non-WSS input without echoing it", input => {
    expect(checkLiveEndpoint(input)).toEqual({ status: "REJECTED_CONFIG", reason: "WSS_REQUIRED" });
  });
  it.each([
    "wss://stream.tick-stream.xyz/v1",
    "wss://stream.tick-stream.xyz/v1/stream/",
    "wss://stream.tick-stream.xyz:443/v1/stream",
    "wss://stream.tick-stream.xyz/v1/%73tream",
    "wss://stream.tick-stream.xyz/v1/stream?key=SECRET_SENTINEL",
    "wss://stream.tick-stream.xyz/v1/stream#SECRET_SENTINEL",
    "wss://SECRET_SENTINEL@stream.tick-stream.xyz/v1/stream",
    "wss://stream.tick-stream.xyz.EXTERNAL.invalid/v1/stream",
    "wss://api.tick-stream.xyz/v1/stream",
    "wss://127.0.0.1:12345/v1/stream",
    "wss://localhost:12345/v1/stream",
  ])("rejects aliases, credentials, redirects and non-allowlisted routes", input => {
    const result = prepareLiveConfig({ endpoint: input });
    expect(result).toEqual({ status: "REJECTED_CONFIG", reason: "ENDPOINT_NOT_ALLOWLISTED" });
    expect(JSON.stringify(preparationDiagnostics({ endpoint: input }))).not.toMatch(/SENTINEL|key=|wss:\/\//);
  });
  it.each([null, undefined, 1, {}, [], new URL(candidate)])("does not coerce endpoint objects to strings", input => {
    expect(checkLiveEndpoint(input)).toEqual({ status: "REJECTED_CONFIG", reason: "ENDPOINT_NOT_ALLOWLISTED" });
  });
});

describe("immutable preparation only; flags never unlock a live path", () => {
  it("prepares ticks/book without subscribing, reading a key or selecting an endpoint", () => {
    const config = prepared({ channels: ["ticks", "book"] });
    expect(config.connectionEnabled).toBe(false);
    expect(config.subscriptionPlan).toEqual([
      { op: "subscribe", channel: "ticks", symbols: ["NQ"] },
      { op: "subscribe", channel: "book", symbols: ["NQ"] },
    ]);
    expect(config.plannedSubscriptionSlots).toBe(2);
    expect(config.plannedSchemaProfiles).toEqual({ ticks: "WS_TICK_LIVE_V1", book: "WS_BOOK_LIVE_V1" });
    expect(config.contract).toBeNull();
  });
  it.each(["ticks", "book"] as const)("permits a single-channel plan %s only as disabled metadata", channel => {
    expect(prepared({ symbol: "NQ", endpoint: candidate, channels: [channel] }).plannedChannels).toEqual([channel]);
  });
  it.each([
    { enabled: true }, { live: true }, { smokeLive: true }, { rejectUnauthorized: false },
    { followRedirects: true }, { perMessageDeflate: true }, { proxy: "SECRET_SENTINEL" },
    { apiKey: "SECRET_SENTINEL" }, { TICKSTREAM_API_KEY: "SECRET_SENTINEL" },
    { safety: { rejectUnauthorized: false } }, { limits: { messageBytes: Infinity } },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { HTTPS_PROXY: "SECRET_SENTINEL" },
  ])("rejects runtime safety/credential/environment-like overrides", input => {
    expect(prepareLiveConfig(input)).toEqual({ status: "REJECTED_CONFIG", reason: "UNKNOWN_SETTING" });
    expect(liveConnectionGate(input)).toEqual({ decision: "BLOCKED", reason: "P2_C3_CODE_CHANGE_REQUIRED" });
    expect(JSON.stringify(preparationDiagnostics(input))).not.toMatch(/SENTINEL/);
  });
  it.each([null, true, [], "SECRET_SENTINEL", new Date(), Object.create({ live: true })])(
    "rejects non-plain configuration without coercion", input => {
      expect(prepareLiveConfig(input)).toEqual({ status: "REJECTED_CONFIG", reason: "INVALID_CONFIG" });
    },
  );
  it.each(["ES", "NQM7", "", null, 1])("rejects unsupported symbol", symbol => {
    expect(prepareLiveConfig({ symbol })).toEqual({ status: "REJECTED_CONFIG", reason: "INVALID_SYMBOL" });
  });
  it.each([[], ["ticks", "ticks"], ["ticks", "book", "book"], ["l3"], ["TICKS"], null, "ticks"])(
    "rejects invalid channels without silent deduplication", channels => {
      expect(prepareLiveConfig({ channels })).toEqual({ status: "REJECTED_CONFIG", reason: "INVALID_CHANNELS" });
    },
  );
  it("does not read artificial credential getters, environment flags or connection capabilities", () => {
    const trap = vi.fn(() => { throw new Error("SECRET_SENTINEL"); });
    const input = Object.defineProperty({}, "TICKSTREAM_API_KEY", { get: trap });
    expect(prepareLiveConfig(input)).toMatchObject({ status: "REJECTED_CONFIG", reason: "UNKNOWN_SETTING" });
    expect(liveConnectionGate(input).decision).toBe("BLOCKED");
    expect(trap).not.toHaveBeenCalled();
    // These are artificial capabilities, NOT real Secrets/environment access.
    expect(liveConnectionGate({ readSecret: trap, connect: trap, approved: true }).decision).toBe("BLOCKED");
    expect(trap).not.toHaveBeenCalled();
  });
  it("rejects allowed-name accessors and contains hostile Proxy exceptions", () => {
    const trap = vi.fn(() => { throw new Error("RAW_EXCEPTION_SENTINEL"); });
    const input = Object.defineProperty({}, "endpoint", { get: trap });
    expect(prepareLiveConfig(input)).toMatchObject({ status: "REJECTED_CONFIG", reason: "INVALID_CONFIG" });
    expect(trap).not.toHaveBeenCalled();
    const hostile = new Proxy({}, { ownKeys: trap });
    expect(prepareLiveConfig(hostile)).toEqual({ status: "REJECTED_CONFIG", reason: "INVALID_CONFIG" });
    expect(JSON.stringify(preparationDiagnostics(hostile))).not.toMatch(/SENTINEL|stack/);
  });
  it("does not invoke array accessors, toJSON or an iterator", () => {
    const trap = vi.fn(() => { throw new Error("SECRET_SENTINEL"); });
    const channels = ["ticks"];
    Object.defineProperty(channels, "0", { get: trap });
    expect(prepareLiveConfig({ channels })).toMatchObject({ status: "REJECTED_CONFIG", reason: "INVALID_CHANNELS" });
    expect(liveConnectionGate({ toJSON: trap, [Symbol.iterator]: trap }).decision).toBe("BLOCKED");
    expect(trap).not.toHaveBeenCalled();
  });
  it("copies and freezes every configuration branch without freezing caller input", () => {
    const channels = ["ticks"];
    const config = prepared({ channels }); channels[0] = "book";
    expect(config.plannedChannels).toEqual(["ticks"]);
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      Object.values(value).forEach(visit);
    };
    visit(config);
    expect(Reflect.set(config, "connectionEnabled", true)).toBe(false);
    expect(Reflect.set(config.safety, "rejectUnauthorized", false)).toBe(false);
    expect(liveConnectionGate({ ...config, connectionEnabled: true }).decision).toBe("BLOCKED");
  });
});

describe("existing safety contracts and no live measurements", () => {
  it("reuses limits by identity and preserves every approved bound", () => {
    expect(LIVE_SAFETY_POLICY.limits).toBe(LIMITS);
    expect(LIVE_SAFETY_POLICY.limits).toMatchObject({
      messageBytes: 1048576, queueCount: 128, queueBytes: 8388608,
      messages: 1000, payloadBytes: 67108864, activeMs: 60000, wallMs: 120000,
      handshakeMs: 10000, heartbeatMs: 30000, reconnects: 1, reconnectMs: 46000, cleanupMs: 2000,
      sessionRss: 268435456, totalRss: 402653184,
    });
    expect(LIVE_SAFETY_POLICY).toMatchObject({
      maxFragments: WS_OPTIONS.maxFragments, maxBufferedChunks: WS_OPTIONS.maxBufferedChunks,
      rejectUnauthorized: true, followRedirects: false, maxRedirects: 0,
      perMessageDeflate: false, skipUTF8Validation: false, binaryPolicy: "REJECT",
    });
  });
  it("keeps preparation disconnected even when fetch and WebSocket constructors throw", () => {
    const deny = vi.fn(() => { throw new Error("NETWORK_FORBIDDEN"); });
    vi.stubGlobal("fetch", deny); vi.stubGlobal("WebSocket", deny);
    try {
      expect(prepared().connectionEnabled).toBe(false);
      expect(preparationDiagnostics().decision).toBe("HOLD");
      expect(liveConnectionGate({ run: true }).decision).toBe("BLOCKED");
      expect(deny).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("contains no secret reader, URL builder, socket import, CLI hook or live dependency", () => {
    const source = readFileSync(new URL("./liveConfig.ts", import.meta.url), "utf8");
    const imports = source.match(/^import .*$/gm);
    expect(imports).toEqual(['import { LIMITS } from "./transport";']);
    expect(source).not.toMatch(/process\s*[.[]|import\s*\(|new\s+(WebSocket|URL)|fetch\s*\(|console\s*\./);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.scripts).not.toHaveProperty("smoke:live");
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@workspace/tickstream-adapter", "@workspace/tickstream-storage", "ws"]);
    const runner = readFileSync(new URL("./poc.ts", import.meta.url), "utf8");
    expect(runner).not.toContain("liveConfig");
  });
  it("outputs only fixed preparation statuses, no live zero counters or sensitive inputs", () => {
    const report = preparationDiagnostics({ endpoint: `${candidate}?key=SECRET_SENTINEL` });
    expect(report).toMatchObject({
      network: "DISABLED", sessionStatus: "NOT_RUNNING",
      authenticationOutcome: "NOT_ATTEMPTED", subscriptionSendOutcome: "NOT_ATTEMPTED",
      firstObservationOutcome: "NOT_ATTEMPTED", counters: null, memoryMeasurement: "NOT_MEASURED",
      entitlementStatus: "USER_REPORTED_NOT_VERIFIED", marketMissingEvents: "NOT_MEASURABLE",
      contract: null, providerSequence: "UNAVAILABLE", stopReason: "NOT_STARTED", decision: "HOLD",
    });
    expect(JSON.stringify(report)).not.toMatch(/SENTINEL|key=|wss:|stack|price|size|side/);
    expect(PLANNED_DIAGNOSTIC_COUNTERS).toHaveLength(10);
    expect(LIVE_BLOCKERS).toContain("LIVE_TRANSPORT_AND_PROVENANCE_NOT_IMPLEMENTED");
  });
  it("does not change the existing offline synthetic behavior or watchdog", () => {
    expect(syntheticSession()).toMatchObject({
      network: "DISABLED", state: "STOPPED", stopReason: "COMPLETED",
      counters: { accepted: 2, control: 1, pending: 0, accountingMatches: true },
    });
    expect(watchdog({ elapsedMs: 0, stopElapsedMs: null, sessionRss: null, totalRss: null }))
      .toEqual({ kind: "REQUEST_STOP", reason: "MEMORY_NOT_MEASURED" });
    expect(watchdog({ elapsedMs: 120000, stopElapsedMs: null, sessionRss: 1, totalRss: 2 }))
      .toEqual({ kind: "FORCE_TERMINATE", reason: "FORCED_TERMINATION" });
  });
});
