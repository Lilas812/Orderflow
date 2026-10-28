import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PgLongStore } from "../src/long-vp/store.ts";
import type { SessionRecord } from "../src/long-vp/store.ts";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { session } from "../src/long-vp/calendar.ts";

test("DUMMY long VP PostgreSQL temp tables: atomic rollback, idempotent replacement, completed-day guard",
  { skip: !process.env.DATABASE_URL || process.env.REPLIT_DEPLOYMENT === "1" }, async () => {
    // Connection-local temporary tables shadow the new schema; never write real market data or public rows.
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, idleTimeoutMillis: 0 });
    const store = new PgLongStore("", pool);
    try {
      for (const name of ["sessions", "volumes", "minutes", "rolls"])
        await pool.query(`CREATE TEMP TABLE long_vp_${name} (LIKE public.long_vp_${name} INCLUDING ALL)`);
      const s = session("2026-10-28");
      const r: SessionRecord = { ...s, complete: false, coverage: [
        { startUs: s.startUs, endUs: s.startUs + 1e6 }], gaps: [], trades: 1, updatedUs: s.endUs };
      const a = new LongAggregate();
      a.add({ tsUs: s.startUs, price: 400, size: 2, side: "buy" }, "NQZ6");
      const rolls = [{ contract: "NQZ6", sinceUs: s.startUs - 1e6 }];
      await store.save(r, a, rolls);
      await store.save(r, a, rolls);
      assert.equal((await pool.query("SELECT count(*) FROM long_vp_volumes")).rows[0].count, "1");
      const before = await store.records();
      const invalid = new LongAggregate();
      invalid.add({ tsUs: s.startUs, price: NaN, size: 2, side: "buy" }, "NQZ6");
      await assert.rejects(store.save({ ...r, trades: 999 }, invalid, rolls), /long_vp_transaction_failed/);
      assert.deepEqual(await store.records(), before);
      assert.equal((await store.load(s.date)).volumes.values().next().value!.buy, 2);
      const conflict = [{ contract: "NQH7", sinceUs: rolls[0].sinceUs }];
      await assert.rejects(store.save(r, a, conflict), /long_vp_transaction_failed/);
      assert.deepEqual(await store.rolls(), rolls);
      await store.save({ ...r, complete: true }, a, rolls);
      await store.save({ ...r, trades: 999 }, new LongAggregate(), rolls);
      assert.equal((await store.records())[0].trades, 1);
      assert.equal((await store.records())[0].complete, true);
      assert.equal((await store.load(s.date)).minutes.size, 1);
    } finally { await store.close(); }
  });
