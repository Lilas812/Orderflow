import * as fs from "node:fs/promises";
import path from "node:path";
import type { Objects } from "../store/objects.ts";
import { settingsStage } from "./trace.ts";

/** Both independent reads must settle before the serial owner releases staging.
 * Promise.all's early rejection would let a later request race an old download. */
export async function fetchSettingsFile(objects: Objects, prefix: string, name: string, file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const results = await Promise.allSettled([
    (async () => {
      if (await settingsStage("cloud_exists", () => objects.exists(prefix + name + ".json"))) {
        await settingsStage("cloud_download", () => objects.download(prefix + name + ".json", file + ".cloud"));
        await fs.rename(file + ".cloud", file);
      } else await fs.rm(file, { force: true });
    })(),
    (async () => settingsStage("cloud_list", () => objects.list(prefix + name + ".corrupt-")))(),
  ]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  const list = results[1];
  return list.status === "fulfilled" ? list.value : [];
}
