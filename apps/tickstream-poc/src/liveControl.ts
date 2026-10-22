import { LIMITS } from "./transport";
export type ControlCode = "JSON_PING" | "JSON_PONG" | "WELCOME_UNVERIFIED" |
  "AUTH_REJECTED" | "ENTITLEMENT_REJECTED" | "SUBSCRIPTION_REJECTED" |
  "CONNECTION_LIMIT" | "LAG_WARNING" | "FEED_UNVERIFIED" | "UNKNOWN_CONTROL" |
  "INVALID_JSON" | "INVALID_UTF8" | "MESSAGE_TOO_LARGE";
export type Classification = { kind: "market"; channel: "ticks" | "book" } |
  { kind: "control"; code: ControlCode; stop: boolean };
/** Never echo an upstream message/code/field name. No invented subscription ACK. */
export function classifyMessage(bytes: Uint8Array): Classification {
  const control = (code: ControlCode, stop = true): Classification => ({ kind: "control", code, stop });
  if (bytes.byteLength > LIMITS.messageBytes) return control("MESSAGE_TOO_LARGE");
  let text: string, object: Record<string, unknown>;
  try { text = new TextDecoder("utf8", { fatal: true }).decode(bytes); }
  catch { return control("INVALID_UTF8"); }
  try {
    object = JSON.parse(text);
    if (!object || typeof object !== "object" || Array.isArray(object)) return control("UNKNOWN_CONTROL");
  } catch { return control("INVALID_JSON"); }
  if (object.type === "tick") return { kind: "market", channel: "ticks" };
  if (object.type === "book") return { kind: "market", channel: "book" };
  if (object.type === "ping" || object.type === "pong") {
    if (Object.keys(object).some(k => k !== "type" && k !== "id") ||
      (object.id !== undefined && !Number.isSafeInteger(object.id))) return control("UNKNOWN_CONTROL");
    return control(object.type === "ping" ? "JSON_PING" : "JSON_PONG", false);
  }
  if (object.type === "welcome") return control("WELCOME_UNVERIFIED", false);
  if (object.type === "warning") return control("LAG_WARNING");
  if (object.type === "feed") return control("FEED_UNVERIFIED");
  if (object.type === "error") {
    const error = object.error;
    const code = error && typeof error === "object" ? (error as Record<string, unknown>).code : null;
    if (["invalid_key", "unauthorized", "authentication_failed"].includes(code as string)) return control("AUTH_REJECTED");
    if (["plan_required", "forbidden", "account_suspended"].includes(code as string)) return control("ENTITLEMENT_REJECTED");
    if (code === "too_many_connections") return control("CONNECTION_LIMIT");
    return control("SUBSCRIPTION_REJECTED");
  }
  return control("UNKNOWN_CONTROL");
}
