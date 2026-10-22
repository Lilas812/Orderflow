import { createHash } from "node:crypto";
import { insist } from "../sqliteCatalog";

/** Independent prototype. Object keys deliberately use the OLD sorted-key rule.
 * Maps preserve insertion order, including the old {$storageMap: entries} envelope.
 * No product export/import is added. Input must remain immutable while consumed. */
export interface CanonicalBudget {
  bufferBytes?: number;
  workingBytes?: number;
  maxDepth?: number;
}
export function* canonicalBytes(value: unknown, budget: CanonicalBudget = {}): Generator<Buffer> {
  const size = budget.bufferBytes ?? 64 * 1024, working = budget.workingBytes ?? 16 * 1024 * 1024;
  const depthLimit = budget.maxDepth ?? 128;
  insist(Number.isSafeInteger(size) && size > 0 && size <= 1024 * 1024 &&
    Number.isSafeInteger(working) && working >= size && working <= 16 * 1024 * 1024 &&
    Number.isSafeInteger(depthLimit) && depthLimit > 0 && depthLimit <= 128,
  "BUDGET_EXCEEDED", "Invalid MOCK canonical budget");
  const active = new Set<object>();
  let live = size;
  function* walk(v: unknown, depth: number): Generator<string> {
    insist(depth <= depthLimit, "BUDGET_EXCEEDED", "Canonical nesting budget");
    if (v !== null && typeof v === "object") {
      insist(!active.has(v), "NON_JSON", "Cyclic input");
      active.add(v);
      try {
        if (v instanceof Map) {
          yield '{"$storageMap":[';
          let first = true;
          for (const [key, item] of v) {
            if (!first) yield ",";
            first = false;
            yield "["; yield* walk(key, depth + 1); yield ","; yield* walk(item, depth + 1); yield "]";
          }
          yield "]}";
        } else if (Array.isArray(v)) {
          yield "[";
          for (let i = 0; i < v.length; i++) {
            if (i) yield ",";
            // Match Array.map().join() of the oracle, even for sparse arrays.
            if (i in v) yield* walk(v[i], depth + 1);
          }
          yield "]";
        } else {
          // Sorting keys, not changing the old canonical ordering to insertion order.
          let keyBytes = 0;
          for (const k in v) if (Object.hasOwn(v, k)) {
            keyBytes += 128 + k.length * 16;
            insist(live + keyBytes <= working, "BUDGET_EXCEEDED", "Object key budget");
          }
          live += keyBytes;
          try {
            const keys = Object.keys(v).sort();
            yield "{";
            for (let i = 0; i < keys.length; i++) {
              if (i) yield ",";
              yield* walk(keys[i], depth + 1); yield ":";
              yield* walk((v as Record<string, unknown>)[keys[i]], depth + 1);
            }
            yield "}";
          } finally { live -= keyBytes; }
        }
      } finally { active.delete(v); }
    } else {
      insist(v === null || typeof v === "string" || typeof v === "boolean" ||
        (typeof v === "number" && Number.isSafeInteger(v)), "NON_JSON", "Lossless primitives only");
      // Includes worst-case JSON escaping, UTF-16 token and UTF-8 byte buffer.
      const cost = typeof v === "string" ? 64 + v.length * 24 : 64;
      insist(live + cost <= working, "BUDGET_EXCEEDED", "Canonical scalar budget");
      yield JSON.stringify(v);
    }
  }
  // Encode each complete JSON token FIRST, then split bytes. A UTF-16 surrogate
  // pair is never independently encoded on opposite sides of a token boundary.
  for (const token of walk(value, 0)) {
    const bytes = Buffer.from(token, "utf8");
    for (let offset = 0; offset < bytes.length; offset += size) {
      // Copy: a consumer retaining one short piece cannot retain a huge parent buffer.
      yield Buffer.from(bytes.subarray(offset, offset + size));
    }
  }
}
export function canonicalDigest(value: unknown, budget?: CanonicalBudget): string {
  const hash = createHash("sha256");
  for (const bytes of canonicalBytes(value, budget)) hash.update(bytes);
  return hash.digest("hex");
}
/** Hash the actual legacy array bytes, never a concatenation of row digests. */
export function arrayHasher() {
  const hash = createHash("sha256").update("[");
  let count = 0, closed = false;
  return {
    add(value: unknown) {
      insist(!closed, "READER_STATE", "Hash already finalized");
      if (count++) hash.update(",");
      for (const bytes of canonicalBytes(value)) hash.update(bytes);
    },
    finish() {
      insist(!closed, "READER_STATE", "Hash already finalized");
      closed = true;
      return hash.update("]").digest("hex");
    },
    get count() { return count; },
  };
}
