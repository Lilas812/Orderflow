// Read-only cloud evidence. Never constructs AppStore or starts a receiver.
import { ReplitObjects } from '../../../server/src/store/objects.ts';
import { tradeFileEntries } from '../../../server/src/store/records.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const restartUs = Number(process.argv[2]);
if (!Number.isSafeInteger(restartUs) || restartUs <= 0) throw Error('Pass recorded research restart Unix us');
const nowUs = Date.now() * 1000;
const target = (Math.floor(restartUs / 3_600_000_000) + 1) * 3600;
const date = new Date(target * 1000).toISOString(), directory = path.resolve('data/research-range-bars/storage-evidence');
await fs.mkdir(directory, { recursive: true });
const cloud = new ReplitObjects();
const results = [];
for (const symbol of ['NQ', 'GC']) {
  const prefix = symbol === 'NQ' ? 'prod/' : 'prod/instruments/GC/';
  const coverageObject = prefix + 'coverage.json';
  const coverageFile = path.join(directory, `${symbol}-coverage.json`);
  const coverageGeneration = await cloud.downloadVersion(coverageObject, coverageFile);
  if (!coverageGeneration) throw Error(`${symbol} production coverage missing`);
  const bytes = await fs.readFile(coverageFile), coverage = JSON.parse(bytes.toString());
  const intervals = coverage.tick.filter(([a, b]) => a < target + 3600 && b > target)
    .map(([a, b]) => [Math.max(a, target), Math.min(b, target + 3600)]);
  const object = `${prefix}trades/${symbol}/${date.slice(0, 10)}/${date.slice(11, 13)}.jsonl.gz`;
  const exists = await cloud.exists(object);
  const row = { symbol, object, targetStartUtc: date, targetEndUtc: new Date((target + 3600) * 1000).toISOString(),
    exists, hourEnded: nowUs >= (target + 3600) * 1e6, coverageGeneration,
    coverageSha256: createHash('sha256').update(bytes).digest('hex'),
    tickCoverageIntervals: intervals, tickCoverageSeconds: intervals.reduce((n, [a, b]) => n + b - a, 0),
    verified: false };
  if (exists && row.hourEnded) {
    const file = path.join(directory, `${symbol}-${date.slice(0, 13).replaceAll(':', '-')}.jsonl.gz`);
    row.objectGeneration = await cloud.downloadVersion(object, file);
    row.sha256 = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    row.count = 0; row.quantity = 0; row.minUs = null; row.maxUs = null;
    for await (const { trade } of tradeFileEntries(file, new AbortController().signal)) {
      if (trade.tsUs < target * 1e6 || trade.tsUs >= (target + 3600) * 1e6) throw Error(`${symbol} trade outside target hour`);
      row.count++; row.quantity += trade.size;
      row.minUs = Math.min(row.minUs ?? trade.tsUs, trade.tsUs);
      row.maxUs = Math.max(row.maxUs ?? trade.tsUs, trade.tsUs);
    }
    row.verified = row.count > 0 && row.tickCoverageSeconds > 0;
  }
  results.push(row);
}
const report = { restartUs, checkedAtUs: nowUs, mode: 'read-only-existing-prod-objects',
  verified: results.every(x => x.verified), note: 'Hourly persistence evidence is not proof of complete feed coverage.', results };
await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
