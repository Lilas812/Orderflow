import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticChild } from "./diagnostics";
import { SqliteCatalog } from "./sqliteCatalog";

const dirs: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "orderflow-r14-restart-")); dirs.push(dir); return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("restores committed data in another process, retains checksums and rejects only the corrupted copy", () => {
  const dir = directory();
  const save = diagnosticChild("save", dir);
  expect(save.stderr).toBe(""); expect(save.status).toBe(0);
  const saved = JSON.parse(save.stdout);
  const recover = diagnosticChild("recover", dir);
  expect(recover.stderr).toBe(""); expect(recover.status).toBe(0);
  const restored = JSON.parse(recover.stdout);
  expect(restored.stats).toEqual(saved.stats);
  expect(restored.manifest).toEqual(saved.manifest);
  expect(restored.fixtureHash).toBe(saved.fixtureHash);
  expect(restored).toMatchObject({
    f01Twa: 38, twoSecondTwa: [60, 40, 30, 60, 0], checkpointQty: 80,
    recoveredQty: 100, gapStatus: "GAP", f07Status: "GAP", f01Unchanged: true,
  });
  expect(saved.stats).toMatchObject({ eventsReceived: 13, eventsApplied: 11 });
  expect(saved).toMatchObject({ pendingReceived: 1, pendingCommitted: false, gapCheckpoint: false });
  expect(saved.sizesAfterClose.database).toBeGreaterThan(0);
  const corrupt = diagnosticChild("corrupt-copy", dir);
  expect(corrupt.status).toBe(0); expect(JSON.parse(corrupt.stdout).detected).toContain("EVENT_CHECKSUM");
  const healthy = diagnosticChild("recover", dir);
  expect(healthy.status).toBe(0); expect(JSON.parse(healthy.stdout).stats).toEqual(saved.stats);
}, 30_000);
it("recovers after SIGKILL and discards an actual uncommitted SQL mutation", () => {
  const dir = directory();
  const crash = diagnosticChild("crash-save", dir);
  expect(crash.signal).toBe("SIGKILL");
  const committed = JSON.parse(crash.stdout);
  expect(committed.sizesBeforeClose["-wal"]).toBeGreaterThan(0);
  const restarted = diagnosticChild("recover", dir);
  expect(restarted.stderr).toBe(""); expect(restarted.status).toBe(0);
  expect(JSON.parse(restarted.stdout).stats).toEqual(committed.stats);
  expect(JSON.parse(restarted.stdout).f01Twa).toBe(38);
}, 30_000);
it("rejects physical SQLite header corruption instead of publishing a normal board", () => {
  const dir = directory(); const filename = join(dir, "broken.sqlite");
  writeFileSync(filename, Buffer.alloc(4096, 0x78), { mode: 0o600 });
  expect(() => new SqliteCatalog(filename)).toThrow(/not a database|malformed/i);
});
