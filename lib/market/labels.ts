import type { MarketSymbol } from "./instruments.ts";

export type LabelKind = "top" | "bottom" | "failed";
export type ViewMode = "live" | "blind" | "hindsight";
export interface TurningLabel {
  id: string;
  symbol: MarketSymbol;
  tsSec: number;
  priceTicks: number;
  kind: LabelKind;
  confidence: number;
  note: string;
  viewMode: ViewMode;
  screen: "heatmap" | "footprint";
  expectedDirection: "up" | "down";
  futureSeconds: number;
  createdUs: number;
  updatedUs: number;
}
export type LabelDraft = Omit<TurningLabel, "createdUs" | "updatedUs">;
export interface LabelsDocument { version: 1; generation: string; labels: TurningLabel[]; }
export const LABEL_LIMIT = 10_000;
export const NOTE_LIMIT = 200;

export function validDraft(v: unknown): v is LabelDraft {
  const x = v as LabelDraft;
  return !!x && typeof x.id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(x.id)
    && (x.symbol === "NQ" || x.symbol === "GC")
    && Number.isSafeInteger(x.tsSec) && x.tsSec >= 0 && x.tsSec <= 0xffffffff
    && Number.isSafeInteger(x.priceTicks) && x.priceTicks > 0 && x.priceTicks <= 0x7fffffff
    && ["top", "bottom", "failed"].includes(x.kind)
    && Number.isInteger(x.confidence) && x.confidence >= 1 && x.confidence <= 3
    && typeof x.note === "string" && Array.from(x.note).length <= NOTE_LIMIT
    && ["live", "blind", "hindsight"].includes(x.viewMode)
    && ["heatmap", "footprint"].includes(x.screen)
    && ["up", "down"].includes(x.expectedDirection)
    && (x.kind !== "top" || x.expectedDirection === "down")
    && (x.kind !== "bottom" || x.expectedDirection === "up")
    && Number.isFinite(x.futureSeconds) && x.futureSeconds >= 0;
}

export function labelContext(tsSec: number, referenceUs: number, replay: boolean, follow: boolean) {
  const futureSeconds = Math.max(0, (referenceUs - tsSec * 1_000_000) / 1_000_000);
  const viewMode: ViewMode = replay
    ? futureSeconds < 1 ? "blind" : "hindsight"
    : follow && futureSeconds <= 2 ? "live" : "hindsight";
  return { futureSeconds, viewMode };
}

/** The two latest distinct actual prices before the selected second; no fabricated default. */
export function approachBefore(trades: Iterable<{ tsUs: number; price: number; seq?: number }>, us: number) {
  let last: { tsUs: number; price: number; seq?: number } | undefined;
  let previous: typeof last;
  const newer = (a: NonNullable<typeof last>, b: typeof last) =>
    !b || a.tsUs > b.tsUs || a.tsUs === b.tsUs && (a.seq ?? 0) >= (b.seq ?? 0);
  for (const t of trades) {
    if (t.tsUs >= us) continue;
    if (newer(t, last)) {
      if (last && t.price !== last.price) previous = last;
      last = t;
    } else if (last && t.price !== last.price && newer(t, previous)) previous = t;
  }
  return last && previous ? last.price > previous.price ? "up" as const : "down" as const : null;
}
