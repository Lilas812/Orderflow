import { DEFAULT_SMOOTHING, type SmoothingOptions } from "../chart/smoothing.ts";
export function readSmoothing(storage: Pick<Storage, "getItem">, symbol: string): SmoothingOptions {
  try {
    const v = JSON.parse(storage.getItem(`heatmap.smoothing.${symbol}`) ?? "null");
    return { time: v?.time === "max" ? "max" : "mean", price: v?.price === "none" ? "none" : "auto" };
  } catch { return { ...DEFAULT_SMOOTHING }; }
}
export function saveSmoothing(storage: Pick<Storage, "setItem">, symbol: string, value: SmoothingOptions) {
  storage.setItem(`heatmap.smoothing.${symbol}`, JSON.stringify(value));
}
