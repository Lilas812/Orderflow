export type DisplayZone = "jst" | "ct";

export function formatTimeUs(timeUs: number, zone: DisplayZone): string {
  const timeZone = zone === "ct" ? "America/Chicago" : "Asia/Tokyo";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timeUs / 1_000));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}:${part("second")}`;
}

export function formatAxisLabels(startUs: number, durationSec: number, widthPx: number, zone: DisplayZone): string[] {
  return formatAxisTicks(startUs, durationSec, widthPx, zone).map((tick) => tick.label);
}

export function formatAxisTicks(startUs: number, durationSec: number, widthPx: number, zone: DisplayZone): { timeUs: number; label: string }[] {
  const targetCount = Math.max(2, Math.min(7, Math.floor(widthPx / 100)));
  const roughStep = durationSec / (targetCount - 1);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200];
  const step = steps.find((candidate) => candidate >= roughStep) ?? steps.at(-1)!;
  const first = Math.ceil(startUs / (step * 1_000_000)) * step;
  const labels: { timeUs: number; label: string }[] = [];
  for (let time = first; time * 1_000_000 < startUs + durationSec * 1_000_000; time += step) {
    labels.push({ timeUs: time * 1_000_000, label: formatTimeUs(time * 1_000_000, zone) });
    if (labels.length >= 8) break;
  }
  return labels;
}
