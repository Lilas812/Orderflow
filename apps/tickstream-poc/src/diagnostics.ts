import { REASON_CODES } from "@workspace/tickstream-adapter/envelope";

export const TRANSPORT_REASONS = [
  "COMPLETED", "HANDSHAKE_TIMEOUT", "AUTH_REJECTED", "SUBSCRIPTION_REJECTED",
  "HEARTBEAT_TIMEOUT", "QUEUE_COUNT_LIMIT", "QUEUE_BYTE_LIMIT",
  "MESSAGE_LIMIT", "PAYLOAD_LIMIT", "ACTIVE_TIME_LIMIT", "WALL_TIME_LIMIT",
  "SOCKET_ERROR", "REMOTE_CLOSE", "RECONNECT_LIMIT", "CTRL_C",
  "PARSER_EXCEPTION", "TIMESTAMP_CONTEXT_MISMATCH", "FRAGMENT_PROTOCOL",
  "FRAGMENT_LIMIT", "UNSUPPORTED_CONTROL", "MEMORY_THRESHOLD",
  "MEMORY_NOT_MEASURED", "FORCED_TERMINATION", "SESSION_FAILURE",
] as const;
export type StopReason = typeof TRANSPORT_REASONS[number] | typeof REASON_CODES[number];
export type Family = "tick" | "ping" | "pong" | "welcome" | "error" | "warning" | "feed" | "OTHER";
const FAMILIES: readonly Family[] = ["tick", "ping", "pong", "welcome", "error", "warning", "feed", "OTHER"];
export const STATES = [
  "IDLE", "CONNECTING", "CONNECTED", "SUBSCRIBING", "RUNNING", "INTERRUPTED",
  "RECONNECT_WAIT", "STOPPING", "STOPPED", "FAILED",
] as const;
export type State = typeof STATES[number];
const REASONS: readonly StopReason[] = [...REASON_CODES, ...TRANSPORT_REASONS];
function zeros<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>;
}

export interface Report {
  readonly schema: "ORDERFLOW_SYNTHETIC_TRANSPORT_V1";
  readonly source: "SYNTHETIC_TEST";
  readonly network: "DISABLED";
  readonly persistence: "DISABLED";
  readonly state: State;
  readonly stopReason: StopReason;
  readonly marketMissingEvents: "NOT_MEASURABLE";
  readonly providerSequence: "UNAVAILABLE";
  readonly contract: null;
  readonly memory: {
    readonly measurement: "MEASURED" | "NOT_MEASURED";
    readonly sessionRssPeak: number | null;
    readonly totalRssPeak: number | null;
    readonly kind: "MONITORING_THRESHOLD_NOT_OS_HARD_LIMIT";
  };
  readonly counters: null | {
    readonly connectionAttempts: number;
    readonly reconnectAttempts: number;
    readonly subscriptionAttempts: number;
    readonly receivedMessages: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly control: number;
    readonly unprocessed: number;
    readonly pending: number;
    readonly payloadBytes: number;
    readonly queuePeakCount: number;
    readonly queuePeakBytes: number;
    readonly fragmentPeakBytes: number;
    readonly heartbeatCount: number;
    readonly closeCount: number;
    readonly errorCount: number;
    readonly reasonCounts: Record<StopReason, number>;
    readonly familyCounts: Record<Family, number>;
    readonly receiveIntervalBuckets: readonly number[];
    readonly providerAgeBuckets: readonly number[];
    readonly stateVisits: Record<State, number>;
    readonly accountingMatches: boolean;
  };
}

/** Only fixed keys and numeric counters cross the report boundary. Never copy payload/errors. */
export class Diagnostics {
  connectionAttempts = 0;
  reconnectAttempts = 0;
  subscriptionAttempts = 0;
  receivedMessages = 0;
  accepted = 0;
  rejected = 0;
  control = 0;
  unprocessed = 0;
  payloadBytes = 0;
  queuePeakCount = 0;
  queuePeakBytes = 0;
  fragmentPeakBytes = 0;
  heartbeatCount = 0;
  closeCount = 0;
  errorCount = 0;
  private readonly reasons = zeros(REASONS);
  private readonly families = zeros(FAMILIES);
  private readonly visits = zeros(STATES);
  // Fixed histograms, not retained samples. Intervals: <1, <10, <100, <1000, >=1000 ms.
  private readonly intervals = [0, 0, 0, 0, 0];
  // Provider age: future, <1s, <60s, <1h, >=1h. NOT network latency.
  private readonly ages = [0, 0, 0, 0, 0];
  private lastReceive: bigint | undefined;
  private sessionPeak: number | null = null;
  private totalPeak: number | null = null;
  private measurementFailed = false;

  reason(reason: StopReason): void { this.reasons[reason]++; }
  family(value: unknown): void {
    const key = typeof value === "string" && FAMILIES.includes(value as Family) ? value as Family : "OTHER";
    this.families[key]++;
  }
  visit(state: State): void { this.visits[state]++; }
  receive(bytes: number, mono: bigint): void {
    this.receivedMessages++;
    this.payloadBytes += bytes;
    if (this.lastReceive !== undefined) {
      const delta = mono - this.lastReceive;
      const index = delta < 1_000_000n ? 0 : delta < 10_000_000n ? 1 :
        delta < 100_000_000n ? 2 : delta < 1_000_000_000n ? 3 : 4;
      this.intervals[index]++;
    }
    this.lastReceive = mono;
  }
  addFragmentBytes(bytes: number): void { this.payloadBytes += bytes; }
  age(ns: bigint): void {
    this.ages[ns < 0n ? 0 : ns < 1_000_000_000n ? 1 : ns < 60_000_000_000n ? 2 :
      ns < 3_600_000_000_000n ? 3 : 4]++;
  }
  peaks(count: number, bytes: number, fragmentBytes: number): void {
    this.queuePeakCount = Math.max(this.queuePeakCount, count);
    this.queuePeakBytes = Math.max(this.queuePeakBytes, bytes);
    this.fragmentPeakBytes = Math.max(this.fragmentPeakBytes, fragmentBytes);
  }
  memory(session: number | null, total: number | null): void {
    if (session === null || total === null || !Number.isSafeInteger(session) ||
      !Number.isSafeInteger(total) || session < 0 || total < session) {
      this.measurementFailed = true;
      return;
    }
    this.sessionPeak = Math.max(this.sessionPeak ?? 0, session);
    this.totalPeak = Math.max(this.totalPeak ?? 0, total);
  }
  report(state: State, stopReason: StopReason, pending: number, measuredCounters = true): Report {
    return {
      schema: "ORDERFLOW_SYNTHETIC_TRANSPORT_V1", source: "SYNTHETIC_TEST",
      network: "DISABLED", persistence: "DISABLED", state, stopReason,
      marketMissingEvents: "NOT_MEASURABLE", providerSequence: "UNAVAILABLE", contract: null,
      memory: {
        measurement: !this.measurementFailed && this.sessionPeak !== null ? "MEASURED" : "NOT_MEASURED",
        sessionRssPeak: this.sessionPeak, totalRssPeak: this.totalPeak,
        kind: "MONITORING_THRESHOLD_NOT_OS_HARD_LIMIT",
      },
      counters: measuredCounters ? {
        connectionAttempts: this.connectionAttempts, reconnectAttempts: this.reconnectAttempts,
        subscriptionAttempts: this.subscriptionAttempts, receivedMessages: this.receivedMessages,
        accepted: this.accepted, rejected: this.rejected, control: this.control,
        unprocessed: this.unprocessed, pending, payloadBytes: this.payloadBytes,
        queuePeakCount: this.queuePeakCount, queuePeakBytes: this.queuePeakBytes,
        fragmentPeakBytes: this.fragmentPeakBytes, heartbeatCount: this.heartbeatCount,
        closeCount: this.closeCount, errorCount: this.errorCount,
        reasonCounts: { ...this.reasons }, familyCounts: { ...this.families },
        receiveIntervalBuckets: [...this.intervals], providerAgeBuckets: [...this.ages],
        stateVisits: { ...this.visits },
        accountingMatches: this.receivedMessages ===
          this.accepted + this.rejected + this.control + this.unprocessed + pending,
      } : null,
    };
  }
}

/** Whitelist projection at the IPC/stdout boundary. No arbitrary strings/keys survive. */
export function readReport(input: unknown): Report | null {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("REPORT_SCHEMA");
    return value as Record<string, unknown>;
  };
  const number = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("REPORT_NUMBER");
    return value as number;
  };
  const nullable = (value: unknown): number | null => value === null ? null : number(value);
  const dictionary = <K extends string>(keys: readonly K[], value: unknown): Record<K, number> => {
    const fields = object(value);
    return Object.fromEntries(keys.map(key => [key, number(fields[key])])) as Record<K, number>;
  };
  const buckets = (value: unknown): number[] => {
    if (!Array.isArray(value) || value.length !== 5) throw new Error("REPORT_BUCKETS");
    return value.map(number);
  };
  try {
    const root = object(input), memory = object(root.memory);
    if (root.schema !== "ORDERFLOW_SYNTHETIC_TRANSPORT_V1" || root.source !== "SYNTHETIC_TEST" ||
      root.network !== "DISABLED" || root.persistence !== "DISABLED" ||
      root.marketMissingEvents !== "NOT_MEASURABLE" || root.providerSequence !== "UNAVAILABLE" ||
      root.contract !== null || !STATES.includes(root.state as State) ||
      !REASONS.includes(root.stopReason as StopReason) ||
      !["MEASURED", "NOT_MEASURED"].includes(memory.measurement as string) ||
      memory.kind !== "MONITORING_THRESHOLD_NOT_OS_HARD_LIMIT") return null;
    let counters: Report["counters"] = null;
    if (root.counters !== null) {
      const c = object(root.counters);
      const receivedMessages = number(c.receivedMessages), accepted = number(c.accepted),
        rejected = number(c.rejected), control = number(c.control),
        unprocessed = number(c.unprocessed), pending = number(c.pending);
      counters = {
        connectionAttempts: number(c.connectionAttempts), reconnectAttempts: number(c.reconnectAttempts),
        subscriptionAttempts: number(c.subscriptionAttempts), receivedMessages, accepted, rejected,
        control, unprocessed, pending, payloadBytes: number(c.payloadBytes),
        queuePeakCount: number(c.queuePeakCount), queuePeakBytes: number(c.queuePeakBytes),
        fragmentPeakBytes: number(c.fragmentPeakBytes), heartbeatCount: number(c.heartbeatCount),
        closeCount: number(c.closeCount), errorCount: number(c.errorCount),
        reasonCounts: dictionary(REASONS, c.reasonCounts), familyCounts: dictionary(FAMILIES, c.familyCounts),
        receiveIntervalBuckets: buckets(c.receiveIntervalBuckets), providerAgeBuckets: buckets(c.providerAgeBuckets),
        stateVisits: dictionary(STATES, c.stateVisits),
        accountingMatches: receivedMessages === accepted + rejected + control + unprocessed + pending,
      };
    }
    return {
      schema: "ORDERFLOW_SYNTHETIC_TRANSPORT_V1", source: "SYNTHETIC_TEST", network: "DISABLED",
      persistence: "DISABLED", state: root.state as State, stopReason: root.stopReason as StopReason,
      marketMissingEvents: "NOT_MEASURABLE", providerSequence: "UNAVAILABLE", contract: null,
      memory: {
        measurement: memory.measurement as "MEASURED" | "NOT_MEASURED",
        sessionRssPeak: nullable(memory.sessionRssPeak), totalRssPeak: nullable(memory.totalRssPeak),
        kind: "MONITORING_THRESHOLD_NOT_OS_HARD_LIMIT",
      }, counters,
    };
  } catch { return null; }
}
