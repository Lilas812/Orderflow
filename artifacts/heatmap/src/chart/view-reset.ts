import type { Viewport } from "../domain.ts";
import { followStartUs } from "./coordinates.ts";

/** Same target for toolbar, double-click and double-tap. Settings are not touched. */
export function resetViewport(anchorUs: number, currentPriceTicks: number, widthPixels: number, mode: "live" | "replay" = "live"): Viewport {
  return { startUs: followStartUs(mode === "replay" ? anchorUs - 1_000_000 : anchorUs, 600, widthPixels), durationSec: 600,
    centerPriceTicks: currentPriceTicks, priceSpanTicks: 160 };
}
