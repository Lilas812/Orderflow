import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonical, checksum } from "../sqliteCatalog";
import { arrayHasher, canonicalBytes, canonicalDigest } from "./canonicalStream";

const examples: unknown[] = [
  null, true, false, 0, -0, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER,
  "", "NQ", "\u0000\b\t\n\f\r\"\\", "日本語🌏𠮷", "\ud800", "\udfff",
  "x\ud83d\ude00y\ud800z", [], {}, [[], {}, null],
  { z: 1, a: 2, "10": true, "2": false, "\ud800": "🌏" },
  new Map(), new Map([["z", 1], ["a", 2]]),
  new Map<unknown, unknown>([[["🌏"], { b: 1, a: 0 }], [3, new Map([["x", "y"]])]]),
  { nested: [{ b: 2, a: 1 }], map: new Map([[null, ["\n", "😀"]]]) },
  Array(3),
];
describe("P1-A legacy canonical oracle, unchanged", () => {
  it.each(examples.map((v, i) => ({ v, i })))("matches bytes/SHA for case $i at every tiny byte boundary", ({ v }) => {
    const oracle = Buffer.from(canonical(v));
    for (const bufferBytes of [1, 2, 3, 4, 7, 64]) {
      const chunks = [...canonicalBytes(v, { bufferBytes })];
      expect(chunks.every(b => b.length <= bufferBytes)).toBe(true);
      expect(Buffer.concat(chunks)).toEqual(oracle);
      expect(canonicalDigest(v, { bufferBytes })).toBe(checksum(v));
      expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(checksum(v));
    }
  });
  it("preserves old sorted object keys AND Map insertion order", () => {
    expect(Buffer.concat([...canonicalBytes({ z: 0, a: 1 })]).toString()).toBe('{"a":1,"z":0}');
    expect(canonicalDigest(new Map([["a", 1], ["b", 2]])))
      .not.toBe(canonicalDigest(new Map([["b", 2], ["a", 1]])));
  });
  it("starts a large array before visiting its elements, never stringifies the array", () => {
    let visited = 0;
    const array = Array.from({ length: 20_000 }, (_, i) => i);
    const proxy = new Proxy(array, { get(target, p, receiver) {
      if (/^\d+$/.test(String(p))) visited++;
      return Reflect.get(target, p, receiver);
    } });
    const stream = canonicalBytes(proxy, { bufferBytes: 4 });
    expect(stream.next().value?.toString()).toBe("["); expect(visited).toBe(0);
    stream.return(undefined);
    expect(canonicalDigest(array)).toBe(checksum(array));
  });
  it("hashes a streamed array as original bytes, not row digest concatenation", () => {
    const h = arrayHasher(); for (const e of examples.slice(0, 12)) h.add(e);
    expect(h.finish()).toBe(checksum(examples.slice(0, 12)));
    expect(() => h.add(0)).toThrow("READER_STATE");
    expect(() => h.finish()).toThrow("READER_STATE");
    expect(arrayHasher().finish()).toBe(checksum([]));
  });
  it.each([undefined, 1.25, NaN, Infinity, 2n, () => 0, Symbol("x")])("rejects noncanonical primitive %s", v => {
    expect(() => canonicalDigest(v)).toThrow("NON_JSON");
  });
  it("refuses cycles and explicit scalar, nesting and key budgets", () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    expect(() => canonicalDigest(cycle)).toThrow("NON_JSON");
    expect(() => canonicalDigest("x".repeat(100), { workingBytes: 128, bufferBytes: 1 })).toThrow("BUDGET_EXCEEDED");
    expect(() => canonicalDigest({ longKey: 1 }, { workingBytes: 128, bufferBytes: 1 })).toThrow("BUDGET_EXCEEDED");
    expect(() => canonicalDigest([[[[0]]]], { maxDepth: 2 })).toThrow("BUDGET_EXCEEDED");
  });
  it.each([0, -1, 1.5, 1024 * 1024 + 1])("refuses buffer budget %s", bufferBytes => {
    expect(() => canonicalDigest([], { bufferBytes })).toThrow("BUDGET_EXCEEDED");
  });
});
