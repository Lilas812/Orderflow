import type { Viewport } from "../domain.ts";
import { followStartUs } from "./coordinates.ts";

/** Same target for toolbar, double-click and double-tap. Settings are not touched. */
/** Phase 14 (UI_SPEC 3.11): live default / reset shows the latest hour. Replay keeps 600 s. */
export const LIVE_RESET_SEC = 3600;
export const REPLAY_RESET_SEC = 600;
export const resetDurationSec = (mode: "live" | "replay") => mode === "live" ? LIVE_RESET_SEC : REPLAY_RESET_SEC;

export function resetViewport(anchorUs: number, currentPriceTicks: number, widthPixels: number, mode: "live" | "replay" = "live"): Viewport {
  const durationSec = resetDurationSec(mode);
  return { startUs: followStartUs(mode === "replay" ? anchorUs - 1_000_000 : anchorUs, durationSec, widthPixels), durationSec,
    centerPriceTicks: currentPriceTicks, priceSpanTicks: 160 };
}
