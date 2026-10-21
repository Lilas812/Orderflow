import { describe, expect, it } from "vitest";
import { fmtJst, fmtTime, tzLabelOf } from "./timeformat";
describe("R13 label-only timezone presentation", () => {
  const time = "1767225600000000123";
  it("keeps legacy JST labels identical", () => {
    expect(fmtJst(time)).toBe("09:00:00");
    expect(fmtTime(time, true, "Asia/Tokyo")).toBe(fmtJst(time, true));
  });
  it("UTC changes label and explicit suffix, not the exact nanosecond string", () => {
    expect(fmtTime(time, false, "UTC")).toBe("00:00:00");
    expect(fmtTime(time, true, "UTC")).toContain("2026/01/01");
    expect(fmtTime(time, true, "UTC")).toMatch(/ UTC$/);
    expect(time).toBe("1767225600000000123");
    expect(BigInt(time) % 1_000_000n).toBe(123n);
  });
  it("switches cached formatters without contaminating other components", () => {
    expect(fmtTime(time, false, "UTC")).toBe("00:00:00");
    expect(fmtJst(time)).toBe("09:00:00");
    expect(tzLabelOf("UTC")).toBe("UTC");
    expect(tzLabelOf("Asia/Tokyo")).toBe("JST");
  });
});
