import { createContext, useContext, useMemo, type MutableRefObject, type ReactNode } from "react";
import type { ScaleSettings } from "@workspace/core/heatmap-scale";
import type { SideStatus } from "./HeatmapDebugControls";
import { fmtTime, tzLabelOf, type DisplayTimeZone } from "./timeformat";

/** Registered by ChartShell; the only route to the R07 update/recalibrate/capture logic. */
export interface HeatmapActions {
  settings: ScaleSettings;
  update: (patch: Partial<ScaleSettings>) => void;
  recalibrate: () => void;
  canRecalibrate: boolean;
  recalibrateReason: string | null;
  status: readonly SideStatus[];
  captureError: string | null;
}
export type HeatmapActionsRef = MutableRefObject<HeatmapActions | null>;

interface TimeCtx { timeZone: DisplayTimeZone; tzLabel: string; fmt: (ns: string, withDate?: boolean) => string }
const DEFAULT: TimeCtx = {
  timeZone: "Asia/Tokyo", tzLabel: "JST", fmt: (ns, withDate = false) => fmtTime(ns, withDate, "Asia/Tokyo"),
};
const Ctx = createContext<TimeCtx>(DEFAULT);

export function TimeFormatProvider({ timeZone, children }: { timeZone: DisplayTimeZone; children: ReactNode }) {
  const value = useMemo<TimeCtx>(() => ({
    timeZone, tzLabel: tzLabelOf(timeZone), fmt: (ns, withDate = false) => fmtTime(ns, withDate, timeZone),
  }), [timeZone]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useTimeFormat = () => useContext(Ctx);
