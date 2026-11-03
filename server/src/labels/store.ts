import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Objects } from "../store/objects.ts";
import { ObjectGenerationConflict } from "../store/objects.ts";
import { LABEL_LIMIT, validDraft, type LabelDraft, type TurningLabel, type LabelsDocument } from "../../../lib/market/labels.ts";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";

export class LabelError extends Error {
  status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}
const fields = ["id", "symbol", "tsSec", "priceTicks", "kind", "confidence", "note", "viewMode",
  "screen", "expectedDirection", "futureSeconds"] as const;
function clean(input: LabelDraft): LabelDraft {
  return Object.fromEntries(fields.map(k => [k, input[k]])) as unknown as LabelDraft;
}

/** Parent-process only. No cached defaults, no blind upload, no automatic CAS retry. */
export class LabelsStore {
  private objects: Objects;
  private prefix: string;
  constructor(objects: Objects, prefix: string) {
    if (!/^(prod|dev)\/$/.test(prefix)) throw Error("invalid_labels_prefix");
    if (!objects.downloadVersion || !objects.uploadConditional) throw Error("labels_require_generation_cas");
    this.objects = objects; this.prefix = prefix;
  }
  private async work<T>(symbol: MarketSymbol, visit: (doc: LabelsDocument, file: string, name: string) => Promise<T>) {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "turning-labels-"));
    const file = path.join(directory, "labels.json"), name = `${this.prefix}labels/${symbol}.json`;
    try {
      const generation = await this.objects.downloadVersion!(name, file);
      let labels: TurningLabel[] = [];
      if (generation !== null) {
        const stat = await fs.stat(file);
        if (stat.size > 16 * 1024 * 1024) throw Error("labels_document_too_large");
        const doc = JSON.parse(await fs.readFile(file, "utf8")) as LabelsDocument;
        if (doc.version !== 1 || !Array.isArray(doc.labels) || doc.labels.length > LABEL_LIMIT
          || !doc.labels.every(l => validDraft(l) && l.symbol === symbol && Number.isSafeInteger(l.createdUs)
            && Number.isSafeInteger(l.updatedUs) && l.updatedUs >= l.createdUs)
          || new Set(doc.labels.map(l => l.id)).size !== doc.labels.length) throw Error("labels_document_invalid");
        labels = doc.labels;
      }
      return await visit({ version: 1, generation: generation ?? "0", labels }, file, name);
    } catch (e) {
      if (e instanceof LabelError) throw e;
      if (e instanceof ObjectGenerationConflict) throw new LabelError(409, "labels_generation_conflict");
      throw new LabelError(503, "labels_io_failed_result_unknown");
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  get(symbol: MarketSymbol) { return this.work(symbol, async doc => doc); }
  mutate(symbol: MarketSymbol, generation: unknown, method: "POST" | "PUT" | "DELETE",
    input: unknown, id?: string, expectedUs?: number) {
    if (typeof generation !== "string" || !/^\d+$/.test(generation)) throw new LabelError(400, "generation_required");
    if (method !== "DELETE" && (!validDraft(input) || input.symbol !== symbol))
      throw new LabelError(400, "invalid_label");
    return this.work(symbol, async (doc, file, name) => {
      const draft = method === "DELETE" ? undefined : clean(input as LabelDraft);
      const key = draft?.id ?? id, index = doc.labels.findIndex(l => l.id === key), old = doc.labels[index];
      // An uncertain POST may be retried, but only the very same record is idempotent.
      if (method === "POST" && old && JSON.stringify(clean(old)) === JSON.stringify(draft)) return doc;
      if (doc.generation !== generation) throw new LabelError(409, "labels_generation_conflict");
      if (method === "POST" && old) throw new LabelError(409, "label_id_conflict");
      if (method !== "POST" && !old) throw new LabelError(404, "label_not_found");
      if (old && expectedUs !== old.updatedUs) throw new LabelError(409, "label_changed");
      if (method === "PUT" && old && draft && ["tsSec", "priceTicks", "viewMode", "screen", "futureSeconds"]
        .some(k => old[k as keyof TurningLabel] !== draft[k as keyof LabelDraft]))
        throw new LabelError(400, "label_origin_immutable");
      if (method === "POST" && doc.labels.length >= LABEL_LIMIT) throw new LabelError(400, "label_limit");
      const now = Math.max(Date.now() * 1000, (old?.updatedUs ?? 0) + 1);
      if (method === "DELETE") doc.labels.splice(index, 1);
      else {
        const record: TurningLabel = { ...draft!, createdUs: old?.createdUs ?? now, updatedUs: now };
        if (old) doc.labels[index] = record; else doc.labels.push(record);
      }
      await fs.writeFile(file, JSON.stringify({ version: 1, labels: doc.labels }), { mode: 0o600 });
      const next = await this.objects.uploadConditional!(name, file, generation);
      // Re-read the exact committed generation; never claim success on an unverified upload.
      const verified = await this.objects.downloadVersion!(name, file, next);
      const readback = JSON.parse(await fs.readFile(file, "utf8"));
      if (verified !== next || JSON.stringify(readback.labels) !== JSON.stringify(doc.labels))
        throw Error("labels_verification_failed");
      return { ...doc, generation: next };
    });
  }
}
