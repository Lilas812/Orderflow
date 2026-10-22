import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { canonical, checksum, insist } from "../sqliteCatalog";
import { encodeIdentity, keyScope, validateIdentity } from "./identityCodec";
import { compareCursor, HistoricalLedgerView, validateCursor, type Cursor, type LedgerEntry,
  type LedgerPort, type LedgerSnapshot, type SeedBinding } from "./historicalLedgerView";
import type { PendingInsert } from "./pendingBranch";

const NAMESPACE = "R166-P1-B-MOCK-SCOPE-EXACT", APP = 0x5031424c;
export const LEDGER_LIMITS = Object.freeze({ entries: 2048, bytes: 8 * 1024 * 1024,
  fingerprintBytes: 1024 * 1024, partBytes: 16 * 1024 });
export interface OwnedLedgerLocation { directory: string; token: string }
export interface LedgerReceipt { root: string; metadataChecksum: string }
function hashEntries(entries: Iterable<LedgerEntry>): string {
  const h = createHash("sha256").update("["); let i = 0;
  for (const e of entries) { if (i++) h.update(","); h.update(canonical(e)); }
  return h.update("]").digest("hex");
}
function text(bytes: unknown): string {
  insist(Buffer.isBuffer(bytes), "LEDGER_CORRUPT", "Expected full UTF-8 bytes");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
function checkLocation(location: OwnedLedgerLocation): string {
  const dir = resolve(location.directory), marker = join(dir, ".r166-p1b-owner");
  insist(dirname(dir) === realpathSync(tmpdir()) && /^r166-p1b-/.test(basename(dir)) &&
    !lstatSync(dir).isSymbolicLink() && realpathSync(dir) === dir &&
    (lstatSync(dir).mode & 0o077) === 0, "LEDGER_OWNERSHIP", "Owned temporary private directory only");
  const st = lstatSync(marker);
  insist(st.isFile() && !st.isSymbolicLink() && st.size <= 256 &&
    readFileSync(marker, "utf8") === location.token && /^[a-f0-9-]{36}$/.test(location.token),
  "LEDGER_OWNERSHIP", "Required out-of-DB ownership marker differs");
  return join(dir, "prototype-ledger.sqlite");
}
/** Separate disposable DB, NOT SqliteCatalog, NOT user_version=3, NOT dual write.
 * All verification is full finite verification. No verified-prefix skipping.
 * Caller retains the receipt as independent evidence across reopen. */
export class SqliteLedger {
  readonly db: Database.Database;
  private constructor(readonly location: OwnedLedgerLocation, creating: boolean, expected?: LedgerReceipt) {
    const file = checkLocation(location);
    if (!creating) insist(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(),
      "LEDGER_OWNERSHIP", "Unsafe prototype DB");
    this.db = new Database(file, { fileMustExist: !creating, timeout: 0 });
    try {
      if (creating) chmodSync(file, 0o600);
      this.db.pragma("foreign_keys=ON"); this.db.pragma("journal_mode=WAL"); this.db.pragma("synchronous=FULL");
      this.db.pragma("cache_size=-2048"); this.db.pragma("mmap_size=0");
      if (!creating) {
        insist(this.db.pragma("application_id", { simple: true }) === APP &&
          this.db.pragma("user_version", { simple: true }) === 1, "LEDGER_OWNERSHIP", "Not the prototype schema");
        this.verify(expected);
      }
    } catch (error) { this.db.close(); throw error; }
  }
  static create(input: { scopeId: string; epoch: string; coverage?: LedgerSnapshot["coverage"]; evidence: string }): SqliteLedger {
    const scope = JSON.parse(input.scopeId);
    insist(Array.isArray(scope) && scope.length === 6 && scope[0] === "MOCK" &&
      scope.every(s => typeof s === "string") && JSON.stringify(scope) === input.scopeId &&
      input.epoch.trim() && input.epoch.length <= 128 && input.evidence.trim() &&
      Buffer.byteLength(input.evidence) <= 4096 && Buffer.byteLength(input.scopeId) <= 65536,
    "MOCK_ONLY", "Explicit finite eligible MOCK scope/evidence required");
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "r166-p1b-")), token = randomUUID();
    writeFileSync(join(directory, ".r166-p1b-owner"), token, { mode: 0o600, flag: "wx" });
    const ledger = new SqliteLedger({ directory, token }, true);
    try {
      ledger.db.transaction(() => {
        ledger.db.exec(`
          CREATE TABLE ledger_meta(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
          CREATE TABLE ledger_entries(
            key TEXT PRIMARY KEY COLLATE BINARY, namespace TEXT NOT NULL, scope_id TEXT NOT NULL,
            first_epoch TEXT NOT NULL, first_position INTEGER NOT NULL, first_ordinal INTEGER NOT NULL,
            insert_order INTEGER NOT NULL UNIQUE, byte_count INTEGER NOT NULL, part_count INTEGER NOT NULL,
            fp_digest TEXT NOT NULL, checksum TEXT NOT NULL
          ) STRICT;
          CREATE TABLE fingerprint_parts(
            key TEXT NOT NULL REFERENCES ledger_entries(key),part INTEGER NOT NULL,bytes BLOB NOT NULL,
            PRIMARY KEY(key,part)
          ) STRICT;
          CREATE TABLE ledger_seed(id TEXT PRIMARY KEY,payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
          PRAGMA application_id=${APP}; PRAGMA user_version=1;
        `);
        ledger.save({ namespace: NAMESPACE, scopeId: input.scopeId, epoch: input.epoch,
          coverage: input.coverage ?? "FULL_SCOPE_FROM_START", evidence: input.evidence,
          through: { position: "0", ordinal: 0 }, count: 0, bytes: 0, root: hashEntries([]), seed: null });
      }).immediate();
      return ledger;
    } catch (error) { ledger.close(); throw error; }
  }
  static open(location: OwnedLedgerLocation, expected: LedgerReceipt): SqliteLedger {
    return new SqliteLedger(location, false, expected);
  }
  private save(meta: LedgerSnapshot): void {
    this.db.prepare("INSERT OR REPLACE INTO ledger_meta VALUES(1,?,?)").run(canonical(meta), checksum(meta));
  }
  private metadata(): LedgerSnapshot {
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(payload AS BLOB))<=65536 THEN CAST(payload AS BLOB) END AS payload,
      CASE WHEN length(checksum)=64 THEN checksum END AS checksum FROM ledger_meta WHERE id=1`).get() as
      { payload: Buffer | null; checksum: string | null } | undefined;
    insist(row?.payload, "LEDGER_CORRUPT", "Missing/oversized ledger metadata");
    const m = JSON.parse(text(row.payload)) as LedgerSnapshot;
    insist(checksum(m) === row.checksum && m.namespace === NAMESPACE && typeof m.epoch === "string" &&
      m.epoch.trim() && ["FULL_SCOPE_FROM_START", "UNPROVEN"].includes(m.coverage) &&
      typeof m.evidence === "string" && m.evidence.trim() && Number.isSafeInteger(m.count) &&
      m.count >= 0 && m.count <= LEDGER_LIMITS.entries && Number.isSafeInteger(m.bytes) &&
      m.bytes >= 0 && m.bytes <= LEDGER_LIMITS.bytes, "LEDGER_CORRUPT", "Metadata checksum/limits differ");
    validateCursor(m.through); return m;
  }
  private *readEntries(): Generator<LedgerEntry> {
    const query = `SELECT
      CASE WHEN length(CAST(key AS BLOB))<=1048576 THEN CAST(key AS BLOB) END AS key,
      CASE WHEN length(namespace)<=128 THEN namespace END AS namespace,
      CASE WHEN length(CAST(scope_id AS BLOB))<=1048576 THEN CAST(scope_id AS BLOB) END AS scope_id,
      CASE WHEN length(first_epoch)<=128 THEN first_epoch END AS first_epoch,
      first_position,first_ordinal,insert_order,byte_count,part_count,
      CASE WHEN length(fp_digest)=64 THEN fp_digest END AS fp_digest,
      CASE WHEN length(checksum)=64 THEN checksum END AS checksum
      FROM ledger_entries ORDER BY insert_order`;
    let seen = 0;
    for (const row of this.db.prepare(query).safeIntegers().iterate() as Iterable<Record<string, unknown>>) {
      insist(++seen <= LEDGER_LIMITS.entries && typeof row.byte_count === "bigint" && row.byte_count > 0n &&
        row.byte_count <= BigInt(LEDGER_LIMITS.fingerprintBytes) && typeof row.part_count === "bigint" &&
        row.part_count === BigInt(Math.ceil(Number(row.byte_count) / LEDGER_LIMITS.partBytes)),
      "LEDGER_CORRUPT", "Entry size/count budget");
      const key = text(row.key), bytes = Buffer.alloc(Number(row.byte_count));
      let ordinal = 0, offset = 0;
      for (const part of this.db.prepare(`SELECT part,
        CASE WHEN length(bytes)<=${LEDGER_LIMITS.partBytes} THEN bytes END AS bytes
        FROM fingerprint_parts WHERE key=? ORDER BY part`).safeIntegers().iterate(key) as
        Iterable<{ part: bigint; bytes: Buffer | null }>) {
        insist(part.part === BigInt(ordinal++) && Buffer.isBuffer(part.bytes) &&
          part.bytes.length === Math.min(LEDGER_LIMITS.partBytes, bytes.length - offset),
        "LEDGER_CORRUPT", "Missing, extra or malformed fingerprint part");
        part.bytes.copy(bytes, offset); offset += part.bytes.length;
      }
      insist(ordinal === Number(row.part_count) && offset === bytes.length &&
        createHash("sha256").update(bytes).digest("hex") === row.fp_digest,
      "LEDGER_CORRUPT", "Incomplete/changed full fingerprint");
      const e: LedgerEntry = { key, fingerprint: text(bytes),
        first: { position: String(row.first_position), ordinal: Number(row.first_ordinal) },
        insertOrder: Number(row.insert_order), firstEpoch: row.first_epoch as string,
        namespace: row.namespace as string, scopeId: text(row.scope_id) };
      validateCursor(e.first);
      insist(e.first.position !== "0", "LEDGER_CORRUPT", "Birth must reference a positive journal position");
      validateIdentity(e.key, e.fingerprint);
      insist(checksum(e) === row.checksum && e.insertOrder === seen &&
        e.namespace === NAMESPACE && typeof e.firstEpoch === "string" && e.firstEpoch.trim(),
      "LEDGER_CORRUPT", "Birth/order/full-entry checksum differs");
      yield e;
    }
  }
  private readTransaction<T>(operation: () => T): T {
    return this.db.inTransaction ? operation() : this.db.transaction(operation).deferred();
  }
  verify(expected?: LedgerReceipt): LedgerSnapshot {
    return this.readTransaction(() => this.verifyInside(expected));
  }
  private verifyInside(expected?: LedgerReceipt): LedgerSnapshot {
    insist(this.db.pragma("quick_check", { simple: true }) === "ok", "LEDGER_CORRUPT", "SQLite corruption");
    const m = this.metadata();
    let count = 0, bytes = 0, previous: Cursor = { position: "0", ordinal: 0 };
    const root = hashEntries((function* (self: SqliteLedger) {
      for (const e of self.readEntries()) {
        insist(e.scopeId === m.scopeId && keyScope(e.key) === m.scopeId &&
          compareCursor(e.first, previous) > 0 && compareCursor(e.first, m.through) <= 0,
        "LEDGER_CORRUPT", "Scope/birth order differs");
        previous = e.first; count++; bytes += Buffer.byteLength(e.key) + Buffer.byteLength(e.fingerprint);
        insist(bytes <= LEDGER_LIMITS.bytes, "BUDGET_EXCEEDED", "Finite total ledger byte budget"); yield e;
      }
    })(this));
    insist(count === m.count && bytes === m.bytes && root === m.root, "LEDGER_CORRUPT", "Missing/extra entry or root mismatch");
    insist((this.db.prepare("SELECT count(*) AS n FROM fingerprint_parts WHERE key NOT IN (SELECT key FROM ledger_entries)")
      .get() as { n: number }).n === 0, "LEDGER_CORRUPT", "Orphan fingerprint parts");
    const seeds: { id: string; payload: string; checksum: string }[] = [];
    for (const row of this.db.prepare(`SELECT
      CASE WHEN length(id)<=128 THEN id END AS id,
      CASE WHEN length(CAST(payload AS BLOB))<=65536 THEN CAST(payload AS BLOB) END AS payload,
      CASE WHEN length(checksum)=64 THEN checksum END AS checksum FROM ledger_seed`).iterate() as
      Iterable<{ id: string | null; payload: Buffer | null; checksum: string | null }>) {
      insist(seeds.length < 1 && row.id && row.checksum && row.payload, "SEED_BINDING", "Oversized/extra seed");
      seeds.push({ id: row.id, payload: text(row.payload), checksum: row.checksum });
    }
    insist(seeds.length === (m.seed ? 1 : 0), "SEED_BINDING", "Missing/extra/orphan seed");
    if (m.seed) {
      const seed = seeds[0];
      insist(seed.id === m.seed.id && seed.payload.length <= 65536 && checksum(JSON.parse(seed.payload)) === seed.checksum &&
        canonical(JSON.parse(seed.payload)) === canonical(m.seed) && compareCursor(m.seed.through, m.through) <= 0,
      "SEED_BINDING", "Anchor seed checksum/binding differs");
      const self = this;
      insist(hashEntries((function* () {
        for (const e of self.readEntries()) if (compareCursor(e.first, m.seed!.through) <= 0) yield e;
      })()) === m.seed.entriesRoot, "SEED_BINDING", "Seed prefix lacks complete exact entries");
    }
    if (expected) insist(expected.root === m.root && expected.metadataChecksum === checksum(m),
      "LEDGER_RECEIPT", "Independent receipt mismatch");
    return structuredClone(m);
  }
  receipt(): LedgerReceipt { const m = this.verify(); return { root: m.root, metadataChecksum: checksum(m) }; }
  port(): LedgerPort {
    const receipt = this.receipt();
    const snapshot = () => this.verify(receipt);
    return { snapshot, entry: key => this.readTransaction(() => {
      snapshot(); for (const e of this.readEntries()) if (e.key === key) return e;
      return undefined;
    }), entries: () => this.readTransaction(() => { snapshot(); return [...this.readEntries()]; }) };
  }
  view(cursor: Cursor, inclusive = false): HistoricalLedgerView {
    const m = this.verify();
    return new HistoricalLedgerView(this.port(), cursor, { epoch: m.epoch,
      ...(m.seed ? { anchorId: m.seed.anchorId, seedId: m.seed.id } : {}) }, inclusive);
  }
  commit(inserts: readonly PendingInsert[], through: Cursor, expected: LedgerReceipt,
    fault?: () => void): LedgerReceipt {
    validateCursor(through);
    insist(inserts.length <= 128, "BUDGET_EXCEEDED", "Commit insert budget");
    this.db.transaction(() => {
      const m = this.verify(expected);
      insist(m.coverage === "FULL_SCOPE_FROM_START", "COVERAGE_UNPROVEN", "No new ID under incomplete coverage");
      insist(compareCursor(through, m.through) >= 0, "CURSOR", "Cannot regress coverage cursor");
      let previous = m.through;
      for (const input of inserts) {
        insist(Buffer.byteLength(input.fingerprint) <= LEDGER_LIMITS.fingerprintBytes &&
          Buffer.byteLength(input.key) <= LEDGER_LIMITS.fingerprintBytes,
        "BUDGET_EXCEEDED", "Full key/fingerprint preflight budget");
        const e: LedgerEntry = { ...structuredClone(input), namespace: NAMESPACE, scopeId: m.scopeId,
          firstEpoch: m.epoch, insertOrder: m.count + 1 };
        validateIdentity(e.key, e.fingerprint);
        const encoded = encodeIdentity(JSON.parse(e.fingerprint));
        const bytes = Buffer.from(e.fingerprint);
        insist(e.first.position !== "0" && encoded.scopeId === m.scopeId && compareCursor(e.first, previous) > 0 &&
          compareCursor(e.first, through) <= 0, "CURSOR", "Insert scope/birth invalid");
        insist(bytes.length <= LEDGER_LIMITS.fingerprintBytes &&
          m.count + 1 <= LEDGER_LIMITS.entries && m.bytes + bytes.length + Buffer.byteLength(e.key) <= LEDGER_LIMITS.bytes,
        "BUDGET_EXCEEDED", "Full fingerprint/ledger capacity");
        this.db.prepare("INSERT INTO ledger_entries VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
          e.key, e.namespace, e.scopeId, e.firstEpoch, BigInt(e.first.position), e.first.ordinal,
          e.insertOrder, bytes.length, Math.ceil(bytes.length / LEDGER_LIMITS.partBytes),
          createHash("sha256").update(bytes).digest("hex"), checksum(e));
        for (let p = 0; p * LEDGER_LIMITS.partBytes < bytes.length; p++) {
          this.db.prepare("INSERT INTO fingerprint_parts VALUES(?,?,?)")
            .run(e.key, p, bytes.subarray(p * LEDGER_LIMITS.partBytes, (p + 1) * LEDGER_LIMITS.partBytes));
        }
        previous = e.first; m.count++; m.bytes += bytes.length + Buffer.byteLength(e.key);
      }
      m.through = { ...through }; m.root = hashEntries(this.readEntries()); this.save(m);
      fault?.(); this.verify();
    }).immediate();
    return this.receipt();
  }
  switchEpoch(epoch: string, expected: LedgerReceipt): LedgerReceipt {
    insist(epoch.trim().length > 0 && epoch.length <= 128, "EPOCH_MISMATCH", "Explicit finite epoch required");
    this.db.transaction(() => {
      const m = this.verify(expected); this.save({ ...m, epoch }); this.verify();
    }).immediate();
    return this.receipt();
  }
  bindSeed(id: string, anchorId: string, expected: LedgerReceipt): LedgerReceipt {
    insist(id.trim() && anchorId.trim() && id.length <= 128 && anchorId.length <= 128, "SEED_BINDING", "Explicit seed/anchor");
    this.db.transaction(() => {
      const m = this.verify(expected);
      insist(!m.seed && m.coverage === "FULL_SCOPE_FROM_START", "SEED_BINDING", "Only complete, first seed binding");
      const seed: SeedBinding = { id, anchorId, epoch: m.epoch, through: { ...m.through }, entriesRoot: m.root };
      this.db.prepare("INSERT INTO ledger_seed VALUES(?,?,?)").run(id, canonical(seed), checksum(seed));
      this.save({ ...m, seed }); this.verify();
    }).immediate();
    return this.receipt();
  }
  close(): void { if (this.db.open) this.db.close(); }
}
