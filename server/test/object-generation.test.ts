import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReplitObjects, ObjectGenerationConflict } from "../src/store/objects.ts";

test("generation adapter pins download body to metadata and sends exact ifGenerationMatch, including 0", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "generation-adapter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // No SDK constructor, sidecar, credentials or real bucket is used in this contract test.
  const adapter = Object.create(ReplitObjects.prototype) as ReplitObjects;
  const calls: any[] = [], generation = "90071992547409930001";
  (adapter as any).bucket = () => ({
    file: (name: string, options: unknown) => {
      calls.push({ method: "file", name, options });
      return {
        getMetadata: async () => [{ generation }],
        download: async ({ destination }: { destination: string }) => fs.writeFile(destination, "DUMMY"),
      };
    },
    upload: async (file: string, options: unknown) => {
      calls.push({ method: "upload", file, options }); return [{ metadata: { generation } }];
    },
  });
  assert.equal(await adapter.downloadVersion("day", path.join(root, "copy")), generation);
  assert.deepEqual(calls[1].options, { generation });
  assert.equal(await fs.readFile(path.join(root, "copy"), "utf8"), "DUMMY");
  await adapter.uploadConditional("day", "localfile", generation);
  assert.equal(calls.at(-1).options.preconditionOpts.ifGenerationMatch, generation);
  await adapter.uploadConditional("day", "localfile", "0");
  assert.equal(calls.at(-1).options.preconditionOpts.ifGenerationMatch, "0");
  assert.equal(calls.at(-1).options.resumable, false);
});
test("generation adapter distinguishes absent latest object from vanished pinned generation and 412 conflict", async () => {
  const adapter = Object.create(ReplitObjects.prototype) as ReplitObjects;
  (adapter as any).bucket = () => ({
    file: () => ({ getMetadata: async () => { throw { code: 404 }; },
      download: async () => { throw { code: 404 }; } }),
    upload: async () => { throw { code: 412 }; },
  });
  assert.equal(await adapter.downloadVersion("missing", "unused"), null);
  await assert.rejects(adapter.downloadVersion("day", "unused", "123"), ObjectGenerationConflict);
  await assert.rejects(adapter.uploadConditional("day", "unused", "123"), ObjectGenerationConflict);
  (adapter as any).bucket = () => ({ upload: async () => { throw Error("DUMMY transport"); } });
  await assert.rejects(adapter.uploadConditional("day", "unused", "123"), /DUMMY transport/);
});
