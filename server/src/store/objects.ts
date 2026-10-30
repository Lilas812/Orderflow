import { Client } from "@replit/object-storage";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Storage } from "@google-cloud/storage";

export class ObjectGenerationConflict extends Error {
  constructor() { super("object_generation_conflict"); }
}

/** Only filenames cross this boundary for market data. No downloadAsBytes. */
export interface Objects {
  exists(name: string): Promise<boolean>;
  download(name: string, file: string): Promise<void>;
  upload(name: string, file: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  downloadVersion?(name: string, file: string, generation?: string): Promise<string | null>;
  uploadConditional?(name: string, file: string, generation: string): Promise<string>;
}
export class ReplitObjects implements Objects {
  private client = new Client({ bucketId: process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID });
  // Same sidecar auth as the SDK; its public API does not expose generation preconditions.
  private versioned = new Storage({ projectId: "", credentials: {
    audience: "replit", subject_token_type: "access_token", type: "external_account",
    token_url: "http://127.0.0.1:1106/token", universe_domain: "googleapis.com",
    credential_source: { url: "http://127.0.0.1:1106/credential",
      format: { type: "json", subject_token_field_name: "access_token" } },
  } });
  private bucket() {
    const id = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
    if (!id) throw Error("object_bucket_missing");
    return this.versioned.bucket(id);
  }
  async downloadVersion(name: string, file: string, generation?: string) {
    try {
      const bucket = this.bucket();
      if (!generation) {
        const [meta] = await bucket.file(name).getMetadata();
        generation = String(meta.generation ?? "");
        if (!/^[1-9]\d*$/.test(generation)) throw Error("object_generation_missing");
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await bucket.file(name, { generation }).download({ destination: file });
      return generation;
    } catch (error) {
      if ((error as { code?: number }).code === 404) {
        if (generation) throw new ObjectGenerationConflict();
        return null;
      }
      throw error;
    }
  }
  async uploadConditional(name: string, file: string, generation: string) {
    try {
      const [uploaded] = await this.bucket().upload(file, { destination: name, resumable: false,
        preconditionOpts: { ifGenerationMatch: generation } });
      const next = String(uploaded.metadata.generation ?? "");
      if (!/^[1-9]\d*$/.test(next)) throw Error("object_generation_missing");
      return next;
    } catch (error) {
      if ((error as { code?: number }).code === 412) throw new ObjectGenerationConflict();
      throw error;
    }
  }
  async exists(name: string) {
    const result = await this.client.exists(name);
    if (!result.ok) throw new Error("object_exists_failed", { cause: result.error });
    return result.value;
  }
  async download(name: string, file: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const result = await this.client.downloadToFilename(name, file);
    if (!result.ok) throw new Error("object_download_failed", { cause: result.error });
  }
  async upload(name: string, file: string) {
    const result = await this.client.uploadFromFilename(name, file);
    if (!result.ok) throw new Error("object_upload_failed", { cause: result.error });
  }
  async list(prefix: string) {
    const result = await this.client.list({ prefix });
    if (!result.ok) throw new Error("object_list_failed", { cause: result.error });
    return result.value.map(object => object.name);
  }
}
export async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export type UploadObservation = <T>(phase: "source_hash" | "upload" | "verification", work: () => Promise<T>) => Promise<T>;
export async function uploadVerified(objects: Objects, name: string, file: string, signal?: AbortSignal,
  observe: UploadObservation = (_phase, work) => work()): Promise<void> {
  const check = file + "." + randomUUID() + ".verify";
  try {
    signal?.throwIfAborted();
    const before = await observe("source_hash", () => digest(file));
    signal?.throwIfAborted();
    await observe("upload", () => objects.upload(name, file));
    signal?.throwIfAborted();
    await observe("verification", async () => {
      await objects.download(name, check);
      signal?.throwIfAborted();
      if (await digest(check) !== before) throw Error("object_verification_failed");
    });
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
