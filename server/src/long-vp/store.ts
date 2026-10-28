import pg from "pg";
import { LongAggregate } from "./aggregate.ts";
import type { MinuteBar, PriceVolume } from "./aggregate.ts";
import type { Roll } from "./rest.ts";
export interface Interval { startUs: number; endUs: number; }
export interface Gap extends Interval { reason: string; }
export interface SessionRecord extends Interval {
  date: string; complete: boolean; coverage: Interval[]; gaps: Gap[]; trades: number; updatedUs: number;
}
export interface LongStore {
  records(): Promise<SessionRecord[]>;
  rolls(): Promise<Roll[]>;
  load(date: string): Promise<LongAggregate>;
  save(record: SessionRecord, aggregate: LongAggregate, rolls: Roll[]): Promise<void>;
  close(): Promise<void>;
}
/** No startup DDL. Production tables are supplied by Replit's Publish schema diff. */
export class PgLongStore implements LongStore {
  private pool: pg.Pool;
  constructor(url: string, pool?: pg.Pool) {
    this.pool = pool ?? new pg.Pool({ connectionString: url, max: 1, idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 10000, query_timeout: 30000, statement_timeout: 30000 });
    // Do not expose driver errors (which can contain connection information).
    this.pool.on("error", () => {
      process.stderr.write(JSON.stringify({ event: "long_vp_db_idle_error", reason: "database_connection_lost" }) + "\n");
    });
  }
  async records(): Promise<SessionRecord[]> {
    const r = await this.pool.query(`SELECT date, start_us AS "startUs", end_us AS "endUs",
      complete, coverage, gaps, trades, updated_us AS "updatedUs" FROM long_vp_sessions ORDER BY date`);
    return r.rows.map(x => ({ ...x, startUs: Number(x.startUs), endUs: Number(x.endUs),
      trades: Number(x.trades), updatedUs: Number(x.updatedUs) }));
  }
  async rolls(): Promise<Roll[]> {
    const r = await this.pool.query('SELECT contract, since_us AS "sinceUs" FROM long_vp_rolls ORDER BY since_us');
    return r.rows.map(x => ({ contract: x.contract, sinceUs: Number(x.sinceUs) }));
  }
  async load(date: string) {
    const result = new LongAggregate();
    const volumes = await this.pool.query('SELECT contract, start_us AS "startUs", price, buy, sell FROM long_vp_volumes WHERE date=$1', [date]);
    const minutes = await this.pool.query(`SELECT contract, start_us AS "startUs", open, high, low, close,
      buy, sell, first_us AS "firstUs", last_us AS "lastUs" FROM long_vp_minutes WHERE date=$1`, [date]);
    for (const r of volumes.rows) {
      const v: PriceVolume = { ...r, startUs: Number(r.startUs), buy: Number(r.buy), sell: Number(r.sell) };
      result.volumes.set(`${v.contract}:${v.startUs}:${v.price}`, v);
    }
    for (const r of minutes.rows) {
      const b: MinuteBar = { ...r, startUs: Number(r.startUs), buy: Number(r.buy), sell: Number(r.sell),
        firstUs: Number(r.firstUs), lastUs: Number(r.lastUs) };
      result.minutes.set(`${b.contract}:${b.startUs}`, b);
    }
    return result;
  }
  async save(record: SessionRecord, aggregate: LongAggregate, rolls: Roll[]) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // During a rolling publish an old and a new process may briefly overlap.
      // Never let a stale partial batch replace a completed day's REST result.
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["long_vp:" + record.date]);
      const current = await c.query("SELECT complete FROM long_vp_sessions WHERE date=$1 FOR UPDATE", [record.date]);
      if (current.rows[0]?.complete) { await c.query("COMMIT"); return; }
      for (const r of rolls) {
        await c.query(`INSERT INTO long_vp_rolls(since_us,contract) VALUES($1,$2)
          ON CONFLICT(since_us) DO NOTHING`, [r.sinceUs, r.contract]);
        const existing = await c.query("SELECT contract FROM long_vp_rolls WHERE since_us=$1", [r.sinceUs]);
        if (existing.rows[0].contract !== r.contract) throw Error("conflicting_roll_metadata");
      }
      await c.query(`INSERT INTO long_vp_sessions(date,start_us,end_us,complete,coverage,gaps,trades,updated_us)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) ON CONFLICT(date) DO UPDATE SET
        complete=excluded.complete,coverage=excluded.coverage,gaps=excluded.gaps,
        trades=excluded.trades,updated_us=excluded.updated_us`,
      [record.date, record.startUs, record.endUs, record.complete, JSON.stringify(record.coverage),
        JSON.stringify(record.gaps), record.trades, record.updatedUs]);
      await c.query("DELETE FROM long_vp_volumes WHERE date=$1", [record.date]);
      await c.query("DELETE FROM long_vp_minutes WHERE date=$1", [record.date]);
      const volumes = [...aggregate.volumes.values()], minutes = [...aggregate.minutes.values()];
      for (let i = 0; i < volumes.length; i += 500) await c.query(`INSERT INTO long_vp_volumes(date,contract,start_us,price,buy,sell)
        SELECT $1, contract, "startUs", price, buy, sell FROM jsonb_to_recordset($2::jsonb)
        AS x(contract text,"startUs" bigint,price integer,buy bigint,sell bigint)`,
      [record.date, JSON.stringify(volumes.slice(i, i + 500))]);
      for (let i = 0; i < minutes.length; i += 500) await c.query(`INSERT INTO long_vp_minutes
        (date,contract,start_us,open,high,low,close,buy,sell,first_us,last_us)
        SELECT $1,contract,"startUs",open,high,low,close,buy,sell,"firstUs","lastUs"
        FROM jsonb_to_recordset($2::jsonb) AS x(contract text,"startUs" bigint,open integer,high integer,
        low integer,close integer,buy bigint,sell bigint,"firstUs" bigint,"lastUs" bigint)`,
      [record.date, JSON.stringify(minutes.slice(i, i + 500))]);
      await c.query("COMMIT");
    } catch {
      await c.query("ROLLBACK").catch(() => {});
      throw Error("long_vp_transaction_failed");
    } finally { c.release(); }
  }
  async close() { await this.pool.end(); }
}
