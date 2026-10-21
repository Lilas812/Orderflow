import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_DISPLAY_SETTINGS, MAX_SETTINGS_BYTES, cloneSettings } from "@workspace/core/settings-schema";
import { SettingsFileStore, settingsDirectory } from "./settingsFileStore";

const directories: string[] = [];
async function setup() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orderflow-r13-")); directories.push(directory);
  return { directory, store: new SettingsFileStore(directory), file: path.join(directory, "display.v1.json") };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
describe("R13 atomic development settings file", () => {
  it("explicitly reports missing settings, without creating a fake persisted file", async () => {
    const { store, file } = await setup();
    expect(await store.load()).toEqual({ revision: 0, persisted: false, settings: DEFAULT_DISPLAY_SETTINGS });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("round-trips after a new store instance (process/restart equivalent) and restricts file mode", async () => {
    const { store, file, directory } = await setup(), next = cloneSettings(DEFAULT_DISPLAY_SETTINGS) as any;
    next.heatmap.scale.minimumVolume = 0; next.viewport.timeZone = "UTC";
    const saved = await store.save(next, 0);
    expect(saved.revision).toBe(1);
    expect(await new SettingsFileStore(directory).load()).toEqual(saved);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["revision", "settings"]);
  });
  it("serializes concurrent CAS saves: one succeeds, one conflicts, no lost update", async () => {
    const { store } = await setup(), a = cloneSettings(DEFAULT_DISPLAY_SETTINGS) as any,
      b = cloneSettings(DEFAULT_DISPLAY_SETTINGS) as any;
    a.heatmap.scale.minimumVolume = 0; b.heatmap.scale.minimumVolume = 80;
    const results = await Promise.allSettled([store.save(a, 0), store.save(b, 0)]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { status: 409, code: "SETTINGS_CONFLICT" } });
    expect((await store.load()).settings.heatmap.scale.minimumVolume).toBe(0);
  });
  it("rejects stale revisions while keeping old bytes and permits a subsequent valid write", async () => {
    const { store, file } = await setup();
    await store.save(DEFAULT_DISPLAY_SETTINGS, 0); const old = await fs.readFile(file, "utf8");
    await expect(store.save(DEFAULT_DISPLAY_SETTINGS, 0)).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(file, "utf8")).toBe(old);
    expect((await store.save(DEFAULT_DISPLAY_SETTINGS, 1)).revision).toBe(2);
  });
  it("protects old settings when rename fails; cleans temporary files", async () => {
    const { store, directory, file } = await setup(); await store.save(DEFAULT_DISPLAY_SETTINGS, 0);
    const old = await fs.readFile(file, "utf8");
    const failing = new SettingsFileStore(directory, { ...fs, rename: vi.fn().mockRejectedValue(new Error("disk failure")) });
    await expect(failing.save(DEFAULT_DISPLAY_SETTINGS, 1)).rejects.toMatchObject({ code: "SETTINGS_WRITE_FAILED" });
    expect(await fs.readFile(file, "utf8")).toBe(old);
    expect(await fs.readdir(directory)).toEqual(["display.v1.json"]);
  });
  it("protects old settings when temporary open fails", async () => {
    const { store, directory, file } = await setup(); await store.save(DEFAULT_DISPLAY_SETTINGS, 0);
    const old = await fs.readFile(file, "utf8");
    const failing = new SettingsFileStore(directory, { ...fs, open: vi.fn().mockRejectedValue(new Error("full")) });
    await expect(failing.save(DEFAULT_DISPLAY_SETTINGS, 1)).rejects.toMatchObject({ code: "SETTINGS_WRITE_FAILED" });
    expect(await fs.readFile(file, "utf8")).toBe(old);
  });
  it.each(["{", JSON.stringify({ revision: 1, settings: { ...DEFAULT_DISPLAY_SETTINGS, schemaVersion: 99 } }),
    JSON.stringify({ revision: 1, settings: DEFAULT_DISPLAY_SETTINGS, apiKey: "forbidden" })])(
    "does not silently migrate/reset corrupt or unknown settings", async content => {
      const { store, file } = await setup(); await fs.writeFile(file, content);
      await expect(store.load()).rejects.toMatchObject({ status: 500 });
      await expect(store.save(DEFAULT_DISPLAY_SETTINGS, 0)).rejects.toMatchObject({ status: 500 });
      expect(await fs.readFile(file, "utf8")).toBe(content);
    });
  it("rejects oversize JSON files without loading or overwriting them", async () => {
    const { store, file } = await setup(); await fs.writeFile(file, " ".repeat(MAX_SETTINGS_BYTES + 1));
    await expect(store.load()).rejects.toMatchObject({ code: "SETTINGS_FILE_TOO_LARGE" });
    await expect(store.save(DEFAULT_DISPLAY_SETTINGS, 0)).rejects.toMatchObject({ status: 500 });
  });
  it("rejects symlink targets", async () => {
    const { store, file, directory } = await setup(), target = path.join(directory, "other");
    await fs.writeFile(target, "{}"); await fs.symlink(target, file);
    await expect(store.load()).rejects.toMatchObject({ code: "UNSAFE_SETTINGS_FILE" });
    await expect(store.save(DEFAULT_DISPLAY_SETTINGS, 0)).rejects.toMatchObject({ code: "UNSAFE_SETTINGS_FILE" });
    expect(await fs.readFile(target, "utf8")).toBe("{}");
  });
  it("validates before write and snapshots mutable callers before the queue", async () => {
    const { store } = await setup(), next = cloneSettings(DEFAULT_DISPLAY_SETTINGS) as any;
    next.events = [];
    await expect(store.save(next, 0)).rejects.toMatchObject({ status: 400 });
    delete next.events;
    const saved = store.save(next, 0); next.heatmap.scale.minimumVolume = 0;
    expect((await saved).settings.heatmap.scale.minimumVolume).toBe(50);
  });
  it("uses an outside-workspace fixed directory keyed by workspace, not caller file paths", () => {
    expect(settingsDirectory("/tmp/workspace-A")).toBe(settingsDirectory("/tmp/workspace-A"));
    expect(settingsDirectory("/tmp/workspace-A")).not.toBe(settingsDirectory("/tmp/workspace-B"));
    expect(settingsDirectory("/tmp/workspace-A").startsWith("/tmp/workspace-A/")).toBe(false);
    expect(path.basename(settingsDirectory("/tmp/workspace-A"))).toMatch(/^[0-9a-f]{24}$/);
  });
});
