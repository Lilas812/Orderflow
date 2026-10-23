import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTrial, inspectTrial, prepareTrialRoot, purgeTrial, scanExpiredTrials, trialAuthorization,
  claimTrialLease, releaseTrialLease } from "./liveTrialDirectory";
import { MAX_RETENTION_MS } from "./liveAuthorization";
import { LiveAppendStore } from "./liveAppendStore";
import { recoverLive } from "./liveRecovery";
import { AUTHORIZED_LIVE_MODE } from "./liveAuthorization";

const parents: string[] = [];
function root() {
  const p = mkdtempSync(join(tmpdir(), "b2b-directory-")); chmodSync(p, 0o700); parents.push(p); return join(p, "trials");
}
const confirmation = { explicitMode: "GATE_B2B" as const, dataPermission: true, replitStoragePermission: true, manualCleanupConfirmed: true };
afterEach(() => parents.splice(0).forEach(p => rmSync(p, { force: true, recursive: true })));
describe("one-trial private path, retention and scoped cleanup", () => {
  it("creates an owned private root and deletes only the selected UUID", () => {
    const r = root(), one = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST"),
      other = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST");
    expect(purgeTrial(r, one.trialId)).toEqual({ deleted: true, remainingFiles: 0, trialId: one.trialId });
    expect(existsSync(one.directory)).toBe(false); expect(inspectTrial(r, other.trialId)).toEqual(other);
    expect(readdirSync(r)).toEqual([other.trialId]);
  });
  it.each(["../", ".", "*", "/home/runner/workspace", "not-a-uuid"])("rejects deletion target %s before touching any files", id => {
    const r = root(), p = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST");
    expect(() => purgeTrial(r, id)).toThrow("TRIAL_PATH_REJECTED"); expect(existsSync(p.directory)).toBe(true);
  });
  it.each(["unexpected", "directory", "symlink", "dangling", "hardlink", "public"])(
    "prevalidates ALL content and refuses %s without partial deletion", kind => {
      const r = root(), p = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST");
      const good = join(p.data, "live-ticks.bin"); writeFileSync(good, "ARTIFICIAL", { mode: 0o600 });
      const other = join(p.data, "live-manifest.json");
      if (kind === "unexpected") writeFileSync(join(p.data, "existing-db.sqlite"), "DO_NOT_DELETE", { mode: 0o600 });
      if (kind === "directory") mkdirSync(other, { mode: 0o700 });
      if (kind === "symlink") symlinkSync(good, other);
      if (kind === "dangling") symlinkSync(join(p.directory, "missing"), other);
      if (kind === "hardlink") linkSync(good, other);
      if (kind === "public") { writeFileSync(other, "ARTIFICIAL", { mode: 0o600 }); chmodSync(other, 0o644); }
      expect(() => purgeTrial(r, p.trialId)).toThrow("TRIAL_CONTENT_REJECTED");
      expect(readFileSync(good, "utf8")).toBe("ARTIFICIAL"); expect(existsSync(join(p.directory, "trial.json"))).toBe(true);
    });
  it("rejects symlink ancestors and a symlink replacing data, including a dangling one", () => {
    const r = root(), p = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST");
    const link = join(parents.at(-1)!, "linked"); symlinkSync(r, link);
    expect(() => prepareTrialRoot(link)).toThrow("TRIAL_PATH_REJECTED");
    rmSync(p.data, { recursive: true }); symlinkSync(join(p.directory, "missing"), p.data);
    expect(() => purgeTrial(r, p.trialId)).toThrow("TRIAL_PATH_REJECTED");
    expect(existsSync(join(p.directory, "trial.json"))).toBe(true);
  });
  it("refuses public roots and workspace destinations", () => {
    const r = root(); prepareTrialRoot(r, true); chmodSync(r, 0o755);
    expect(() => prepareTrialRoot(r)).toThrow("TRIAL_PATH_REJECTED");
    expect(() => prepareTrialRoot(process.cwd())).toThrow("TRIAL_PATH_REJECTED");
  });
  it("detects expiry from metadata only, refuses expired authorization and never reads expired log data", () => {
    const r = root(), now = Date.now(), p = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST", now, 100);
    writeFileSync(join(p.data, "live-ticks.bin"), "CORRUPT_EXPIRED_BYTES_MUST_NOT_BE_PARSED", { mode: 0o600 });
    expect(scanExpiredTrials(r, now + 99)).toEqual([]);
    expect(scanExpiredTrials(r, now + 100)).toEqual([p.trialId]);
    expect(() => trialAuthorization(p, confirmation, now + 100)).toThrow("LIVE_AUTH_EXPIRED");
    expect(purgeTrial(r, p.trialId).remainingFiles).toBe(0);
  });
  it("cannot authorize from marker alone or from an unconfirmed permission", () => {
    const r = root(), p = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST");
    expect(() => trialAuthorization(p, { ...confirmation, dataPermission: false })).toThrow("LIVE_AUTH_REQUIRED");
  });
  it("blocks purge while a capture/recovery process has an active lease", () => {
    const r = root(), p = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST");
    claimTrialLease(p); expect(() => purgeTrial(r, p.trialId)).toThrow("TRIAL_ACTIVE");
    releaseTrialLease(p); expect(purgeTrial(r, p.trialId).deleted).toBe(true);
  });
  it("rejects a corrupt marker/lease before deleting any data", () => {
    const r = root(), p = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST");
    writeFileSync(join(p.data, "live-ticks.bin"), "ARTIFICIAL", { mode: 0o600 });
    writeFileSync(join(p.directory, "session.lock"), '{"pid":"unexpected"}', { mode: 0o600 });
    expect(() => purgeTrial(r, p.trialId)).toThrow("TRIAL_CONTENT_REJECTED");
    expect(readFileSync(join(p.data, "live-ticks.bin"), "utf8")).toBe("ARTIFICIAL");
    unlinkSync(join(p.directory, "session.lock"));
    const marker = JSON.parse(readFileSync(join(p.directory, "trial.json"), "utf8"));
    writeFileSync(join(p.directory, "trial.json"), JSON.stringify({ ...marker, deleteByMs: marker.deleteByMs + 1 }));
    expect(() => purgeTrial(r, p.trialId)).toThrow("TRIAL_CONTENT_REJECTED");
    expect(existsSync(p.data)).toBe(true);
  });
  it("allows safe resumption after data files were already removed, but rejects missing proof", () => {
    const r = root(), p = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST");
    const a = trialAuthorization(p, confirmation), s = new LiveAppendStore(p.data, { testMode: AUTHORIZED_LIVE_MODE, authorization: a }); s.close();
    for (const f of readdirSync(p.data)) unlinkSync(join(p.data, f));
    expect(purgeTrial(r, p.trialId).deleted).toBe(true);
    const other = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST");
    unlinkSync(join(other.directory, "trial.json"));
    expect(() => purgeTrial(r, other.trialId)).toThrow("TRIAL_CONTENT_REJECTED");
    expect(existsSync(other.data)).toBe(true);
  });
  it("retains separate format boundaries and explicit recovery authorization", () => {
    const r = root(), p = createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST"), a = trialAuthorization(p, confirmation);
    const s = new LiveAppendStore(p.data, { testMode: AUTHORIZED_LIVE_MODE, authorization: a }); s.close();
    expect(() => recoverLive(p.data)).toThrow("LIVE_AUTH_REQUIRED");
    expect(recoverLive(p.data, undefined, a).persistedCount).toBe(0);
    expect(() => createTrial(r, randomUUID(), "PRODUCTION")).toThrow("TRIAL_PATH_REJECTED");
    expect(() => createTrial(r, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST", Date.now(), MAX_RETENTION_MS + 1)).toThrow("TRIAL_PATH_REJECTED");
  });
});
