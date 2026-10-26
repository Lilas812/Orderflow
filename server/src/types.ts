export type TimeUs = number;
export type PriceTicks = number;

export interface Trade {
  tsUs: TimeUs;
  recvUs: TimeUs;
  seq: number;
  price: PriceTicks;
  size: number;
  side: "buy" | "sell";
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
