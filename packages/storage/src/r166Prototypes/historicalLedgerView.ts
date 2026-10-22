import { insist } from "../sqliteCatalog";
import { keyScope } from "./identityCodec";

export interface Cursor { readonly position: string; readonly ordinal: number }
export function validateCursor(c: Cursor): void {
  insist(c && typeof c.position === "string" && /^(0|[1-9]\d*)$/.test(c.position) &&
    BigInt(c.position) < (1n << 63n) && Number.isInteger(c.ordinal) && c.ordinal >= 0 && c.ordinal < 128,
  "CURSOR", "Canonical int64 position and BATCH ordinal 0..127 required");
}
export function compareCursor(a: Cursor, b: Cursor): number {
  validateCursor(a); validateCursor(b);
  return BigInt(a.position) < BigInt(b.position) ? -1 : BigInt(a.position) > BigInt(b.position) ? 1 :
    Math.sign(a.ordinal - b.ordinal);
}
export interface LedgerEntry {
  key: string; fingerprint: string; first: Cursor; insertOrder: number;
  namespace: string; scopeId: string; firstEpoch: string;
}
export interface SeedBinding {
  id: string; anchorId: string; epoch: string; through: Cursor; entriesRoot: string;
}
export interface LedgerSnapshot {
  namespace: string; scopeId: string; epoch: string;
  coverage: "FULL_SCOPE_FROM_START" | "UNPROVEN"; evidence: string;
  through: Cursor; count: number; bytes: number; root: string; seed: SeedBinding | null;
}
export interface LedgerPort {
  snapshot(): LedgerSnapshot;
  /** Both operations must verify the entire ledger and pinned receipt, not just
   * the requested row. A present row is not proof that absent rows are genuine. */
  entry(key: string): LedgerEntry | undefined;
  entries(): readonly LedgerEntry[];
}
export class HistoricalLedgerView {
  private readonly snap: LedgerSnapshot;
  readonly cursor: Cursor;
  constructor(private readonly port: LedgerPort, cursor: Cursor,
    binding: { epoch: string; anchorId?: string; seedId?: string }, readonly inclusive = false) {
    this.snap = structuredClone(port.snapshot()); this.cursor = { ...cursor };
    validateCursor(cursor);
    insist(binding.epoch === this.snap.epoch, "EPOCH_MISMATCH", "Historical epoch differs");
    insist(this.snap.coverage === "FULL_SCOPE_FROM_START" && this.snap.evidence.trim(),
      "COVERAGE_UNPROVEN", "An absent ID cannot be declared new");
    insist(compareCursor(cursor, this.snap.through) <= 0, "COVERAGE_UNPROVEN", "Cursor beyond verified coverage");
    const seed = this.snap.seed;
    insist(seed ? binding.anchorId === seed.anchorId && binding.seedId === seed.id :
      binding.anchorId === undefined && binding.seedId === undefined, "SEED_BINDING", "Anchor/seed binding differs");
    insist(!seed || compareCursor(cursor, seed.through) >= 0, "BEFORE_SEED", "No historical prefix before anchor seed");
  }
  private visible(e: LedgerEntry): boolean {
    if (this.snap.seed && compareCursor(e.first, this.snap.seed.through) <= 0) return true;
    const order = compareCursor(e.first, this.cursor);
    return order < 0 || (this.inclusive && order === 0);
  }
  get(key: string): string | undefined {
    insist(keyScope(key) === this.snap.scopeId, "SCOPE_MISMATCH", "Foreign eligible scope");
    const e = this.port.entry(key);
    return e && this.visible(e) ? e.fingerprint : undefined;
  }
  materializeNative(): Map<string, string> {
    // Full real Map, no proxy/partial-Map pretending to be the legacy API.
    return new Map(this.port.entries().filter(e => this.visible(e)).map(e => [e.key, e.fingerprint]));
  }
}
