import { Client } from "@replit/object-storage";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

/** Only filenames cross this boundary for market data. No downloadAsBytes. */
export interface Objects {
  exists(name: string): Promise<boolean>;
  download(name: string, file: string): Promise<void>;
  upload(name: string, file: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
export class ReplitObjects implements Objects {
  private client = new Client({ bucketId: process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID });
  async exists(name: string) {
    const result = await this.client.exists(name);
    if (!result.ok) throw Error("object_exists_failed");
    return result.value;
  }
  async download(name: string, file: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const result = await this.client.downloadToFilename(name, file);
    if (!result.ok) throw Error("object_download_failed");
  }
  async upload(name: string, file: string) {
    const result = await this.client.uploadFromFilename(name, file);
    if (!result.ok) throw Error("object_upload_failed");
  }
  async list(prefix: string) {
    const result = await this.client.list({ prefix });
    if (!result.ok) throw Error("object_list_failed");
    return result.value.map(object => object.name);
  }
}
export async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function uploadVerified(objects: Objects, name: string, file: string, signal?: AbortSignal): Promise<void> {
  const check = file + "." + randomUUID() + ".verify";
  try {
    signal?.throwIfAborted();
    const before = await digest(file);
    signal?.throwIfAborted();
    await objects.upload(name, file);
    signal?.throwIfAborted();
    await objects.download(name, check);
    signal?.throwIfAborted();
    if (await digest(check) !== before) throw Error("object_verification_failed");
    signal?.throwIfAborted();
  } finally { await fs.rm(check, { force: true }); }
}
export function storageMode(env: NodeJS.ProcessEnv) {
  const published = env.REPLIT_DEPLOYMENT === "1";
  if (env.HEATMAP_STORAGE && !["local", "app-storage"].includes(env.HEATMAP_STORAGE))
    throw Error("invalid_storage_mode");
  return { app: published || env.HEATMAP_STORAGE === "app-storage",
    prefix: published ? "prod/" : "dev/" };
}
