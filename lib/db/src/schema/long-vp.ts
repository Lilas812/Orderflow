import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const longVpSessions = pgTable("long_vp_sessions", {
  date: text("date").primaryKey(),
  startUs: bigint("start_us", { mode: "number" }).notNull(),
  endUs: bigint("end_us", { mode: "number" }).notNull(),
  complete: boolean("complete").notNull(),
  coverage: jsonb("coverage").notNull(),
  gaps: jsonb("gaps").notNull(),
  trades: bigint("trades", { mode: "number" }).notNull(),
  updatedUs: bigint("updated_us", { mode: "number" }).notNull(),
});
export const longVpVolumes = pgTable("long_vp_volumes", {
  date: text("date").notNull().references(() => longVpSessions.date),
  contract: text("contract").notNull(),
  startUs: bigint("start_us", { mode: "number" }).notNull(),
  price: integer("price").notNull(),
  buy: bigint("buy", { mode: "number" }).notNull(),
  sell: bigint("sell", { mode: "number" }).notNull(),
}, t => [primaryKey({ columns: [t.date, t.contract, t.startUs, t.price] })]);
export const longVpMinutes = pgTable("long_vp_minutes", {
  date: text("date").notNull().references(() => longVpSessions.date),
  contract: text("contract").notNull(),
  startUs: bigint("start_us", { mode: "number" }).notNull(),
  open: integer("open").notNull(), high: integer("high").notNull(),
  low: integer("low").notNull(), close: integer("close").notNull(),
  buy: bigint("buy", { mode: "number" }).notNull(), sell: bigint("sell", { mode: "number" }).notNull(),
  firstUs: bigint("first_us", { mode: "number" }).notNull(),
  lastUs: bigint("last_us", { mode: "number" }).notNull(),
}, t => [primaryKey({ columns: [t.date, t.contract, t.startUs] })]);
export const longVpRolls = pgTable("long_vp_rolls", {
  sinceUs: bigint("since_us", { mode: "number" }).primaryKey(),
  contract: text("contract").notNull(),
});
