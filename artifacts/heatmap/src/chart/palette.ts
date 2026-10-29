/** Phase 14 nine-stop heat palette (UI_SPEC 3.11), sampled into a 256-entry lookup table. */
export const HEAT_STOPS: readonly { at: number; color: string }[] = [
  { at: 0, color: "#000000" },
  { at: 0.10, color: "#0d0a26" },
  { at: 0.25, color: "#241a6b" },
  { at: 0.42, color: "#4b3bd1" },
  { at: 0.58, color: "#8c7dff" },
  { at: 0.72, color: "#cfc6ff" },
  { at: 0.84, color: "#ffffff" },
  { at: 0.92, color: "#ff8a6a" },
  { at: 1, color: "#ff3d2e" },
];

export const COLOR_LUT_STEPS = 256;

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** RGB triplets, index = round(position * 255). */
export const COLOR_LUT: Uint8Array = (() => {
  const out = new Uint8Array(COLOR_LUT_STEPS * 3);
  const stops = HEAT_STOPS.map(s => ({ at: s.at, rgb: hexRgb(s.color) }));
  for (let index = 0; index < COLOR_LUT_STEPS; index++) {
    const position = index / (COLOR_LUT_STEPS - 1);
    let stop = 0;
    while (stop < stops.length - 2 && position > stops[stop + 1]!.at) stop++;
    const a = stops[stop]!, b = stops[stop + 1]!;
    const amount = Math.min(1, Math.max(0, (position - a.at) / (b.at - a.at)));
    for (let c = 0; c < 3; c++) out[index * 3 + c] = Math.round(a.rgb[c]! + (b.rgb[c]! - a.rgb[c]!) * amount);
  }
  return out;
})();

export function lutIndex(position: number): number {
  const p = position <= 0 ? 0 : position >= 1 ? 1 : position;
  return Math.round(p * (COLOR_LUT_STEPS - 1));
}

/** Colour position t' of a size under the SPEC 7 scale (0 when not painted). */
export function colorPosition(size: number, upper: number, lower: number, gamma: number): number {
  if (!(size >= 1) || size <= lower || Number.isNaN(upper)) return 0;
  const t = Math.min(1, Math.max(0, (size - lower) / Math.max(1, upper - lower)));
  return gamma === 1 ? t : t ** gamma;
}
