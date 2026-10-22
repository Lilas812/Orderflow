import { validateMarketEvent, type MarketEvent } from "@workspace/core/events";
import { insist } from "../sqliteCatalog";

/** This is GUARD canonical, NOT storage canonical. In particular undefined object
 * fields are omitted and a native Map has no enumerable entries (therefore {}).
 * The unexported old kernel remains the independent test oracle. */
export function guardCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(guardCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, v]) => `${JSON.stringify(key)}:${guardCanonical(v)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Event content must be JSON-compatible");
  return serialized;
}
export function encodeIdentity(input: unknown): { key: string; fingerprint: string; scopeId: string; event: MarketEvent } {
  const event = validateMarketEvent(input), h = event.header;
  const tuple = [h.environment, h.source, h.sourceId, h.canonicalInstrumentId, h.sessionId, h.channel, h.eventId];
  return { key: JSON.stringify(tuple), fingerprint: guardCanonical(event),
    scopeId: JSON.stringify(tuple.slice(0, 6)), event };
}
export function keyScope(key: string): string {
  const parts: unknown = JSON.parse(key);
  insist(Array.isArray(parts) && parts.length === 7 && parts.every(p => typeof p === "string") &&
    JSON.stringify(parts) === key, "IDENTITY", "Exact JSON tuple required");
  return JSON.stringify(parts.slice(0, 6));
}
/** Digest is deliberately irrelevant to exact equality (including collision tests). */
export function sameFingerprint(first: string, incoming: string, _digestHint?: (s: string) => string): boolean {
  return Buffer.from(first, "utf8").equals(Buffer.from(incoming, "utf8"));
}
export function validateIdentity(key: string, fingerprint: string): void {
  keyScope(key);
  const value = encodeIdentity(JSON.parse(fingerprint));
  insist(value.key === key && sameFingerprint(value.fingerprint, fingerprint),
    "IDENTITY", "Key and complete canonical event fingerprint disagree");
}
