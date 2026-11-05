export type SymbolName = 'NQ' | 'GC';
export type ExtremeKind = 'top' | 'bottom';
export interface TradeRef {
  tsUs: number; seq: number; priceTicks: number;
  file: string; line: number; source: Record<string, unknown>;
}
export interface RangeBar {
  startUs: number; endUs: number; open: number; high: number; low: number; close: number;
  buy: number; sell: number; unknown: number; count: number;
  highRef: TradeRef; lowRef: TradeRef;
  session: string; partial: boolean; reason: string; segment: number;
}
export interface RangeSession {
  date: string; startDate: string; startUs: number; endUs: number;
  first: number; count: number; partial: boolean;
}
export interface RangeGap { fromUs: number; toUs: number; kind: 'missing' | 'scheduled'; at: number }
export interface Candidate { kind: ExtremeKind; ref: TradeRef; confirmedUs: number | null; segment: number }
export interface RangeData {
  version: string; symbol: SymbolName; contract: string; tickSize: number; width: number;
  reversalTicks: number; inputHash: string; cacheKey: string; bars: RangeBar[];
  sessions: RangeSession[]; gaps: RangeGap[]; candidates: Candidate[];
  totals: { count: number; buy: number; sell: number; unknown: number };
  manifest: Record<string, unknown>;
}
export interface RangeMark {
  id: string; symbol: SymbolName; contract: string; kind: ExtremeKind; ref: TradeRef;
  note: string; hindsight: 'hindsight'; createdUs: number; updatedUs: number;
  context: { width: number; guides: boolean; reversalTicks: number; inputHash: string };
}
export interface MarkHistory {
  revision: number; atUs: number; action: 'create' | 'edit' | 'delete' | 'undo' | 'criteria';
  id?: string; before?: RangeMark | null; after?: RangeMark | null;
  beforeCriteria?: string; afterCriteria?: string;
}
export interface MarkStore {
  version: 1; revision: number; marks: RangeMark[]; criteria: string; history: MarkHistory[];
}
export type MarkCommand =
  | { action: 'create'; mark: Omit<RangeMark, 'id' | 'createdUs' | 'updatedUs'> }
  | { action: 'edit'; id: string; note: string; kind: ExtremeKind }
  | { action: 'delete'; id: string }
  | { action: 'undo' }
  | { action: 'criteria'; text: string };
