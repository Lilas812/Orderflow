import { LIMITS } from "./transport";

/**
 * P2-C2 preparation ONLY. This module has no environment reader, credential,
 * authenticated URL builder, socket factory, live runner, or CLI connection.
 * P2-C3 must change code under separate approval; runtime flags cannot unlock it.
 */
const STREAM_CANDIDATE = "wss://stream.tick-stream.xyz/v1/stream";
export const DOCUMENTATION_REVIEW = Object.freeze({
  checkedAtUtc: "2026-10-22T18:53:44Z",
  sources: Object.freeze({
    introduction: "https://tick-stream.xyz/docs",
    streaming: "https://tick-stream.xyz/docs/streaming",
    authentication: "https://tick-stream.xyz/docs/authentication",
    level2: "https://tick-stream.xyz/docs/level2",
    limits: "https://tick-stream.xyz/docs/limits",
    terms: "https://tick-stream.xyz/terms",
  }),
  endpoint: Object.freeze({
    decision: "HOLD_DOCUMENTATION_PATH_CONFLICT",
    documentedCandidate: STREAM_CANDIDATE,
    authenticationExample: "wss://stream.tick-stream.xyz/v1",
    relationship: "UNEXPLAINED_NO_PROBING",
    selectedEndpoint: null,
    fallback: "FORBIDDEN",
  }),
  authentication: Object.freeze({
    documentedMethod: "WEBSOCKET_QUERY_KEY_ONLY",
    authorizationHeader: "NOT_READ_BY_PROVIDER_PER_DOCUMENTATION",
    secretVariableName: "TICKSTREAM_API_KEY", // Name only. Never accessed here.
    secretAccess: "FORBIDDEN_IN_P2_C2",
    authenticatedUrlBuilder: "NOT_IMPLEMENTED",
    http401: "MISSING_OR_INVALID_KEY",
    http403: "ENTITLEMENT_OR_ACCOUNT_REFUSAL_NOT_JUST_INVALID_KEY",
  }),
  protocol: Object.freeze({
    timestampUnit: "s",
    timestampConfidence: "DOCUMENTED_SECONDS_NOT_WIRE_VERIFIED",
    schemaCompatibility: "DOCUMENTATION_PROFILES_ONLY_NOT_WIRE_VERIFIED",
    jsonPingIntervalMs: 15_000,
    protocolPingIntervalMs: 15_000,
    idleCloseMs: 45_000,
    explicitSubscriptionAck: "NOT_DOCUMENTED",
    subscriptionErrors: "ERROR_FRAME_SOCKET_MAY_REMAIN_OPEN",
    welcome: "DOCUMENTED_PLAN_CAPABILITIES_AND_SUBSCRIBED_SYMBOLS_SCHEMA_UNVERIFIED",
    warnings: "LAGGED_TICKS_MAY_HAVE_BEEN_DROPPED_NO_AUTOMATIC_BACKFILL",
  }),
  entitlement: Object.freeze({
    plan: "REALTIME_PLUS_L2_USER_REPORTED_NOT_ACCOUNT_VERIFIED",
    documentedConnections: 3,
    documentedSubscriptionLimit: "UNLIMITED",
    slotCounting: "EACH_SYMBOL_CHANNEL_PAIR_COUNTS",
    accountClassification: "UNVERIFIED",
    accountAcceptedTermsVersion: "UNVERIFIED",
    runtimeStatus: "NOT_QUERIED",
  }),
  interpretation: Object.freeze({
    nqRoot: "AUTOMATIC_FRONT_MONTH_ROLL",
    contract: null,
    providerSequence: "UNAVAILABLE",
    providerTradeId: "UNAVAILABLE",
    completeness: "UNKNOWN",
    sequenceContinuity: "UNVERIFIED",
    book: "COALESCED_FULL_SNAPSHOTS_NOT_INCREMENTAL_UPDATES",
    bookRate: "DOCUMENTED_AT_MOST_APPROX_7_HZ_NOT_MEASURED",
    bookDepth: "DOCUMENTED_UP_TO_400_LEVELS_PER_SIDE",
    intermediateUpdates: "UNOBSERVED",
    snapshotDifferenceAsOrderAddCancelModify: "FORBIDDEN",
    productionValidityPromotion: "NOT_IMPLEMENTED_EXISTING_CONTRACTS_UNCHANGED",
  }),
});

/** Public terms are not account-specific authorisation or a storage licence. */
export const RIGHTS_REVIEW = Object.freeze({
  decision: "HOLD_ACCOUNT_AND_USAGE_SCOPE_UNCONFIRMED",
  personalDisplay: "CONDITIONAL_INTERNAL_USE_ACCOUNT_CLASSIFICATION_UNVERIFIED",
  personalDesktop: "CONDITIONAL_OWN_APPLICATION_ACCOUNT_CLASSIFICATION_UNVERIFIED",
  replitNodeReceive: "CLOUD_EXECUTION_SCOPE_UNCONFIRMED",
  shortRamBuffer: "NECESSARY_OPERATION_EXCEPTION_SCOPE_UNCONFIRMED",
  technicalNonDisplay: "EXCHANGE_AND_ACCOUNT_REQUIREMENTS_UNCONFIRMED",
  aggregateDiagnostics: "INTERNAL_METRICS_SCOPE_UNCONFIRMED",
  rawStorage: "NOT_GENERALLY_LICENSED_NECESSITY_AND_DURATION_REQUIRE_REVIEW",
  derivedStorage: "NO_BLANKET_PERMISSION_CONFIRMED",
  historicalReplay: "NO_BLANKET_PERMISSION_CONFIRMED",
  thirdPartyRedistribution: "PROHIBITED_BY_DEFAULT_NO_FUTURES_GRANT_CONFIRMED",
});

export const LIVE_SAFETY_POLICY = Object.freeze({
  limits: LIMITS,
  maxFragments: LIMITS.fragments,
  maxBufferedChunks: 1024,
  rejectUnauthorized: true,
  followRedirects: false,
  maxRedirects: 0,
  perMessageDeflate: false,
  skipUTF8Validation: false,
  binaryPolicy: "REJECT",
  allowedExternalWebsocketProtocol: "wss:",
  proxyPolicy: "NO_IMPLICIT_PROXY_NO_CALLER_SUPPLIED_AGENT",
  protocolPong: "EXACTLY_ONE_OWNER_REUSE_P2_C1_AUTOPONG",
  jsonPong: "SEPARATE_FROM_PROTOCOL_PONG",
  backpressure: Object.freeze({ pauseRatio: .75, resumeRatio: .5 }),
  watchdog: "REUSE_PARENT_MONITORING_NOT_OS_HARD_LIMIT",
  forceStopDiagnostics: "FIXED_CODES_UNKNOWN_COUNTERS_NULL_NO_STACKS",
});

export const LIVE_BLOCKERS = Object.freeze([
  "P2_C3_CODE_CHANGE_REQUIRED",
  "ENDPOINT_DOCUMENTATION_CONFLICT",
  "ACCOUNT_ENTITLEMENT_NOT_VERIFIED",
  "LICENCE_SCOPE_UNCONFIRMED",
  "LIVE_TRANSPORT_AND_PROVENANCE_NOT_IMPLEMENTED",
  "LIVE_CONTROL_FRAME_SCHEMA_NOT_REVIEWED",
] as const);
const BLOCKED = Object.freeze({
  decision: "BLOCKED" as const,
  reason: "P2_C3_CODE_CHANGE_REQUIRED" as const,
});
/** Ignore all input, including getters, booleans, credentials and CLI-like flags. */
export function liveConnectionGate(_runtimeInput?: unknown): typeof BLOCKED { return BLOCKED; }

type Channel = "ticks" | "book";
type ConfigReason = "INVALID_CONFIG" | "UNKNOWN_SETTING" | "WSS_REQUIRED" |
  "ENDPOINT_NOT_ALLOWLISTED" | "INVALID_SYMBOL" | "INVALID_CHANNELS";
const rejected = (reason: ConfigReason) => Object.freeze({ status: "REJECTED_CONFIG" as const, reason });

/** Exact candidate comparison: no normalisation, credentials, query, alias or fallback. */
export function checkLiveEndpoint(input: unknown):
  | { readonly status: "DOCUMENTED_CANDIDATE_ONLY"; readonly connectionEnabled: false }
  | ReturnType<typeof rejected> {
  if (typeof input !== "string") return rejected("ENDPOINT_NOT_ALLOWLISTED");
  if (!input.startsWith("wss://")) return rejected("WSS_REQUIRED");
  if (input !== STREAM_CANDIDATE) return rejected("ENDPOINT_NOT_ALLOWLISTED");
  return Object.freeze({ status: "DOCUMENTED_CANDIDATE_ONLY", connectionEnabled: false });
}

function channelList(value: unknown): readonly Channel[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if ((length !== 1 && length !== 2) || Reflect.ownKeys(value).length !== length + 1) return null;
  const channels: Channel[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) ||
      (descriptor.value !== "ticks" && descriptor.value !== "book") ||
      channels.includes(descriptor.value)) return null;
    channels.push(descriptor.value);
  }
  return Object.freeze(channels);
}

/**
 * Only pure preparation inputs. Unknown security overrides and accessors fail
 * closed without reading their values or echoing a key/value/exception.
 */
export function prepareLiveConfig(input: unknown = {}) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return rejected("INVALID_CONFIG");
    const values: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !["endpoint", "symbol", "channels"].includes(key)) return rejected("UNKNOWN_SETTING");
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) return rejected("INVALID_CONFIG");
      values[key] = descriptor.value;
    }
    const endpoint = Object.hasOwn(values, "endpoint") ? values.endpoint : STREAM_CANDIDATE;
    const checked = checkLiveEndpoint(endpoint);
    if (checked.status === "REJECTED_CONFIG") return checked;
    if (Object.hasOwn(values, "symbol") && values.symbol !== "NQ") return rejected("INVALID_SYMBOL");
    const channels = channelList(Object.hasOwn(values, "channels") ? values.channels : ["ticks"]);
    if (!channels) return rejected("INVALID_CHANNELS");
    return Object.freeze({
      status: "PREPARED_DISABLED" as const,
      config: Object.freeze({
        connectionEnabled: false,
        source: "PREPARATION_ONLY_NO_MARKET_DATA",
        selectedEndpoint: null,
        documentedEndpointCandidate: STREAM_CANDIDATE,
        symbol: "NQ",
        contract: null,
        plannedChannels: channels,
        // Planning data only; not connected to any socket/send method.
        subscriptionPlan: Object.freeze(channels.map(channel => Object.freeze({
          op: "subscribe", channel, symbols: Object.freeze(["NQ"]),
        }))),
        plannedSubscriptionSlots: channels.length,
        plannedSchemaProfiles: Object.freeze({
          ticks: "WS_TICK_LIVE_V1", book: "WS_BOOK_LIVE_V1",
        }),
        safety: LIVE_SAFETY_POLICY,
        documentation: DOCUMENTATION_REVIEW,
        rights: RIGHTS_REVIEW,
        blockers: LIVE_BLOCKERS,
      }),
    });
  } catch {
    // Also contains hostile Proxy exceptions; never return the thrown object.
    return rejected("INVALID_CONFIG");
  }
}

/** Designed future counter vocabulary, NOT measurements from a running pipeline. */
export const PLANNED_DIAGNOSTIC_COUNTERS = Object.freeze([
  "connectionAttempts", "accepted", "rejected", "reasonCounts", "familyCounts",
  "payloadBytes", "queuePeakCount", "queuePeakBytes", "heartbeatCount", "disconnectCount",
] as const);
export function preparationDiagnostics(input: unknown = {}) {
  const result = prepareLiveConfig(input);
  return Object.freeze({
    schema: "ORDERFLOW_LIVE_PREPARATION_V1",
    source: "NO_MARKET_DATA",
    network: "DISABLED",
    sessionStatus: "NOT_RUNNING",
    configStatus: result.status,
    configReason: result.status === "REJECTED_CONFIG" ? result.reason : "P2_C3_CODE_CHANGE_REQUIRED",
    authenticationOutcome: "NOT_ATTEMPTED",
    subscriptionSendOutcome: "NOT_ATTEMPTED",
    firstObservationOutcome: "NOT_ATTEMPTED",
    counters: null,
    memoryMeasurement: "NOT_MEASURED",
    marketMissingEvents: "NOT_MEASURABLE",
    contract: null,
    providerSequence: "UNAVAILABLE",
    timestampUnitConfidence: DOCUMENTATION_REVIEW.protocol.timestampConfidence,
    schemaCompatibility: DOCUMENTATION_REVIEW.protocol.schemaCompatibility,
    entitlementStatus: "USER_REPORTED_NOT_VERIFIED",
    rightsStatus: RIGHTS_REVIEW.decision,
    stopReason: "NOT_STARTED",
    decision: "HOLD",
  });
}
