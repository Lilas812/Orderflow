/** Generation-aware storage for LONG VP runtime and explicit maintenance tools. */
import { Storage, type Bucket } from "@google-cloud/storage";
import * as fs from "node:fs/promises";
import path from "node:path";
export interface CloudVersion {
  generation: string; size: number; contentType?: string; contentEncoding?: string;
  metadata: Record<string, string>; updated?: string;
}
export interface ConditionalCloud {
  stat(name: string): Promise<CloudVersion | null>;
  download(name: string, generation: string, file: string): Promise<void>;
  put(name: string, file: string, expected: string | null, metadata?: Record<string, string>,
    headers?: { contentType?: string; contentEncoding?: string }): Promise<string>;
  remove(name: string, generation: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
export class LongVpCloud implements ConditionalCloud {
  private bucket: Bucket;
  constructor() {
    if (!process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID) throw Error("storage_bucket_not_configured");
    const endpoint = "http://127.0.0.1:1106";
    const storage = new Storage({ projectId: "", credentials: {
      audience: "replit", subject_token_type: "access_token", type: "external_account",
      token_url: `${endpoint}/token`, credential_source: {
        url: `${endpoint}/credential`, format: { type: "json", subject_token_field_name: "access_token" },
      }, universe_domain: "googleapis.com",
    } });
    this.bucket = storage.bucket(process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID);
  }
  async stat(name: string): Promise<CloudVersion | null> {
    try {
      const [m] = await this.bucket.file(name).getMetadata();
      if (!/^\d+$/.test(String(m.generation))) throw Error("invalid_cloud_generation");
      return { generation: String(m.generation), size: Number(m.size), contentType: m.contentType,
        contentEncoding: m.contentEncoding, metadata: m.metadata as Record<string, string> ?? {}, updated: m.updated };
    } catch (e) { if ((e as { code?: number }).code === 404) return null; throw e; }
  }
  async download(name: string, generation: string, file: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Raw stored bytes, not transparent HTTP content-encoding decompression.
    await this.bucket.file(name, { generation }).download({ destination: file, decompress: false });
  }
  async put(name: string, file: string, expected: string | null, metadata: Record<string, string> = {},
    headers: { contentType?: string; contentEncoding?: string } = {}) {
    const [saved] = await this.bucket.upload(file, { destination: name, resumable: false, gzip: false,
      preconditionOpts: { ifGenerationMatch: expected ?? 0 },
      metadata: { ...headers, metadata } });
    // The upload response is our generation. A subsequent unpinned GET could see another writer.
    const m = saved.metadata;
    if (!m.generation) throw Error("uploaded_generation_unavailable");
    return String(m.generation);
  }
  async remove(name: string, generation: string) {
    await this.bucket.file(name).delete({ ifGenerationMatch: generation });
  }
  async list(prefix: string) {
    const [files] = await this.bucket.getFiles({ prefix, autoPaginate: true });
    return files.map(f => f.name).sort();
  }
}
