import { readFileSync } from "node:fs";
import type { Log } from "../logger.ts";

export const isolationMarker = new URL("../../../data/perf-memory/isolation.json", import.meta.url);
const allowedOrigin = "http://127.0.0.1:19090";
export function processStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

/** Measurement-only, owned by a live collector, never a deployment setting.
 * Removing the marker or ending its exact owner immediately restores admission.
 */
export class MeasurementIsolation {
  private previous = false;
  private marker: string | URL;
  private log: Log;
  constructor(marker: string | URL, log: Log) { this.marker = marker; this.log = log; }
  snapshot() {
    let enabled = false;
    try {
      const marker = JSON.parse(readFileSync(this.marker, "utf8"));
      enabled = Number.isSafeInteger(marker.ownerPid) && marker.ownerPid > 1
        && typeof marker.ownerStart === "string" && processStart(marker.ownerPid) === marker.ownerStart;
    } catch (error) {
      if (!(error instanceof Error && "code" in error
        && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw error;
    }
    if (enabled !== this.previous) {
      this.log(enabled ? "measurement_isolation_enabled" : "measurement_isolation_released", { allowedOrigin });
      this.previous = enabled;
    }
    return { enabled, allowedOrigin: enabled ? allowedOrigin : null };
  }
  allows(origin?: string): boolean { return !this.snapshot().enabled || origin === allowedOrigin; }
}
