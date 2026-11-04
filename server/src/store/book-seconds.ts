import { scanColumnFile } from "./records.ts";

/** Actual persisted records, NOT fetched-range coverage. Bounded to one UTC hour. */
export async function inspectBookSeconds(file: string, hour: number, start = hour, end = hour + 3600,
  signal?: AbortSignal) {
  const present = new Uint8Array(3600);
  await scanColumnFile(file, second => {
    if (second < hour || second >= hour + 3600) throw Error("column_outside_hour");
    if (second >= start && second < end) present[second - hour] = 1;
  }, signal);
  let count = 0;
  const intervals: [number, number][] = [];
  for (let i = 0; i < 3600; i++) {
    if (!present[i]) continue;
    count++;
    const previous = intervals.at(-1);
    if (previous && previous[1] === hour + i) previous[1]++;
    else intervals.push([hour + i, hour + i + 1]);
  }
  return { hour, count, intervals };
}
