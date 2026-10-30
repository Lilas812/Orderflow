export type TimeUs = number;
export type PriceTicks = number;

export interface Trade {
  tsUs: TimeUs;
  recvUs: TimeUs;
  seq: number;
  price: PriceTicks;
  size: number;
  side: "buy" | "sell" | "unknown";
  /** GC only: explicit record identity or verified current LIVE identity; absent = unknown. */
  contract?: string;
}

export interface BookLevel {
  price: PriceTicks;
  size: number;
}

export interface BookSnapshot {
  tsUs: TimeUs;
  recvUs: TimeUs;
  source: "live" | "history";
  bids: BookLevel[];
  asks: BookLevel[];
}
