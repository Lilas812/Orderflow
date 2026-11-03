import type { MarketSymbol } from "../../../../lib/market/instruments.ts";

export interface SharedReplayState {
  symbol: MarketSymbol;
  positionUs: number;
  fromSec: number;
  toSec: number;
  state: "playing" | "paused" | "ended";
  speed: number;
}

const key = (symbol: MarketSymbol) => `replay.shared.v1.${symbol}`;
const speeds = [1, 2, 5, 10, 30, 60];

export function loadSharedReplay(symbol: MarketSymbol): SharedReplayState | null {
  try {
    const raw = window.sessionStorage.getItem(key(symbol));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SharedReplayState>;
    if (value.symbol !== symbol || !Number.isSafeInteger(value.positionUs)
      || !Number.isSafeInteger(value.fromSec) || !Number.isSafeInteger(value.toSec)
      || value.fromSec! >= value.toSec! || value.positionUs! < value.fromSec! * 1_000_000
      || value.positionUs! > value.toSec! * 1_000_000
      || !["playing", "paused", "ended"].includes(value.state ?? "")
      || !speeds.includes(value.speed ?? 0)) return null;
    return value as SharedReplayState;
  } catch {
    return null;
  }
}

export function saveSharedReplay(state: SharedReplayState): boolean {
  try {
    window.sessionStorage.setItem(key(state.symbol), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearSharedReplay(symbol: MarketSymbol): boolean {
  try { window.sessionStorage.removeItem(key(symbol)); return true; } catch { return false; }
}

export function replayStart(state: SharedReplayState) {
  return {
    fromSec: Math.min(state.toSec - 1, Math.floor(state.positionUs / 1_000_000)),
    speed: state.speed,
    paused: state.state !== "playing",
    headUs: state.positionUs,
  };
}
