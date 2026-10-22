import type { MarketEvent } from "@workspace/core/events";
import type { SequenceGuard } from "@workspace/core/sequence-guard";
import { insist } from "../sqliteCatalog";
import { encodeIdentity, sameFingerprint } from "./identityCodec";
import { compareCursor, validateCursor, type Cursor, type LedgerEntry, type LedgerSnapshot } from "./historicalLedgerView";

export interface PendingBase {
  snapshot: LedgerSnapshot;
  get(key: string): string | undefined;
  materializeNative(): Map<string, string>;
}
export interface PendingInsert { key: string; fingerprint: string; first: Cursor }
const MAX_EVENTS = 128, MAX_BYTES = 8 * 1024 * 1024;
/** Count JSON bytes without first constructing a potentially huge JSON string.
 * Events are normalized below; undefined object fields follow JSON.stringify. */
function inputBytes(value: unknown): number {
  let total = 0;
  const spend = (n: number) => {
    total += n; insist(total <= MAX_BYTES, "BUDGET_EXCEEDED", "Serialized input exceeds 8 MiB");
  };
  function string(s: string) {
    spend(2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) spend(2);
      else if (c < 32) spend(6);
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length &&
        s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { spend(4); i++; }
      else if (c >= 0xd800 && c <= 0xdfff) spend(6);
      else spend(c < 128 ? 1 : c < 2048 ? 2 : 3);
    }
  }
  function walk(v: unknown, depth: number) {
    insist(depth <= 128, "BUDGET_EXCEEDED", "Input depth budget");
    if (typeof v === "string") string(v);
    else if (Array.isArray(v)) {
      spend(2);
      for (let i = 0; i < v.length; i++) { if (i) spend(1); walk(v[i] ?? null, depth + 1); }
    } else if (v !== null && typeof v === "object") {
      spend(2); let first = true;
      for (const k in v) if (Object.hasOwn(v, k)) {
        const item = (v as Record<string, unknown>)[k];
        if (item === undefined) continue;
        if (!first) spend(1); first = false;
        string(k); spend(1); walk(item, depth + 1);
      }
    } else {
      const json = JSON.stringify(v); insist(json !== undefined, "ADOPTION", "JSON input required"); spend(json.length);
    }
  }
  walk(value, 0); return total;
}
/** Independent adopted-version adapter, NOT a new guard algorithm. The caller
 * supplies the FINAL adopted Native Map after book/quality branch resolution.
 * A speculative guard insert alone is deliberately insufficient authority. */
export class PendingBranch {
  private readonly inserts = new Map<string, PendingInsert>();
  private readonly baseSnapshot: LedgerSnapshot;
  private consumed = 0;
  private serializedBytes = 0;
  private through: Cursor;
  private markCount = 0;
  private readonly marks = new WeakMap<object, { keys: string[]; through: Cursor }>();
  constructor(private readonly base: PendingBase) {
    this.baseSnapshot = structuredClone(base.snapshot); this.through = { ...base.snapshot.through };
    insist(base.snapshot.coverage === "FULL_SCOPE_FROM_START", "COVERAGE_UNPROVEN", "Pending cannot hide unknown history");
  }
  get(key: string): string | undefined {
    return this.inserts.get(key)?.fingerprint ?? this.base.get(key);
  }
  materializeNative(): Map<string, string> {
    const map = new Map(this.base.materializeNative());
    for (const e of this.inserts.values()) map.set(e.key, e.fingerprint);
    return map;
  }
  mark(): object {
    insist(++this.markCount <= 128, "BUDGET_EXCEEDED", "Finite branch mark budget");
    const mark = Object.freeze({});
    this.marks.set(mark, { keys: [...this.inserts.keys()], through: { ...this.through } }); return mark;
  }
  rollback(mark: object): void {
    const saved = this.marks.get(mark);
    const keys = [...this.inserts.keys()];
    insist(saved && saved.keys.length <= keys.length && saved.keys.every((k, i) => keys[i] === k),
      "BRANCH", "Foreign, stale or invalid branch mark");
    for (const k of keys.slice(saved.keys.length)) this.inserts.delete(k);
    this.through = { ...saved.through };
    // Capacity counts ALL attempted input, including rejected/rolled-back branches.
    this.marks.delete(mark);
  }
  stage(events: readonly MarketEvent[], adopted: SequenceGuard, start: Cursor): void {
    validateCursor(start);
    insist(start.position !== "0" && events.length > 0 && start.ordinal + events.length <= 128,
      "CURSOR", "Positive journal position and bounded batch ordinal required");
    insist(this.consumed + events.length <= MAX_EVENTS, "BUDGET_EXCEEDED", "128 attempted events");
    const bytes = inputBytes(events);
    insist(this.serializedBytes + bytes <= MAX_BYTES,
      "BUDGET_EXCEEDED", "128 events / 8 MiB serialized attempted input");
    this.consumed += events.length; this.serializedBytes += bytes;
    const samePosition = start.position === this.through.position && start.ordinal === this.through.ordinal + 1;
    const nextPosition = BigInt(start.position) === BigInt(this.through.position) + 1n && start.ordinal === 0;
    insist(samePosition || nextPosition, "CURSOR", "Uncertified gap/reversal in consumed input cursor");
    insist(adopted.seen instanceof Map, "ADOPTION", "Real adopted Native Map required");
    const before = this.materializeNative(), after = [...adopted.seen.entries()];
    insist(after.length >= before.size, "ADOPTION", "Adopted version removed prior IDs");
    let index = 0;
    for (const [key, fp] of before) {
      insist(after[index]?.[0] === key && sameFingerprint(after[index][1], fp),
        "ADOPTION", "Adopted version reordered/overwrote the first fingerprint"); index++;
    }
    const inputs = events.map(encodeIdentity), additions: PendingInsert[] = [];
    let previousOrdinal = -1;
    for (const [key, fingerprint] of after.slice(index)) {
      const ordinal = inputs.findIndex((e, i) => i > previousOrdinal && e.key === key &&
        sameFingerprint(e.fingerprint, fingerprint));
      insist(ordinal >= 0 && inputs[ordinal].scopeId === this.baseSnapshot.scopeId,
        "ADOPTION", "New adopted ID must correspond to ordered input");
      insist(this.get(key) === undefined, "ADOPTION", "Cannot overwrite durable/pending first fingerprint");
      previousOrdinal = ordinal;
      additions.push({ key, fingerprint, first: { position: start.position, ordinal: start.ordinal + ordinal } });
    }
    for (const e of additions) this.inserts.set(e.key, e);
    this.through = { position: start.position, ordinal: start.ordinal + events.length - 1 };
  }
  seal(): { inserts: PendingInsert[]; through: Cursor; base: LedgerSnapshot } {
    return structuredClone({ inserts: [...this.inserts.values()], through: this.through, base: this.baseSnapshot });
  }
}
/** Explicitly detached helper for finite oracle comparisons only. */
export function entriesToNative(entries: readonly LedgerEntry[]): Map<string, string> {
  return new Map(entries.map(e => [e.key, e.fingerprint]));
}
