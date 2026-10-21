import { expect, it } from "vitest";
import { Latencies, Metrics, maxNs } from "./metrics";
it("uses exact nearest-rank p95/p99 and mean", () => {
  const l = new Latencies(); for (let i=1;i<=100;i++) l.add(i);
  expect(l.report()).toEqual({ count: 100, meanMs: 50.5, p95Ms: 95, p99Ms: 99, exactPercentiles: true });
});
it("does not invent unmeasured latencies or sampled tails", () => {
  const l = new Latencies(2); expect(l.report().p99Ms).toBeNull();
  l.add(1); l.add(2); l.add(99); expect(l.report()).toMatchObject({ meanMs: 34, p95Ms: null, exactPercentiles: false });
  expect(new Metrics().snapshot().renderLagMs).toBeNull();
});
it.each([-1, NaN, Infinity])("rejects invalid latency %s", x => expect(() => new Latencies().add(x)).toThrow());
it("keeps UTC ns exact and counts delivery/audit/logical stages separately", () => {
  expect(maxNs("1767225600000000001","1767225600000000002")).toBe("1767225600000000002");
  const m = new Metrics(); m.receivedEvents=1010; m.persistedEvents=1000; m.auditRecords=1010;
  expect(m.snapshot()).toMatchObject({ receivedEvents: 1010, persistedEvents: 1000, auditRecords: 1010 });
});
