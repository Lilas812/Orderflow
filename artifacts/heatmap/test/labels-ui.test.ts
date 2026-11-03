import test from "node:test";
import assert from "node:assert/strict";
import { utcDayRange, initialFailedDirection, mustConfirmRevision } from "../src/labels/pure.ts";

test("utcDayRange inclusive UTC days", () => {
  assert.deepEqual(utcDayRange("2024-01-02", "2024-01-02"), { fromSec: 1704153600, toSec: 1704240000 });
  assert.equal(utcDayRange("2024-01-03", "2024-01-02"), null);
  assert.equal(utcDayRange("x", "2024-01-02"), null);
});
test("failed direction from approach", () => {
  assert.equal(initialFailedDirection("up"), "down");
  assert.equal(initialFailedDirection("down"), "up");
  assert.equal(initialFailedDirection(null), null);
});
test("conflict acknowledgement covers exactly one revision, including uncertain POST recovery", () => {
  assert.equal(mustConfirmRevision(1, undefined, 1), false);
  assert.equal(mustConfirmRevision(1, undefined, 2), true);
  assert.equal(mustConfirmRevision(1, 2, 2), false);
  assert.equal(mustConfirmRevision(1, 2, 3), true);
  assert.equal(mustConfirmRevision(undefined, undefined, 1), true);
  assert.equal(mustConfirmRevision(undefined, 1, 1), false);
});
