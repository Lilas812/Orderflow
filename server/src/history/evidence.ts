/** Observed UTC seconds only. A non-truncated response is not proof of quiet seconds.
 * Merge after sorting because legitimate trade event timestamps may roll backwards. */
export function observedRanges(seconds: Iterable<number>): [number, number][] {
  const ranges: [number, number][] = [];
  for (const sec of [...new Set(seconds)].sort((a, b) => a - b)) {
    if (!Number.isSafeInteger(sec)) throw Error("invalid_observed_second");
    const last = ranges.at(-1);
    if (last?.[1] === sec) last[1]++;
    else ranges.push([sec, sec + 1]);
  }
  return ranges;
}
