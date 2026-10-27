import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameProfile } from "../src/chart/frame-profile.ts";

const frame = { at: 1, totalMs: 10, heatmapMs: 3, tradesMs: 1, bookMs: 1, bigMs: 1,
  priceAxisMs: 1, timeAxisMs: 1, depth: true, aggregationMs: 1, scaleMs: 1, rasterMs: 1,
  colorMs: 1, uploadMs: 1, tileSyncMs: 1 };
test("frame profile adds exclusive layers, not nested heatmap timers", () => {
  const profile = new FrameProfile();
  profile.record(frame);
  assert.equal(profile.snapshot()[0]?.otherMs, 2);
});
test("frame history is bounded and snapshots cannot modify recorded values", () => {
  const profile = new FrameProfile();
  for (let at = 0; at < 3000; at++) profile.record({ ...frame, at });
  const snapshot = profile.snapshot();
  assert.equal(snapshot.length, 2400); assert.equal(snapshot[0]?.at, 600);
  snapshot[0]!.totalMs = 999;
  assert.equal(profile.snapshot()[0]?.totalMs, 10);
});
