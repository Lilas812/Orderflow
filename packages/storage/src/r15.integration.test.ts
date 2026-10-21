import { afterEach, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { diagnosticChild, diagnosticDirectory } from "./r15Diagnostics";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const dir = diagnosticDirectory(); dirs.push(dir);
  const child = diagnosticChild("save", dir); expect(child.status, child.stderr).toBe(0);
  return { dir, saved: JSON.parse(child.stdout) };
}
it("restores identical F01/F03, raw hashes and gaps in separate restarted processes", () => {
  const { dir, saved } = setup();
  const before = diagnosticChild("recover", dir);
  expect(before.status, before.stderr).toBe(0);
  const recovered = JSON.parse(before.stdout);
  expect(recovered.hash).toBe(saved.numeric.inputHash);
  expect(recovered.recordCount).toBe(11);
  expect(recovered.restored).toMatchObject({ twa: 38, bins: [60,40,30,60,0],
    gap: { status: "NO DATA", coverageRatio: 0.5, partialTWA: 35 } });
  const expired = diagnosticChild("expire", dir); expect(expired.status, expired.stderr).toBe(0);
  expect(JSON.parse(expired.stdout).deleted).toBe(1);
  const after = diagnosticChild("recover", dir); expect(after.status, after.stderr).toBe(0);
  expect(JSON.parse(after.stdout).retention).toMatchObject({ gapStatus: "NO DATA", visibleMarketEvents: 7, floorPosition: "1" });
  expect(JSON.parse(after.stdout).retention.visibleHash).toBe(recovered.retention.visibleHash);
}, 30_000);
it.each(["after-intent", "after-unlink", "before-final-commit"])(
  "recovers after real SIGKILL at %s in retention", phase => {
    const { dir } = setup();
    const killed = diagnosticChild(`kill-retention:${phase}`, dir);
    expect(killed.signal).toBe("SIGKILL");
    const recovery = diagnosticChild("recover", dir); expect(recovery.status, recovery.stderr).toBe(0);
    expect(JSON.parse(recovery.stdout).retention).toMatchObject({ gapStatus: "NO DATA", visibleMarketEvents: 7, floorPosition: "1" });
  }, 30_000);
it("rolls back uncommitted SQLite+v2 index+manifest after actual SIGKILL", () => {
  const { dir, saved } = setup();
  const killed = diagnosticChild("kill-write", dir);
  expect(killed.signal).toBe("SIGKILL");
  const recovery = diagnosticChild("recover", dir); expect(recovery.status, recovery.stderr).toBe(0);
  const result = JSON.parse(recovery.stdout);
  expect(result.hash).toBe(saved.numeric.inputHash); expect(result.recordCount).toBe(11);
});
it.each(["after-flush", "after-rename", "before-commit"])(
  "keeps committed originals after actual chunk SIGKILL at %s", phase => {
    const { dir } = setup();
    const killed = diagnosticChild(`kill-segment:${phase}`, dir);
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const expected = JSON.parse(killed.stdout);
    const recovery = diagnosticChild("recover", dir); expect(recovery.status, recovery.stderr).toBe(0);
    expect(JSON.parse(recovery.stdout)).toMatchObject({ hash: expected.hash, recordCount: 12 });
  }, 30_000);
