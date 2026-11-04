import type { Log } from "../logger.ts";

export class Metrics {
  readonly bookRejections: Record<string, number> = Object.create(null);
  readonly byType: Record<string, number> = Object.create(null);
  readonly counts: Record<string, number> = {
    nonPositiveBookLevels: 0, crossedBook: 0, bookOrder: 0,
    duplicatePrice: 0, offTick: 0, bookTimestampRollback: 0, tradeTimestampRollback: 0,
    warning: 0, feed: 0, error: 0, ticksLagged: 0,
    invalidJson: 0, invalidMessage: 0, unknownType: 0,
    rejectedBook: 0, rejectedTrade: 0, acceptedBook: 0, acceptedTrade: 0,
    disconnects: 0, abnormalClose: 0, watchdog: 0,
  };
  readonly examples: Record<string, unknown[]> = Object.create(null);
  // Count all intervals, retain only the first five examples (bounded memory).
  readonly lagIntervals: unknown[] = [];
  private log: Log;

  constructor(log: Log) { this.log = log; }

  type(name: string) {
    this.byType[name] = (this.byType[name] ?? 0) + 1;
  }

  count(name: string, amount = 1) {
    this.counts[name] = (this.counts[name] ?? 0) + amount;
  }

  issue(name: string, example: unknown, amount = 1) {
    this.count(name, amount);
    const examples = this.examples[name] ??= [];
    if (examples.length < 5) {
      examples.push(example);
      this.log("validation_issue", { kind: name, example, count: this.counts[name] });
    }
  }
}
